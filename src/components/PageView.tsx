/**
 * One open page: loads the file, runs the autosave loop, and resolves
 * conflicts with external edits without ever overwriting them silently.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArchiveRestore,
  Clock,
  Copy,
  FileText,
  FolderInput,
  History,
  Info,
  Link2,
  MoreHorizontal,
  Paperclip,
  Plus,
  Star,
  Table2,
  Trash2,
} from 'lucide-react'
import { api, childrenDir, errorMessage, isCoreError, pathParent, pathStem, type Backlink, type BrokenLink, type CoreError, type DiffLine, type PageDoc, type TreeEntry } from '../api'
import { deleteEntry, duplicatePage, exportPage, renameEntry, reveal, toggleFavorite } from '../actions'
import { Editor, type EditorHandle } from '../editor/Editor'
import { navigate, openPage, refreshNav, registerFlush, setOverlay, toast, toastError, useApp } from '../store'
import { openMenu } from '../ui/Menu'
import { Modal } from '../ui/Modal'
import { pageCommands } from '../pageCommands'
import { addProperty, Properties } from './Properties'
import { Crumbs, TopBar, useScrolled } from './TopBar'

type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict' | 'readonly'

interface Conflict {
  diskBody: string | null
  diskHash: string | null
  deleted: boolean
  /** True when detected from a file-watcher event rather than a save. */
  external: boolean
}

const STATE_LABEL: Record<SaveState, string> = {
  saved: 'Salvo',
  dirty: 'Alterações não salvas',
  saving: 'Salvando…',
  error: 'Erro ao salvar',
  conflict: 'Conflito',
  readonly: 'Somente leitura',
}

const fmtDate = (ms: number) => new Date(ms).toLocaleString('pt-BR', { dateStyle: 'medium', timeStyle: 'short' })

export function PageView({ path }: { path: string }) {
  const settings = useApp((s) => s.settings)
  const externalChange = useApp((s) => s.externalChange)
  const treeVersion = useApp((s) => s.treeVersion)
  const favorites = useApp((s) => s.nav.favorites)
  const infoPanel = useApp((s) => s.infoPanel)

  const [doc, setDoc] = useState<PageDoc | null>(null)
  const [loadError, setLoadError] = useState<CoreError | null>(null)
  const [loadKey, setLoadKey] = useState('')
  const [editorBody, setEditorBody] = useState('')
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [conflict, setConflict] = useState<Conflict | null>(null)
  const [diff, setDiff] = useState<DiffLine[] | null>(null)
  const [backlinks, setBacklinks] = useState<Backlink[]>([])
  const [broken, setBroken] = useState<BrokenLink[]>([])
  const [subpages, setSubpages] = useState<TreeEntry[]>([])
  const [words, setWords] = useState(0)
  const [title, setTitle] = useState(pathStem(path))

  const editorRef = useRef<EditorHandle>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrolled = useScrolled(scrollRef)
  const base = useRef<{ hash: string | null; body: string }>({ hash: null, body: '' })
  const version = useRef(0)
  const savedVersion = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const inflight = useRef<Promise<void> | null>(null)
  const conflictRef = useRef<Conflict | null>(null)
  conflictRef.current = conflict
  const pathRef = useRef(path)
  pathRef.current = path

  const refreshLinks = useCallback(async () => {
    const p = pathRef.current
    const [bl, br] = await Promise.all([api.backlinks(p).catch(() => []), api.brokenLinks(p).catch(() => [])])
    if (p !== pathRef.current) return
    setBacklinks(bl)
    setBroken(br)
    editorRef.current?.setBrokenLinks(br.map((b) => b.dest))
  }, [])

  const applyDoc = useCallback((d: PageDoc, body = d.body) => {
    base.current = { hash: d.hash, body: d.body }
    version.current = 0
    savedVersion.current = 0
    setDoc(d)
    setTitle(pathStem(d.path))
    setEditorBody(body)
    setLoadKey(`${d.path}:${d.hash}:${Date.now()}`)
    setConflict(null)
    setSaveError(null)
    setSaveState(d.readOnly ? 'readonly' : 'saved')
  }, [])

  // ----- Load ---------------------------------------------------------------
  useEffect(() => {
    let alive = true
    setLoadError(null)
    setDoc(null)
    api
      .pageRead(path)
      .then((d) => {
        if (!alive) return
        applyDoc(d)
        void refreshNav()
      })
      .catch((e) => alive && setLoadError(isCoreError(e) ? e : { kind: 'io', message: errorMessage(e) }))
    return () => {
      alive = false
    }
  }, [path, applyDoc])

  useEffect(() => {
    if (doc) void refreshLinks()
  }, [doc, refreshLinks, treeVersion])

  useEffect(() => {
    let alive = true
    api
      .treeList(childrenDir(path))
      .then((l) => alive && setSubpages(l.filter((e) => e.kind !== 'file')))
      .catch(() => alive && setSubpages([]))
    return () => {
      alive = false
    }
  }, [path, treeVersion])

  // ----- Save -----------------------------------------------------------------
  const save = useCallback(async (force = false): Promise<void> => {
    if (inflight.current) await inflight.current
    clearTimeout(timer.current)
    const ed = editorRef.current
    const p = pathRef.current
    if (!ed || (!force && (version.current === savedVersion.current || conflictRef.current))) return
    const startedAt = version.current
    const md = ed.getMarkdown()
    if (!force && md === base.current.body) {
      savedVersion.current = startedAt
      setSaveState('saved')
      return
    }
    setSaveState('saving')
    const run = (async () => {
      try {
        const out = await api.pageSave(p, md, base.current.hash, force)
        if (p !== pathRef.current) return
        if (out.status === 'conflict') {
          setConflict({ diskBody: out.diskBody, diskHash: out.diskHash, deleted: out.deleted, external: false })
          setSaveState('conflict')
          return
        }
        base.current = { hash: out.hash, body: md }
        savedVersion.current = startedAt
        setConflict(null)
        setSaveError(null)
        setSaveState(version.current === startedAt ? 'saved' : 'dirty')
        if (out.status === 'saved') void refreshLinks()
      } catch (e) {
        setSaveError(errorMessage(e))
        setSaveState('error')
      }
    })()
    inflight.current = run
    await run
    inflight.current = null
  }, [refreshLinks])

  useEffect(() => registerFlush(() => save()), [save])

  const onChange = useCallback(() => {
    version.current++
    if (conflictRef.current) return
    setSaveState('dirty')
    clearTimeout(timer.current)
    if (settings?.editor.autosave !== false) {
      timer.current = setTimeout(() => void save(), settings?.editor.autosaveDelayMs ?? 800)
    }
    if (settings?.editor.showWordCount) {
      setWords(editorRef.current?.wordCount() ?? 0)
    }
  }, [save, settings?.editor.autosave, settings?.editor.autosaveDelayMs, settings?.editor.showWordCount])

  useEffect(() => {
    if (doc) setWords(editorRef.current?.wordCount() ?? 0)
  }, [doc, loadKey])

  // Retry failed saves periodically (e.g. a disconnected volume coming back).
  useEffect(() => {
    if (saveState !== 'error') return
    const t = setTimeout(() => void save(), 8000)
    return () => clearTimeout(t)
  }, [saveState, save])

  // ----- External changes ---------------------------------------------------------
  useEffect(() => {
    if (!externalChange.seq || !doc) return
    const p = pathRef.current
    const touched = externalChange.paths.some((x) => x === p || p.startsWith(x + '/'))
    if (!touched) return
    void (async () => {
      try {
        const fresh = await api.pageRead(p)
        if (fresh.hash === base.current.hash) {
          // Our own write, or a touch that left the content unchanged.
          setDoc((d) => (d ? { ...d, properties: fresh.properties, modified: fresh.modified } : d))
          return
        }
        if (version.current === savedVersion.current && !conflictRef.current) {
          applyDoc(fresh)
          toast('A página foi atualizada com alterações feitas fora do note4me.')
        } else {
          setConflict({ diskBody: fresh.body, diskHash: fresh.hash, deleted: false, external: true })
          setSaveState('conflict')
        }
      } catch (e) {
        if (isCoreError(e) && e.kind === 'notFound') {
          if (version.current !== savedVersion.current) {
            setConflict({ diskBody: null, diskHash: null, deleted: true, external: true })
            setSaveState('conflict')
          } else {
            setLoadError({ kind: 'notFound', message: 'O arquivo foi movido ou excluído fora do note4me.' })
          }
        }
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalChange.seq])

  // ----- Conflict resolution ---------------------------------------------------------
  const useDisk = async () => {
    try {
      const fresh = await api.pageRead(path)
      await api.draftDiscard(path)
      applyDoc(fresh)
    } catch (e) {
      toastError(e)
    }
  }
  const keepMine = async () => {
    setConflict(null)
    conflictRef.current = null
    await save(true)
  }
  const saveMineAsCopy = async () => {
    const md = editorRef.current?.getMarkdown() ?? ''
    try {
      const copy = await api.pageSaveCopy(path, md)
      toast('Sua versão foi salva como uma página separada.', 'success', { label: 'Abrir cópia', run: () => void openPage(copy) })
      if (conflict?.deleted) await openPage(copy)
      else await useDisk()
    } catch (e) {
      toastError(e)
    }
  }
  const compare = async () => {
    const mine = editorRef.current?.getMarkdown() ?? ''
    setDiff(await api.textDiff(conflict?.diskBody ?? '', mine))
  }

  // ----- Properties --------------------------------------------------------------------
  const setProperty = async (key: string, value: unknown | null) => {
    if (inflight.current) await inflight.current
    try {
      const out = await api.propertySet(path, key, value, base.current.hash)
      if (out.status === 'conflict') {
        setConflict({ diskBody: out.diskBody, diskHash: out.diskHash, deleted: out.deleted, external: false })
        setSaveState('conflict')
        return
      }
      base.current.hash = out.hash
      const fresh = await api.pageRead(path)
      base.current.hash = fresh.hash
      setDoc((d) => (d ? { ...d, properties: fresh.properties, frontmatter: fresh.frontmatter, frontmatterError: fresh.frontmatterError, hash: fresh.hash } : d))
    } catch (e) {
      toastError(e, 'Não foi possível alterar a propriedade')
    }
  }

  // ----- Commands for menu bar and app shell -------------------------------------------------
  useEffect(() => {
    pageCommands.current = {
      path,
      save: () => save(),
      undo: () => editorRef.current?.undo() ?? false,
      redo: () => editorRef.current?.redo() ?? false,
      editorContains: (el) => editorRef.current?.contains(el) ?? false,
      insertFiles: (paths, at) => editorRef.current?.insertFiles(paths, at) ?? Promise.resolve(),
      copyMarkdown: async () => {
        await save()
        const fm = doc?.frontmatter != null ? `---\n${doc.frontmatter}---\n` : ''
        await navigator.clipboard.writeText(fm + (editorRef.current?.getMarkdown() ?? ''))
        toast('Markdown copiado para a área de transferência.', 'success')
      },
    }
    return () => {
      if (pageCommands.current?.path === path) pageCommands.current = null
    }
  }, [path, save, doc])

  const commitTitle = async () => {
    const t = title.trim()
    if (!t || t === pathStem(path)) {
      setTitle(pathStem(path))
      return
    }
    const newPath = await renameEntry(path, t)
    if (!newPath) setTitle(pathStem(path))
  }

  const isFav = favorites.some((f) => f.path === path)
  const moreMenu = (el: HTMLElement) =>
    openMenu(
      el,
      [
        { label: 'Copiar Markdown', icon: <Copy />, hint: '⌥⌘C', onSelect: () => void pageCommands.current?.copyMarkdown() },
        { label: 'Histórico de versões…', icon: <History />, hint: '⌥⌘H', onSelect: () => setOverlay('history') },
        { label: 'Duplicar', icon: <Copy />, onSelect: () => void duplicatePage(path) },
        { label: 'Exportar com anexos…', icon: <Paperclip />, onSelect: () => void exportPage(path) },
        { label: 'Mostrar no Finder', icon: <FolderInput />, hint: '⌥⌘R', onSelect: () => void reveal(path) },
        { separator: true },
        { label: 'Mover para a lixeira', icon: <Trash2 />, danger: true, onSelect: () => void deleteEntry({ path, kind: 'page', hasChildren: subpages.length > 0 }) },
      ],
      'Ações da página',
    )

  const topRight = (
    <>
      <span className="save-state" data-state={saveState} role="status" aria-live="polite">
        <span className="dot" aria-hidden />
        {STATE_LABEL[saveState]}
      </span>
      <button className="icon-btn" aria-pressed={isFav} aria-label={isFav ? 'Remover dos favoritos' : 'Adicionar aos favoritos'} title="Favorito" onClick={() => void toggleFavorite(path)}>
        <Star fill={isFav ? 'currentColor' : 'none'} />
      </button>
      <button className="icon-btn" aria-pressed={infoPanel} aria-label="Painel de informações" title="Informações (⌥⌘I)" onClick={() => useApp.setState({ infoPanel: !infoPanel })}>
        <Info />
      </button>
      <button className="icon-btn" aria-label="Mais ações da página" onClick={(e) => moreMenu(e.currentTarget)}>
        <MoreHorizontal />
      </button>
    </>
  )

  if (loadError) {
    return (
      <>
        <TopBar left={<Crumbs path={path} />} />
        <div className="main-scroll">
          <div className="empty" role="alert">
            <h2>{loadError.kind === 'invalidEncoding' ? 'Este arquivo não pode ser editado aqui' : loadError.kind === 'notFound' ? 'Página não encontrada' : 'Não foi possível abrir a página'}</h2>
            <p>
              {loadError.kind === 'invalidEncoding'
                ? 'O arquivo não está em UTF-8. Para não corromper o conteúdo, o note4me não o edita. Abra-o em outro editor para convertê-lo.'
                : loadError.message}
            </p>
            {loadError.kind !== 'notFound' && (
              <div className="welcome-actions" style={{ justifyContent: 'center' }}>
                <button className="btn" onClick={() => void api.openWithDefaultApp(path).catch(toastError)}>
                  Abrir no app padrão
                </button>
                <button className="btn" onClick={() => void reveal(path)}>
                  Mostrar no Finder
                </button>
              </div>
            )}
          </div>
        </div>
      </>
    )
  }

  if (!doc) {
    return (
      <>
        <TopBar left={<Crumbs path={path} />} />
        <div className="main-scroll" aria-busy="true">
          <p className="sr-only" role="status">
            Carregando página…
          </p>
        </div>
      </>
    )
  }

  const editable = !doc.readOnly
  return (
    <>
      <TopBar left={<Crumbs path={path} />} right={topRight} scrolled={scrolled} />
      <div className="main-body">
        <div className="main-scroll" ref={scrollRef}>
          <article className="page">
            <div className="page-inner">
              {doc.draft && version.current === 0 && (
                <div className="banner" data-kind="warning" role="alert">
                  <ArchiveRestore aria-hidden />
                  <span className="banner-text">Há alterações não salvas de {fmtDate(doc.draft.savedAt)} que não chegaram ao arquivo.</span>
                  <span className="banner-actions">
                    <button
                      className="btn small primary"
                      onClick={() => {
                        const draft = doc.draft!
                        setDoc({ ...doc, draft: null })
                        setEditorBody(draft.body)
                        setLoadKey(`${path}:draft:${Date.now()}`)
                        version.current = 1
                        setSaveState('dirty')
                        setTimeout(() => void save(), 50)
                      }}
                    >
                      Restaurar
                    </button>
                    <button
                      className="btn small"
                      onClick={() => {
                        void api.draftDiscard(path)
                        setDoc({ ...doc, draft: null })
                      }}
                    >
                      Descartar
                    </button>
                  </span>
                </div>
              )}
              {conflict && (
                <div className="banner" data-kind="danger" role="alert">
                  <AlertTriangle aria-hidden />
                  <span className="banner-text">
                    {conflict.deleted
                      ? 'O arquivo desta página foi removido ou movido fora do note4me enquanto você editava. Suas alterações não foram perdidas.'
                      : 'Este arquivo foi alterado fora do note4me. Nada foi sobrescrito — escolha qual versão manter.'}
                  </span>
                  <span className="banner-actions">
                    {!conflict.deleted && (
                      <button className="btn small" onClick={() => void compare()}>
                        Comparar
                      </button>
                    )}
                    {!conflict.deleted && (
                      <button className="btn small" onClick={() => void useDisk()}>
                        Usar a versão do disco
                      </button>
                    )}
                    <button className="btn small" onClick={() => void saveMineAsCopy()}>
                      Salvar a minha como cópia
                    </button>
                    <button className="btn small primary" onClick={() => void keepMine()}>
                      {conflict.deleted ? 'Recriar com a minha versão' : 'Manter a minha'}
                    </button>
                  </span>
                </div>
              )}
              {saveState === 'error' && (
                <div className="banner" data-kind="danger" role="alert">
                  <AlertTriangle aria-hidden />
                  <span className="banner-text">
                    Não foi possível salvar: {saveError}. Suas alterações estão preservadas como rascunho de recuperação e uma nova tentativa será feita automaticamente.
                  </span>
                  <span className="banner-actions">
                    <button className="btn small" onClick={() => void save(false)}>
                      Tentar agora
                    </button>
                  </span>
                </div>
              )}
              {doc.readOnly && (
                <div className="banner" role="note">
                  <Info aria-hidden />
                  <span className="banner-text">Este arquivo é somente leitura no disco; edições estão desativadas.</span>
                </div>
              )}
              {doc.frontmatterError && (
                <div className="banner" data-kind="warning" role="note">
                  <AlertTriangle aria-hidden />
                  <span className="banner-text">O frontmatter YAML deste arquivo é inválido. Ele é mantido exatamente como está; as propriedades só podem ser editadas depois de corrigido. ({doc.frontmatterError})</span>
                </div>
              )}
              <textarea
                className="page-title"
                aria-label="Título da página (nome do arquivo)"
                rows={1}
                value={title}
                disabled={!editable}
                placeholder="Sem título"
                onChange={(e) => setTitle(e.target.value.replace(/\n/g, ''))}
                onBlur={() => void commitTitle()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void commitTitle()
                    editorRef.current?.focus()
                  } else if (e.key === 'Escape') {
                    setTitle(pathStem(path))
                  }
                }}
              />
              <div className="page-meta">
                <span>Editado {fmtDate(doc.modified)}</span>
                {settings?.editor.showWordCount && <span>{words} palavra{words === 1 ? '' : 's'}</span>}
                {backlinks.length > 0 && (
                  <a href="#backlinks" style={{ color: 'inherit' }}>
                    {backlinks.length} referência{backlinks.length === 1 ? '' : 's'}
                  </a>
                )}
                {editable && !doc.frontmatterError && (
                  <button className="btn small ghost" onClick={(e) => void addProperty(e.currentTarget, doc.properties, setProperty)} style={{ marginLeft: '-0.5rem' }}>
                    <Plus aria-hidden /> Propriedade
                  </button>
                )}
              </div>
              <Properties properties={doc.properties} onSet={setProperty} disabled={!editable || Boolean(doc.frontmatterError)} />
              <Editor ref={editorRef} pagePath={path} body={editorBody} loadKey={loadKey} editable={editable && !conflict} onChange={onChange} />

              {subpages.length > 0 && (
                <section className="subpages" aria-labelledby="subpages-title">
                  <h2 className="section-title" id="subpages-title">
                    Subpáginas
                    <button className="btn small ghost" onClick={() => void navigate({ kind: 'collection', folder: childrenDir(path) })}>
                      <Table2 aria-hidden /> Ver como coleção
                    </button>
                  </h2>
                  <ul className="link-list">
                    {subpages.map((s) => (
                      <li key={s.path}>
                        <button onClick={() => (s.kind === 'page' ? void openPage(s.path) : void navigate({ kind: 'collection', folder: s.path }))}>
                          <FileText aria-hidden /> {s.name}
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {backlinks.length > 0 && (
                <section className="subpages" id="backlinks" aria-labelledby="backlinks-title">
                  <h2 className="section-title" id="backlinks-title">
                    Referências a esta página
                  </h2>
                  <ul className="link-list">
                    {backlinks.map((b) => (
                      <li key={b.path}>
                        <button onClick={() => void openPage(b.path)}>
                          <Link2 aria-hidden /> {b.title} <span className="muted">{pathParent(b.path)}</span>
                        </button>
                        {b.contexts.slice(0, 2).map((c, i) => (
                          <div className="context" key={i}>
                            {c}
                          </div>
                        ))}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          </article>
        </div>
        {infoPanel && (
          <aside className="info-panel" aria-label="Informações da página">
            <h3>Arquivo</h3>
            <dl>
              <dt>Caminho</dt>
              <dd>{path}</dd>
              <dt>Modificado</dt>
              <dd>{fmtDate(doc.modified)}</dd>
              {typeof doc.properties.created === 'string' && (
                <>
                  <dt>Criado</dt>
                  <dd>{fmtDate(Date.parse(doc.properties.created))}</dd>
                </>
              )}
              {typeof doc.properties.id === 'string' && (
                <>
                  <dt>ID</dt>
                  <dd style={{ fontFamily: 'var(--font-code)', fontSize: '0.85rem' }}>{doc.properties.id}</dd>
                </>
              )}
              <dt>Palavras</dt>
              <dd>{words}</dd>
            </dl>
            <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.75rem', flexWrap: 'wrap' }}>
              <button className="btn small" onClick={() => void reveal(path)}>
                <FolderInput aria-hidden /> Finder
              </button>
              <button className="btn small" onClick={() => setOverlay('history')}>
                <Clock aria-hidden /> Histórico
              </button>
            </div>
            <h3>Referências ({backlinks.length})</h3>
            {backlinks.length === 0 ? (
              <p className="muted">Nenhuma página aponta para esta.</p>
            ) : (
              <ul className="link-list">
                {backlinks.map((b) => (
                  <li key={b.path}>
                    <button onClick={() => void openPage(b.path)}>{b.title}</button>
                  </li>
                ))}
              </ul>
            )}
            <h3>Links quebrados ({broken.length})</h3>
            {broken.length === 0 ? (
              <p className="muted">Todos os links desta página funcionam.</p>
            ) : (
              <ul className="link-list">
                {broken.map((b, i) => (
                  <li key={i} className="error-text" style={{ overflowWrap: 'anywhere', padding: '0.2rem 0.5rem' }}>
                    {b.dest}
                  </li>
                ))}
              </ul>
            )}
          </aside>
        )}
      </div>
      {diff && (
        <Modal onClose={() => setDiff(null)} label="Comparar versões" className="dialog wide">
          <h2>Disco × sua versão</h2>
          <p>Linhas em vermelho existem só no arquivo do disco; em verde, só na sua versão.</p>
          <DiffView lines={diff} />
          <div className="dialog-actions">
            <button className="btn" onClick={() => setDiff(null)} data-autofocus>
              Fechar
            </button>
          </div>
        </Modal>
      )}
    </>
  )
}

export function DiffView({ lines }: { lines: DiffLine[] }) {
  if (lines.every((l) => l.op === 'equal')) return <p className="muted">As versões são idênticas.</p>
  return (
    <div className="diff" role="region" aria-label="Diferenças">
      {lines.map((l, i) => (
        <div key={i} className={l.op}>
          <span className="sr-only">{l.op === 'insert' ? 'Adicionado: ' : l.op === 'delete' ? 'Removido: ' : ''}</span>
          {l.text || ' '}
        </div>
      ))}
    </div>
  )
}
