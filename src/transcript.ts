import type { SessionUpdate, ToolCallContent, ToolCallStatus } from '@agentclientprotocol/sdk'

export type Entry =
  | { kind: 'user'; id: number; text: string }
  | { kind: 'assistant'; id: number; text: string }
  | { kind: 'thought'; id: number; text: string }
  | {
      kind: 'tool'
      id: number
      callId: string
      title: string
      detail: string
      status: ToolCallStatus
      output: string
      /** Why the agent asked to leave the sandbox, when it did. */
      reason: string
      /** Compact preview of a file change, for edit/write tools. */
      diff: DiffLine[]
    }
  | { kind: 'system'; id: number; text: string; tone: 'info' | 'error' }

export interface DiffLine {
  sign: '+' | '-' | '…'
  text: string
}

export interface Transcript {
  entries: Entry[]
  nextId: number
  usage: { used: number; size: number } | undefined
}

export const emptyTranscript: Transcript = { entries: [], nextId: 0, usage: undefined }

type NewEntry = Entry extends infer E ? (E extends Entry ? Omit<E, 'id'> : never) : never

export function addEntry(state: Transcript, entry: NewEntry): Transcript {
  return {
    ...state,
    entries: [...state.entries, { ...entry, id: state.nextId } as Entry],
    nextId: state.nextId + 1,
  }
}

/** Append streamed text to the last entry when it has the same kind, else start one. */
function appendText(state: Transcript, kind: 'assistant' | 'thought', text: string): Transcript {
  const last = state.entries.at(-1)
  if (last !== undefined && last.kind === kind) {
    const entries = state.entries.slice(0, -1)
    entries.push({ ...last, text: last.text + text })
    return { ...state, entries }
  }
  return addEntry(state, { kind, text })
}

const MAX_DETAIL = 80

/** One-line summary of a tool's input: the command, path or pattern if present. */
export function summarizeInput(rawInput: unknown): string {
  if (rawInput === null || typeof rawInput !== 'object') return ''
  const input = rawInput as Record<string, unknown>
  for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'url']) {
    const value = input[key]
    if (typeof value === 'string' && value !== '') return truncate(firstLine(value), MAX_DETAIL)
  }
  const json = JSON.stringify(input)
  return json === '{}' ? '' : truncate(json, MAX_DETAIL)
}

/** dsh puts the escalation reason in `justification` next to `sandbox_permissions`. */
export function justification(rawInput: unknown): string {
  if (rawInput === null || typeof rawInput !== 'object') return ''
  const value = (rawInput as Record<string, unknown>).justification
  return typeof value === 'string' ? value : ''
}

const MAX_DIFF_LINES = 12

function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/** Removed then added lines, capped, with a marker for what was cut. */
export function diffLines(oldText: string | null | undefined, newText: string): DiffLine[] {
  const lines: DiffLine[] = [
    ...splitLines(oldText ?? '').map((text) => ({ sign: '-' as const, text })),
    ...splitLines(newText).map((text) => ({ sign: '+' as const, text })),
  ]
  if (lines.length <= MAX_DIFF_LINES) return lines
  return [
    ...lines.slice(0, MAX_DIFF_LINES),
    { sign: '…', text: `${lines.length - MAX_DIFF_LINES} more lines` },
  ]
}

/**
 * Preview of a file change: an ACP `diff` content block if the agent sent one,
 * else dsh's `edit` (`old_string`/`new_string`) or `write` (`content`) input.
 */
export function previewDiff(
  rawInput: unknown,
  content: ToolCallContent[] | null | undefined,
): DiffLine[] {
  const block = content?.find((item) => item.type === 'diff')
  if (block !== undefined && block.type === 'diff') return diffLines(block.oldText, block.newText)
  if (rawInput === null || typeof rawInput !== 'object') return []
  const input = rawInput as Record<string, unknown>
  if (typeof input.old_string === 'string' && typeof input.new_string === 'string') {
    return diffLines(input.old_string, input.new_string)
  }
  if (typeof input.file_path === 'string' && typeof input.content === 'string') {
    return diffLines(undefined, input.content)
  }
  return []
}

/** Short description of a tool's output: first line plus a line count. */
export function summarizeOutput(content: ToolCallContent[] | null | undefined): string {
  if (!content) return ''
  const texts: string[] = []
  for (const item of content) {
    if (item.type === 'content' && item.content.type === 'text') texts.push(item.content.text)
    else if (item.type === 'diff') texts.push(`edited ${item.path}`)
  }
  const text = texts.join('\n').trim()
  if (text === '') return ''
  const lines = text.split(/\r?\n/)
  const head = truncate(lines[0] ?? '', MAX_DETAIL)
  return lines.length > 1 ? `${head} (+${lines.length - 1} lines)` : head
}

function firstLine(text: string): string {
  return text.split(/\r?\n/)[0] ?? ''
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export function applyUpdate(state: Transcript, update: SessionUpdate): Transcript {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      return update.content.type === 'text'
        ? appendText(state, 'assistant', update.content.text)
        : state
    case 'agent_thought_chunk':
      return update.content.type === 'text'
        ? appendText(state, 'thought', update.content.text)
        : state
    case 'tool_call':
      return addEntry(state, {
        kind: 'tool',
        callId: update.toolCallId,
        title: update.title,
        detail: summarizeInput(update.rawInput),
        reason: justification(update.rawInput),
        status: update.status ?? 'pending',
        output: summarizeOutput(update.content),
        diff: previewDiff(update.rawInput, update.content),
      })
    case 'tool_call_update': {
      const index = state.entries.findIndex(
        (entry) => entry.kind === 'tool' && entry.callId === update.toolCallId,
      )
      const current = state.entries[index]
      if (current === undefined || current.kind !== 'tool') return state
      const next: Entry = {
        ...current,
        title: update.title ?? current.title,
        detail: update.rawInput !== undefined ? summarizeInput(update.rawInput) : current.detail,
        reason: update.rawInput !== undefined ? justification(update.rawInput) : current.reason,
        status: update.status ?? current.status,
        output: update.content ? summarizeOutput(update.content) : current.output,
        diff:
          update.rawInput !== undefined
            ? previewDiff(update.rawInput, update.content)
            : current.diff.length > 0
              ? current.diff
              : previewDiff(undefined, update.content),
      }
      const entries = state.entries.slice()
      entries[index] = next
      return { ...state, entries }
    }
    case 'usage_update':
      return { ...state, usage: { used: update.used, size: update.size } }
    default:
      return state
  }
}

/**
 * How many leading entries can no longer change, so they can be printed once
 * (Ink `<Static>`). While a turn runs, the last entry and any unfinished tool
 * call stay live.
 */
export function settledCount(entries: Entry[], running: boolean): number {
  if (!running) return entries.length
  let count = Math.max(0, entries.length - 1)
  const firstOpenTool = entries.findIndex(
    (entry) =>
      entry.kind === 'tool' && (entry.status === 'pending' || entry.status === 'in_progress'),
  )
  if (firstOpenTool >= 0) count = Math.min(count, firstOpenTool)
  return count
}
