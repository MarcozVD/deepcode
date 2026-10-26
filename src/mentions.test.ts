import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { setText } from './editor.js'
import {
  applyMention,
  currentMention,
  expandMentions,
  listFiles,
  matchFiles,
  mentionedPaths,
} from './mentions.js'

describe('mentions', () => {
  it('finds the @token under the cursor only at a word start', () => {
    expect(currentMention(setText('look at @src/ui'))).toEqual({ start: 8, query: 'src/ui' })
    expect(currentMention(setText('@'))).toEqual({ start: 0, query: '' })
    expect(currentMention(setText('mail me@x.com'))).toBeUndefined()
    expect(currentMention(setText('@done '))).toBeUndefined()
  })

  it('ranks basename prefix before path prefix before substring', () => {
    const files = ['src/ui.tsx', 'docs/ui-notes.md', 'src/build/guide.ts', 'ui/index.ts']
    expect(matchFiles(files, 'ui')).toEqual([
      'src/ui.tsx',
      'docs/ui-notes.md',
      'ui/index.ts',
      'src/build/guide.ts',
    ])
  })

  it('completes the mention and keeps the rest of the text', () => {
    const editor = { text: 'see @ui and more', cursor: 7 }
    expect(applyMention(editor, 'src/ui.tsx')).toEqual({
      text: 'see @src/ui.tsx  and more',
      cursor: 16,
    })
  })

  it('extracts mentioned paths without trailing punctuation', () => {
    expect(mentionedPaths('fix @a.ts, then @b/c.md. @a.ts')).toEqual(['a.ts', 'b/c.md'])
  })

  it('lists files skipping ignored folders and inlines small workspace files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deepcode-mentions-'))
    await mkdir(join(root, 'src'))
    await mkdir(join(root, 'node_modules'))
    await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1\n')
    await writeFile(join(root, 'node_modules', 'x.js'), 'ignored')
    expect(await listFiles(root)).toEqual(['src/a.ts'])

    const { prompt, attached } = await expandMentions('explain @src/a.ts and @missing.ts', root)
    expect(attached).toEqual(['src/a.ts'])
    expect(prompt).toContain('<file path="src/a.ts">\nexport const a = 1\n')
    const outside = await expandMentions('read @../secret.txt', root)
    expect(outside.attached).toEqual([])
  })
})
