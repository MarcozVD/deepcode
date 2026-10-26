import type { SlashCommand } from './commands.js'
import { type EditorState, setText } from './editor.js'
import { applyMention, currentMention, matchFiles } from './mentions.js'

/** The menu under the input while typing `/command` or `@file`. */
export interface CompletionItem {
  label: string
  description: string
}

export interface Completion {
  kind: 'command' | 'file'
  items: CompletionItem[]
  /** Editor state after accepting `items[index]`. */
  accept: (index: number) => EditorState
}

const MAX_ITEMS = 8

export function completionFor(
  editor: EditorState,
  commands: SlashCommand[],
  files: string[] | undefined,
): Completion | undefined {
  // `/name` as the whole input so far (no arguments yet).
  if (/^\/[\w-]*$/.test(editor.text) && editor.cursor === editor.text.length) {
    const query = editor.text.slice(1).toLowerCase()
    const matches = commands.filter((command) => command.name.startsWith(query))
    if (matches.length === 0) return undefined
    return {
      kind: 'command',
      items: matches.map((command) => ({
        label: `/${command.name}`,
        description: command.description,
      })),
      accept: (index) => setText(`/${matches[index]?.name ?? query}`),
    }
  }
  if (files === undefined) return undefined
  const mention = currentMention(editor)
  if (mention === undefined) return undefined
  const matches = matchFiles(files, mention.query, MAX_ITEMS)
  if (matches.length === 0) return undefined
  return {
    kind: 'file',
    items: matches.map((file) => ({ label: `@${file}`, description: '' })),
    accept: (index) => applyMention(editor, matches[index] ?? mention.query),
  }
}
