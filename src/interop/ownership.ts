import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { REPORT_FLAG } from "../reporter.ts";

function canonical(path: string): string {
	try { return realpathSync(path); } catch { return resolve(path); }
}

export function foreignSubagentOwner(pi: Pick<ExtensionAPI, "getAllTools">, packageRoot: string): string | undefined {
	const owner = pi.getAllTools().find((tool) => tool.name === "subagent")?.sourceInfo.path;
	if (!owner) return undefined;
	const location = relative(canonical(packageRoot), canonical(owner));
	return location === ".." || location.startsWith(`..${sep}`) || isAbsolute(location) ? owner : undefined;
}

export function registerOwnership(
	pi: ExtensionAPI,
	packageRoot: string,
	register: () => void,
	fleetAvailable: () => boolean,
): void {
	let registered = false;
	let checked = false;
	pi.on("session_start", () => {
		checked = false;
		if (pi.getFlag(REPORT_FLAG) || registered || foreignSubagentOwner(pi, packageRoot)) return;
		register();
		registered = true;
	});
	pi.on("before_agent_start", (_event, ctx) => {
		if (checked || pi.getFlag(REPORT_FLAG)) return;
		checked = true;
		const owner = foreignSubagentOwner(pi, packageRoot);
		if (!owner || !ctx.hasUI) return;
		const guidance = owner.split(/[\\/]/).includes("pi-subagents")
			? fleetAvailable() ? "Fleet opens runs in Rex splits." : "The Rex Fleet inspector is unavailable."
			: "Remove that extension to use pi-rex-panes' subagent.";
		ctx.ui.notify(`pi-rex-panes is standing down: ${owner} owns subagent. ${guidance}`, "info");
	});
}
