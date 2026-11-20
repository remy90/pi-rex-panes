import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";

function harness(owner?: string, reporter = false) {
	const handlers = new Map<string, Function[]>();
	const flags: string[] = [];
	const tools: string[] = [];
	const notices: string[] = [];
	const pi = {
		on(name: string, handler: Function) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
		registerFlag(name: string) { flags.push(name); },
		getFlag: () => reporter,
		registerTool(tool: { name: string }) { tools.push(tool.name); },
		getAllTools: () => owner ? [{ name: "subagent", sourceInfo: { path: owner } }] : [],
		getSettings: () => ({ rexPanes: { lingerSeconds: 0 } }),
		events: { emit() {}, on() { return () => {}; } },
	} as unknown as ExtensionAPI;
	extension(pi);
	return {
		flags, tools, notices,
		setOwner(path: string) { owner = path; },
		async fire(name: string, event: object = {}) {
			const results: unknown[] = [];
			for (const handler of handlers.get(name) ?? []) results.push(await handler(event, {
				hasUI: true, sessionManager: { getSessionFile: () => undefined, getSessionId: () => "interop-test" },
				ui: { notify: (message: string) => notices.push(message) },
			}));
			return results;
		},
	};
}

test("extension stands down while its reporter flag stays registered at load", async () => {
	const h = harness("/extensions/subagent/index.ts");
	expect(h.flags).toContain("rex-panes-report");
	await h.fire("session_start");
	await h.fire("before_agent_start");
	await h.fire("before_agent_start");
	expect(h.tools).toEqual([]);
	expect(h.notices).toHaveLength(1);
	expect(h.notices[0]).toContain("/extensions/subagent/index.ts");
	await h.fire("session_shutdown");
});

test("a fresh standalone session exposes subagent before its first request", async () => {
	const h = harness();
	expect(h.tools).toEqual([]);
	await h.fire("session_start");
	expect(h.tools).toEqual(["subagent"]);
	h.setOwner(new URL("../index.ts", import.meta.url).pathname);
	await h.fire("before_agent_start");
	expect(h.notices).toEqual([]);
	await h.fire("session_shutdown");
});

test("a later foreign owner keeps control of its tool results", async () => {
	const h = harness();
	await h.fire("session_start");
	h.setOwner("/extensions/other/subagent.ts");
	const results = await h.fire("tool_result", { toolName: "subagent", details: { isError: true } });
	expect(results.every((result) => result === undefined)).toBe(true);
	await h.fire("session_shutdown");
});

test("reporter children register no delegation tool", async () => {
	const h = harness(undefined, true);
	await h.fire("session_start");
	await h.fire("before_agent_start");
	expect(h.tools).toEqual([]);
	expect(h.notices).toEqual([]);
	await h.fire("session_shutdown");
});
