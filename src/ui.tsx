import { Box, Static, Text, useInput, useStdout } from 'ink'
import { useRef, useState } from 'react'

import type { ApprovalMode } from './args.js'
import { COMMANDS } from './commands.js'
import {
  backspace,
  cursorParts,
  deleteForward,
  deleteToLineStart,
  deleteWordBefore,
  type EditorState,
  emptyEditor,
  insert,
  lineEnd,
  lineStart,
  moveLeft,
  moveRight,
  setText,
  wordLeft,
  wordRight,
} from './editor.js'
import { Markdown } from './markdown.js'
import { applyMention, currentMention, matchFiles } from './mentions.js'
import { type Entry, settledCount, type Transcript } from './transcript.js'

export interface PermissionChoice {
  id: string
  label: string
}

export interface PendingPermission {
  title: string
  detail: string
  reason: string
  choices: PermissionChoice[]
}

/** A list the user picks one item from (models, sessions). */
export interface Picker {
  title: string
  items: PermissionChoice[]
}

/** One agent question on screen (multi-question requests are asked in turn). */
export interface PendingQuestion {
  header: string
  question: string
  options: { label: string; description?: string | undefined }[]
  multiSelect: boolean
  /** Label of the free-text choice appended after the options. */
  customLabel: string
  position: string
}

/** What the user did with a question. */
export type QuestionChoice =
  | { kind: 'selected'; labels: string[] }
  | { kind: 'custom' }
  | { kind: 'dismissed' }

/** Agent-facing mode the Shift+Tab cycle moves through. */
export type Mode = 'normal' | 'plan' | 'auto-reject'

export interface AppProps {
  transcript: Transcript
  running: boolean
  model: string | undefined
  cwd: string
  sandbox: string
  approval: ApprovalMode
  /** Whether plan mode is active (agent-side, via the bridge). */
  planMode?: boolean | undefined
  permission: PendingPermission | undefined
  picker: Picker | undefined
  question?: PendingQuestion | undefined
  /** Workspace files for `@` completion. */
  files?: string[] | undefined
  onSubmit: (text: string) => void
  onCancel: () => void
  onPermission: (choiceId: string | undefined) => void
  onPick: (id: string | undefined) => void
  onQuestion?: ((choice: QuestionChoice) => void) | undefined
  /** Shift+Tab: advance the mode cycle. */
  onToggleApproval: () => void
  onExit: () => void
  /** Shown above the input when it collects something other than a prompt. */
  inputLabel?: string | undefined
  /** Esc while `inputLabel` is shown. */
  onInputCancel?: (() => void) | undefined
}

const EXIT_WINDOW_MS = 2000

const STATUS_MARK: Record<string, string> = {
  pending: '○',
  in_progress: '◐',
  completed: '●',
  failed: '✗',
}

/** Keep the last `maxLines` lines so a live entry never outgrows the terminal. */
export function tailLines(text: string, maxLines: number | undefined): string {
  if (maxLines === undefined) return text
  const lines = text.split('\n')
  if (lines.length <= maxLines) return text
  return `… (${lines.length - maxLines} lines above)\n${lines.slice(-maxLines).join('\n')}`
}

const DIFF_COLOR = { '+': 'green', '-': 'red', '…': 'gray' } as const

export function EntryView({ entry, maxLines }: { entry: Entry; maxLines?: number }) {
  switch (entry.kind) {
    case 'user':
      return (
        <Box marginTop={1}>
          <Text color="gray">{'> '}</Text>
          <Text>{entry.text}</Text>
        </Box>
      )
    case 'assistant':
      return (
        <Box marginTop={1}>
          <Text color="white">{'● '}</Text>
          <Markdown text={tailLines(entry.text.trim(), maxLines)} />
        </Box>
      )
    case 'thought':
      return (
        <Box marginTop={1}>
          <Text color="gray" italic>
            {`✻ ${tailLines(entry.text.trim(), maxLines)}`}
          </Text>
        </Box>
      )
    case 'tool':
      return (
        <Box marginTop={1} flexDirection="column">
          <Text>
            <Text color={entry.status === 'failed' ? 'red' : 'green'}>
              {`${STATUS_MARK[entry.status] ?? '○'} `}
            </Text>
            <Text bold>{entry.title}</Text>
            {entry.detail !== '' ? <Text color="gray">{`(${entry.detail})`}</Text> : null}
          </Text>
          {entry.output !== '' && (entry.diff.length === 0 || entry.status === 'failed') ? (
            <Text color="gray">{`  ⎿ ${entry.output}`}</Text>
          ) : null}
          {entry.diff.map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are static per entry
            <Text key={index} color={DIFF_COLOR[line.sign]} wrap="truncate-end">
              {`    ${line.sign} ${line.text}`}
            </Text>
          ))}
        </Box>
      )
    case 'system':
      return (
        <Box marginTop={1}>
          <Text color={entry.tone === 'error' ? 'red' : 'yellow'}>{entry.text}</Text>
        </Box>
      )
  }
}

function SelectList({ items, selected }: { items: PermissionChoice[]; selected: number }) {
  return (
    <>
      {items.map((item, index) => (
        <Text key={item.id} color={index === selected ? 'cyan' : undefined} wrap="truncate-end">
          {`${index === selected ? '❯' : ' '} ${index + 1}. ${item.label}`}
        </Text>
      ))}
    </>
  )
}

export function PermissionPrompt({
  permission,
  selected,
}: {
  permission: PendingPermission
  selected: number
}) {
  return (
    <Box borderStyle="round" borderColor="yellow" flexDirection="column" paddingX={1} marginTop={1}>
      <Text bold>Permission required</Text>
      <Text>
        {permission.title}
        {permission.detail !== '' ? <Text color="gray">{` (${permission.detail})`}</Text> : null}
      </Text>
      {permission.reason !== '' ? <Text color="gray">{permission.reason}</Text> : null}
      <SelectList items={permission.choices} selected={selected} />
      <Text color="gray">↑/↓ or number to choose · Enter confirm · Esc cancel</Text>
    </Box>
  )
}

export function QuestionBox({
  question,
  selected,
  checked,
}: {
  question: PendingQuestion
  selected: number
  checked: ReadonlySet<number>
}) {
  const items = [...question.options, { label: question.customLabel, description: undefined }]
  return (
    <Box
      borderStyle="round"
      borderColor="magenta"
      flexDirection="column"
      paddingX={1}
      marginTop={1}
    >
      <Text bold>
        {question.header !== '' ? `${question.header} ` : ''}
        <Text color="gray">{question.position}</Text>
      </Text>
      <Text>{question.question}</Text>
      {items.map((item, index) => {
        const isCustom = index === items.length - 1
        const box = question.multiSelect && !isCustom ? (checked.has(index) ? '[x] ' : '[ ] ') : ''
        return (
          <Text
            key={item.label}
            color={index === selected ? 'cyan' : undefined}
            wrap="truncate-end"
          >
            {`${index === selected ? '❯' : ' '} ${index + 1}. ${box}${item.label}`}
            {item.description ? <Text color="gray">{`  ${item.description}`}</Text> : null}
          </Text>
        )
      })}
      <Text color="gray">
        {question.multiSelect
          ? '↑/↓ move · Space toggle · Enter confirm · Esc dismiss'
          : '↑/↓ or number to choose · Enter confirm · Esc dismiss'}
      </Text>
    </Box>
  )
}

const TODO_MARK = { pending: '☐', in_progress: '◐', completed: '☑' } as const

export function TodoList({ todos }: { todos: Transcript['todos'] }) {
  if (todos.length === 0) return null
  return (
    <Box flexDirection="column" marginTop={1}>
      {todos.map((todo, index) => (
        <Text
          // biome-ignore lint/suspicious/noArrayIndexKey: todo order is the identity
          key={index}
          color={
            todo.status === 'completed'
              ? 'gray'
              : todo.status === 'in_progress'
                ? 'cyan'
                : undefined
          }
          strikethrough={todo.status === 'completed'}
          wrap="truncate-end"
        >
          {`${TODO_MARK[todo.status]} ${todo.content}`}
        </Text>
      ))}
    </Box>
  )
}

export function PickerBox({ picker, selected }: { picker: Picker; selected: number }) {
  return (
    <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={1} marginTop={1}>
      <Text bold>{picker.title}</Text>
      {picker.items.length === 0 ? <Text color="gray">Nothing to choose.</Text> : null}
      <SelectList items={picker.items} selected={selected} />
      <Text color="gray">↑/↓ or number to choose · Enter confirm · Esc cancel</Text>
    </Box>
  )
}

export function StatusBar(props: {
  model: string | undefined
  transcript: Transcript
  cwd: string
  sandbox: string
  approval: ApprovalMode
  planMode?: boolean | undefined
  hint: string | undefined
}) {
  const usage = props.transcript.usage
  const tokens =
    usage !== undefined
      ? `${Math.round(usage.used / 1000)}k/${Math.round(usage.size / 1000)}k tokens`
      : undefined
  const mode = props.approval === 'auto-reject' ? `${props.sandbox} · auto-reject` : props.sandbox
  const parts = [props.model ?? 'connecting…', tokens, mode, props.cwd].filter(
    (part) => part !== undefined,
  )
  return (
    <Box flexDirection="column">
      <Text color="gray" wrap="truncate-start">
        {props.planMode ? <Text color="cyan">⏸ plan mode · </Text> : null}
        {parts.join(' · ')}
      </Text>
      {props.hint !== undefined ? <Text color="yellow">{props.hint}</Text> : null}
    </Box>
  )
}

/** Shared ↑/↓/number/Enter/Esc handling for permission prompts and pickers. */
function handleSelect(
  char: string,
  key: { escape: boolean; upArrow: boolean; downArrow: boolean; return: boolean },
  items: PermissionChoice[],
  selected: number,
  setSelected: (update: (index: number) => number) => void,
  choose: (id: string | undefined) => void,
): void {
  const count = items.length
  if (key.escape) {
    choose(undefined)
  } else if (key.upArrow && count > 0) {
    setSelected((index) => (index + count - 1) % count)
  } else if (key.downArrow && count > 0) {
    setSelected((index) => (index + 1) % count)
  } else if (key.return) {
    const item = items[selected]
    if (item !== undefined) choose(item.id)
  } else if (/^[1-9]$/.test(char)) {
    const item = items[Number(char) - 1]
    if (item !== undefined) choose(item.id)
  }
}

export function App(props: AppProps) {
  const { transcript, running, permission, picker, question } = props
  const [editor, setEditor] = useState<EditorState>(emptyEditor)
  const input = editor.text
  const clearInput = (): void => setEditor(emptyEditor)
  const [selected, setSelected] = useState(0)
  const [checked, setChecked] = useState<ReadonlySet<number>>(new Set())
  const mention = props.files === undefined ? undefined : currentMention(editor)
  const mentionMatches =
    mention === undefined || props.files === undefined ? [] : matchFiles(props.files, mention.query)
  const [exitArmed, setExitArmed] = useState(false)
  // A ref, not state: two quick Ctrl+C presses can arrive before a re-render.
  const exitArmedRef = useRef(false)
  const history = useRef<string[]>([])
  const historyIndex = useRef(-1)
  const exitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useInput((char, key) => {
    if (key.ctrl && char === 'c') {
      if (exitArmedRef.current) {
        props.onExit()
        return
      }
      exitArmedRef.current = true
      setExitArmed(true)
      clearTimeout(exitTimer.current)
      exitTimer.current = setTimeout(() => {
        exitArmedRef.current = false
        setExitArmed(false)
      }, EXIT_WINDOW_MS)
      return
    }

    if (permission !== undefined) {
      handleSelect(char, key, permission.choices, selected, setSelected, (id) => {
        setSelected(0)
        props.onPermission(id)
      })
      return
    }
    if (question !== undefined && props.inputLabel === undefined) {
      const count = question.options.length + 1
      const customIndex = count - 1
      const finish = (choice: QuestionChoice): void => {
        setSelected(0)
        setChecked(new Set())
        props.onQuestion?.(choice)
      }
      const choose = (index: number): void => {
        if (index === customIndex) finish({ kind: 'custom' })
        else if (question.multiSelect) {
          const picked = checked.size > 0 ? [...checked] : [index]
          const labels = picked
            .sort((a, b) => a - b)
            .map((position) => question.options[position]?.label ?? '')
          finish({ kind: 'selected', labels })
        } else finish({ kind: 'selected', labels: [question.options[index]?.label ?? ''] })
      }
      if (key.escape) finish({ kind: 'dismissed' })
      else if (key.upArrow) setSelected((index) => (index + count - 1) % count)
      else if (key.downArrow) setSelected((index) => (index + 1) % count)
      else if (char === ' ' && question.multiSelect && selected !== customIndex) {
        setChecked((current) => {
          const next = new Set(current)
          if (next.has(selected)) next.delete(selected)
          else next.add(selected)
          return next
        })
      } else if (key.return) choose(selected)
      else if (/^[1-9]$/.test(char) && Number(char) <= count) {
        if (question.multiSelect && Number(char) - 1 !== customIndex) setSelected(Number(char) - 1)
        else choose(Number(char) - 1)
      }
      return
    }
    if (picker !== undefined) {
      handleSelect(char, key, picker.items, selected, setSelected, (id) => {
        setSelected(0)
        props.onPick(id)
      })
      return
    }

    if (key.tab && key.shift) {
      props.onToggleApproval()
      return
    }
    if (key.tab && mentionMatches.length > 0) {
      const file = mentionMatches[0]
      if (file !== undefined) setEditor((state) => applyMention(state, file))
      return
    }
    const collecting = props.inputLabel !== undefined
    if (key.escape) {
      clearInput()
      if (collecting) props.onInputCancel?.()
      else if (running) props.onCancel()
      return
    }
    if (key.return) {
      // Alt+Enter (and terminals that send Shift+Enter as ESC CR) or a trailing
      // backslash insert a newline instead of sending.
      if (key.meta) {
        setEditor((state) => insert(state, '\n'))
        return
      }
      if (editor.cursor === input.length && input.endsWith('\\')) {
        setEditor((state) => insert(backspace(state), '\n'))
        return
      }
      const text = input.trim()
      if (collecting) {
        clearInput()
        props.onSubmit(text)
        return
      }
      if (text === '' || running) return
      history.current.unshift(text)
      historyIndex.current = -1
      clearInput()
      props.onSubmit(text)
      return
    }
    // History only while the prompt is a single line; otherwise ↑/↓ are inert.
    if (key.upArrow) {
      if (input.includes('\n')) return
      const next = Math.min(historyIndex.current + 1, history.current.length - 1)
      if (next >= 0) {
        historyIndex.current = next
        setEditor(setText(history.current[next] ?? ''))
      }
      return
    }
    if (key.downArrow) {
      if (input.includes('\n')) return
      const next = historyIndex.current - 1
      historyIndex.current = Math.max(next, -1)
      setEditor(setText(next >= 0 ? (history.current[next] ?? '') : ''))
      return
    }
    if (key.leftArrow) {
      setEditor((state) => (key.ctrl || key.meta ? wordLeft(state) : moveLeft(state)))
      return
    }
    if (key.rightArrow) {
      setEditor((state) => (key.ctrl || key.meta ? wordRight(state) : moveRight(state)))
      return
    }
    if (key.home || (key.ctrl && char === 'a')) {
      setEditor(lineStart)
      return
    }
    if (key.end || (key.ctrl && char === 'e')) {
      setEditor(lineEnd)
      return
    }
    if (key.ctrl && char === 'u') {
      setEditor(deleteToLineStart)
      return
    }
    if (key.ctrl && char === 'w') {
      setEditor(deleteWordBefore)
      return
    }
    if (key.ctrl && char === 'd') {
      setEditor(deleteForward)
      return
    }
    if (key.backspace || key.delete) {
      setEditor(backspace)
      return
    }
    if (key.meta && char === 'b') {
      setEditor(wordLeft)
      return
    }
    if (key.meta && char === 'f') {
      setEditor(wordRight)
      return
    }
    if (key.ctrl || key.meta || key.tab) return
    if (char !== '') setEditor((state) => insert(state, char))
  })

  const caret = cursorParts(editor)

  const settled = settledCount(transcript.entries, running)
  const live = transcript.entries.slice(settled)
  // Ink redraws the live area in place; if it is taller than the terminal the
  // overflow is duplicated in scrollback, so cap live text to what fits.
  const { stdout } = useStdout()
  const rows = (stdout as { rows?: number }).rows
  const liveLines = Math.max(4, (rows || 24) - 12)
  let hint: string | undefined
  if (exitArmed) hint = 'Press Ctrl+C again to exit'
  else if (running) hint = 'Esc to interrupt'

  const suggestions =
    input.startsWith('/') && !input.includes(' ')
      ? COMMANDS.filter((command) => command.name.startsWith(input.slice(1).toLowerCase()))
      : []

  return (
    <Box flexDirection="column">
      <Static items={transcript.entries.slice(0, settled)}>
        {(entry) => <EntryView key={entry.id} entry={entry} />}
      </Static>
      {live.map((entry) => (
        <EntryView key={entry.id} entry={entry} maxLines={liveLines} />
      ))}
      <TodoList todos={transcript.todos} />
      {running && permission === undefined && question === undefined ? (
        <Box marginTop={1}>
          <Text color="cyan">✻ Working…</Text>
        </Box>
      ) : null}
      {question !== undefined && permission === undefined ? (
        <QuestionBox question={question} selected={selected} checked={checked} />
      ) : null}
      {permission !== undefined ? (
        <PermissionPrompt permission={permission} selected={selected} />
      ) : null}
      {picker !== undefined && permission === undefined && question === undefined ? (
        <PickerBox picker={picker} selected={selected} />
      ) : null}
      {props.inputLabel !== undefined ? (
        <Box marginTop={1}>
          <Text color="yellow">{props.inputLabel}</Text>
        </Box>
      ) : null}
      <Box
        borderStyle="round"
        borderColor={props.inputLabel !== undefined ? 'yellow' : 'gray'}
        paddingX={1}
        marginTop={props.inputLabel !== undefined ? 0 : 1}
      >
        <Text color="gray">{'> '}</Text>
        <Text>
          {caret.before}
          <Text inverse>{caret.at}</Text>
          {caret.after}
        </Text>
      </Box>
      {suggestions.map((command) => (
        <Text key={command.name} color="gray">
          {`  /${command.name.padEnd(8)} ${command.description}`}
        </Text>
      ))}
      {mentionMatches.map((file, index) => (
        <Text key={file} color={index === 0 ? 'cyan' : 'gray'} wrap="truncate-start">
          {`  @${file}${index === 0 ? '  (Tab)' : ''}`}
        </Text>
      ))}
      <StatusBar
        model={props.model}
        transcript={transcript}
        cwd={props.cwd}
        sandbox={props.sandbox}
        approval={props.approval}
        planMode={props.planMode}
        hint={hint}
      />
    </Box>
  )
}
