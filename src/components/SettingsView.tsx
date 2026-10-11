/**
 * Preferences. Every control here changes real behaviour; settings are stored
 * in the app's configuration directory, never in a vault.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { Accessibility, FileCog, Info, Keyboard, Palette, PenLine, Type } from 'lucide-react'
import { api, type BrokenLink, type FontChoice, type Generic, type Theme } from '../api'
import { effectiveTheme, isFontAvailable, readEnvironment, SYSTEM_FONTS, themeVars } from '../appearance'
import { chooseVault } from '../actions'
import { navigate, openPage, refreshTree, setOverlay, toast, toastError, updateSettings, useApp } from '../store'
import { exportTheme, ThemeEditor } from './ThemeEditor'
import { TopBar } from './TopBar'
import { Modal } from '../ui/Modal'

const SECTIONS = [
  { id: 'appearance', label: 'Aparência', icon: <Palette /> },
  { id: 'typography', label: 'Tipografia', icon: <Type /> },
  { id: 'accessibility', label: 'Acessibilidade', icon: <Accessibility /> },
  { id: 'editor', label: 'Editor', icon: <PenLine /> },
  { id: 'files', label: 'Arquivos e armazenamento', icon: <FileCog /> },
  { id: 'about', label: 'Sobre', icon: <Info /> },
]

function Row(props: { label: string; htmlFor?: string; help?: ReactNode; children: ReactNode }) {
  return (
    <div className="setting">
      {props.htmlFor ? <label htmlFor={props.htmlFor}>{props.label}</label> : <span className="setting-label">{props.label}</span>}
      <div className="control">{props.children}</div>
      {props.help && <div className="help">{props.help}</div>}
    </div>
  )
}

function Segmented<T extends string>(props: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="group" aria-label={props.label}>
      {props.options.map((o) => (
        <button key={o.value} aria-pressed={props.value === o.value} onClick={() => props.onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Slider(props: { id: string; min: number; max: number; step: number; value: number; format: (v: number) => string; onChange: (v: number) => void }) {
  return (
    <>
      <input id={props.id} type="range" min={props.min} max={props.max} step={props.step} value={props.value} onChange={(e) => props.onChange(Number(e.target.value))} aria-valuetext={props.format(props.value)} />
      <span className="value">{props.format(props.value)}</span>
    </>
  )
}

function Check(props: { id: string; checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <label htmlFor={props.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
      <input id={props.id} type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
      {props.label ?? 'Ativado'}
    </label>
  )
}

const MONO = /mono|code|courier|menlo|consol|monaco|hack|inconsolata|iosevka|fira code|cascadia|andale/i
const SERIF = /serif|garamond|georgia|times|baskerville|palatino|didot|bodoni|charter|cochin|hoefler|new york|caslon|minion|merriweather|literata|lora|libre|playfair|crimson|cambria|book antiqua|big caslon|athelas|iowan|superclarendon|charis|noto serif|pt serif/i
const READING = /atkinson|opendyslexic|lexend|dyslexie|verdana|tahoma|inter\b/i

function classify(f: string): Generic | 'reading' {
  if (READING.test(f)) return 'reading'
  if (MONO.test(f)) return 'mono'
  if (SERIF.test(f) && !/sans/i.test(f)) return 'serif'
  return 'sans'
}

function FontSelect({ id, value, installed, onChange, prefer }: { id: string; value: FontChoice; installed: string[]; onChange: (v: FontChoice) => void; prefer?: Generic }) {
  const groups: Record<string, string[]> = { reading: [], sans: [], serif: [], mono: [] }
  for (const f of installed) groups[classify(f)]!.push(f)
  const order = prefer === 'mono' ? ['mono', 'sans', 'serif', 'reading'] : ['reading', 'sans', 'serif', 'mono']
  const labels: Record<string, string> = { reading: 'Leitura e acessibilidade', sans: 'Sans-serif', serif: 'Serifadas', mono: 'Monoespaçadas' }
  const available = isFontAvailable(value, installed)
  return (
    <>
      <select
        id={id}
        value={value.family}
        onChange={(e) => {
          const family = e.target.value
          const sys = SYSTEM_FONTS.find((s) => s.family === family)
          const c = classify(family)
          onChange({ family, generic: sys ? sys.generic : c === 'reading' ? 'sans' : c })
        }}
      >
        {!available && <option value={value.family}>{value.family} (não instalada)</option>}
        <optgroup label="Fontes do sistema">
          {SYSTEM_FONTS.map((s) => (
            <option key={s.family} value={s.family}>
              {s.label}
            </option>
          ))}
        </optgroup>
        {order.map((g) =>
          groups[g]!.length ? (
            <optgroup key={g} label={labels[g]}>
              {groups[g]!.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </optgroup>
          ) : null,
        )}
      </select>
      {!available && <span className="font-note">“{value.family}” não está instalada neste Mac; usando uma alternativa {value.generic === 'serif' ? 'serifada' : value.generic === 'mono' ? 'monoespaçada' : 'sem serifa'}.</span>}
    </>
  )
}

function ThemeCard({ theme, selected, onSelect, onEdit }: { theme: Theme; selected: boolean; onSelect: () => void; onEdit: () => void }) {
  const c = theme.colors
  return (
    <div style={{ position: 'relative' }}>
      <button className="theme-card" aria-pressed={selected} onClick={onSelect} onDoubleClick={onEdit} aria-label={`Tema ${theme.name}`} style={{ width: '100%' }}>
        <div className="swatch" style={{ background: c.bg }} aria-hidden>
          <div className="sb" style={{ background: c.surface }}>
            <div className="line" style={{ background: c.active, width: '90%' }} />
            <div className="line" style={{ background: c.textMuted, width: '60%', opacity: 0.5 }} />
            <div className="line" style={{ background: c.textMuted, width: '70%', opacity: 0.5 }} />
          </div>
          <div className="ct">
            <div className="line" style={{ background: c.text, width: '55%', height: '0.5rem' }} />
            <div className="line" style={{ background: c.textSecondary, width: '90%' }} />
            <div className="line" style={{ background: c.link, width: '40%' }} />
            <div className="line" style={{ background: c.accent, width: '25%', height: '0.55rem' }} />
          </div>
        </div>
        <div className="name" style={{ ...(themeVars(theme) as React.CSSProperties), background: c.raised, color: c.text, borderTopColor: c.border }}>
          <span>{theme.name}</span>
          {!theme.builtin && <span style={{ color: c.textMuted }}>pers.</span>}
        </div>
      </button>
    </div>
  )
}

export function SettingsView({ section = 'appearance' }: { section?: string }) {
  const settings = useApp((s) => s.settings)
  const themes = useApp((s) => s.themes)
  const fonts = useApp((s) => s.fonts)
  const presets = useApp((s) => s.presets)
  const vault = useApp((s) => s.vault)
  const [editing, setEditing] = useState<Theme | null>(null)
  const [info, setInfo] = useState<{ version: string; configDir: string } | null>(null)
  const [broken, setBroken] = useState<BrokenLink[] | null>(null)
  useEffect(() => void api.appInfo().then(setInfo).catch(() => undefined), [])
  if (!settings) return null
  const s = settings
  const set = updateSettings
  const go = (id: string) => void navigate({ kind: 'settings', section: id }, { replace: true })
  const light = themes.filter((t) => t.mode === 'light')
  const dark = themes.filter((t) => t.mode === 'dark')
  const current = effectiveTheme(s, themes, readEnvironment())

  const importTheme = async () => {
    const path = await openDialog({ multiple: false, title: 'Importar tema', filters: [{ name: 'Tema do note4me', extensions: ['json'] }] })
    if (typeof path !== 'string') return
    try {
      const [theme, report] = await api.themeImportFile(path)
      useApp.setState({ themes: await api.themesList() })
      const weak = report.checks.filter((c) => !c.ok).length
      toast(weak ? `Tema “${theme.name}” importado com ${weak} aviso(s) de contraste.` : `Tema “${theme.name}” importado.`, weak ? 'info' : 'success')
    } catch (e) {
      toastError(e, 'Tema inválido')
    }
  }

  const loc = s.files.attachmentLocation
  return (
    <>
      <TopBar left={<strong style={{ padding: '0 0.4rem' }}>Ajustes</strong>} />
      <div className="main-scroll">
        <div className="settings">
          <nav className="settings-nav" aria-label="Seções de ajustes">
            {SECTIONS.map((sec) => (
              <button key={sec.id} aria-current={section === sec.id} onClick={() => go(sec.id)}>
                {sec.icon} {sec.label}
              </button>
            ))}
          </nav>
          <div className="settings-body">
            {section === 'appearance' && (
              <>
                <h1>Aparência</h1>
                <Row label="Modo">
                  <Segmented
                    label="Modo de cor"
                    value={s.appearance.mode}
                    options={[
                      { value: 'system', label: 'Seguir o macOS' },
                      { value: 'light', label: 'Claro' },
                      { value: 'dark', label: 'Escuro' },
                    ]}
                    onChange={(v) => set((x) => void (x.appearance.mode = v))}
                  />
                </Row>
                <h2>Tema claro</h2>
                <div className="theme-grid">
                  {light.map((t) => (
                    <ThemeCard key={t.id} theme={t} selected={s.appearance.lightTheme === t.id} onSelect={() => set((x) => void (x.appearance.lightTheme = t.id))} onEdit={() => setEditing(t)} />
                  ))}
                </div>
                <h2>Tema escuro</h2>
                <div className="theme-grid">
                  {dark.map((t) => (
                    <ThemeCard key={t.id} theme={t} selected={s.appearance.darkTheme === t.id} onSelect={() => set((x) => void (x.appearance.darkTheme = t.id))} onEdit={() => setEditing(t)} />
                  ))}
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', margin: '1rem 0' }}>
                  <button className="btn" onClick={() => current && setEditing(current)}>
                    {current && !current.builtin ? 'Editar tema atual…' : 'Personalizar tema atual…'}
                  </button>
                  <button className="btn" onClick={() => void importTheme()}>
                    Importar tema…
                  </button>
                  <button className="btn" onClick={() => current && void exportTheme(current)}>
                    Exportar tema atual…
                  </button>
                </div>
                <p className="muted">Clique duas vezes em um tema para criar uma variação personalizada. Temas são arquivos JSON documentados e validados na importação.</p>
                <h2>Interface</h2>
                <Row label="Densidade">
                  <Segmented
                    label="Densidade"
                    value={s.appearance.density}
                    options={[
                      { value: 'compact', label: 'Compacta' },
                      { value: 'comfortable', label: 'Confortável' },
                      { value: 'spacious', label: 'Espaçosa' },
                    ]}
                    onChange={(v) => set((x) => void (x.appearance.density = v))}
                  />
                </Row>
                <Row label="Barra lateral" htmlFor="sb-visible">
                  <Check id="sb-visible" checked={s.appearance.sidebarVisible} onChange={(v) => set((x) => void (x.appearance.sidebarVisible = v))} label="Mostrar (⌘\)" />
                </Row>
                <Row label="Largura da barra lateral" htmlFor="sb-width">
                  <Slider id="sb-width" min={180} max={520} step={4} value={s.appearance.sidebarWidth} format={(v) => `${v}px`} onChange={(v) => set((x) => void (x.appearance.sidebarWidth = v))} />
                </Row>
                <Row label="Anexos na barra lateral" htmlFor="sb-files" help="Mostra imagens e outros arquivos que não são páginas.">
                  <Check id="sb-files" checked={s.appearance.showFilesInSidebar} onChange={(v) => set((x) => void (x.appearance.showFilesInSidebar = v))} label="Mostrar" />
                </Row>
                <Row label="Efeitos visuais" htmlFor="fx" help="Sombras suaves e transições curtas. Desative para uma interface plana.">
                  <Check id="fx" checked={s.appearance.effects} onChange={(v) => set((x) => void (x.appearance.effects = v))} />
                </Row>
              </>
            )}

            {section === 'typography' && (
              <>
                <h1>Tipografia</h1>
                <h2>Pontos de partida</h2>
                <div className="theme-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(13rem, 1fr))' }}>
                  {presets.map((p) => (
                    <button
                      key={p.id}
                      className="theme-card"
                      aria-pressed={s.typography.preset === p.id}
                      style={{ padding: '0.7rem 0.8rem' }}
                      onClick={() => set((x) => void (x.typography = { ...p.values }))}
                    >
                      <strong style={{ display: 'block', marginBottom: '0.2rem' }}>{p.name}</strong>
                      <span className="muted" style={{ fontSize: '0.88rem', lineHeight: 1.4 }}>
                        {p.description}
                      </span>
                    </button>
                  ))}
                </div>
                <p className="muted">Os presets apenas preenchem os controles abaixo — ajuste-os à vontade.</p>
                <h2>Fontes</h2>
                <Row label="Interface" htmlFor="f-ui">
                  <FontSelect id="f-ui" value={s.typography.uiFont} installed={fonts} onChange={(v) => set((x) => void (x.typography.uiFont = v))} />
                </Row>
                <Row label="Conteúdo" htmlFor="f-content">
                  <FontSelect id="f-content" value={s.typography.contentFont} installed={fonts} onChange={(v) => set((x) => void (x.typography.contentFont = v))} />
                </Row>
                <Row label="Títulos" htmlFor="f-heading">
                  <FontSelect id="f-heading" value={s.typography.headingFont} installed={fonts} onChange={(v) => set((x) => void (x.typography.headingFont = v))} />
                </Row>
                <Row label="Código" htmlFor="f-code">
                  <FontSelect id="f-code" prefer="mono" value={s.typography.codeFont} installed={fonts} onChange={(v) => set((x) => void (x.typography.codeFont = v))} />
                </Row>
                <h2>Texto</h2>
                <Row label="Tamanho" htmlFor="t-size">
                  <Slider id="t-size" min={11} max={40} step={0.5} value={s.typography.contentSize} format={(v) => `${v}px`} onChange={(v) => set((x) => void (x.typography.contentSize = v))} />
                </Row>
                <Row label="Peso do texto" htmlFor="t-weight">
                  <select id="t-weight" value={s.typography.weight} onChange={(e) => set((x) => void (x.typography.weight = Number(e.target.value)))}>
                    {[300, 400, 500, 600, 700].map((w) => (
                      <option key={w} value={w}>
                        {w === 300 ? 'Leve (300)' : w === 400 ? 'Regular (400)' : w === 500 ? 'Médio (500)' : w === 600 ? 'Seminegrito (600)' : 'Negrito (700)'}
                      </option>
                    ))}
                  </select>
                </Row>
                <Row label="Peso dos títulos" htmlFor="t-hweight">
                  <Slider id="t-hweight" min={400} max={900} step={50} value={s.typography.headingWeight} format={String} onChange={(v) => set((x) => void (x.typography.headingWeight = v))} />
                </Row>
                <Row label="Altura da linha" htmlFor="t-lh">
                  <Slider id="t-lh" min={1.1} max={2.6} step={0.05} value={s.typography.lineHeight} format={(v) => v.toFixed(2)} onChange={(v) => set((x) => void (x.typography.lineHeight = v))} />
                </Row>
                <Row label="Espaço entre parágrafos" htmlFor="t-ps">
                  <Slider id="t-ps" min={0} max={3} step={0.05} value={s.typography.paragraphSpacing} format={(v) => `${v.toFixed(2)} em`} onChange={(v) => set((x) => void (x.typography.paragraphSpacing = v))} />
                </Row>
                <Row label="Espaçamento entre letras" htmlFor="t-ls">
                  <Slider id="t-ls" min={-0.05} max={0.25} step={0.005} value={s.typography.letterSpacing} format={(v) => `${v.toFixed(3)} em`} onChange={(v) => set((x) => void (x.typography.letterSpacing = v))} />
                </Row>
                <Row label="Largura da leitura" htmlFor="t-width">
                  <Slider id="t-width" min={420} max={2000} step={10} value={s.typography.maxWidth || 2000} format={(v) => (s.typography.maxWidth === 0 ? 'total' : `${v}px`)} onChange={(v) => set((x) => void (x.typography.maxWidth = v))} />
                  <Check id="t-full" checked={s.typography.maxWidth === 0} onChange={(v) => set((x) => void (x.typography.maxWidth = v ? 0 : 720))} label="Usar toda a largura" />
                </Row>
                <Row label="Alinhamento" help="O texto justificado pode criar espaços irregulares; para leitura com dislexia, prefira à esquerda.">
                  <Segmented
                    label="Alinhamento"
                    value={s.typography.align}
                    options={[
                      { value: 'left', label: 'À esquerda' },
                      { value: 'justify', label: 'Justificado' },
                    ]}
                    onChange={(v) => set((x) => void (x.typography.align = v))}
                  />
                </Row>
                <Row label="Texto em tabelas" htmlFor="t-table">
                  <Slider id="t-table" min={10} max={32} step={0.5} value={s.typography.tableSize} format={(v) => `${v}px`} onChange={(v) => set((x) => void (x.typography.tableSize = v))} />
                </Row>
                <Row label="Texto em blocos de código" htmlFor="t-code">
                  <Slider id="t-code" min={10} max={32} step={0.5} value={s.typography.codeSize} format={(v) => `${v}px`} onChange={(v) => set((x) => void (x.typography.codeSize = v))} />
                </Row>
                <div className="preview-box editor" aria-label="Pré-visualização da tipografia">
                  <h2 style={{ marginTop: 0 }}>Pré-visualização</h2>
                  <p style={{ marginBottom: 'var(--paragraph-spacing)' }}>
                    Cada página do note4me é um arquivo Markdown comum. Fontes, tamanhos e espaçamentos mudam apenas a apresentação — nunca o conteúdo dos seus arquivos.
                  </p>
                  <p>
                    Um parágrafo com <strong>negrito</strong>, <em>itálico</em>, <a href="#preview">um link</a> e <code>código em linha</code>.
                  </p>
                </div>
              </>
            )}

            {section === 'accessibility' && (
              <>
                <h1>Acessibilidade</h1>
                <Row label="Escala da interface" htmlFor="a-scale" help="Aumenta menus, barra lateral e controles. O tamanho do texto das páginas é ajustado separadamente em Tipografia (⌘+ / ⌘−).">
                  <Slider id="a-scale" min={80} max={200} step={5} value={s.accessibility.uiScale} format={(v) => `${v}%`} onChange={(v) => set((x) => void (x.accessibility.uiScale = v))} />
                </Row>
                <Row label="Reduzir movimento" help="“Seguir o macOS” usa Ajustes do Sistema › Acessibilidade › Monitor › Reduzir movimento.">
                  <Segmented
                    label="Reduzir movimento"
                    value={s.accessibility.reduceMotion}
                    options={[
                      { value: 'system', label: 'Seguir o macOS' },
                      { value: 'on', label: 'Sempre' },
                      { value: 'off', label: 'Nunca' },
                    ]}
                    onChange={(v) => set((x) => void (x.accessibility.reduceMotion = v))}
                  />
                </Row>
                <Row label="Alto contraste" help="Usa os temas High Contrast Light/Dark. “Seguir o macOS” respeita a opção Aumentar contraste do sistema.">
                  <Segmented
                    label="Alto contraste"
                    value={s.accessibility.highContrast}
                    options={[
                      { value: 'system', label: 'Seguir o macOS' },
                      { value: 'on', label: 'Sempre' },
                      { value: 'off', label: 'Nunca' },
                    ]}
                    onChange={(v) => set((x) => void (x.accessibility.highContrast = v))}
                  />
                </Row>
                <Row label="Indicador de foco reforçado" htmlFor="a-focus" help="Contorno mais espesso no elemento com foco do teclado.">
                  <Check id="a-focus" checked={s.accessibility.strongFocus} onChange={(v) => set((x) => void (x.accessibility.strongFocus = v))} />
                </Row>
                <Row label="Sublinhar links" htmlFor="a-links" help="Para não depender apenas da cor para identificar links.">
                  <Check id="a-links" checked={s.accessibility.underlineLinks} onChange={(v) => set((x) => void (x.accessibility.underlineLinks = v))} />
                </Row>
                <h2>Leitura</h2>
                <p className="muted">
                  Para fontes de alta legibilidade, instale gratuitamente Atkinson Hyperlegible ou OpenDyslexic (licença SIL OFL) e escolha-as em Tipografia, ou aplique o preset “Dislexia-friendly”. Nenhuma fonte resolve
                  todas as dificuldades de leitura; combine tamanho, espaçamento e largura conforme a sua necessidade.
                </p>
                <h2>Teclado e VoiceOver</h2>
                <p className="muted">
                  Todas as funções têm acesso por teclado. A barra lateral é uma árvore navegável com as setas; menus e diálogos prendem o foco e fecham com Esc. A interface roda numa WebView do macOS (WebKit) e é
                  exposta ao VoiceOver com papéis e rótulos ARIA.
                </p>
                <button className="btn" onClick={() => setOverlay('shortcuts')}>
                  <Keyboard aria-hidden /> Ver atalhos de teclado
                </button>
              </>
            )}

            {section === 'editor' && (
              <>
                <h1>Editor</h1>
                <Row label="Salvamento automático" htmlFor="e-auto" help="Desativado, salve com ⌘S. Alterações pendentes também são salvas ao trocar de página ou fechar a janela.">
                  <Check id="e-auto" checked={s.editor.autosave} onChange={(v) => set((x) => void (x.editor.autosave = v))} />
                </Row>
                <Row label="Atraso do salvamento" htmlFor="e-delay">
                  <Slider id="e-delay" min={200} max={10000} step={100} value={s.editor.autosaveDelayMs} format={(v) => `${(v / 1000).toFixed(1)} s`} onChange={(v) => set((x) => void (x.editor.autosaveDelayMs = v))} />
                </Row>
                <Row label="Verificação ortográfica" htmlFor="e-spell">
                  <Check id="e-spell" checked={s.editor.spellcheck} onChange={(v) => set((x) => void (x.editor.spellcheck = v))} />
                </Row>
                <Row label="Menu de comandos /" htmlFor="e-slash" help="Digite / para inserir títulos, listas, tabelas, imagens e outros blocos.">
                  <Check id="e-slash" checked={s.editor.slashMenu} onChange={(v) => set((x) => void (x.editor.slashMenu = v))} />
                </Row>
                <Row label="Contagem de palavras" htmlFor="e-words">
                  <Check id="e-words" checked={s.editor.showWordCount} onChange={(v) => set((x) => void (x.editor.showWordCount = v))} label="Mostrar" />
                </Row>
                <h2>Markdown</h2>
                <Row label="Links internos" help="Links Markdown relativos funcionam no GitHub, VS Code e na maioria das ferramentas. Links wiki são o formato do Obsidian.">
                  <Segmented
                    label="Formato de links internos"
                    value={s.editor.linkFormat}
                    options={[
                      { value: 'markdown', label: '[Título](caminho.md)' },
                      { value: 'wiki', label: '[[Título]]' },
                    ]}
                    onChange={(v) => set((x) => void (x.editor.linkFormat = v))}
                  />
                </Row>
                <Row label="Frontmatter em novas páginas" htmlFor="e-fm" help="Adiciona “id” (identificador estável) e “created” às páginas criadas pelo note4me. O resto do frontmatter é sempre seu.">
                  <Check id="e-fm" checked={s.editor.newPageFrontmatter} onChange={(v) => set((x) => void (x.editor.newPageFrontmatter = v))} />
                </Row>
                <Row label="Links externos" htmlFor="e-ext">
                  <Check id="e-ext" checked={s.editor.confirmExternalLinks} onChange={(v) => set((x) => void (x.editor.confirmExternalLinks = v))} label="Confirmar antes de abrir no navegador" />
                </Row>
              </>
            )}

            {section === 'files' && (
              <>
                <h1>Arquivos e armazenamento</h1>
                <Row label="Espaço de trabalho" help="As páginas são arquivos .md nesta pasta. Você pode abri-los, copiá-los, versioná-los e sincronizá-los com qualquer ferramenta.">
                  <code style={{ userSelect: 'text', overflowWrap: 'anywhere' }}>{vault?.root ?? '—'}</code>
                  <button className="btn small" onClick={() => void chooseVault()}>
                    Alterar…
                  </button>
                  {vault && (
                    <button className="btn small" onClick={() => void api.revealAbs(vault.root).catch(toastError)}>
                      Mostrar no Finder
                    </button>
                  )}
                </Row>
                <Row label="Local dos anexos" htmlFor="f-loc" help="Imagens e arquivos adicionados às páginas são copiados para cá e referenciados por links relativos.">
                  <select
                    id="f-loc"
                    value={loc.mode}
                    onChange={(e) =>
                      set((x) => {
                        const m = e.target.value as typeof loc.mode
                        x.files.attachmentLocation = m === 'sameFolder' ? { mode: 'sameFolder' } : { mode: m, folder: m === 'vaultFolder' ? 'Anexos' : 'anexos' }
                      })
                    }
                  >
                    <option value="vaultFolder">Uma pasta no espaço de trabalho</option>
                    <option value="subfolder">Subpasta ao lado de cada página</option>
                    <option value="sameFolder">Mesma pasta da página</option>
                  </select>
                  {loc.mode !== 'sameFolder' && (
                    <input
                      type="text"
                      aria-label="Nome da pasta de anexos"
                      value={loc.folder}
                      onChange={(e) => set((x) => void (x.files.attachmentLocation = { mode: loc.mode, folder: e.target.value }))}
                      style={{ width: '10rem' }}
                    />
                  )}
                </Row>
                <Row label="Tamanho máximo de anexos" htmlFor="f-max">
                  <Slider id="f-max" min={1} max={2048} step={1} value={s.files.maxAttachmentMb} format={(v) => `${v} MB`} onChange={(v) => set((x) => void (x.files.maxAttachmentMb = v))} />
                </Row>
                <Row label="Indexar arquivos até" htmlFor="f-idx" help="Arquivos maiores aparecem na barra lateral, mas seu conteúdo não entra na busca.">
                  <Slider id="f-idx" min={1} max={256} step={1} value={s.files.maxIndexFileMb} format={(v) => `${v} MB`} onChange={(v) => set((x) => void (x.files.maxIndexFileMb = v))} />
                </Row>
                <h2>Histórico de versões</h2>
                <Row label="Guardar versões" htmlFor="h-on" help="Cópias anteriores ficam em .note4me/history no espaço de trabalho.">
                  <Check id="h-on" checked={s.files.historyEnabled} onChange={(v) => set((x) => void (x.files.historyEnabled = v))} />
                </Row>
                <Row label="Intervalo mínimo" htmlFor="h-int">
                  <Slider id="h-int" min={0} max={120} step={1} value={s.files.historyIntervalMin} format={(v) => (v === 0 ? 'cada salvamento' : `${v} min`)} onChange={(v) => set((x) => void (x.files.historyIntervalMin = v))} />
                </Row>
                <Row label="Versões por página" htmlFor="h-max">
                  <Slider id="h-max" min={1} max={1000} step={1} value={s.files.historyMaxVersions} format={String} onChange={(v) => set((x) => void (x.files.historyMaxVersions = v))} />
                </Row>
                <h2>Manutenção</h2>
                <Row label="Índice de busca" help="O índice é reconstruído a partir dos arquivos a cada abertura e atualizado quando os arquivos mudam. Use se algo parecer desatualizado.">
                  <button
                    className="btn"
                    disabled={!vault}
                    onClick={async () => {
                      try {
                        const i = await api.vaultReindex()
                        useApp.setState({ vault: i })
                        refreshTree()
                        toast(`Índice reconstruído: ${i.pageCount} páginas.`, 'success')
                      } catch (e) {
                        toastError(e)
                      }
                    }}
                  >
                    Reindexar agora
                  </button>
                </Row>
                <Row label="Links quebrados" help="Lista links para páginas ou anexos que não existem em todo o espaço de trabalho.">
                  <button className="btn" disabled={!vault} onClick={() => void api.brokenLinks(null).then(setBroken).catch(toastError)}>
                    Verificar
                  </button>
                </Row>
              </>
            )}

            {section === 'about' && (
              <>
                <h1>Sobre o note4me</h1>
                <p>Versão {info?.version ?? '—'}</p>
                <p className="muted" style={{ lineHeight: 1.55 }}>
                  Suas páginas são arquivos Markdown comuns no espaço de trabalho. O note4me guarda dados opcionais (histórico, lixeira, rascunhos e preferências da barra lateral) em <code>.note4me/</code> dentro dele, e
                  seus ajustes em <code style={{ userSelect: 'text' }}>{info?.configDir}</code>. Nenhum documento é enviado para servidores.
                </p>
              </>
            )}
          </div>
        </div>
      </div>
      {editing && <ThemeEditor base={editing} onClose={() => setEditing(null)} />}
      {broken && (
        <Modal onClose={() => setBroken(null)} label="Links quebrados" className="dialog wide">
          <h2>Links quebrados ({broken.length})</h2>
          {broken.length === 0 ? (
            <p>Nenhum link quebrado encontrado.</p>
          ) : (
            <ul className="link-list" style={{ maxHeight: '55vh', overflow: 'auto' }}>
              {broken.map((b, i) => (
                <li key={i}>
                  <button
                    onClick={() => {
                      setBroken(null)
                      void openPage(b.from)
                    }}
                  >
                    <span>{b.from}</span>
                    <span className="error-text" style={{ marginLeft: 'auto', overflowWrap: 'anywhere' }}>
                      {b.dest}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="dialog-actions">
            <button className="btn" data-autofocus onClick={() => setBroken(null)}>
              Fechar
            </button>
          </div>
        </Modal>
      )}
    </>
  )
}

