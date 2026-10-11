import { useEffect, useState } from 'react'
import { ArchiveRestore, FileText, Folder, Trash2 } from 'lucide-react'
import { api, isMarkdown, pathName, pathStem, type DiffLine, type TrashEntry, type Version } from '../api'
import { confirmDialog, flushAll, openPage, refreshTree, setOverlay, toast, toastError, useApp } from '../store'
import { Modal } from '../ui/Modal'
import { DiffView } from './PageView'
import { TopBar } from './TopBar'

const fmt = (ms: number) => new Date(ms).toLocaleString('pt-BR', { dateStyle: 'medium', timeStyle: 'short' })
const size = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`)

export function HistoryDialog() {
  const route = useApp((s) => s.route)
  const path = route.kind === 'page' ? route.path : null
  const [versions, setVersions] = useState<Version[] | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [view, setView] = useState<{ content: string; diff: DiffLine[] } | null>(null)
  const [mode, setMode] = useState<'diff' | 'content'>('diff')
  const close = () => setOverlay(null)

  useEffect(() => {
    if (!path) return
    void (async () => {
      await flushAll()
      const v = await api.historyList(path).catch(() => [])
      setVersions(v)
      if (v[0]) setSelected(v[0].timestamp)
    })()
  }, [path])

  useEffect(() => {
    if (!path || selected === null) return
    api.historyRead(path, selected).then(setView).catch(toastError)
  }, [path, selected])

  if (!path) return null
  const restore = async () => {
    if (selected === null) return
    const ok = await confirmDialog({
      title: 'Restaurar esta versão?',
      message: `O arquivo voltará ao conteúdo de ${fmt(selected)}. A versão atual será guardada no histórico antes, então esta ação pode ser desfeita.`,
      confirmLabel: 'Restaurar',
    })
    if (!ok) return
    try {
      await flushAll()
      await api.historyRestore(path, selected)
      toast('Versão restaurada.', 'success')
      close()
      useApp.setState((s) => ({ externalChange: { seq: s.externalChange.seq + 1, paths: [path] } }))
    } catch (e) {
      toastError(e)
    }
  }
  return (
    <Modal onClose={close} label="Histórico de versões" className="dialog wide">
      <h2>Histórico de “{pathStem(path)}”</h2>
      <p>
        Versões anteriores ficam em <code>.note4me/history</code>, ao lado das suas páginas. Uma versão é guardada no máximo a cada intervalo configurado e sempre antes de
        sobrescrever uma alteração externa.
      </p>
      {versions === null ? (
        <p role="status">Carregando…</p>
      ) : versions.length === 0 ? (
        <p className="muted">Ainda não há versões anteriores desta página.</p>
      ) : (
        <div className="history-layout">
          <div className="history-list" role="listbox" aria-label="Versões">
            {versions.map((v) => (
              <button key={v.timestamp} role="option" aria-selected={selected === v.timestamp} className="palette-item" onClick={() => setSelected(v.timestamp)}>
                <span className="title">{fmt(v.timestamp)}</span>
                <span className="meta">{size(v.size)}</span>
              </button>
            ))}
          </div>
          <div style={{ minWidth: 0 }}>
            <div className="segmented" role="group" aria-label="Modo de visualização" style={{ marginBottom: '0.6rem' }}>
              <button aria-pressed={mode === 'diff'} onClick={() => setMode('diff')}>
                Diferenças para a atual
              </button>
              <button aria-pressed={mode === 'content'} onClick={() => setMode('content')}>
                Conteúdo da versão
              </button>
            </div>
            {view && (mode === 'diff' ? <DiffView lines={view.diff} /> : <div className="diff"><div>{view.content}</div></div>)}
          </div>
        </div>
      )}
      <div className="dialog-actions">
        <button className="btn" onClick={close}>
          Fechar
        </button>
        <button className="btn primary" disabled={selected === null} onClick={() => void restore()}>
          Restaurar esta versão
        </button>
      </div>
    </Modal>
  )
}

export function TrashView() {
  const [items, setItems] = useState<TrashEntry[] | null>(null)
  const load = () => api.trashList().then(setItems).catch(toastError)
  useEffect(() => void load(), [])
  const restore = async (t: TrashEntry) => {
    try {
      const p = await api.trashRestore(t.id)
      refreshTree()
      await load()
      toast(`Restaurado em “${p}”.`, 'success', isMarkdown(p) ? { label: 'Abrir', run: () => void openPage(p) } : undefined)
    } catch (e) {
      toastError(e)
    }
  }
  const purge = async (t: TrashEntry) => {
    const ok = await confirmDialog({ title: 'Excluir permanentemente?', message: `“${pathName(t.original)}” será apagado do disco. Isso não pode ser desfeito.`, confirmLabel: 'Excluir', danger: true })
    if (!ok) return
    await api.trashPurge(t.id).catch(toastError)
    await load()
  }
  const empty = async () => {
    const ok = await confirmDialog({ title: 'Esvaziar a lixeira?', message: `${items?.length ?? 0} item(ns) serão apagados do disco permanentemente.`, confirmLabel: 'Esvaziar', danger: true })
    if (!ok) return
    await api.trashEmpty().catch(toastError)
    await load()
  }
  return (
    <>
      <TopBar left={<strong style={{ padding: '0 0.4rem' }}>Lixeira</strong>} right={items && items.length > 0 ? <button className="btn small danger" onClick={() => void empty()}>Esvaziar lixeira</button> : undefined} />
      <div className="main-scroll">
        <div className="page">
          <div className="page-inner">
            <p className="muted">
              Itens excluídos ficam em <code>.note4me/trash</code> dentro do espaço de trabalho até você esvaziar a lixeira.
            </p>
            {items?.length === 0 && (
              <div className="empty" style={{ marginTop: '8vh' }}>
                <h2>A lixeira está vazia</h2>
              </div>
            )}
            <ul className="link-list">
              {items?.map((t) => (
                <li key={t.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.35rem 0', borderBottom: '1px solid var(--c-border)' }}>
                  {t.isFolder ? <Folder aria-hidden style={{ width: '1rem' }} /> : <FileText aria-hidden style={{ width: '1rem' }} />}
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <strong>{t.isFolder ? pathName(t.original) : pathStem(t.original)}</strong>
                    <div className="muted" style={{ fontSize: '0.9rem' }}>
                      {t.original} · excluído em {fmt(t.deletedAt)}
                      {t.children ? ' · com subpáginas' : ''}
                    </div>
                  </span>
                  <button className="btn small" onClick={() => void restore(t)}>
                    <ArchiveRestore aria-hidden /> Restaurar
                  </button>
                  <button className="icon-btn" aria-label={`Excluir ${pathName(t.original)} permanentemente`} onClick={() => void purge(t)}>
                    <Trash2 />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </>
  )
}
