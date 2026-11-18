import { spawn } from "node:child_process";

export interface CommandResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

export type Runner = (binary: string, args: string[], options?: { signal?: AbortSignal }) => Promise<CommandResult>;

export class UncertainPaneLaunch extends Error {
	readonly mayHaveStarted = true;
}

export interface PaneOptions {
	anchor: string;
	direction: "right" | "below";
	ratio: number;
	label: string;
	cwd: string;
	argv: string[];
}

export function createRexClient(binary: string, session: string, runner: Runner = runCommand) {
	const run = (args: string[], options?: { signal?: AbortSignal }) =>
		runner(binary, ["--autostart=false", "--timeout", "3s", ...args], options);
	return {
		async listPaneIds(): Promise<Set<string>> {
			const result = await run(["block", "ls", "-s", session, "-q", "--short=false"]);
			if (result.code !== 0) throw new Error(result.stderr || "Rex block listing failed");
			return new Set(result.stdout.split(/\s+/).filter(Boolean));
		},
		closePane(blockId: string) {
			return run(["block", "close", blockId, "-s", session]);
		},
		waitPane(blockId: string, options?: { signal?: AbortSignal }) {
			return run(["wait", blockId, "-s", session, "--json"], options);
		},
		async openPane(options: PaneOptions): Promise<string> {
			const result = await run([
				"split", "-s", session, "-b", options.anchor, `--split=${options.direction}`,
				"--ratio", String(options.ratio), "--focus=false", "--label", options.label,
				"-c", options.cwd, "--shell=none", "--keep-open", "--json", "--", ...options.argv,
			]);
			if (result.code !== 0) {
				const message = result.stderr || "Rex split failed";
				if (result.code === null || /timed?\s*out|timeout/i.test(message)) throw new UncertainPaneLaunch(message);
				throw new Error(message);
			}
			try {
				const data = JSON.parse(result.stdout);
				const id: unknown = data.block_ids?.[0];
				if (typeof id === "string" && id) return id;
			} catch { /* A successful split may already have launched the child. */ }
			throw new UncertainPaneLaunch("Rex split returned no usable block ID");
		},
	};
}

export const runCommand: Runner = (binary, args, options) => new Promise((resolve, reject) => {
	const proc = spawn(binary, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	let killTimer: ReturnType<typeof setTimeout> | undefined;
	const abort = () => {
		proc.kill("SIGTERM");
		killTimer = setTimeout(() => proc.kill("SIGKILL"), 500);
	};
	const cleanup = () => {
		options?.signal?.removeEventListener("abort", abort);
		if (killTimer) clearTimeout(killTimer);
	};
	proc.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
	proc.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
	proc.on("error", (error) => { cleanup(); reject(error); });
	proc.on("close", (code) => { cleanup(); resolve({ code, stdout, stderr }); });
	if (options?.signal?.aborted) abort();
	else options?.signal?.addEventListener("abort", abort, { once: true });
});

export type RexClient = ReturnType<typeof createRexClient>;
