import { describe, expect, it } from 'vitest'

import {
  assertDshExists,
  currentOptionName,
  DshNotFoundError,
  dshCommand,
  hasOptionValue,
  jsonLinesOnly,
  TESTED_DSH_VERSION,
  versionWarning,
} from './acp.js'
import { DEFAULT_MODEL, parseConfig } from './config.js'

describe('parseConfig', () => {
  it('falls back to the default model', () => {
    expect(parseConfig(undefined).model).toBe(DEFAULT_MODEL)
    expect(parseConfig('not json').model).toBe(DEFAULT_MODEL)
    expect(parseConfig('{"model": 3}').model).toBe(DEFAULT_MODEL)
  })

  it('keeps a saved model', () => {
    expect(parseConfig('{"model":"[\\"a\\",\\"b\\"]"}').model).toBe('["a","b"]')
  })
})

describe('dshCommand', () => {
  it('wraps the .cmd in cmd.exe on Windows', () => {
    expect(dshCommand('C:\\x y\\dsh.cmd', 'win32')).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', '""C:\\x y\\dsh.cmd" acp"'],
      verbatim: true,
    })
    expect(dshCommand('/usr/bin/dsh', 'linux').args).toEqual(['acp'])
  })
})

describe('dsh checks', () => {
  it('reports a missing dsh with the path and the override', () => {
    expect(() => assertDshExists('C:/nope/dsh.cmd')).toThrow(DshNotFoundError)
    expect(() => assertDshExists('C:/nope/dsh.cmd')).toThrow(/DEEPCODE_DSH/)
  })

  it('warns only for untested versions', () => {
    expect(versionWarning(TESTED_DSH_VERSION)).toBeUndefined()
    expect(versionWarning(undefined)).toBeUndefined()
    expect(versionWarning('0.3.0')).toContain('0.3.0')
  })

  it('builds a --version command line', () => {
    expect(dshCommand('C:\\dsh.cmd', 'win32', '--version').args.at(-1)).toBe(
      '""C:\\dsh.cmd" --version"',
    )
  })
})

describe('jsonLinesOnly', () => {
  it('passes JSON lines and diverts log lines, across chunk boundaries', async () => {
    const other: string[] = []
    const encoder = new TextEncoder()
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('[llm] loaded 2 models\n{"jsonrpc":'))
        controller.enqueue(encoder.encode('"2.0","id":1}\n\n'))
        controller.close()
      },
    })
    const text = await new Response(
      source.pipeThrough(jsonLinesOnly((line) => other.push(line))),
    ).text()
    expect(text).toBe('{"jsonrpc":"2.0","id":1}\n')
    expect(other).toEqual(['[llm] loaded 2 models'])
  })
})

describe('config options', () => {
  const options = [
    {
      id: 'model',
      name: 'Model',
      type: 'select' as const,
      currentValue: '["deepseek-account","deepseek-flash"]',
      options: [
        {
          group: 'deepseek-account',
          name: 'DeepSeek Account',
          options: [
            { value: '["deepseek-account","deepseek-flash"]', name: 'DeepSeek-V4.1-Flash' },
          ],
        },
      ],
    },
  ]

  it('finds grouped values and names', () => {
    expect(currentOptionName(options, 'model')).toBe('DeepSeek-V4.1-Flash')
    expect(hasOptionValue(options, 'model', '["deepseek-account","deepseek-flash"]')).toBe(true)
    expect(hasOptionValue(options, 'model', 'nope')).toBe(false)
  })
})
