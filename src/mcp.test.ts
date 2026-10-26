// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these tests check literal ${VAR} expansion
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  addServer,
  expandEnv,
  loadServers,
  removeServer,
  resolveCommand,
  toAcpServers,
} from './mcp.js'
import { configFromAdd, McpCliError, parseAdd, runMcpCli } from './mcpCli.js'

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), 'deepcode-mcp-'))
  const home = join(root, 'home')
  const cwd = join(root, 'project')
  await mkdir(home)
  await mkdir(cwd)
  return { root, home, cwd }
}

describe('MCP config', () => {
  it('reads Claude Code .mcp.json and user/local scopes with local > project > user', async () => {
    const { home, cwd } = await sandbox()
    await writeFile(
      join(cwd, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          shared: { command: 'node', args: ['p.js'] },
          web: { type: 'http', url: 'http://x' },
        },
      }),
    )
    await addServer('user', 'shared', { command: 'node', args: ['u.js'], env: {} }, cwd, home)
    await addServer('user', 'files', { command: 'node', args: [], env: {} }, cwd, home)
    await addServer('local', 'web', { type: 'http', url: 'http://local', headers: {} }, cwd, home)
    const servers = await loadServers(cwd, home)
    expect(servers.map((server) => [server.name, server.scope])).toEqual([
      ['web', 'local'],
      ['shared', 'project'],
      ['files', 'user'],
    ])
  })

  it('flags bad names and SSE, and removes from the first scope that has a server', async () => {
    const { home, cwd } = await sandbox()
    await writeFile(
      join(cwd, '.mcp.json'),
      JSON.stringify({
        mcpServers: { 'bad name': { command: 'x' }, old: { type: 'sse', url: 'http://x' } },
      }),
    )
    const servers = await loadServers(cwd, home)
    expect(servers.find((server) => server.name === 'bad name')?.error).toMatch(/name/)
    expect(servers.find((server) => server.name === 'old')?.error).toMatch(/SSE/)
    expect(await removeServer('old', cwd, undefined, home)).toBe('project')
    expect(
      JSON.parse(await readFile(join(cwd, '.mcp.json'), 'utf8')).mcpServers.old,
    ).toBeUndefined()
    expect(await removeServer('missing', cwd, undefined, home)).toBeUndefined()
  })

  it('expands ${VAR} and ${VAR:-default}', () => {
    expect(expandEnv('Bearer ${TOKEN}', { TOKEN: 'abc' })).toBe('Bearer abc')
    expect(expandEnv('${MISSING:-fallback}/x', {})).toBe('fallback/x')
  })

  it('resolves commands on PATH with PATHEXT and builds ACP servers', async () => {
    const { root, cwd } = await sandbox()
    const bin = join(root, 'bin')
    await mkdir(bin)
    await writeFile(join(bin, 'tool.cmd'), '@echo off')
    const env = { PATH: bin, PATHEXT: '.EXE;.CMD', TOKEN: 't' }
    expect(resolveCommand('tool', cwd, env, 'win32')).toBe(join(bin, 'tool.cmd'))
    expect(resolveCommand('nope', cwd, env, 'win32')).toBeUndefined()

    const { acp, skipped } = toAcpServers(
      [
        {
          name: 'a',
          scope: 'user',
          error: undefined,
          config: { command: 'tool', args: ['--k', '${TOKEN}'], env: { K: '${TOKEN}' } },
        },
        {
          name: 'b',
          scope: 'user',
          error: undefined,
          config: { type: 'http', url: 'http://h/${TOKEN}', headers: { X: '${TOKEN}' } },
        },
        {
          name: 'c',
          scope: 'user',
          error: undefined,
          config: { command: 'nope', args: [], env: {} },
        },
      ],
      cwd,
      env,
    )
    expect(acp).toEqual([
      {
        name: 'a',
        command: join(bin, 'tool.cmd'),
        args: ['--k', 't'],
        env: [{ name: 'K', value: 't' }],
      },
      { type: 'http', name: 'b', url: 'http://h/t', headers: [{ name: 'X', value: 't' }] },
    ])
    expect(skipped.map((server) => server.error)).toEqual(['command not found: nope'])
  })
})

describe('deepcode mcp CLI', () => {
  it('parses add like claude mcp add', () => {
    expect(
      configFromAdd(parseAdd(['-s', 'user', '-e', 'A=1', 'gh', '--', 'npx', '-y', 'server'])),
    ).toEqual({ name: 'gh', config: { command: 'npx', args: ['-y', 'server'], env: { A: '1' } } })
    expect(
      configFromAdd(
        parseAdd(['--transport', 'http', 'web', 'http://x', '-H', 'Authorization: Bearer t']),
      ),
    ).toEqual({
      name: 'web',
      config: { type: 'http', url: 'http://x', headers: { Authorization: 'Bearer t' } },
    })
    // Flags after the command belong to the command.
    expect(configFromAdd(parseAdd(['fs', 'node', 'srv.js', '-e', 'x'])).config).toEqual({
      command: 'node',
      args: ['srv.js', '-e', 'x'],
      env: {},
    })
    expect(() => parseAdd(['-t', 'sse', 'x', 'http://x'])).toThrow(McpCliError)
  })

  it('adds, lists, gets and removes servers', async () => {
    const { home, cwd } = await sandbox()
    let output = ''
    const io = {
      cwd,
      home,
      out: (text: string) => {
        output += text
      },
    }
    await runMcpCli(['add', '--transport', 'http', 'basics', 'http://127.0.0.1:4747/mcp'], io)
    await runMcpCli(
      ['add-json', '-s', 'project', 'files', '{"command":"node","args":["s.js"]}'],
      io,
    )
    output = ''
    await runMcpCli(['list'], io)
    expect(output).toContain('basics (local): http http://127.0.0.1:4747/mcp')
    expect(output).toContain('files (project): stdio node s.js')
    output = ''
    await runMcpCli(['get', 'files'], io)
    expect(output).toContain('Scope: project')
    await runMcpCli(['remove', 'basics'], io)
    output = ''
    await runMcpCli(['list'], io)
    expect(output).not.toContain('basics')
    await expect(runMcpCli(['remove', 'basics'], io)).rejects.toThrow(McpCliError)
  })
})
