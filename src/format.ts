export function shortTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}m`;
	if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
	return String(tokens);
}

type Color = "blue" | "green" | "magenta" | "cyan" | "yellow" | "red" | "dim" | "dimMagenta";
export type StatusStyle = (color: Color, text: string) => string;
const codes = {
	blue: "1;34",
	green: "1;32",
	magenta: "1;35",
	cyan: "1;36",
	yellow: "1;33",
	red: "1;31",
	dim: "2",
	dimMagenta: "2;35",
};
export const ansiStyle: StatusStyle = (color, text) => `\x1b[${codes[color]}m${text}\x1b[0m`;

const THINKING_SUFFIX = /:(off|minimal|low|medium|high|xhigh|max)$/;

export function parseModelSpec(spec: string): { provider?: string; id: string; effort?: string } {
	const effort = spec.match(THINKING_SUFFIX)?.[1];
	const bare = spec.replace(THINKING_SUFFIX, "");
	const slash = bare.indexOf("/");
	return {
		provider: slash < 0 ? undefined : bare.slice(0, slash),
		id: slash < 0 ? bare : bare.slice(slash + 1),
		effort,
	};
}

export function launchedEffort(agentModel?: string, dispatchLevel?: string): string | undefined {
	return agentModel ? parseModelSpec(agentModel).effort : dispatchLevel;
}

export interface SubagentRow {
	name: string;
	model?: string;
	effort?: string;
	tokens: number;
	contextWindow?: number;
	status: string;
	label: string;
}

interface TerminalLayout {
	visibleWidth(text: string): number;
	truncateToWidth(text: string, width: number, ellipsis?: string): string;
}

export function formatSubagentRow(
	row: SubagentRow,
	width: number,
	layout: TerminalLayout,
	style: StatusStyle = ansiStyle,
): string {
	const showModel = row.status !== "pending" || !!row.model;
	const model = row.model ? prettyModel(row.model) : "resolving";
	const effort = row.effort ?? "effort unset";
	const context = row.contextWindow && row.contextWindow > 0
		? ` (${Math.round(row.tokens * 100 / row.contextWindow)}%)`
		: "";
	const tokens = shortTokens(row.tokens) + context;
	const state = row.status === "running" ? "" : row.status === "completed" ? "done" : row.status;
	const modelSegment = showModel ? `${model} · ${effort}` : "";
	const fixed = [row.name, modelSegment, tokens, state].filter(Boolean).join("  ");
	const room = width - layout.visibleWidth(fixed) - 2;
	const label = row.label.replace(/\s+/g, " ").trim();
	const parts = [style("blue", row.name)];
	if (showModel) {
		parts.push(style("magenta", `${model} · `) + style(row.effort == null ? "dimMagenta" : "magenta", effort));
	}
	parts.push(style("cyan", tokens));
	if (state) parts.push(style(state === "done" || state === "pending" ? "dim" : "red", state));
	if (room >= 8 && label) parts.push(style("dim", layout.truncateToWidth(label, room, "…")));
	return parts.join("  ");
}

export function prettyModel(spec: string): string {
	const { id } = parseModelSpec(spec);
	const match = id.replace(/-\d{8}$/, "").match(/^claude-([a-z]+)-((?:\d+-)*\d+)$/);
	return match ? `${match[1][0].toUpperCase()}${match[1].slice(1)} ${match[2].replaceAll("-", ".")}` : id;
}
