import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerOwnership } from "./ownership.ts";

function harness(owner?: string, hasUI = true, reporter = false) {
	const handlers = new Map<string, Function[]>();
	const notices: string[] = [];
	let registrations = 0;
	const pi = {
		on(name: string, handler: Function) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
		getAllTools: () => owner ? [{ name: "subagent", sourceInfo: { path: owner } }] : [],
		getFlag: () => reporter,
	} as unknown as ExtensionAPI;
	registerOwnership(pi, "/package", () => { registrations++; owner = "/package/src/index.ts"; }, () => true);
	return {
		notices, registrations: () => registrations,
		setOwner(value: string) { owner = value; },
		async fire(name: string) {
			for (const handler of handlers.get(name) ?? []) await handler({}, {
				hasUI, ui: { notify: (message: string) => notices.push(message) },
			});
		},
	};
}

test("foreign subagent keeps ownership and gets one notice before the first request", async () => {
	const h = harness("/npm/pi-subagents/index.ts");
	await h.fire("session_start");
	expect(h.registrations()).toBe(0);
	expect(h.notices).toEqual([]);
	await h.fire("before_agent_start");
	await h.fire("before_agent_start");
	expect(h.notices).toHaveLength(1);
	expect(h.notices[0]).toContain("/npm/pi-subagents/index.ts");
	expect(h.notices[0]).toContain("Fleet opens runs in Rex splits");
});

test("an unclaimed tool registers at session_start and stays quiet", async () => {
	const h = harness();
	await h.fire("session_start");
	await h.fire("before_agent_start");
	expect(h.registrations()).toBe(1);
	expect(h.notices).toEqual([]);
});

test("ownership is checked after late startup work with directory boundaries", async () => {
	const h = harness();
	await h.fire("session_start");
	h.setOwner("/package-other/extension.ts");
	await h.fire("before_agent_start");
	expect(h.notices[0]).toContain("/package-other/extension.ts");
	expect(h.notices[0]).toContain("Remove that extension");
});

test.each([[false, false], [true, true]])("headless and reporter sessions stay quiet: UI=%s reporter=%s", async (ui, reporter) => {
	const h = harness("/extensions/subagent/index.ts", ui, reporter);
	await h.fire("session_start");
	await h.fire("before_agent_start");
	expect(h.registrations()).toBe(0);
	expect(h.notices).toEqual([]);
});

test("a new session can show its own notice", async () => {
	const h = harness("/extensions/subagent/index.ts");
	for (let i = 0; i < 2; i++) {
		await h.fire("session_start");
		await h.fire("before_agent_start");
	}
	expect(h.notices).toHaveLength(2);
});
