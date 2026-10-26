import { describe, expect, it } from 'vitest'

import { toHalfBlocks, WHALE, WHALE_COLORS } from './header.js'

const text = (row: { text: string }[]): string => row.map((span) => span.text).join('')

describe('toHalfBlocks', () => {
  it('packs two pixel rows into one terminal row', () => {
    const rows = toHalfBlocks(['a a', 'aa '], { a: 'blue' })
    expect(rows.map(text)).toEqual(['█▄▀'])
    expect(toHalfBlocks(['a'], { a: 'blue' }).map(text)).toEqual(['▀'])
  })

  it('draws two colors in one cell as foreground over background', () => {
    const [row] = toHalfBlocks(['a', 'b'], { a: 'blue', b: 'white' })
    expect(row).toEqual([{ text: '▀', color: 'blue', background: 'white' }])
  })

  it('merges runs of one color and trims trailing blanks', () => {
    const [row] = toHalfBlocks(['aa  '], { a: 'blue' })
    expect(row).toEqual([{ text: '▀▀', color: 'blue' }])
  })

  it('renders the whale in three rows, like the Claude Code mascot', () => {
    const rows = toHalfBlocks(WHALE, WHALE_COLORS)
    expect(rows).toHaveLength(3)
    expect(rows.map(text).join('')).toMatch(/█/)
  })
})
