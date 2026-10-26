import { z } from 'zod'

import type { SandboxMode } from './acp.js'

/** How the TUI answers sandbox-escalation prompts. */
export type ApprovalMode = 'ask' | 'auto-reject'

export const argsSchema = z.object({
  help: z.boolean(),
  version: z.boolean(),
  sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']),
  approval: z.enum(['ask', 'auto-reject']),
  /** Use the stock `dsh acp` profile: no agent questions or plan mode. */
  noBridge: z.boolean(),
  /** `undefined`: fresh session; `''`: pick from a list; otherwise a session id. */
  resume: z.string().optional(),
})
export type Args = z.infer<typeof argsSchema> & { sandbox: SandboxMode; approval: ApprovalMode }

export class ArgsError extends Error {}

export function parseArgs(argv: readonly string[]): Args {
  let help = false
  let version = false
  let sandbox: SandboxMode = 'workspace-write'
  let approval: ApprovalMode = 'ask'
  let noBridge = false
  let resume: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? ''
    if (argument === '-h' || argument === '--help') help = true
    else if (argument === '-v' || argument === '--version') version = true
    else if (argument === '--careful') sandbox = 'read-only'
    else if (argument === '--dangerously-full-access') sandbox = 'danger-full-access'
    else if (argument === '--yolo') approval = 'auto-reject'
    else if (argument === '--no-bridge') noBridge = true
    else if (argument === '--resume' || argument === '-r') {
      const value = argv[index + 1]
      if (value !== undefined && !value.startsWith('-')) {
        resume = value
        index += 1
      } else {
        resume = ''
      }
    } else if (argument.startsWith('--resume=')) resume = argument.slice('--resume='.length)
    else throw new ArgsError(`unknown option: ${argument}`)
  }
  return argsSchema.parse({ help, version, sandbox, approval, noBridge, resume }) as Args
}

export const HELP = `deepcode — terminal UI for DeepSeek Harness

Usage: deepcode [options]
       deepcode mcp <add|add-json|list|get|remove>   Manage MCP servers (deepcode mcp --help)

Options:
  -r, --resume [id]           Resume a session (pick from a list without an id)
      --careful               Read-only sandbox: every write or command asks first
      --yolo                  Never ask: sandbox escalations are rejected automatically
      --dangerously-full-access
                              No sandbox (dsh danger-full-access)
      --no-bridge             Plain \`dsh acp\`: no agent questions or plan mode
  -h, --help                  Show this help
  -v, --version               Show version

In the prompt: /help lists commands, @ mentions files, Shift+Tab cycles
normal → plan mode → auto-reject.

Environment:
  DEEPCODE_DSH                Path to dsh.cmd
`
