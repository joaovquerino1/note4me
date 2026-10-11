/**
 * The visual Markdown editor. It loads a page body, lets the user edit it as
 * blocks, and hands back Markdown through `getMarkdown()`; it never writes
 * files itself.
 */
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { EditorContent, useEditor, type Editor as TipTapEditor } from '@tiptap/react'
import { Extension } from '@tiptap/core'
import { Placeholder } from '@tiptap/extensions'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { convertFileSrc } from '@tauri-apps/api/core'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { Bold, Code, Italic, Link2, Strikethrough } from 'lucide-react'
import { api, pathParent, pathStem } from '../api'
import { confirmDialog, openPage, promptDialog, refreshTree, toast, toastError, useApp } from '../store'
import { contentExtensions, setAssetResolver } from './schema'
import { parseMarkdown, serializeMarkdown } from './markdown'
import { BrokenLinks, brokenLinksKey, filterItems, PageLinkSuggest, SlashCommands, type SuggestItem } from './suggest'
import { SuggestionPopup } from './SuggestionPopup'

export interface EditorHandle {
  getMarkdown(): string
  focus(): void
  undo(): boolean
  redo(): boolean
  insertFiles(paths: string[], at?: { x: number; y: number }): Promise<void>
  setBrokenLinks(dests: string[]): void
  wordCount(): number
  contains(el: Element | null): boolean
}

interface Props {
  pagePath: string
  body: string
  /** Changes whenever `body` must be (re)loaded into the editor. */
  loadKey: string
  editable: boolean
  onChange: () => void
}

/** Joins a page-relative path to the vault root, resolving `.` and `..`. */
function joinVault(root: string, pageDir: string, rel: string) {
  const parts = [...(pageDir ? pageDir.split('/') : [])]
  for (const seg of rel.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg && seg !== '.') parts.push(seg)
  }
  return `${root}/${parts.join('/')}`
}

function safeDecode(s: string) {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')

export const Editor = forwardRef<EditorHandle, Props>(function Editor(props, ref) {
  const prefix = useRef('')
  const loadingRef = useRef(false)
  const pathRef = useRef(props.pagePath)
  pathRef.current = props.pagePath
  const onChangeRef = useRef(props.onChange)
  onChangeRef.current = props.onChange
  const settings = useApp((s) => s.settings)
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const vaultRoot = useApp((s) => s.vault?.root ?? '')

  // Images: relative sources are displayed through the asset protocol.
  useEffect(() => {
    setAssetResolver((src) => {
      if (!src || /^(https?:|data:|blob:)/i.test(src)) return src
      if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('/')) return ''
      const clean = safeDecode(src.split(/[?#]/)[0]!)
      return convertFileSrc(joinVault(vaultRoot, pathParent(pathRef.current), clean))
    })
  }, [vaultRoot])

  const insertLinkToPage = async (editor: TipTapEditor, range: { from: number; to: number }, target: string, title: string) => {
    const format = settingsRef.current?.editor.linkFormat ?? 'markdown'
    if (format === 'wiki') {
      editor.chain().focus().insertContentAt(range, [{ type: 'wikiLink', attrs: { target: pathStem(target), alias: null } }, { type: 'text', text: ' ' }]).run()
      return
    }
    const href = await api.linkRelative(pathRef.current, target)
    editor
      .chain()
      .focus()
      .insertContentAt(range, [
        { type: 'text', text: title, marks: [{ type: 'link', attrs: { href } }] },
        { type: 'text', text: ' ' },
      ])
      .run()
  }

  const attachFiles = async (editor: TipTapEditor, paths: string[], pos?: number) => {
    for (const p of paths) {
      try {
        const a = await api.attachmentAdd(pathRef.current, p)
        const content = a.isImage
          ? { type: 'image', attrs: { src: a.link, alt: pathStem(a.name) } }
          : { type: 'text', text: a.name, marks: [{ type: 'link', attrs: { href: a.link } }] }
        const at = pos ?? editor.state.selection.to
        editor.chain().focus().insertContentAt(at, [content, { type: 'text', text: ' ' }]).run()
        pos = undefined
      } catch (e) {
        toastError(e, 'Não foi possível anexar o arquivo')
      }
    }
    refreshTree()
  }

  const slashItems = useMemo<SuggestItem[]>(() => {
    const block = (id: string, title: string, keywords: string, run: (e: TipTapEditor) => void, subtitle?: string): SuggestItem => ({
      id,
      title,
      keywords,
      subtitle,
      run: (editor, range) => {
        editor.chain().focus().deleteRange(range).run()
        run(editor)
      },
    })
    return [
      block('p', 'Texto', 'paragrafo paragraph text', (e) => e.chain().setParagraph().run()),
      block('h1', 'Título 1', 'heading h1 titulo', (e) => e.chain().setHeading({ level: 1 }).run(), '# '),
      block('h2', 'Título 2', 'heading h2 titulo', (e) => e.chain().setHeading({ level: 2 }).run(), '## '),
      block('h3', 'Título 3', 'heading h3 titulo', (e) => e.chain().setHeading({ level: 3 }).run(), '### '),
      block('ul', 'Lista com marcadores', 'bullet list lista', (e) => e.chain().toggleBulletList().run(), '- '),
      block('ol', 'Lista numerada', 'ordered numbered lista', (e) => e.chain().toggleOrderedList().run(), '1. '),
      block('todo', 'Lista de tarefas', 'task todo checkbox tarefa', (e) => e.chain().toggleTaskList().run(), '- [ ] '),
      block('quote', 'Citação', 'quote blockquote citacao', (e) => e.chain().toggleBlockquote().run(), '> '),
      block('code', 'Bloco de código', 'code codigo fence', (e) => e.chain().toggleCodeBlock().run(), '```'),
      block('hr', 'Divisor', 'divider hr linha separador', (e) => e.chain().setHorizontalRule().run(), '---'),
      block('table', 'Tabela', 'table tabela grid', (e) => e.chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()),
      {
        id: 'link',
        title: 'Link para página',
        keywords: 'link pagina wiki interno',
        subtitle: '[[',
        run: (editor, range) => {
          editor.chain().focus().deleteRange(range).insertContent('[[').run()
        },
      },
      {
        id: 'image',
        title: 'Imagem…',
        keywords: 'image imagem foto picture',
        run: async (editor, range) => {
          editor.chain().focus().deleteRange(range).run()
          const picked = await openDialog({ multiple: true, filters: [{ name: 'Imagens', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'heic', 'avif'] }] })
          const list = (Array.isArray(picked) ? picked : picked ? [picked] : []) as string[]
          if (list.length) await attachFiles(editor, list)
        },
      },
      {
        id: 'file',
        title: 'Anexo…',
        keywords: 'file arquivo anexo pdf attachment',
        run: async (editor, range) => {
          editor.chain().focus().deleteRange(range).run()
          const picked = await openDialog({ multiple: true })
          const list = (Array.isArray(picked) ? picked : picked ? [picked] : []) as string[]
          if (list.length) await attachFiles(editor, list)
        },
      },
    ]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const editor = useEditor({
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    extensions: [
      ...contentExtensions(),
      Placeholder.configure({
        placeholder: ({ node, pos }) => (pos === 0 && node.type.name === 'paragraph' ? 'Comece a escrever, ou digite / para inserir blocos…' : node.type.name === 'heading' ? 'Título' : ''),
        showOnlyCurrent: true,
      }),
      SlashCommands.configure({ items: (q) => filterItems(slashItems, q), enabled: () => settingsRef.current?.editor.slashMenu ?? true }),
      PageLinkSuggest.configure({
        items: async (query) => {
          const pages = await api.quickFind(query, 8).catch(() => [])
          const items: SuggestItem[] = pages
            .filter((p) => p.path !== pathRef.current)
            .map((p) => ({ id: p.path, title: p.title, subtitle: pathParent(p.path) || undefined, run: (ed, range) => void insertLinkToPage(ed, range, p.path, p.title) }))
          const name = query.trim()
          if (name && !pages.some((p) => p.title.toLowerCase() === name.toLowerCase())) {
            items.push({
              id: 'create',
              title: `Criar página “${name}”`,
              subtitle: 'como subpágina desta',
              run: async (ed, range) => {
                try {
                  const created = await api.pageCreate(pathRef.current, name)
                  refreshTree()
                  await insertLinkToPage(ed, range, created, name)
                } catch (e) {
                  toastError(e)
                }
              },
            })
          }
          return items
        },
      }),
      BrokenLinks,
      Extension.create({
        name: 'linkShortcut',
        addKeyboardShortcuts() {
          return {
            'Mod-k': () => {
              void editLink(this.editor)
              return true
            },
          }
        },
      }),
    ],
    editorProps: {
      attributes: { 'aria-label': 'Conteúdo da página', 'aria-multiline': 'true', role: 'textbox', class: 'ProseMirror' },
      handleDOMEvents: {
        click: (_view, event) => {
          const a = (event.target as HTMLElement).closest('a')
          if (!a || event.altKey) return false
          event.preventDefault()
          if (a.dataset.wikilink !== undefined) void followLink(a.dataset.target ?? '', true)
          else void followLink(a.getAttribute('href') ?? '', false)
          return true
        },
      },
      handlePaste: (view, event) => {
        const files = [...(event.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'))
        if (!files.length) return false
        event.preventDefault()
        void (async () => {
          for (const f of files) {
            try {
              const bytes = Array.from(new Uint8Array(await f.arrayBuffer()))
              const ext = f.type.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png'
              const a = await api.attachmentAddBytes(pathRef.current, f.name && f.name !== 'image.png' ? f.name : `colado.${ext}`, bytes)
              const node = view.state.schema.nodes.image!.create({ src: a.link, alt: pathStem(a.name) })
              view.dispatch(view.state.tr.replaceSelectionWith(node))
              refreshTree()
            } catch (e) {
              toastError(e, 'Não foi possível colar a imagem')
            }
          }
        })()
        return true
      },
    },
    onUpdate: () => {
      if (!loadingRef.current) onChangeRef.current()
    },
  })

  const followLink = async (dest: string, wiki: boolean) => {
    if (!dest) return
    if (!wiki && dest.startsWith('#')) {
      const wanted = safeDecode(dest.slice(1))
      editor?.state.doc.descendants((node, pos) => {
        if (node.type.name === 'heading' && slug(node.textContent) === slug(wanted)) {
          editor.chain().focus().setTextSelection(pos + 1).scrollIntoView().run()
          return false
        }
        return true
      })
      return
    }
    if (!wiki && /^[a-z][a-z0-9+.-]*:/i.test(dest)) {
      if (settingsRef.current?.editor.confirmExternalLinks) {
        const ok = await confirmDialog({ title: 'Abrir link externo?', message: dest, confirmLabel: 'Abrir' })
        if (!ok) return
      }
      return api.openExternal(dest).catch(toastError)
    }
    try {
      const r = await api.linkResolve(pathRef.current, dest, wiki)
      if (r.path && r.exists) {
        if (r.isPage) return void openPage(r.path)
        return void api.openWithDefaultApp(r.path).catch(toastError)
      }
      if (r.path && r.isPage) {
        const ok = await confirmDialog({ title: 'Página não encontrada', message: `O link aponta para “${r.path}”, que não existe. Deseja criar essa página?`, confirmLabel: 'Criar página' })
        if (ok) {
          const created = await api.pageCreate(pathParent(r.path), pathStem(r.path))
          refreshTree()
          void openPage(created)
        }
        return
      }
      if (wiki) {
        const ok = await confirmDialog({ title: 'Página não encontrada', message: `Nenhuma página chamada “${dest}”. Deseja criá-la ao lado desta?`, confirmLabel: 'Criar página' })
        if (ok) {
          const created = await api.pageCreate(pathParent(pathRef.current), dest)
          refreshTree()
          void openPage(created)
        }
        return
      }
      toast('O destino deste link não foi encontrado.', 'error')
    } catch (e) {
      toastError(e)
    }
  }

  // Load (or reload) the body without creating an undo step or a "dirty" event.
  useEffect(() => {
    if (!editor) return
    loadingRef.current = true
    try {
      const parsed = parseMarkdown(editor.schema, props.body)
      prefix.current = parsed.prefix
      const state = EditorState.create({ doc: parsed.doc, plugins: editor.state.plugins, selection: undefined })
      editor.view.updateState(state)
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.atStart(editor.state.doc)).setMeta('addToHistory', false))
    } finally {
      loadingRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, props.loadKey])

  useEffect(() => {
    editor?.setEditable(props.editable, false)
  }, [editor, props.editable])

  useImperativeHandle(
    ref,
    () => ({
      getMarkdown: () => (editor ? serializeMarkdown(editor.state.doc, prefix.current) : props.body),
      focus: () => editor?.commands.focus(),
      undo: () => editor?.commands.undo() ?? false,
      redo: () => editor?.commands.redo() ?? false,
      insertFiles: async (paths, at) => {
        if (!editor) return
        const pos = at ? editor.view.posAtCoords({ left: at.x, top: at.y })?.pos : undefined
        await attachFiles(editor, paths, pos)
      },
      setBrokenLinks: (dests) => {
        if (editor) editor.view.dispatch(editor.state.tr.setMeta(brokenLinksKey, new Set(dests)).setMeta('addToHistory', false))
      },
      wordCount: () => (editor ? editor.state.doc.textBetween(0, editor.state.doc.content.size, ' ', ' ').split(/\s+/).filter(Boolean).length : 0),
      contains: (el) => Boolean(el && editor?.view.dom.contains(el)),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor, props.body],
  )

  return (
    <div className="editor" spellCheck={settings?.editor.spellcheck ?? true}>
      <EditorContent editor={editor} />
      <SuggestionPopup />
      {editor && <FormatBar editor={editor} onLink={() => void editLink(editor)} />}
    </div>
  )
})

async function editLink(editor: TipTapEditor) {
  const current = editor.getAttributes('link').href as string | undefined
  const href = await promptDialog({ title: current ? 'Editar link' : 'Inserir link', label: 'Endereço (https://…) ou caminho relativo (Pasta/Página.md)', initial: current ?? '', confirmLabel: 'Aplicar' })
  if (href === null) return
  if (/^\s*javascript:/i.test(href)) return toast('Este tipo de link não é permitido.', 'error')
  editor.chain().focus().extendMarkRange('link').setLink({ href: href.trim() }).run()
}

function FormatBar({ editor, onLink }: { editor: TipTapEditor; onLink: () => void }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const [, force] = useState(0)
  useEffect(() => {
    const update = () => {
      const { state, view } = editor
      const { from, to, empty } = state.selection
      if (empty || !view.hasFocus() || state.selection.$from.parent.type.spec.code || !(state.selection instanceof TextSelection)) {
        setPos(null)
        return
      }
      const start = view.coordsAtPos(from)
      const end = view.coordsAtPos(to)
      setPos({ x: Math.max(8, (start.left + end.left) / 2 - 90), y: Math.max(48, start.top - 44) })
      force((n) => n + 1)
    }
    editor.on('selectionUpdate', update)
    editor.on('blur', () => setPos(null))
    return () => {
      editor.off('selectionUpdate', update)
    }
  }, [editor])
  if (!pos) return null
  const btn = (label: string, active: boolean, icon: React.ReactNode, run: () => void, key: string) => (
    <button className="icon-btn" aria-label={label} title={`${label} (${key})`} aria-pressed={active} onMouseDown={(e) => e.preventDefault()} onClick={run}>
      {icon}
    </button>
  )
  return (
    <div className="format-bar" style={{ left: pos.x, top: pos.y }} role="toolbar" aria-label="Formatação">
      {btn('Negrito', editor.isActive('bold'), <Bold />, () => editor.chain().focus().toggleBold().run(), '⌘B')}
      {btn('Itálico', editor.isActive('italic'), <Italic />, () => editor.chain().focus().toggleItalic().run(), '⌘I')}
      {btn('Tachado', editor.isActive('strike'), <Strikethrough />, () => editor.chain().focus().toggleStrike().run(), '⌘⇧S')}
      {btn('Código', editor.isActive('code'), <Code />, () => editor.chain().focus().toggleCode().run(), '⌘E')}
      {btn('Link', editor.isActive('link'), <Link2 />, onLink, '⌘K')}
    </div>
  )
}
