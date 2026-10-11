import { Clock, FilePlus, FolderOpen, FolderPlus, Search } from 'lucide-react'
import { pathParent } from '../api'
import { chooseVault, createVault, newPage } from '../actions'
import { openPage, openVault, setOverlay, useApp } from '../store'
import { Modal } from '../ui/Modal'
import { TopBar } from './TopBar'

export function Welcome() {
  const recent = useApp((s) => s.settings?.recentVaults ?? [])
  return (
    <main className="welcome">
      <div className="welcome-drag" data-tauri-drag-region />
      <div className="welcome-card">
        <h1>note4me</h1>
        <p>
          Organize páginas, subpáginas, links e coleções. Cada página é um arquivo Markdown comum numa pasta que você escolhe — legível em qualquer editor, fácil de copiar, sincronizar e versionar.
        </p>
        <div className="welcome-actions">
          <button className="btn primary" onClick={() => void chooseVault()}>
            <FolderOpen aria-hidden /> Abrir uma pasta…
          </button>
          <button className="btn" onClick={() => void createVault()}>
            <FolderPlus aria-hidden /> Criar espaço de trabalho…
          </button>
        </div>
        {recent.length > 0 && (
          <>
            <h2 className="section-title">Abertos recentemente</h2>
            <ul className="link-list">
              {recent.map((r) => (
                <li key={r}>
                  <button onClick={() => void openVault(r)} title={r}>
                    <FolderOpen aria-hidden />
                    <span>{r.split('/').pop()}</span>
                    <span className="muted" style={{ marginLeft: 'auto', fontSize: '0.88rem', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {r}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </main>
  )
}

export function Home() {
  const vault = useApp((s) => s.vault)
  const recents = useApp((s) => s.nav.recents)
  return (
    <>
      <TopBar left={<strong style={{ padding: '0 0.4rem' }}>{vault?.name}</strong>} />
      <div className="main-scroll">
        <div className="empty">
          <h2>{vault?.pageCount ? `${vault.pageCount} página${vault.pageCount === 1 ? '' : 's'} em ${vault.name}` : `${vault?.name} está vazio`}</h2>
          <p>Escolha uma página na barra lateral, procure com ⌘P ou crie uma nova com ⌘N.</p>
          <div className="welcome-actions" style={{ justifyContent: 'center' }}>
            <button className="btn primary" onClick={() => void newPage('')}>
              <FilePlus aria-hidden /> Nova página
            </button>
            <button className="btn" onClick={() => setOverlay('quickOpen')}>
              <Search aria-hidden /> Ir para…
            </button>
          </div>
          {recents.length > 0 && (
            <ul className="link-list" style={{ textAlign: 'left', maxWidth: '26rem', margin: '0 auto' }}>
              {recents.slice(0, 8).map((r) => (
                <li key={r.path}>
                  <button onClick={() => void openPage(r.path)}>
                    <Clock aria-hidden /> {r.title}
                    <span className="muted" style={{ marginLeft: 'auto', fontSize: '0.88rem' }}>
                      {pathParent(r.path)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  )
}

const SHORTCUTS: [string, string][] = [
  ['⌘N', 'Nova página'],
  ['⇧⌘N', 'Nova subpágina'],
  ['⌥⌘N', 'Nova pasta'],
  ['⌘P', 'Ir para página'],
  ['⇧⌘F ou ⌘F', 'Buscar no espaço de trabalho'],
  ['⌘[ / ⌘]', 'Voltar / avançar'],
  ['⌘\\', 'Mostrar ou ocultar a barra lateral'],
  ['⌥⌘I', 'Painel de informações'],
  ['⌘S', 'Salvar agora'],
  ['⌘Z / ⇧⌘Z', 'Desfazer / refazer'],
  ['⌘= / ⌘− / ⌘0', 'Tamanho do texto'],
  ['⌘B ⌘I ⌘E', 'Negrito, itálico, código'],
  ['⇧⌘S', 'Tachado'],
  ['⌘K', 'Inserir ou editar link'],
  ['⌥⌘1 … ⌥⌘6', 'Títulos'],
  ['⇧⌘7 / ⇧⌘8 / ⇧⌘9', 'Lista numerada, com marcadores, de tarefas'],
  ['/', 'Menu de blocos'],
  ['[[', 'Link para outra página'],
  ['⌥ + clique', 'Posicionar o cursor dentro de um link sem abri-lo'],
  ['Setas, ↩, F2, ⌘⌫', 'Na barra lateral: navegar, abrir, renomear, excluir'],
  ['⌥⌘H', 'Histórico de versões'],
  ['⌥⌘C', 'Copiar Markdown da página'],
]

export function ShortcutsDialog() {
  return (
    <Modal onClose={() => setOverlay(null)} label="Atalhos de teclado" className="dialog wide">
      <h2>Atalhos de teclado</h2>
      <table className="grid" style={{ marginTop: '0.5rem' }}>
        <tbody>
          {SHORTCUTS.map(([k, d]) => (
            <tr key={k}>
              <td style={{ width: '14rem' }}>
                <kbd>{k}</kbd>
              </td>
              <td>{d}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="dialog-actions">
        <button className="btn" data-autofocus onClick={() => setOverlay(null)}>
          Fechar
        </button>
      </div>
    </Modal>
  )
}
