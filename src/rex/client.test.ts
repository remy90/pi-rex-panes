import { expect, test } from "bun:test";
import { createRexClient, type Runner } from "./client.ts";
import { findRex } from "./lookup.ts";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("openPane preserves focus and reads only the first split block ID", async () => {
	const calls: string[][] = [];
	const runner: Runner = async (binary, args) => {
		expect(binary).toBe("/rex/bin/rex");
		calls.push(args);
		return { code: 0, stdout: '{"block_ids":["child","parent"]}', stderr: "" };
	};
	const rex = createRexClient("/rex/bin/rex", "session", runner);
	expect(await rex.openPane({ anchor: "parent", direction: "right", ratio: 40, label: "scout", cwd: "/work", argv: ["pi", "Task: 'hello'\nworld"] })).toBe("child");
	expect(calls).toEqual([["--autostart=false", "--timeout", "3s", "split", "-s", "session", "-b", "parent", "--split=right", "--ratio", "40", "--focus=false", "--label", "scout", "-c", "/work", "--shell=none", "--keep-open", "--json", "--", "pi", "Task: 'hello'\nworld"]]);
});

test("closePane and waitPane scope every call and forward wait cancellation", async () => {
	const calls: string[][] = [];
	const signal = new AbortController().signal;
	const rex = createRexClient("rex", "s", async (_binary, args, options) => {
		calls.push(args);
		if (args.includes("wait")) expect(options?.signal).toBe(signal);
		return { code: 1, stdout: '{"exit_code":1}', stderr: "" };
	});
	await rex.closePane("b");
	await rex.waitPane("b", { signal });
	expect(calls).toEqual([
		["--autostart=false", "--timeout", "3s", "block", "close", "b", "-s", "s"],
		["--autostart=false", "--timeout", "3s", "wait", "b", "-s", "s", "--json"],
	]);
});

test.each([
	{ code: 1, stdout: "", stderr: "connection lost" },
	{ code: 0, stdout: "not json", stderr: "" },
	{ code: 0, stdout: '{"exit_code":"0"}', stderr: "" },
	{ code: null, stdout: '{"exit_code":0}', stderr: "" },
	new Error("spawn failed"),
])("waitPane confirms the child is running before re-arming a failed wait: %j", async (failure) => {
	let waits = 0;
	let confirmations = 0;
	const rex = createRexClient("rex", "s", async (_binary, args) => {
		if (args.includes("wait")) {
			if (++waits === 1) {
				if (failure instanceof Error) throw failure;
				return failure;
			}
			return { code: 3, stdout: '{"exit_code":3,"error":"exit status 3"}', stderr: "exit status 3" };
		}
		expect(args.slice(3)).toEqual(["block", "call", "-s", "s", "-b", "b", "process"]);
		confirmations++;
		return { code: 0, stdout: '{"last_exit":null}', stderr: "" };
	});
	await rex.waitPane("b");
	expect(waits).toBe(2);
	expect(confirmations).toBe(1);
});

test.each([0, 1, 3, -1])("waitPane accepts a confirmed child exit with code %s", async (exitCode) => {
	let calls = 0;
	const rex = createRexClient("rex", "s", async () => {
		calls++;
		return { code: exitCode === -1 ? 1 : exitCode, stdout: JSON.stringify({ exit_code: exitCode }), stderr: "" };
	});
	await rex.waitPane("b");
	expect(calls).toBe(1);
});

test("waitPane polls process state after its bounded wait retries and confirms an exit", async () => {
	let waits = 0;
	let inspections = 0;
	const rex = createRexClient("rex", "s", async (_binary, args) => {
		if (args.includes("wait")) {
			waits++;
			return { code: 1, stdout: "", stderr: "connection lost" };
		}
		inspections++;
		return { code: 0, stdout: inspections > 3 ? '{"last_exit":{"exit_code":1}}' : '{"last_exit":null}', stderr: "" };
	});
	await rex.waitPane("b");
	expect(waits).toBe(3);
	expect(inspections).toBe(4);
});

test("waitPane confirms a removed pane through a successful block listing", async () => {
	const calls: string[][] = [];
	const rex = createRexClient("rex", "s", async (_binary, args) => {
		calls.push(args.slice(3));
		if (args.includes("ls")) return { code: 0, stdout: "other-pane\n", stderr: "" };
		return { code: 3, stdout: "", stderr: "block not found" };
	});
	await rex.waitPane("b");
	expect(calls).toEqual([
		["wait", "b", "-s", "s", "--json"],
		["block", "call", "-s", "s", "-b", "b", "process"],
		["block", "ls", "-s", "s", "-q", "--short=false"],
	]);
});

test.each([1, 3])("abort stops recovery during the backoff after wait attempt %s", async (abortAfter) => {
	const controller = new AbortController();
	let waits = 0;
	let inspections = 0;
	let abortTimer: ReturnType<typeof setTimeout> | undefined;
	const rex = createRexClient("rex", "s", async (_binary, args, options) => {
		expect(options?.signal).toBe(controller.signal);
		if (args.includes("wait")) {
			waits++;
			return { code: 1, stdout: "", stderr: "connection lost" };
		}
		inspections++;
		if (inspections === abortAfter) abortTimer = setTimeout(() => controller.abort(), 10);
		return { code: 0, stdout: '{"last_exit":null}', stderr: "" };
	});
	try {
		await expect(rex.waitPane("b", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
		expect(waits).toBe(abortAfter);
		expect(inspections).toBe(abortAfter);
	} finally {
		if (abortTimer) clearTimeout(abortTimer);
		controller.abort();
	}
});

test.each([false, true])("abort after an in-flight wait returns starts no recovery commands, rejection: %s", async (reject) => {
	const controller = new AbortController();
	let calls = 0;
	const rex = createRexClient("rex", "s", async () => {
		calls++;
		controller.abort();
		if (reject) throw new Error("killed");
		return { code: null, stdout: "", stderr: "" };
	});
	await expect(rex.waitPane("b", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
	expect(calls).toBe(1);
});

test.each([
	{ code: 0, stdout: "not json", stderr: "" },
	{ code: 0, stdout: '{"block_ids":[]}', stderr: "" },
	{ code: 1, stdout: "", stderr: "request timed out" },
	{ code: null, stdout: "", stderr: "" },
])("an ambiguous split result reports that the child may have started", async (result) => {
	const rex = createRexClient("rex", "s", async () => result);
	await expect(rex.openPane({ anchor: "p", direction: "right", ratio: 40, label: "s", cwd: "/", argv: ["pi"] })).rejects.toMatchObject({ mayHaveStarted: true });
});

test("binary lookup checks REX_BIN_DIR before PATH and skips non-executable files", () => {
	const dir = mkdtempSync(join(tmpdir(), "rex-lookup-"));
	try {
		const preferred = join(dir, "preferred");
		const fallback = join(dir, "fallback");
		mkdirSync(preferred);
		mkdirSync(fallback);
		for (const place of [preferred, fallback]) {
			writeFileSync(join(place, "rex"), "#!/bin/sh\n", { mode: 0o700 });
		}
		expect(findRex({ REX_BIN_DIR: preferred, PATH: fallback })).toBe(join(preferred, "rex"));
		chmodSync(join(preferred, "rex"), 0o600);
		expect(findRex({ REX_BIN_DIR: preferred, PATH: fallback })).toBe(join(fallback, "rex"));
		expect(findRex({ PATH: join(dir, "missing") })).toBeUndefined();
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
