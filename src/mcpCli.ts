import {
  addServer,
  describeServer,
  loadServers,
  removeServer,
  SCOPES,
  type Scope,
  type ServerConfig,
  serverSchema,
} from './mcp.js'

/** `deepcode mcp …`, mirroring `claude mcp …`. */

export const MCP_HELP = `Usage: deepcode mcp <command>

Commands:
  add [options] <name> <commandOrUrl> [args...]   Add a server
  add-json [-s scope] <name> <json>              Add a server from JSON
  list                                           List configured servers
  get <name>                                     Show one server
  remove [-s scope] <name>                       Remove a server

Options for add:
  -s, --scope <scope>          local (default, this folder only), project (.mcp.json) or user
  -t, --transport <transport>  stdio (default) or http
  -e, --env <KEY=value>        Environment variable for a stdio server (repeatable)
  -H, --header <"Name: value"> Header for an http server (repeatable)

Examples:
  deepcode mcp add github -e GITHUB_TOKEN=\${GITHUB_TOKEN} -- npx -y @modelcontextprotocol/server-github
  deepcode mcp add --transport http basics http://127.0.0.1:4747/mcp
  deepcode mcp add-json -s user files '{"command":"node","args":["server.js"]}'
`

export class McpCliError extends Error {}

export interface McpCliIo {
  out: (text: string) => void
  cwd: string
  home?: string
}

interface AddOptions {
  scope: Scope
  transport: 'stdio' | 'http'
  env: Record<string, string>
  headers: Record<string, string>
  positional: string[]
}

function parseScope(value: string | undefined): Scope {
  if (value === undefined || !SCOPES.includes(value as Scope)) {
    throw new McpCliError(`--scope must be one of ${SCOPES.join(', ')}`)
  }
  return value as Scope
}

/** Options may come before the name; everything after `--` is the command. */
export function parseAdd(argv: string[]): AddOptions {
  const options: AddOptions = {
    scope: 'local',
    transport: 'stdio',
    env: {},
    headers: {},
    positional: [],
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? ''
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined) throw new McpCliError(`${argument} needs a value`)
      index += 1
      return next
    }
    if (argument === '--') {
      options.positional.push(...argv.slice(index + 1))
      break
    }
    // Once a stdio server's name and command are known, the rest are its arguments.
    if (options.positional.length >= 2 && options.transport === 'stdio') {
      options.positional.push(argument)
      continue
    }
    if (argument === '-s' || argument === '--scope') options.scope = parseScope(value())
    else if (argument === '-t' || argument === '--transport') {
      const transport = value()
      if (transport === 'sse')
        throw new McpCliError('SSE is not supported by dsh; use --transport http')
      if (transport !== 'stdio' && transport !== 'http') {
        throw new McpCliError('--transport must be stdio or http')
      }
      options.transport = transport
    } else if (argument === '-e' || argument === '--env') {
      const pair = value()
      const equals = pair.indexOf('=')
      if (equals <= 0) throw new McpCliError(`--env expects KEY=value, got ${pair}`)
      options.env[pair.slice(0, equals)] = pair.slice(equals + 1)
    } else if (argument === '-H' || argument === '--header') {
      const header = value()
      const colon = header.indexOf(':')
      if (colon <= 0) throw new McpCliError(`--header expects "Name: value", got ${header}`)
      options.headers[header.slice(0, colon).trim()] = header.slice(colon + 1).trim()
    } else options.positional.push(argument)
  }
  return options
}

export function configFromAdd(options: AddOptions): { name: string; config: ServerConfig } {
  const [name, target, ...rest] = options.positional
  if (name === undefined || target === undefined) {
    throw new McpCliError('usage: deepcode mcp add [options] <name> <commandOrUrl> [args...]')
  }
  if (options.transport === 'http') {
    return { name, config: { type: 'http', url: target, headers: options.headers } }
  }
  return { name, config: { command: target, args: rest, env: options.env } }
}

export async function runMcpCli(argv: string[], io: McpCliIo): Promise<void> {
  const [command, ...rest] = argv
  switch (command) {
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      io.out(MCP_HELP)
      return
    case 'add': {
      const options = parseAdd(rest)
      const { name, config } = configFromAdd(options)
      const path = await addServer(options.scope, name, config, io.cwd, io.home)
      io.out(
        `Added ${options.scope} MCP server ${name}: ${describeServer(config)}\nSaved to ${path}\n`,
      )
      return
    }
    case 'add-json': {
      let scope: Scope = 'local'
      const positional: string[] = []
      for (let index = 0; index < rest.length; index += 1) {
        const argument = rest[index] ?? ''
        if (argument === '-s' || argument === '--scope') {
          scope = parseScope(rest[index + 1])
          index += 1
        } else positional.push(argument)
      }
      const [name, json] = positional
      if (name === undefined || json === undefined) {
        throw new McpCliError('usage: deepcode mcp add-json [-s scope] <name> <json>')
      }
      let raw: unknown
      try {
        raw = JSON.parse(json)
      } catch {
        throw new McpCliError('the server definition is not valid JSON')
      }
      const parsed = serverSchema.safeParse(raw)
      if (!parsed.success)
        throw new McpCliError(parsed.error.issues[0]?.message ?? 'invalid server')
      const path = await addServer(scope, name, parsed.data, io.cwd, io.home)
      io.out(
        `Added ${scope} MCP server ${name}: ${describeServer(parsed.data)}\nSaved to ${path}\n`,
      )
      return
    }
    case 'list': {
      const servers = await loadServers(io.cwd, io.home)
      if (servers.length === 0) {
        io.out('No MCP servers configured. Add one with: deepcode mcp add <name> <command>\n')
        return
      }
      for (const server of servers) {
        const problem = server.error === undefined ? '' : `  ✗ ${server.error}`
        io.out(`${server.name} (${server.scope}): ${describeServer(server.config)}${problem}\n`)
      }
      return
    }
    case 'get': {
      const name = rest[0]
      const server = (await loadServers(io.cwd, io.home)).find((entry) => entry.name === name)
      if (server === undefined) throw new McpCliError(`no MCP server named ${name ?? ''}`)
      io.out(
        `${server.name}\n  Scope: ${server.scope}\n  ${describeServer(server.config)}\n${
          server.error === undefined ? '' : `  Problem: ${server.error}\n`
        }`,
      )
      return
    }
    case 'remove': {
      let scope: Scope | undefined
      let name: string | undefined
      for (let index = 0; index < rest.length; index += 1) {
        const argument = rest[index] ?? ''
        if (argument === '-s' || argument === '--scope') {
          scope = parseScope(rest[index + 1])
          index += 1
        } else name = argument
      }
      if (name === undefined) throw new McpCliError('usage: deepcode mcp remove [-s scope] <name>')
      const removed = await removeServer(name, io.cwd, scope, io.home)
      if (removed === undefined) throw new McpCliError(`no MCP server named ${name}`)
      io.out(`Removed ${removed} MCP server ${name}\n`)
      return
    }
    default:
      throw new McpCliError(`unknown mcp command: ${command}\n\n${MCP_HELP}`)
  }
}
