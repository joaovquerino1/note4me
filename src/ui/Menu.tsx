import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { create } from 'zustand'

export type MenuEntry =
  | { label: string; icon?: ReactNode; hint?: string; danger?: boolean; disabled?: boolean; onSelect: () => void }
  | { separator: true }
  | { header: string }

interface MenuState {
  open: { x: number; y: number; items: MenuEntry[]; label: string } | null
}
const useMenu = create<MenuState>(() => ({ open: null }))

/** Opens a context menu at a point (or under an element). */
export function openMenu(at: { x: number; y: number } | HTMLElement, items: MenuEntry[], label = 'Menu') {
  let x: number
  let y: number
  if (at instanceof HTMLElement) {
    const r = at.getBoundingClientRect()
    x = r.left
    y = r.bottom + 4
  } else {
    ;({ x, y } = at)
  }
  useMenu.setState({ open: { x, y, items, label } })
}

export function closeMenu() {
  useMenu.setState({ open: null })
}

export function MenuHost() {
  const open = useMenu((s) => s.open)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const [active, setActive] = useState(-1)
  const previous = useRef<HTMLElement | null>(null)

  const actionable = open ? open.items.map((it, i) => ('onSelect' in it && !it.disabled ? i : -1)).filter((i) => i >= 0) : []

  useLayoutEffect(() => {
    if (!open || !ref.current) return
    const r = ref.current.getBoundingClientRect()
    setPos({ x: Math.max(4, Math.min(open.x, innerWidth - r.width - 8)), y: Math.max(4, Math.min(open.y, innerHeight - r.height - 8)) })
  }, [open])

  useEffect(() => {
    if (!open) return
    previous.current = document.activeElement as HTMLElement | null
    setActive(actionable[0] ?? -1)
    ref.current?.focus()
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeMenu()
    }
    const onBlur = () => closeMenu()
    addEventListener('mousedown', onDown, true)
    addEventListener('blur', onBlur)
    return () => {
      removeEventListener('mousedown', onDown, true)
      removeEventListener('blur', onBlur)
      previous.current?.focus?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open) return null
  const select = (i: number) => {
    const it = open.items[i]
    if (it && 'onSelect' in it && !it.disabled) {
      closeMenu()
      // Let focus return before running the action.
      setTimeout(it.onSelect, 0)
    }
  }
  const onKeyDown = (e: React.KeyboardEvent) => {
    const idx = actionable.indexOf(active)
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive(actionable[(idx + 1) % actionable.length] ?? -1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive(actionable[(idx - 1 + actionable.length) % actionable.length] ?? -1)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      select(active)
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault()
      closeMenu()
    }
  }
  return (
    <div
      ref={ref}
      className="menu"
      role="menu"
      aria-label={open.label}
      tabIndex={-1}
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {open.items.map((it, i) => {
        if ('separator' in it) return <div key={i} className="menu-sep" role="separator" />
        if ('header' in it) return <div key={i} className="menu-label">{it.header}</div>
        return (
          <button
            key={i}
            role="menuitem"
            className={`menu-item ${it.danger ? 'danger' : ''}`}
            aria-disabled={it.disabled || undefined}
            aria-selected={active === i}
            disabled={it.disabled}
            tabIndex={-1}
            onMouseEnter={() => setActive(i)}
            onClick={() => select(i)}
          >
            {it.icon}
            <span>{it.label}</span>
            {it.hint && <span className="hint">{it.hint}</span>}
          </button>
        )
      })}
    </div>
  )
}
