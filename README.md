# pi-rex-panes

A Pi package that adds the `subagent` tool. Run a single agent, parallel tasks, or a chain with isolated child contexts.

Rex gives each child a full interactive Pi in a split beside the parent. The first child opens to the right at 40%. Concurrent children stack below the most recent open child, and keyboard focus stays with the parent.

The tool selects headless JSON mode when Rex context is unavailable.

## Requirements

- Pi 1.5 or later, with a configured model provider.
- Rex for interactive panes. Its `rex` executable must be in `$REX_BIN_DIR` or on `PATH`.
- Bun for development from a checkout.

## Install

```sh
pi install npm:pi-rex-panes
```

This package and `~/.pi/agent/extensions/subagent/` must never load together. Disable or remove that directory before loading the package. Disable any other extension that registers `subagent`, including other subagent packages.

For a local checkout:

```sh
bun install
pi --no-extensions -e .
```

## Agents

User agents live in `~/.pi/agent/agents/*.md`. Project agents live in `.pi/agents/*.md` and require `agentScope: "project"` or `"both"`; interactive runs ask for confirmation by default.

```md
---
name: scout
description: Find files and entry points
tools: read, bash
model: openai-codex/gpt-6.1-terra:high
---
Inspect the code and report the relevant paths.
```

The body is appended to the child's system prompt. Model settings accept `provider/id:thinking`. The tool accepts `agent` and `task`, `tasks` for parallel work, or `chain` with `{previous}` placeholders. Set `cwd` on the call or each task to choose its working directory.

## Pane lifetime

Successful children write their final report and request Pi shutdown. The parent closes their panes. Failures stay open for inspection, including panes whose child crashes during startup. Aborting a task closes its pane. Parent session shutdown also aborts active pane tasks and waits up to five seconds for cleanup.

Set `PI_REX_PANES_KEEP=1` to keep every finished pane open. Task abort closes retained panes too. Rex launches use `--shell=none --keep-open` so process failures remain visible until you close the pane. Retained panes remain anchors for later children. When both close attempts fail, the result warns that the pane may still be open and includes its block ID for manual cleanup.

Children report `agent_start` when a run begins. If no start record arrives within 60 seconds, the parent returns a failed result and leaves the pane open. This covers startup errors shown only in the child UI and a reporter that fails to load. Runs have no timeout after starting. A timed-out child can still run in its pane; inspect it before retrying the task.

Children use `--no-session` and write results to a private temporary report file. The parent removes that file after the task finishes. Reporter handlers load once per child session, even when the package is also installed globally.

## Environment

| Variable | Effect |
| --- | --- |
| `PI_REX_PANES=0` | Force headless children. |
| `PI_REX_PANES_KEEP=1` | Keep completed and failed panes open. |
| `PI_REX_PANES_START_TIMEOUT_MS` | Milliseconds to wait for `agent_start`. Default: `60000`. Accepts whole numbers from `1` to `2147483647`; invalid values use the default. |
| `REX_SESSION`, `REX_BLOCK` | Rex supplies the parent session and block. Both are required for panes. |
| `REX_BIN_DIR` | Directory to search for `rex` before checking `PATH`. |

Rex starts pane children directly with `--shell=none`, without running shell startup files. Configure provider credentials in Pi or in the environment available to Rex.

The pane child argv follows this shape. Optional arguments appear in brackets:

```text
/usr/bin/env PI_REX_PANES_KEEP=0|1 pi --no-session [--model m] [--thinking t] [--tools read,bash] [--append-system-prompt <file>] -e <package>/src/index.ts --rex-panes-report <file> "Task: <task>"
```

When the parent uses a runtime and CLI script, the child reuses that invocation in place of `pi`. Each path and the complete task remain separate argv entries.

Missing Rex context or a missing executable selects headless mode. A split rejected before the child starts also falls back to headless. An ambiguous split response returns a failed result because the task may already be running in Rex. Without a block ID, cleanup cannot close that pane, including after abort; close it manually.

The parent drains the report file after a confirmed child exit or pane removal. An exit before the final report returns a failed result and leaves any remaining pane open for inspection. Rex connection failures trigger up to three wait attempts with a short backoff and process-state checks. After those attempts, the parent checks process state once a second. Exit confirmation and the final report end monitoring. Task abort cancels it. A failed state check also checks the pane listing for removal. Report polling continues throughout an outage; a started run stays active while Rex is unreachable.

## Development

```sh
bun install
bun test
bun run typecheck
bun pm pack --dry-run
```

## Credits

The Pi subagent example provides the tool's foundation. Pane routing and child reporting borrow ideas from `pi-subagents` and `pi-rex-subagents`, both MIT-licensed.

## Source

Ported from `agent-config` branch `build/pi-statusline`, commit `b75cd32a1ad417dff34cb0929295b25b636ca5fa`. Its `UPSTREAM` records a copy from pi-coding-agent 1.5.1 `examples/extensions/subagent` on 2026-11-13. The package includes the shared subagent formatter from that branch. See [LICENSE](LICENSE).
