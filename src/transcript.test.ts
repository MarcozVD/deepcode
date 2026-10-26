import { describe, expect, it } from 'vitest'

import {
  addEntry,
  applyUpdate,
  emptyTranscript,
  previewDiff,
  settledCount,
  summarizeInput,
  summarizeOutput,
  withTodos,
} from './transcript.js'

describe('applyUpdate', () => {
  it('merges consecutive message chunks into one assistant entry', () => {
    let state = applyUpdate(emptyTranscript, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'po' },
    })
    state = applyUpdate(state, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'ng' },
    })
    expect(state.entries).toEqual([{ kind: 'assistant', id: 0, text: 'pong' }])
  })

  it('starts a new text entry after a tool call', () => {
    let state = applyUpdate(emptyTranscript, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'a' },
    })
    state = applyUpdate(state, {
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'pwsh',
      status: 'in_progress',
      rawInput: { command: 'echo done' },
    })
    state = applyUpdate(state, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'b' },
    })
    expect(state.entries.map((entry) => entry.kind)).toEqual(['assistant', 'tool', 'assistant'])
  })

  it('updates a tool call status and output in place', () => {
    let state = applyUpdate(emptyTranscript, {
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'pwsh',
      status: 'in_progress',
      rawInput: { command: 'echo done' },
    })
    state = applyUpdate(state, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'done\r\n' } }],
    })
    expect(state.entries[0]).toMatchObject({
      kind: 'tool',
      title: 'pwsh',
      detail: 'echo done',
      status: 'completed',
      output: 'done',
    })
  })

  it('ignores updates for unknown tool calls and records usage', () => {
    let state = applyUpdate(emptyTranscript, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'missing',
      status: 'completed',
    })
    expect(state.entries).toEqual([])
    state = applyUpdate(state, { sessionUpdate: 'usage_update', used: 8233, size: 1048576 })
    expect(state.usage).toEqual({ used: 8233, size: 1048576 })
  })
})

describe('summaries', () => {
  it('prefers command, path or pattern fields', () => {
    expect(summarizeInput({ command: 'npm test\nmore' })).toBe('npm test')
    expect(summarizeInput({ file_path: 'C:/a.txt', content: 'x' })).toBe('C:/a.txt')
    expect(summarizeInput(undefined)).toBe('')
  })

  it('counts extra output lines', () => {
    expect(
      summarizeOutput([{ type: 'content', content: { type: 'text', text: 'one\ntwo\nthree' } }]),
    ).toBe('one (+2 lines)')
    expect(summarizeOutput(undefined)).toBe('')
  })
})

describe('previewDiff', () => {
  it('shows removed then added lines for an edit', () => {
    expect(
      previewDiff({ file_path: 'a.ts', old_string: 'one\ntwo', new_string: 'uno' }, undefined),
    ).toEqual([
      { sign: '-', text: 'one' },
      { sign: '-', text: 'two' },
      { sign: '+', text: 'uno' },
    ])
  })

  it('shows new content for a write and caps long previews', () => {
    const content = Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n')
    const diff = previewDiff({ file_path: 'a.ts', content }, undefined)
    expect(diff).toHaveLength(13)
    expect(diff[0]).toEqual({ sign: '+', text: 'line 0' })
    expect(diff.at(-1)).toEqual({ sign: '…', text: '8 more lines' })
  })

  it('prefers an ACP diff block and ignores other tools', () => {
    expect(
      previewDiff({ command: 'ls' }, [{ type: 'diff', path: 'a', oldText: 'x', newText: 'y' }]),
    ).toEqual([
      { sign: '-', text: 'x' },
      { sign: '+', text: 'y' },
    ])
    expect(previewDiff({ command: 'ls' }, undefined)).toEqual([])
  })
})

describe('todos', () => {
  it('mirrors todo_write input into the task list and ignores bad items', () => {
    const state = applyUpdate(emptyTranscript, {
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'todo_write',
      status: 'completed',
      rawInput: {
        todos: [
          { content: 'Read', status: 'completed' },
          { content: 'Fix', status: 'in_progress' },
          { content: 'Bad', status: 'later' },
        ],
      },
    })
    expect(state.todos).toEqual([
      { content: 'Read', status: 'completed' },
      { content: 'Fix', status: 'in_progress' },
    ])
    expect(withTodos(state, 'read', { todos: [] }).todos).toHaveLength(2)
  })
})

describe('settledCount', () => {
  it('keeps the last entry and open tool calls live while running', () => {
    let state = addEntry(emptyTranscript, { kind: 'user', text: 'hi' })
    state = applyUpdate(state, {
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'read',
      status: 'in_progress',
    })
    state = applyUpdate(state, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'x' },
    })
    expect(settledCount(state.entries, true)).toBe(1)
    expect(settledCount(state.entries, false)).toBe(3)
  })
})
