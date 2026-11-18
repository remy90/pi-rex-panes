# pi-rex-panes

A Pi package that adds the `subagent` tool. Run a single agent, parallel tasks, or a chain with isolated child contexts.

Inside Rex, each child runs a full interactive Pi in a split beside the parent. The first child opens to the right at 40%. Concurrent children stack below the most recent open child, and keyboard focus stays with the parent. Outside Rex, children use Pi's headless JSON mode.

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

Set `PI_REX_PANES_KEEP=1` to keep every finished pane open. Task abort closes retained panes too. Rex launches use `--shell=none --keep-open` so process failures remain visible until you close the pane. Retained panes remain anchors for later children.

Children use `--no-session` and write results to a private temporary report file. The parent removes that file after the task finishes. Reporter handlers load once per child session, even when the package is also installed globally.

## Environment

| Variable | Effect |
| --- | --- |
| `PI_REX_PANES=0` | Force headless children. |
| `PI_REX_PANES_KEEP=1` | Keep completed and failed panes open. |
| `REX_SESSION`, `REX_BLOCK` | Rex supplies the parent session and block. Both are required for panes. |
| `REX_BIN_DIR` | Directory to search for `rex` before checking `PATH`. |

Rex starts pane children directly with `--shell=none`, without running shell startup files. Configure provider credentials in Pi or in the environment available to Rex.

Missing Rex context or a missing executable selects headless mode. A split rejected before the child starts also falls back to headless. An ambiguous split response returns a failed result because the task may already be running in Rex. Without a block ID, cleanup cannot close that pane, including after abort; close it manually.

If `rex wait` returns before the final report, the parent drains the report file and returns a failed result. A Rex connection error can trigger this while the child is running; its pane stays open for inspection.

## Development

```sh
bun install
bun test
bunx tsc --noEmit
bun pm pack --dry-run
```

## Credits

The Pi subagent example provides the tool's foundation. Pane routing and child reporting borrow ideas from `pi-subagents` and `pi-rex-subagents`, both MIT-licensed.

## Source

Ported from `agent-config` branch `build/pi-statusline`, commit `b75cd32a1ad417dff34cb0929295b25b636ca5fa`. Its `UPSTREAM` records a copy from pi-coding-agent 1.5.1 `examples/extensions/subagent` on 2026-11-13. The package includes the shared subagent formatter from that branch. See [LICENSE](LICENSE).
