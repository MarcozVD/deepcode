import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { z } from 'zod'

/** First-run model: the Desktop account route needs no API key. */
export const DEFAULT_MODEL = '["deepseek-account","deepseek-flash"]'

export const configSchema = z.object({
  model: z.string().min(1).default(DEFAULT_MODEL),
  /** dsh `reasoning_effort` value; unset keeps dsh's default. */
  effort: z.string().min(1).optional(),
})
export type Config = z.infer<typeof configSchema>

export function configPath(home = homedir()): string {
  return join(home, '.deepcode', 'config.json')
}

/** Parse raw file text; anything missing or invalid falls back to defaults. */
export function parseConfig(text: string | undefined): Config {
  if (text === undefined) return configSchema.parse({})
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return configSchema.parse({})
  }
  const result = configSchema.safeParse(raw)
  return result.success ? result.data : configSchema.parse({})
}

export async function loadConfig(path = configPath()): Promise<Config> {
  try {
    return parseConfig(await readFile(path, 'utf8'))
  } catch {
    return parseConfig(undefined)
  }
}

export async function saveConfig(config: Config, path = configPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`)
}
