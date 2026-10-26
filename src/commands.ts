export interface SlashCommand {
  name: string
  description: string
}

export const COMMANDS: SlashCommand[] = [
  { name: 'help', description: 'Show commands and keys' },
  { name: 'model', description: 'Choose the model' },
  { name: 'effort', description: 'Choose the reasoning effort' },
  { name: 'plan', description: 'Toggle plan mode (plan first, edit after approval)' },
  { name: 'resume', description: 'Resume a previous session in this folder' },
  { name: 'clear', description: 'Start a new session' },
  { name: 'exit', description: 'Quit deepcode' },
]

export type ParsedInput =
  | { kind: 'prompt'; text: string }
  | { kind: 'command'; name: string; args: string }
  | { kind: 'unknown'; name: string }

/** Lines starting with `/` are local commands; `//` sends a literal slash. */
export function parseInput(text: string): ParsedInput {
  if (text.startsWith('//')) return { kind: 'prompt', text: text.slice(1) }
  if (!text.startsWith('/')) return { kind: 'prompt', text }
  const [head = '', ...rest] = text.slice(1).split(/\s+/)
  const name = head.toLowerCase()
  if (COMMANDS.some((command) => command.name === name)) {
    return { kind: 'command', name, args: rest.join(' ') }
  }
  return { kind: 'unknown', name }
}

export const HELP_TEXT = [
  'Commands:',
  ...COMMANDS.map((command) => `  /${command.name.padEnd(8)} ${command.description}`),
  '',
  'Keys: Enter send · \\+Enter newline · ↑/↓ history · Esc interrupt',
  '      Shift+Tab normal/plan/auto-reject · @ mention files (Tab completes) · Ctrl+C twice exit',
].join('\n')
