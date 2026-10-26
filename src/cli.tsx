import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
} from '@agentclientprotocol/sdk'
import { render } from 'ink'
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  assertDshExists,
  currentOptionName,
  DshAcpClient,
  DshNotFoundError,
  defaultDshPath,
  hasOptionValue,
  readDshVersion,
  versionWarning,
} from './acp.js'
import { type ApprovalMode, type Args, ArgsError, HELP, parseArgs } from './args.js'
import { type Answer, BridgeServer, type Question } from './bridge.js'
import { HELP_TEXT, parseInput } from './commands.js'
import { type Config, loadConfig, saveConfig } from './config.js'
import { expandMentions, listFiles } from './mentions.js'
import { ALWAYS_PREFIX, allowKey, buildChoices, REASON_PREFIX } from './permissions.js'
import { ensureProfile, PROFILE_NAME } from './profile.js'
import { type HistoryItem, readStoredSession, sessionModified } from './sessions.js'
import { addEntry, applyUpdate, emptyTranscript, type Transcript } from './transcript.js'
import {
  App,
  type PendingPermission,
  type PendingQuestion,
  type PermissionChoice,
  type Picker,
  type QuestionChoice,
} from './ui.js'

/**
 * Callbacks that outlive React renders: the ACP client and the bridge call
 * these, and Root swaps in implementations bound to its state.
 */
interface Hooks {
  permission: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>
  question: (questions: Question[], signal: AbortSignal) => Promise<Answer[] | undefined>
  plan: (sessionId: string, active: boolean) => void
}

interface ActiveQuestion {
  questions: Question[]
  index: number
  answers: Answer[]
  resolve: (answers: Answer[] | undefined) => void
}

function questionView(active: ActiveQuestion): PendingQuestion | undefined {
  const question = active.questions[active.index]
  if (question === undefined) return undefined
  const review = question.intent?.kind === 'plan-review'
  return {
    header: question.header ?? '',
    question: question.question,
    options: question.options,
    multiSelect: question.multiSelect,
    customLabel: review ? 'Keep planning, with feedback…' : 'Type something else…',
    position: active.questions.length > 1 ? `(${active.index + 1}/${active.questions.length})` : '',
  }
}

interface ActivePermission {
  view: PendingPermission
  key: string
  resolve: (response: RequestPermissionResponse) => void
}

interface ActivePicker {
  view: Picker
  pick: (id: string) => void
}

/** Flattened `{value, name}` choices of a select config option. */
function selectChoices(options: SessionConfigOption[], id: string): PermissionChoice[] {
  const option = options.find((candidate) => candidate.id === id)
  if (option === undefined || option.type !== 'select') return []
  const choices: PermissionChoice[] = []
  for (const entry of option.options) {
    if ('options' in entry) {
      for (const choice of entry.options) choices.push({ id: choice.value, label: choice.name })
    } else {
      choices.push({ id: entry.value, label: entry.name })
    }
  }
  return choices
}

/** How many past items a resumed session shows. */
const HISTORY_LIMIT = 30
/** Longest replayed message, in lines. */
const HISTORY_LINES = 8

type NewEntry = Parameters<typeof addEntry>[1]

function historyEntry(item: HistoryItem): NewEntry {
  if (item.kind === 'tool') {
    return {
      kind: 'tool',
      callId: '',
      title: item.title,
      detail: item.detail,
      status: item.failed ? 'failed' : 'completed',
      output: '',
      reason: '',
      diff: [],
    }
  }
  const lines = item.text.split(/\r?\n/)
  if (lines.length <= HISTORY_LINES) return item
  const kept = lines.slice(0, HISTORY_LINES).join('\n')
  return { ...item, text: `${kept}\n… (+${lines.length - HISTORY_LINES} lines)` }
}

function formatDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function Root({
  client,
  hooks,
  server,
  args,
  initialConfig,
  cwd,
  onExit,
}: {
  client: DshAcpClient
  hooks: Hooks
  /** The bridge pipe, when the deepcode profile is in use. */
  server: BridgeServer | undefined
  args: Args
  initialConfig: Config
  cwd: string
  onExit: (code: number) => void
}) {
  const [planMode, setPlanMode] = useState(false)
  const [question, setQuestion] = useState<ActiveQuestion | undefined>()
  const [askingCustom, setAskingCustom] = useState(false)
  const [files, setFiles] = useState<string[]>([])
  const [transcript, setTranscriptState] = useState<Transcript>(emptyTranscript)
  const [running, setRunning] = useState(false)
  const [model, setModel] = useState<string | undefined>()
  const [approval, setApproval] = useState<ApprovalMode>(args.approval)
  const [permission, setPermission] = useState<ActivePermission | undefined>()
  const [picker, setPicker] = useState<ActivePicker | undefined>()
  const [askingReason, setAskingReason] = useState(false)
  const pendingReason = useRef<string | undefined>(undefined)
  const config = useRef(initialConfig)
  // The ref is the source of truth and changes synchronously: a permission
  // request can arrive right after its tool_call, before React re-renders.
  const transcriptRef = useRef(transcript)
  const setTranscript = useCallback(
    (next: Transcript | ((state: Transcript) => Transcript)): void => {
      transcriptRef.current = typeof next === 'function' ? next(transcriptRef.current) : next
      setTranscriptState(transcriptRef.current)
    },
    [],
  )
  const approvalRef = useRef(approval)
  approvalRef.current = approval
  const allowed = useRef(new Set<string>())

  const say = useCallback(
    (text: string, tone: 'info' | 'error' = 'info'): void =>
      setTranscript((state) => addEntry(state, { kind: 'system', text, tone })),
    [setTranscript],
  )

  /** Status-bar label: model name plus reasoning effort. */
  const refreshModelLabel = useCallback((): void => {
    const name = currentOptionName(client.configOptions, 'model')
    const effort = currentOptionName(client.configOptions, 'reasoning_effort')
    setModel(name === undefined ? undefined : effort ? `${name} (${effort})` : name)
  }, [client])

  /** Apply the saved model and effort to the current session. */
  const applyModel = useCallback(async (): Promise<void> => {
    const { model: savedModel, effort } = config.current
    if (hasOptionValue(client.configOptions, 'model', savedModel)) {
      await client.setConfig('model', savedModel)
    }
    if (effort !== undefined && hasOptionValue(client.configOptions, 'reasoning_effort', effort)) {
      await client.setConfig('reasoning_effort', effort)
    }
    refreshModelLabel()
  }, [client, refreshModelLabel])

  /** Picker over a select config option that saves the choice. */
  const chooseOption = (configId: string, title: string, key: 'model' | 'effort'): void => {
    setPicker({
      view: { title, items: selectChoices(client.configOptions, configId) },
      pick: (value) => {
        void client
          .setConfig(configId, value)
          .then(async () => {
            config.current = { ...config.current, [key]: value }
            refreshModelLabel()
            await saveConfig(config.current)
          })
          .catch((error: unknown) => say(describeError(error), 'error'))
      },
    })
  }

  /** Resume a session and replay its recent history from dsh's log. */
  const resume = useCallback(
    async (id: string): Promise<void> => {
      await client.resumeSession(id)
      await applyModel()
      allowed.current.clear()
      const stored = await readStoredSession(id)
      let state = emptyTranscript
      const history = stored?.history ?? []
      const shown = history.slice(-HISTORY_LIMIT)
      if (history.length > shown.length) {
        state = addEntry(state, {
          kind: 'system',
          text: `… ${history.length - shown.length} earlier items`,
          tone: 'info',
        })
      }
      for (const item of shown) state = addEntry(state, historyEntry(item))
      state = addEntry(state, {
        kind: 'system',
        text: `Resumed: ${stored?.title ?? id}`,
        tone: 'info',
      })
      setTranscript(state)
      setPlanMode(false)
      server?.requestPlanState(id)
    },
    [client, applyModel, setTranscript, server],
  )

  const showSessions = useCallback(async (): Promise<void> => {
    const sessions = (await client.listSessions()).filter(
      (session) => session.sessionId !== client.sessionId,
    )
    const dated = await Promise.all(
      sessions.map(async (session) => ({
        id: session.sessionId,
        modified: await sessionModified(session.sessionId),
      })),
    )
    dated.sort((a, b) => (b.modified?.getTime() ?? 0) - (a.modified?.getTime() ?? 0))
    const items = await Promise.all(
      dated.slice(0, 9).map(async ({ id, modified }) => {
        const stored = await readStoredSession(id)
        const firstPrompt = stored?.history.find((item) => item.kind === 'user')
        const title = stored?.title ?? (firstPrompt?.kind === 'user' ? firstPrompt.text : id)
        const when = modified !== undefined ? `  ${formatDate(modified)}` : ''
        return { id, label: `${title.split(/\r?\n/)[0]}${when}` }
      }),
    )
    setPicker({
      view: { title: 'Resume a session from this folder', items },
      pick: (id) => {
        resume(id).catch((error: unknown) => say(`Resume failed: ${describeError(error)}`, 'error'))
      },
    })
  }, [client, resume, say])

  useEffect(() => {
    const stopUpdates = client.onUpdate((update) =>
      setTranscript((state) => applyUpdate(state, update)),
    )
    const stopExit = client.onExit((message) => {
      say(message, 'error')
      onExit(1)
    })
    hooks.question = (questions, signal) =>
      new Promise((resolve) => {
        if (questions.length === 0) {
          resolve([])
          return
        }
        // A plan under review is long: print it into the transcript once,
        // and keep only the question itself in the live prompt.
        for (const item of questions) {
          if (item.detail) {
            const title = item.intent?.kind === 'plan-review' ? 'Plan for review' : item.header
            setTranscript((state) =>
              addEntry(state, {
                kind: 'assistant',
                text: `**${title ?? 'Details'}**\n\n${item.detail}`,
              }),
            )
          }
        }
        const finish = (answers: Answer[] | undefined): void => {
          setQuestion(undefined)
          setAskingCustom(false)
          resolve(answers)
        }
        signal.addEventListener('abort', () => finish(undefined), { once: true })
        setQuestion({ questions, index: 0, answers: [], resolve: finish })
      })
    hooks.plan = (sessionId, active) => {
      if (sessionId === client.sessionId) setPlanMode(active)
    }
    void listFiles(cwd).then(setFiles)
    hooks.permission = (request) =>
      new Promise((resolve) => {
        const tool = transcriptRef.current.entries.find(
          (entry) => entry.kind === 'tool' && entry.callId === request.toolCall.toolCallId,
        )
        const title = request.toolCall.title ?? (tool?.kind === 'tool' ? tool.title : 'tool')
        const detail = tool?.kind === 'tool' ? tool.detail : ''
        const reason = tool?.kind === 'tool' ? tool.reason : ''
        const key = allowKey(title, detail)
        const allowOnce = request.options.find((option) => option.kind === 'allow_once')
        const rejectOnce = request.options.find((option) => option.kind === 'reject_once')
        if (approvalRef.current === 'auto-reject') {
          resolve(
            rejectOnce !== undefined
              ? { outcome: { outcome: 'selected', optionId: rejectOnce.optionId } }
              : { outcome: { outcome: 'cancelled' } },
          )
          return
        }
        if (allowed.current.has(key) && allowOnce !== undefined) {
          resolve({ outcome: { outcome: 'selected', optionId: allowOnce.optionId } })
          return
        }
        setPermission({
          view: { title, detail, reason, choices: buildChoices(request.options, key) },
          key,
          resolve,
        })
      })

    void (async () => {
      try {
        await client.start()
        void readDshVersion().then((version) => {
          const warning = versionWarning(version)
          if (warning !== undefined) say(warning, 'error')
        })
        if (args.resume !== undefined && args.resume !== '') {
          await resume(args.resume)
        } else {
          await client.newSession()
          await applyModel()
        }
        if (args.resume === '') await showSessions()
      } catch (error) {
        say(`Failed to start dsh acp: ${describeError(error)}`, 'error')
        onExit(1)
      }
    })()
    return () => {
      stopUpdates()
      stopExit()
    }
  }, [client, hooks, args, cwd, onExit, say, applyModel, showSessions, setTranscript, resume])

  const switchPlan = (active: boolean): void => {
    const sessionId = client.sessionId
    if (server === undefined || !server.connected || sessionId === undefined) {
      say('Plan mode needs the deepcode dsh profile; it is not available in this session.', 'error')
      return
    }
    void server.setPlan(sessionId, active).then((outcome) => {
      if (outcome === 'error') say('Could not switch plan mode.', 'error')
      else if (outcome === 'queued') say(`Plan mode ${active ? 'on' : 'off'} from the next step.`)
      if (outcome === 'committed' || outcome === 'queued' || outcome === 'noop') setPlanMode(active)
    })
  }

  /** Shift+Tab: normal → plan → auto-reject → normal (plan only with the bridge). */
  const cycleMode = (): void => {
    if (planMode) {
      switchPlan(false)
      setApproval('auto-reject')
    } else if (approval === 'auto-reject') {
      setApproval('ask')
    } else if (server?.connected) {
      switchPlan(true)
    } else {
      setApproval('auto-reject')
    }
  }

  const answerQuestion = (choice: QuestionChoice): void => {
    if (question === undefined) return
    const current = question.questions[question.index]
    if (current === undefined) return
    if (choice.kind === 'dismissed') {
      question.resolve(undefined)
      return
    }
    if (choice.kind === 'custom') {
      setAskingCustom(true)
      return
    }
    recordAnswer({ id: current.id, selected: choice.labels })
  }

  const recordAnswer = (answer: Answer): void => {
    if (question === undefined) return
    const answers = [...question.answers, answer]
    if (question.index + 1 < question.questions.length) {
      setQuestion({ ...question, index: question.index + 1, answers })
    } else {
      question.resolve(answers)
    }
  }

  const submitCustom = (text: string): void => {
    setAskingCustom(false)
    const current = question?.questions[question.index]
    if (current === undefined) return
    recordAnswer({ id: current.id, selected: [], custom: text.trim() })
  }

  const runCommand = (name: string): void => {
    switch (name) {
      case 'help':
        say(HELP_TEXT)
        return
      case 'exit':
        onExit(0)
        return
      case 'clear':
        void client
          .newSession()
          .then(applyModel)
          .then(() => {
            allowed.current.clear()
            setTranscript(emptyTranscript)
            say('New session.')
          })
          .catch((error: unknown) => say(describeError(error), 'error'))
        return
      case 'resume':
        showSessions().catch((error: unknown) => say(describeError(error), 'error'))
        return
      case 'model':
        chooseOption('model', 'Choose a model', 'model')
        return
      case 'effort':
        chooseOption('reasoning_effort', 'Choose the reasoning effort', 'effort')
        return
      case 'plan':
        switchPlan(!planMode)
        return
    }
  }

  const submit = (text: string): void => {
    const parsed = parseInput(text)
    if (parsed.kind === 'command') {
      runCommand(parsed.name)
      return
    }
    if (parsed.kind === 'unknown') {
      say(`Unknown command /${parsed.name}. Type /help.`, 'error')
      return
    }
    sendPrompt(parsed.text)
  }

  const sendPrompt = (text: string): void => {
    setTranscript((state) => {
      // A finished task list has done its job; drop it when new work starts.
      const done =
        state.todos.length > 0 && state.todos.every((todo) => todo.status === 'completed')
      return addEntry(done ? { ...state, todos: [] } : state, { kind: 'user', text })
    })
    setRunning(true)
    expandMentions(text, cwd)
      .then(({ prompt, attached }) => {
        if (attached.length > 0) say(`Attached ${attached.join(', ')}`)
        return client.prompt(prompt)
      })
      .then((stopReason) => {
        if (stopReason === 'cancelled') say('Interrupted')
        else if (stopReason !== 'end_turn') say(`Turn ended: ${stopReason}`)
      })
      .catch((error: unknown) => say(describeError(error), 'error'))
      .finally(() => {
        setRunning(false)
        // The agent may have created or removed files: refresh @ completion.
        void listFiles(cwd).then(setFiles)
        // A rejection reason typed during the turn goes out as the next prompt.
        const reason = pendingReason.current
        pendingReason.current = undefined
        if (reason !== undefined) sendPrompt(reason)
      })
  }

  /** The user's "what to do instead" after rejecting a permission. */
  const submitReason = (text: string): void => {
    setAskingReason(false)
    const trimmed = text.trim()
    if (trimmed === '') return
    const message = `I rejected that action. ${trimmed}`
    if (running) pendingReason.current = message
    else sendPrompt(message)
  }

  const answerPermission = (choiceId: string | undefined): void => {
    if (permission === undefined) return
    setPermission(undefined)
    if (choiceId === undefined) {
      permission.resolve({ outcome: { outcome: 'cancelled' } })
      return
    }
    let optionId = choiceId
    if (choiceId.startsWith(ALWAYS_PREFIX)) {
      allowed.current.add(permission.key)
      optionId = choiceId.slice(ALWAYS_PREFIX.length)
    } else if (choiceId.startsWith(REASON_PREFIX)) {
      optionId = choiceId.slice(REASON_PREFIX.length)
      setAskingReason(true)
    }
    permission.resolve({ outcome: { outcome: 'selected', optionId } })
  }

  return (
    <App
      transcript={transcript}
      running={running}
      model={model}
      cwd={cwd}
      sandbox={client.sandbox}
      approval={approval}
      planMode={planMode}
      permission={permission?.view}
      picker={picker?.view}
      question={question === undefined ? undefined : questionView(question)}
      files={files}
      onQuestion={answerQuestion}
      onSubmit={askingCustom ? submitCustom : askingReason ? submitReason : submit}
      inputLabel={
        askingCustom
          ? 'Your answer (Enter send · Esc back to the options)'
          : askingReason
            ? 'What should the agent do instead? (Enter send · Esc skip)'
            : undefined
      }
      onInputCancel={
        askingCustom
          ? () => setAskingCustom(false)
          : askingReason
            ? () => setAskingReason(false)
            : undefined
      }
      onCancel={() => {
        client.cancel().catch(() => {})
      }}
      onPermission={answerPermission}
      onPick={(id) => {
        const active = picker
        setPicker(undefined)
        if (active !== undefined && id !== undefined) active.pick(id)
      }}
      onToggleApproval={cycleMode}
      onExit={() => onExit(0)}
    />
  )
}

async function main(): Promise<void> {
  let args: Args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    if (!(error instanceof ArgsError)) throw error
    process.stderr.write(`deepcode: ${error.message}\n\n${HELP}`)
    process.exitCode = 2
    return
  }
  if (args.help) {
    process.stdout.write(HELP)
    return
  }
  if (args.version) {
    process.stdout.write('deepcode 0.0.0\n')
    return
  }
  try {
    assertDshExists(defaultDshPath())
  } catch (error) {
    if (!(error instanceof DshNotFoundError)) throw error
    process.stderr.write(`deepcode: ${error.message}\n`)
    process.exitCode = 1
    return
  }
  if (!process.stdin.isTTY) {
    process.stderr.write('deepcode: stdin is not a terminal\n')
    process.exitCode = 1
    return
  }

  const cwd = process.cwd()
  const config = await loadConfig()
  const hooks: Hooks = {
    permission: () => Promise.resolve({ outcome: { outcome: 'cancelled' } }),
    question: () => Promise.resolve(undefined),
    plan: () => {},
  }

  // The deepcode profile adds agent questions and plan mode on top of
  // `dsh acp`. If it cannot be prepared, fall back to the stock profile.
  let server: BridgeServer | undefined
  if (!args.noBridge) {
    const setupLog: string[] = []
    const ready = await ensureProfile(defaultDshPath(), (line) => setupLog.push(line))
    if (ready) {
      server = new BridgeServer({
        onQuestion: (questions, signal) => hooks.question(questions, signal),
        onPlan: (sessionId, active) => hooks.plan(sessionId, active),
      })
      try {
        await server.listen()
      } catch {
        server = undefined
      }
    } else {
      process.stderr.write(
        `deepcode: could not prepare the "${PROFILE_NAME}" dsh profile; agent questions and plan mode are off.\n${setupLog.slice(-5).join('\n')}\n`,
      )
    }
  }
  const client = new DshAcpClient({
    cwd,
    sandbox: args.sandbox,
    profile: server === undefined ? undefined : PROFILE_NAME,
    env: server === undefined ? undefined : { DEEPCODE_BRIDGE: server.path },
    onPermission: (request) => hooks.permission(request),
  })

  let exiting = false
  const exit = (code: number): void => {
    if (exiting) return
    exiting = true
    client.close()
    server?.close()
    // Let Ink flush the last frame, then leave even if streams are still open.
    setTimeout(() => {
      app.unmount()
      process.exit(code)
    }, 50)
  }

  const app = render(
    <Root
      client={client}
      hooks={hooks}
      server={server}
      args={args}
      initialConfig={config}
      cwd={cwd}
      onExit={exit}
    />,
    { exitOnCtrlC: false },
  )
}

main().catch((error: unknown) => {
  process.stderr.write(
    `deepcode: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  )
  process.exit(1)
})
