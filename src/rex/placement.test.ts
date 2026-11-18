import { expect, test } from "bun:test";
import { createRexClient } from "./client.ts";
import { createPlacement } from "./placement.ts";

test("concurrent children split right at 40%, then below the most recent open child", async () => {
	const splits: string[][] = [];
	let next = 0;
	let live = "one\ntwo\nthree\n";
	const rex = createRexClient("rex", "s", async (_binary, args) => {
		expect(args.slice(0, 3)).toEqual(["--autostart=false", "--timeout", "3s"]);
		if (args.includes("ls")) return { code: 0, stdout: live, stderr: "" };
		splits.push(args);
		return { code: 0, stdout: JSON.stringify({ block_ids: [["one", "two", "three", "four"][next++]] }), stderr: "" };
	});
	const placement = createPlacement(rex, "parent");
	const options = { label: "scout", cwd: "/work", argv: ["pi"] };
	expect(await Promise.all([placement.open(options), placement.open(options), placement.open(options)])).toEqual(["one", "two", "three"]);
	live = "one\ntwo\n"; // The user closed the third pane.
	await placement.open(options);
	expect(splits.map((args) => [args[args.indexOf("-b") + 1], args.find((arg) => arg.startsWith("--split=")), args[args.indexOf("--ratio") + 1]])).toEqual([
		["parent", "--split=right", "40"], ["one", "--split=below", "50"],
		["two", "--split=below", "50"], ["two", "--split=below", "50"],
	]);
});
