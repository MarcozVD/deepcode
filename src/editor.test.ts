import { describe, expect, it } from 'vitest'

import {
  backspace,
  cursorParts,
  deleteForward,
  deleteToLineStart,
  deleteWordBefore,
  emptyEditor,
  insert,
  lineEnd,
  lineStart,
  moveLeft,
  moveRight,
  setText,
  wordLeft,
  wordRight,
} from './editor.js'

describe('editor', () => {
  it('inserts at the cursor, not only at the end', () => {
    let state = setText('helo')
    state = moveLeft(state)
    state = insert(state, 'l')
    expect(state).toEqual({ text: 'hello', cursor: 4 })
  })

  it('turns pasted CR and CRLF into newlines', () => {
    expect(insert(emptyEditor, 'a\r\nb\rc').text).toBe('a\nb\nc')
  })

  it('deletes backward and forward around the cursor', () => {
    const state = moveLeft(setText('abc'))
    expect(backspace(state)).toEqual({ text: 'ac', cursor: 1 })
    expect(deleteForward(state)).toEqual({ text: 'ab', cursor: 2 })
    expect(backspace({ text: 'x', cursor: 0 })).toEqual({ text: 'x', cursor: 0 })
  })

  it('clamps cursor movement', () => {
    expect(moveLeft({ text: 'a', cursor: 0 }).cursor).toBe(0)
    expect(moveRight(setText('a')).cursor).toBe(1)
  })

  it('jumps to line start and end in multi-line text', () => {
    const state = { text: 'one\ntwo three\nfour', cursor: 6 }
    expect(lineStart(state).cursor).toBe(4)
    expect(lineEnd(state).cursor).toBe(13)
  })

  it('moves and deletes by words', () => {
    const state = setText('git commit  -m')
    expect(wordLeft(state).cursor).toBe(12)
    expect(wordRight({ text: state.text, cursor: 0 }).cursor).toBe(3)
    expect(deleteWordBefore(state)).toEqual({ text: 'git commit  ', cursor: 12 })
    expect(deleteToLineStart({ text: 'a\nbcd', cursor: 4 })).toEqual({ text: 'a\nd', cursor: 2 })
  })

  it('splits text around the cursor for rendering', () => {
    expect(cursorParts({ text: 'abc', cursor: 1 })).toEqual({ before: 'a', at: 'b', after: 'c' })
    expect(cursorParts(setText('ab'))).toEqual({ before: 'ab', at: ' ', after: '' })
    expect(cursorParts({ text: 'a\nb', cursor: 1 })).toEqual({ before: 'a', at: ' ', after: '\nb' })
  })
})
