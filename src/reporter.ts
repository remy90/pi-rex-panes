import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const REPORT_FLAG = "rex-panes-report";
const claimKey = Symbol.for("pi-rex-panes.reporter-claims");
const shared = globalThis as typeof globalThis & { [claimKey]?: Map<string, symbol> };
const claims = shared[claimKey] ??= new Map<string, symbol>();

export function registerReporter(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env): void {
	pi.registerFlag(REPORT_FLAG, { type: "string", description: "Internal child report file for Rex panes" });
	const owner = Symbol("reporter");
	let session: string | undefined;
	let file: string | undefined;
	let settled = false;
	let failed = false;
	const release = () => {
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
	});
	pi.on("message_end", (event) => {
		if (!file || settled) return;
		if (event.message.role === "assistant") {
			failed = event.message.stopReason === "error" || event.message.stopReason === "aborted";
		}
		append({ type: "message_end", message: event.message });
	});
	pi.on("agent_settled", (event, ctx) => {
		if (!append({ type: "agent_settled" })) return;
		settled = true;
		if (!failed && !event.aborted && env.PI_REX_PANES_KEEP !== "1") ctx.shutdown();
	});
	pi.on("session_shutdown", release);
}
