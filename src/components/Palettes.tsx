import { useEffect, useMemo, useState } from 'react'
import { FilePlus, FileText, Search } from 'lucide-react'
import { api, pathParent, type PageSummary, type SearchHit } from '../api'
import { newPage } from '../actions'
import { openPage, setOverlay, toastError } from '../store'
import { Modal } from '../ui/Modal'

function useListKeys(count: number, onEnter: (i: number, e: React.KeyboardEvent) => void) {
  const [active, setActive] = useState(0)
  useEffect(() => setActive((a) => Math.min(a, Math.max(0, count - 1))), [count])
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => (count ? (a + 1) % count : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => (count ? (a - 1 + count) % count : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      onEnter(active, e)
    }
  }
  return { active, setActive, onKeyDown }
}

export function QuickOpen() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<PageSummary[]>([])
  useEffect(() => {
    let alive = true
    const t = setTimeout(() => {
      api
        .quickFind(query, 30)
        .then((r) => alive && setResults(r))
        .catch(() => undefined)
    }, 40)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [query])
  const close = () => setOverlay(null)
  const create = async () => {
    close()
    await newPage('', query.trim() || undefined)
  }
  const { active, setActive, onKeyDown } = useListKeys(results.length + (query.trim() ? 1 : 0), (i, e) => {
    if (e.metaKey || i === results.length) return void create()
    const r = results[i]
    if (r) {
      close()
      void openPage(r.path)
    }
  })
  return (
    <Modal onClose={close} label="Ir para página" className="palette">
      <div className="palette-input">
        <Search aria-hidden />
        <input
          type="text"
          data-autofocus
          placeholder="Ir para página…"
          aria-label="Nome da página"
          aria-controls="quick-results"
          aria-activedescendant={`qo-${active}`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className="palette-list" role="listbox" id="quick-results" aria-label="Páginas">
        {results.map((r, i) => (
          <button
            key={r.path}
            id={`qo-${i}`}
            role="option"
            aria-selected={i === active}
            className="palette-item"
            onMouseEnter={() => setActive(i)}
            onClick={() => {
              close()
              void openPage(r.path)
            }}
          >
            <FileText aria-hidden style={{ width: '1rem', height: '1rem', flex: 'none' }} />
            <span className="title">{r.title}</span>
            <span className="meta">{pathParent(r.path)}</span>
          </button>
        ))}
        {query.trim() && (
          <button id={`qo-${results.length}`} role="option" aria-selected={active === results.length} className="palette-item" onMouseEnter={() => setActive(results.length)} onClick={() => void create()}>
            <FilePlus aria-hidden style={{ width: '1rem', height: '1rem', flex: 'none' }} />
            <span className="title">Criar página “{query.trim()}”</span>
            <span className="meta">⌘↩</span>
          </button>
        )}
        {!query.trim() && results.length === 0 && <div className="palette-empty">Nenhuma página ainda.</div>}
      </div>
      <div className="palette-foot">
        <span>
          <kbd>↑</kbd> <kbd>↓</kbd> navegar
        </span>
        <span>
          <kbd>↩</kbd> abrir
        </span>
        <span>
          <kbd>⌘↩</kbd> criar
        </span>
        <span>
          <kbd>esc</kbd> fechar
        </span>
      </div>
    </Modal>
  )
}

const DAY = 86_400_000

function highlight(text: string, terms: string[]) {
  if (!terms.length) return text
  const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
  // Character-aligned fold so match offsets map back onto the original text.
  const folded = [...text].map((c) => fold(c)[0] ?? c).join('')
  const ranges: [number, number][] = []
  for (const t of terms) {
    const ft = fold(t)
    if (!ft) continue
    let i = folded.indexOf(ft)
    while (i >= 0 && ranges.length < 40) {
      ranges.push([i, i + ft.length])
      i = folded.indexOf(ft, i + ft.length)
    }
  }
  ranges.sort((a, b) => a[0] - b[0])
  const chars = [...text]
  const out: React.ReactNode[] = []
  let pos = 0
  ranges.forEach(([s, e], k) => {
    if (s < pos) return
    out.push(chars.slice(pos, s).join(''))
    out.push(<mark key={k}>{chars.slice(s, e).join('')}</mark>)
    pos = e
  })
  out.push(chars.slice(pos).join(''))
  return out
}

export function SearchPanel() {
  const [text, setText] = useState('')
  const [folder, setFolder] = useState('')
  const [tag, setTag] = useState('')
  const [since, setSince] = useState('any')
  const [folders, setFolders] = useState<string[]>([])
  const [tags, setTags] = useState<[string, number][]>([])
  const [hits, setHits] = useState<SearchHit[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api.foldersList().then(setFolders).catch(() => undefined)
    void api.tagsList().then(setTags).catch(() => undefined)
  }, [])

  useEffect(() => {
    let alive = true
    const modifiedAfter = since === '7' ? Date.now() - 7 * DAY : since === '30' ? Date.now() - 30 * DAY : since === '365' ? Date.now() - 365 * DAY : null
    if (!text.trim() && !folder && !tag && !modifiedAfter) {
      setHits([])
      return
    }
    setBusy(true)
    const t = setTimeout(() => {
      api
        .search({ text, folder: folder || null, tags: tag ? [tag] : [], modifiedAfter, limit: 200 })
        .then((h) => alive && setHits(h))
        .catch(toastError)
        .finally(() => alive && setBusy(false))
    }, 120)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [text, folder, tag, since])

  const terms = useMemo(
    () =>
      (text.match(/"[^"]+"|\S+/g) ?? [])
        .map((t) => t.replace(/"/g, ''))
        .filter((t) => !t.startsWith('tag:') && !t.startsWith('path:') && !t.startsWith('#')),
    [text],
  )
  const close = () => setOverlay(null)
  const { active, setActive, onKeyDown } = useListKeys(hits.length, (i) => {
    const h = hits[i]
    if (h) {
      close()
      void openPage(h.path)
    }
  })

  return (
    <Modal onClose={close} label="Buscar no espaço de trabalho" className="palette" backdropClass="search-panel">
      <div className="palette-input">
        <Search aria-hidden />
        <input
          type="search"
          data-autofocus
          placeholder="Buscar em títulos, conteúdo, tags e propriedades…"
          aria-label="Termos de busca"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className="search-filters">
        <label className="sr-only" htmlFor="sf-folder">
          Pasta
        </label>
        <select id="sf-folder" value={folder} onChange={(e) => setFolder(e.target.value)}>
          <option value="">Todas as pastas</option>
          {folders.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="sf-tag">
          Tag
        </label>
        <select id="sf-tag" value={tag} onChange={(e) => setTag(e.target.value)}>
          <option value="">Todas as tags</option>
          {tags.map(([t, n]) => (
            <option key={t} value={t}>
              #{t} ({n})
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="sf-date">
          Data de modificação
        </label>
        <select id="sf-date" value={since} onChange={(e) => setSince(e.target.value)}>
          <option value="any">Qualquer data</option>
          <option value="7">Últimos 7 dias</option>
          <option value="30">Últimos 30 dias</option>
          <option value="365">Último ano</option>
        </select>
        <span className="muted" role="status" aria-live="polite" style={{ marginLeft: 'auto' }}>
          {busy ? 'Buscando…' : text || folder || tag || since !== 'any' ? `${hits.length} resultado${hits.length === 1 ? '' : 's'}` : ''}
        </span>
      </div>
      <div className="palette-list" role="listbox" aria-label="Resultados">
        {hits.map((h, i) => (
          <button
            key={h.path}
            role="option"
            aria-selected={i === active}
            className="palette-item"
            style={{ alignItems: 'flex-start', flexDirection: 'column', gap: '0.15rem' }}
            onMouseEnter={() => setActive(i)}
            onClick={() => {
              close()
              void openPage(h.path)
            }}
          >
            <span style={{ display: 'flex', width: '100%', gap: '0.5rem' }}>
              <span className="title" style={{ fontWeight: 550 }}>
                {highlight(h.title, terms)}
              </span>
              <span className="meta">{pathParent(h.path) || 'raiz'}</span>
            </span>
            {h.snippet && <span className="hit-snippet">{highlight(h.snippet, terms)}</span>}
          </button>
        ))}
        {!busy && hits.length === 0 && (text || folder || tag) && <div className="palette-empty">Nada encontrado.</div>}
      </div>
      <div className="palette-foot">
        <span>
          Use <kbd>"frase exata"</kbd>, <kbd>tag:nome</kbd> ou <kbd>path:Pasta</kbd>. A busca ignora maiúsculas e acentos.
        </span>
      </div>
    </Modal>
  )
}
