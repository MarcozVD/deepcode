import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

import type { EditorState } from './editor.js'

/** `@path` mentions: completion while typing and file contents on send. */

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.turbo',
  '.venv',
  'venv',
  '__pycache__',
  'target',
])
const MAX_FILES = 5000
const MAX_INLINE_BYTES = 64 * 1024
const MAX_SUGGESTIONS = 8

/** Workspace files as forward-slash relative paths, breadth-first, capped. */
export async function listFiles(root: string, limit = MAX_FILES): Promise<string[]> {
  const files: string[] = []
  const queue = [root]
  while (queue.length > 0 && files.length < limit) {
    const dir = queue.shift() ?? root
    let names: import('node:fs').Dirent[]
    try {
      names = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of names) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          queue.push(join(dir, entry.name))
        }
      } else if (entry.isFile()) {
        files.push(relative(root, join(dir, entry.name)).split(sep).join('/'))
        if (files.length >= limit) break
      }
    }
  }
  return files
}

/** The `@query` token under the cursor, if any. */
export function currentMention(editor: EditorState): { start: number; query: string } | undefined {
  const before = editor.text.slice(0, editor.cursor)
  const match = /(^|\s)@([^\s@]*)$/.exec(before)
  if (match === null) return undefined
  const query = match[2] ?? ''
  return { start: editor.cursor - query.length - 1, query }
}

/** Best matches: basename prefix, then path prefix, then substring. */
export function matchFiles(files: string[], query: string, limit = MAX_SUGGESTIONS): string[] {
  const needle = query.toLowerCase()
  const scored: { file: string; score: number }[] = []
  for (const file of files) {
    const lower = file.toLowerCase()
    const base = lower.slice(lower.lastIndexOf('/') + 1)
    let score: number
    if (needle === '') score = 3
    else if (base.startsWith(needle)) score = 0
    else if (lower.startsWith(needle)) score = 1
    else if (lower.includes(needle)) score = 2
    else continue
    scored.push({ file, score })
  }
  scored.sort(
    (a, b) => a.score - b.score || a.file.length - b.file.length || a.file.localeCompare(b.file),
  )
  return scored.slice(0, limit).map((entry) => entry.file)
}

/** Replace the mention under the cursor with `@file `. */
export function applyMention(editor: EditorState, file: string): EditorState {
  const mention = currentMention(editor)
  if (mention === undefined) return editor
  const insertion = `@${file} `
  const text = editor.text.slice(0, mention.start) + insertion + editor.text.slice(editor.cursor)
  return { text, cursor: mention.start + insertion.length }
}

/** Paths mentioned in a prompt, in order, without duplicates. */
export function mentionedPaths(text: string): string[] {
  const paths: string[] = []
  for (const match of text.matchAll(/(?:^|\s)@([^\s@]+)/g)) {
    const path = match[1]?.replace(/[.,;:!?)]+$/, '')
    if (path && !paths.includes(path)) paths.push(path)
  }
  return paths
}

/**
 * Append the contents of mentioned workspace files to the prompt, so the
 * agent sees them without a tool call. Files outside the workspace, missing
 * files and large files are left as plain mentions.
 */
export async function expandMentions(
  text: string,
  cwd: string,
): Promise<{ prompt: string; attached: string[] }> {
  const blocks: string[] = []
  const attached: string[] = []
  const root = resolve(cwd)
  for (const path of mentionedPaths(text)) {
    const absolute = resolve(root, path)
    if (absolute !== root && !absolute.startsWith(root + sep)) continue
    try {
      const info = await stat(absolute)
      if (!info.isFile() || info.size > MAX_INLINE_BYTES) continue
      const content = await readFile(absolute, 'utf8')
      if (content.includes('\u0000')) continue
      blocks.push(`<file path="${path}">\n${content}\n</file>`)
      attached.push(path)
    } catch {
      // Not a readable file: leave the mention as text.
    }
  }
  if (blocks.length === 0) return { prompt: text, attached }
  return { prompt: `${text}\n\nMentioned files:\n${blocks.join('\n')}`, attached }
}
