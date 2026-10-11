/**
 * UI state. Holds presentation state only — page content lives in files and
 * is loaded on demand through the API.
 */
import { create } from 'zustand'
import { api, errorMessage, type PageSummary, type Preset, type Settings, type Theme, type VaultInfo } from './api'

export type Route =
  | { kind: 'home' }
  | { kind: 'page'; path: string }
  | { kind: 'collection'; folder: string }
  | { kind: 'settings'; section?: string }
  | { kind: 'trash' }

export type ToastKind = 'info' | 'success' | 'error'
export interface Toast {
  id: number
  kind: ToastKind
  message: string
  action?: { label: string; run: () => void }
}

export type Dialog =
  | { kind: 'confirm'; title: string; message: string; confirmLabel: string; danger?: boolean; resolve: (ok: boolean) => void }
  | { kind: 'prompt'; title: string; label: string; initial: string; confirmLabel: string; resolve: (value: string | null) => void }

export type Overlay = 'quickOpen' | 'search' | 'history' | 'shortcuts' | null

interface AppState {
  ready: boolean
  settings: Settings | null
  themes: Theme[]
  fonts: string[]
  presets: Preset[]
  vault: VaultInfo | null
  route: Route
  backStack: Route[]
  forwardStack: Route[]
  treeVersion: number
  nav: { favorites: PageSummary[]; recents: PageSummary[] }
  overlay: Overlay
  infoPanel: boolean
  toasts: Toast[]
  dialog: Dialog | null
  /** Last vault change notification: paths and a counter. */
  externalChange: { seq: number; paths: string[] }
}

export const useApp = create<AppState>(() => ({
  ready: false,
  settings: null,
  themes: [],
  fonts: [],
  presets: [],
  vault: null,
  route: { kind: 'home' },
  backStack: [],
  forwardStack: [],
  treeVersion: 0,
  nav: { favorites: [], recents: [] },
  overlay: null,
  infoPanel: false,
  toasts: [],
  dialog: null,
  externalChange: { seq: 0, paths: [] },
}))

const set = useApp.setState
const get = useApp.getState

// ----- Toasts ---------------------------------------------------------------

let toastSeq = 0
export function toast(message: string, kind: ToastKind = 'info', action?: Toast['action']) {
  const id = ++toastSeq
  set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, message, action }] }))
  setTimeout(() => dismissToast(id), kind === 'error' ? 9000 : 4500)
}
export function dismissToast(id: number) {
  set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}
export function toastError(e: unknown, prefix?: string) {
  toast(prefix ? `${prefix}: ${errorMessage(e)}` : errorMessage(e), 'error')
}

// ----- Dialogs ----------------------------------------------------------------

export function confirmDialog(opts: { title: string; message: string; confirmLabel?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    set({ dialog: { kind: 'confirm', confirmLabel: 'Confirmar', ...opts, resolve } })
  })
}

export function promptDialog(opts: { title: string; label: string; initial?: string; confirmLabel?: string }): Promise<string | null> {
  return new Promise((resolve) => {
    set({ dialog: { kind: 'prompt', initial: '', confirmLabel: 'OK', ...opts, resolve } })
  })
}

export function closeDialog() {
  set({ dialog: null })
}

// ----- Save coordination ----------------------------------------------------------

/** Open editors register a flush so navigation never loses typing. */
const flushers = new Set<() => Promise<void>>()
export function registerFlush(fn: () => Promise<void>) {
  flushers.add(fn)
  return () => {
    flushers.delete(fn)
  }
}
export async function flushAll() {
  await Promise.all([...flushers].map((f) => f().catch(() => undefined)))
}

// ----- Navigation ---------------------------------------------------------------------

const sameRoute = (a: Route, b: Route) => JSON.stringify(a) === JSON.stringify(b)

export async function navigate(route: Route, opts: { replace?: boolean } = {}) {
  const current = get().route
  if (sameRoute(current, route)) return
  await flushAll()
  if (opts.replace) set({ route })
  else set((s) => ({ route, backStack: [...s.backStack.slice(-99), current], forwardStack: [] }))
}

export async function goBack() {
  const { backStack, route } = get()
  const prev = backStack[backStack.length - 1]
  if (!prev) return
  await flushAll()
  set((s) => ({ route: prev, backStack: s.backStack.slice(0, -1), forwardStack: [route, ...s.forwardStack] }))
}

export async function goForward() {
  const { forwardStack, route } = get()
  const next = forwardStack[0]
  if (!next) return
  await flushAll()
  set((s) => ({ route: next, forwardStack: s.forwardStack.slice(1), backStack: [...s.backStack, route] }))
}

export function openPage(path: string) {
  return navigate({ kind: 'page', path })
}

/** Rewrites routes in the history after a rename/move. */
export function rebaseRoutes(moves: [string, string][]) {
  const fix = (r: Route): Route => {
    for (const [from, to] of moves) {
      if (r.kind === 'page' && (r.path === from || r.path.startsWith(from + '/'))) return { ...r, path: to + r.path.slice(from.length) }
      if (r.kind === 'collection' && (r.folder === from || r.folder.startsWith(from + '/'))) return { ...r, folder: to + r.folder.slice(from.length) }
    }
    return r
  }
  set((s) => ({ route: fix(s.route), backStack: s.backStack.map(fix), forwardStack: s.forwardStack.map(fix) }))
}

/** Removes routes pointing at a deleted path. */
export function dropRoutes(prefix: string) {
  const dead = (r: Route) =>
    (r.kind === 'page' && (r.path === prefix || r.path.startsWith(prefix.replace(/\.md$/, '') + '/'))) ||
    (r.kind === 'collection' && (r.folder === prefix || r.folder.startsWith(prefix + '/')))
  set((s) => ({
    route: dead(s.route) ? { kind: 'home' } : s.route,
    backStack: s.backStack.filter((r) => !dead(r)),
    forwardStack: s.forwardStack.filter((r) => !dead(r)),
  }))
}

// ----- Data refresh -----------------------------------------------------------------------

export function refreshTree() {
  set((s) => ({ treeVersion: s.treeVersion + 1 }))
  void refreshNav()
}

export async function refreshNav() {
  if (!get().vault) return
  try {
    set({ nav: await api.navState() })
  } catch {
    /* vault closed meanwhile */
  }
}

export async function refreshThemes() {
  set({ themes: await api.themesList() })
}

// ----- Settings ------------------------------------------------------------------------------

let settingsTimer: ReturnType<typeof setTimeout> | undefined
/** Applies a settings change immediately and persists it shortly after. */
export function updateSettings(mutate: (s: Settings) => void) {
  const current = get().settings
  if (!current) return
  const next: Settings = structuredClone(current)
  mutate(next)
  set({ settings: next })
  clearTimeout(settingsTimer)
  settingsTimer = setTimeout(async () => {
    try {
      const saved = await api.settingsSet(get().settings!)
      // Keep UI values unless the backend clamped them.
      if (JSON.stringify(saved) !== JSON.stringify(get().settings)) set({ settings: saved })
    } catch (e) {
      toastError(e, 'Não foi possível salvar os ajustes')
    }
  }, 250)
}

// ----- Vault ------------------------------------------------------------------------------------

export async function openVault(path: string) {
  try {
    await flushAll()
    const vault = await api.vaultOpen(path)
    set({ vault, route: { kind: 'home' }, backStack: [], forwardStack: [], settings: await api.settingsGet() })
    refreshTree()
    return true
  } catch (e) {
    toastError(e, 'Não foi possível abrir a pasta')
    return false
  }
}

export function setOverlay(overlay: Overlay) {
  set({ overlay })
}
