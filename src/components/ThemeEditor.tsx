import { useEffect, useState } from 'react'
import { save as saveDialog } from '@tauri-apps/plugin-dialog'
import { api, type Theme, type ThemeReport } from '../api'
import { themeVars } from '../appearance'
import { confirmDialog, refreshThemes, toast, toastError, updateSettings } from '../store'
import { Modal } from '../ui/Modal'

const TOKEN_LABELS: Record<string, string> = {
  bg: 'Fundo do conteúdo',
  surface: 'Barra lateral e painéis',
  raised: 'Menus e diálogos',
  hover: 'Fundo ao passar o cursor',
  active: 'Item selecionado',
  border: 'Bordas discretas',
  borderStrong: 'Bordas fortes',
  text: 'Texto principal',
  textSecondary: 'Texto secundário',
  textMuted: 'Metadados',
  accent: 'Destaque (botões)',
  accentText: 'Texto sobre o destaque',
  link: 'Links',
  focus: 'Anel de foco',
  selection: 'Seleção de texto',
  codeBg: 'Fundo de código',
  codeText: 'Texto de código',
  danger: 'Erro',
  warning: 'Alerta',
  success: 'Sucesso',
  highlight: 'Marca-texto',
  shadow: 'Sombra',
}

const slugify = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 36) || 'tema'

export async function exportTheme(theme: Theme) {
  const path = await saveDialog({ title: 'Exportar tema', defaultPath: `${theme.id}.note4me-theme.json`, filters: [{ name: 'Tema do note4me', extensions: ['json'] }] })
  if (!path) return
  try {
    await api.themeExportFile(theme, path)
    toast('Tema exportado.', 'success')
  } catch (e) {
    toastError(e)
  }
}

export function ThemeEditor({ base, onClose }: { base: Theme; onClose: () => void }) {
  const editingCustom = !base.builtin
  const [theme, setTheme] = useState<Theme>(() => ({
    ...base,
    builtin: false,
    id: editingCustom ? base.id : `${slugify(base.name)}-${Math.random().toString(36).slice(2, 6)}`,
    name: editingCustom ? base.name : `${base.name} (personalizado)`,
    colors: { ...base.colors },
  }))
  const [report, setReport] = useState<ThemeReport | null>(null)

  useEffect(() => {
    const t = setTimeout(() => void api.themeValidate(theme).then(setReport).catch(() => setReport(null)), 150)
    return () => clearTimeout(t)
  }, [theme])

  const setColor = (k: string, v: string) => setTheme((t) => ({ ...t, colors: { ...t.colors, [k]: v } }))
  const valid = report && report.errors.length === 0

  const save = async () => {
    try {
      const r = await api.themeSave(theme)
      await refreshThemes()
      updateSettings((s) => {
        if (theme.mode === 'light') s.appearance.lightTheme = theme.id
        else s.appearance.darkTheme = theme.id
      })
      const weak = r.checks.filter((c) => !c.ok)
      toast(weak.length ? `Tema salvo. Atenção: ${weak.length} combinação(ões) abaixo do contraste recomendado.` : 'Tema salvo e aplicado.', weak.length ? 'info' : 'success')
      onClose()
    } catch (e) {
      toastError(e, 'Não foi possível salvar o tema')
    }
  }

  const remove = async () => {
    if (!(await confirmDialog({ title: 'Excluir tema?', message: `“${theme.name}” será removido.`, confirmLabel: 'Excluir', danger: true }))) return
    try {
      await api.themeDelete(theme.id)
      await refreshThemes()
      onClose()
    } catch (e) {
      toastError(e)
    }
  }

  const preview = themeVars(theme) as React.CSSProperties
  return (
    <Modal onClose={onClose} label="Editor de tema" className="dialog wide">
      <h2>{editingCustom ? 'Editar tema' : 'Novo tema personalizado'}</h2>
      <div className="theme-editor">
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '0.5rem', marginBottom: '0.75rem' }}>
            <div>
              <label htmlFor="te-name">Nome</label>
              <input id="te-name" type="text" value={theme.name} onChange={(e) => setTheme((t) => ({ ...t, name: e.target.value }))} />
            </div>
            <div>
              <label htmlFor="te-mode">Modo</label>
              <select id="te-mode" value={theme.mode} onChange={(e) => setTheme((t) => ({ ...t, mode: e.target.value as Theme['mode'] }))}>
                <option value="light">Claro</option>
                <option value="dark">Escuro</option>
              </select>
            </div>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
            <input type="checkbox" checked={theme.highContrast} onChange={(e) => setTheme((t) => ({ ...t, highContrast: e.target.checked }))} /> Tema de alto contraste (exige contraste 7:1)
          </label>
          <div style={{ maxHeight: '42vh', overflow: 'auto', paddingRight: '0.5rem' }}>
            {Object.keys(TOKEN_LABELS).map((k) => {
              const v = theme.colors[k] ?? '#000000'
              return (
                <div className="token-row" key={k}>
                  <input type="color" aria-label={`Escolher cor: ${TOKEN_LABELS[k]}`} value={/^#[0-9a-f]{6}/i.test(v) ? v.slice(0, 7) : '#000000'} onChange={(e) => setColor(k, e.target.value + (v.length === 9 ? v.slice(7) : ''))} />
                  <label htmlFor={`tok-${k}`} style={{ margin: 0 }}>
                    {TOKEN_LABELS[k]}
                  </label>
                  <input id={`tok-${k}`} type="text" value={v} onChange={(e) => setColor(k, e.target.value.trim())} spellCheck={false} />
                </div>
              )
            })}
          </div>
        </div>
        <div>
          <div className="preview-box" style={{ ...preview, background: 'var(--c-bg)', color: 'var(--c-text)', marginTop: 0 }} aria-label="Pré-visualização do tema">
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <div style={{ background: 'var(--c-surface)', padding: '0.6rem', borderRadius: '0.4rem', width: '35%', color: 'var(--c-text-secondary)', fontSize: '0.9rem' }}>
                <div style={{ background: 'var(--c-active)', color: 'var(--c-text)', borderRadius: '0.3rem', padding: '0.2rem 0.4rem' }}>Página</div>
                <div style={{ padding: '0.2rem 0.4rem' }}>Outra</div>
              </div>
              <div style={{ flex: 1 }}>
                <strong style={{ fontSize: '1.15rem' }}>Título</strong>
                <p style={{ margin: '0.4rem 0', lineHeight: 1.5 }}>
                  Texto com um <span style={{ color: 'var(--c-link)', textDecoration: 'underline' }}>link</span>, <code style={{ background: 'var(--c-code-bg)', color: 'var(--c-code-text)', padding: '0 0.2rem' }}>código</code> e{' '}
                  <mark style={{ background: 'var(--c-highlight)', color: 'inherit' }}>destaque</mark>.
                </p>
                <p style={{ margin: 0, color: 'var(--c-text-muted)', fontSize: '0.9rem' }}>Editado há 2 minutos</p>
                <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.6rem' }}>
                  <span style={{ background: 'var(--c-accent)', color: 'var(--c-accent-text)', padding: '0.2rem 0.6rem', borderRadius: '0.3rem' }}>Botão</span>
                  <span style={{ color: 'var(--c-danger)', padding: '0.2rem 0' }}>Erro</span>
                </div>
              </div>
            </div>
          </div>
          <h3 style={{ fontSize: '0.95rem', margin: '1rem 0 0.25rem' }}>Contraste (WCAG)</h3>
          {report?.errors.length ? (
            <ul className="contrast-list">
              {report.errors.map((e) => (
                <li key={e} className="bad">
                  {e}
                </li>
              ))}
            </ul>
          ) : (
            <ul className="contrast-list">
              {report?.checks.map((c) => (
                <li key={c.pair} className={c.ok ? '' : 'bad'}>
                  <span>{c.pair}</span>
                  <span>
                    {c.ratio.toFixed(2)}:1 {c.ok ? '✓' : `✕ (mín. ${c.required}:1)`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className="dialog-actions">
        {editingCustom && (
          <button className="btn danger" style={{ marginRight: 'auto' }} onClick={() => void remove()}>
            Excluir tema
          </button>
        )}
        <button className="btn" onClick={() => void exportTheme(theme)} disabled={!valid}>
          Exportar…
        </button>
        <button className="btn" onClick={onClose}>
          Cancelar
        </button>
        <button className="btn primary" onClick={() => void save()} disabled={!valid}>
          Salvar e aplicar
        </button>
      </div>
    </Modal>
  )
}
