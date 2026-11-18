import { expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runSingleAgent } from "./index.ts";
import { createPaneTransport } from "./pane-transport.ts";
import type { AgentConfig } from "./agents.ts";

const agent: AgentConfig = {
	name: "scout", description: "Inspect files", source: "user", filePath: "/agents/scout.md",
	systemPrompt: "Inspect carefully.", tools: ["read", "bash"],
};

const cases = [
	["successful settle", "stop", "completed", 0],
	["settled assistant error", "error", "failed", 0],
	["settled assistant abort", "aborted", "aborted", 0],
	["uncertain launch", "uncertain", "failed", 1],
	["report failure", "exit", "failed", 1],
	["task abort", "abort", "aborted", 1],
] as const;

test.each(cases)("pane branch handles %s", async (_name, kind, status, exitCode) => {
	const controller = new AbortController();
	let splits = 0;
	const closed: string[] = [];
	const transport = createPaneTransport({
		env: { REX_SESSION: "s", REX_BLOCK: "p" }, lookup: () => "rex",
		runner: async (_binary, args) => {
			if (args.includes("close")) closed.push(args[5]!);
			if (args.includes("split")) {
				splits++;
				if (kind === "uncertain") return { code: 0, stdout: "malformed split response", stderr: "" };
				if (kind === "abort") controller.abort();
				if (["stop", "error", "aborted"].includes(kind)) {
					const file = args[args.indexOf("--rex-panes-report") + 1]!;
					appendFileSync(file, `${JSON.stringify({ type: "message_end", message: {
						role: "assistant", content: [{ type: "text", text: "Report" }], model: "provider/model",
						stopReason: kind, errorMessage: kind === "error" ? "Provider rejected prompt" : undefined,
						usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { total: 0 } },
					} })}\n{"type":"agent_settled"}\n`);
				}
				return { code: 0, stdout: '{"block_ids":["child"]}', stderr: "" };
			}
			return { code: 0, stdout: "", stderr: "" };
		},
	});
	const result = await runSingleAgent(transport, { model: "provider/model", thinkingLevel: "high" },
		{ agent, available: [agent], cwd: process.cwd() }, "scout", "hello", undefined, controller.signal, undefined,
		(results) => ({ mode: "single", results, isError: false }));
	expect(result.status).toBe(status);
	expect(result.exitCode).toBe(exitCode);
	expect(splits).toBe(1);
	expect(closed).toEqual(kind === "stop" || kind === "abort" ? ["child"] : []);
	if (kind === "error") expect(result.errorMessage).toBe("Provider rejected prompt");
	if (kind === "uncertain") expect(result.errorMessage).toContain("no usable block ID");
	if (kind === "exit") expect(result.errorMessage).toContain("before agent_settled");
});

test.each(["0", "1"])("pane branch launches the documented argv with KEEP=%s", async (keep) => {
	let promptFile = "";
	let prompt = "";
	let reportFile = "";
	let argv: string[] = [];
	const transport = createPaneTransport({
		env: { REX_SESSION: "s", REX_BLOCK: "p", PI_REX_PANES_KEEP: keep }, lookup: () => "rex",
		runner: async (_binary, args) => {
			if (args.includes("split")) {
				argv = args.slice(args.indexOf("--") + 1);
				promptFile = argv[argv.indexOf("--append-system-prompt") + 1]!;
				reportFile = argv[argv.indexOf("--rex-panes-report") + 1]!;
				prompt = readFileSync(promptFile, "utf8");
				appendFileSync(reportFile, '{"type":"agent_settled"}\n');
				return { code: 0, stdout: '{"block_ids":["child"]}', stderr: "" };
			}
			return { code: 0, stdout: "", stderr: "" };
		},
	});
	const result = await runSingleAgent(transport, { model: "provider/model", thinkingLevel: "high" },
		{ agent, available: [agent], cwd: process.cwd() }, "scout", "hello", undefined, undefined, undefined,
		(results) => ({ mode: "single", results, isError: false }));
	expect(result.status).toBe("completed");
	expect(argv.slice(0, 2)).toEqual(["/usr/bin/env", `PI_REX_PANES_KEEP=${keep}`]);
	expect(argv.slice(argv.indexOf("--no-session"))).toEqual([
		"--no-session", "--model", "provider/model", "--thinking", "high", "--tools", "read,bash",
		"--append-system-prompt", promptFile, "-e", fileURLToPath(new URL("./index.ts", import.meta.url)),
		"--rex-panes-report", reportFile, "Task: hello",
	]);
	expect(prompt).toBe("Inspect carefully.");
	expect(promptFile).not.toBe("");
	expect(existsSync(promptFile)).toBe(false);
});
