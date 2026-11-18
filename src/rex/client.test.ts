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
		return { code: 1, stdout: "exit payload", stderr: "" };
	});
	await rex.closePane("b");
	expect(await rex.waitPane("b", { signal })).toEqual({ code: 1, stdout: "exit payload", stderr: "" });
	expect(calls).toEqual([
		["--autostart=false", "--timeout", "3s", "block", "close", "b", "-s", "s"],
		["--autostart=false", "--timeout", "3s", "wait", "b", "-s", "s", "--json"],
	]);
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
