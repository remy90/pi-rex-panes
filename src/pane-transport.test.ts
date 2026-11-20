import { expect, test } from "bun:test";
import { appendFileSync, existsSync, statSync } from "node:fs";
import { createPaneTransport, parseLingerSeconds, parseStartTimeout } from "./pane-transport.ts";
import type { Runner } from "./rex/client.ts";

test.each([undefined, "", "0", "-1", "1.5", "60s", "Infinity", "2147483648"])("invalid startup timeout %s uses 60 seconds", (value) => {
	expect(parseStartTimeout(value)).toBe(60_000);
});

test.each([["1", 1], [" 2000 ", 2000], ["2147483647", 2_147_483_647]] as const)("startup timeout %s accepts milliseconds", (value, expected) => {
	expect(parseStartTimeout(value)).toBe(expected);
});

test.each([undefined, null, "", " ", -1, "-1", 1.5, "1.5", "180s", Infinity, "Infinity", true, {}, 2_147_484])("invalid linger %j uses 180 seconds", (value) => {
	expect(parseLingerSeconds(value)).toBe(180);
});

test.each([[0, 0], [60, 60], [" 2 ", 2], ["0", 0], ["2147483", 2_147_483]] as const)("linger %j accepts whole seconds", (value, expected) => {
	expect(parseLingerSeconds(value)).toBe(expected);
});

test.each([
	[undefined, []],
	["", []],
	["/tmp/agent config=custom", ["PI_CODING_AGENT_DIR=/tmp/agent config=custom"]],
	[" \t ", ["PI_CODING_AGENT_DIR= \t "]],
] as const)("pane argv silences child program status and forwards only a non-empty agent directory: %j", async (agentDir, expected) => {
	let argv: string[] = [];
	const transport = createPaneTransport({
		env: { REX_SESSION: "s", REX_BLOCK: "p", PI_REX_PANES_KEEP: "1", PI_CODING_AGENT_DIR: agentDir },
		lookup: () => "rex",
		runner: async (_binary, args) => {
			argv = args.slice(args.indexOf("--") + 1, args.indexOf("--no-session"));
			return { code: 1, stdout: "", stderr: "split rejected" };
		},
	});
	await transport.run(launch);
	expect(argv).toEqual(["/usr/bin/env", "PI_PROGRAM_STATUS=0", "PI_REX_PANES_KEEP=1", `PI_REX_PANES_PARENT_PID=${process.pid}`, ...expected, "pi"]);
});

test("pane reports feed processLine from a private file, settle, and clean up", async () => {
	let file = "";
	let waitSignal: AbortSignal | undefined;
	const lines: string[] = [];
	const closed: string[] = [];
	const runner: Runner = async (_binary, args, options) => {
		if (args.includes("close")) {
			closed.push(args[5]!);
			return { code: 0, stdout: "", stderr: "" };
		}
		if (args.includes("wait")) {
			waitSignal = options?.signal;
			return new Promise(() => {});
		}
		if (args.includes("session.view")) return { code: 0, stdout: '{"active_window_id":"w","windows":[{"window_id":"w","focused_block_id":"p"}]}', stderr: "" };
		expect(args.slice(args.indexOf("--") + 1, args.indexOf("--") + 6)).toEqual(["/usr/bin/env", "PI_PROGRAM_STATUS=0", "PI_REX_PANES_KEEP=0", `PI_REX_PANES_PARENT_PID=${process.pid}`, "pi"]);
		file = args[args.indexOf("--rex-panes-report") + 1];
		expect(statSync(file).mode & 0o777).toBe(0o600);
		appendFileSync(file, '{"type":"message_end","message":{"role":"assistant","stopReason":"stop"}}\n{"type":"agent_settled"}\n');
		return { code: 0, stdout: '{"block_ids":["child","parent"]}', stderr: "" };
	};
	const clock = fakeClock();
	const transport = createPaneTransport({ env: { REX_SESSION: "s", REX_BLOCK: "p" }, lookup: () => "rex", runner, timers: clock });
	expect(await transport.run({ ...launch, processLine: (line) => lines.push(line) })).toEqual({ settled: true, aborted: false });
	expect(lines).toHaveLength(2);
	expect(closed).toEqual([]);
	expect(waitSignal?.aborted).toBe(true);
	expect(existsSync(file)).toBe(false);
	await clock.advance(179_999);
	expect(closed).toEqual([]);
	await clock.advance(1);
	expect(closed).toEqual(["child"]);
});

test.each([
	["2", 4, 2_000, 0],
	[" 3 ", 4, 3_000, 0],
	["0", 4, 0, 0],
	[undefined, 2, 2_000, 1],
	["", "3", 3_000, 1],
	[" \t ", 4, 4_000, 1],
	[undefined, 0, 0, 1],
	["invalid", 1, 180_000, 0],
	["-1", 1, 180_000, 0],
	["1.5", 1, 180_000, 0],
	["Infinity", 1, 180_000, 0],
	["2147484", 1, 180_000, 0],
	[undefined, -1, 180_000, 1],
	[undefined, 1.5, 180_000, 1],
	[undefined, Infinity, 180_000, 1],
	[undefined, "invalid", 180_000, 1],
	[undefined, null, 180_000, 1],
	[undefined, false, 180_000, 1],
	[undefined, {}, 180_000, 1],
	[undefined, undefined, 180_000, 1],
] as const)("linger env %s and setting %s close after %s ms", async (env, setting, delay, reads) => {
	let settingsReads = 0;
	const h = lingerHarness({
		env: { PI_REX_PANES_LINGER_SECONDS: env },
		settings: () => { settingsReads++; return { lingerSeconds: setting }; },
	});
	await h.transport.run(launch);
	expect(settingsReads).toBe(reads);
	if (delay > 0) {
		await h.clock.advance(delay - 1);
		expect(h.closed).toEqual([]);
		await h.clock.advance(1);
	} else await flush();
	expect(h.closed).toEqual(["child"]);
	if (delay === 0) expect(h.state.views).toBe(0);
});

test("focus postpones closing until the pane has been unfocused for 30 seconds", async () => {
	const h = lingerHarness();
	h.state.focused = "child";
	await h.transport.run(launch);
	await h.clock.advance(240_000);
	expect(h.closed).toEqual([]);
	h.state.focused = "p";
	await h.clock.advance(5_000);
	await h.clock.advance(29_999);
	expect(h.closed).toEqual([]);
	await h.clock.advance(1);
	expect(h.closed).toEqual(["child"]);
});

test("returning focus restarts the consecutive unfocused window", async () => {
	const h = lingerHarness();
	h.state.focused = "child";
	await h.transport.run(launch);
	await h.clock.advance(180_000);
	h.state.focused = undefined;
	await h.clock.advance(30_000);
	expect(h.closed).toEqual([]);
	h.state.focused = "child";
	await h.clock.advance(5_000);
	h.state.focused = "p";
	await h.clock.advance(34_999);
	expect(h.closed).toEqual([]);
	await h.clock.advance(1);
	expect(h.closed).toEqual(["child"]);
});

test.each([false, true])("a failed focus read counts as unfocused, postponed: %s", async (postponed) => {
	const h = lingerHarness();
	h.state.focused = postponed ? "child" : new Error("Rex unavailable");
	await h.transport.run(launch);
	await h.clock.advance(180_000);
	if (postponed) {
		expect(h.closed).toEqual([]);
		h.state.focused = new Error("Rex unavailable");
		await h.clock.advance(34_999);
		expect(h.closed).toEqual([]);
		await h.clock.advance(1);
	}
	expect(h.closed).toEqual(["child"]);
});

test("KEEP=1 skips the linger timer even when linger is zero", async () => {
	const h = lingerHarness({ env: { PI_REX_PANES_KEEP: "1", PI_REX_PANES_LINGER_SECONDS: "0" } });
	await h.transport.run(launch);
	expect(h.clock.pending).toBe(0);
	await h.clock.advance(1_000_000);
	expect(h.closed).toEqual([]);
	expect(h.state.views).toBe(0);
});

test("a throwing settings getter falls back to the default linger", async () => {
	const h = lingerHarness({ settings: () => { throw new Error("settings unavailable"); } });
	await h.transport.run(launch);
	await h.clock.advance(179_999);
	expect(h.closed).toEqual([]);
	await h.clock.advance(1);
	expect(h.closed).toEqual(["child"]);
});

test("a lingering pane anchors the next split until it closes", async () => {
	const h = lingerHarness();
	await h.transport.run(launch);
	await h.transport.run(launch);
	expect(h.anchors).toEqual(["p", "child"]);
	await h.clock.advance(180_000);
	expect(h.closed).toEqual(["child", "child-2"]);
	await h.transport.run(launch);
	expect(h.anchors).toEqual(["p", "child", "p"]);
});

test("shutdown retries a failed background close and the pane stays an anchor until closed", async () => {
	const h = lingerHarness();
	h.state.closeCode = 1;
	await h.transport.run(launch);
	await h.clock.advance(180_000);
	expect(h.closed).toEqual(["child", "child"]);
	expect(h.clock.pending).toBe(0);
	await h.transport.run(launch);
	expect(h.anchors).toEqual(["p", "child"]);
	h.state.closeCode = 0;
	await h.transport.shutdown();
	expect(h.closed).toEqual(["child", "child", "child", "child-2"]);
	await h.transport.run(launch);
	expect(h.anchors).toEqual(["p", "child", "p"]);
	await h.transport.shutdown();
});

test("shutdown closes every lingering pane and cancels focus checks", async () => {
	const h = lingerHarness();
	h.state.focused = "child";
	await h.transport.run(launch);
	await h.clock.advance(180_000);
	await h.transport.run(launch);
	await h.transport.shutdown();
	expect(h.closed).toEqual(["child", "child-2"]);
	expect(h.clock.pending).toBe(0);
	const reads = h.state.views;
	await h.clock.advance(1_000_000);
	expect(h.state.views).toBe(reads);
	expect(h.closed).toHaveLength(2);
});

test("shutdown during a focus read closes immediately and prevents rescheduling", async () => {
	const h = lingerHarness();
	let release!: () => void;
	h.state.viewGate = new Promise<void>((resolve) => { release = resolve; });
	h.state.focused = "child";
	await h.transport.run(launch);
	await h.clock.advance(180_000);
	expect(h.state.views).toBe(1);
	await h.transport.shutdown();
	expect(h.closed).toEqual(["child"]);
	release();
	await flush();
	expect(h.clock.pending).toBe(0);
	await h.clock.advance(1_000_000);
	expect(h.state.views).toBe(1);
	expect(h.closed).toHaveLength(1);
});

test("zero linger returns the result while close is pending and shutdown awaits the same close", async () => {
	const h = lingerHarness({ env: { PI_REX_PANES_LINGER_SECONDS: "0" } });
	let release!: () => void;
	h.state.closeGate = new Promise<void>((resolve) => { release = resolve; });
	expect(await h.transport.run(launch)).toEqual({ settled: true, aborted: false });
	let stopped = false;
	const shutdown = h.transport.shutdown().then(() => { stopped = true; });
	await flush();
	expect(stopped).toBe(false);
	expect(h.closed).toEqual(["child"]);
	release();
	await shutdown;
	expect(stopped).toBe(true);
	expect(h.closed).toEqual(["child"]);
});

test("shutdown bounds a hanging linger close by the grace period", async () => {
	const h = lingerHarness({ env: { PI_REX_PANES_LINGER_SECONDS: "0" }, shutdownGraceMs: 5 });
	let release!: () => void;
	h.state.closeGate = new Promise<void>((resolve) => { release = resolve; });
	await h.transport.run(launch);
	await h.transport.shutdown();
	expect(h.closed).toEqual(["child"]);
	release();
	await flush();
});

test("shutdown between settlement and the run continuation closes the successful pane", async () => {
	const h = lingerHarness();
	let shutdown: Promise<void> | undefined;
	const outcome = await h.transport.run({ ...launch, processLine: () => {
		queueMicrotask(() => { shutdown = h.transport.shutdown(); });
	} });
	await shutdown;
	expect(outcome).toEqual({ settled: true, aborted: false });
	expect(h.closed).toEqual(["child"]);
	expect(h.clock.pending).toBe(0);
});

test.each(["abort", "shutdown"])("%s during an in-flight split waits for its ID and closes the pane", async (action) => {
	const controller = new AbortController();
	const calls: string[][] = [];
	let release!: () => void;
	let opening!: () => void;
	const opened = new Promise<void>((resolve) => { opening = resolve; });
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const runner: Runner = async (_binary, args) => {
		calls.push(args);
		if (args.includes("split")) {
			opening();
			await gate;
			return { code: 0, stdout: '{"block_ids":["child"]}', stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};
	const transport = createPaneTransport({ env: { REX_SESSION: "s", REX_BLOCK: "p", PI_REX_PANES_KEEP: "1" }, lookup: () => "rex", runner });
	const pending = transport.run({ ...launch, signal: controller.signal });
	await opened;
	let shutdownDone = false;
	const shutdown = action === "shutdown" ? transport.shutdown().then(() => { shutdownDone = true; }) : undefined;
	if (action === "abort") controller.abort();
	await Promise.resolve();
	expect(shutdownDone).toBe(false);
	release();
	expect(await pending).toEqual({ settled: false, aborted: true });
	await shutdown;
	if (action === "shutdown") expect(shutdownDone).toBe(true);
	expect(calls.map((args) => args.slice(3))).toEqual([
		expect.arrayContaining(["split"]), ["block", "close", "child", "-s", "s"],
	]);
});

test.each(["nonzero", "timeout", "reject"])("abort retries a %s close and forgets the pane after success", async (failure) => {
	const controller = new AbortController();
	let closes = 0;
	const anchors: string[] = [];
	const transport = createPaneTransport({
		env: { REX_SESSION: "s", REX_BLOCK: "p" }, lookup: () => "rex",
		runner: async (_binary, args) => {
			if (args.includes("split")) {
				anchors.push(args[args.indexOf("-b") + 1]!);
				controller.abort();
				const file = args[args.indexOf("--rex-panes-report") + 1]!;
				appendFileSync(file, '{"type":"agent_settled"}\n');
				return { code: 0, stdout: '{"block_ids":["child"]}', stderr: "" };
			}
			if (args.includes("close") && ++closes === 1) {
				if (failure === "reject") throw new Error("spawn failed");
				return { code: failure === "timeout" ? null : 1, stdout: "", stderr: "close failed" };
			}
			return { code: 0, stdout: "", stderr: "" };
		},
	});
	expect(await transport.run({ ...launch, signal: controller.signal })).toEqual({ settled: false, aborted: true });
	expect(closes).toBe(2);
	await transport.run(launch);
	expect(anchors).toEqual(["p", "p"]);
});

test("two failed close attempts keep the live pane as the next placement anchor", async () => {
	const controller = new AbortController();
	let closes = 0;
	const anchors: string[] = [];
	const transport = createPaneTransport({
		env: { REX_SESSION: "s", REX_BLOCK: "p", PI_REX_PANES_KEEP: "1" }, lookup: () => "rex",
		runner: async (_binary, args) => {
			if (args.includes("split")) {
				anchors.push(args[args.indexOf("-b") + 1]!);
				controller.abort();
				const file = args[args.indexOf("--rex-panes-report") + 1]!;
				appendFileSync(file, '{"type":"agent_settled"}\n');
				return { code: 0, stdout: '{"block_ids":["child"]}', stderr: "" };
			}
			if (args.includes("close")) { closes++; return { code: 1, stdout: "", stderr: "close failed" }; }
			return { code: 0, stdout: "child\n", stderr: "" };
		},
	});
	const outcome = await transport.run({ ...launch, signal: controller.signal });
	expect(outcome).toMatchObject({ settled: false, aborted: true });
	expect(outcome?.warning).toBe("Warning: Could not confirm pane child closed. It may still be open; close it manually.");
	expect(closes).toBe(2);
	await transport.run(launch);
	expect(anchors).toEqual(["p", "child"]);
});

test.each([
	["assistant error", "error", "0", true],
	["assistant abort", "aborted", "0", true],
	["startup crash", "", "0", false],
	["keep enabled", "stop", "1", true],
] as const)("%s leaves the pane open", async (_name, stopReason, keep, settled) => {
	const calls: string[][] = [];
	const transport = createPaneTransport({
		env: { REX_SESSION: "s", REX_BLOCK: "p", PI_REX_PANES_KEEP: keep }, lookup: () => "rex",
		runner: async (_binary, args) => {
			calls.push(args);
			if (args.includes("split")) {
				expect(args).toContain(`PI_REX_PANES_PARENT_PID=${process.pid}`);
				const file = args[args.indexOf("--rex-panes-report") + 1]!;
				if (stopReason) appendFileSync(file, `${JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason } })}\n`);
				if (settled) appendFileSync(file, '{"type":"agent_settled"}\n');
				return { code: 0, stdout: '{"block_ids":["child"]}', stderr: "" };
			}
			return { code: 1, stdout: '{"exit_code":1}', stderr: "" };
		},
	});
	const outcome = await transport.run(launch);
	expect(outcome?.settled).toBe(settled);
	if (!settled) expect(outcome?.error?.message).toContain("before agent_settled");
	expect(calls.some((args) => args.includes("close"))).toBe(false);
});

test.each(["reject", "malformed"])("a healthy child keeps reporting through a Rex %s outage", async (failure) => {
	let waits = 0;
	let reportTimer: ReturnType<typeof setTimeout> | undefined;
	let waitSignal: AbortSignal | undefined;
	const transport = createPaneTransport({
		env: { REX_SESSION: "s", REX_BLOCK: "p" }, lookup: () => "rex",
		runner: async (_binary, args, options) => {
			if (args.includes("split")) {
				const file = args[args.indexOf("--rex-panes-report") + 1]!;
				appendFileSync(file, '{"type":"agent_start"}\n');
				reportTimer = setTimeout(() => appendFileSync(file, '{"type":"agent_settled"}\n'), 400);
				return { code: 0, stdout: '{"block_ids":["child"]}', stderr: "" };
			}
			if (args.includes("close")) return { code: 0, stdout: "", stderr: "" };
			waitSignal = options?.signal;
			if (args.includes("wait")) waits++;
			if (failure === "reject") throw new Error("Rex disconnected");
			if (args.includes("ls")) return { code: 1, stdout: "", stderr: "Rex disconnected" };
			return { code: 0, stdout: "broken response", stderr: "" };
		},
	});
	try {
		expect(await transport.run(launch)).toEqual({ settled: true, aborted: false });
		expect(waits).toBeGreaterThan(0);
		expect(waitSignal?.aborted).toBe(true);
	} finally { if (reportTimer) clearTimeout(reportTimer); }
});

test("a live child without agent_start fails within the startup timeout and stays open", async () => {
	const calls: string[][] = [];
	let waitSignal: AbortSignal | undefined;
	const transport = createPaneTransport({
		env: { REX_SESSION: "s", REX_BLOCK: "p", PI_REX_PANES_START_TIMEOUT_MS: "15" }, lookup: () => "rex",
		runner: async (_binary, args, options) => {
			calls.push(args);
			if (args.includes("wait")) { waitSignal = options?.signal; return new Promise(() => {}); }
			return { code: 0, stdout: '{"block_ids":["child"]}', stderr: "" };
		},
	});
	const outcome = await transport.run(launch);
	expect(outcome).toMatchObject({ settled: false, aborted: false });
	expect(outcome?.error?.message).toContain("agent_start");
	expect(outcome?.error?.message).toContain("15 ms");
	expect(calls.some((args) => args.includes("close"))).toBe(false);
	expect(waitSignal?.aborted).toBe(true);
}, 1000);

test("an uncertain split returns failure without selecting the headless fallback", async () => {
	const transport = createPaneTransport({
		env: { REX_SESSION: "s", REX_BLOCK: "p" }, lookup: () => "rex",
		runner: async () => ({ code: 0, stdout: "invalid response", stderr: "" }),
	});
	expect(await transport.run(launch)).toMatchObject({ settled: false, aborted: false, error: { mayHaveStarted: true } });
});

test("shutdown cancels queued children and awaits the one in-flight pane close", async () => {
	let release!: () => void;
	let opening!: () => void;
	const opened = new Promise<void>((resolve) => { opening = resolve; });
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const calls: string[][] = [];
	const transport = createPaneTransport({
		env: { REX_SESSION: "s", REX_BLOCK: "p" }, lookup: () => "rex",
		runner: async (_binary, args) => {
			calls.push(args);
			if (args.includes("split")) { opening(); await gate; }
			return { code: 0, stdout: '{"block_ids":["child"]}', stderr: "" };
		},
	});
	const children = [transport.run(launch), transport.run(launch), transport.run(launch)];
	await opened;
	const shutdown = transport.shutdown();
	release();
	await shutdown;
	expect(await Promise.all(children)).toEqual(Array(3).fill({ settled: false, aborted: true }));
	expect(calls.filter((args) => args.includes("split"))).toHaveLength(1);
	expect(calls.filter((args) => args.includes("close"))).toHaveLength(1);
});

test("shutdown returns after its grace period when pane cleanup hangs", async () => {
	let opening!: () => void;
	const opened = new Promise<void>((resolve) => { opening = resolve; });
	let cleanupStarted!: () => void;
	let release!: () => void;
	const cleaning = new Promise<void>((resolve) => { cleanupStarted = resolve; });
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const transport = createPaneTransport({
		env: { REX_SESSION: "s", REX_BLOCK: "p" }, lookup: () => "rex", shutdownGraceMs: 5,
		runner: async (_binary, args) => {
			if (args.includes("split")) {
				opening();
				return { code: 0, stdout: '{"block_ids":["child"]}', stderr: "" };
			}
			if (args.includes("close")) { cleanupStarted(); await gate; }
			return { code: 0, stdout: "", stderr: "" };
		},
	});
	const child = transport.run(launch);
	await opened;
	const shutdown = transport.shutdown();
	await cleaning;
	await shutdown;
	release();
	expect(await child).toEqual({ settled: false, aborted: true });
});

function lingerHarness(config: Omit<NonNullable<Parameters<typeof createPaneTransport>[0]>, "runner" | "timers" | "lookup"> = {}) {
	const clock = fakeClock();
	const closed: string[] = [];
	const anchors: string[] = [];
	const live = new Set<string>();
	const state = {
		focused: "p" as string | Error | undefined,
		views: 0,
		viewGate: undefined as Promise<void> | undefined,
		closeGate: undefined as Promise<void> | undefined,
		closeCode: 0,
	};
	const transport = createPaneTransport({
		...config, env: { REX_SESSION: "s", REX_BLOCK: "p", ...config.env }, lookup: () => "rex", timers: clock,
		runner: async (_binary, args) => {
			if (args.includes("split")) {
				anchors.push(args[args.indexOf("-b") + 1]!);
				const file = args[args.indexOf("--rex-panes-report") + 1]!;
				appendFileSync(file, '{"type":"agent_settled"}\n');
				const id = anchors.length === 1 ? "child" : `child-${anchors.length}`;
				live.add(id);
				return { code: 0, stdout: JSON.stringify({ block_ids: [id] }), stderr: "" };
			}
			if (args.includes("session.view")) {
				state.views++;
				await state.viewGate;
				if (state.focused instanceof Error) throw state.focused;
				return { code: 0, stdout: JSON.stringify({ active_window_id: "w", windows: [{ window_id: "w", focused_block_id: state.focused }] }), stderr: "" };
			}
			if (args.includes("wait")) return new Promise(() => {});
			if (args.includes("close")) {
				closed.push(args[5]!);
				await state.closeGate;
				if (state.closeCode !== 0) return { code: state.closeCode, stdout: "", stderr: "close failed" };
				live.delete(args[5]!);
			}
			return { code: 0, stdout: [...live].join("\n"), stderr: "" };
		},
	});
	return { transport, clock, closed, anchors, state };
}

function fakeClock() {
	let now = 0;
	let nextId = 0;
	const pending = new Map<number, { at: number; callback: () => void }>();
	return {
		now: () => now,
		setTimeout(callback: () => void, ms: number): unknown {
			const id = ++nextId;
			pending.set(id, { at: now + ms, callback });
			return id;
		},
		clearTimeout(id: unknown) { pending.delete(id as number); },
		async advance(ms: number) {
			const until = now + ms;
			while (true) {
				const next = [...pending].sort((a, b) => a[1].at - b[1].at).find(([, timer]) => timer.at <= until);
				if (!next) break;
				const [id, timer] = next;
				now = timer.at;
				pending.delete(id);
				timer.callback();
				await flush();
			}
			now = until;
			await flush();
		},
		get pending() { return pending.size; },
	};
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const launch = { label: "scout", cwd: "/work", argv: (file: string) => ["pi", "--no-session", "--rex-panes-report", file, "Task: hello"], processLine() {} };

test.each([
	["missing session", { REX_BLOCK: "parent" }, true, false],
	["missing block", { REX_SESSION: "s" }, true, false],
	["disabled panes", { REX_SESSION: "s", REX_BLOCK: "parent", PI_REX_PANES: "0" }, true, false],
	["missing rex", { REX_SESSION: "s", REX_BLOCK: "parent" }, false, false],
	["split failed before launch", { REX_SESSION: "s", REX_BLOCK: "parent" }, true, true],
] as const)("%s selects the headless fallback", async (_name, env, found, splitFails) => {
	let calls = 0;
	const transport = createPaneTransport({ env, lookup: () => found ? "/bin/rex" : undefined, runner: async () => {
		calls++;
		throw new Error("split rejected");
	} });
	expect(await transport.run(launch)).toBeUndefined();
	expect(calls).toBe(splitFails ? 1 : 0);
});
