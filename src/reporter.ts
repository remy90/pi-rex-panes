import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withinGrace, type GraceTimers } from "./grace.ts";
import { isFailureStopReason } from "./report-tail.ts";
import { createRexClient, type Runner } from "./rex/client.ts";
import { findRex } from "./rex/lookup.ts";

export const REPORT_FLAG = "rex-panes-report";
export const PARENT_PID_ENV = "PI_REX_PANES_PARENT_PID";
export const PARENT_POLL_MS = 2_000;
const PARENT_CLOSE_GRACE_MS = 4_000;
const defaultTimers: GraceTimers = {
	setTimeout(callback, ms) {
		const timer = setTimeout(callback, ms);
		timer.unref();
		return timer;
	},
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function parentIsAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (error) { return !(error instanceof Error && "code" in error && error.code === "ESRCH"); }
}

const claimKey = Symbol.for("pi-rex-panes.reporter-claims");
const shared = globalThis as typeof globalThis & { [claimKey]?: Map<string, symbol> };
const claims = shared[claimKey] ??= new Map<string, symbol>();

export function registerReporter(pi: ExtensionAPI, deps: {
	env?: NodeJS.ProcessEnv;
	timers?: GraceTimers;
	isAlive?: (pid: number) => boolean;
	lookup?: typeof findRex;
	runner?: Runner;
} = {}): void {
	const env = deps.env ?? process.env;
	const timers = deps.timers ?? defaultTimers;
	const isAlive = deps.isAlive ?? parentIsAlive;
	let timer: unknown;
	let watching = false;
	let failed = false;
	pi.registerFlag(REPORT_FLAG, { type: "string", description: "Internal child report file for Rex panes" });
	const owner = Symbol("reporter");
	let session: string | undefined;
	let file: string | undefined;
	let settled = false;
	const release = () => {
		watching = false;
		if (timer !== undefined) timers.clearTimeout(timer);
		timer = undefined;
		if (session && claims.get(session) === owner) claims.delete(session);
		file = undefined;
	};
	const append = (record: unknown): boolean => {
		if (!file || settled) return false;
		try {
			appendFileSync(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
			return true;
		} catch { return false; }
	};
	pi.on("session_start", (_event, ctx) => {
		release();
		session = ctx.sessionManager.getSessionId();
		settled = false;
		failed = false;
		const flag = pi.getFlag(REPORT_FLAG);
		if (typeof flag !== "string" || !flag || claims.has(session)) return;
		claims.set(session, owner);
		file = flag;
		const rawPid = env[PARENT_PID_ENV] ?? "";
		const pid = /^\d+$/.test(rawPid) ? Number(rawPid) : NaN;
		if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return;
		watching = true;
		const poll = async () => {
			if (!watching) return;
			if (isAlive(pid)) {
				timer = timers.setTimeout(poll, PARENT_POLL_MS);
				return;
			}
			watching = false;
			timer = undefined;
			try {
				if (!settled) ctx.abort();
				else if (!failed && env.REX_SESSION && env.REX_BLOCK) {
					const binary = (deps.lookup ?? findRex)(env);
					if (binary) await withinGrace(
						createRexClient(binary, env.REX_SESSION, deps.runner).closePane(env.REX_BLOCK),
						PARENT_CLOSE_GRACE_MS, timers,
					);
				}
			} catch { /* Shutdown proceeds if abort or pane cleanup fails. */ }
			finally { ctx.shutdown(); }
		};
		timer = timers.setTimeout(poll, PARENT_POLL_MS);
	});
	pi.on("agent_start", () => { append({ type: "agent_start" }); });
	pi.on("message_end", (event) => {
		if (!file || settled) return;
		if (event.message.role === "assistant") failed = isFailureStopReason(event.message.stopReason);
		append({ type: "message_end", message: event.message });
	});
	pi.on("agent_settled", (event) => {
		if (!file || settled) return;
		append({ type: "agent_settled" });
		failed ||= event.aborted;
		settled = true;
	});
	pi.on("session_shutdown", release);
}
