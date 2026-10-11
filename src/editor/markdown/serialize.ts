/**
 * Editor document → Markdown.
 *
 * Blocks whose content is unchanged since parsing are emitted from their
 * original source. Changed or new blocks are serialised in a conventional
 * style: ATX headings, `-` bullets (or the list's original marker), fenced
 * code, GFM tables and task lists.
 */
import { MarkdownSerializer, type MarkdownSerializerState } from 'prosemirror-markdown'
import type { Mark, Node as PMNode } from '@tiptap/pm/model'
import { fingerprint } from './fingerprint'

type State = MarkdownSerializerState & { inAutolink?: boolean; inTable?: boolean }

function backticksFor(node: PMNode, side: number) {
  const ticks = /`+/g
  let m: RegExpExecArray | null
  let len = 0
  if (node.isText) while ((m = ticks.exec(node.text!))) len = Math.max(len, m[0].length)
  let result = len > 0 && side > 0 ? ' `' : '`'
  for (let i = 0; i < len; i++) result += '`'
  if (len > 0 && side < 0) result += ' '
  return result
}

function linkDest(href: string) {
  if (/[\s<>]/.test(href)) return `<${href.replace(/[<>]/g, (c) => encodeURIComponent(c))}>`
  return href.replace(/[()]/g, '\\$&')
}

function isPlainUrl(link: Mark, parent: PMNode, index: number) {
  if (link.attrs.title || !/^\w+:/.test(link.attrs.href)) return false
  const content = parent.child(index)
  if (!content.isText || content.text !== link.attrs.href || content.marks[content.marks.length - 1] !== link) return false
  return index === parent.childCount - 1 || !link.isInSet(parent.child(index + 1).marks)
}

function fenceFor(text: string) {
  let longest = 0
  for (const m of text.matchAll(/`{3,}/g)) longest = Math.max(longest, m[0].length)
  return '`'.repeat(Math.max(3, longest + 1))
}

let serializer: MarkdownSerializer

/** Renders a table cell's paragraphs as single-line GFM cell content. */
function cellText(cell: PMNode): string {
  const parts: string[] = []
  cell.forEach((child) => {
    const doc = cell.type.schema.topNodeType.create(null, [child.type.name === 'paragraph' ? child : cell.type.schema.nodes.paragraph!.create(null, child.content)])
    parts.push(serializer.serialize(doc, { tightLists: true }).trim())
  })
  return parts
    .join('<br>')
    .replace(/\\\n/g, '<br>')
    .replace(/\n/g, ' ')
    .replace(/(^|[^\\])\|/g, '$1\\|')
}

serializer = new MarkdownSerializer(
  {
    doc(state, node) {
      state.renderContent(node)
    },
    paragraph(state, node) {
      state.renderInline(node)
      state.closeBlock(node)
    },
    heading(state, node) {
      state.write(`${'#'.repeat(node.attrs.level)} `)
      state.renderInline(node, false)
      state.closeBlock(node)
    },
    blockquote(state, node) {
      state.wrapBlock('> ', null, node, () => state.renderContent(node))
    },
    codeBlock(state, node) {
      const fence = fenceFor(node.textContent)
      state.write(fence + (node.attrs.language || '') + '\n')
      state.text(node.textContent, false)
      state.write('\n')
      state.write(fence)
      state.closeBlock(node)
    },
    rawBlock(state, node) {
      state.text(node.textContent, false)
      state.closeBlock(node)
    },
    horizontalRule(state, node) {
      state.write(node.attrs.markup || '---')
      state.closeBlock(node)
    },
    bulletList(state, node) {
      state.renderList(node, '  ', () => `${node.attrs.bullet || '-'} `)
    },
    taskList(state, node) {
      state.renderList(node, '  ', () => `${node.attrs.bullet || '-'} `)
    },
    orderedList(state, node) {
      const start = node.attrs.start || 1
      const maxW = String(start + node.childCount - 1).length
      const space = ' '.repeat(maxW + 2)
      state.renderList(node, space, (i) => {
        const n = String(start + i)
        return `${' '.repeat(maxW - n.length)}${n}${node.attrs.markup === ')' ? ')' : '.'} `
      })
    },
    listItem(state, node) {
      state.renderContent(node)
    },
    taskItem(state, node) {
      state.write(node.attrs.checked ? '[x] ' : '[ ] ')
      state.renderContent(node)
    },
    image(state, node) {
      state.write(
        `![${state.esc(node.attrs.alt || '')}](${linkDest(node.attrs.src || '')}${node.attrs.title ? ` "${String(node.attrs.title).replace(/"/g, '\\"')}"` : ''})`,
      )
    },
    hardBreak(state, node, parent, index) {
      for (let i = index + 1; i < parent.childCount; i++) {
        if (parent.child(i).type !== node.type) {
          state.write((state as State).inTable ? '<br>' : '\\\n')
          return
        }
      }
    },
    rawInline(state, node) {
      state.write(node.attrs.source)
    },
    wikiLink(state, node) {
      state.write(`[[${node.attrs.target}${node.attrs.alias ? `|${node.attrs.alias}` : ''}]]`)
    },
    text(state, node) {
      state.text(node.text!, !(state as State).inAutolink)
    },
    table(state, node) {
      const rows: string[][] = []
      const aligns: (string | null)[] = []
      node.forEach((row, _o, r) => {
        const cells: string[] = []
        row.forEach((cell, _o2, c) => {
          cells.push(cellText(cell))
          if (r === 0) aligns[c] = cell.attrs.align ?? null
        })
        rows.push(cells)
      })
      const width = Math.max(...rows.map((r) => r.length))
      const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`
      const sep = Array.from({ length: width }, (_, i) => {
        const a = aligns[i]
        return a === 'center' ? ':---:' : a === 'right' ? '---:' : a === 'left' ? ':---' : '---'
      })
      const out = [line(rows[0] ?? []), `| ${sep.join(' | ')} |`, ...rows.slice(1).map(line)]
      state.write(out.join('\n'))
      state.closeBlock(node)
    },
  },
  {
    italic: {
      open: (_s, mark) => mark.attrs.markup || '*',
      close: (_s, mark) => mark.attrs.markup || '*',
      mixable: true,
      expelEnclosingWhitespace: true,
    },
    bold: {
      open: (_s, mark) => mark.attrs.markup || '**',
      close: (_s, mark) => mark.attrs.markup || '**',
      mixable: true,
      expelEnclosingWhitespace: true,
    },
    strike: { open: '~~', close: '~~', mixable: true, expelEnclosingWhitespace: true },
    link: {
      open(state, mark, parent, index) {
        ;(state as State).inAutolink = isPlainUrl(mark, parent, index)
        return (state as State).inAutolink ? '<' : '['
      },
      close(state, mark) {
        const auto = (state as State).inAutolink
        ;(state as State).inAutolink = undefined
        if (auto) return '>'
        const title = mark.attrs.title ? ` "${String(mark.attrs.title).replace(/"/g, '\\"')}"` : ''
        return `](${linkDest(mark.attrs.href || '')}${title})`
      },
      mixable: true,
    },
    code: {
      open: (_s, _m, parent, index) => backticksFor(parent.child(index), -1),
      close: (_s, _m, parent, index) => backticksFor(parent.child(index - 1), 1),
      escape: false,
    },
  },
  { hardBreakNodeName: 'hardBreak', strict: true },
)

const LISTS = new Set(['bulletList', 'taskList', 'orderedList'])

function marker(node: PMNode): string {
  return node.type.name === 'orderedList' ? (node.attrs.markup === ')' ? ')' : '.') : node.attrs.bullet || '-'
}

/**
 * Adjacent lists of the same kind and marker would merge into one list in
 * Markdown; switch the marker of the second so they stay separate.
 */
function separateFrom(prev: PMNode | null, node: PMNode): PMNode {
  if (!prev || !LISTS.has(node.type.name) || (prev.type.name === 'orderedList') !== (node.type.name === 'orderedList')) return node
  if (!LISTS.has(prev.type.name) || marker(prev) !== marker(node)) return node
  const attrs = node.type.name === 'orderedList'
    ? { ...node.attrs, markup: marker(prev) === ')' ? '.' : ')' }
    : { ...node.attrs, bullet: marker(prev) === '-' ? '*' : '-' }
  return node.type.create(attrs, node.content, node.marks)
}

/** Serialises a single block in the conventional style. */
export function serializeBlock(node: PMNode): string {
  const doc = node.type.schema.topNodeType.create(null, [node])
  return serializer.serialize(doc, { tightLists: true })
}

function isEmptyParagraph(node: PMNode) {
  return node.type.name === 'paragraph' && node.childCount === 0
}

export function serializeMarkdown(doc: PMNode, prefix = ''): string {
  let out = prefix
  const count = doc.childCount
  // Trailing empty paragraphs are an editing affordance, not content.
  let last = count - 1
  while (last >= 0 && isEmptyParagraph(doc.child(last)) && doc.child(last).attrs.mdsrc == null) last--
  for (let i = 0; i <= last; i++) {
    const node = doc.child(i)
    const src = node.attrs.mdsrc as string | null
    const gap = (node.attrs.mdgap as string | null) ?? null
    const unchanged = src != null && node.attrs.mdfp === fingerprint(node)
    if (unchanged) {
      out += src + (gap ?? '')
      continue
    }
    // A re-serialised block must be separated from its neighbours by a
    // blank line so it cannot merge into them.
    if (out.length > 0 && !out.endsWith('\n\n')) out += out.endsWith('\n') ? '\n' : '\n\n'
    if (isEmptyParagraph(node)) {
      continue
    }
    out += serializeBlock(separateFrom(i > 0 ? doc.child(i - 1) : null, node)).replace(/\n+$/, '') + '\n'
    if (gap && gap.trim() !== '') {
      // Reference definitions etc. that followed the block are kept.
      out += '\n' + gap.replace(/^\n*/, '')
    } else if (gap && gap.includes('\n')) {
      out += gap
    } else if (i < last) {
      out += '\n'
    }
  }
  return out
}
