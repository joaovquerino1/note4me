/**
 * User-level actions shared by the menu bar, sidebar, context menus and
 * keyboard shortcuts. Destructive actions always ask first.
 */
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { api, isMarkdown, pathName, pathParent, pathStem, type TreeEntry } from './api'
import {
  confirmDialog,
  dropRoutes,
  flushAll,
  navigate,
  openPage,
  openVault,
  promptDialog,
  rebaseRoutes,
  refreshTree,
  toast,
  toastError,
  useApp,
} from './store'

export function currentPagePath(): string | null {
  const r = useApp.getState().route
  return r.kind === 'page' ? r.path : null
}

/** Folder or page that new items should go into, from the current context. */
export function currentContainer(): string {
  const r = useApp.getState().route
  if (r.kind === 'page') return pathParent(r.path)
  if (r.kind === 'collection') return r.folder
  return ''
}

export async function newPage(parent = currentContainer(), title?: string) {
  const name = title ?? (await promptDialog({ title: 'Nova página', label: 'Título', initial: 'Sem título', confirmLabel: 'Criar' }))
  if (!name) return null
  try {
    const path = await api.pageCreate(parent, name)
    refreshTree()
    await openPage(path)
    return path
  } catch (e) {
    toastError(e, 'Não foi possível criar a página')
    return null
  }
}

export async function newSubpage() {
  const page = currentPagePath()
  if (!page) return newPage('')
  return newPage(page)
}

export async function newFolder(parent = currentContainer()) {
  const name = await promptDialog({ title: 'Nova pasta', label: 'Nome da pasta', initial: 'Nova pasta', confirmLabel: 'Criar' })
  if (!name) return
  try {
    await api.folderCreate(parent, name)
    refreshTree()
  } catch (e) {
    toastError(e, 'Não foi possível criar a pasta')
  }
}

function reportRelocation(report: { linksUpdated: number; pagesUpdated: string[]; errors: string[] }) {
  if (report.errors.length) toast(`Alguns links não puderam ser atualizados: ${report.errors.join('; ')}`, 'error')
  else if (report.linksUpdated > 0)
    toast(`${report.linksUpdated} link${report.linksUpdated > 1 ? 's' : ''} atualizado${report.linksUpdated > 1 ? 's' : ''} em ${report.pagesUpdated.length} página${report.pagesUpdated.length > 1 ? 's' : ''}.`, 'success')
}

export async function renameEntry(path: string, newName?: string) {
  const current = isMarkdown(path) ? pathStem(path) : pathName(path)
  const name = newName ?? (await promptDialog({ title: 'Renomear', label: 'Novo nome', initial: current, confirmLabel: 'Renomear' }))
  if (!name || name === current) return null
  try {
    await flushAll()
    const report = await api.entryRename(path, name)
    rebaseRoutes(report.moves)
    refreshTree()
    reportRelocation(report)
    return report.path
  } catch (e) {
    toastError(e, 'Não foi possível renomear')
    return null
  }
}

export async function moveEntry(path: string, dest: string) {
  try {
    await flushAll()
    const report = await api.entryMove(path, dest)
    rebaseRoutes(report.moves)
    refreshTree()
    reportRelocation(report)
    return report.path
  } catch (e) {
    toastError(e, 'Não foi possível mover')
    return null
  }
}

export async function deleteEntry(entry: Pick<TreeEntry, 'path' | 'kind' | 'hasChildren'>) {
  const name = entry.kind === 'page' ? pathStem(entry.path) : pathName(entry.path)
  const what = entry.kind === 'folder' ? 'a pasta' : entry.kind === 'file' ? 'o arquivo' : 'a página'
  const extra = entry.hasChildren ? ' Todo o conteúdo dentro dela também irá para a lixeira.' : ''
  const ok = await confirmDialog({
    title: `Mover ${what} para a lixeira?`,
    message: `“${name}” será movid${entry.kind === 'folder' ? 'a' : entry.kind === 'file' ? 'o' : 'a'} para a lixeira do note4me e poderá ser restaurad${entry.kind === 'file' ? 'o' : 'a'} depois.${extra}`,
    confirmLabel: 'Mover para a lixeira',
    danger: true,
  })
  if (!ok) return
  try {
    await flushAll()
    const t = await api.entryDelete(entry.path)
    dropRoutes(entry.path)
    if (t.children) dropRoutes(t.children)
    refreshTree()
    toast(`“${name}” foi para a lixeira.`, 'info', {
      label: 'Desfazer',
      run: async () => {
        try {
          const restored = await api.trashRestore(t.id)
          refreshTree()
          if (isMarkdown(restored)) void openPage(restored)
        } catch (e) {
          toastError(e)
        }
      },
    })
  } catch (e) {
    toastError(e, 'Não foi possível excluir')
  }
}

export async function duplicatePage(path: string) {
  try {
    await flushAll()
    const p = await api.pageDuplicate(path)
    refreshTree()
    await openPage(p)
  } catch (e) {
    toastError(e, 'Não foi possível duplicar')
  }
}

export async function toggleFavorite(path: string) {
  const isFav = useApp.getState().nav.favorites.some((f) => f.path === path)
  try {
    await api.favoriteSet(path, !isFav)
    refreshTree()
  } catch (e) {
    toastError(e)
  }
}

export async function reveal(path: string) {
  try {
    await api.revealInFinder(path)
  } catch (e) {
    toastError(e, 'Não foi possível mostrar no Finder')
  }
}

export async function chooseVault() {
  const dir = await openDialog({ directory: true, multiple: false, title: 'Escolha a pasta do espaço de trabalho' })
  if (typeof dir === 'string') await openVault(dir)
}

export async function createVault() {
  const parent = await openDialog({ directory: true, multiple: false, title: 'Onde criar o novo espaço de trabalho?' })
  if (typeof parent !== 'string') return
  const name = await promptDialog({ title: 'Novo espaço de trabalho', label: 'Nome da pasta', initial: 'Notas', confirmLabel: 'Criar' })
  if (!name) return
  try {
    await flushAll()
    const vault = await api.vaultCreate(parent, name)
    useApp.setState({ vault, route: { kind: 'home' }, backStack: [], forwardStack: [], settings: await api.settingsGet() })
    refreshTree()
    void openPage('Início.md')
  } catch (e) {
    toastError(e, 'Não foi possível criar o espaço de trabalho')
  }
}

export async function importMarkdown(kind: 'files' | 'folder', dest = currentContainer()) {
  const picked =
    kind === 'files'
      ? await openDialog({ multiple: true, directory: false, title: 'Importar arquivos Markdown', filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }] })
      : await openDialog({ multiple: true, directory: true, title: 'Importar pastas (com subpastas e anexos)' })
  const sources = (Array.isArray(picked) ? picked : picked ? [picked] : []) as string[]
  if (!sources.length) return
  try {
    const r = await api.importPaths(sources, dest)
    refreshTree()
    const parts = [`${r.importedPages} página${r.importedPages === 1 ? '' : 's'} e ${r.importedFiles} arquivo${r.importedFiles === 1 ? '' : 's'} importados`]
    if (r.renamed.length) parts.push(`${r.renamed.length} renomeado(s) para evitar sobrescrita`)
    if (r.warnings.length) parts.push(`avisos: ${r.warnings.join('; ')}`)
    if (r.skipped.length) parts.push(`ignorados: ${r.skipped.join('; ')}`)
    toast(parts.join('. ') + '.', r.warnings.length || r.skipped.length ? 'info' : 'success')
    const first = r.rootItems.find(isMarkdown)
    if (first) void openPage(first)
  } catch (e) {
    toastError(e, 'A importação falhou')
  }
}

export async function exportPage(path = currentPagePath()) {
  if (!path) return toast('Abra uma página para exportá-la.')
  const dest = await openDialog({ directory: true, multiple: false, title: 'Escolha onde salvar a exportação' })
  if (typeof dest !== 'string') return
  const withSub = await confirmDialog({
    title: 'Incluir subpáginas?',
    message: 'A exportação cria uma pasta nova com a página e seus anexos. Deseja incluir também as subpáginas?',
    confirmLabel: 'Incluir subpáginas',
  })
  try {
    await flushAll()
    const r = await api.exportPage(path, dest, withSub)
    const notes: string[] = []
    if (r.externalLinks.length) notes.push(`${r.externalLinks.length} link(s) para páginas não incluídas`)
    if (r.missing.length) notes.push(`${r.missing.length} anexo(s) ausente(s)`)
    toast(`Exportadas ${r.pages} página(s) e ${r.attachments} anexo(s).${notes.length ? ' ' + notes.join('; ') + '.' : ''}`, 'success', {
      label: 'Mostrar',
      run: () => void api.revealAbs(r.destination).catch(toastError),
    })
  } catch (e) {
    toastError(e, 'A exportação falhou')
  }
}

export async function exportVault() {
  const dest = await openDialog({ directory: true, multiple: false, title: 'Escolha onde salvar a cópia do espaço de trabalho' })
  if (typeof dest !== 'string') return
  try {
    await flushAll()
    const r = await api.exportVault(dest)
    toast(`Cópia criada com ${r.pages} página(s) e ${r.attachments} outro(s) arquivo(s).`, 'success', { label: 'Mostrar', run: () => void api.revealAbs(r.destination).catch(toastError) })
  } catch (e) {
    toastError(e, 'A exportação falhou')
  }
}

export async function openSettings(section?: string) {
  await navigate({ kind: 'settings', section })
}
