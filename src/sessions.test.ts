import zlib from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { decodeZstdFrames, parseSessionLog } from './sessions.js'

const events = [
  { type: 'session', version: 4, id: 's1' },
  {
    type: 'user/message',
    data: { content: [{ type: 'text', text: 'hidden' }], source: { kind: 'agent-instructions' } },
  },
  {
    type: 'user/message',
    data: { content: [{ type: 'text', text: 'run git status' }], source: { kind: 'user' } },
  },
  { type: 'session/title', data: { title: 'Check repo status' } },
  {
    type: 'assistant/message',
    data: {
      message: {
        content: [
          { type: 'reasoning', text: 'think' },
          { type: 'text', text: 'Running it.' },
        ],
      },
    },
  },
  {
    type: 'tool/call',
    data: { callId: 'c1', name: 'pwsh', arguments: '{"command":"git status"}' },
  },
  { type: 'tool/result', data: { message: { toolCallId: 'c1', isError: true } } },
]
const log = events.map((event) => JSON.stringify(event)).join('\n')

describe('decodeZstdFrames', () => {
  it('decodes several concatenated frames', () => {
    const half = Math.floor(log.length / 2)
    const buffer = Buffer.concat([
      zlib.zstdCompressSync(Buffer.from(log.slice(0, half))),
      zlib.zstdCompressSync(Buffer.from(log.slice(half))),
    ])
    expect(decodeZstdFrames(buffer)).toBe(log)
  })
})

describe('parseSessionLog', () => {
  it('extracts title, user prompts, assistant text and tool calls', () => {
    expect(parseSessionLog(log)).toEqual({
      title: 'Check repo status',
      history: [
        { kind: 'user', text: 'run git status' },
        { kind: 'assistant', text: 'Running it.' },
        { kind: 'tool', title: 'pwsh', detail: 'git status', failed: true },
      ],
    })
  })

  it('skips malformed lines', () => {
    expect(parseSessionLog('not json\n{"type":"session/title","data":{"title":"t"}}').title).toBe(
      't',
    )
  })
})
