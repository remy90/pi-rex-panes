import { expect, test } from "bun:test";
import { createInspector, registerInspector } from "./inspector.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { INSPECTOR_REGISTER_EVENT, type InspectorRegistrationRequest } from "./types.ts";
import type { InspectorContext, InspectorLaunch } from "./types.ts";
import type { Runner } from "../rex/client.ts";

const context: InspectorContext = {
	cwd: "/parent", env: { REX_SESSION: "session", REX_BLOCK: "parent" },
	target: { runId: "run", asyncDir: "/runs/run", status: { state: "running", cwd: "/child" } },
};
const launch: InspectorLaunch = {
	executable: "/bin/node", argv: ["/inspector.js", "argument with spaces", "--flag"], displayCommand: "ignored",
	allowSteer: true, allowStop: true, sessionRoots: [],
};
function harness() {
	const commands: string[][] = [];
	const live = new Set<string>(["parent", "foreign"]);
	const exited = new Set<string>();
	let next = 0;
	const runner: Runner = async (_binary, args) => {
		commands.push(args);
		if (args.includes("split")) {
			const id = `pane-${++next}`;
			live.add(id);
			return { code: 0, stdout: JSON.stringify({ block_ids: [id] }), stderr: "" };
		}
		if (args.includes("ls")) return { code: 0, stdout: [...live].join("\n"), stderr: "" };
		if (args.includes("process")) return {
			code: 0, stdout: JSON.stringify({ last_exit: exited.has(args[8]!) ? { exit_code: 0 } : null }), stderr: "",
		};
		if (args.includes("close") && !live.delete(args[5]!)) return { code: 1, stdout: "", stderr: "Block not found" };
		return { code: 0, stdout: "", stderr: "" };
	};
	return { ...createInspector({ lookup: () => "/bin/rex", runner }), commands, live, exited };
}

test("inspector opens launch argv unchanged in a right split and focuses on request", async () => {
	const h = harness();
	expect(h.plugin.available(context)).toBe(true);
	const result = await h.plugin.open(context, launch, { focus: true });
	expect(result.isError).not.toBe(true);
	expect(h.commands[0]).toEqual([
		"--autostart=false", "--timeout", "3s", "split", "-s", "session", "-b", "parent", "--split=right",
		"--ratio", "40", "--focus=false", "--label", "pi-inspector-run", "-c", "/child", "--shell=none",
		"--keep-open", "--json", "--", "/bin/node", "/inspector.js", "argument with spaces", "--flag",
	]);
	expect(h.commands[1]).toEqual(["--autostart=false", "--timeout", "3s", "block", "focus", "pane-1", "-s", "session"]);
	expect(h.plugin.owns(context)).toBe(true);
});

test("an existing inspector is reused and later indexes stack below it", async () => {
	const h = harness();
	await h.plugin.open(context, launch, {});
	await h.plugin.open(context, launch, {});
	const step = { ...context, target: { ...context.target, index: 0 } };
	await h.plugin.open(step, launch, { focus: false });
	const splits = h.commands.filter((args) => args.includes("split"));
	expect(splits).toHaveLength(2);
	expect(splits[1]).toContain("--split=below");
	expect(splits[1]!.slice(6, 11)).toEqual(["-b", "pane-1", "--split=below", "--ratio", "50"]);
	expect(h.commands.some((args) => args.includes("focus"))).toBe(false);
	expect(h.plugin.owns(step)).toBe(true);
});

test("status observes missing panes and close leaves unowned panes and runs alone", async () => {
	const h = harness();
	await h.plugin.close!(context);
	expect(h.commands).toEqual([]);
	await h.plugin.open(context, launch, {});
	expect((await h.plugin.status!(context)).content).toEqual([{ type: "text", text: "Rex inspector pane-1 is open." }]);
	await h.plugin.close!(context);
	expect(h.plugin.owns(context)).toBe(false);
	expect(h.live).toEqual(new Set(["parent", "foreign"]));
	await h.plugin.open(context, launch, {});
	h.live.delete("pane-2");
	expect((await h.plugin.status!(context)).content).toEqual([{ type: "text", text: "Rex inspector is closed." }]);
	expect(h.plugin.owns(context)).toBe(false);
	expect(h.commands.filter((args) => args.includes("close"))).toEqual([
		["--autostart=false", "--timeout", "3s", "block", "close", "pane-1", "-s", "session"],
	]);
});

test("inspector availability requires its parent session, block and executable", () => {
	const h = harness();
	for (const env of [{}, { REX_SESSION: "s" }, { REX_BLOCK: "p" }]) {
		expect(h.plugin.available({ ...context, env })).toBe(false);
	}
	const unavailable = createInspector({ lookup: () => undefined });
	expect(unavailable.plugin.available(context)).toBe(false);
});

test("concurrent opens share one pane and a missing pane can reopen", async () => {
	const h = harness();
	await Promise.all([h.plugin.open(context, launch, {}), h.plugin.open(context, launch, {})]);
	expect(h.commands.filter((args) => args.includes("split"))).toHaveLength(1);
	h.live.delete("pane-1");
	await h.plugin.open(context, launch, {});
	const splits = h.commands.filter((args) => args.includes("split"));
	expect(splits[1]).toContain("--split=right");
	expect(h.live.has("pane-2")).toBe(true);
});

test("closing a pane already removed by the user releases its ownership", async () => {
	const h = harness();
	await h.plugin.open(context, launch, {});
	h.live.delete("pane-1");
	expect((await h.plugin.close!(context)).isError).not.toBe(true);
	expect(h.plugin.owns(context)).toBe(false);
});

test("opening an exited inspector starts a fresh runner", async () => {
	const h = harness();
	await h.plugin.open(context, launch, {});
	h.exited.add("pane-1");
	await h.plugin.open(context, launch, {});
	expect(h.live).toEqual(new Set(["parent", "foreign", "pane-2"]));
});

test("parent shutdown closes every tracked inspector", async () => {
	const h = harness();
	await h.plugin.open(context, launch, {});
	await h.plugin.open({ ...context, target: { ...context.target, index: 1 } }, launch, {});
	await h.shutdown();
	expect(h.live).toEqual(new Set(["parent", "foreign"]));
	expect(h.plugin.owns(context)).toBe(false);
	expect((await h.plugin.open(context, launch, {})).isError).toBe(true);
});

test("shutdown waits for an in-flight split and closes its returned block", async () => {
	let release!: (result: { code: number; stdout: string; stderr: string }) => void;
	let started!: () => void;
	const splitting = new Promise<void>((resolve) => { started = resolve; });
	const closed: string[] = [];
	const h = createInspector({
		lookup: () => "rex",
		runner: async (_binary, args) => {
			if (args.includes("split")) {
				started();
				return new Promise((resolve) => { release = resolve; });
			}
			if (args.includes("close")) closed.push(args[5]!);
			return { code: 0, stdout: "", stderr: "" };
		},
	});
	const opened = h.plugin.open(context, launch, {});
	await splitting;
	const closing = h.shutdown();
	release({ code: 0, stdout: '{"block_ids":["late-pane"]}', stderr: "" });
	await Promise.all([opened, closing]);
	expect(closed).toEqual(["late-pane"]);
	expect(h.plugin.owns(context)).toBe(false);
});

test("inspector shutdown returns within its grace when Rex hangs", async () => {
	let closing = false;
	const h = createInspector({
		lookup: () => "rex", shutdownGraceMs: 5,
		runner: async (_binary, args) => {
			if (args.includes("split")) return { code: 0, stdout: '{"block_ids":["hung-pane"]}', stderr: "" };
			closing = true;
			return new Promise(() => {});
		},
	});
	await h.plugin.open(context, launch, {});
	await h.shutdown();
	expect(closing).toBe(true);
}, 100);

function registrationHarness(outcome: "absent" | "rejected" | "accepted") {
	const handlers = new Map<string, Function[]>();
	const emitted: InspectorRegistrationRequest[] = [];
	const log: string[] = [];
	let disposed = 0;
	const pi = {
		on(name: string, handler: Function) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
		getFlag: () => false,
		events: { emit(name: string, request: InspectorRegistrationRequest) {
			expect(name).toBe(INSPECTOR_REGISTER_EVENT);
			emitted.push(request);
			if (outcome === "accepted") request.result = { ok: true, registration: { dispose() { disposed++; } } };
			if (outcome === "rejected") request.result = { ok: false, error: new Error("Rejected plugin") };
		} },
	} as unknown as ExtensionAPI;
	const handle = registerInspector(pi, { log: (message) => log.push(message) });
	return {
		emitted, log, registered: handle.registered, shutdown: handle.shutdown, disposed: () => disposed,
		async fire(name: string) { for (const handler of handlers.get(name) ?? []) await handler({}); },
	};
}

test.each(["absent", "rejected", "accepted"] as const)("inspector registration handles %s listeners", async (outcome) => {
	const h = registrationHarness(outcome);
	await h.fire("session_start");
	expect(h.registered()).toBe(outcome === "accepted");
	expect(h.emitted[0]!.version).toBe(1);
	expect(h.emitted[0]!.plugin.name).toBe("rex-panes");
	await h.fire("session_start");
	expect(h.disposed()).toBe(outcome === "accepted" ? 1 : 0);
	await h.shutdown();
	expect(h.disposed()).toBe(outcome === "accepted" ? 2 : 0);
	expect(h.registered()).toBe(false);
	expect(h.log).toHaveLength(outcome === "rejected" ? 1 : 0);
	if (outcome === "rejected") expect(h.log[0]).toContain("Rejected plugin");
});

