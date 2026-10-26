import type { PermissionOption } from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'

import { ALWAYS_PREFIX, allowKey, buildChoices, commandName, TOOL_PREFIX } from './permissions.js'

describe('commandName', () => {
  it('takes the program of a shell command', () => {
    expect(commandName('git status')).toBe('git')
    expect(commandName('  npm test -- --watch')).toBe('npm')
    expect(commandName('& "C:\\Program Files\\Git\\bin\\git.exe" log')).toBe('git')
    expect(commandName('./scripts/build.ps1')).toBe('build')
    expect(commandName('Get-ChildItem')).toBe('get-childitem')
  })
})

describe('allowKey', () => {
  it('keys shell tools by program and other tools by name', () => {
    expect(allowKey('pwsh', 'git commit -m x')).toBe('pwsh:git')
    expect(allowKey('pwsh', 'GIT.exe status')).toBe('pwsh:git')
    expect(allowKey('write', 'C:\\x\\notes.txt')).toBe('write')
  })
})

const options: PermissionOption[] = [
  { optionId: 'yes', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'no', name: 'Reject', kind: 'reject_once' },
]

describe('buildChoices', () => {
  it('offers program-wide and tool-wide "always" for shell tools', () => {
    const ids = buildChoices(options, 'pwsh:git', 'pwsh').map((choice) => choice.id)
    expect(ids).toEqual(['yes', `${ALWAYS_PREFIX}yes`, `${TOOL_PREFIX}yes`, 'no', 'reason:no'])
  })

  it('offers one "always" for other tools', () => {
    const ids = buildChoices(options, 'write', 'write').map((choice) => choice.id)
    expect(ids).toEqual(['yes', `${ALWAYS_PREFIX}yes`, 'no', 'reason:no'])
  })

  it("remembers the agent's own allow-always option on the TUI side", () => {
    const withAlways: PermissionOption[] = [
      ...options,
      { optionId: 'all', name: 'Always allow', kind: 'allow_always' },
    ]
    const ids = buildChoices(withAlways, 'write', 'write').map((choice) => choice.id)
    expect(ids).toEqual(['yes', 'no', 'reason:no', `${ALWAYS_PREFIX}all`])
  })
})
