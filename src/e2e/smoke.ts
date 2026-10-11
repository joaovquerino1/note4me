/**
 * End-to-end smoke test that runs inside the real app (real WebView, real
 * Rust backend, real files). Enabled only in debug builds when the
 * NOTE4ME_E2E_OUT environment variable is set; see scripts/e2e.sh.
 */
import { invoke } from '@tauri-apps/api/core'
import { api } from '../api'
import { renameEntry } from '../actions'
import { goBack, openPage, openVault, updateSettings, useApp } from '../store'

interface Result {
  name: string
  ok: boolean
  detail?: string
  ms: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor<T>(what: string, fn: () => T | Promise<T>, timeout = 6000): Promise<NonNullable<T>> {
  const start = performance.now()
  let last: unknown
  while (performance.now() - start < timeout) {
    try {
      const v = await fn()
      if (v) return v as NonNullable<T>
    } catch (e) {
      last = e
    }
    await sleep(50)
  }
  throw new Error(`timeout: ${what}${last ? ` (${String(last)})` : ''}`)
}

const readFile = (path: string) => invoke<string>('e2e_read_file', { path })
const writeFile = (path: string, content: string) => invoke<void>('e2e_write_file', { path, content })
const editorEl = () => document.querySelector<HTMLElement>('.editor .ProseMirror')

function typeAtEnd(text: string) {
  const el = editorEl()!
  el.focus()
  const sel = getSelection()!
  const range = document.createRange()
  const paragraphs = [...el.querySelectorAll(':scope > p')]
  range.selectNodeContents(paragraphs[paragraphs.length - 1] ?? el)
  range.collapse(false)
  sel.removeAllRanges()
  sel.addRange(range)
  document.execCommand('insertText', false, text)
}

function key(target: Element, k: string, opts: KeyboardEventInit = {}) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }))
}

export async function runSmoke(vault: string) {
  const results: Result[] = []
  const step = async (name: string, fn: () => Promise<void>) => {
    const t = performance.now()
    try {
      await fn()
      results.push({ name, ok: true, ms: Math.round(performance.now() - t) })
    } catch (e) {
      results.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e), ms: Math.round(performance.now() - t) })
    }
  }
  const assert = (cond: unknown, msg: string) => {
    if (!cond) throw new Error(msg)
  }

  await step('abre o espaço de trabalho e indexa os arquivos', async () => {
    assert(await openVault(vault), 'openVault falhou')
    const v = useApp.getState().vault
    assert(v && v.pageCount >= 3, `pageCount=${v?.pageCount}`)
    updateSettings((s) => {
      s.editor.autosaveDelayMs = 300
      s.files.historyIntervalMin = 0
    })
  })

  await step('abrir página existente sem alterá-la', async () => {
    const before = await readFile('Notas.md')
    await openPage('Notas.md')
    await waitFor('editor', () => editorEl()?.textContent?.includes('Texto original'))
    await sleep(900)
    assert((await readFile('Notas.md')) === before, 'arquivo mudou só por abrir')
  })

  await step('digitar salva automaticamente no arquivo .md', async () => {
    typeAtEnd(' Digitado no app.')
    await waitFor('salvo no disco', async () => (await readFile('Notas.md')).includes('Digitado no app.'), 5000)
    const content = await readFile('Notas.md')
    assert(content.startsWith('---\ncustom: manter\n'), 'frontmatter alterado')
    assert(content.includes('| a | b |'), 'tabela não editada foi reescrita')
  })

  await step('alteração externa recarrega a página sem conflito', async () => {
    await sleep(400)
    const cur = await readFile('Notas.md')
    await writeFile('Notas.md', cur.replace('Texto original', 'Texto editado fora'))
    await waitFor('editor recarregado', () => editorEl()?.textContent?.includes('Texto editado fora'), 6000)
  })

  await step('conflito: edição externa durante edição local não sobrescreve', async () => {
    updateSettings((s) => void (s.editor.autosaveDelayMs = 4000))
    await sleep(400)
    typeAtEnd(' Local pendente.')
    const external = (await readFile('Notas.md')) + '\nLinha externa concorrente.\n'
    await writeFile('Notas.md', external)
    await waitFor('banner de conflito', () => document.querySelector('.banner[data-kind="danger"]'), 6000)
    await sleep(300)
    assert((await readFile('Notas.md')) === external, 'arquivo externo foi sobrescrito')
    const keep = [...document.querySelectorAll<HTMLButtonElement>('.banner button')].find((b) => b.textContent?.includes('Manter a minha'))
    assert(keep, 'botão manter não encontrado')
    keep!.click()
    await waitFor('versão local salva', async () => (await readFile('Notas.md')).includes('Local pendente.'))
    const versions = await api.historyList('Notas.md')
    const contents = await Promise.all(versions.map((v) => api.historyRead('Notas.md', v.timestamp).then((r) => r.content)))
    assert(contents.some((c) => c.includes('Linha externa concorrente.')), 'versão externa não foi guardada no histórico')
    updateSettings((s) => void (s.editor.autosaveDelayMs = 300))
  })

  await step('tema e tipografia não modificam arquivos', async () => {
    await sleep(500)
    const before = await readFile('Notas.md')
    updateSettings((s) => {
      s.appearance.mode = 'light'
      s.appearance.lightTheme = 'warm-paper'
      s.typography.contentSize = 22
      s.typography.contentFont = { family: 'ui-serif', generic: 'serif' }
    })
    await sleep(300)
    updateSettings((s) => void (s.appearance.mode = 'dark'))
    await sleep(900)
    assert((await readFile('Notas.md')) === before, 'arquivo mudou após trocar tema/tipografia')
    const bg = getComputedStyle(document.body).backgroundColor
    assert(bg === 'rgb(30, 30, 31)', `fundo do tema escuro inesperado: ${bg}`)
    updateSettings((s) => {
      s.typography.contentSize = 16
      s.appearance.mode = 'system'
    })
  })

  await step('renomear página atualiza links em outras páginas', async () => {
    const newPath = await renameEntry('Notas.md', 'Notas Renomeadas')
    assert(newPath === 'Notas Renomeadas.md', `novo caminho ${newPath}`)
    const other = await readFile('Pasta/Outra.md')
    assert(other.includes('[notas](../Notas%20Renomeadas.md)'), `link não atualizado: ${other}`)
    assert(useApp.getState().route.kind === 'page' && (useApp.getState().route as { path: string }).path === 'Notas Renomeadas.md', 'rota não acompanhou')
  })

  await step('busca encontra conteúdo sem acentos', async () => {
    const hits = await api.search({ text: 'pendente' })
    assert(hits.some((h) => h.path === 'Notas Renomeadas.md'), 'sem resultado')
    const accent = await api.search({ text: 'programacao' })
    assert(accent.some((h) => h.path === 'Pasta/Outra.md'), 'busca sem acento falhou')
  })

  await step('navegação por teclado na árvore abre página', async () => {
    const tree = await waitFor('árvore', () => document.querySelector<HTMLElement>('[role="tree"]'))
    tree.focus()
    await sleep(100)
    const rows = () => [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')]
    const target = rows().findIndex((r) => r.dataset.path === 'Pasta')
    assert(target >= 0, 'pasta não está na árvore')
    const press = async (k: string) => {
      key(tree, k)
      await sleep(40)
    }
    await press('Home')
    for (let i = 0; i < target; i++) await press('ArrowDown')
    await press('ArrowRight')
    await waitFor('pasta expandida', () => rows().some((r) => r.dataset.path === 'Pasta/Outra.md'))
    await press('ArrowDown')
    await press('Enter')
    await waitFor('página aberta', () => (useApp.getState().route as { path?: string }).path === 'Pasta/Outra.md')
    await goBack()
  })

  await step('escala de interface 200% sem rolagem horizontal', async () => {
    updateSettings((s) => void (s.accessibility.uiScale = 200))
    await sleep(400)
    const doc = document.documentElement
    assert(doc.scrollWidth <= innerWidth + 1, `scrollWidth ${doc.scrollWidth} > ${innerWidth}`)
    const top = document.querySelector('.topbar')!.getBoundingClientRect()
    assert(top.right <= innerWidth + 1, 'barra superior cortada')
    updateSettings((s) => void (s.accessibility.uiScale = 100))
  })

  await step('menu / insere blocos via teclado', async () => {
    await openPage('Notas Renomeadas.md')
    await waitFor('editor', () => editorEl())
    await sleep(300)
    const el = editorEl()!
    typeAtEnd('')
    key(el, 'Enter')
    document.execCommand('insertText', false, '/tare')
    await waitFor('popup do menu', () => document.querySelector('.slash-menu [role="option"]'))
    key(el, 'Enter')
    document.execCommand('insertText', false, 'Tarefa criada pelo teste')
    await waitFor('tarefa salva', async () => (await readFile('Notas Renomeadas.md')).includes('- [ ] Tarefa criada pelo teste'), 5000)
  })

  await step('excluir vai para a lixeira e pode ser restaurado', async () => {
    const entry = await api.entryDelete('Pasta/Outra.md')
    const gone = await readFile('Pasta/Outra.md').then(() => false, () => true)
    assert(gone, 'arquivo ainda existe')
    const restored = await api.trashRestore(entry.id)
    assert(restored === 'Pasta/Outra.md', `restaurado em ${restored}`)
    assert((await readFile('Pasta/Outra.md')).includes('Programação'), 'conteúdo perdido')
  })

  await step('reconstruir o índice a partir dos arquivos', async () => {
    const info = await api.vaultReindex()
    assert(info.pageCount >= 3, `pageCount ${info.pageCount}`)
    const bl = await api.backlinks('Notas Renomeadas.md')
    assert(bl.length === 1, `backlinks ${bl.length}`)
  })

  const report = { passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results }
  await invoke('e2e_finish', { report })
}

/** Visits the main screens, pausing on each so they can be screenshotted. */
export async function runTour(vault: string) {
  const mark = async (name: string) => {
    await sleep(900)
    await invoke('e2e_mark', { name })
    await sleep(2200)
  }
  const { navigate, setOverlay } = await import('../store')
  await openVault(vault)
  updateSettings((s) => {
    s.appearance.mode = 'light'
    s.appearance.lightTheme = 'light-classic'
  })
  await openPage('Início.md')
  await mark('page-light')
  updateSettings((s) => void (s.appearance.mode = 'dark'))
  await mark('page-dark')
  updateSettings((s) => {
    s.appearance.mode = 'light'
    s.appearance.lightTheme = 'warm-paper'
    s.typography = { ...useApp.getState().presets.find((p) => p.id === 'editorial')!.values }
  })
  await mark('page-warm-editorial')
  updateSettings((s) => {
    s.appearance.lightTheme = 'light-classic'
    s.typography = { ...useApp.getState().presets.find((p) => p.id === 'default')!.values }
  })
  await navigate({ kind: 'collection', folder: 'Projetos' })
  await mark('collection')
  await navigate({ kind: 'settings', section: 'appearance' })
  await mark('settings-appearance')
  await navigate({ kind: 'settings', section: 'typography' })
  await mark('settings-typography')
  await openPage('Início.md')
  setOverlay('search')
  await sleep(300)
  const input = document.querySelector<HTMLInputElement>('.palette input')
  if (input) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, 'rust')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  await mark('search')
  setOverlay(null)
  updateSettings((s) => {
    s.appearance.mode = 'dark'
    s.accessibility.highContrast = 'on'
    s.accessibility.uiScale = 150
  })
  await mark('hc-dark-150')
  updateSettings((s) => {
    s.appearance.mode = 'dark'
    s.appearance.darkTheme = 'midnight'
    s.accessibility.highContrast = 'off'
    s.accessibility.uiScale = 100
  })
  await mark('midnight')
  await invoke('e2e_finish', { report: { tour: true } })
}
