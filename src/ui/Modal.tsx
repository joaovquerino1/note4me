import { useEffect, useRef, type ReactNode } from 'react'

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Accessible modal: traps focus, closes on Escape, restores focus. */
export function Modal(props: { onClose: () => void; children: ReactNode; label: string; className?: string; backdropClass?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const el = ref.current
    const first = el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>(FOCUSABLE)
    first?.focus()
    return () => previous?.focus?.()
  }, [])
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      props.onClose()
      return
    }
    if (e.key !== 'Tab' || !ref.current) return
    const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null)
    if (!items.length) return
    const first = items[0]!
    const last = items[items.length - 1]!
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }
  return (
    <div className={`backdrop ${props.backdropClass ?? ''}`} onMouseDown={(e) => e.target === e.currentTarget && props.onClose()} onKeyDown={onKeyDown}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={props.label} className={props.className ?? 'dialog'}>
        {props.children}
      </div>
    </div>
  )
}
