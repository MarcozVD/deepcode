import { existsSync, statSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'

import type { McpServer } from '@agentclientprotocol/sdk'
import { z } from 'zod'

/**
 * MCP servers configured the way Claude Code does it: the same JSON shape
 * (`{"mcpServers": {name: {command, args, env} | {type: "http", url, headers}}}`)
 * and the same three scopes.
 *
 * - local:   private to this folder, in ~/.deepcode/mcp.json under "projects"
 * - project: shared with the repo, in <cwd>/.mcp.json (Claude Code's file)
 * - user:    every folder, in ~/.deepcode/mcp.json
 *
 * On a name clash local wins over project, and project over user.
 */

export type Scope = 'local' | 'project' | 'user'
export const SCOPES: Scope[] = ['local', 'project', 'user']

const stdioServer = z.object({
  type: z.literal('stdio').optional(),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
})
const httpServer = z.object({
  type: z.enum(['http', 'sse']),
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()).default({}),
})
export const serverSchema = z.union([httpServer, stdioServer])
export type ServerConfig = z.infer<typeof serverSchema>

const serversSchema = z.record(z.string(), z.unknown())
const fileSchema = z
  .object({
    mcpServers: serversSchema.optional(),
    projects: z.record(z.string(), z.object({ mcpServers: serversSchema.optional() })).optional(),
  })
  .passthrough()
type McpFile = z.infer<typeof fileSchema>

/** dsh's server-name rule; names outside it would be rewritten with a hash. */
export const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/

export interface ConfiguredServer {
  name: string
  scope: Scope
  config: ServerConfig | undefined
  /** Why the entry cannot be used, when it cannot. */
  error: string | undefined
}

export function userConfigPath(home = homedir()): string {
  return join(home, '.deepcode', 'mcp.json')
}

export function projectConfigPath(cwd: string): string {
  return join(cwd, '.mcp.json')
}

async function readMcpFile(path: string): Promise<McpFile> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return {}
  }
  const parsed = fileSchema.safeParse(JSON.parse(text))
  if (!parsed.success)
    throw new Error(`${path}: ${parsed.error.issues[0]?.message ?? 'invalid MCP config'}`)
  return parsed.data
}

function projectKey(cwd: string): string {
  return resolve(cwd)
}

function entries(raw: Record<string, unknown> | undefined, scope: Scope): ConfiguredServer[] {
  return Object.entries(raw ?? {}).map(([name, value]) => {
    const parsed = serverSchema.safeParse(value)
    let error: string | undefined
    if (!SERVER_NAME.test(name)) error = 'name must be 1-32 letters, digits, _ or -'
    else if (!parsed.success) error = parsed.error.issues[0]?.message ?? 'invalid server config'
    else if ('url' in parsed.data && parsed.data.type === 'sse')
      error = 'SSE transport is not supported by dsh; use --transport http'
    return { name, scope, config: parsed.success ? parsed.data : undefined, error }
  })
}

/** Every configured server, with shadowed duplicates removed (local > project > user). */
export async function loadServers(cwd: string, home = homedir()): Promise<ConfiguredServer[]> {
  const user = await readMcpFile(userConfigPath(home))
  const project = await readMcpFile(projectConfigPath(cwd))
  const all = [
    ...entries(user.projects?.[projectKey(cwd)]?.mcpServers, 'local'),
    ...entries(project.mcpServers, 'project'),
    ...entries(user.mcpServers, 'user'),
  ]
  const seen = new Set<string>()
  return all.filter((server) => {
    if (seen.has(server.name)) return false
    seen.add(server.name)
    return true
  })
}

/** `${VAR}` and `${VAR:-default}`, as in Claude Code's .mcp.json. */
export function expandEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_match, name: string, fallback?: string) => {
      return env[name] ?? fallback ?? ''
    },
  )
}

/** Find an executable on PATH (with PATHEXT on Windows); dsh needs absolute stdio commands. */
export function resolveCommand(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const isFile = (path: string) => {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  }
  const extensions =
    platform === 'win32' ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')] : ['']
  const candidates = (base: string) => extensions.map((extension) => base + extension.toLowerCase())
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    const base = isAbsolute(command) ? command : resolve(cwd, command)
    return candidates(base).find(isFile)
  }
  for (const dir of (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : delimiter)) {
    if (dir === '') continue
    const found = candidates(join(dir, command)).find(isFile)
    if (found !== undefined) return found
  }
  return undefined
}

/** ACP `mcpServers` for session/new and session/resume, plus entries that were left out. */
export function toAcpServers(
  servers: ConfiguredServer[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): { acp: McpServer[]; skipped: ConfiguredServer[] } {
  const acp: McpServer[] = []
  const skipped: ConfiguredServer[] = []
  for (const server of servers) {
    const config = server.config
    if (config === undefined || server.error !== undefined) {
      skipped.push(server)
      continue
    }
    if ('url' in config) {
      acp.push({
        type: 'http',
        name: server.name,
        url: expandEnv(config.url, env),
        headers: Object.entries(config.headers).map(([name, value]) => ({
          name,
          value: expandEnv(value, env),
        })),
      })
      continue
    }
    const command = resolveCommand(expandEnv(config.command, env), cwd, env)
    if (command === undefined) {
      skipped.push({ ...server, error: `command not found: ${config.command}` })
      continue
    }
    acp.push({
      name: server.name,
      command,
      args: config.args.map((arg) => expandEnv(arg, env)),
      env: Object.entries(config.env).map(([name, value]) => ({
        name,
        value: expandEnv(value, env),
      })),
    })
  }
  return { acp, skipped }
}

async function writeMcpFile(path: string, data: McpFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`)
}

/** Add or replace a server in one scope. */
export async function addServer(
  scope: Scope,
  name: string,
  config: ServerConfig,
  cwd: string,
  home = homedir(),
): Promise<string> {
  if (!SERVER_NAME.test(name)) throw new Error('server name must be 1-32 letters, digits, _ or -')
  if (scope === 'project') {
    const path = projectConfigPath(cwd)
    const data = await readMcpFile(path)
    data.mcpServers = { ...data.mcpServers, [name]: config }
    await writeMcpFile(path, data)
    return path
  }
  const path = userConfigPath(home)
  const data = await readMcpFile(path)
  if (scope === 'user') {
    data.mcpServers = { ...data.mcpServers, [name]: config }
  } else {
    const key = projectKey(cwd)
    const project = data.projects?.[key] ?? {}
    data.projects = {
      ...data.projects,
      [key]: { ...project, mcpServers: { ...project.mcpServers, [name]: config } },
    }
  }
  await writeMcpFile(path, data)
  return path
}

/** Remove a server; without a scope, from the first scope that has it. */
export async function removeServer(
  name: string,
  cwd: string,
  scope: Scope | undefined,
  home = homedir(),
): Promise<Scope | undefined> {
  for (const candidate of scope === undefined ? SCOPES : [scope]) {
    const path = candidate === 'project' ? projectConfigPath(cwd) : userConfigPath(home)
    if (!existsSync(path)) continue
    const data = await readMcpFile(path)
    let servers: Record<string, unknown> | undefined
    if (candidate === 'project' || candidate === 'user') servers = data.mcpServers
    else servers = data.projects?.[projectKey(cwd)]?.mcpServers
    if (servers === undefined || !(name in servers)) continue
    delete servers[name]
    await writeMcpFile(path, data)
    return candidate
  }
  return undefined
}

/** One-line description of a server's transport and target. */
export function describeServer(config: ServerConfig | undefined): string {
  if (config === undefined) return 'invalid'
  if ('url' in config) return `${config.type} ${config.url}`
  return `stdio ${[config.command, ...config.args].join(' ')}`
}
