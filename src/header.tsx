import { Box, Text } from 'ink'

import { theme } from './theme.js'

/**
 * The DeepSeek whale as pixels ('#' filled), rendered two pixel rows per
 * terminal row with half blocks, like Claude Code's mascot.
 */
export const WHALE = [
  '            ## ',
  '  #######  ##  ',
  ' ############  ',
  '## #########   ',
  '###########    ',
  ' ########      ',
]

/** Pixel rows → terminal rows using ▀ ▄ █. */
export function toHalfBlocks(pixels: string[]): string[] {
  const rows: string[] = []
  for (let top = 0; top < pixels.length; top += 2) {
    const upper = pixels[top] ?? ''
    const lower = pixels[top + 1] ?? ''
    const width = Math.max(upper.length, lower.length)
    let row = ''
    for (let column = 0; column < width; column += 1) {
      const a = upper[column] === '#'
      const b = lower[column] === '#'
      row += a && b ? '█' : a ? '▀' : b ? '▄' : ' '
    }
    rows.push(row.replace(/\s+$/, ''))
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
  const mascot = toHalfBlocks(WHALE)
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Box flexDirection="column" marginRight={2}>
          {mascot.map((row, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static art rows
            <Text key={index} color={theme.brand}>
              {row}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column">
          <Text>
            <Text bold>deepcode</Text>
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
