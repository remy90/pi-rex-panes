import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRexClient, UncertainPaneLaunch, type Runner } from "./rex/client.ts";
import { findRex } from "./rex/lookup.ts";
import { createPlacement } from "./rex/placement.ts";
import { tailReport, type ReportOutcome } from "./report-tail.ts";

interface PaneLaunch {
	label: string;
	cwd: string;
	argv: (reportFile: string) => string[];
	processLine: (line: string) => void;
	signal?: AbortSignal;
}

export function createPaneTransport(deps: {
	env?: NodeJS.ProcessEnv;
	lookup?: typeof findRex;
	runner?: Runner;
	shutdownGraceMs?: number;
} = {}) {
	const env = deps.env ?? process.env;
	const placements = new Map<string, ReturnType<typeof createPlacement>>();
	const active = new Map<AbortController, Promise<void>>();
	return {
		async shutdown() {
			const running = [...active.entries()];
			for (const [controller] of running) controller.abort();
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					Promise.allSettled(running.map(([, finished]) => finished)),
					new Promise<void>((resolve) => { timer = setTimeout(resolve, deps.shutdownGraceMs ?? 5000); }),
				]);
			} finally {
				if (timer) clearTimeout(timer);
			}
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
						argv: ["/usr/bin/env", `PI_REX_PANES_KEEP=${env.PI_REX_PANES_KEEP === "1" ? "1" : "0"}`, ...options.argv(file)],
					}, controller.signal);
				} catch (error) {
					if (controller.signal.aborted) return { settled: false, aborted: true };
					if (error instanceof UncertainPaneLaunch) return { settled: false, aborted: false, error };
					return undefined;
				}
				let failed = false;
				const outcome = await tailReport({ file, processLine: (line) => {
					options.processLine(line);
					try {
						const event = JSON.parse(line);
						if (event.type === "message_end" && event.message?.role === "assistant") {
							failed = ["error", "aborted"].includes(event.message.stopReason);
						}
					} catch { /* The result parser handles unrelated output. */ }
				}, signal: controller.signal, startTimeoutMs: parseStartTimeout(env.PI_REX_PANES_START_TIMEOUT_MS),
				waitForExit: (signal) => rex.waitPane(id, { signal }) });
				if (outcome.aborted || (outcome.settled && !failed && env.PI_REX_PANES_KEEP !== "1")) {
					await rex.closePane(id).catch(() => {});
					placement.forget(id);
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

export function parseStartTimeout(value: string | undefined): number {
	const trimmed = value?.trim() ?? "";
	const timeout = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
	return timeout >= 1 && timeout <= 2_147_483_647 ? timeout : 60_000;
}

export type PaneTransport = ReturnType<typeof createPaneTransport>;
