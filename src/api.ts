/**
 * Typed wrappers around the Rust commands. The UI never touches the file
 * system directly; every read and write goes through these calls.
 */
import { invoke } from '@tauri-apps/api/core'

export interface CoreError {
  kind: string
  message: string
}

export function isCoreError(e: unknown): e is CoreError {
  return typeof e === 'object' && e !== null && 'kind' in e && 'message' in e
}

export function errorMessage(e: unknown): string {
  if (isCoreError(e)) return e.message
  if (e instanceof Error) return e.message
  return String(e)
}

const call = <T>(cmd: string, args?: Record<string, unknown>) => invoke<T>(cmd, args)

// ----- Types mirrored from note4me-core -------------------------------------

export type ThemeMode = 'system' | 'light' | 'dark'
export type Density = 'compact' | 'comfortable' | 'spacious'
export type Tristate = 'system' | 'on' | 'off'
export type Generic = 'sans' | 'serif' | 'mono'

export interface FontChoice {
  family: string
  generic: Generic
}

export interface Typography {
  preset: string | null
  uiFont: FontChoice
  contentFont: FontChoice
  headingFont: FontChoice
  codeFont: FontChoice
  contentSize: number
  weight: number
  headingWeight: number
  lineHeight: number
  paragraphSpacing: number
  letterSpacing: number
  maxWidth: number
  align: 'left' | 'justify'
  tableSize: number
  codeSize: number
}

export type AttachmentLocation = { mode: 'vaultFolder'; folder: string } | { mode: 'sameFolder' } | { mode: 'subfolder'; folder: string }

export interface Settings {
  version: number
  lastVault: string | null
  recentVaults: string[]
  appearance: {
    mode: ThemeMode
    lightTheme: string
    darkTheme: string
    density: Density
    sidebarWidth: number
    sidebarVisible: boolean
    showFilesInSidebar: boolean
    effects: boolean
  }
  typography: Typography
  accessibility: {
    uiScale: number
    reduceMotion: Tristate
    highContrast: Tristate
    strongFocus: boolean
    underlineLinks: boolean
  }
  editor: {
    autosave: boolean
    autosaveDelayMs: number
    spellcheck: boolean
    slashMenu: boolean
    showWordCount: boolean
    newPageFrontmatter: boolean
    linkFormat: 'markdown' | 'wiki'
    confirmExternalLinks: boolean
  }
  files: {
    attachmentLocation: AttachmentLocation
    maxAttachmentMb: number
    maxIndexFileMb: number
    historyEnabled: boolean
    historyIntervalMin: number
    historyMaxVersions: number
  }
}

export interface Theme {
  format: string
  version: number
  id: string
  name: string
  mode: 'light' | 'dark'
  highContrast: boolean
  builtin: boolean
  colors: Record<string, string>
}

export interface ContrastCheck {
  pair: string
  ratio: number
  required: number
  ok: boolean
}

export interface ThemeReport {
  errors: string[]
  checks: ContrastCheck[]
}

export interface Preset {
  id: string
  name: string
  description: string
  values: Typography
}

export interface VaultInfo {
  root: string
  name: string
  pageCount: number
}

export type EntryKind = 'page' | 'folder' | 'file'

export interface TreeEntry {
  path: string
  name: string
  kind: EntryKind
  childrenDir: string | null
  hasChildren: boolean
  modified: number
}

export interface Draft {
  path: string
  body: string
  baseHash: string | null
  savedAt: number
}

export interface PageDoc {
  path: string
  title: string
  body: string
  frontmatter: string | null
  properties: Record<string, unknown>
  frontmatterError: string | null
  hash: string
  modified: number
  readOnly: boolean
  draft: Draft | null
}

export type SaveOutcome =
  | { status: 'saved'; hash: string; modified: number }
  | { status: 'unchanged'; hash: string }
  | { status: 'conflict'; diskHash: string | null; diskBody: string | null; deleted: boolean }

export interface RelocateReport {
  path: string | null
  moves: [string, string][]
  linksUpdated: number
  pagesUpdated: string[]
  errors: string[]
}

export interface TrashEntry {
  id: string
  original: string
  deletedAt: number
  isFolder: boolean
  children: string | null
}

export interface PageSummary {
  path: string
  title: string
  tags: string[]
  modified: number
  status: 'ok' | 'tooLarge' | 'invalidEncoding' | 'invalidFrontmatter'
}

export interface SearchHit {
  path: string
  title: string
  snippet: string
  score: number
  matched: string[]
  modified: number
  tags: string[]
}

export interface SearchQuery {
  text: string
  folder?: string | null
  tags?: string[]
  modifiedAfter?: number | null
  modifiedBefore?: number | null
  limit?: number
}

export interface Backlink {
  path: string
  title: string
  contexts: string[]
}

export interface BrokenLink {
  from: string
  dest: string
  kind: 'markdown' | 'image' | 'wiki'
}

export interface Version {
  timestamp: number
  size: number
}

export interface DiffLine {
  op: 'equal' | 'insert' | 'delete'
  text: string
}

export interface AddedAttachment {
  path: string
  link: string
  name: string
  isImage: boolean
}

export interface ImportReport {
  importedPages: number
  importedFiles: number
  renamed: [string, string][]
  warnings: string[]
  skipped: string[]
  rootItems: string[]
}

export interface ExportReport {
  destination: string
  pages: number
  attachments: number
  externalLinks: string[]
  missing: string[]
}

export type FilterOp = 'eq' | 'neq' | 'contains' | 'notContains' | 'gt' | 'lt' | 'isEmpty' | 'isNotEmpty'
export type PropType = 'text' | 'number' | 'date' | 'checkbox' | 'tags'

export interface CollectionView {
  columns: string[]
  filters: { key: string; op: FilterOp; value: unknown }[]
  sort: { key: string; desc: boolean }[]
  groupBy: string | null
  recursive: boolean
  template: Record<string, unknown>
  layout: 'table' | 'list' | null
}

export interface CollectionResult {
  folder: string
  columns: { key: string; kind: PropType; count: number }[]
  groups: { label: string | null; rows: { path: string; title: string; modified: number; props: Record<string, unknown> }[] }[]
  total: number
  matched: number
}

// ----- Commands ---------------------------------------------------------------

export const api = {
  appInfo: () => call<{ version: string; configDir: string }>('app_info'),
  settingsGet: () => call<Settings>('settings_get'),
  settingsSet: (settings: Settings) => call<Settings>('settings_set', { settings }),
  typographyPresets: () => call<Preset[]>('typography_presets'),
  fontsList: () => call<string[]>('fonts_list'),
  themesList: () => call<Theme[]>('themes_list'),
  themeValidate: (theme: Theme) => call<ThemeReport>('theme_validate', { theme }),
  themeSave: (theme: Theme) => call<ThemeReport>('theme_save', { theme }),
  themeImportFile: (path: string) => call<[Theme, ThemeReport]>('theme_import_file', { path }),
  themeExportFile: (theme: Theme, path: string) => call<void>('theme_export_file', { theme, path }),
  themeDelete: (id: string) => call<void>('theme_delete', { id }),

  vaultOpen: (path: string) => call<VaultInfo>('vault_open', { path }),
  vaultCurrent: () => call<VaultInfo | null>('vault_current'),
  vaultClose: () => call<void>('vault_close'),
  vaultCreate: (parent: string, name: string) => call<VaultInfo>('vault_create', { parent, name }),
  vaultReindex: () => call<VaultInfo>('vault_reindex'),
  absPath: (path: string) => call<string>('abs_path', { path }),

  treeList: (dir: string) => call<TreeEntry[]>('tree_list', { dir }),
  foldersList: () => call<string[]>('folders_list'),
  treeReorder: (dir: string, names: string[]) => call<void>('tree_reorder', { dir, names }),
  pageRead: (path: string) => call<PageDoc>('page_read', { path }),
  pageSave: (path: string, body: string, baseHash: string | null, force = false) => call<SaveOutcome>('page_save', { path, body, baseHash, force }),
  pageSaveCopy: (path: string, body: string) => call<string>('page_save_copy', { path, body }),
  draftStash: (path: string, body: string, baseHash: string | null) => call<void>('draft_stash', { path, body, baseHash }),
  draftDiscard: (path: string) => call<void>('draft_discard', { path }),
  pageCreate: (parent: string, title: string, body?: string) => call<string>('page_create', { parent, title, body }),
  folderCreate: (parent: string, name: string) => call<string>('folder_create', { parent, name }),
  entryRename: (path: string, name: string) => call<RelocateReport>('entry_rename', { path, name }),
  entryMove: (path: string, dest: string) => call<RelocateReport>('entry_move', { path, dest }),
  pageDuplicate: (path: string) => call<string>('page_duplicate', { path }),
  entryDelete: (path: string) => call<TrashEntry>('entry_delete', { path }),
  propertySet: (path: string, key: string, value: unknown | null, baseHash: string | null) => call<SaveOutcome>('property_set', { path, key, value, baseHash }),

  navState: () => call<{ favorites: PageSummary[]; recents: PageSummary[] }>('nav_state'),
  favoriteSet: (path: string, on: boolean) => call<void>('favorite_set', { path, on }),

  search: (query: SearchQuery) => call<SearchHit[]>('search', { query }),
  quickFind: (query: string, limit = 30) => call<PageSummary[]>('quick_find', { query, limit }),
  tagsList: () => call<[string, number][]>('tags_list'),
  backlinks: (path: string) => call<Backlink[]>('backlinks', { path }),
  brokenLinks: (path: string | null) => call<BrokenLink[]>('broken_links', { path }),
  linkResolve: (from: string, dest: string, wiki: boolean) => call<{ path: string | null; exists: boolean; isPage: boolean }>('link_resolve', { from, dest, wiki }),
  linkRelative: (from: string, to: string) => call<string>('link_relative', { from, to }),

  trashList: () => call<TrashEntry[]>('trash_list'),
  trashRestore: (id: string) => call<string>('trash_restore', { id }),
  trashPurge: (id: string) => call<void>('trash_purge', { id }),
  trashEmpty: () => call<number>('trash_empty'),
  historyList: (path: string) => call<Version[]>('history_list', { path }),
  historyRead: (path: string, timestamp: number) => call<{ content: string; diff: DiffLine[] }>('history_read', { path, timestamp }),
  historyRestore: (path: string, timestamp: number) => call<SaveOutcome>('history_restore', { path, timestamp }),
  textDiff: (old: string, current: string) => call<DiffLine[]>('text_diff', { old, current }),

  attachmentAdd: (page: string, source: string) => call<AddedAttachment>('attachment_add', { page, source }),
  attachmentAddBytes: (page: string, name: string, bytes: number[]) => call<AddedAttachment>('attachment_add_bytes', { page, name, bytes }),

  importPaths: (sources: string[], dest: string) => call<ImportReport>('import_paths', { sources, dest }),
  exportPage: (path: string, dest: string, includeSubpages: boolean) => call<ExportReport>('export_page', { path, dest, includeSubpages }),
  exportVault: (dest: string) => call<ExportReport>('export_vault', { dest }),

  collectionQuery: (folder: string, view?: CollectionView | null) => call<CollectionResult>('collection_query', { folder, view: view ?? null }),
  collectionViewGet: (folder: string) => call<CollectionView>('collection_view_get', { folder }),
  collectionViewSave: (folder: string, view: CollectionView) => call<void>('collection_view_save', { folder, view }),
  collectionAdd: (folder: string, title: string) => call<string>('collection_add', { folder, title }),

  revealInFinder: (path: string) => call<void>('reveal_in_finder', { path }),
  revealAbs: (path: string) => call<void>('reveal_abs', { path }),
  openWithDefaultApp: (path: string) => call<void>('open_with_default_app', { path }),
  openExternal: (url: string) => call<void>('open_external', { url }),
}

// ----- Path helpers (pure string logic, mirrored from RelPath) ----------------

export const pathName = (p: string) => p.split('/').pop() ?? p
export const pathParent = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
export const pathStem = (p: string) => {
  const n = pathName(p)
  const i = n.lastIndexOf('.')
  return i > 0 ? n.slice(0, i) : n
}
export const isMarkdown = (p: string) => /\.(md|markdown)$/i.test(p)
export const childrenDir = (p: string) => p.replace(/\.md$/i, '')
