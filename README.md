# pi-rex-panes

A Pi package that adds the `subagent` tool. Run a single agent, parallel tasks, or a chain with isolated child contexts.

Rex gives each child a full interactive Pi in a split beside the parent. The first child opens to the right at 40%. Concurrent children stack below the most recent open child, and keyboard focus stays with the parent.

The tool selects headless JSON mode when Rex context is unavailable.

<!-- ![pi-rex-panes demo](docs/demo.gif) -->

## Requirements

- Pi 1.5 or later, with a configured model provider.
- Rex for interactive panes. Its `rex` executable must be in `$REX_BIN_DIR` or on `PATH`.
- Bun for development from a checkout.

## Install

```sh
pi install npm:pi-rex-panes
```

Install directly into your current Pi setup. Any extension already providing `subagent` keeps control, and pi-rex-panes tells you which one. To use this package's `subagent`, remove the extension named in that notice.

For a local checkout:

```sh
bun install
pi --no-extensions -e .
```

## With pi-subagents

When another extension owns `subagent`, pi-rex-panes stands down. At the first prompt in an interactive session, it shows one notice naming the owner's path.

Inside Rex, pi-rex-panes registers the `rex-panes` inspector with pi-subagents. Fleet (`/subagents-fleet`) opens a selected run in a split beside the parent when it chooses this inspector. The pane runs the dashboard command supplied by pi-subagents, which provides the live UI and controls the run. Closing that pane leaves the run going. Parent session shutdown closes inspector panes.

Tested with pi-subagents 0.89.1. The agent configuration and pane lifetime below apply when pi-rex-panes owns `subagent`.

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

Successful children write their final report and stay open for 180 seconds by default. The parent schedules cleanup in the background so tool results return straight away. At the deadline, an unfocused pane closes. If it is focused in Rex's active window, the parent checks every 5 seconds and closes it after 30 seconds continuously unfocused. A failed focus read counts as unfocused under the same rules.

Set `rexPanes.lingerSeconds` in Pi's `settings.json` to change the delay:

```json
{
  "rexPanes": {
    "lingerSeconds": 60
  }
}
```

A non-empty `PI_REX_PANES_LINGER_SECONDS` overrides that setting. When the environment variable is unset or blank, the parent reads `rexPanes.lingerSeconds`, then uses 180 seconds if absent. Values must be whole numbers from `0` to `2147483`. An invalid value uses 180 seconds, including an invalid environment override when a valid setting exists. Set `0` to close straight away, including while focused. `PI_REX_PANES_KEEP=1` keeps finished panes open until the parent exits.

Failed panes stay open for inspection, including panes whose child crashes during startup. Aborting a task closes its pane, including with `PI_REX_PANES_KEEP=1`. Parent session shutdown aborts active pane tasks and closes lingering panes, with up to five seconds for cleanup.

Each child checks every 2 seconds whether its parent process still exists, including after a forced parent exit. When the parent is gone, a child that settled successfully tries to close its own pane. The watchdog shuts down the child even if Rex cannot close it. Failed or unfinished runs, including aborted runs, leave their final screen visible through `--keep-open`. A failed close can also leave a completed pane on screen.

Rex launches use `--shell=none --keep-open` to leave process failures visible until you close the pane. An open pane remains an anchor for later children. After a failed close, the parent retries once and includes the block ID in a warning if task abort cleanup still fails. Linger cleanup runs silently, with another attempt during session shutdown.

Children report `agent_start` when a run begins. If no start record arrives within 60 seconds, the parent returns a failed result and leaves the pane open. This covers startup errors shown only in the child UI and a reporter that fails to load. Runs have no timeout after starting. A timed-out child can still run in its pane; inspect it before retrying the task.

Children use `--no-session` and write results to a private temporary report file. The parent removes that file after the task finishes. Reporter handlers load once per child session, even when the package is also installed globally.

## Environment

| Variable | Effect |
| --- | --- |
| `PI_REX_PANES=0` | Force headless children. |
| `PI_REX_PANES_KEEP=1` | Keep finished child panes open until the parent exits, overriding linger. Task abort still closes its pane. |
| `PI_REX_PANES_LINGER_SECONDS` | Seconds successful child panes linger. Default: `180`. Overrides `rexPanes.lingerSeconds` when non-empty. Accepts whole numbers from `0` to `2147483`; invalid values use the default. `0` closes straight away. |
| `PI_REX_PANES_START_TIMEOUT_MS` | Milliseconds to wait for `agent_start`. Default: `60000`. Accepts whole numbers from `1` to `2147483647`; invalid values use the default. |
| `REX_SESSION`, `REX_BLOCK` | Rex supplies the parent session and block. Both are required for panes. |
| `REX_BIN_DIR` | Directory to search for `rex` before checking `PATH`. |

Rex starts pane children directly with `--shell=none`, without running shell startup files. Configure provider credentials in Pi or in the environment available to Rex.

The pane child argv follows this shape. Optional arguments appear in brackets:

```text
/usr/bin/env PI_REX_PANES_PARENT_PID=<parent-pid> pi --no-session [--model m] [--thinking t] [--tools read,bash] [--append-system-prompt <file>] -e <package>/src/index.ts --rex-panes-report <file> "Task: <task>"
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

The Pi subagent example provides the tool's foundation. Running each child as a live interactive Pi in Rex follows the idea behind `pi-subagents` (MIT).

## Source

Ported from `agent-config` branch `build/pi-statusline`, commit `b75cd32a1ad417dff34cb0929295b25b636ca5fa`. Its `UPSTREAM` records a copy from pi-coding-agent 1.5.1 `examples/extensions/subagent` on 2026-11-13. The package includes the shared subagent formatter from that branch. See [LICENSE](LICENSE).
