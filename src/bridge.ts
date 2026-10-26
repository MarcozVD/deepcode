import { randomUUID } from 'node:crypto'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * TUI side of the deepcode bridge (see bridge/index.js): a local pipe the
 * dsh-side plugin connects to, carrying agent questions and plan mode.
 */

export interface QuestionOption {
  label: string
  description?: string | undefined
}

export interface Question {
  id: string
  question: string
  header?: string | undefined
  detail?: string | undefined
  multiSelect: boolean
  options: QuestionOption[]
  intent?: { kind: string; approve: string } | undefined
}

export interface Answer {
  id: string
  selected: string[]
  custom?: string
}

export type PlanOutcome = 'committed' | 'queued' | 'cancelled' | 'noop' | 'error'

export interface BridgeHandlers {
  /** Resolve with answers, or undefined when the user dismisses the questions. */
  onQuestion: (questions: Question[], signal: AbortSignal) => Promise<Answer[] | undefined>
  onPlan: (sessionId: string, active: boolean) => void
}

export function pipePath(platform: NodeJS.Platform = process.platform): string {
  const name = `deepcode-${process.pid}-${randomUUID().slice(0, 8)}`
  return platform === 'win32' ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`)
}

interface Incoming {
  type?: string
  id?: number
  requestId?: number
  sessionId?: string
  active?: boolean
  outcome?: PlanOutcome
  error?: string
  questions?: Question[]
  skills?: SkillSummary[]
  content?: string
  tools?: string[]
}

export interface SkillSummary {
  name: string
  description: string
  userInvocable: boolean
  source?: string
  path?: string
}

/** Replies that answer a `requestId`. */
const REPLY_TYPES = new Set(['planResult', 'skills', 'skill', 'tools'])

export class BridgeServer {
  readonly path = pipePath()
  private server: net.Server | undefined
  private socket: net.Socket | undefined
  private readonly aborts = new Map<number, AbortController>()
  private readonly requests = new Map<number, (reply: Incoming | undefined) => void>()
  private nextRequest = 1
  private connectedListeners = new Set<() => void>()

  constructor(private readonly handlers: BridgeHandlers) {}

  get connected(): boolean {
    return this.socket !== undefined && !this.socket.destroyed
  }

  onConnected(listener: () => void): () => void {
    this.connectedListeners.add(listener)
    return () => this.connectedListeners.delete(listener)
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.accept(socket))
      this.server = server
      server.once('error', reject)
      server.listen(this.path, () => resolve())
    })
  }

  private accept(socket: net.Socket): void {
    // The latest dsh process wins; a restarted dsh replaces the old socket.
    this.socket?.destroy()
    this.socket = socket
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', (data: string) => {
      buffer += data
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (line === '') continue
        try {
          this.handle(JSON.parse(line) as Incoming)
        } catch {
          // Ignore malformed lines.
        }
      }
    })
    socket.on('close', () => {
      if (this.socket === socket) this.socket = undefined
      for (const controller of this.aborts.values()) controller.abort()
      this.aborts.clear()
      for (const resolve of this.requests.values()) resolve(undefined)
      this.requests.clear()
    })
    socket.on('error', () => {})
  }

  private send(message: object): void {
    if (this.connected) this.socket?.write(`${JSON.stringify(message)}\n`)
  }

  private handle(message: Incoming): void {
    if (message.type !== undefined && REPLY_TYPES.has(message.type)) {
      const resolve = this.requests.get(message.requestId ?? -1)
      this.requests.delete(message.requestId ?? -1)
      resolve?.(message)
      return
    }
    switch (message.type) {
      case 'hello':
        for (const listener of this.connectedListeners) listener()
        return
      case 'question': {
        const id = message.id
        if (id === undefined) return
        const controller = new AbortController()
        this.aborts.set(id, controller)
        this.handlers
          .onQuestion(message.questions ?? [], controller.signal)
          .then((answers) => {
            if (!this.aborts.delete(id)) return
            this.send(
              answers === undefined ? { type: 'cancel', id } : { type: 'answer', id, answers },
            )
          })
          .catch(() => {
            if (this.aborts.delete(id)) this.send({ type: 'cancel', id })
          })
        return
      }
      case 'abort': {
        const id = message.id
        if (id === undefined) return
        this.aborts.get(id)?.abort()
        this.aborts.delete(id)
        return
      }
      case 'plan':
        if (message.sessionId !== undefined) {
          this.handlers.onPlan(message.sessionId, message.active === true)
        }
        return
    }
  }

  /** Send a request and wait for its reply; undefined when disconnected. */
  private request(message: object): Promise<Incoming | undefined> {
    if (!this.connected) return Promise.resolve(undefined)
    const requestId = this.nextRequest
    this.nextRequest += 1
    return new Promise((resolve) => {
      this.requests.set(requestId, resolve)
      this.send({ ...message, requestId })
    })
  }

  async setPlan(sessionId: string, active: boolean): Promise<PlanOutcome> {
    const reply = await this.request({ type: 'setPlan', sessionId, active })
    return reply?.outcome ?? 'error'
  }

  /** Skills dsh discovers for this folder (including ~/.claude/skills via the bridge patch). */
  async listSkills(cwd: string, sessionId?: string): Promise<SkillSummary[]> {
    const reply = await this.request({ type: 'listSkills', cwd, sessionId })
    if (reply?.error !== undefined) throw new Error(reply.error)
    return reply?.skills ?? []
  }

  /** A skill rendered as dsh's `<skill_content>` block, ready to put in a prompt. */
  async getSkill(name: string, cwd: string, sessionId?: string): Promise<string> {
    const reply = await this.request({ type: 'getSkill', name, cwd, sessionId })
    if (reply === undefined) throw new Error('the dsh bridge is not connected')
    if (reply.error !== undefined) throw new Error(reply.error)
    return reply.content ?? ''
  }

  /** Tool names the session's agent can call (MCP tools are `mcp__<server>__<tool>`). */
  async listTools(sessionId: string): Promise<string[]> {
    const reply = await this.request({ type: 'listTools', sessionId })
    return reply?.tools ?? []
  }

  /** Ask for the session's plan state; the answer arrives through `onPlan`. */
  requestPlanState(sessionId: string): void {
    this.send({ type: 'getPlan', sessionId })
  }

  close(): void {
    this.socket?.destroy()
    this.server?.close()
  }
}
