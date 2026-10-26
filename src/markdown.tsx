import { Box, Text } from 'ink'

/** Minimal Markdown for terminal output: enough for typical agent replies. */

export type Span =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'link'; text: string; url: string }

export type Block =
  | { kind: 'paragraph'; spans: Span[] }
  | { kind: 'heading'; level: number; spans: Span[] }
  | { kind: 'bullet'; marker: string; indent: number; spans: Span[] }
  | { kind: 'code'; lang: string; lines: string[] }
  | { kind: 'blank' }

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\([^)\s]+\))/g

export function parseInline(line: string): Span[] {
  const spans: Span[] = []
  let last = 0
  for (const match of line.matchAll(INLINE)) {
    const index = match.index ?? 0
    if (index > last) spans.push({ kind: 'text', text: line.slice(last, index) })
    const token = match[0]
    if (match[1] !== undefined) spans.push({ kind: 'code', text: token.slice(1, -1) })
    else if (match[2] !== undefined) spans.push({ kind: 'bold', text: token.slice(2, -2) })
    else {
      const close = token.indexOf('](')
      spans.push({ kind: 'link', text: token.slice(1, close), url: token.slice(close + 2, -1) })
    }
    last = index + token.length
  }
  if (last < line.length) spans.push({ kind: 'text', text: line.slice(last) })
  return spans
}

export function parseMarkdown(text: string): Block[] {
  const blocks: Block[] = []
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const fence = /^\s*```\s*([\w+-]*)\s*$/.exec(line)
    if (fence !== null) {
      const code: string[] = []
      index += 1
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index] ?? '')) {
        code.push(lines[index] ?? '')
        index += 1
      }
      blocks.push({ kind: 'code', lang: fence[1] ?? '', lines: code })
      continue
    }
    if (line.trim() === '') {
      if (blocks.at(-1)?.kind !== 'blank') blocks.push({ kind: 'blank' })
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null) {
      blocks.push({
        kind: 'heading',
        level: heading[1]?.length ?? 1,
        spans: parseInline(heading[2] ?? ''),
      })
      continue
    }
    const bullet = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (bullet !== null) {
      const marker = /^\d/.test(bullet[2] ?? '') ? (bullet[2] ?? '') : '•'
      blocks.push({
        kind: 'bullet',
        marker,
        indent: Math.floor((bullet[1]?.length ?? 0) / 2),
        spans: parseInline(bullet[3] ?? ''),
      })
      continue
    }
    blocks.push({ kind: 'paragraph', spans: parseInline(line) })
  }
  while (blocks.at(-1)?.kind === 'blank') blocks.pop()
  return blocks
}

function Spans({ spans }: { spans: Span[] }) {
  return (
    <>
      {spans.map((span, index) => {
        const key = `${index}:${span.kind}`
        switch (span.kind) {
          case 'code':
            return (
              <Text key={key} color="cyan">
                {span.text}
              </Text>
            )
          case 'bold':
            return (
              <Text key={key} bold>
                {span.text}
              </Text>
            )
          case 'link':
            return (
              <Text key={key}>
                <Text underline>{span.text}</Text>
                <Text color="gray">{` (${span.url})`}</Text>
              </Text>
            )
          default:
            return <Text key={key}>{span.text}</Text>
        }
      })}
    </>
  )
}

export function Markdown({ text }: { text: string }) {
  const blocks = parseMarkdown(text)
  return (
    <Box flexDirection="column" flexShrink={1}>
      {blocks.map((block, index) => {
        const key = `${index}:${block.kind}`
        switch (block.kind) {
          case 'blank':
            return <Text key={key}> </Text>
          case 'heading':
            return (
              <Text key={key} bold underline={block.level === 1}>
                <Spans spans={block.spans} />
              </Text>
            )
          case 'bullet':
            return (
              <Text key={key}>
                {`${'  '.repeat(block.indent)}${block.marker} `}
                <Spans spans={block.spans} />
              </Text>
            )
          case 'code':
            return (
              <Box key={key} flexDirection="column" paddingLeft={1}>
                {block.lines.map((line, lineIndex) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: code lines are static
                  <Text key={lineIndex} color="yellow">
                    <Text color="gray">│ </Text>
                    {line}
                  </Text>
                ))}
              </Box>
            )
          default:
            return (
              <Text key={key}>
                <Spans spans={block.spans} />
              </Text>
            )
        }
      })}
    </Box>
  )
}
