/**
 * Page tree. Folders load on demand when expanded; very large folders render
 * in slices ("show more") so expanding thousands of pages stays responsive.
 * Keyboard: ↑/↓ move, →/← expand/collapse, Enter opens, F2 renames,
 * ⌘⌫ deletes, Home/End jump. Drag rows to move or reorder them.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronRight,
  Copy,
  ExternalLink,
  FilePlus,
  FileText,
  Folder,
  FolderInput,
  FolderPlus,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Plus,
  Star,
  Table2,
  Trash2,
  Upload,
} from 'lucide-react'
import { api, pathName, pathParent, type TreeEntry } from '../api'
import { deleteEntry, duplicatePage, exportPage, moveEntry, newFolder, newPage, renameEntry, reveal, toggleFavorite } from '../actions'
import { navigate, openPage, toastError, useApp } from '../store'
import { openMenu, type MenuEntry } from '../ui/Menu'
import { openMovePicker } from './MovePicker'

const SLICE = 400

interface Row {
  entry: TreeEntry
  depth: number
  parentDir: string
}

type DropPos = 'before' | 'after' | 'inside'

function storageKey(root: string) {
  return `note4me:expanded:${root}`
}

function loadExpanded(root: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(storageKey(root)) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

export function Tree() {
  const vault = useApp((s) => s.vault)
  const treeVersion = useApp((s) => s.treeVersion)
  const route = useApp((s) => s.route)
  const showFiles = useApp((s) => s.settings?.appearance.showFilesInSidebar ?? false)
  const favorites = useApp((s) => s.nav.favorites)
  const [children, setChildren] = useState<Map<string, TreeEntry[]>>(new Map())
  const [expanded, setExpanded] = useState<Set<string>>(() => (vault ? loadExpanded(vault.root) : new Set()))
  const [limits, setLimits] = useState<Map<string, number>>(new Map())
  const [focusIdx, setFocusIdx] = useState(0)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [drag, setDrag] = useState<{ source: Row; target: string | null; pos: DropPos | null } | null>(null)
  const treeRef = useRef<HTMLDivElement>(null)
  const [treeFocused, setTreeFocused] = useState(false)
  const suppressClick = useRef(false)

  const load = useCallback(async (dir: string) => {
    try {
      const list = await api.treeList(dir)
      setChildren((m) => new Map(m).set(dir, list))
    } catch {
      // The folder vanished (moved/deleted outside the app): forget it.
      setChildren((m) => {
        const n = new Map(m)
        n.delete(dir)
        return n
      })
    }
  }, [])

  // (Re)load the root and every expanded folder whenever the vault changes.
  useEffect(() => {
    if (!vault) return
    void load('')
    expanded.forEach((d) => void load(d))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault?.root, treeVersion])

  useEffect(() => {
    if (vault) localStorage.setItem(storageKey(vault.root), JSON.stringify([...expanded]))
  }, [expanded, vault])

  // Reveal the open page by expanding its ancestors.
  useEffect(() => {
    if (route.kind !== 'page') return
    const parts = route.path.split('/')
    const dirs: string[] = []
    for (let i = 1; i < parts.length; i++) dirs.push(parts.slice(0, i).join('/'))
    const missing = dirs.filter((d) => !expanded.has(d))
    if (missing.length) {
      setExpanded((s) => new Set([...s, ...missing]))
      missing.forEach((d) => void load(d))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route])

  const rows = useMemo(() => {
    const out: (Row | { more: string; remaining: number; depth: number })[] = []
    const walk = (dir: string, depth: number) => {
      const list = (children.get(dir) ?? []).filter((e) => showFiles || e.kind !== 'file')
      const limit = limits.get(dir) ?? SLICE
      list.slice(0, limit).forEach((entry) => {
        out.push({ entry, depth, parentDir: dir })
        if (entry.childrenDir && expanded.has(entry.childrenDir)) walk(entry.childrenDir, depth + 1)
      })
      if (list.length > limit) out.push({ more: dir, remaining: list.length - limit, depth })
    }
    walk('', 0)
    return out
  }, [children, expanded, limits, showFiles])

  const realRows = rows.filter((r): r is Row => 'entry' in r)
  const selectedPath = route.kind === 'page' ? route.path : route.kind === 'collection' ? route.folder : null

  const toggle = (row: Row, open?: boolean) => {
    const dir = row.entry.childrenDir
    if (!dir || !row.entry.hasChildren) return
    const isOpen = expanded.has(dir)
    const next = open ?? !isOpen
    if (next === isOpen) return
    setExpanded((s) => {
      const n = new Set(s)
      if (next) n.add(dir)
      else n.delete(dir)
      return n
    })
    if (next) void load(dir)
  }

  const activate = (row: Row) => {
    const e = row.entry
    if (e.kind === 'page') void openPage(e.path)
    else if (e.kind === 'folder') void navigate({ kind: 'collection', folder: e.path })
    else void api.openWithDefaultApp(e.path).catch(toastError)
  }

  const menuFor = (row: Row): MenuEntry[] => {
    const e = row.entry
    const isFav = favorites.some((f) => f.path === e.path)
    if (e.kind === 'file') {
      return [
        { label: 'Abrir no app padrão', icon: <ExternalLink />, onSelect: () => void api.openWithDefaultApp(e.path).catch(toastError) },
        { label: 'Mostrar no Finder', icon: <FolderInput />, onSelect: () => void reveal(e.path) },
        { separator: true },
        { label: 'Renomear…', icon: <Pencil />, hint: 'F2', onSelect: () => setRenaming(e.path) },
        { label: 'Mover para…', icon: <Upload />, onSelect: () => openMovePicker(e.path) },
        { separator: true },
        { label: 'Mover para a lixeira', icon: <Trash2 />, danger: true, onSelect: () => void deleteEntry(e) },
      ]
    }
    if (e.kind === 'folder') {
      return [
        { label: 'Nova página aqui', icon: <FilePlus />, onSelect: () => void newPage(e.path) },
        { label: 'Nova pasta aqui', icon: <FolderPlus />, onSelect: () => void newFolder(e.path) },
        { label: 'Ver como coleção', icon: <Table2 />, onSelect: () => void navigate({ kind: 'collection', folder: e.path }) },
        { separator: true },
        { label: 'Renomear…', icon: <Pencil />, hint: 'F2', onSelect: () => setRenaming(e.path) },
        { label: 'Mover para…', icon: <Upload />, onSelect: () => openMovePicker(e.path) },
        { label: 'Mostrar no Finder', icon: <FolderInput />, onSelect: () => void reveal(e.path) },
        { separator: true },
        { label: 'Mover para a lixeira', icon: <Trash2 />, danger: true, onSelect: () => void deleteEntry(e) },
      ]
    }
    return [
      { label: 'Nova subpágina', icon: <FilePlus />, onSelect: () => void newPage(e.path) },
      ...(e.hasChildren && e.childrenDir ? [{ label: 'Ver subpáginas como coleção', icon: <Table2 />, onSelect: () => void navigate({ kind: 'collection', folder: e.childrenDir! }) }] : []),
      { separator: true },
      { label: 'Renomear…', icon: <Pencil />, hint: 'F2', onSelect: () => setRenaming(e.path) },
      { label: 'Duplicar', icon: <Copy />, onSelect: () => void duplicatePage(e.path) },
      { label: 'Mover para…', icon: <Upload />, onSelect: () => openMovePicker(e.path) },
      { label: isFav ? 'Remover dos favoritos' : 'Adicionar aos favoritos', icon: <Star />, onSelect: () => void toggleFavorite(e.path) },
      { separator: true },
      { label: 'Mostrar no Finder', icon: <FolderInput />, onSelect: () => void reveal(e.path) },
      { label: 'Exportar com anexos…', icon: <Paperclip />, onSelect: () => void exportPage(e.path) },
      { separator: true },
      { label: 'Mover para a lixeira', icon: <Trash2 />, danger: true, onSelect: () => void deleteEntry(e) },
    ]
  }

  const focusRow = (i: number) => {
    const clamped = Math.max(0, Math.min(realRows.length - 1, i))
    setFocusIdx(clamped)
    treeRef.current?.querySelector<HTMLElement>(`[data-index="${clamped}"]`)?.scrollIntoView({ block: 'nearest' })
  }

  const onKeyDown = (ev: React.KeyboardEvent) => {
    if (renaming) return
    const row = realRows[focusIdx]
    if (!row) return
    const open = row.entry.childrenDir ? expanded.has(row.entry.childrenDir) : false
    switch (ev.key) {
      case 'ArrowDown':
        ev.preventDefault()
        focusRow(focusIdx + 1)
        break
      case 'ArrowUp':
        ev.preventDefault()
        focusRow(focusIdx - 1)
        break
      case 'Home':
        ev.preventDefault()
        focusRow(0)
        break
      case 'End':
        ev.preventDefault()
        focusRow(realRows.length - 1)
        break
      case 'ArrowRight':
        ev.preventDefault()
        if (row.entry.hasChildren && !open) toggle(row, true)
        else if (open) focusRow(focusIdx + 1)
        break
      case 'ArrowLeft': {
        ev.preventDefault()
        if (open) toggle(row, false)
        else {
          const parentIdx = realRows.findIndex((r) => r.entry.childrenDir === row.parentDir && row.parentDir !== '')
          if (parentIdx >= 0) focusRow(parentIdx)
        }
        break
      }
      case 'Enter':
        ev.preventDefault()
        activate(row)
        break
      case 'F2':
        ev.preventDefault()
        setRenaming(row.entry.path)
        break
      case 'Backspace':
      case 'Delete':
        if (ev.metaKey) {
          ev.preventDefault()
          void deleteEntry(row.entry)
        }
        break
      case 'ContextMenu': {
        ev.preventDefault()
        const el = treeRef.current?.querySelector<HTMLElement>(`[data-index="${focusIdx}"]`)
        if (el) openMenu(el, menuFor(row), `Ações de ${row.entry.name}`)
        break
      }
    }
  }

  // ----- Pointer-based drag and drop ---------------------------------------------
  const dragStart = useRef<{ x: number; y: number; row: Row } | null>(null)
  const onPointerDown = (e: React.PointerEvent, row: Row) => {
    if (e.button !== 0 || renaming) return
    dragStart.current = { x: e.clientX, y: e.clientY, row }
  }
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const start = dragStart.current
      if (!start) return
      if (!drag && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 5) return
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-path]')
      let target: string | null = null
      let pos: DropPos | null = null
      if (el && el.dataset.path !== start.row.entry.path) {
        const r = el.getBoundingClientRect()
        const rel = (e.clientY - r.top) / r.height
        const kind = el.dataset.kind
        target = el.dataset.path!
        pos = kind !== 'file' && rel > 0.28 && rel < 0.72 ? 'inside' : rel < 0.5 ? 'before' : 'after'
      }
      setDrag({ source: start.row, target, pos })
    }
    const up = async () => {
      const d = drag
      dragStart.current = null
      setDrag(null)
      if (d) {
        suppressClick.current = true
        setTimeout(() => (suppressClick.current = false), 0)
      }
      if (!d || !d.target || !d.pos) return
      const src = d.source.entry
      const targetRow = realRows.find((r) => r.entry.path === d.target)
      if (!targetRow) return
      if (d.pos === 'inside') {
        const moved = await moveEntry(src.path, targetRow.entry.path)
        if (moved && targetRow.entry.childrenDir) {
          setExpanded((s) => new Set(s).add(targetRow.entry.childrenDir!))
        }
        return
      }
      // Reorder within the target's folder (moving there first if needed).
      const destDir = targetRow.parentDir
      let name = pathName(src.path)
      if (pathParent(src.path) !== destDir) {
        const moved = await moveEntry(src.path, destDir)
        if (!moved) return
        name = pathName(moved)
      }
      const siblings = (await api.treeList(destDir)).map((e) => pathName(e.path)).filter((n) => n !== name)
      const at = siblings.indexOf(pathName(targetRow.entry.path))
      siblings.splice(d.pos === 'before' ? at : at + 1, 0, name)
      try {
        await api.treeReorder(destDir, siblings)
        await load(destDir)
      } catch (e) {
        toastError(e)
      }
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
    return () => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
    }
  })

  if (!vault) return null
  const rootList = children.get('')
  if (rootList && rootList.length === 0) {
    return (
      <div className="tree-empty">
        Nenhuma página ainda.{' '}
        <button className="btn small ghost" onClick={() => void newPage('')}>
          <Plus /> Criar página
        </button>
      </div>
    )
  }

  let index = -1
  return (
    <div
      className="tree"
      role="tree"
      aria-label="Páginas"
      ref={treeRef}
      tabIndex={realRows.length ? 0 : -1}
      onKeyDown={onKeyDown}
      onBlur={() => setTreeFocused(false)}
      onFocus={(e) => {
        setTreeFocused(e.target === treeRef.current)
        if (e.target === treeRef.current) {
          const sel = realRows.findIndex((r) => r.entry.path === selectedPath)
          focusRow(sel >= 0 ? sel : focusIdx)
        }
      }}
      aria-activedescendant={realRows[focusIdx] ? `tree-${focusIdx}` : undefined}
    >
      {rows.map((r) => {
        if (!('entry' in r)) {
          return (
            <div key={`more-${r.more}`} style={{ paddingLeft: `${0.5 + r.depth * 1.1}rem` }}>
              <button className="btn small ghost" onClick={() => setLimits((m) => new Map(m).set(r.more, (m.get(r.more) ?? SLICE) + SLICE))}>
                Mostrar mais {Math.min(SLICE, r.remaining)} de {r.remaining}…
              </button>
            </div>
          )
        }
        index++
        const i = index
        const e = r.entry
        const open = e.childrenDir ? expanded.has(e.childrenDir) : false
        const isDragging = drag?.source.entry.path === e.path
        const dropCls = drag?.target === e.path && drag.pos ? `drop-${drag.pos}` : ''
        return (
          <div
            key={e.path}
            id={`tree-${i}`}
            data-index={i}
            data-path={e.path}
            data-kind={e.kind}
            role="treeitem"
            aria-level={r.depth + 1}
            aria-expanded={e.hasChildren ? open : undefined}
            aria-selected={selectedPath === e.path || (e.kind === 'folder' && selectedPath === e.childrenDir)}
            className={`tree-row tree-${e.kind} ${focusIdx === i && treeFocused ? 'focused' : ''} ${isDragging ? 'dragging' : ''} ${dropCls}`}
            style={{ paddingLeft: `${0.2 + r.depth * 1.1}rem` }}
            onPointerDown={(ev) => onPointerDown(ev, r)}
            onClick={() => {
              setFocusIdx(i)
              if (!suppressClick.current) activate(r)
            }}
            onDoubleClick={() => e.kind !== 'file' && setRenaming(e.path)}
            onContextMenu={(ev) => {
              ev.preventDefault()
              setFocusIdx(i)
              openMenu({ x: ev.clientX, y: ev.clientY }, menuFor(r), `Ações de ${e.name}`)
            }}
          >
            <span
              className="tree-twisty"
              data-open={open}
              aria-hidden
              style={{ visibility: e.hasChildren ? 'visible' : 'hidden' }}
              onClick={(ev) => {
                ev.stopPropagation()
                toggle(r)
              }}
            >
              <ChevronRight />
            </span>
            <span className="tree-icon" aria-hidden>
              {e.kind === 'folder' ? <Folder /> : e.kind === 'file' ? <Paperclip /> : <FileText />}
            </span>
            {renaming === e.path ? (
              <RenameInput
                initial={e.name}
                onDone={async (value) => {
                  setRenaming(null)
                  treeRef.current?.focus()
                  if (value && value !== e.name) await renameEntry(e.path, value)
                }}
              />
            ) : (
              <span className="tree-label" title={e.path}>
                {e.name}
              </span>
            )}
            {e.kind !== 'file' && renaming !== e.path && (
              <span className="row-actions">
                <button
                  className="icon-btn"
                  tabIndex={-1}
                  aria-label={`Nova página em ${e.name}`}
                  title="Nova subpágina"
                  onClick={async (ev) => {
                    ev.stopPropagation()
                    const p = await newPage(e.path)
                    if (p && e.childrenDir) setExpanded((s) => new Set(s).add(e.childrenDir!))
                    else if (p) setExpanded((s) => new Set(s).add(e.path.replace(/\.md$/i, '')))
                  }}
                >
                  <Plus />
                </button>
                <button
                  className="icon-btn"
                  tabIndex={-1}
                  aria-label={`Mais ações para ${e.name}`}
                  onClick={(ev) => {
                    ev.stopPropagation()
                    openMenu(ev.currentTarget, menuFor(r), `Ações de ${e.name}`)
                  }}
                >
                  <MoreHorizontal />
                </button>
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}

function RenameInput({ initial, onDone }: { initial: string; onDone: (v: string | null) => void }) {
  const [value, setValue] = useState(initial)
  const done = useRef(false)
  const finish = (v: string | null) => {
    if (done.current) return
    done.current = true
    onDone(v)
  }
  return (
    <input
      className="tree-rename"
      type="text"
      autoFocus
      aria-label="Novo nome"
      value={value}
      onFocus={(e) => e.target.select()}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') finish(value.trim() || null)
        if (e.key === 'Escape') finish(null)
      }}
      onBlur={() => finish(value.trim() || null)}
    />
  )
}

