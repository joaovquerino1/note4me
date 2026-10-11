/**
 * Suggestion popups (slash commands and `[[` page links) built on
 * @tiptap/suggestion. Popup state lives in a tiny store rendered by
 * <SuggestionPopup/>; keyboard handling stays inside the editor.
 */
import { Extension, type Editor, type Range } from '@tiptap/core'
import Suggestion, { type SuggestionKeyDownProps } from '@tiptap/suggestion'
import { PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { Plugin } from '@tiptap/pm/state'
import { create } from 'zustand'

export interface SuggestItem {
  id: string
  title: string
  subtitle?: string
  icon?: string
  keywords?: string
  run: (editor: Editor, range: Range) => void | Promise<void>
}

interface PopupState {
  kind: 'slash' | 'link' | null
  items: SuggestItem[]
  active: number
  rect: DOMRect | null
  command: ((item: SuggestItem) => void) | null
}

export const usePopup = create<PopupState>(() => ({ kind: null, items: [], active: 0, rect: null, command: null }))

function popupRender(kind: 'slash' | 'link') {
  return () => ({
    onStart: (props: { items: SuggestItem[]; clientRect?: (() => DOMRect | null) | null; command: (item: SuggestItem) => void }) => {
      usePopup.setState({ kind, items: props.items, active: 0, rect: props.clientRect?.() ?? null, command: props.command })
    },
    onUpdate: (props: { items: SuggestItem[]; clientRect?: (() => DOMRect | null) | null; command: (item: SuggestItem) => void }) => {
      usePopup.setState((s) => ({ items: props.items, active: Math.min(s.active, Math.max(0, props.items.length - 1)), rect: props.clientRect?.() ?? null, command: props.command }))
    },
    onKeyDown: ({ event }: SuggestionKeyDownProps) => {
      const s = usePopup.getState()
      if (!s.items.length) return false
      if (event.key === 'ArrowDown') {
        usePopup.setState({ active: (s.active + 1) % s.items.length })
        return true
      }
      if (event.key === 'ArrowUp') {
        usePopup.setState({ active: (s.active - 1 + s.items.length) % s.items.length })
        return true
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const item = s.items[s.active]
        if (item && s.command) s.command(item)
        return true
      }
      if (event.key === 'Escape') {
        usePopup.setState({ kind: null, items: [] })
        return true
      }
      return false
    },
    onExit: () => usePopup.setState({ kind: null, items: [], rect: null, command: null }),
  })
}

function fold(s: string) {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

export function filterItems(items: SuggestItem[], query: string) {
  const q = fold(query.trim())
  if (!q) return items
  return items.filter((i) => fold(`${i.title} ${i.keywords ?? ''}`).includes(q))
}

export const SlashCommands = Extension.create<{ items: (query: string) => SuggestItem[]; enabled: () => boolean }>({
  name: 'slashCommands',
  addOptions: () => ({ items: () => [], enabled: () => true }),
  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        pluginKey: new PluginKey('slash'),
        char: '/',
        allowSpaces: false,
        startOfLine: false,
        allow: ({ state, range }) => {
          if (!this.options.enabled()) return false
          const $from = state.doc.resolve(range.from)
          return !$from.parent.type.spec.code
        },
        items: ({ query }) => this.options.items(query),
        command: ({ editor, range, props }) => void (props as SuggestItem).run(editor, range),
        render: popupRender('slash'),
      }),
    ]
  },
})

export const PageLinkSuggest = Extension.create<{ items: (query: string) => Promise<SuggestItem[]> }>({
  name: 'pageLinkSuggest',
  addOptions: () => ({ items: async () => [] }),
  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        pluginKey: new PluginKey('pageLink'),
        char: '[[',
        allowSpaces: true,
        startOfLine: false,
        allow: ({ state, range }) => !state.doc.resolve(range.from).parent.type.spec.code,
        items: ({ query }) => this.options.items(query),
        command: ({ editor, range, props }) => void (props as SuggestItem).run(editor, range),
        render: popupRender('link'),
      }),
    ]
  },
})

/** Decorates links whose destination is known to be broken. */
export const brokenLinksKey = new PluginKey<DecorationSet>('brokenLinks')
export const BrokenLinks = Extension.create({
  name: 'brokenLinks',
  addProseMirrorPlugins() {
    return [
      new Plugin<{ dests: Set<string>; set: DecorationSet }>({
        key: brokenLinksKey as never,
        state: {
          init: () => ({ dests: new Set(), set: DecorationSet.empty }),
          apply(tr, value, _old, state) {
            const meta = tr.getMeta(brokenLinksKey) as Set<string> | undefined
            const dests = meta ?? value.dests
            if (!meta && !tr.docChanged) return value
            const decos: Decoration[] = []
            if (dests.size) {
              state.doc.descendants((node, pos) => {
                if (node.type.name === 'wikiLink' && dests.has(node.attrs.target)) {
                  decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'broken', title: 'Página não encontrada' }))
                }
                if (!node.isText) return
                for (const m of node.marks) {
                  if (m.type.name === 'link' && dests.has(m.attrs.href)) {
                    decos.push(Decoration.inline(pos, pos + node.nodeSize, { class: 'broken', title: 'Destino não encontrado' }))
                  }
                }
              })
            }
            return { dests, set: DecorationSet.create(state.doc, decos) }
          },
        },
        props: {
          decorations(state) {
            return (this.getState(state) as { set: DecorationSet } | undefined)?.set
          },
        },
      }),
    ]
  },
})
