import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRexClient, UncertainPaneLaunch, type RexClient, type Runner } from "./rex/client.ts";
import { findRex } from "./rex/lookup.ts";
import { createPlacement, type Placement } from "./rex/placement.ts";
import { withinGrace } from "./grace.ts";
import { scheduleLinger, type LingerTimers } from "./interop/linger.ts";
import { PARENT_PID_ENV } from "./reporter.ts";
import { DEFAULT_START_TIMEOUT_MS, isFailureStopReason, tailReport, type ReportOutcome } from "./report-tail.ts";

export const DEFAULT_LINGER_SECONDS = 60;
export const MAX_LINGER_SECONDS = 2_147_483;

interface PaneLaunch {
	label: string;
	cwd: string;
	argv: (reportFile: string) => string[];
	processLine: (line: string) => void;
	signal?: AbortSignal;
}

interface LingeringPane {
	id: string;
	rex: RexClient;
	placement: Placement;
	cancelLinger?: () => void;
	closing?: Promise<boolean>;
}

async function closePane(id: string, rex: RexClient, placement: Placement): Promise<boolean> {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			if ((await rex.closePane(id)).code === 0) {
				placement.forget(id);
				return true;
			}
		} catch { /* Retry once; a live pane remains a placement anchor. */ }
	}
	return false;
}

export function createPaneTransport(deps: {
	env?: NodeJS.ProcessEnv;
	lookup?: typeof findRex;
	runner?: Runner;
	shutdownGraceMs?: number;
	timers?: LingerTimers;
	settings?: () => { lingerSeconds?: unknown } | undefined;
} = {}) {
	const env = deps.env ?? process.env;
	const placements = new Map<string, Placement>();
	const active = new Map<AbortController, Promise<void>>();
	const lingering = new Set<LingeringPane>();
	const close = (pane: LingeringPane): Promise<boolean> => {
		if (!pane.closing) {
			pane.cancelLinger?.();
			pane.closing = closePane(pane.id, pane.rex, pane.placement).then((closed) => {
				if (closed) lingering.delete(pane);
				else pane.closing = undefined;
				return closed;
			});
		}
		return pane.closing;
	};
	const linger = (id: string, rex: RexClient, placement: Placement) => {
		const pane: LingeringPane = { id, rex, placement };
		lingering.add(pane);
		let value: unknown = env.PI_REX_PANES_LINGER_SECONDS?.trim();
		if (!value) {
			try { value = deps.settings?.()?.lingerSeconds; }
			catch { /* Use the default when settings cannot be read. */ }
		}
		pane.cancelLinger = scheduleLinger({
			delayMs: parseLingerSeconds(value) * 1_000,
			timers: deps.timers,
			isFocused: async () => await rex.focusedBlockId() === id,
			close: () => { void close(pane); },
		});
	};
	return {
		async shutdown() {
			const running = [...active.entries()];
			for (const [controller] of running) controller.abort();
			const closing = [...lingering].map(close);
			await withinGrace(
				Promise.allSettled([...running.map(([, finished]) => finished), ...closing]),
				deps.shutdownGraceMs,
			);
		},
		async run(options: PaneLaunch): Promise<ReportOutcome | undefined> {
			if (env.PI_REX_PANES === "0" || !env.REX_SESSION || !env.REX_BLOCK) return undefined;
			const binary = (deps.lookup ?? findRex)(env);
			if (!binary) return undefined;
			const rex = createRexClient(binary, env.REX_SESSION, deps.runner);
			const key = `${binary}:${env.REX_SESSION}:${env.REX_BLOCK}`;
			let placement = placements.get(key);
			if (!placement) {
				placement = createPlacement(rex, env.REX_BLOCK);
				placements.set(key, placement);
			}
			const controller = new AbortController();
			const abort = () => controller.abort();
			let finish!: () => void;
			active.set(controller, new Promise<void>((resolve) => { finish = resolve; }));
			options.signal?.addEventListener("abort", abort, { once: true });
			if (options.signal?.aborted) controller.abort();
			let dir: string | undefined;
			try {
				dir = mkdtempSync(join(tmpdir(), "pi-rex-panes-"));
				const file = join(dir, "report.ndjson");
				if (controller.signal.aborted) return { settled: false, aborted: true };
				writeFileSync(file, "", { mode: 0o600 });
				let id: string;
				try {
					id = await placement.open({ label: options.label, cwd: options.cwd,
						argv: ["/usr/bin/env", `PI_REX_PANES_KEEP=${env.PI_REX_PANES_KEEP === "1" ? "1" : "0"}`, `${PARENT_PID_ENV}=${process.pid}`,
							...(env.PI_CODING_AGENT_DIR ? [`PI_CODING_AGENT_DIR=${env.PI_CODING_AGENT_DIR}`] : []), ...options.argv(file)],
					}, controller.signal);
				} catch (error) {
					if (controller.signal.aborted) return { settled: false, aborted: true };
					if (error instanceof UncertainPaneLaunch) return { settled: false, aborted: false, error };
					return undefined;
				}
				let failed = false;
				const outcome = await tailReport({ file, processLine: (line, event) => {
					options.processLine(line);
					if (event?.type === "message_end" && event.message?.role === "assistant") {
						failed = isFailureStopReason(event.message.stopReason);
					}
				}, signal: controller.signal, startTimeoutMs: parseStartTimeout(env.PI_REX_PANES_START_TIMEOUT_MS),
				waitForExit: (signal) => rex.waitPane(id, { signal }) });
				if (outcome.aborted || controller.signal.aborted) {
					if (!await closePane(id, rex, placement)) outcome.warning = `Warning: Could not confirm pane ${id} closed. It may still be open; close it manually.`;
				} else if (outcome.settled && !failed && env.PI_REX_PANES_KEEP !== "1") {
					linger(id, rex, placement);
				}
				return outcome;
			} finally {
				active.delete(controller);
				options.signal?.removeEventListener("abort", abort);
				try {
					if (dir) rmSync(dir, { recursive: true, force: true });
				} finally { finish(); }
			}
		},
	};
}

export function parseLingerSeconds(value: unknown): number {
	const seconds = typeof value === "number" ? value
		: typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
	return Number.isInteger(seconds) && seconds >= 0 && seconds <= MAX_LINGER_SECONDS
		? seconds : DEFAULT_LINGER_SECONDS;
}

export function parseStartTimeout(value: string | undefined): number {
	const trimmed = value?.trim() ?? "";
	const timeout = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
	return timeout >= 1 && timeout <= 2_147_483_647 ? timeout : DEFAULT_START_TIMEOUT_MS;
}

export type PaneTransport = ReturnType<typeof createPaneTransport>;
