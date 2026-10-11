/** "Move to…" picker: choose a destination page or folder by name. */
import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { FileText, Folder, Home } from 'lucide-react'
import { api, childrenDir, pathName, pathParent, type PageSummary } from '../api'
import { moveEntry } from '../actions'
import { Modal } from '../ui/Modal'

const useMove = create<{ source: string | null }>(() => ({ source: null }))
export const openMovePicker = (source: string) => useMove.setState({ source })

export function MovePicker() {
  const source = useMove((s) => s.source)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<PageSummary[]>([])
  const [folders, setFolders] = useState<string[]>([])
  const [active, setActive] = useState(0)
  useEffect(() => {
    if (source) void api.foldersList().then(setFolders).catch(() => setFolders([]))
  }, [source])
  useEffect(() => {
    if (!source) return
    let alive = true
    void api.quickFind(query, 40).then((r) => {
      if (!alive) return
      const own = childrenDir(source)
      setResults(r.filter((p) => p.path !== source && !p.path.startsWith(own + '/')))
      setActive(0)
    })
    return () => {
      alive = false
    }
  }, [query, source])
  if (!source) return null
  const close = () => {
    useMove.setState({ source: null })
    setQuery('')
  }
  const q = query.trim().toLocaleLowerCase()
  const own = childrenDir(source)
  const folderOptions = folders
    .filter((f) => f !== own && !f.startsWith(own + '/') && f !== pathParent(source) && (!q || f.toLocaleLowerCase().includes(q)))
    .slice(0, 15)
    .map((f) => ({ label: pathName(f), dest: f, hint: pathParent(f) || 'pasta', icon: <Folder /> }))
  const options: { label: string; dest: string; hint: string; icon: React.ReactNode }[] = [
    ...(pathParent(source) !== '' ? [{ label: 'Raiz do espaço de trabalho', dest: '', hint: '', icon: <Home /> }] : []),
    ...folderOptions,
    ...results.map((p) => ({ label: p.title, dest: p.path, hint: pathParent(p.path) || 'página', icon: <FileText /> })),
  ]
  const choose = async (dest: string) => {
    close()
    await moveEntry(source, dest)
  }
  return (
    <Modal onClose={close} label="Mover para" className="palette">
      <div className="palette-input">
        <Folder aria-hidden />
        <input
          type="text"
          data-autofocus
          placeholder={`Mover “${pathName(source)}” para…`}
          aria-label="Buscar destino"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((a) => Math.min(options.length - 1, a + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((a) => Math.max(0, a - 1))
            } else if (e.key === 'Enter' && options[active]) {
              e.preventDefault()
              void choose(options[active]!.dest)
            }
          }}
        />
      </div>
      <div className="palette-list" role="listbox" aria-label="Destinos">
        {options.map((o, i) => (
          <button key={o.dest || 'root'} role="option" aria-selected={i === active} className="palette-item" onMouseEnter={() => setActive(i)} onClick={() => void choose(o.dest)}>
            {o.icon}
            <span className="title">{o.label}</span>
            <span className="meta">{o.hint}</span>
          </button>
        ))}
      </div>
      <div className="palette-foot">
        <span>Escolher uma página torna o item uma subpágina dela. Os links que apontam para ele são atualizados.</span>
      </div>
    </Modal>
  )
}
