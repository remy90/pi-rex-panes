import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerReporter } from "./reporter.ts";

function watchdog() {
	const pending = new Map<number, () => void>();
	const delays: number[] = [];
	const commands: string[][] = [];
	let next = 0;
	let alive = true;
	return {
		pending, delays, commands,
		die() { alive = false; },
		async tick() {
			const callbacks = [...pending.values()];
			pending.clear();
			for (const callback of callbacks) await callback();
		},
		deps: {
			env: { PI_REX_PANES_PARENT_PID: "12345", REX_SESSION: "session", REX_BLOCK: "child" },
			lookup: () => "/bin/rex",
			isAlive(pid: number) { expect(pid).toBe(12345); return alive; },
			timers: {
				setTimeout(callback: () => void, ms: number) { delays.push(ms); pending.set(++next, callback); return next; },
				clearTimeout(handle: unknown) { pending.delete(Number(handle)); },
			},
			runner: async (_binary: string, args: string[]) => {
				commands.push(args);
				return { code: 0, stdout: "", stderr: "" };
			},
		},
	};
}

test("a successful child closes its pane and exits after its parent disappears", async () => {
	const h = harness(reportFile());
	const clock = watchdog();
	registerReporter(h.pi, clock.deps);
	h.emit("session_start");
	h.emit("message_end", { message: { role: "assistant", stopReason: "stop" } });
	h.emit("agent_settled", { aborted: false });
	await clock.tick();
	expect(h.shutdowns).toBe(0);
	expect(clock.delays).toEqual([2000, 2000]);
	clock.die();
	await clock.tick();
	expect(clock.commands).toEqual([["--autostart=false", "--timeout", "3s", "block", "close", "child", "-s", "session"]]);
	expect(h.shutdowns).toBe(1);
	expect(clock.pending.size).toBe(0);
	h.emit("session_shutdown");
});

test.each(["error", "aborted", "unsettled"])("a %s child exits without closing its pane after parent loss", async (kind) => {
	const h = harness(reportFile());
	const clock = watchdog();
	registerReporter(h.pi, clock.deps);
	h.emit("session_start");
	if (kind !== "unsettled") {
		h.emit("message_end", { message: { role: "assistant", stopReason: kind === "error" ? "error" : "stop" } });
		h.emit("agent_settled", { aborted: kind === "aborted" });
	}
	clock.die();
	await clock.tick();
	expect(h.shutdowns).toBe(1);
	expect(clock.commands).toEqual([]);
	h.emit("session_shutdown");
});

test.each(["", "abc", "0", "-1", "1", "1.5", "9007199254740992"])("an invalid parent PID %s never starts polling", (pid) => {
	const h = harness(reportFile());
	const clock = watchdog();
	clock.deps.env.PI_REX_PANES_PARENT_PID = pid;
	registerReporter(h.pi, clock.deps);
	h.emit("session_start");
	expect(clock.pending.size).toBe(0);
	h.emit("session_shutdown");
});

test("shutdown stops polling and an inactive reporter never polls", async () => {
	const clock = watchdog();
	const inactive = harness("");
	registerReporter(inactive.pi, clock.deps);
	inactive.emit("session_start");
	expect(clock.pending.size).toBe(0);
	const h = harness(reportFile(), "watchdog-claim");
	const duplicate = harness(reportFile(), "watchdog-claim");
	registerReporter(h.pi, clock.deps);
	registerReporter(duplicate.pi, clock.deps);
	h.emit("session_start");
	duplicate.emit("session_start");
	expect(clock.pending.size).toBe(1);
	h.emit("session_shutdown");
	expect(clock.pending.size).toBe(0);
	clock.die();
	await clock.tick();
	expect(h.shutdowns).toBe(0);
	duplicate.emit("session_shutdown");
});

test.each(["throw", "nonzero", "missing"])("child exits even when its own pane close fails: %s", async (failure) => {
	const h = harness(reportFile());
	const clock = watchdog();
	registerReporter(h.pi, {
		...clock.deps,
		lookup: () => failure === "missing" ? undefined : "rex",
		runner: async () => {
			if (failure === "throw") throw new Error("Rex unavailable");
			return { code: 1, stdout: "", stderr: "close failed" };
		},
	});
	h.emit("session_start");
	h.emit("agent_settled", { aborted: false });
	clock.die();
	await clock.tick();
	expect(h.shutdowns).toBe(1);
	h.emit("session_shutdown");
});

test("a hung Rex close cannot prevent the child from exiting", async () => {
	const h = harness(reportFile());
	const clock = watchdog();
	registerReporter(h.pi, { ...clock.deps, runner: () => new Promise(() => {}) });
	h.emit("session_start");
	h.emit("agent_settled", { aborted: false });
	clock.die();
	const checking = clock.tick();
	expect(h.shutdowns).toBe(0);
	expect(clock.delays).toEqual([2000, 4000]);
	await clock.tick();
	await checking;
	expect(h.shutdowns).toBe(1);
	h.emit("session_shutdown");
});

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

test.each(["error", "aborted", "stop"])("reporter keeps %s panes open and stops writing after settling", (kind) => {
	const file = reportFile();
	const h = harness(file);
	registerReporter(h.pi);
	h.emit("session_start");
	h.emit("message_end", { message: { role: "assistant", stopReason: kind } });
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
	registerReporter(first.pi);
	registerReporter(duplicate.pi);
	first.emit("session_start");
	duplicate.emit("session_start");
	for (const h of [first, duplicate]) {
		h.emit("message_end", { message: { role: "user", content: "one" } });
		h.emit("agent_settled");
	}
	expect(readFileSync(file, "utf8")).toBe('{"type":"message_end","message":{"role":"user","content":"one"}}\n{"type":"agent_settled"}\n');
	first.emit("session_shutdown");
	const reload = harness(file, "same-session");
	registerReporter(reload.pi);
	reload.emit("session_start");
	duplicate.emit("session_shutdown"); // A losing copy cannot release the new claim.
	const another = harness(file, "same-session");
	registerReporter(another.pi);
	another.emit("session_start");
	for (const h of [reload, another]) h.emit("agent_settled");
	expect(readFileSync(file, "utf8")).toEndWith('{"type":"agent_settled"}\n{"type":"agent_settled"}\n');
	expect(another.shutdowns).toBe(0);
	reload.emit("session_shutdown");
	another.emit("session_shutdown");
});

test("reporter handlers append exact records and leave successful panes for the parent to close", () => {
	const file = reportFile();
	const h = harness(file);
	registerReporter(h.pi);
	expect(h.flags).toEqual(["rex-panes-report"]);
	h.emit("session_start");
	h.emit("agent_start", { type: "agent_start" });
	h.emit("message_end", { type: "message_end", message: { role: "user", content: "Task: hello" } });
	h.emit("message_end", { type: "message_end", message: { role: "assistant", content: [], stopReason: "stop" } });
	h.emit("agent_settled", { type: "agent_settled", aborted: false });
	expect(readFileSync(file, "utf8")).toBe('{"type":"agent_start"}\n{"type":"message_end","message":{"role":"user","content":"Task: hello"}}\n{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"stop"}}\n{"type":"agent_settled"}\n');
	expect(h.shutdowns).toBe(0);
	h.emit("session_shutdown");
});
