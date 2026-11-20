import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { REPORT_FLAG } from "../reporter.ts";
import type { registerInspector } from "./inspector.ts";
import { foreignSubagentOwner } from "./ownership.ts";
import { ASYNC_STARTED_EVENT, ASYNC_COMPLETE_EVENT, type AsyncComplete, type AsyncStarted, type InspectorContext } from "./types.ts";

interface AutoInspectDeps {
	env?: NodeJS.ProcessEnv;
	settings?: () => { autoInspect?: unknown } | undefined;
	exists?: (path: string) => boolean;
}

function validStart(value: unknown): value is AsyncStarted {
	if (!value || typeof value !== "object") return false;
	const event = value as Record<string, unknown>;
	return ["id", "asyncDir", "sessionId", "cwd", "mode"].every((field) => typeof event[field] === "string" && event[field].trim().length > 0)
		&& (event.sessionRoot === undefined || typeof event.sessionRoot === "string" && event.sessionRoot.trim().length > 0);
}

function validComplete(value: unknown): value is AsyncComplete {
	if (!value || typeof value !== "object") return false;
	const event = value as Record<string, unknown>;
	const validId = (id: unknown) => typeof id === "string" && id.trim().length > 0;
	return (event.runId === undefined || validId(event.runId)) && (event.id === undefined || validId(event.id))
		&& (validId(event.runId) || validId(event.id)) && (event.success === undefined || typeof event.success === "boolean");
}

export function registerAutoInspect(
	pi: ExtensionAPI,
	packageRoot: string,
	inspector: ReturnType<typeof registerInspector>,
	deps: AutoInspectDeps = {},
) {
	const env = deps.env ?? process.env;
	let dispose: (() => void) | undefined;
	let stopped = false;
	pi.on("session_start", (_event, ctx) => {
		dispose?.();
		dispose = undefined;
		if (stopped || pi.getFlag(REPORT_FLAG)) return;
		const sessionId = ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
		const runs = new Map<string, { opened?: Promise<() => void> }>();
		let active = true;
		let disabled = false;
		const offStart = pi.events.on(ASYNC_STARTED_EVENT, (payload) => {
			if (stopped || disabled || !validStart(payload) || payload.sessionId !== sessionId || runs.has(payload.id)) return;
			if (env.PI_REX_PANES_AUTO_INSPECT === "0") return;
			try { if (deps.settings?.()?.autoInspect === false) return; }
			catch { /* Use the default when settings cannot be read. */ }
			const owner = foreignSubagentOwner(pi, packageRoot);
			if (!owner?.split(/[\\/]/).includes("pi-subagents") || !inspector.available(env)) return;
			const runner = join(dirname(dirname(owner)), "inspector-runner.mjs");
			let exists = false;
			try { exists = (deps.exists ?? existsSync)(runner); } catch { /* Treat inaccessible runners as missing. */ }
			if (!exists) {
				disabled = true;
				if (ctx.hasUI) ctx.ui.notify(`pi-rex-panes auto inspect disabled: missing ${runner}.`, "warning");
				return;
			}
			const context: InspectorContext = {
				cwd: payload.cwd, env,
				target: { runId: payload.id, asyncDir: payload.asyncDir, status: { cwd: payload.cwd, state: "running" } },
			};
			const sessionRoots = payload.sessionRoot ? [payload.sessionRoot] : [];
			const opened = inspector.openAutomatically(context, {
				executable: process.execPath,
				argv: [runner, "--async-dir", payload.asyncDir, "--run-id", payload.id, "--allow-steer", "true", "--allow-stop", "true",
					"--session-roots", Buffer.from(JSON.stringify(sessionRoots)).toString("base64")],
				displayCommand: runner, allowSteer: true, allowStop: true, sessionRoots,
			});
			runs.set(payload.id, { opened });
		});
		const offComplete = pi.events.on(ASYNC_COMPLETE_EVENT, (payload) => {
			if (stopped || !validComplete(payload)) return;
			const run = runs.get((payload.runId ?? payload.id)!);
			if (!run?.opened) return;
			const opened = run.opened;
			run.opened = undefined;
			void opened.then((linger) => { if (active && !stopped) linger(); });
		});
		dispose = () => { active = false; offStart(); offComplete(); };
	});
	return { shutdown() { stopped = true; dispose?.(); dispose = undefined; } };
}
