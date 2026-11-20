import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAutoInspect } from "./autoinspect.ts";
import { registerInspector } from "./inspector.ts";
import { INSPECTOR_REGISTER_EVENT, type InspectorContext, type InspectorPlugin, type InspectorRegistrationRequest } from "./types.ts";

const started = {
	id: "run", asyncDir: "/async dir", sessionId: "/sessions/current.jsonl", cwd: "/work dir",
	mode: "single", sessionRoot: "/sessions/root",
};
const context: InspectorContext = {
	cwd: started.cwd, env: { REX_SESSION: "rex-session", REX_BLOCK: "parent" },
	target: { runId: "run", asyncDir: started.asyncDir, status: { state: "running" } },
};
async function flush() { for (let i = 0; i < 50; i++) await Promise.resolve(); }
function clock() {
	let now = 0;
	let next = 0;
	const jobs = new Map<number, { at: number; callback: () => void }>();
	return {
		now: () => now,
		setTimeout(callback: () => void, ms: number) { const id = ++next; jobs.set(id, { at: now + ms, callback }); return id; },
		clearTimeout(id: unknown) { jobs.delete(id as number); },
		get pending() { return jobs.size; },
		async advance(ms: number) {
			const until = now + ms;
			while (true) {
				const job = [...jobs].sort((a, b) => a[1].at - b[1].at)[0];
				if (!job || job[1].at > until) break;
				now = job[1].at; jobs.delete(job[0]); job[1].callback(); await flush();
			}
			now = until; await flush();
		},
	};
}
function harness(options: { env?: NodeJS.ProcessEnv; settings?: { autoInspect?: unknown; lingerSeconds?: unknown }; exists?: boolean; owner?: string; reporter?: boolean; accepted?: boolean; sessionFile?: string | null; splitGate?: Promise<void> } = {}) {
	const handlers = new Map<string, Function[]>();
	const listeners = new Map<string, Set<(payload: unknown) => void>>();
	const commands: string[][] = [];
	const notices: string[] = [];
	const checks: string[] = [];
	const live = new Set(["parent", "foreign"]);
	const timers = clock();
	const env = { ...context.env, ...options.env };
	let plugin!: InspectorPlugin;
	let focused = "parent";
	let next = 0;
	const pi = {
		on(name: string, handler: Function) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
		getFlag: () => options.reporter ?? false,
		getAllTools: () => [{ name: "subagent", sourceInfo: { path: options.owner ?? "/packages/pi-subagents/bundle/index.js" } }],
		events: {
			on(name: string, handler: (payload: unknown) => void) {
				if (!listeners.has(name)) listeners.set(name, new Set());
				listeners.get(name)!.add(handler);
				return () => { listeners.get(name)!.delete(handler); };
			},
			emit(name: string, payload: unknown) {
				if (name === INSPECTOR_REGISTER_EVENT) {
					const request = payload as InspectorRegistrationRequest;
					plugin = request.plugin;
					if (options.accepted !== false) request.result = { ok: true, registration: { dispose() {} } };
				}
				for (const listener of listeners.get(name) ?? []) listener(payload);
			},
		},
	} as unknown as ExtensionAPI;
	const inspector = registerInspector(pi, {
		timers, settings: () => options.settings, lookup: () => "rex",
		runner: async (_binary, args) => {
			commands.push(args);
			if (args.includes("split")) { await options.splitGate; const id = `pane-${++next}`; live.add(id); return { code: 0, stdout: JSON.stringify({ block_ids: [id] }), stderr: "" }; }
			if (args.includes("ls")) return { code: 0, stdout: [...live].join("\n"), stderr: "" };
			if (args.includes("process")) return { code: 0, stdout: '{"last_exit":null}', stderr: "" };
			if (args.includes("close")) live.delete(args[5]!);
			if (args.includes("session.view")) return { code: 0, stdout: JSON.stringify({ active_window_id: "w", windows: [{ window_id: "w", focused_block_id: focused }] }), stderr: "" };
			return { code: 0, stdout: "", stderr: "" };
		},
	});
	const auto = registerAutoInspect(pi, "/packages/pi-rex-panes", inspector, {
		env, settings: () => options.settings,
		exists: (path) => { checks.push(path); return options.exists !== false; },
	});
	return {
		commands, notices, checks, live, timers, get plugin() { return plugin; },
		focus(id: string) { focused = id; },
		async emit(name: string, payload: unknown) { pi.events.emit(name, payload); await flush(); },
		async session() {
			for (const handler of handlers.get("session_start") ?? []) await handler({}, {
				hasUI: true, sessionManager: { getSessionFile: () => options.sessionFile === undefined ? "/sessions/current.jsonl" : options.sessionFile, getSessionId: () => "current" },
				ui: { notify: (message: string) => notices.push(message) },
			});
		},
		async shutdown() { auto.shutdown(); await inspector.shutdown(); },
	};
}

test("matching background start opens the public inspector runner beside the parent", async () => {
	const h = harness();
	await h.session();
	await h.emit("subagent:async-started", started);
	const split = h.commands.find((args) => args.includes("split"))!;
	expect(split).toBeDefined();
	expect(split.slice(split.indexOf("--") + 1)).toEqual([
		process.execPath, "/packages/pi-subagents/inspector-runner.mjs", "--async-dir", "/async dir", "--run-id", "run",
		"--allow-steer", "true", "--allow-stop", "true", "--session-roots", "WyIvc2Vzc2lvbnMvcm9vdCJd",
	]);
	expect(split).toContain("--split=right");
	expect(h.commands.some((args) => args.includes("focus"))).toBe(false);
	expect(h.plugin.owns(context)).toBe(true);
	await h.shutdown();
});

test.each([
	{ env: { PI_REX_PANES_AUTO_INSPECT: "0" } },
	{ settings: { autoInspect: false } },
	{ env: { PI_REX_PANES_AUTO_INSPECT: "1" }, settings: { autoInspect: false } },
])("auto inspect off switch skips starts: %j", async (options) => {
	const h = harness(options);
	await h.session();
	await h.emit("subagent:async-started", started);
	expect(h.commands).toEqual([]);
	await h.shutdown();
});

test.each([
	null, [], {}, { ...started, id: "" }, { ...started, asyncDir: 1 }, { ...started, cwd: null },
	{ ...started, mode: false }, { ...started, sessionRoot: [] }, { ...started, sessionId: "other" },
])("ignores malformed or foreign-session starts: %j", async (payload) => {
	const h = harness();
	await h.session();
	await h.emit("subagent:async-started", payload);
	expect(h.commands).toEqual([]);
	await h.shutdown();
});

test.each([
	{ owner: "/packages/other/bundle/index.js" },
	{ reporter: true }, { accepted: false }, { env: { REX_BLOCK: "" } },
])("auto inspect requires pi-subagents ownership and an available parent: %j", async (options) => {
	const h = harness(options);
	await h.session();
	await h.emit("subagent:async-started", started);
	expect(h.commands).toEqual([]);
	await h.shutdown();
});

test("missing runner disables automatic opens for the session with one notice", async () => {
	const h = harness({ exists: false });
	await h.session();
	await h.emit("subagent:async-started", started);
	await h.emit("subagent:async-started", { ...started, id: "another" });
	expect(h.checks).toEqual(["/packages/pi-subagents/inspector-runner.mjs"]);
	expect(h.notices).toHaveLength(1);
	expect(h.notices[0]).toContain("inspector-runner.mjs");
	expect(h.commands).toEqual([]);
	await h.shutdown();
});

test("completed automatic inspectors linger for 60 seconds then close", async () => {
	const h = harness();
	await h.session();
	await h.emit("subagent:async-started", started);
	await h.timers.advance(90_000);
	expect(h.live.has("pane-1")).toBe(true);
	await h.emit("subagent:async-complete", { runId: "run", success: true });
	await h.timers.advance(59_999);
	expect(h.live.has("pane-1")).toBe(true);
	await h.timers.advance(1);
	expect(h.live.has("pane-1")).toBe(false);
	expect(h.plugin.owns(context)).toBe(false);
	await h.shutdown();
});

test("Fleet reuses the automatic pane and focus postpones linger cleanup", async () => {
	const h = harness();
	await h.session();
	await h.emit("subagent:async-started", started);
	await h.plugin.open(context, { executable: "unused", argv: [], displayCommand: "", allowSteer: true, allowStop: true, sessionRoots: [] }, { focus: true });
	expect(h.commands.filter((args) => args.includes("split"))).toHaveLength(1);
	expect((await h.plugin.status!(context)).isError).not.toBe(true);
	h.focus("pane-1");
	await h.emit("subagent:async-complete", { id: "run", success: false });
	await h.timers.advance(100_000);
	expect(h.live.has("pane-1")).toBe(true);
	h.focus("parent");
	await h.timers.advance(34_999);
	expect(h.live.has("pane-1")).toBe(true);
	await h.timers.advance(1);
	expect(h.live.has("pane-1")).toBe(false);
	await h.shutdown();
});

test("shutdown closes automatic panes, cancels timers and removes listeners", async () => {
	const h = harness();
	await h.session();
	await h.emit("subagent:async-started", started);
	await h.emit("subagent:async-complete", { runId: "run", success: true });
	await h.shutdown();
	expect(h.live).toEqual(new Set(["parent", "foreign"]));
	expect(h.timers.pending).toBe(0);
	const before = h.commands.length;
	await h.emit("subagent:async-started", { ...started, id: "late" });
	await h.timers.advance(120_000);
	expect(h.commands).toHaveLength(before);
});

test.each([null, {}, { runId: 1 }, { runId: "" }, { runId: "run", success: "true" }, { runId: "unknown", success: true }])("malformed or unknown completion leaves the pane open: %j", async (payload) => {
	const h = harness();
	await h.session();
	await h.emit("subagent:async-started", started);
	await h.emit("subagent:async-complete", payload);
	await h.timers.advance(120_000);
	expect(h.live.has("pane-1")).toBe(true);
	await h.shutdown();
});

test.each([
	{ env: { PI_REX_PANES_LINGER_SECONDS: "2" }, settings: { lingerSeconds: 3 }, delay: 2_000 },
	{ settings: { lingerSeconds: 3 }, delay: 3_000 },
	{ env: { PI_REX_PANES_LINGER_SECONDS: "invalid" }, settings: { lingerSeconds: 3 }, delay: 60_000 },
	{ settings: { lingerSeconds: 0 }, delay: 0 },
])("automatic panes use the child linger settings: %j", async ({ delay, ...options }) => {
	const h = harness(options);
	await h.session();
	await h.emit("subagent:async-started", started);
	h.focus("pane-1");
	await h.emit("subagent:async-complete", { runId: "run" });
	if (delay === 0) expect(h.live.has("pane-1")).toBe(false);
	else {
		h.focus("parent");
		await h.timers.advance(delay - 1);
		expect(h.live.has("pane-1")).toBe(true);
		await h.timers.advance(1);
		expect(h.live.has("pane-1")).toBe(false);
	}
	await h.shutdown();
});

test("completion during a pending split starts linger after the inspector opens", async () => {
	let release!: () => void;
	const splitGate = new Promise<void>((resolve) => { release = resolve; });
	const h = harness({ splitGate });
	await h.session();
	await h.emit("subagent:async-started", started);
	await h.emit("subagent:async-complete", { runId: "run", success: true });
	expect(h.timers.pending).toBe(0);
	release();
	await flush();
	await h.timers.advance(60_000);
	expect(h.live.has("pane-1")).toBe(false);
	await h.shutdown();
});

test("completion leaves a Fleet replacement of the original automatic pane alone", async () => {
	const h = harness();
	await h.session();
	await h.emit("subagent:async-started", started);
	await h.plugin.close!(context);
	await h.plugin.open(context, { executable: "fleet", argv: [], displayCommand: "", allowSteer: true, allowStop: true, sessionRoots: [] }, {});
	await h.emit("subagent:async-complete", { runId: "run", success: true });
	await h.timers.advance(120_000);
	expect(h.live.has("pane-2")).toBe(true);
	await h.shutdown();
});

test("an unsaved parent matches the current session ID and omitted roots encode as an empty list", async () => {
	const h = harness({ sessionFile: null });
	await h.session();
	await h.emit("subagent:async-started", { ...started, sessionId: "current", sessionRoot: undefined, mode: "workflow" });
	const split = h.commands.find((args) => args.includes("split"))!;
	expect(split.at(-1)).toBe("W10=");
	await h.shutdown();
});

test("session replacement removes earlier listeners and resets a missing-runner notice", async () => {
	const options = { exists: false, sessionFile: "/sessions/current.jsonl" };
	const h = harness(options);
	await h.session();
	await h.emit("subagent:async-started", started);
	options.sessionFile = "/sessions/next.jsonl";
	await h.session();
	await h.emit("subagent:async-started", started);
	expect(h.notices).toHaveLength(1);
	await h.emit("subagent:async-started", { ...started, sessionId: options.sessionFile });
	expect(h.notices).toHaveLength(2);
	expect(h.checks).toHaveLength(2);
	await h.shutdown();
});
