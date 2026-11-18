import { expect, test } from "bun:test";
import { appendFileSync, existsSync, statSync } from "node:fs";
import { createPaneTransport, parseStartTimeout } from "./pane-transport.ts";
import type { Runner } from "./rex/client.ts";

test.each([undefined, "", "0", "-1", "1.5", "60s", "Infinity", "2147483648"])("invalid startup timeout %s uses 60 seconds", (value) => {
	expect(parseStartTimeout(value)).toBe(60_000);
});

test.each([["1", 1], [" 2000 ", 2000], ["2147483647", 2_147_483_647]] as const)("startup timeout %s accepts milliseconds", (value, expected) => {
	expect(parseStartTimeout(value)).toBe(expected);
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
		expect(args.slice(args.indexOf("--") + 1, args.indexOf("--") + 4)).toEqual(["/usr/bin/env", "PI_REX_PANES_KEEP=0", "pi"]);
		file = args[args.indexOf("--rex-panes-report") + 1];
		expect(statSync(file).mode & 0o777).toBe(0o600);
		appendFileSync(file, '{"type":"message_end","message":{"role":"assistant","stopReason":"stop"}}\n{"type":"agent_settled"}\n');
		return { code: 0, stdout: '{"block_ids":["child","parent"]}', stderr: "" };
	};
	const transport = createPaneTransport({ env: { REX_SESSION: "s", REX_BLOCK: "p" }, lookup: () => "rex", runner });
	expect(await transport.run({ ...launch, processLine: (line) => lines.push(line) })).toEqual({ settled: true, aborted: false });
	expect(lines).toHaveLength(2);
	expect(closed).toEqual(["child"]);
	expect(waitSignal?.aborted).toBe(true);
	expect(existsSync(file)).toBe(false);
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
	expect(outcome?.warning).toBe("Could not confirm pane child closed. It may still be open; close it manually.");
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
				expect(args).toContain(`PI_REX_PANES_KEEP=${keep}`);
				const file = args[args.indexOf("--rex-panes-report") + 1]!;
				if (stopReason) appendFileSync(file, `${JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason } })}\n`);
				if (settled) appendFileSync(file, '{"type":"agent_settled"}\n');
				return { code: 0, stdout: '{"block_ids":["child"]}', stderr: "" };
			}
			return { code: 0, stdout: "", stderr: "" };
		},
	});
	const outcome = await transport.run(launch);
	expect(outcome?.settled).toBe(settled);
	if (!settled) expect(outcome?.error?.message).toContain("before agent_settled");
	expect(calls.some((args) => args.includes("close"))).toBe(false);
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
