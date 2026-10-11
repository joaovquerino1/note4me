/**
 * Database-style view over a folder. Records are pages; fields are their
 * frontmatter properties (portable YAML). Only the view configuration is
 * app-specific (stored in .note4me/state.json).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Columns3, FilePlus, FileText, Filter, Layers, LayoutList, Plus, Table2, X } from 'lucide-react'
import { api, pathName, type CollectionResult, type CollectionView as View, type FilterOp, type PropType } from '../api'
import { openPage, promptDialog, refreshTree, toastError, useApp } from '../store'
import { openMenu } from '../ui/Menu'
import { Modal } from '../ui/Modal'
import { Crumbs, TopBar } from './TopBar'

const EMPTY: View = { columns: [], filters: [], sort: [], groupBy: null, recursive: false, template: {}, layout: 'table' }

const OPS: { op: FilterOp; label: string; needsValue: boolean }[] = [
  { op: 'eq', label: 'é igual a', needsValue: true },
  { op: 'neq', label: 'é diferente de', needsValue: true },
  { op: 'contains', label: 'contém', needsValue: true },
  { op: 'notContains', label: 'não contém', needsValue: true },
  { op: 'gt', label: 'maior que', needsValue: true },
  { op: 'lt', label: 'menor que', needsValue: true },
  { op: 'isEmpty', label: 'está vazio', needsValue: false },
  { op: 'isNotEmpty', label: 'não está vazio', needsValue: false },
]

function Cell({ kind, value, onCommit, label }: { kind: PropType; value: unknown; onCommit: (v: unknown | null) => void; label: string }) {
  const text = Array.isArray(value) ? value.join(', ') : value === null || value === undefined ? '' : String(value)
  const [draft, setDraft] = useState(text)
  useEffect(() => setDraft(text), [text])
  if (kind === 'checkbox') return <input type="checkbox" aria-label={label} checked={value === true} onChange={(e) => onCommit(e.target.checked)} />
  const commit = () => {
    if (draft === text) return
    if (draft.trim() === '') return onCommit(null)
    if (kind === 'number') {
      const n = Number(draft)
      return Number.isFinite(n) ? onCommit(n) : setDraft(text)
    }
    if (kind === 'tags') return onCommit(draft.split(',').map((t) => t.trim()).filter(Boolean))
    onCommit(draft)
  }
  return (
    <input
      type={kind === 'number' ? 'number' : kind === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(draft || '2000-01-01') ? 'date' : 'text'}
      aria-label={label}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  )
}

export function CollectionView({ folder }: { folder: string }) {
  const treeVersion = useApp((s) => s.treeVersion)
  const externalSeq = useApp((s) => s.externalChange.seq)
  const [view, setView] = useState<View | null>(null)
  const [result, setResult] = useState<CollectionResult | null>(null)
  const [templateOpen, setTemplateOpen] = useState(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    setView(null)
    api
      .collectionViewGet(folder)
      .then((v) => setView({ ...EMPTY, ...v }))
      .catch(() => setView(EMPTY))
  }, [folder])

  const query = useCallback(async () => {
    if (!view) return
    try {
      setResult(await api.collectionQuery(folder, view))
    } catch (e) {
      toastError(e)
    }
  }, [folder, view])

  useEffect(() => void query(), [query, treeVersion, externalSeq])

  const update = (fn: (v: View) => View) => {
    setView((v) => {
      const next = fn(v ?? EMPTY)
      clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => void api.collectionViewSave(folder, next).catch(toastError), 300)
      return next
    })
  }

  const setCell = async (path: string, key: string, value: unknown | null) => {
    try {
      await api.propertySet(path, key, value, null)
      await query()
    } catch (e) {
      toastError(e, 'Não foi possível alterar o valor')
    }
  }

  const addRecord = async () => {
    const title = await promptDialog({ title: 'Nova entrada', label: 'Título da página', initial: 'Sem título', confirmLabel: 'Criar' })
    if (!title) return
    try {
      await api.collectionAdd(folder, title)
      refreshTree()
      await query()
    } catch (e) {
      toastError(e)
    }
  }

  if (!view) return <TopBar left={<Crumbs path={folder} />} />
  const columns = result?.columns ?? []
  const allKeys = ['title', ...columns.map((c) => c.key)]
  const keyLabel = (k: string) => (k === 'title' ? 'Título' : k === 'modified' ? 'Modificado' : k)
  const sort = view.sort[0]
  const layout = view.layout ?? 'table'

  const toggleSort = (key: string) =>
    update((v) => {
      const cur = v.sort[0]
      if (cur?.key !== key) return { ...v, sort: [{ key, desc: false }] }
      if (!cur.desc) return { ...v, sort: [{ key, desc: true }] }
      return { ...v, sort: [] }
    })

  const columnsMenu = (el: HTMLElement) => {
    const visible = new Set(view.columns.length ? view.columns : columns.map((c) => c.key))
    openMenu(
      el,
      [
        { header: 'Colunas visíveis' },
        ...columns.map((c) => ({
          label: `${visible.has(c.key) ? '✓ ' : '   '}${c.key}`,
          onSelect: () =>
            update((v) => {
              const cur = v.columns.length ? v.columns : columns.map((x) => x.key)
              return { ...v, columns: visible.has(c.key) ? cur.filter((k) => k !== c.key) : [...cur, c.key] }
            }),
        })),
        { separator: true },
        {
          label: 'Nova coluna (propriedade)…',
          icon: <Plus />,
          onSelect: async () => {
            const name = await promptDialog({ title: 'Nova coluna', label: 'Nome da propriedade', initial: '', confirmLabel: 'Adicionar' })
            if (name) update((v) => ({ ...v, columns: [...(v.columns.length ? v.columns : columns.map((x) => x.key)), name] }))
          },
        },
        { label: 'Mostrar todas', onSelect: () => update((v) => ({ ...v, columns: [] })) },
      ],
      'Colunas',
    )
  }

  const shownColumns = view.columns.length ? view.columns.map((k) => columns.find((c) => c.key === k) ?? { key: k, kind: 'text' as PropType, count: 0 }) : columns
  const title = folder ? pathName(folder) : 'Raiz'

  return (
    <>
      <TopBar left={folder ? <Crumbs path={folder} /> : <strong>Raiz</strong>} />
      <div className="main-scroll">
        <div className="collection">
          <div className="collection-head">
            <h1>{title}</h1>
            <div className="segmented" role="group" aria-label="Layout">
              <button aria-pressed={layout === 'table'} onClick={() => update((v) => ({ ...v, layout: 'table' }))}>
                <Table2 aria-hidden style={{ width: '1rem', verticalAlign: 'middle' }} /> Tabela
              </button>
              <button aria-pressed={layout === 'list'} onClick={() => update((v) => ({ ...v, layout: 'list' }))}>
                <LayoutList aria-hidden style={{ width: '1rem', verticalAlign: 'middle' }} /> Lista
              </button>
            </div>
            <button className="btn primary" onClick={() => void addRecord()}>
              <FilePlus aria-hidden /> Nova entrada
            </button>
          </div>
          <div className="collection-toolbar">
            <button className="btn small" onClick={() => update((v) => ({ ...v, filters: [...v.filters, { key: allKeys[1] ?? 'title', op: 'contains', value: '' }] }))}>
              <Filter aria-hidden /> Filtro
            </button>
            <label className="filter-row">
              <span className="muted">Ordenar</span>
              <select value={sort?.key ?? ''} onChange={(e) => update((v) => ({ ...v, sort: e.target.value ? [{ key: e.target.value, desc: v.sort[0]?.desc ?? false }] : [] }))}>
                <option value="">Título (padrão)</option>
                {[...allKeys, 'modified'].map((k) => (
                  <option key={k} value={k}>
                    {keyLabel(k)}
                  </option>
                ))}
              </select>
              {sort && (
                <button className="icon-btn" aria-label={sort.desc ? 'Ordem decrescente' : 'Ordem crescente'} onClick={() => toggleSort(sort.key)}>
                  {sort.desc ? <ArrowDown /> : <ArrowUp />}
                </button>
              )}
            </label>
            <label className="filter-row">
              <Layers aria-hidden style={{ width: '1rem' }} />
              <span className="muted">Agrupar</span>
              <select value={view.groupBy ?? ''} onChange={(e) => update((v) => ({ ...v, groupBy: e.target.value || null }))}>
                <option value="">Sem agrupamento</option>
                {columns.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.key}
                  </option>
                ))}
              </select>
            </label>
            <label className="filter-row">
              <input type="checkbox" checked={view.recursive} onChange={(e) => update((v) => ({ ...v, recursive: e.target.checked }))} />
              Incluir subpastas
            </label>
            <button className="btn small" onClick={(e) => columnsMenu(e.currentTarget)}>
              <Columns3 aria-hidden /> Colunas
            </button>
            <button className="btn small" onClick={() => setTemplateOpen(true)}>
              Modelo
            </button>
            <span className="muted" style={{ marginLeft: 'auto' }} role="status">
              {result ? `${result.matched} de ${result.total}` : ''}
            </span>
          </div>
          {view.filters.map((f, i) => {
            const op = OPS.find((o) => o.op === f.op)
            return (
              <div className="filter-row" key={i} style={{ marginBottom: '0.4rem' }}>
                <span className="muted">{i === 0 ? 'Onde' : 'e'}</span>
                <select aria-label="Propriedade do filtro" value={f.key} onChange={(e) => update((v) => ({ ...v, filters: v.filters.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) }))}>
                  {allKeys.map((k) => (
                    <option key={k} value={k}>
                      {keyLabel(k)}
                    </option>
                  ))}
                </select>
                <select aria-label="Condição" value={f.op} onChange={(e) => update((v) => ({ ...v, filters: v.filters.map((x, j) => (j === i ? { ...x, op: e.target.value as FilterOp } : x)) }))}>
                  {OPS.map((o) => (
                    <option key={o.op} value={o.op}>
                      {o.label}
                    </option>
                  ))}
                </select>
                {op?.needsValue && (
                  <input
                    type="text"
                    aria-label="Valor do filtro"
                    value={String(f.value ?? '')}
                    onChange={(e) => update((v) => ({ ...v, filters: v.filters.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) }))}
                  />
                )}
                <button className="icon-btn" aria-label="Remover filtro" onClick={() => update((v) => ({ ...v, filters: v.filters.filter((_, j) => j !== i) }))}>
                  <X />
                </button>
              </div>
            )
          })}
          {result && result.total === 0 && (
            <div className="empty" style={{ marginTop: '6vh' }}>
              <h2>Nenhuma página nesta pasta</h2>
              <p>Cada entrada de uma coleção é uma página Markdown; os campos são propriedades do frontmatter.</p>
            </div>
          )}
          {result?.groups.map((g, gi) => (
            <div key={gi}>
              {view.groupBy && (
                <div className="group-title">
                  {g.label ?? <span className="muted">Sem valor</span>} <span className="muted">{g.rows.length}</span>
                </div>
              )}
              {layout === 'list' ? (
                <ul className="link-list">
                  {g.rows.map((r) => (
                    <li key={r.path}>
                      <button onClick={() => void openPage(r.path)}>
                        <FileText aria-hidden />
                        <span>{r.title}</span>
                        <span className="muted" style={{ marginLeft: 'auto', fontSize: '0.9rem' }}>
                          {shownColumns
                            .map((c) => r.props[c.key])
                            .filter((v) => v !== undefined && v !== null && v !== '')
                            .map((v) => (Array.isArray(v) ? v.join(', ') : String(v)))
                            .join(' · ')}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="grid-wrap">
                  <table className="grid">
                    <thead>
                      <tr>
                        <th scope="col" aria-sort={sort?.key === 'title' ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
                          <button onClick={() => toggleSort('title')}>
                            Título {sort?.key === 'title' && (sort.desc ? <ArrowDown aria-hidden /> : <ArrowUp aria-hidden />)}
                          </button>
                        </th>
                        {shownColumns.map((c) => (
                          <th scope="col" key={c.key} aria-sort={sort?.key === c.key ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
                            <button onClick={() => toggleSort(c.key)}>
                              {c.key} {sort?.key === c.key && (sort.desc ? <ArrowDown aria-hidden /> : <ArrowUp aria-hidden />)}
                            </button>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {g.rows.map((r) => (
                        <tr key={r.path}>
                          <td className="title-cell">
                            <button onClick={() => void openPage(r.path)}>
                              <FileText aria-hidden style={{ width: '0.95rem' }} /> {r.title}
                            </button>
                          </td>
                          {shownColumns.map((c) => (
                            <td key={c.key}>
                              <Cell kind={c.kind} value={r.props[c.key]} label={`${c.key} de ${r.title}`} onCommit={(v) => void setCell(r.path, c.key, v)} />
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
          <p className="muted" style={{ marginTop: '1.5rem', fontSize: '0.92rem' }}>
            Os valores ficam no frontmatter YAML de cada página e funcionam em qualquer editor que leia Markdown. Filtros, ordenação e colunas desta visualização são
            preferências do note4me.
          </p>
        </div>
      </div>
      {templateOpen && (
        <TemplateDialog
          columns={shownColumns.map((c) => c.key)}
          template={view.template}
          onClose={() => setTemplateOpen(false)}
          onSave={(t) => {
            update((v) => ({ ...v, template: t }))
            setTemplateOpen(false)
          }}
        />
      )}
    </>
  )
}

function TemplateDialog(props: { columns: string[]; template: Record<string, unknown>; onClose: () => void; onSave: (t: Record<string, unknown>) => void }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(props.columns.map((k) => [k, props.template[k] === undefined ? '' : String(props.template[k])])))
  return (
    <Modal onClose={props.onClose} label="Modelo de novas entradas">
      <h2>Modelo de novas entradas</h2>
      <p>Valores aplicados às propriedades de cada página criada por “Nova entrada”. Deixe em branco para não definir.</p>
      {props.columns.length === 0 && <p className="muted">Adicione colunas para definir um modelo.</p>}
      {props.columns.map((k) => (
        <div key={k} style={{ marginBottom: '0.6rem' }}>
          <label htmlFor={`tpl-${k}`}>{k}</label>
          <input id={`tpl-${k}`} type="text" value={values[k] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [k]: e.target.value }))} />
        </div>
      ))}
      <div className="dialog-actions">
        <button className="btn" onClick={props.onClose}>
          Cancelar
        </button>
        <button
          className="btn primary"
          onClick={() => {
            const t: Record<string, unknown> = {}
            for (const [k, v] of Object.entries(values)) {
              if (!v.trim()) continue
              t[k] = v === 'true' ? true : v === 'false' ? false : /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v
            }
            props.onSave(t)
          }}
        >
          Salvar modelo
        </button>
      </div>
    </Modal>
  )
}
