import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerReporter } from "./reporter.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function harness(file: string, session: string = crypto.randomUUID()) {
	const handlers = new Map<string, (...args: any[]) => any>();
	let shutdowns = 0;
	const flags: string[] = [];
	const pi = {
		registerFlag(name: string) { flags.push(name); },
		getFlag() { return file; },
		on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
	} as unknown as ExtensionAPI;
	const ctx = { sessionManager: { getSessionId: () => session }, shutdown: () => { shutdowns++; } };
	return { pi, flags, emit: (name: string, event = {}) => handlers.get(name)?.(event, ctx), get shutdowns() { return shutdowns; } };
}
function reportFile() {
	const dir = mkdtempSync(join(tmpdir(), "reporter-test-"));
	dirs.push(dir);
	return join(dir, "report.ndjson");
}

test.each(["error", "aborted", "keep"])("reporter keeps %s panes open and stops writing after settling", (kind) => {
	const file = reportFile();
	const h = harness(file);
	registerReporter(h.pi, kind === "keep" ? { PI_REX_PANES_KEEP: "1" } : {});
	h.emit("session_start");
	h.emit("message_end", { message: { role: "assistant", stopReason: kind === "keep" ? "stop" : kind } });
	h.emit("agent_settled", { aborted: kind === "aborted" });
	const report = readFileSync(file, "utf8");
	h.emit("message_end", { message: { role: "assistant", stopReason: "stop" } });
	h.emit("agent_settled");
	expect(readFileSync(file, "utf8")).toBe(report);
	expect(h.shutdowns).toBe(0);
	h.emit("session_shutdown");
});

test("distinct extension copies share one session claim and release it for reload", () => {
	const file = reportFile();
	const first = harness(file, "same-session");
	const duplicate = harness(file, "same-session");
	registerReporter(first.pi, {});
	registerReporter(duplicate.pi, {});
	first.emit("session_start");
	duplicate.emit("session_start");
	for (const h of [first, duplicate]) {
		h.emit("message_end", { message: { role: "user", content: "one" } });
		h.emit("agent_settled");
	}
	expect(readFileSync(file, "utf8")).toBe('{"type":"message_end","message":{"role":"user","content":"one"}}\n{"type":"agent_settled"}\n');
	first.emit("session_shutdown");
	const reload = harness(file, "same-session");
	registerReporter(reload.pi, {});
	reload.emit("session_start");
	duplicate.emit("session_shutdown"); // A losing copy cannot release the new claim.
	const another = harness(file, "same-session");
	registerReporter(another.pi, {});
	another.emit("session_start");
	for (const h of [reload, another]) h.emit("agent_settled");
	expect(readFileSync(file, "utf8")).toEndWith('{"type":"agent_settled"}\n{"type":"agent_settled"}\n');
	expect(another.shutdowns).toBe(0);
	reload.emit("session_shutdown");
	another.emit("session_shutdown");
});

test("reporter handlers append exact message_end and settled records before success shutdown", () => {
	const file = reportFile();
	const h = harness(file);
	registerReporter(h.pi, {});
	expect(h.flags).toEqual(["rex-panes-report"]);
	h.emit("session_start");
	h.emit("agent_start", { type: "agent_start" });
	h.emit("message_end", { type: "message_end", message: { role: "user", content: "Task: hello" } });
	h.emit("message_end", { type: "message_end", message: { role: "assistant", content: [], stopReason: "stop" } });
	h.emit("agent_settled", { type: "agent_settled", aborted: false });
	expect(readFileSync(file, "utf8")).toBe('{"type":"agent_start"}\n{"type":"message_end","message":{"role":"user","content":"Task: hello"}}\n{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"stop"}}\n{"type":"agent_settled"}\n');
	expect(h.shutdowns).toBe(1);
	h.emit("session_shutdown");
});
