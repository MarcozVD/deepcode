# deepcode — plan

Terminal UI (like Claude Code) for DeepSeek Harness, built as a custom dsh bundle. Planning done 2026-10-25.

## Goals and scope

| # | Decision |
|---|---|
| Q1 | Personal first, publishable later. Own code in this repo; `@deepseek-ai/*` packages (MIT) used as dependencies, never copied. |
| Q2 | v1: streaming chat, tool calls/results, approvals, agent questions, resume. v2: colored diffs, slash commands (`/model`, `/clear`, `/resume`), model picker. v3: plan mode, `@` file mentions. |
| Q7 | UI strings in English; agent answers in whatever language the user writes. |
| Q12 | Windows Terminal first. Cross-platform code, tested only on Windows in v1. |

## UX

| # | Decision |
|---|---|
| Q6 | `deepcode` command (wraps `dsh tui`); `dsh tui` also works. |
| Q8 | Claude Code layout: inline scrollback output, fixed input at bottom, status bar (model, tokens, cwd). No fullscreen panels. |
| Q9 | Default approvals: reads/searches auto-approved; edits, shell, network ask. `--yolo` approves all. Prompt options: yes / yes always this session / no + reason. |
| Q10 | Claude Code keys: Enter send, Shift+Enter or `\`+Enter newline, Esc interrupt, Ctrl+C twice exit, ↑ history. Shift+Tab mode cycle from v2. |

## Architecture (revised 2026-10-25: ACP client)

The first design (Ink running inside dsh as a bundle) failed live: on Windows dsh runs as `DeepSeek Harness.exe` with `ELECTRON_RUN_AS_NODE=1`, where `process.stdin.isTTY` is undefined, so Ink cannot enter raw mode (`\\.\CONIN$` opened but delivered no keys). New design:

- `deepcode` is a plain Node CLI (system Node >= 22) that owns the terminal and renders with Ink.
- It spawns `dsh acp` (Agent Client Protocol over stdio, JSON-RPC lines) and speaks ACP with the official SDK `@agentclientprotocol/sdk` (Q25).
- Verified against `dsh acp`: `initialize`, `session/new` (returns `configOptions`: model + reasoning_effort), `session/set_config_option`, `session/prompt` → `session/update` notifications (`agent_message_chunk`, `tool_call`, `tool_call_update` with rawInput/content/status, `usage_update`), `stopReason`, `session/request_permission` (options allow-once / reject-once). Capabilities: session list / resume / close.
- Spawn on Windows: `cmd.exe /d /s /c ""<dsh.cmd>" acp"` with `windowsVerbatimArguments: true`. dsh.cmd path: `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd` (overridable with `DEEPCODE_DSH`).
- dsh stdout belongs to ACP; dsh may print non-JSON log lines (e.g. `[llm-deepseek-account] ...`): ignore/route them to a debug log, never crash.

| # | Decision |
|---|---|
| Q13 | Superseded: `dsh-acp` is used as the server, not copied. |
| Q14 | Superseded: no dsh bundle in v1. `deepcode` installs as a normal npm bin (`pnpm link --global` for dev). The `~/.dsh/profiles/tui` profile from the first attempt is unused. |
| Q15 | esbuild single ESM file `dist/cli.js` (bin `deepcode`), platform node, target node22, all deps bundled, `define process.env.NODE_ENV="production"`. |
| Q16 | Record tested dsh version (`0.2.1-rc.2`); warn if `initialize` reports something unexpected. No `engines.dsh`. |
| Q17 | dsh-acp already uses Desktop credentials/account. |
| Q18 | "Always this session" = TUI-side allowlist (tool name + first shell word) answering `session/request_permission` automatically. "No + reason" = reject, then send the reason as the next prompt text. |
| Q19/Q23 | Agent questions (`ask_user_question`) not available over ACP: dropped from v1, revisit in v3 with plan mode. |
| Q20 | `/resume` and `--resume [id]` use ACP session list/resume, filtered to current cwd. ACP gives no titles and resume does not replay, so titles, dates and the last 30 history items are read from dsh's own log (`~/.dsh/sessions/<cwd>/<id>/session.v4.jsonl.zstd`, concatenated zstd frames, Node >= 22.15 `zlib.zstdDecompressSync`). |
| Q21/Q22 | Verified: dsh-acp does not execute slash commands (`/permission` reaches the model as text), and the sandbox mode is pinned per session at creation from `DSH_PERMISSION_MODE` (a resumed session keeps its mode). So: sandbox chosen at launch — default `workspace-write`, `--careful` = `read-only` (writes/commands escalate and ask), `--dangerously-full-access` = `danger-full-access`. Shift+Tab toggles the TUI's approval mode live: ask ↔ auto-reject (escalations rejected without asking = Q21 yolo); `--yolo` starts in auto-reject. |
| Q24 | Model: last choice saved in `~/.deepcode/config.json` (zod-validated); first run `["deepseek-account","deepseek-flash"]` (ACP default `deepseek-official` needs `DEEPSEEK_API_KEY`). Applied with `session/set_config_option` after `session/new`. |

## dsh internals (reference only, for later bundle work)

- Bundle manifest: `"dsh": {"bundle": {"patch": "./cordis.patch.yml"}}` in `package.json`; ESM plugin exports `name`, `inject`, `Config`, `apply(ctx, config)`.
- Profile `package.json`: `"dsh": {"profile": {"bundles": ["@deepseek-ai/dsh-base", "<this package>"]}}`.
- Streaming: `ctx.on("agent/assistant-stream", ({agent, frame}) => …)` (`text-delta`, `reasoning-delta`, `tool-call-delta`, `usage`, `finish`).
- Persisted events: `ctx.on("session/event", (session, event) => …)` (`tool/call`, `tool/result`, `turn/end`, `approval/*`, …).
- Agent: `followup`, `steer`, `cancel({kind:"user"})`, `whenIdle`.
- Approvals: waterfall `approval/request` → `"allowed-once" | "rejected" | "cancelled" | "unavailable"`. Without a handler everything is refused.
- Questions: waterfall `user-questions/request` → `{answers:[{id, selected, custom?}]}`.
- Exit via `ctx.appExit(code)`. Raw-mode Ctrl+C arrives as `\x03`.
- Reference code (extracted app): `dsh-acp/lib/index.js`, `dsh-headless/lib`, `dsh-plan-mode/lib/index.js`, `dsh-tool-cordis/lib/types/api-catalog.js`.

## Stack

TypeScript, pnpm, esbuild, Node >= 22 (system), `@agentclientprotocol/sdk`, React + Ink, Zod (cmdline/config validation), Vitest + ink-testing-library, Biome, Lefthook (pre-commit: biome, `tsc --noEmit`, vitest), GitHub Actions on `windows-latest`. See `STACK.md`.

## Testing (Q11)

Vitest + ink-testing-library for components and logic (allowlist matcher, event reducer). One manual E2E against a real dsh session (costs tokens, not in CI).
