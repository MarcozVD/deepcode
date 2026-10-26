import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'

import { summarizeInput } from './transcript.js'

/**
 * Read-only access to dsh's own session logs (`~/.dsh/sessions/<cwd>/<id>/
 * session.v4.jsonl.zstd`). ACP's session list carries no titles and resume
 * does not replay history, so deepcode reads both from here.
 */

export type HistoryItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; title: string; detail: string; failed: boolean }

export interface StoredSession {
  title: string | undefined
  history: HistoryItem[]
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

export function sessionsRoot(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return join(env.DSH_HOME ?? join(home, '.dsh'), 'sessions')
}

/**
 * dsh appends one zstd frame per flush; Node's decoder stops after the first
 * frame, so split on the frame magic and decode each piece. A magic sequence
 * inside compressed data just fails to decode and is merged with the next.
 */
export function decodeZstdFrames(buffer: Buffer): string {
  const decompress = (zlib as { zstdDecompressSync?: (data: Buffer) => Buffer }).zstdDecompressSync
  if (decompress === undefined) return ''
  const starts: number[] = []
  for (let index = buffer.indexOf(ZSTD_MAGIC); index >= 0; ) {
    starts.push(index)
    index = buffer.indexOf(ZSTD_MAGIC, index + ZSTD_MAGIC.length)
  }
  let text = ''
  for (let first = 0; first < starts.length; first += 1) {
    for (let end = first + 1; end <= starts.length; end += 1) {
      try {
        text += decompress(buffer.subarray(starts[first], starts[end] ?? buffer.length)).toString(
          'utf8',
        )
        first = end - 1
        break
      } catch {
        // Not a frame boundary; extend to the next magic.
      }
    }
  }
  return text
}

interface RawEvent {
  type?: string
  data?: {
    title?: string
    source?: { kind?: string }
    content?: { type?: string; text?: string }[]
    message?: {
      content?: { type?: string; text?: string }[]
      toolCallId?: string
      isError?: boolean
    }
    callId?: string
    name?: string
    arguments?: string
  }
}

function textOf(blocks: { type?: string; text?: string }[] | undefined): string {
  return (blocks ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim()
}

export function parseSessionLog(text: string): StoredSession {
  let title: string | undefined
  const history: HistoryItem[] = []
  const tools = new Map<string, Extract<HistoryItem, { kind: 'tool' }>>()
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let event: RawEvent
    try {
      event = JSON.parse(line) as RawEvent
    } catch {
      continue
    }
    const data = event.data
    if (data === undefined) continue
    switch (event.type) {
      case 'session/title':
        if (typeof data.title === 'string') title = data.title
        break
      case 'user/message':
        if (data.source?.kind === 'user') {
          const message = textOf(data.content)
          if (message !== '') history.push({ kind: 'user', text: message })
        }
        break
      case 'assistant/message': {
        const message = textOf(data.message?.content)
        if (message !== '') history.push({ kind: 'assistant', text: message })
        break
      }
      case 'tool/call': {
        let input: unknown
        try {
          input = JSON.parse(data.arguments ?? '{}')
        } catch {
          input = undefined
        }
        const item = {
          kind: 'tool' as const,
          title: data.name ?? 'tool',
          detail: summarizeInput(input),
          failed: false,
        }
        if (data.callId !== undefined) tools.set(data.callId, item)
        history.push(item)
        break
      }
      case 'tool/result': {
        const item = tools.get(data.message?.toolCallId ?? '')
        if (item !== undefined && data.message?.isError === true) item.failed = true
        break
      }
    }
  }
  return { title, history }
}

/** Find `<root>/<cwd-dir>/<id>` without depending on how dsh encodes the cwd. */
async function findSessionDir(root: string, id: string): Promise<string | undefined> {
  let groups: string[]
  try {
    groups = await readdir(root)
  } catch {
    return undefined
  }
  for (const group of groups) {
    const candidate = join(root, group, id)
    try {
      if ((await stat(candidate)).isDirectory()) return candidate
    } catch {
      // Not in this group.
    }
  }
  return undefined
}

/** The session's log file, if dsh has written one. */
async function findSessionLog(id: string, root: string): Promise<string | undefined> {
  const dir = await findSessionDir(root, id)
  if (dir === undefined) return undefined
  try {
    const log = (await readdir(dir)).find((file) => file.endsWith('.jsonl.zstd'))
    return log === undefined ? undefined : join(dir, log)
  } catch {
    return undefined
  }
}

export async function readStoredSession(
  id: string,
  root = sessionsRoot(),
): Promise<StoredSession | undefined> {
  const log = await findSessionLog(id, root)
  if (log === undefined) return undefined
  try {
    return parseSessionLog(decodeZstdFrames(await readFile(log)))
  } catch {
    return undefined
  }
}

/** When the session log was last written, for sorting and labels. */
export async function sessionModified(
  id: string,
  root = sessionsRoot(),
): Promise<Date | undefined> {
  const log = await findSessionLog(id, root)
  if (log === undefined) return undefined
  try {
    return (await stat(log)).mtime
  } catch {
    return undefined
  }
}
