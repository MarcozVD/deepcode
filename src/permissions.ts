import type { PermissionOption } from '@agentclientprotocol/sdk'

import type { PermissionChoice } from './ui.js'

/** Choice-id prefix for the TUI-side "don't ask again this session" answer. */
export const ALWAYS_PREFIX = 'always:'
/** Choice-id prefix for "don't ask again for this tool at all this session". */
export const TOOL_PREFIX = 'tool:'
/** Choice-id prefix for "reject, then tell the agent why". */
export const REASON_PREFIX = 'reason:'

const SHELL_TOOL = /^(pwsh|powershell|bash|sh|shell|cmd|terminal|exec)/i

export function isShellTool(title: string): boolean {
  return SHELL_TOOL.test(title)
}

/**
 * The program a shell command runs: first word, without PowerShell's call
 * operator, quotes, directories or a Windows extension (`& "C:\x\git.exe"` → `git`).
 */
export function commandName(command: string): string {
  const word = /^\s*(?:&\s*)?(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(command)
  const raw = word?.[1] ?? word?.[2] ?? word?.[3] ?? ''
  const base = raw.split(/[\\/]/).pop() ?? ''
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase()
}

/**
 * What "always allow" remembers: the tool name, plus the program for shell
 * tools (`pwsh:npm`, `pwsh:git`).
 */
export function allowKey(title: string, detail: string): string {
  if (isShellTool(title)) {
    const name = commandName(detail)
    return name === '' ? title : `${title}:${name}`
  }
  return title
}

/**
 * Agent options plus TUI-side extras: session-wide "always" choices after
 * allow-once and a "tell the agent why" choice after reject-once. An agent
 * allow-always option is answered the same way, since dsh-acp does not keep it.
 */
export function buildChoices(
  options: PermissionOption[],
  key: string,
  title: string,
): PermissionChoice[] {
  const choices: PermissionChoice[] = []
  for (const option of options) {
    if (option.kind === 'allow_always') {
      choices.push({ id: `${ALWAYS_PREFIX}${option.optionId}`, label: option.name })
      continue
    }
    choices.push({ id: option.optionId, label: option.name })
    if (option.kind === 'allow_once') {
      if (!options.some((other) => other.kind === 'allow_always')) {
        choices.push({
          id: `${ALWAYS_PREFIX}${option.optionId}`,
          label: `Allow, and don't ask again for ${key} this session`,
        })
      }
      if (key !== title) {
        choices.push({
          id: `${TOOL_PREFIX}${option.optionId}`,
          label: `Allow, and don't ask again for any ${title} command this session`,
        })
      }
    } else if (option.kind === 'reject_once') {
      choices.push({
        id: `${REASON_PREFIX}${option.optionId}`,
        label: 'Reject, and tell the agent what to do instead',
      })
    }
  }
  return choices
}
