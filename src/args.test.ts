import { describe, expect, it } from 'vitest'

import { ArgsError, parseArgs } from './args.js'
import { parseInput } from './commands.js'

describe('parseArgs', () => {
  it('defaults to a fresh workspace-write session that asks', () => {
    expect(parseArgs([])).toEqual({
      help: false,
      version: false,
      sandbox: 'workspace-write',
      approval: 'ask',
      noBridge: false,
      resume: undefined,
    })
  })

  it('maps mode flags', () => {
    expect(parseArgs(['--careful']).sandbox).toBe('read-only')
    expect(parseArgs(['--dangerously-full-access']).sandbox).toBe('danger-full-access')
    expect(parseArgs(['--yolo']).approval).toBe('auto-reject')
  })

  it('takes an optional resume id', () => {
    expect(parseArgs(['--resume', 'abc']).resume).toBe('abc')
    expect(parseArgs(['-r']).resume).toBe('')
    expect(parseArgs(['--resume', '--yolo'])).toMatchObject({ resume: '', approval: 'auto-reject' })
    expect(parseArgs(['--resume=xyz']).resume).toBe('xyz')
  })

  it('rejects unknown options', () => {
    expect(() => parseArgs(['--nope'])).toThrow(ArgsError)
  })
})

describe('parseInput', () => {
  it('separates prompts, commands and unknown commands', () => {
    expect(parseInput('hello')).toEqual({ kind: 'prompt', text: 'hello' })
    expect(parseInput('/Model')).toEqual({ kind: 'command', name: 'model', args: '' })
    expect(parseInput('/nope now')).toEqual({ kind: 'unknown', name: 'nope' })
    expect(parseInput('//etc is a path')).toEqual({ kind: 'prompt', text: '/etc is a path' })
  })
})
