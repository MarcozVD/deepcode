import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'

import { Markdown, parseInline, parseMarkdown } from './markdown.js'

describe('parseInline', () => {
  it('splits code, bold and links out of plain text', () => {
    expect(parseInline('run `pnpm test` **now**, see [docs](https://x.dev)')).toEqual([
      { kind: 'text', text: 'run ' },
      { kind: 'code', text: 'pnpm test' },
      { kind: 'text', text: ' ' },
      { kind: 'bold', text: 'now' },
      { kind: 'text', text: ', see ' },
      { kind: 'link', text: 'docs', url: 'https://x.dev' },
    ])
  })

  it('leaves unmatched markers alone', () => {
    expect(parseInline('a * b ` c')).toEqual([{ kind: 'text', text: 'a * b ` c' }])
  })
})

describe('parseMarkdown', () => {
  it('recognizes headings, bullets, numbered items and fenced code', () => {
    const blocks = parseMarkdown(
      '# Title\n\n- one\n  - nested\n2. two\n```ts\nconst a = 1\n```\nend',
    )
    expect(blocks.map((block) => block.kind)).toEqual([
      'heading',
      'blank',
      'bullet',
      'bullet',
      'bullet',
      'code',
      'paragraph',
    ])
    expect(blocks[3]).toMatchObject({ kind: 'bullet', indent: 1, marker: '•' })
    expect(blocks[4]).toMatchObject({ kind: 'bullet', marker: '2.' })
    expect(blocks[5]).toEqual({ kind: 'code', lang: 'ts', lines: ['const a = 1'] })
  })

  it('keeps an unclosed fence as code to the end', () => {
    expect(parseMarkdown('```\nhalf streamed')).toEqual([
      { kind: 'code', lang: '', lines: ['half streamed'] },
    ])
  })
})

describe('Markdown', () => {
  it('renders without the raw markers', () => {
    const frame = render(<Markdown text={'**Done.** Use `git stash`.\n- item'} />).lastFrame() ?? ''
    expect(frame).toContain('Done. Use git stash.')
    expect(frame).toContain('• item')
    expect(frame).not.toContain('**')
  })
})
