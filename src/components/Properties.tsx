/**
 * Frontmatter properties editor. Each change is applied by the Rust core as
 * a surgical edit of that one key; everything else in the frontmatter is
 * left byte-for-byte untouched.
 */
import { useEffect, useState } from 'react'
import { Calendar, CheckSquare, Hash, Lock, Tags, Type, X } from 'lucide-react'
import { confirmDialog, promptDialog } from '../store'
import { openMenu } from '../ui/Menu'

type Value = unknown
const READONLY = new Set(['id', 'created'])
const isDate = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)

function kindOf(v: Value): 'checkbox' | 'number' | 'date' | 'tags' | 'text' | 'complex' {
  if (typeof v === 'boolean') return 'checkbox'
  if (typeof v === 'number') return 'number'
  if (Array.isArray(v)) return v.every((x) => typeof x === 'string' || typeof x === 'number') ? 'tags' : 'complex'
  if (v !== null && typeof v === 'object') return 'complex'
  if (isDate(v)) return 'date'
  return 'text'
}

const ICON = { checkbox: <CheckSquare />, number: <Hash />, date: <Calendar />, tags: <Tags />, text: <Type />, complex: <Lock /> }

export function Properties(props: { properties: Record<string, Value>; onSet: (key: string, value: Value | null) => Promise<void>; disabled: boolean }) {
  // Identity fields written by the app are shown in the info panel instead.
  const entries = Object.entries(props.properties).filter(([k]) => !READONLY.has(k))
  if (!entries.length) return null
  return (
    <section className="properties" aria-label="Propriedades">
      {entries.map(([k, v]) => (
        <div className="prop-row" key={k}>
          <span className="prop-key" title={k}>
            {READONLY.has(k) ? <Lock aria-hidden /> : <span aria-hidden>{ICON[kindOf(v)]}</span>}
            {k}
          </span>
          <div className="prop-value">
            <PropValue name={k} value={v} disabled={props.disabled || READONLY.has(k)} onCommit={(nv) => props.onSet(k, nv)} />
          </div>
          {!READONLY.has(k) && !props.disabled ? (
            <button
              className="icon-btn"
              aria-label={`Remover propriedade ${k}`}
              onClick={async () => {
                if (await confirmDialog({ title: 'Remover propriedade?', message: `A propriedade “${k}” será removida do frontmatter deste arquivo.`, confirmLabel: 'Remover', danger: true }))
                  await props.onSet(k, null)
              }}
            >
              <X />
            </button>
          ) : (
            <span />
          )}
        </div>
      ))}
    </section>
  )
}

export async function addProperty(anchor: HTMLElement, existing: Record<string, unknown>, onSet: (key: string, value: unknown) => Promise<void>) {
  const name = await promptDialog({ title: 'Nova propriedade', label: 'Nome (letras, números, espaço, _ - .)', initial: '', confirmLabel: 'Continuar' })
  if (!name) return
  if (name in existing) return
  const pick = (value: unknown) => void onSet(name, value)
  const today = new Date().toISOString().slice(0, 10)
  openMenu(
    anchor,
    [
      { header: 'Tipo da propriedade' },
      { label: 'Texto', icon: <Type />, onSelect: () => pick('') },
      { label: 'Número', icon: <Hash />, onSelect: () => pick(0) },
      { label: 'Data', icon: <Calendar />, onSelect: () => pick(today) },
      { label: 'Caixa de seleção', icon: <CheckSquare />, onSelect: () => pick(false) },
      { label: 'Tags / lista', icon: <Tags />, onSelect: () => pick([]) },
    ],
    'Tipo da propriedade',
  )
}

function PropValue({ name, value, disabled, onCommit }: { name: string; value: Value; disabled: boolean; onCommit: (v: Value) => Promise<void> }) {
  const kind = kindOf(value)
  const [draft, setDraft] = useState(() => (kind === 'number' ? String(value) : typeof value === 'string' ? value : ''))
  useEffect(() => setDraft(kind === 'number' ? String(value) : typeof value === 'string' ? value : ''), [value, kind])
  const label = `Valor de ${name}`
  if (disabled && kind !== 'checkbox' && kind !== 'tags') {
    return <div className="readonly">{typeof value === 'string' ? value : JSON.stringify(value)}</div>
  }
  switch (kind) {
    case 'checkbox':
      return <input type="checkbox" aria-label={label} checked={Boolean(value)} disabled={disabled} onChange={(e) => void onCommit(e.target.checked)} />
    case 'number':
      return (
        <input
          type="number"
          aria-label={label}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            const n = Number(draft)
            if (draft.trim() !== '' && Number.isFinite(n) && n !== value) void onCommit(n)
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      )
    case 'date':
      return <input type="date" aria-label={label} value={draft} onChange={(e) => e.target.value && void onCommit(e.target.value)} />
    case 'tags':
      return <TagEditor label={label} tags={(value as unknown[]).map(String)} disabled={disabled} onChange={(t) => void onCommit(t)} />
    case 'complex':
      return (
        <div className="readonly" title="Estrutura complexa preservada como está; edite-a em um editor de texto.">
          {JSON.stringify(value)}
        </div>
      )
    default:
      return (
        <input
          type="text"
          aria-label={label}
          value={draft}
          placeholder="Vazio"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => draft !== value && void onCommit(draft)}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      )
  }
}

function TagEditor({ tags, onChange, disabled, label }: { tags: string[]; onChange: (t: string[]) => void; disabled: boolean; label: string }) {
  const [text, setText] = useState('')
  const add = () => {
    const parts = text
      .split(',')
      .map((t) => t.trim().replace(/^#/, ''))
      .filter((t) => t && !tags.includes(t))
    setText('')
    if (parts.length) onChange([...tags, ...parts])
  }
  return (
    <div className="chips" aria-label={label}>
      {tags.map((t) => (
        <span className="chip" key={t}>
          {t}
          {!disabled && (
            <button aria-label={`Remover ${t}`} onClick={() => onChange(tags.filter((x) => x !== t))}>
              <X style={{ width: '0.7rem', height: '0.7rem' }} />
            </button>
          )}
        </span>
      ))}
      {!disabled && (
        <input
          type="text"
          aria-label={`Adicionar a ${label}`}
          placeholder={tags.length ? '' : 'Adicionar…'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault()
              add()
            } else if (e.key === 'Backspace' && !text && tags.length) onChange(tags.slice(0, -1))
          }}
          onBlur={add}
        />
      )}
    </div>
  )
}

