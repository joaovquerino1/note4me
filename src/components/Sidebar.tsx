import { useState } from 'react'
import { ChevronDown, Clock, FilePlus, FileText, FolderOpen, FolderPlus, PanelLeftClose, RefreshCw, Search, Settings2, Star, Trash2, Vault, X } from 'lucide-react'
import { api, pathParent } from '../api'
import { chooseVault, createVault, newFolder, newPage, openSettings } from '../actions'
import { navigate, openPage, refreshTree, setOverlay, toast, toastError, updateSettings, useApp } from '../store'
import { openMenu } from '../ui/Menu'
import { Tree } from './Tree'

function useCollapsed(key: string) {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(`note4me:collapsed:${key}`) === '1'
    } catch {
      return false
    }
  })
  const toggle = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(`note4me:collapsed:${key}`, c ? '0' : '1')
      } catch {
        /* storage unavailable */
      }
      return !c
    })
  }
  return [collapsed, toggle] as const
}

function Section(props: { id: string; title: string; actions?: React.ReactNode; children: React.ReactNode }) {
  const [collapsed, toggle] = useCollapsed(props.id)
  const headingId = `section-${props.id}`
  return (
    <section className="sidebar-section" aria-labelledby={headingId}>
      <div className="sidebar-section-title">
        <button id={headingId} aria-expanded={!collapsed} onClick={toggle} style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
          {props.title}
          <ChevronDown aria-hidden style={{ width: '0.8rem', height: '0.8rem', transform: collapsed ? 'rotate(-90deg)' : undefined }} />
        </button>
        <span style={{ display: 'flex' }}>{props.actions}</span>
      </div>
      {!collapsed && props.children}
    </section>
  )
}

export function Sidebar() {
  const vault = useApp((s) => s.vault)
  const nav = useApp((s) => s.nav)
  const route = useApp((s) => s.route)
  const width = useApp((s) => s.settings?.appearance.sidebarWidth ?? 260)

  const vaultMenu = (el: HTMLElement) =>
    openMenu(
      el,
      [
        { header: vault?.root ?? '' },
        { label: 'Abrir outra pasta…', icon: <FolderOpen />, onSelect: () => void chooseVault() },
        { label: 'Novo espaço de trabalho…', icon: <FolderPlus />, onSelect: () => void createVault() },
        { separator: true },
        { label: 'Mostrar no Finder', icon: <FolderOpen />, onSelect: () => vault && void api.revealAbs(vault.root).catch(toastError) },
        {
          label: 'Reindexar a partir dos arquivos',
          icon: <RefreshCw />,
          onSelect: async () => {
            try {
              const info = await api.vaultReindex()
              useApp.setState({ vault: info })
              refreshTree()
              toast(`Índice reconstruído: ${info.pageCount} páginas.`, 'success')
            } catch (e) {
              toastError(e)
            }
          },
        },
        { separator: true },
        {
          label: 'Fechar espaço de trabalho',
          icon: <X />,
          onSelect: async () => {
            await api.vaultClose()
            useApp.setState({ vault: null, route: { kind: 'home' }, backStack: [], forwardStack: [] })
          },
        },
      ],
      'Espaço de trabalho',
    )

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    const move = (ev: PointerEvent) => updateSettings((s) => void (s.appearance.sidebarWidth = Math.max(180, Math.min(520, startW + ev.clientX - startX))))
    const up = () => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
  }

  const current = route.kind === 'page' ? route.path : null
  const recents = nav.recents.filter((r) => r.path !== current).slice(0, 5)

  return (
    <nav className="sidebar" aria-label="Barra lateral">
      <div className="sidebar-head" data-tauri-drag-region>
        <button className="icon-btn" aria-label="Ocultar barra lateral" title="Ocultar barra lateral (⌘\)" onClick={() => updateSettings((s) => void (s.appearance.sidebarVisible = false))}>
          <PanelLeftClose />
        </button>
        <button className="icon-btn" aria-label="Nova página" title="Nova página (⌘N)" onClick={() => void newPage(current ? pathParent(current) : '')}>
          <FilePlus />
        </button>
      </div>
      <button className="sidebar-vault" onClick={(e) => vaultMenu(e.currentTarget)} aria-label={`Espaço de trabalho ${vault?.name}. Abrir opções`}>
        <Vault aria-hidden style={{ width: '1rem', height: '1rem', flex: 'none', color: 'var(--c-text-secondary)' }} />
        <span>{vault?.name}</span>
        <ChevronDown aria-hidden style={{ width: '0.85rem', height: '0.85rem', flex: 'none', color: 'var(--c-text-muted)' }} />
      </button>
      <button className="sidebar-search" onClick={() => setOverlay('quickOpen')} aria-label="Ir para página (⌘P)">
        <Search aria-hidden style={{ width: '0.95rem', height: '0.95rem' }} />
        <span>Ir para…</span>
        <kbd aria-hidden>⌘P</kbd>
      </button>
      <div className="sidebar-scroll">
        {nav.favorites.length > 0 && (
          <Section id="favorites" title="Favoritos">
            <ul className="link-list" style={{ padding: '0 0.4rem' }}>
              {nav.favorites.map((f) => (
                <li key={f.path}>
                  <button onClick={() => void openPage(f.path)} aria-current={current === f.path ? 'page' : undefined} title={f.path}>
                    <Star aria-hidden />
                    <span className="tree-label">{f.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Section>
        )}
        {recents.length > 0 && (
          <Section id="recents" title="Recentes">
            <ul className="link-list" style={{ padding: '0 0.4rem' }}>
              {recents.map((f) => (
                <li key={f.path}>
                  <button onClick={() => void openPage(f.path)} title={f.path}>
                    <Clock aria-hidden />
                    <span className="tree-label">{f.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Section>
        )}
        <Section
          id="pages"
          title="Páginas"
          actions={
            <>
              <button className="icon-btn" aria-label="Nova pasta na raiz" title="Nova pasta" onClick={() => void newFolder('')}>
                <FolderPlus />
              </button>
              <button className="icon-btn" aria-label="Nova página na raiz" title="Nova página na raiz" onClick={() => void newPage('')}>
                <FileText />
              </button>
            </>
          }
        >
          <Tree />
        </Section>
      </div>
      <div className="sidebar-foot">
        <button className="btn ghost small" onClick={() => void navigate({ kind: 'trash' })} aria-current={route.kind === 'trash' ? 'page' : undefined}>
          <Trash2 aria-hidden /> Lixeira
        </button>
        <button className="btn ghost small" onClick={() => void openSettings()} aria-current={route.kind === 'settings' ? 'page' : undefined}>
          <Settings2 aria-hidden /> Ajustes
        </button>
      </div>
      <div
        className="sidebar-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Largura da barra lateral"
        aria-valuemin={180}
        aria-valuemax={520}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={startResize}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault()
            const d = e.key === 'ArrowLeft' ? -16 : 16
            updateSettings((s) => void (s.appearance.sidebarWidth = Math.max(180, Math.min(520, s.appearance.sidebarWidth + d))))
          }
        }}
      />
    </nav>
  )
}
