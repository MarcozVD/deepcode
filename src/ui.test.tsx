import { render } from 'ink-testing-library'
import { describe, expect, it, vi } from 'vitest'

import { addEntry, applyUpdate, emptyTranscript } from './transcript.js'
import { App, type AppProps, tailLines } from './ui.js'

const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

const ENTER = '\r'
const ESC = '\u001b'
const CTRL_C = '\u0003'
const DOWN = '\u001b[B'
const LEFT = '\u001b[D'
const SHIFT_TAB = '\u001b[Z'

function props(overrides: Partial<AppProps> = {}): AppProps {
  return {
    transcript: emptyTranscript,
    running: false,
    model: 'DeepSeek-V4.1-Flash',
    cwd: 'C:/work',
    sandbox: 'workspace-write',
    approval: 'ask',
    permission: undefined,
    picker: undefined,
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
    onPermission: vi.fn(),
    onPick: vi.fn(),
    onToggleApproval: vi.fn(),
    onExit: vi.fn(),
    ...overrides,
  }
}

describe('App', () => {
  it('renders transcript entries, tool calls and the status bar', () => {
    let transcript = addEntry(emptyTranscript, { kind: 'user', text: 'run it' })
    transcript = applyUpdate(transcript, {
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'pwsh',
      status: 'completed',
      rawInput: { command: 'echo done' },
    })
    transcript = applyUpdate(transcript, {
      sessionUpdate: 'usage_update',
      used: 8000,
      size: 1000000,
    })
    const { lastFrame } = render(<App {...props({ transcript })} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('run it')
    expect(frame).toContain('pwsh(echo done)')
    expect(frame).toContain('DeepSeek-V4.1-Flash · 8k/1000k tokens · workspace-write · C:/work')
  })

  it('submits typed text on Enter and clears the input', async () => {
    const onSubmit = vi.fn()
    const { stdin, lastFrame } = render(<App {...props({ onSubmit })} />)
    stdin.write('hello')
    await tick()
    expect(lastFrame()).toContain('hello')
    stdin.write(ENTER)
    await tick()
    expect(onSubmit).toHaveBeenCalledWith('hello')
  })

  it('edits in the middle of the input with arrow keys', async () => {
    const onSubmit = vi.fn()
    const { stdin } = render(<App {...props({ onSubmit })} />)
    stdin.write('helo')
    await tick()
    stdin.write(LEFT)
    await tick()
    stdin.write('l')
    await tick()
    stdin.write(ENTER)
    await tick()
    expect(onSubmit).toHaveBeenCalledWith('hello')
  })

  it('keeps pasted multi-line text in the input instead of sending it', async () => {
    const onSubmit = vi.fn()
    const { stdin, lastFrame } = render(<App {...props({ onSubmit })} />)
    stdin.write('line one\r\nline two')
    await tick()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(lastFrame()).toContain('line two')
    stdin.write(ENTER)
    await tick()
    expect(onSubmit).toHaveBeenCalledWith('line one\nline two')
  })

  it('cancels a running turn on Esc', async () => {
    const onCancel = vi.fn()
    const { stdin, lastFrame } = render(<App {...props({ running: true, onCancel })} />)
    expect(lastFrame()).toContain('Esc to interrupt')
    stdin.write(ESC)
    await tick()
    expect(onCancel).toHaveBeenCalled()
  })

  it('exits only on a second Ctrl+C', async () => {
    const onExit = vi.fn()
    const { stdin, lastFrame } = render(<App {...props({ onExit })} />)
    stdin.write(CTRL_C)
    await tick()
    expect(onExit).not.toHaveBeenCalled()
    expect(lastFrame()).toContain('Press Ctrl+C again to exit')
    stdin.write(CTRL_C)
    await tick()
    expect(onExit).toHaveBeenCalled()
  })

  it('exits on two quick Ctrl+C presses', async () => {
    const onExit = vi.fn()
    const { stdin } = render(<App {...props({ onExit })} />)
    stdin.write(CTRL_C)
    stdin.write(CTRL_C)
    await tick()
    expect(onExit).toHaveBeenCalled()
  })

  it('answers a permission prompt by number', async () => {
    const onPermission = vi.fn()
    const permission = {
      title: 'pwsh',
      detail: 'rm -rf build',
      reason: 'Need to clean the build folder',
      choices: [
        { id: 'allow-once', label: 'Allow once' },
        { id: 'reject-once', label: 'Reject' },
      ],
    }
    const { stdin, lastFrame } = render(<App {...props({ permission, onPermission })} />)
    expect(lastFrame()).toContain('Permission required')
    expect(lastFrame()).toContain('1. Allow once')
    expect(lastFrame()).toContain('Need to clean the build folder')
    stdin.write('2')
    await tick()
    expect(onPermission).toHaveBeenCalledWith('reject-once')
  })

  it('toggles the approval mode on Shift+Tab', async () => {
    const onToggleApproval = vi.fn()
    const { stdin } = render(<App {...props({ onToggleApproval })} />)
    stdin.write(SHIFT_TAB)
    await tick()
    expect(onToggleApproval).toHaveBeenCalled()
  })

  it('shows the auto-reject mode in the status bar', () => {
    const { lastFrame } = render(<App {...props({ approval: 'auto-reject' })} />)
    expect(lastFrame()).toContain('workspace-write · auto-reject')
  })

  it('suggests slash commands while typing', async () => {
    const { stdin, lastFrame } = render(<App {...props()} />)
    stdin.write('/re')
    await tick()
    expect(lastFrame()).toContain('/resume')
    expect(lastFrame()).not.toContain('/model')
  })

  it('collects free text while a turn runs when an input label is shown', async () => {
    const onSubmit = vi.fn()
    const onInputCancel = vi.fn()
    const { stdin, lastFrame } = render(
      <App {...props({ running: true, onSubmit, onInputCancel, inputLabel: 'What instead?' })} />,
    )
    expect(lastFrame()).toContain('What instead?')
    stdin.write('use git stash')
    await tick()
    stdin.write(ENTER)
    await tick()
    expect(onSubmit).toHaveBeenCalledWith('use git stash')
    stdin.write(ESC)
    await tick()
    expect(onInputCancel).toHaveBeenCalled()
  })

  it('renders an edit diff under the tool line', () => {
    const transcript = applyUpdate(emptyTranscript, {
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'edit',
      status: 'completed',
      rawInput: { file_path: 'a.ts', old_string: 'old line', new_string: 'new line' },
    })
    const frame = render(<App {...props({ transcript })} />).lastFrame() ?? ''
    expect(frame).toContain('- old line')
    expect(frame).toContain('+ new line')
  })

  it('caps live text to the last lines', () => {
    expect(tailLines('a\nb\nc\nd', 2)).toBe('… (2 lines above)\nc\nd')
    expect(tailLines('a\nb', 5)).toBe('a\nb')
  })

  it('picks from a picker with arrows and Enter', async () => {
    const onPick = vi.fn()
    const picker = {
      title: 'Choose a model',
      items: [
        { id: 'a', label: 'Flash' },
        { id: 'b', label: 'Pro' },
      ],
    }
    const { stdin, lastFrame } = render(<App {...props({ picker, onPick })} />)
    expect(lastFrame()).toContain('Choose a model')
    stdin.write(DOWN)
    await tick()
    stdin.write(ENTER)
    await tick()
    expect(onPick).toHaveBeenCalledWith('b')
  })
})
