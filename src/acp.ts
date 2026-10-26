import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'

import {
  type Client,
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionInfo,
  type SessionUpdate,
  type StopReason,
} from '@agentclientprotocol/sdk'

/** dsh version this client was tested against. */
export const TESTED_DSH_VERSION = '0.2.1-rc.2'

export function defaultDshPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DEEPCODE_DSH) return env.DEEPCODE_DSH
  const base = env.LOCALAPPDATA ?? ''
  return join(base, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd')
}

/** How to run dsh; on Windows a .cmd needs cmd.exe with verbatim quoting. */
export function dshCommand(
  dshPath: string,
  platform: NodeJS.Platform = process.platform,
  argument = 'acp',
): { command: string; args: string[]; verbatim: boolean } {
  if (platform === 'win32') {
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', `""${dshPath}" ${argument}"`],
      verbatim: true,
    }
  }
  return { command: dshPath, args: [argument], verbatim: false }
}

/** Raised before spawning when dsh is not where deepcode expects it. */
export class DshNotFoundError extends Error {
  constructor(readonly dshPath: string) {
    super(
      `DeepSeek Harness CLI not found at ${dshPath}. Install DeepSeek Harness, or set DEEPCODE_DSH to the path of dsh.cmd.`,
    )
  }
}

export function assertDshExists(dshPath: string): void {
  if (!existsSync(dshPath)) throw new DshNotFoundError(dshPath)
}

/** `dsh --version`, or undefined if it cannot be read. */
export function readDshVersion(dshPath = defaultDshPath()): Promise<string | undefined> {
  return new Promise((resolve) => {
    const { command, args, verbatim } = dshCommand(dshPath, process.platform, '--version')
    const child = spawn(command, args, { windowsVerbatimArguments: verbatim, windowsHide: true })
    let output = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (data: string) => {
      output += data
    })
    child.once('error', () => resolve(undefined))
    child.once('exit', (code) => {
      const version = /\d+\.\d+\.\d+(?:-[\w.]+)?/.exec(output)?.[0]
      resolve(code === 0 ? version : undefined)
    })
  })
}

/** A warning when the running dsh is not the version deepcode was tested with. */
export function versionWarning(version: string | undefined): string | undefined {
  if (version === undefined || version === TESTED_DSH_VERSION) return undefined
  return `dsh ${version} has not been tested with deepcode (tested: ${TESTED_DSH_VERSION}). If something breaks, check docs/PLAN.md.`
}

// Log lines such as `[llm-deepseek-account] ...` start with `[`, so a prefix
// check is not enough: only lines that parse are protocol messages.
function isJson(line: string): boolean {
  if (!line.startsWith('{') && !line.startsWith('[')) return false
  try {
    JSON.parse(line)
    return true
  } catch {
    return false
  }
}

/**
 * dsh writes some log lines to stdout next to ACP JSON. Pass only JSON lines
 * on; hand everything else to `onOther` so the SDK never answers them with a
 * parse error.
 */
export function jsonLinesOnly(
  onOther: (line: string) => void,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let pending = ''
  const route = (line: string, controller: TransformStreamDefaultController<Uint8Array>): void => {
    const trimmed = line.trim()
    if (trimmed === '') return
    if (isJson(trimmed)) {
      controller.enqueue(encoder.encode(`${trimmed}\n`))
    } else {
      onOther(trimmed)
    }
  }
  return new TransformStream({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true })
      let newline = pending.indexOf('\n')
      while (newline >= 0) {
        route(pending.slice(0, newline), controller)
        pending = pending.slice(newline + 1)
        newline = pending.indexOf('\n')
      }
    },
    flush(controller) {
      route(pending, controller)
    },
  })
}

/** dsh's file-effect boundary, chosen when the process starts (`DSH_PERMISSION_MODE`). */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

export interface DshAcpClientOptions {
  cwd: string
  dshPath?: string
  sandbox?: SandboxMode
  /** dsh profile serving ACP; default is the stock `acp` profile. */
  profile?: string | undefined
  /** Extra environment for the dsh process. */
  env?: Record<string, string> | undefined
  onPermission: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>
  onLog?: (line: string) => void
}

/** One `dsh acp` child process and the single session deepcode drives. */
export class DshAcpClient {
  private child: ChildProcess | undefined
  private connection: ClientSideConnection | undefined
  private readonly updateListeners = new Set<(update: SessionUpdate) => void>()
  private readonly exitListeners = new Set<(message: string) => void>()
  sessionId: string | undefined
  sandbox: SandboxMode
  configOptions: SessionConfigOption[] = []
  agentVersion: string | undefined

  constructor(private readonly options: DshAcpClientOptions) {
    this.sandbox = options.sandbox ?? 'workspace-write'
  }

  onUpdate(listener: (update: SessionUpdate) => void): () => void {
    this.updateListeners.add(listener)
    return () => this.updateListeners.delete(listener)
  }

  /** Fires when dsh exits unexpectedly. */
  onExit(listener: (message: string) => void): () => void {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  async start(): Promise<void> {
    const dshPath = this.options.dshPath ?? defaultDshPath()
    assertDshExists(dshPath)
    const profile = this.options.profile
    const { command, args, verbatim } = dshCommand(
      dshPath,
      process.platform,
      profile === undefined ? 'acp' : `--profile ${profile}`,
    )
    const child = spawn(command, args, {
      cwd: this.options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsVerbatimArguments: verbatim,
      windowsHide: true,
      env: { ...process.env, ...this.options.env, DSH_PERMISSION_MODE: this.sandbox },
    })
    this.child = child
    const log = this.options.onLog ?? (() => {})
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (data: string) => {
      for (const line of data.split('\n')) if (line.trim() !== '') log(line.trim())
    })
    const exited = new Promise<never>((_, reject) => {
      child.once('error', (error) => reject(error))
      child.once('exit', (code) => {
        const message = `dsh acp exited with code ${String(code)}`
        // Only the current child counts; a replaced or closed one exits on purpose.
        if (child === this.child) for (const listener of this.exitListeners) listener(message)
        reject(new Error(message))
      })
    })
    exited.catch(() => {})

    if (child.stdin === null || child.stdout === null) throw new Error('dsh acp: stdio unavailable')
    const input = (Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>).pipeThrough(
      jsonLinesOnly(log),
    )
    const output = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>
    const client: Client = {
      requestPermission: (request) => this.options.onPermission(request),
      sessionUpdate: (notification) => {
        for (const listener of this.updateListeners) listener(notification.update)
      },
    }
    this.connection = new ClientSideConnection(() => client, ndJsonStream(output, input))
    const init = await Promise.race([
      this.connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }),
      exited,
    ])
    this.agentVersion = init.agentInfo?.version
  }

  private get conn(): ClientSideConnection {
    if (this.connection === undefined) throw new Error('dsh acp: not started')
    return this.connection
  }

  private get session(): string {
    if (this.sessionId === undefined) throw new Error('dsh acp: no session')
    return this.sessionId
  }

  async newSession(): Promise<string> {
    const response = await this.conn.newSession({ cwd: this.options.cwd, mcpServers: [] })
    this.sessionId = response.sessionId
    this.configOptions = response.configOptions ?? []
    return response.sessionId
  }

  async resumeSession(sessionId: string): Promise<void> {
    const response = await this.conn.resumeSession({
      sessionId,
      cwd: this.options.cwd,
      mcpServers: [],
    })
    this.sessionId = sessionId
    this.configOptions = response.configOptions ?? []
  }

  /** Sessions recorded for this client's cwd, newest first. */
  async listSessions(): Promise<SessionInfo[]> {
    const sessions: SessionInfo[] = []
    let cursor: string | null | undefined
    do {
      const page = await this.conn.listSessions({ cwd: this.options.cwd, cursor })
      sessions.push(...page.sessions)
      cursor = page.nextCursor
    } while (cursor)
    return sessions
      .filter((session) => samePath(session.cwd, this.options.cwd))
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
  }

  async setConfig(configId: string, value: string): Promise<void> {
    const response = await this.conn.setSessionConfigOption({
      sessionId: this.session,
      configId,
      value,
    })
    this.configOptions = response.configOptions
  }

  async prompt(text: string): Promise<StopReason> {
    const response = await this.conn.prompt({
      sessionId: this.session,
      prompt: [{ type: 'text', text }],
    })
    return response.stopReason
  }

  async cancel(): Promise<void> {
    if (this.sessionId !== undefined) await this.conn.cancel({ sessionId: this.sessionId })
  }

  close(): void {
    this.stopChild()
  }

  private stopChild(): void {
    const child = this.child
    this.child = undefined
    this.connection = undefined
    if (child === undefined || child.exitCode !== null) return
    if (process.platform === 'win32' && child.pid !== undefined) {
      // cmd.exe wraps the real dsh process; kill the whole tree.
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      })
    } else {
      child.kill()
    }
  }
}

/** Display name of the current value of a select option, if any. */
export function currentOptionName(options: SessionConfigOption[], id: string): string | undefined {
  const option = options.find((candidate) => candidate.id === id)
  if (option === undefined || option.type !== 'select') return undefined
  for (const entry of option.options) {
    if ('options' in entry) {
      const match = entry.options.find((choice) => choice.value === option.currentValue)
      if (match !== undefined) return match.name
    } else if (entry.value === option.currentValue) {
      return entry.name
    }
  }
  return option.currentValue
}

/** Whether a select option offers the given value. */
export function hasOptionValue(options: SessionConfigOption[], id: string, value: string): boolean {
  const option = options.find((candidate) => candidate.id === id)
  if (option === undefined || option.type !== 'select') return false
  return option.options.some((entry) =>
    'options' in entry
      ? entry.options.some((choice) => choice.value === value)
      : entry.value === value,
  )
}

function samePath(a: string, b: string): boolean {
  const normalize = (path: string) => path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
  return normalize(a) === normalize(b)
}
