import { REPORT_FLAG } from "./reporter.ts";

export function buildChildArgs(options: {
	model?: string;
	thinking?: string;
	tools?: string[];
	promptFile?: string;
	task: string;
	pane?: { extensionPath: string; reportFile: string };
}): string[] {
	const args = options.pane ? ["--no-session"] : ["--mode", "json", "-p", "--no-session"];
	if (options.model) args.push("--model", options.model);
	if (options.thinking) args.push("--thinking", options.thinking);
	if (options.tools?.length) args.push("--tools", options.tools.join(","));
	if (options.promptFile) args.push("--append-system-prompt", options.promptFile);
	if (options.pane) args.push("-e", options.pane.extensionPath, `--${REPORT_FLAG}`, options.pane.reportFile);
	args.push(`Task: ${options.task}`);
	return args;
}
