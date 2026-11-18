import { expect, test } from "bun:test";
import { formatSubagentRow, launchedEffort, prettyModel, shortTokens } from "./format.ts";

test("model labels drop provider and effort and format Claude versions", () => {
	for (const [id, label] of [
		["claude-code/claude-fable-5-2:high", "Fable 5.2"],
		["claude-haiku-4-5-20251001", "Haiku 4.5"],
		["anthropic/claude-sonnet-4-6", "Sonnet 4.6"],
		["openai-codex/gpt-6.1-sol:low", "gpt-6.1-sol"],
		["claude-code/default", "default"],
		["claude-3-5-sonnet", "claude-3-5-sonnet"],
		["claude-opus-5", "Opus 5"],
		["claude-sonnet-4-20250514", "Sonnet 4"],
	]) expect(prettyModel(id)).toBe(label);
});

test("effort records the launched suffix or inherited dispatch level", () => {
	expect(launchedEffort("claude-code/claude-fable-5-2:high", "low")).toBe("high");
	expect(launchedEffort(undefined, "medium")).toBe("medium");
	expect(launchedEffort(undefined, "off")).toBe("off");
	expect(launchedEffort("claude-code/default", "high")).toBeUndefined();
	expect(launchedEffort("custom/model:version", "high")).toBeUndefined();
	expect(launchedEffort(undefined, undefined)).toBeUndefined();
});

const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

const layout = {
	visibleWidth: (text: string) => Bun.stringWidth(text),
	truncateToWidth(text: string, width: number, ellipsis = "…") {
		if (Bun.stringWidth(text) <= width) return text;
		let fit = "";
		for (const char of text) {
			if (Bun.stringWidth(fit + char + ellipsis) > width) break;
			fit += char;
		}
		return fit + ellipsis;
	},
};

const row = {
	name: "scout", model: "openai-codex/gpt-6.1-terra:low", effort: "low",
	tokens: 42000, contextWindow: 200000, status: "running", label: "Find the entry point",
};

test("subagent rows show context tokens and hide the running state", () => {
	expect(plain(formatSubagentRow(row, 120, layout)))
		.toBe("scout  gpt-6.1-terra · low  42k (21%)  Find the entry point");
});

test("pending rows without a model leave room for the label", () => {
	const pending = {
		...row,
		model: undefined,
		effort: undefined,
		tokens: 0,
		contextWindow: undefined,
		status: "pending",
	};
	expect(plain(formatSubagentRow(pending, 120, layout)))
		.toBe("scout  0  pending  Find the entry point");
	expect(plain(formatSubagentRow(pending, 31, layout)))
		.toBe("scout  0  pending  Find the en…");
});

test("pending rows with a resolved model keep their model and effort", () => {
	expect(plain(formatSubagentRow({ ...row, status: "pending" }, 120, layout)))
		.toBe("scout  gpt-6.1-terra · low  42k (21%)  pending  Find the entry point");
});

test("subagent labels truncate to the remaining terminal columns", () => {
	expect(plain(formatSubagentRow(row, 49, layout)))
		.toBe("scout  gpt-6.1-terra · low  42k (21%)  Find the …");
	expect(plain(formatSubagentRow({ ...row, label: "日本語のラベルを探す" }, 49, layout)))
		.toBe("scout  gpt-6.1-terra · low  42k (21%)  日本語の…");
	expect(plain(formatSubagentRow(row, 40, layout)))
		.toBe("scout  gpt-6.1-terra · low  42k (21%)");
});

test("unknown effort is dim magenta and unresolved context has no percentage", () => {
	const output = formatSubagentRow(
		{ ...row, model: undefined, effort: undefined, contextWindow: undefined }, 120, layout,
	);
	expect(plain(output)).toBe("scout  resolving · effort unset  42k  Find the entry point");
	expect(output).toContain("\x1b[2;35meffort unset\x1b[0m");
});

test("finished rows distinguish done, failed and aborted", () => {
	for (const [status, state] of [
		["completed", "\x1b[2mdone\x1b[0m"],
		["failed", "\x1b[1;31mfailed\x1b[0m"],
		["aborted", "\x1b[1;31maborted\x1b[0m"],
	]) {
		expect(formatSubagentRow({ ...row, status }, 120, layout)).toContain(state);
	}
});

test("tokens use the scripts' rounded short forms", () => {
	for (const [tokens, label] of [
		[0, "0"], [950, "950"], [1000, "1k"], [1499, "1k"],
		[1500, "2k"], [42000, "42k"], [1000000, "1m"], [1250000, "1.3m"],
	] as const) expect(shortTokens(tokens)).toBe(label);
});
