import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { dshCommand } from './acp.js'

/**
 * The `deepcode` dsh profile: dsh-base + dsh-acp-app + deepcode-bridge. It
 * serves ACP like `dsh acp` and adds agent questions and plan-mode control.
 */
export const PROFILE_NAME = 'deepcode'
export const BRIDGE_PACKAGE = 'deepcode-bridge'
export const PROFILE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app', BRIDGE_PACKAGE]

export function profileDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return join(env.DSH_HOME ?? join(home, '.dsh'), 'profiles', PROFILE_NAME)
}

/** The bridge bundle shipped next to dist/ (repo or installed package). */
export function bridgeDir(moduleUrl: string = import.meta.url): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), '..', 'bridge')
}

interface ProfilePackage {
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
}

/** Whether the profile links this bridge and lists the bundles in order. */
export function profileIsReady(pkg: ProfilePackage | undefined, bridge: string): boolean {
  if (pkg === undefined) return false
  const link = pkg.dependencies?.[BRIDGE_PACKAGE]
  const bundles = pkg.dsh?.profile?.bundles ?? []
  return (
    link !== undefined &&
    normalize(link.replace(/^link:/, '')) === normalize(bridge) &&
    bundles.join('\n') === PROFILE_BUNDLES.join('\n')
  )
}

function normalize(path: string): string {
  return path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
}

async function readProfile(dir: string): Promise<ProfilePackage | undefined> {
  try {
    return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as ProfilePackage
  } catch {
    return undefined
  }
}

function run(dshPath: string, argument: string, onLog: (line: string) => void): Promise<number> {
  return new Promise((resolvePromise) => {
    const { command, args, verbatim } = dshCommand(dshPath, process.platform, argument)
    const child = spawn(command, args, {
      windowsVerbatimArguments: verbatim,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const log = (data: Buffer) => {
      for (const line of data.toString('utf8').split('\n'))
        if (line.trim() !== '') onLog(line.trim())
    }
    child.stdout?.on('data', log)
    child.stderr?.on('data', log)
    child.once('error', () => resolvePromise(1))
    child.once('exit', (code) => resolvePromise(code ?? 1))
  })
}

/**
 * Create or repair the profile: link the bridge with dsh's plugin manager,
 * then pin the bundle list. Returns false when it could not be set up.
 */
export async function ensureProfile(
  dshPath: string,
  onLog: (line: string) => void = () => {},
  bridge = bridgeDir(),
  dir = profileDir(),
): Promise<boolean> {
  if (!existsSync(join(bridge, 'package.json'))) return false
  if (profileIsReady(await readProfile(dir), bridge)) return true
  const linkPath = bridge.replaceAll('\\', '/')
  const code = await run(dshPath, `plugin --profile ${PROFILE_NAME} add "link:${linkPath}"`, onLog)
  const pkg = await readProfile(dir)
  if (code !== 0 || pkg === undefined) return false
  pkg.dsh = { ...pkg.dsh, profile: { ...pkg.dsh?.profile, bundles: PROFILE_BUNDLES } }
  await writeFile(join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
  return profileIsReady(pkg, bridge)
}
