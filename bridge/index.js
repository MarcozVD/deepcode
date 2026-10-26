// deepcode bridge: relays dsh agent questions and plan mode to the deepcode TUI.
//
// Protocol: newline-delimited JSON over the pipe named by DEEPCODE_BRIDGE.
//   bridge -> tui  {type:'hello', version}
//                  {type:'question', id, sessionId, questions}
//                  {type:'abort', id}
//                  {type:'plan', sessionId, active}
//                  {type:'planResult', requestId, outcome, error?}
//   tui -> bridge  {type:'answer', id, answers}
//                  {type:'cancel', id}
//                  {type:'setPlan', requestId, sessionId, active}
//                  {type:'getPlan', sessionId}   (answered with a 'plan' message)
//                  {type:'listSkills', requestId, cwd, sessionId?} -> {type:'skills', requestId, skills}
//                  {type:'getSkill', requestId, name, cwd, sessionId?} -> {type:'skill', requestId, content}
//                  {type:'listTools', requestId, sessionId} -> {type:'tools', requestId, tools}
import net from 'node:net'

export const name = 'deepcode-bridge'
export const inject = ['agents']

export const PROTOCOL_VERSION = 1

/**
 * A user-questions failure. Importing dsh's own UserQuestionError does not
 * resolve from a linked bundle, but dsh restores any error shaped like this
 * (name + message + code) into its typed error.
 */
function questionError(message, code) {
  const error = new Error(message)
  error.name = 'UserQuestionError'
  error.code = code
  return error
}

const escapeAttr = (value) =>
  String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')

/** A loaded skill in dsh's own `<skill_content>` framing (as the `skill` tool renders it). */
function renderSkill(skill) {
  const base = skill.resourceBase
  const hint =
    base?.kind === 'directory'
      ? [
          `Base directory for this skill: ${base.path}`,
          'Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.',
        ]
      : base?.kind === 'url'
        ? [`Base URL for this skill: ${base.url}`, 'Load referenced resources only as needed.']
        : ['Load referenced resources only as needed.']
  return [
    `<skill_content name="${escapeAttr(skill.name)}">`,
    '<skill_resources>',
    ...hint,
    '</skill_resources>',
    '',
    '<skill_instructions>',
    skill.content,
    '</skill_instructions>',
    '</skill_content>',
  ].join('\n')
}

/** Session id of an agent, across dsh session shapes. */
function sessionIdOf(agent) {
  return agent?.session?.id ?? agent?.session?.header?.id
}

/** Plain-data copy of a question, without functions or signals. */
function plainQuestion(question) {
  return {
    id: question.id,
    question: question.question,
    header: question.header,
    detail: question.detail,
    multiSelect: question.multiSelect === true,
    options: (question.options ?? []).map((option) => ({
      label: option.label,
      description: option.description,
    })),
    intent:
      question.intent === undefined
        ? undefined
        : { kind: question.intent.kind, approve: question.intent.approve },
  }
}

export function apply(ctx) {
  const path = process.env.DEEPCODE_BRIDGE
  if (!path) return

  const pending = new Map()
  let nextId = 1
  let connected = false
  let buffer = ''
  const socket = net.connect(path)
  socket.setEncoding('utf8')

  const send = (message) => {
    if (connected) socket.write(`${JSON.stringify(message)}\n`)
  }

  const dropPending = () => {
    for (const entry of pending.values()) {
      entry.reject(questionError('the deepcode terminal disconnected', 'NO_PROVIDER'))
    }
    pending.clear()
  }

  const setPlan = (message) => {
    const reply = (outcome, error) =>
      send({ type: 'planResult', requestId: message.requestId, outcome, error })
    const agent = ctx.agents.get(message.sessionId)
    const planMode = ctx.get('planMode')
    if (agent === undefined) return reply('error', 'no live agent for this session')
    if (planMode === undefined) return reply('error', 'plan mode is not available in this profile')
    try {
      reply(planMode.set(agent, message.active === true))
    } catch (error) {
      reply('error', error instanceof Error ? error.message : String(error))
    }
  }

  const handle = (message) => {
    if (message === null || typeof message !== 'object') return
    if (message.type === 'answer' || message.type === 'cancel') {
      const entry = pending.get(message.id)
      if (entry === undefined) return
      pending.delete(message.id)
      if (message.type === 'answer') entry.resolve({ answers: message.answers ?? [] })
      else entry.reject(questionError('the user dismissed the question', 'ASK_CANCELLED'))
    } else if (message.type === 'setPlan') {
      setPlan(message)
    } else if (message.type === 'getPlan') {
      const agent = ctx.agents.get(message.sessionId)
      const planMode = ctx.get('planMode')
      if (agent === undefined || planMode === undefined) return
      const state = planMode.get(agent)
      send({ type: 'plan', sessionId: message.sessionId, active: state.pending ?? state.active })
    } else if (message.type === 'listSkills') {
      void listSkills(message)
    } else if (message.type === 'getSkill') {
      void getSkill(message)
    } else if (message.type === 'listTools') {
      listTools(message)
    }
  }

  /** Reply to a request; failures become `{ error }` so the TUI never hangs. */
  const answer = async (message, type, work) => {
    try {
      send({ type, requestId: message.requestId, ...(await work()) })
    } catch (error) {
      send({
        type,
        requestId: message.requestId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const skillScope = (message) => {
    const agent = message.sessionId === undefined ? undefined : ctx.agents.get(message.sessionId)
    return { cwd: message.cwd, ...(agent === undefined ? {} : { scope: agent }) }
  }

  const listSkills = (message) =>
    answer(message, 'skills', async () => {
      const skills = ctx.get('skills')
      if (skills === undefined) return { skills: [] }
      const summaries = await skills.list(skillScope(message))
      return {
        skills: summaries.map((skill) => ({
          name: skill.name,
          description: skill.description,
          userInvocable: skill.invocation?.userInvocable !== false,
          source: skill.source,
          path: skill.path,
        })),
      }
    })

  const getSkill = (message) =>
    answer(message, 'skill', async () => {
      const skills = ctx.get('skills')
      const skill = await skills?.get(message.name, skillScope(message))
      if (skill === undefined) throw new Error(`no skill named ${message.name}`)
      return { name: skill.name, content: renderSkill(skill) }
    })

  const listTools = (message) =>
    answer(message, 'tools', async () => {
      const agent = ctx.agents.get(message.sessionId)
      const tools = ctx.get('tools')
      if (agent === undefined || typeof tools?.view !== 'function') return { tools: [] }
      return { tools: [...tools.view(agent).visible.keys()] }
    })

  socket.on('connect', () => {
    connected = true
    send({ type: 'hello', version: PROTOCOL_VERSION })
  })
  socket.on('data', (data) => {
    buffer += data
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
      if (line === '') continue
      try {
        handle(JSON.parse(line))
      } catch {
        // Ignore malformed lines from the TUI.
      }
    }
  })
  socket.on('error', () => {
    connected = false
    dropPending()
  })
  socket.on('close', () => {
    connected = false
    dropPending()
  })

  ctx.on('user-questions/request', (request, next) => {
    if (!connected) return next()
    const id = nextId
    nextId += 1
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      request.signal?.addEventListener(
        'abort',
        () => {
          if (!pending.delete(id)) return
          send({ type: 'abort', id })
          reject(questionError('ask_user_question was aborted', 'ASK_ABORTED'))
        },
        { once: true },
      )
      send({
        type: 'question',
        id,
        sessionId: sessionIdOf(request.agent),
        questions: request.questions.map(plainQuestion),
      })
    })
  })

  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'plan/mode') return
    send({
      type: 'plan',
      sessionId: session?.header?.id ?? session?.id,
      active: event.data?.active === true,
    })
  })

  ctx.on('dispose', () => {
    dropPending()
    socket.destroy()
  })
}
