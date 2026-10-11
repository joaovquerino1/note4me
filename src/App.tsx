import { useEffect } from 'react'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { api } from './api'
import { applyAppearance, readEnvironment } from './appearance'
import { chooseVault, currentPagePath, exportPage, exportVault, importMarkdown, newFolder, newPage, newSubpage, openSettings, reveal } from './actions'
import { pageCommands } from './pageCommands'
import { flushAll, goBack, goForward, navigate, openVault, refreshTree, setOverlay, toast, toastError, updateSettings, useApp } from './store'
import { MenuHost } from './ui/Menu'
import { DialogHost, ToastHost } from './ui/Hosts'
import { Sidebar } from './components/Sidebar'
import { PageView } from './components/PageView'
import { CollectionView } from './components/CollectionView'
import { SettingsView } from './components/SettingsView'
import { HistoryDialog, TrashView } from './components/HistoryTrash'
import { QuickOpen, SearchPanel } from './components/Palettes'
import { Home, ShortcutsDialog, Welcome } from './components/Home'
import { MovePicker } from './components/MovePicker'

function isTextInput(el: Element | null) {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
}

function changeTextSize(delta: number | 'reset') {
  updateSettings((s) => {
    const next = delta === 'reset' ? 16 : Math.round((s.typography.contentSize + delta) * 2) / 2
    s.typography.contentSize = Math.max(11, Math.min(40, next))
  })
}

async function handleMenu(id: string) {
  const page = currentPagePath()
  const hasVault = Boolean(useApp.getState().vault)
  const needVault = () => {
    if (!hasVault) toast('Abra um espaço de trabalho primeiro.')
    return hasVault
  }
  switch (id) {
    case 'settings':
      return openSettings()
    case 'new-page':
      return needVault() && newPage()
    case 'new-subpage':
      return needVault() && newSubpage()
    case 'new-folder':
      return needVault() && newFolder()
    case 'open-vault':
      return chooseVault()
    case 'save-now':
      return pageCommands.current?.save()
    case 'import-files':
      return needVault() && importMarkdown('files')
    case 'import-folder':
      return needVault() && importMarkdown('folder')
    case 'export-page':
      return exportPage()
    case 'export-vault':
      return needVault() && exportVault()
    case 'reveal':
      return page && reveal(page)
    case 'copy-markdown':
      return pageCommands.current?.copyMarkdown().catch(toastError)
    case 'history':
      return page ? setOverlay('history') : toast('Abra uma página para ver o histórico.')
    case 'trash':
      return needVault() && navigate({ kind: 'trash' })
    case 'undo':
    case 'redo': {
      const el = document.activeElement
      if (pageCommands.current?.editorContains(el)) return id === 'undo' ? pageCommands.current.undo() : pageCommands.current.redo()
      if (isTextInput(el)) document.execCommand(id)
      return
    }
    case 'find':
      return needVault() && setOverlay('search')
    case 'quick-open':
      return needVault() && setOverlay('quickOpen')
    case 'toggle-sidebar':
      return updateSettings((s) => void (s.appearance.sidebarVisible = !s.appearance.sidebarVisible))
    case 'toggle-info':
      return useApp.setState((s) => ({ infoPanel: !s.infoPanel }))
    case 'back':
      return goBack()
    case 'forward':
      return goForward()
    case 'text-bigger':
      return changeTextSize(1)
    case 'text-smaller':
      return changeTextSize(-1)
    case 'text-reset':
      return changeTextSize('reset')
    case 'shortcuts':
      return setOverlay('shortcuts')
  }
}

let booted = false

export function App() {
  const ready = useApp((s) => s.ready)
  const settings = useApp((s) => s.settings)
  const themes = useApp((s) => s.themes)
  const vault = useApp((s) => s.vault)
  const route = useApp((s) => s.route)
  const overlay = useApp((s) => s.overlay)

  // Boot: preferences, themes, fonts, then the last vault.
  useEffect(() => {
    if (booted) return
    booted = true
    void (async () => {
      try {
        const [settings, themes, fonts, presets] = await Promise.all([api.settingsGet(), api.themesList(), api.fontsList(), api.typographyPresets()])
        useApp.setState({ settings, themes, fonts, presets })
        if (import.meta.env.DEV) {
          const e2e = await invoke<{ vault: string; mode: string } | null>('e2e_config').catch(() => null)
          if (e2e) {
            useApp.setState({ ready: true })
            const mod = await import('./e2e/smoke')
            return void (e2e.mode === 'tour' ? mod.runTour(e2e.vault) : mod.runSmoke(e2e.vault))
          }
        }
        if (settings.lastVault) {
          const ok = await openVault(settings.lastVault)
          if (ok) {
            const nav = await api.navState().catch(() => null)
            const last = nav?.recents[0]
            if (last) useApp.setState({ route: { kind: 'page', path: last.path } })
          }
        }
      } catch (e) {
        toastError(e, 'Falha ao iniciar')
      } finally {
        useApp.setState({ ready: true })
      }
    })()
  }, [])

  // Appearance follows settings and the system (dark mode, motion, contrast).
  useEffect(() => {
    if (!settings) return
    const apply = () => applyAppearance(settings, themes, readEnvironment())
    apply()
    const queries = ['(prefers-color-scheme: dark)', '(prefers-reduced-motion: reduce)', '(prefers-contrast: more)'].map((q) => matchMedia(q))
    queries.forEach((q) => q.addEventListener('change', apply))
    return () => queries.forEach((q) => q.removeEventListener('change', apply))
  }, [settings, themes])

  // Native menu, file-system changes, file drops, window close.
  useEffect(() => {
    const unlisten: Promise<() => void>[] = []
    unlisten.push(listen<string>('menu', (e) => void handleMenu(e.payload)))
    let pending: string[] = []
    let timer: ReturnType<typeof setTimeout> | undefined
    unlisten.push(
      listen<string[]>('vault:changed', (e) => {
        pending.push(...e.payload)
        clearTimeout(timer)
        timer = setTimeout(() => {
          const paths = [...new Set(pending)]
          pending = []
          useApp.setState((s) => ({ externalChange: { seq: s.externalChange.seq + 1, paths } }))
          refreshTree()
        }, 120)
      }),
    )
    unlisten.push(
      getCurrentWebview().onDragDropEvent(async (event) => {
        if (event.payload.type !== 'drop' || !useApp.getState().vault) return
        const ratio = window.devicePixelRatio || 1
        const x = event.payload.position.x / ratio
        const y = event.payload.position.y / ratio
        const target = document.elementFromPoint(x, y)
        const paths = event.payload.paths
        if (target?.closest('.editor') && pageCommands.current) {
          await pageCommands.current.insertFiles(paths, { x, y })
          return
        }
        const row = target?.closest<HTMLElement>('[data-path]')
        const dest = row ? (row.dataset.kind === 'file' ? '' : row.dataset.path!) : ''
        try {
          const r = await api.importPaths(paths, dest)
          refreshTree()
          toast(`${r.importedPages} página(s) e ${r.importedFiles} arquivo(s) copiados para o espaço de trabalho.`, 'success')
        } catch (e) {
          toastError(e, 'Não foi possível importar')
        }
      }),
    )
    unlisten.push(
      getCurrentWindow().onCloseRequested(async () => {
        await flushAll()
      }),
    )
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f' && useApp.getState().vault) {
        e.preventDefault()
        setOverlay('search')
      }
    }
    addEventListener('keydown', onKey)
    // Last line of defence: save pending edits when the page is hidden.
    const onHide = () => document.visibilityState === 'hidden' && void flushAll()
    document.addEventListener('visibilitychange', onHide)
    return () => {
      unlisten.forEach((p) => void p.then((f) => f()))
      removeEventListener('keydown', onKey)
      document.removeEventListener('visibilitychange', onHide)
    }
  }, [])

  if (!ready || !settings) return <div className="app" aria-busy="true" />

  const sidebar = settings.appearance.sidebarVisible
  let view: React.ReactNode
  switch (route.kind) {
    case 'page':
      view = <PageView key={route.path} path={route.path} />
      break
    case 'collection':
      view = <CollectionView key={route.folder} folder={route.folder} />
      break
    case 'settings':
      view = <SettingsView section={route.section} />
      break
    case 'trash':
      view = <TrashView />
      break
    default:
      view = vault ? <Home /> : null
  }

  return (
    <div className={`app ${sidebar && vault ? '' : 'no-sidebar'}`}>
      {vault ? (
        <>
          {sidebar && <Sidebar />}
          <main className="main" aria-label="Conteúdo">
            {view}
          </main>
        </>
      ) : route.kind === 'settings' ? (
        <main className="main">{view}</main>
      ) : (
        <Welcome />
      )}
      {overlay === 'quickOpen' && <QuickOpen />}
      {overlay === 'search' && <SearchPanel />}
      {overlay === 'history' && <HistoryDialog />}
      {overlay === 'shortcuts' && <ShortcutsDialog />}
      <MovePicker />
      <MenuHost />
      <DialogHost />
      <ToastHost />
    </div>
  )
}
