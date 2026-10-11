/**
 * markdown-it configured for note4me: CommonMark + GFM tables, task lists and
 * strikethrough, plus rules that turn syntax the visual editor cannot model
 * (footnotes, math, Obsidian embeds) into verbatim "raw" tokens.
 */
import MarkdownIt from 'markdown-it'
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs'
import type StateBlock from 'markdown-it/lib/rules_block/state_block.mjs'
import type StateCore from 'markdown-it/lib/rules_core/state_core.mjs'
import type Token from 'markdown-it/lib/token.mjs'

function pushRaw(state: StateInline, source: string) {
  const t = state.push('raw_inline', '', 0)
  t.content = source
}

/** `[[Página]]`, `[[Página|apelido]]`, and `![[embed]]` (kept raw). */
function wikilink(state: StateInline, silent: boolean): boolean {
  const src = state.src
  let pos = state.pos
  const embed = src.charCodeAt(pos) === 0x21 /* ! */
  if (embed) pos++
  if (src.charCodeAt(pos) !== 0x5b || src.charCodeAt(pos + 1) !== 0x5b) return false
  const close = src.indexOf(']]', pos + 2)
  if (close < 0) return false
  const inner = src.slice(pos + 2, close)
  if (!inner.trim() || /[\[\]\n]/.test(inner)) return false
  if (!silent) {
    if (embed) {
      pushRaw(state, src.slice(state.pos, close + 2))
    } else {
      const bar = inner.indexOf('|')
      const t = state.push('wikilink', '', 0)
      t.meta = bar >= 0 ? { target: inner.slice(0, bar), alias: inner.slice(bar + 1) } : { target: inner, alias: null }
    }
  }
  state.pos = close + 2
  return true
}

/** Footnote references `[^1]` stay verbatim (also covers definitions' labels). */
function footnoteRef(state: StateInline, silent: boolean): boolean {
  const src = state.src
  if (src.charCodeAt(state.pos) !== 0x5b || src.charCodeAt(state.pos + 1) !== 0x5e) return false
  const m = /^\[\^[^\]\s]+\]/.exec(src.slice(state.pos))
  if (!m) return false
  if (!silent) pushRaw(state, m[0])
  state.pos += m[0].length
  return true
}

/** `$inline$` and `$$display$$` math, kept verbatim. */
function math(state: StateInline, silent: boolean): boolean {
  const src = state.src
  const start = state.pos
  if (src.charCodeAt(start) !== 0x24 /* $ */) return false
  if (start > 0 && src.charCodeAt(start - 1) === 0x5c /* \ */) return false
  const display = src.charCodeAt(start + 1) === 0x24
  const delim = display ? '$$' : '$'
  const from = start + delim.length
  if (!display && (from >= src.length || /\s|\d/.test(src[from]!))) return false
  let end = src.indexOf(delim, from)
  while (end >= 0 && src.charCodeAt(end - 1) === 0x5c) end = src.indexOf(delim, end + 1)
  if (end < 0 || end === from) return false
  if (!display) {
    if (/\s/.test(src[end - 1]!)) return false
    if (/\d/.test(src[end + 1] ?? '')) return false
    if (src.slice(from, end).includes('\n')) return false
  }
  if (!silent) pushRaw(state, src.slice(start, end + delim.length))
  state.pos = end + delim.length
  return true
}

/** Footnote definitions become raw blocks so they stay visible and intact. */
function footnoteDef(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  const lineText = (l: number) => state.src.slice(state.bMarks[l]! + state.tShift[l]!, state.eMarks[l])
  if (state.sCount[startLine]! - state.blkIndent >= 4) return false
  if (!/^\[\^[^\]\s]+\]:/.test(lineText(startLine))) return false
  if (silent) return true
  let next = startLine + 1
  while (next < endLine) {
    const indented = state.sCount[next]! - state.blkIndent >= 4
    const blank = state.isEmpty(next)
    if (blank) {
      // A blank line continues the definition only if indented text follows.
      if (next + 1 < endLine && state.sCount[next + 1]! - state.blkIndent >= 4 && !state.isEmpty(next + 1)) {
        next++
        continue
      }
      break
    }
    if (!indented) break
    next++
  }
  const t = state.push('html_block', '', 0)
  t.map = [startLine, next]
  t.content = state.getLines(startLine, next, state.blkIndent, true)
  state.line = next
  return true
}

const TASK_RE = /^\[([ xX])\](?=\s|$)\s?/

function stripPrefix(inline: Token, n: number) {
  inline.content = inline.content.slice(n)
  let left = n
  const kids = inline.children ?? []
  while (left > 0 && kids.length) {
    const k = kids[0]!
    if (k.type !== 'text') break
    if (k.content.length <= left) {
      left -= k.content.length
      kids.shift()
    } else {
      k.content = k.content.slice(left)
      left = 0
    }
  }
}

/** Converts bullet lists whose items all start with `[ ]`/`[x]` into task lists. */
function taskLists(state: StateCore) {
  const tokens = state.tokens
  for (let i = 0; i < tokens.length; i++) {
    const open = tokens[i]!
    if (open.type !== 'bullet_list_open') continue
    const level = open.level
    let close = i + 1
    while (close < tokens.length && !(tokens[close]!.type === 'bullet_list_close' && tokens[close]!.level === level)) close++
    const items: { open: number; inline: number | null }[] = []
    for (let j = i + 1; j < close; j++) {
      const t = tokens[j]!
      if (t.type === 'list_item_open' && t.level === level + 1) {
        const p = tokens[j + 1]
        const inl = tokens[j + 2]
        items.push({ open: j, inline: p?.type === 'paragraph_open' && inl?.type === 'inline' ? j + 2 : null })
      }
    }
    if (!items.length || !items.every((it) => it.inline !== null && TASK_RE.test(tokens[it.inline]!.content))) continue
    open.type = 'task_list_open'
    tokens[close]!.type = 'task_list_close'
    for (const it of items) {
      const inl = tokens[it.inline!]!
      const m = TASK_RE.exec(inl.content)!
      const itemOpen = tokens[it.open]!
      itemOpen.type = 'task_item_open'
      itemOpen.meta = { checked: m[1] !== ' ' }
      stripPrefix(inl, m[0].length)
      // Find the matching close for this item.
      for (let k = it.open + 1; k < close; k++) {
        const t = tokens[k]!
        if (t.type === 'list_item_close' && t.level === itemOpen.level) {
          t.type = 'task_item_close'
          break
        }
      }
    }
  }
}

/** Table cells hold inline content in Markdown but paragraphs in the editor. */
function tableCellParagraphs(state: StateCore) {
  const out: Token[] = []
  const tokens = state.tokens
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    out.push(t)
    if ((t.type === 'th_open' || t.type === 'td_open') && tokens[i + 1]?.type === 'inline') {
      const p = new state.Token('paragraph_open', 'p', 1)
      p.level = t.level + 1
      const inline = tokens[i + 1]!
      const pc = new state.Token('paragraph_close', 'p', -1)
      pc.level = t.level + 1
      out.push(p, inline, pc)
      i++
    }
  }
  state.tokens = out
}

export function createTokenizer(): MarkdownIt {
  const md = MarkdownIt('commonmark', { html: true, linkify: false, typographer: false }).enable(['table', 'strikethrough'])
  // Keep destinations exactly as written: no percent-encoding on read, so
  // re-serialised links stay identical to the source.
  md.normalizeLink = (url: string) => url
  md.normalizeLinkText = (text: string) => text
  md.inline.ruler.before('link', 'note4me_wikilink', wikilink)
  md.inline.ruler.before('link', 'note4me_footnote_ref', footnoteRef)
  md.inline.ruler.before('escape', 'note4me_math', math)
  md.block.ruler.before('reference', 'note4me_footnote_def', footnoteDef, { alt: ['paragraph', 'reference'] })
  md.core.ruler.after('inline', 'note4me_tasks', taskLists)
  md.core.ruler.after('note4me_tasks', 'note4me_table_cells', tableCellParagraphs)
  return md
}
