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
import { HELP_TEXT, parseInput } from './commands.js'
import { type Config, loadConfig, saveConfig } from './config.js'
import { ALWAYS_PREFIX, allowKey, buildChoices, REASON_PREFIX } from './permissions.js'
import { type HistoryItem, readStoredSession, sessionModified } from './sessions.js'
import { addEntry, applyUpdate, emptyTranscript, type Transcript } from './transcript.js'
import { App, type PendingPermission, type PermissionChoice, type Picker } from './ui.js'

interface Bridge {
  permission: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>
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
  bridge,
  args,
  initialConfig,
  cwd,
  onExit,
}: {
  client: DshAcpClient
  bridge: Bridge
  args: Args
  initialConfig: Config
  cwd: string
  onExit: (code: number) => void
}) {
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
    },
    [client, applyModel, setTranscript],
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
    bridge.permission = (request) =>
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
  }, [client, bridge, args, onExit, say, applyModel, showSessions, setTranscript, resume])

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
    setTranscript((state) => addEntry(state, { kind: 'user', text }))
    setRunning(true)
    client
      .prompt(text)
      .then((stopReason) => {
        if (stopReason === 'cancelled') say('Interrupted')
        else if (stopReason !== 'end_turn') say(`Turn ended: ${stopReason}`)
      })
      .catch((error: unknown) => say(describeError(error), 'error'))
      .finally(() => {
        setRunning(false)
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
      permission={permission?.view}
      picker={picker?.view}
      onSubmit={askingReason ? submitReason : submit}
      inputLabel={
        askingReason ? 'What should the agent do instead? (Enter send · Esc skip)' : undefined
      }
      onInputCancel={askingReason ? () => setAskingReason(false) : undefined}
      onCancel={() => {
        client.cancel().catch(() => {})
      }}
      onPermission={answerPermission}
      onPick={(id) => {
        const active = picker
        setPicker(undefined)
        if (active !== undefined && id !== undefined) active.pick(id)
      }}
      onToggleApproval={() => setApproval((mode) => (mode === 'ask' ? 'auto-reject' : 'ask'))}
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
  const bridge: Bridge = {
    permission: () => Promise.resolve({ outcome: { outcome: 'cancelled' } }),
  }
  const client = new DshAcpClient({
    cwd,
    sandbox: args.sandbox,
    onPermission: (request) => bridge.permission(request),
  })

  let exiting = false
  const exit = (code: number): void => {
    if (exiting) return
    exiting = true
    client.close()
    // Let Ink flush the last frame, then leave even if streams are still open.
    setTimeout(() => {
      app.unmount()
      process.exit(code)
    }, 50)
  }

  const app = render(
    <Root
      client={client}
      bridge={bridge}
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
