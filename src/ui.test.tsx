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
    expect(frame).toContain('DeepSeek-V4.1-Flash · 8k/1000k tokens · workspace-write')
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

  it('accepts input while a turn runs and shows what is queued', async () => {
    const onSubmit = vi.fn()
    const onEditQueued = vi.fn(() => 'then run tests')
    const { stdin, lastFrame } = render(
      <App {...props({ running: true, onSubmit, onEditQueued, queued: ['then run tests'] })} />,
    )
    expect(lastFrame()).toContain('> then run tests')
    expect(lastFrame()).toContain('↑ to edit queued messages')
    stdin.write('and lint')
    await tick()
    stdin.write(ENTER)
    await tick()
    expect(onSubmit).toHaveBeenCalledWith('and lint')
    stdin.write('\u001b[A')
    await tick()
    expect(onEditQueued).toHaveBeenCalled()
  })

  it('cancels a running turn on Esc', async () => {
    const onCancel = vi.fn()
    const { stdin, lastFrame } = render(<App {...props({ running: true, onCancel })} />)
    expect(lastFrame()).toContain('esc to interrupt')
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
    expect(lastFrame()).toContain('⏵⏵ auto-reject on')
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

  it('answers a single-choice question by number and offers free text', async () => {
    const onQuestion = vi.fn()
    const question = {
      header: 'Color',
      question: 'Which color?',
      options: [{ label: 'Red', description: 'warm' }, { label: 'Blue' }],
      multiSelect: false,
      customLabel: 'Type something else…',
      position: '',
    }
    const { stdin, lastFrame } = render(<App {...props({ question, onQuestion })} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Which color?')
    expect(frame).toContain('1. Red')
    expect(frame).toContain('3. Type something else…')
    stdin.write('2')
    await tick()
    expect(onQuestion).toHaveBeenLastCalledWith({ kind: 'selected', labels: ['Blue'] })
    stdin.write('3')
    await tick()
    expect(onQuestion).toHaveBeenLastCalledWith({ kind: 'custom' })
    stdin.write(ESC)
    await tick()
    expect(onQuestion).toHaveBeenLastCalledWith({ kind: 'dismissed' })
  })

  it('toggles several options in a multi-select question', async () => {
    const onQuestion = vi.fn()
    const question = {
      header: '',
      question: 'Pick toppings',
      options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
      multiSelect: true,
      customLabel: 'Other…',
      position: '(1/2)',
    }
    const { stdin, lastFrame } = render(<App {...props({ question, onQuestion })} />)
    stdin.write(' ')
    await tick()
    stdin.write(DOWN)
    await tick()
    stdin.write(DOWN)
    await tick()
    stdin.write(' ')
    await tick()
    expect(lastFrame()).toContain('[x] A')
    expect(lastFrame()).toContain('[x] C')
    stdin.write(ENTER)
    await tick()
    expect(onQuestion).toHaveBeenCalledWith({ kind: 'selected', labels: ['A', 'C'] })
  })

  it('shows plan mode and the agent task list', () => {
    const transcript = applyUpdate(emptyTranscript, {
      sessionUpdate: 'plan',
      entries: [
        { content: 'Read the code', status: 'completed', priority: 'medium' },
        { content: 'Write the fix', status: 'in_progress', priority: 'high' },
      ],
    })
    const frame = render(<App {...props({ transcript, planMode: true })} />).lastFrame() ?? ''
    expect(frame).toContain('plan mode')
    expect(frame).toContain('☑ Read the code')
    expect(frame).toContain('◐ Write the fix')
  })

  it('suggests files for @ and completes with Tab', async () => {
    const onSubmit = vi.fn()
    const files = ['src/ui.tsx', 'README.md']
    const { stdin, lastFrame } = render(<App {...props({ files, onSubmit })} />)
    stdin.write('see @ui')
    await tick()
    expect(lastFrame()).toContain('@src/ui.tsx')
    stdin.write('\t')
    await tick()
    stdin.write(ENTER)
    await tick()
    expect(onSubmit).toHaveBeenCalledWith('see @src/ui.tsx')
  })

  it('prints the header with the whale before anything else', () => {
    const header = {
      version: '1.2.3',
      model: 'DeepSeek-V4.1-Flash with high effort',
      account: 'DeepSeek account',
      cwd: 'C:/work',
      note: 'Using DeepSeek-V4.1-Flash · /model',
    }
    const transcript = addEntry(emptyTranscript, { kind: 'system', text: 'hello', tone: 'info' })
    const frame = render(<App {...props({ header, transcript })} />).lastFrame() ?? ''
    expect(frame).toContain('deepcode v1.2.3')
    expect(frame).toContain('DeepSeek-V4.1-Flash with high effort · DeepSeek account')
    expect(frame).toContain('│ Using DeepSeek-V4.1-Flash · /model')
    expect(frame).toContain('█')
    expect(frame.indexOf('deepcode v1.2.3')).toBeLessThan(frame.indexOf('hello'))
  })

  it('shows a placeholder in the empty input and a connecting line without a header', () => {
    const frame =
      render(<App {...props({ placeholder: 'Try "fix typecheck errors"' })} />).lastFrame() ?? ''
    expect(frame).toContain('Try "fix typecheck errors"')
    expect(frame).toContain('Connecting to DeepSeek Harness…')
  })

  it('navigates the slash command menu and runs the choice on Enter', async () => {
    const onSubmit = vi.fn()
    const { stdin, lastFrame } = render(<App {...props({ onSubmit })} />)
    stdin.write('/')
    await tick()
    expect(lastFrame()).toContain('/help')
    expect(lastFrame()).toContain('Choose the model')
    stdin.write(DOWN)
    await tick()
    stdin.write(ENTER)
    await tick()
    expect(onSubmit).toHaveBeenCalledWith('/model')
  })

  it('closes the menu on Esc and completes a command on Tab', async () => {
    const onSubmit = vi.fn()
    const { stdin, lastFrame } = render(<App {...props({ onSubmit })} />)
    stdin.write('/res')
    await tick()
    stdin.write('\t')
    await tick()
    expect(lastFrame()).toContain('> /resume')
    expect(onSubmit).not.toHaveBeenCalled()
    stdin.write('\u0015')
    await tick()
    stdin.write('/he')
    await tick()
    stdin.write(ESC)
    await tick()
    expect(lastFrame()).not.toContain('Show commands and keys')
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
