import { useLayoutEffect, useRef, useState } from 'react'
import { usePopup } from './suggest'

/** Renders the active suggestion list (slash commands or page links). */
export function SuggestionPopup() {
  const { kind, items, active, rect, command } = usePopup()
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  useLayoutEffect(() => {
    if (!rect || !ref.current) return
    const h = ref.current.offsetHeight
    const below = rect.bottom + 6
    const y = below + h > innerHeight - 8 ? Math.max(8, rect.top - h - 6) : below
    setPos({ x: Math.min(rect.left, innerWidth - ref.current.offsetWidth - 8), y })
  }, [rect, items])
  useLayoutEffect(() => {
    ref.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])
  if (!kind || !rect) return null
  const label = kind === 'slash' ? 'Inserir bloco' : 'Link para página'
  return (
    <div ref={ref} className="menu slash-menu" role="listbox" aria-label={label} style={{ left: pos.x, top: pos.y }}>
      <div className="menu-label">{label}</div>
      {items.length === 0 && <div className="menu-label">{kind === 'link' ? 'Digite para buscar páginas' : 'Nenhum resultado'}</div>}
      {items.map((it, i) => (
        <button
          key={it.id}
          role="option"
          aria-selected={i === active}
          className="menu-item"
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => usePopup.setState({ active: i })}
          onClick={() => command?.(it)}
        >
          <span>
            {it.title}
            {it.subtitle && <small>{it.subtitle}</small>}
          </span>
        </button>
      ))}
    </div>
  )
}
