# deepcode

A terminal UI for [DeepSeek Harness](https://www.deepseek.com) in the style of Claude Code. It runs `dsh acp` in the background and talks to it over the [Agent Client Protocol](https://agentclientprotocol.com), so the agent, its tools, sessions and your DeepSeek account all come from the installed DeepSeek Harness app.

```
> Run the tests and fix what fails
● pwsh(pnpm test)
  ⎿ 2 failed (+40 lines)
● edit(src/parser.ts)
    - return value
    + return value ?? fallback
● Both tests pass now.
╭──────────────────────────────────────────────╮
│ >                                            │
╰──────────────────────────────────────────────╯
DeepSeek-V4.1-Flash (high) · 9k/1049k tokens · workspace-write · C:\code\app
```

## Requirements

- Windows (tested on Windows 11 with Windows Terminal)
- Node.js 22.15 or newer
- DeepSeek Harness desktop app, signed in (deepcode uses its `dsh` CLI)

## Install

```sh
pnpm install
pnpm build
npm link        # puts `deepcode` on your PATH
```

If dsh is not in the default location, set `DEEPCODE_DSH` to the full path of `dsh.cmd`.

## Use

```sh
deepcode                  # new session in the current folder
deepcode --resume         # pick a previous session from this folder
deepcode --resume <id>    # resume a specific session
deepcode --careful        # read-only sandbox: every write or command asks first
deepcode --yolo           # never ask: sandbox escalations are rejected automatically
deepcode --dangerously-full-access   # no sandbox at all
```

### Keys

| Key | Action |
| --- | --- |
| Enter | Send |
| `\` + Enter, Alt+Enter | New line |
| ← → , Ctrl+← → | Move by character / word |
| Home / End, Ctrl+A / Ctrl+E | Start / end of line |
| Ctrl+W, Ctrl+U | Delete word / to start of line |
| ↑ ↓ | Prompt history |
| Esc | Interrupt the agent (or clear the input) |
| Shift+Tab | Toggle ask / auto-reject for sandbox escalations |
| Ctrl+C twice | Exit |

### Commands

| Command | Action |
| --- | --- |
| `/model` | Choose the model (saved in `~/.deepcode/config.json`) |
| `/effort` | Choose the reasoning effort (saved) |
| `/resume` | Resume a session from this folder |
| `/clear` | Start a new session |
| `/help` | List commands and keys |
| `/exit` | Quit |

Start a message with `//` to send a literal leading slash.

## Permissions

dsh decides what needs permission through its sandbox, which is fixed when a session is created:

- `workspace-write` (default): the agent can edit and run commands inside the folder; leaving it asks.
- `read-only` (`--careful`): any write or command asks.
- `danger-full-access`: nothing asks.

When dsh asks, deepcode offers: allow once, allow for the rest of the session (per tool, or per command name for shell tools), reject, or reject and tell the agent what to do instead.

## Development

```sh
pnpm test         # vitest + ink-testing-library
pnpm typecheck
pnpm lint         # biome
pnpm build        # esbuild -> dist/cli.js
pnpm smoke        # one real prompt through dsh acp (uses your account)
```

Design decisions and dsh findings are in [docs/PLAN.md](docs/PLAN.md).

## Not yet supported

- Agent questions (`ask_user_question`) and plan mode: dsh's ACP server does not forward them.
- `@` file mentions, image input.

## License

MIT
