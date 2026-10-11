/**
 * Markdown → editor document.
 *
 * Each top-level block remembers the exact source lines it came from
 * (`mdsrc`), the text between it and the next block (`mdgap`, which also
 * holds link reference definitions) and a fingerprint of its parsed form
 * (`mdfp`). The serializer writes unchanged blocks back from `mdsrc`, so
 * opening and saving never reformats content the user did not touch.
 */
import { MarkdownParser } from 'prosemirror-markdown'
import type { Node as PMNode, Schema } from '@tiptap/pm/model'
import type Token from 'markdown-it/lib/token.mjs'
import { createTokenizer } from './tokenizer'
import { fingerprint } from './fingerprint'

const md = createTokenizer()

function listIsTight(tokens: readonly Token[], i: number) {
  while (++i < tokens.length) {
    const t = tokens[i]!
    if (t.type !== 'list_item_open' && t.type !== 'task_item_open') return t.hidden
  }
  return false
}

function cellAlign(tok: Token) {
  const style = tok.attrGet('style') ?? ''
  const m = /text-align:\s*(left|right|center)/.exec(style)
  return { align: m ? m[1] : null }
}

const parsers = new WeakMap<Schema, { parser: MarkdownParser; last: { tokens: Token[] } }>()

function parserFor(schema: Schema) {
  const cached = parsers.get(schema)
  if (cached) return cached
  const last = { tokens: [] as Token[] }
  const tokenizer = {
    parse(src: string, env: object) {
      last.tokens = md.parse(src, env)
      return last.tokens
    },
  }
  const parser = new MarkdownParser(schema, tokenizer as never, {
    blockquote: { block: 'blockquote' },
    paragraph: { block: 'paragraph' },
    list_item: { block: 'listItem' },
    task_item: { block: 'taskItem', getAttrs: (tok) => ({ checked: Boolean(tok.meta?.checked) }) },
    bullet_list: { block: 'bulletList', getAttrs: (tok, tokens, i) => ({ tight: listIsTight(tokens, i), bullet: tok.markup || null }) },
    task_list: { block: 'taskList', getAttrs: (tok, tokens, i) => ({ tight: listIsTight(tokens, i), bullet: tok.markup || null }) },
    ordered_list: {
      block: 'orderedList',
      getAttrs: (tok, tokens, i) => ({ start: Number(tok.attrGet('start')) || 1, tight: listIsTight(tokens, i), markup: tok.markup || null }),
    },
    heading: { block: 'heading', getAttrs: (tok) => ({ level: Number(tok.tag.slice(1)) }) },
    code_block: { block: 'codeBlock', noCloseToken: true },
    fence: { block: 'codeBlock', getAttrs: (tok) => ({ language: tok.info.trim().split(/\s+/)[0] || null }), noCloseToken: true },
    html_block: { block: 'rawBlock', noCloseToken: true },
    hr: { node: 'horizontalRule', getAttrs: (tok) => ({ markup: tok.markup || null }) },
    image: {
      node: 'image',
      getAttrs: (tok) => ({ src: tok.attrGet('src'), title: tok.attrGet('title') || null, alt: tok.children?.map((c) => c.content).join('') || null }),
    },
    hardbreak: { node: 'hardBreak' },
    html_inline: { node: 'rawInline', getAttrs: (tok) => ({ source: tok.content }) },
    raw_inline: { node: 'rawInline', getAttrs: (tok) => ({ source: tok.content }) },
    wikilink: { node: 'wikiLink', getAttrs: (tok) => ({ target: tok.meta.target, alias: tok.meta.alias }) },
    em: { mark: 'italic', getAttrs: (tok) => ({ markup: tok.markup || null }) },
    strong: { mark: 'bold', getAttrs: (tok) => ({ markup: tok.markup || null }) },
    s: { mark: 'strike' },
    link: { mark: 'link', getAttrs: (tok) => ({ href: tok.attrGet('href'), title: tok.attrGet('title') || null }) },
    code_inline: { mark: 'code', noCloseToken: true },
    table: { block: 'table' },
    thead: { ignore: true },
    tbody: { ignore: true },
    tr: { block: 'tableRow' },
    th: { block: 'tableHeader', getAttrs: cellAlign },
    td: { block: 'tableCell', getAttrs: cellAlign },
  })
  const entry = { parser, last }
  parsers.set(schema, entry)
  return entry
}

export interface ParsedDoc {
  doc: PMNode
  /** Text before the first block (blank lines, reference definitions). */
  prefix: string
  /** Whether per-block source preservation could be set up. */
  preserved: boolean
}

function lineOffsets(src: string): number[] {
  const offsets = [0]
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) offsets.push(i + 1)
  return offsets
}

export function parseMarkdown(schema: Schema, body: string): ParsedDoc {
  const { parser, last } = parserFor(schema)
  const parsed = parser.parse(body)
  const tops = last.tokens.filter((t) => t.block && t.level === 0 && t.nesting !== -1 && t.map)
  const offsets = lineOffsets(body)
  const at = (line: number) => (line < offsets.length ? offsets[line]! : body.length)
  if (tops.length === 0) {
    // Whitespace-only (or empty) document.
    return { doc: parsed, prefix: body.trim() === '' ? body : '', preserved: body.trim() === '' }
  }
  if (tops.length !== parsed.childCount) {
    return { doc: parsed, prefix: '', preserved: false }
  }
  const children: PMNode[] = []
  parsed.forEach((node, _offset, i) => {
    const [start, end] = tops[i]!.map!
    const nextStart = i + 1 < tops.length ? tops[i + 1]!.map![0] : Number.MAX_SAFE_INTEGER
    const src = body.slice(at(start), at(end))
    const gap = body.slice(at(end), at(nextStart))
    const attrs = { ...node.attrs, mdsrc: src, mdgap: gap, mdfp: fingerprint(node) }
    children.push(node.type.create(attrs, node.content, node.marks))
  })
  const doc = schema.topNodeType.create(parsed.attrs, children)
  return { doc, prefix: body.slice(0, at(tops[0]!.map![0])), preserved: true }
}
