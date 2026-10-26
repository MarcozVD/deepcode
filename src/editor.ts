/** Pure single-buffer line editor behind the prompt input. */
export interface EditorState {
  text: string
  /** Cursor offset into `text`, 0..text.length. */
  cursor: number
}

export const emptyEditor: EditorState = { text: '', cursor: 0 }

export function setText(text: string): EditorState {
  return { text, cursor: text.length }
}

/** Insert typed or pasted text; pasted CR/CRLF become newlines. */
export function insert(state: EditorState, raw: string): EditorState {
  const chunk = raw.replace(/\r\n?/g, '\n')
  const text = state.text.slice(0, state.cursor) + chunk + state.text.slice(state.cursor)
  return { text, cursor: state.cursor + chunk.length }
}

export function backspace(state: EditorState): EditorState {
  if (state.cursor === 0) return state
  return {
    text: state.text.slice(0, state.cursor - 1) + state.text.slice(state.cursor),
    cursor: state.cursor - 1,
  }
}

export function deleteForward(state: EditorState): EditorState {
  if (state.cursor >= state.text.length) return state
  return { ...state, text: state.text.slice(0, state.cursor) + state.text.slice(state.cursor + 1) }
}

export function moveLeft(state: EditorState): EditorState {
  return { ...state, cursor: Math.max(0, state.cursor - 1) }
}

export function moveRight(state: EditorState): EditorState {
  return { ...state, cursor: Math.min(state.text.length, state.cursor + 1) }
}

/** Start of the current line (Home / Ctrl+A). */
export function lineStart(state: EditorState): EditorState {
  return { ...state, cursor: state.text.lastIndexOf('\n', state.cursor - 1) + 1 }
}

/** End of the current line (End / Ctrl+E). */
export function lineEnd(state: EditorState): EditorState {
  const next = state.text.indexOf('\n', state.cursor)
  return { ...state, cursor: next === -1 ? state.text.length : next }
}

/** Previous word boundary (Ctrl+←, Meta+B). */
export function wordLeft(state: EditorState): EditorState {
  let index = state.cursor
  while (index > 0 && /\s/.test(state.text[index - 1] ?? '')) index -= 1
  while (index > 0 && !/\s/.test(state.text[index - 1] ?? '')) index -= 1
  return { ...state, cursor: index }
}

/** Next word boundary (Ctrl+→, Meta+F). */
export function wordRight(state: EditorState): EditorState {
  let index = state.cursor
  const length = state.text.length
  while (index < length && /\s/.test(state.text[index] ?? '')) index += 1
  while (index < length && !/\s/.test(state.text[index] ?? '')) index += 1
  return { ...state, cursor: index }
}

/** Delete the word before the cursor (Ctrl+W). */
export function deleteWordBefore(state: EditorState): EditorState {
  const target = wordLeft(state).cursor
  return {
    text: state.text.slice(0, target) + state.text.slice(state.cursor),
    cursor: target,
  }
}

/** Delete from the start of the line to the cursor (Ctrl+U). */
export function deleteToLineStart(state: EditorState): EditorState {
  const start = lineStart(state).cursor
  return { text: state.text.slice(0, start) + state.text.slice(state.cursor), cursor: start }
}

/** Text split around the cursor for rendering: before, the char under it, after. */
export function cursorParts(state: EditorState): { before: string; at: string; after: string } {
  const at = state.text[state.cursor]
  if (at === undefined || at === '\n') {
    return {
      before: state.text.slice(0, state.cursor),
      at: ' ',
      after: state.text.slice(state.cursor),
    }
  }
  return {
    before: state.text.slice(0, state.cursor),
    at,
    after: state.text.slice(state.cursor + 1),
  }
}
