import type { PermissionOption } from '@agentclientprotocol/sdk'

import type { PermissionChoice } from './ui.js'

/** Choice-id prefix for the TUI-side "don't ask again this session" answer. */
export const ALWAYS_PREFIX = 'always:'
/** Choice-id prefix for "reject, then tell the agent why". */
export const REASON_PREFIX = 'reason:'

const SHELL_TOOL = /^(pwsh|powershell|bash|sh|shell|cmd|terminal|exec)/i

/**
 * What "always allow" remembers: the tool name, plus the first word of the
 * command for shell tools (`pwsh:npm`, `pwsh:git`).
 */
export function allowKey(title: string, detail: string): string {
  if (SHELL_TOOL.test(title)) {
    const word = detail.trim().split(/\s+/)[0] ?? ''
    return word === '' ? title : `${title}:${word}`
  }
  return title
}

/**
 * Agent options plus TUI-side extras: a session-wide "always" choice after
 * allow-once and a "tell the agent why" choice after reject-once.
 */
export function buildChoices(options: PermissionOption[], key: string): PermissionChoice[] {
  const choices: PermissionChoice[] = []
  for (const option of options) {
    choices.push({ id: option.optionId, label: option.name })
    if (option.kind === 'allow_once') {
      choices.push({
        id: `${ALWAYS_PREFIX}${option.optionId}`,
        label: `Allow, and don't ask again for ${key} this session`,
      })
    } else if (option.kind === 'reject_once') {
      choices.push({
        id: `${REASON_PREFIX}${option.optionId}`,
        label: 'Reject, and tell the agent what to do instead',
      })
    }
  }
  return choices
}
