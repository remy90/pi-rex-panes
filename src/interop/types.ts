// Inspector API copied from pi-subagents 0.89.1: src/inspectors/types.d.ts and src/api/inspectors.d.ts.
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

export interface InspectorParams {
	id?: string;
	runId?: string;
	dir?: string;
	index?: number;
	focus?: boolean;
}
export interface InspectorTarget {
	runId: string;
	asyncDir: string;
	index?: number;
	status: { cwd?: string; state: string; steps?: unknown[] };
}
export interface InspectorContext {
	cwd: string;
	signal?: AbortSignal;
	env: NodeJS.ProcessEnv;
	now?: () => Date;
	target: InspectorTarget;
}
export interface InspectorLaunch {
	executable: string;
	argv: string[];
	displayCommand: string;
	mission?: { id: string; path: string };
	allowSteer: boolean;
	allowStop: boolean;
	sessionRoots: string[];
}
// Only the management result fields produced by this plugin are needed here.
export type InspectorResult = AgentToolResult<{ mode: "management"; results: never[] }>;
export interface InspectorPlugin {
	readonly name: string;
	available(context: InspectorContext): Promise<boolean> | boolean;
	owns(context: InspectorContext): boolean;
	open(context: InspectorContext, launch: InspectorLaunch, params: InspectorParams): Promise<InspectorResult>;
	status?(context: InspectorContext): Promise<InspectorResult>;
	close?(context: InspectorContext): Promise<InspectorResult>;
}
export interface InspectorRegistration { dispose(): void }
export interface InspectorRegistrationRequest {
	version: 1;
	plugin: InspectorPlugin;
	result?: { ok: true; registration: InspectorRegistration } | { ok: false; error: Error };
}
export const INSPECTOR_REGISTER_EVENT = "pi-subagents:inspector-register:v1";

// Async event fields consumed from pi-subagents 0.89.1.
export interface AsyncStarted {
	id: string;
	asyncDir: string;
	sessionId: string;
	cwd: string;
	mode: string;
	sessionRoot?: string;
}
export const ASYNC_STARTED_EVENT = "subagent:async-started";
