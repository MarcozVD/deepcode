import { describe, expect, it } from 'vitest'

import { toHalfBlocks, WHALE } from './header.js'

describe('toHalfBlocks', () => {
  it('packs two pixel rows into one terminal row', () => {
    expect(toHalfBlocks(['#.#', '##.'])).toEqual(['█▄▀'])
    expect(toHalfBlocks(['#'])).toEqual(['▀'])
  })

  it('renders the whale in three rows', () => {
    const rows = toHalfBlocks(WHALE)
    expect(rows).toHaveLength(3)
    expect(rows.join('')).toMatch(/█/)
  })
})
