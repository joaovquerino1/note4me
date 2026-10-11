import { useEffect, useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, PanelLeftOpen } from 'lucide-react'
import { isMarkdown, pathName, pathStem } from '../api'
import { goBack, goForward, navigate, openPage, updateSettings, useApp } from '../store'

/** Breadcrumb trail for a vault path: folders open as collections, pages open. */
export function Crumbs({ path }: { path: string }) {
  const parts = path.split('/')
  const items: { label: string; onClick: () => void }[] = []
  for (let i = 0; i < parts.length; i++) {
    const sub = parts.slice(0, i + 1).join('/')
    const last = i === parts.length - 1
    const label = last && isMarkdown(sub) ? pathStem(sub) : pathName(sub)
    items.push({ label, onClick: () => (last && isMarkdown(sub) ? void openPage(sub) : void navigate({ kind: 'collection', folder: sub })) })
  }
  const shown = items.length > 4 ? [items[0]!, { label: '…', onClick: () => undefined }, ...items.slice(-2)] : items
  return (
    <nav className="crumbs" aria-label="Localização">
      {shown.map((it, i) => (
        <span key={i} style={{ display: 'contents' }}>
          {i > 0 && (
            <span className="sep" aria-hidden>
              /
            </span>
          )}
          <button onClick={it.onClick} aria-current={i === shown.length - 1 ? 'page' : undefined} disabled={it.label === '…'}>
            {it.label}
          </button>
        </span>
      ))}
    </nav>
  )
}

export function TopBar({ left, right, scrolled }: { left?: ReactNode; right?: ReactNode; scrolled?: boolean }) {
  const back = useApp((s) => s.backStack.length > 0)
  const fwd = useApp((s) => s.forwardStack.length > 0)
  const sidebarVisible = useApp((s) => s.settings?.appearance.sidebarVisible ?? true)
  return (
    <header className={`topbar ${scrolled ? 'scrolled' : ''}`} data-tauri-drag-region>
      {!sidebarVisible && (
        <button className="icon-btn" aria-label="Mostrar barra lateral" title="Mostrar barra lateral (⌘\)" onClick={() => updateSettings((s) => void (s.appearance.sidebarVisible = true))}>
          <PanelLeftOpen />
        </button>
      )}
      <button className="icon-btn" aria-label="Voltar" title="Voltar (⌘[)" disabled={!back} onClick={() => void goBack()}>
        <ChevronLeft />
      </button>
      <button className="icon-btn" aria-label="Avançar" title="Avançar (⌘])" disabled={!fwd} onClick={() => void goForward()}>
        <ChevronRight />
      </button>
      {left}
      <div className="topbar-drag" data-tauri-drag-region />
      {right}
    </header>
  )
}

/** Tracks whether a scroll container has scrolled (for the top bar divider). */
export function useScrolled(ref: React.RefObject<HTMLElement | null>) {
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const on = () => setScrolled(el.scrollTop > 4)
    el.addEventListener('scroll', on, { passive: true })
    return () => el.removeEventListener('scroll', on)
  }, [ref])
  return scrolled
}
