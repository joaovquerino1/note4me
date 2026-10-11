/**
 * Document schema shared by the editor and the Markdown converter.
 *
 * Only nodes and marks that have a faithful Markdown representation are
 * enabled. Constructs without a native editor equivalent (raw HTML, footnote
 * references, math) are kept as "raw" nodes whose source is written back
 * verbatim, so nothing is silently dropped.
 */
import { Extension, Node, mergeAttributes, type AnyExtension } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import Image from '@tiptap/extension-image'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { common, createLowlight } from 'lowlight'

export const lowlight = createLowlight(common)

/** Block types that can appear at the top level and carry source info. */
export const TOP_LEVEL_TYPES = [
  'paragraph',
  'heading',
  'blockquote',
  'bulletList',
  'orderedList',
  'taskList',
  'codeBlock',
  'horizontalRule',
  'table',
  'rawBlock',
]

/** Resolves a Markdown image `src` (relative to the page) to a displayable URL. */
let assetResolver: (src: string) => string = (src) => src
export function setAssetResolver(fn: (src: string) => string) {
  assetResolver = fn
}
export function resolveAsset(src: string) {
  return assetResolver(src)
}

const notRendered = { rendered: false, keepOnSplit: false, default: null }

/**
 * Attributes that never reach the DOM:
 * - `mdsrc` / `mdgap` / `mdfp`: original source of a top-level block, the
 *   whitespace/definitions after it, and a fingerprint of its parsed form.
 *   Unchanged blocks are written back from `mdsrc` byte for byte.
 * - list `tight`, `bullet`; rule and emphasis `markup`: formatting details
 *   used when a block has to be re-serialised.
 */
const SourceAttributes = Extension.create({
  name: 'sourceAttributes',
  addGlobalAttributes() {
    return [
      { types: TOP_LEVEL_TYPES, attributes: { mdsrc: notRendered, mdgap: notRendered, mdfp: notRendered } },
      {
        types: ['bulletList', 'orderedList', 'taskList'],
        attributes: { tight: { rendered: false, default: true }, bullet: { rendered: false, default: null } },
      },
      { types: ['horizontalRule', 'italic', 'bold', 'orderedList'], attributes: { markup: { rendered: false, default: null } } },
      {
        types: ['tableCell', 'tableHeader'],
        attributes: {
          align: {
            default: null,
            parseHTML: (el: HTMLElement) => el.style.textAlign || null,
            renderHTML: (attrs: Record<string, unknown>) => (attrs.align ? { style: `text-align: ${attrs.align}` } : {}),
          },
        },
      },
    ]
  },
})

/** Verbatim block (HTML blocks, comments). Editable as plain text. */
export const RawBlock = Node.create({
  name: 'rawBlock',
  group: 'block',
  content: 'text*',
  marks: '',
  code: true,
  defining: true,
  parseHTML: () => [{ tag: 'pre[data-raw-block]', preserveWhitespace: 'full' }],
  renderHTML: ({ HTMLAttributes }) => [
    'pre',
    mergeAttributes(HTMLAttributes, { 'data-raw-block': '', class: 'raw-block', 'aria-label': 'Bloco Markdown/HTML preservado' }),
    ['code', 0],
  ],
})

/** Verbatim inline source: inline HTML, footnote refs, math. */
export const RawInline = Node.create({
  name: 'rawInline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({ source: { default: '' } }),
  parseHTML: () => [{ tag: 'code[data-raw-inline]', getAttrs: (el) => ({ source: (el as HTMLElement).textContent ?? '' }) }],
  renderHTML: ({ node }) => ['code', { 'data-raw-inline': '', class: 'raw-inline', title: 'Sintaxe preservada sem edição visual' }, node.attrs.source],
})

/** `[[Página]]` / `[[Página|apelido]]` links (Obsidian-compatible). */
export const WikiLink = Node.create({
  name: 'wikiLink',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({ target: { default: '' }, alias: { default: null } }),
  parseHTML: () => [
    {
      tag: 'a[data-wikilink]',
      getAttrs: (el) => ({ target: (el as HTMLElement).dataset.target ?? '', alias: (el as HTMLElement).dataset.alias ?? null }),
    },
  ],
  renderHTML: ({ node }) => [
    'a',
    {
      'data-wikilink': '',
      'data-target': node.attrs.target,
      ...(node.attrs.alias ? { 'data-alias': node.attrs.alias } : {}),
      class: 'wikilink',
      href: '#',
    },
    node.attrs.alias || node.attrs.target,
  ],
})

const PortableImage = Image.extend({
  renderHTML({ HTMLAttributes }) {
    const src = String(HTMLAttributes.src ?? '')
    return ['img', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { src: resolveAsset(src), 'data-src': src, loading: 'lazy' })]
  },
  parseHTML() {
    return [{ tag: 'img[src]', getAttrs: (el) => ({ src: (el as HTMLElement).dataset.src ?? (el as HTMLImageElement).getAttribute('src') }) }]
  },
}).configure({ inline: true, allowBase64: false })

/** The node/mark set. Behavioural extensions are added by the editor. */
export function contentExtensions(): AnyExtension[] {
  return [
    StarterKit.configure({
      codeBlock: false,
      underline: false, // no Markdown equivalent
      link: { openOnClick: false, autolink: true, linkOnPaste: true, HTMLAttributes: { rel: null, target: null } },
      trailingNode: false,
    }),
    CodeBlockLowlight.configure({ lowlight, defaultLanguage: null }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
    PortableImage,
    RawBlock,
    RawInline,
    WikiLink,
    SourceAttributes,
  ]
}
