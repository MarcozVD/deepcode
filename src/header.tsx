import { Box, Text } from 'ink'

import { theme } from './theme.js'

/**
 * The deepcode whale (ballena.svg) as pixels, one character per pixel:
 * a key of WHALE_COLORS or a space. Rendered two pixel rows per terminal row
 * with half blocks, like Claude Code's mascot.
 */
export const WHALE = [
  '                bb      ',
  '                bb      ',
  '              bb  bb    ',
  '              bb  bb    ',
  'aa    aa        bb      ',
  'aa    aa        bb      ',
  'aaaaaaaa    aaaaaaaaaa  ',
  'aaaaaaaa    aaaaaaaaaaaa',
  '  aaaaa   aaaaaaaaaaaaaa',
  '    a    aaaaaaaaaaaaaaa',
  '    a    aaaaaaaaaaaaaaa',
  '    aaaaaaaaaaaaaaaaaaaa',
  '    aaaaaaaaaaaaaaawaaaa',
  '    aaaaaaaaaaaaaaawaaaa',
  '     aaaaaaaaaaaaaaaaaaa',
  '       bbbbaaabbbbbbbb  ',
  '       bbbbaaabbbbbbbb  ',
  '          aaabbbbbbbb   ',
  '          aaa           ',
  '          aa            ',
]

export const WHALE_COLORS: Record<string, string> = {
  a: '#5271FF',
  b: '#8FA8FF',
  w: '#FFFFFF',
}

/** A run of terminal cells drawn with one foreground and background color. */
export interface Span {
  text: string
  color?: string | undefined
  background?: string | undefined
}

/**
 * Pixel rows → terminal rows using ▀ ▄ █: the upper pixel is the foreground
 * of ▀, the lower one its background when both are set and differ.
 */
export function toHalfBlocks(pixels: string[], colors: Record<string, string>): Span[][] {
  const rows: Span[][] = []
  for (let top = 0; top < pixels.length; top += 2) {
    const upper = pixels[top] ?? ''
    const lower = pixels[top + 1] ?? ''
    const width = Math.max(upper.length, lower.length)
    const row: Span[] = []
    for (let column = 0; column < width; column += 1) {
      const a = colors[upper[column] ?? '']
      const b = colors[lower[column] ?? '']
      const cell: Span =
        a === undefined && b === undefined
          ? { text: ' ' }
          : a === undefined
            ? { text: '▄', color: b }
            : b === undefined
              ? { text: '▀', color: a }
              : a === b
                ? { text: '█', color: a }
                : { text: '▀', color: a, background: b }
      const last = row.at(-1)
      if (last !== undefined && last.color === cell.color && last.background === cell.background) {
        last.text += cell.text
      } else {
        row.push(cell)
      }
    }
    while (row.length > 0 && row.at(-1)?.color === undefined) row.pop()
    rows.push(row)
  }
  return rows
}

export interface HeaderInfo {
  version: string
  /** e.g. "DeepSeek-V4.1-Flash with high effort". */
  model: string
  /** e.g. "DeepSeek account". */
  account: string | undefined
  cwd: string
  /** Dim line under the header, e.g. where the model came from. */
  note: string | undefined
}

export function Header({ info }: { info: HeaderInfo }) {
  const mascot = toHalfBlocks(WHALE, WHALE_COLORS)
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Box flexDirection="column" marginRight={2}>
          {mascot.map((row, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static art rows
            <Text key={index}>
              {row.map((span, column) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static art spans
                <Text key={column} color={span.color} backgroundColor={span.background}>
                  {span.text}
                </Text>
              ))}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column" justifyContent="center">
          <Text>
            <Text bold color={theme.brand}>
              deepcode
            </Text>
            <Text color={theme.muted}>{` v${info.version}`}</Text>
          </Text>
          <Text color={theme.muted}>
            {info.account !== undefined ? `${info.model} · ${info.account}` : info.model}
          </Text>
          <Text color={theme.muted}>{info.cwd}</Text>
        </Box>
      </Box>
      {info.note !== undefined ? (
        <Box marginTop={1}>
          <Text color={theme.muted}>{`│ ${info.note}`}</Text>
        </Box>
      ) : null}
    </Box>
  )
}
