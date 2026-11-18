import { expect, test } from "bun:test";
import { buildChildArgs } from "./child-args.ts";

test("pane argv matches the interactive child contract with all options", () => {
	expect(buildChildArgs({
		model: "provider/model", thinking: "high", tools: ["read", "bash"],
		promptFile: "/private/prompt file.md", task: "Inspect 'a b'\nand report",
		pane: { extensionPath: "/package/src/index.ts", reportFile: "/private/report.ndjson" },
	})).toEqual([
		"--no-session", "--model", "provider/model", "--thinking", "high", "--tools", "read,bash",
		"--append-system-prompt", "/private/prompt file.md", "-e", "/package/src/index.ts",
		"--rex-panes-report", "/private/report.ndjson", "Task: Inspect 'a b'\nand report",
	]);
});

test("pane argv omits unset options and empty tools", () => {
	expect(buildChildArgs({ task: "hello", tools: [], pane: { extensionPath: "/index.ts", reportFile: "/report" } })).toEqual([
		"--no-session", "-e", "/index.ts", "--rex-panes-report", "/report", "Task: hello",
	]);
});

test("headless argv keeps JSON print mode and the same task options", () => {
	expect(buildChildArgs({ model: "provider/model", thinking: "low", tools: ["read"], promptFile: "/prompt", task: "hello" })).toEqual([
		"--mode", "json", "-p", "--no-session", "--model", "provider/model", "--thinking", "low", "--tools", "read",
		"--append-system-prompt", "/prompt", "Task: hello",
	]);
});
