//! IPC commands. Each one validates its input, delegates to `note4me-core`
//! and returns either data or a structured `CoreError`. Commands run off the
//! main thread (`async`) so file work never blocks the window.

use crate::state::AppState;
use crate::{fonts, watcher};
use note4me_core::collections::{self, CollectionResult, CollectionView};
use note4me_core::history::{self, DiffLine, Version};
use note4me_core::import_export::{self, ExportReport, ImportReport};
use note4me_core::index::{Backlink, BrokenLink, PageSummary, SearchHit, SearchQuery};
use note4me_core::settings::{self, PresetInfo, Settings, Typography};
use note4me_core::themes::{self, Theme, ThemeReport};
use note4me_core::trash::TrashEntry;
use note4me_core::workspace::{PageDoc, RelocateReport, SaveOutcome, TreeEntry, Workspace};
use note4me_core::{CoreError, RelPath, Result};
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};

fn with_ws<T>(state: &AppState, f: impl FnOnce(&mut Workspace) -> Result<T>) -> Result<T> {
    let mut guard = state
        .workspace
        .lock()
        .map_err(|_| CoreError::Validation("estado interno indisponível".into()))?;
    let ws = guard.as_mut().ok_or_else(|| CoreError::Validation("nenhum espaço de trabalho aberto".into()))?;
    f(ws)
}

fn rel(s: &str) -> Result<RelPath> {
    RelPath::parse(s)
}

// ----- App, settings, themes, fonts ------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: String,
    config_dir: String,
}

#[tauri::command(async)]
pub fn app_info(app: AppHandle, state: State<AppState>) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        config_dir: state.config_dir.display().to_string(),
    }
}

#[tauri::command(async)]
pub fn settings_get(state: State<AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command(async)]
pub fn settings_set(state: State<AppState>, settings: Settings) -> Result<Settings> {
    let normalized = settings.normalized();
    normalized.save(&state.settings_path())?;
    let opts = normalized.workspace_options();
    *state.settings.lock().unwrap() = normalized.clone();
    if let Ok(mut guard) = state.workspace.lock() {
        if let Some(ws) = guard.as_mut() {
            ws.set_options(opts);
        }
    }
    Ok(normalized)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetWithValues {
    #[serde(flatten)]
    info: PresetInfo,
    values: Typography,
}

#[tauri::command(async)]
pub fn typography_presets() -> Vec<PresetWithValues> {
    settings::PRESETS
        .into_iter()
        .map(|info| PresetWithValues {
            values: settings::preset(info.id).unwrap(),
            info,
        })
        .collect()
}

#[tauri::command(async)]
pub fn fonts_list() -> Vec<String> {
    fonts::installed_families()
}

#[tauri::command(async)]
pub fn themes_list(state: State<AppState>) -> Vec<Theme> {
    let mut all = themes::builtins();
    all.extend(state.custom_themes());
    all
}

#[tauri::command(async)]
pub fn theme_validate(theme: Theme) -> ThemeReport {
    themes::validate(&theme)
}

/// Saves a custom theme (created in the theme editor or imported).
#[tauri::command(async)]
pub fn theme_save(state: State<AppState>, theme: Theme) -> Result<ThemeReport> {
    let json = themes::export(&theme);
    let (theme, report) = themes::import(&json)?;
    let dir = state.themes_dir();
    note4me_core::fsio::ensure_dir(&dir, "temas")?;
    note4me_core::fsio::atomic_write(&dir.join(format!("{}.json", theme.id)), themes::export(&theme).as_bytes(), "tema")?;
    Ok(report)
}

#[tauri::command(async)]
pub fn theme_import_file(state: State<AppState>, path: PathBuf) -> Result<(Theme, ThemeReport)> {
    let meta = std::fs::metadata(&path).map_err(|e| CoreError::from_io(e, "tema"))?;
    if meta.len() > 64 * 1024 {
        return Err(CoreError::TooLarge("tema".into()));
    }
    let json = std::fs::read_to_string(&path).map_err(|e| CoreError::from_io(e, "tema"))?;
    let (theme, report) = themes::import(&json)?;
    theme_save(state, theme.clone())?;
    Ok((theme, report))
}

#[tauri::command(async)]
pub fn theme_export_file(theme: Theme, path: PathBuf) -> Result<()> {
    note4me_core::fsio::atomic_write(&path, themes::export(&theme).as_bytes(), "tema")
}

#[tauri::command(async)]
pub fn theme_delete(state: State<AppState>, id: String) -> Result<()> {
    if themes::builtins().iter().any(|t| t.id == id) || !id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
        return Err(CoreError::Validation("tema embutido não pode ser removido".into()));
    }
    std::fs::remove_file(state.themes_dir().join(format!("{id}.json"))).map_err(|e| CoreError::from_io(e, "tema"))
}

// ----- Vault ---------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultInfo {
    root: String,
    name: String,
    page_count: usize,
}

fn info(ws: &Workspace) -> VaultInfo {
    VaultInfo {
        root: ws.root().display().to_string(),
        name: ws.root().file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        page_count: ws.index.len(),
    }
}

#[tauri::command(async)]
pub fn vault_open(app: AppHandle, state: State<AppState>, path: PathBuf) -> Result<VaultInfo> {
    let opts = state.settings.lock().unwrap().workspace_options();
    let ws = Workspace::open(&path, opts)?;
    let root = ws.root().to_path_buf();
    let i = info(&ws);
    // Let the webview load images from this vault, and nothing else.
    let _ = app.asset_protocol_scope().allow_directory(&root, true);
    *state.workspace.lock().unwrap() = Some(ws);
    watcher::watch(&app, &state, &root);
    let mut s = state.settings.lock().unwrap();
    s.remember_vault(&root);
    let _ = s.save(&state.settings_path());
    log::info!("vault opened ({} pages)", i.page_count);
    Ok(i)
}

#[tauri::command(async)]
pub fn vault_current(state: State<AppState>) -> Option<VaultInfo> {
    state.workspace.lock().ok()?.as_ref().map(info)
}

#[tauri::command(async)]
pub fn vault_close(state: State<AppState>) {
    *state.watcher.lock().unwrap() = None;
    *state.workspace.lock().unwrap() = None;
    let mut s = state.settings.lock().unwrap();
    s.last_vault = None;
    let _ = s.save(&state.settings_path());
}

/// Creates a new, empty folder for a vault and opens it.
#[tauri::command(async)]
pub fn vault_create(app: AppHandle, state: State<AppState>, parent: PathBuf, name: String) -> Result<VaultInfo> {
    let clean = note4me_core::paths::sanitize_name(&name)?;
    let dir = parent.join(&clean);
    if dir.exists() {
        return Err(CoreError::AlreadyExists(clean));
    }
    std::fs::create_dir_all(&dir).map_err(|e| CoreError::from_io(e, &clean))?;
    let welcome = "Bem-vindo ao note4me.\n\nCada página deste espaço é um arquivo `.md` comum nesta pasta. Você pode abri-los no Finder, em outro editor, versioná-los com Git ou sincronizá-los com o iCloud Drive.\n\n- [ ] Crie uma página com ⌘N\n- [ ] Digite `/` para inserir blocos\n- [ ] Use ⌘P para ir rapidamente a qualquer página\n";
    note4me_core::fsio::write_new(&dir.join("Início.md"), welcome.as_bytes(), "Início.md")?;
    vault_open(app, state, dir)
}

#[tauri::command(async)]
pub fn vault_reindex(state: State<AppState>) -> Result<VaultInfo> {
    with_ws(&state, |ws| {
        let started = std::time::Instant::now();
        ws.reindex();
        log::info!("reindexed {} pages in {:?}", ws.index.len(), started.elapsed());
        Ok(info(ws))
    })
}

#[tauri::command(async)]
pub fn abs_path(state: State<AppState>, path: String) -> Result<String> {
    with_ws(&state, |ws| Ok(rel(&path)?.to_abs(ws.root()).display().to_string()))
}

// ----- Tree & pages --------------------------------------------------------------

#[tauri::command(async)]
pub fn tree_list(state: State<AppState>, dir: String) -> Result<Vec<TreeEntry>> {
    with_ws(&state, |ws| ws.list_dir(&rel(&dir)?))
}

#[tauri::command(async)]
pub fn folders_list(state: State<AppState>) -> Result<Vec<String>> {
    with_ws(&state, |ws| Ok(ws.folders(5000).into_iter().map(|p| p.to_string()).collect()))
}

#[tauri::command(async)]
pub fn tree_reorder(state: State<AppState>, dir: String, names: Vec<String>) -> Result<()> {
    with_ws(&state, |ws| ws.reorder(&rel(&dir)?, names))
}

#[tauri::command(async)]
pub fn page_read(state: State<AppState>, path: String) -> Result<PageDoc> {
    with_ws(&state, |ws| {
        let p = rel(&path)?;
        let doc = ws.read_page(&p)?;
        ws.state.touch_recent(&p);
        let _ = ws.save_state();
        Ok(doc)
    })
}

#[tauri::command(async)]
pub fn page_save(state: State<AppState>, path: String, body: String, base_hash: Option<String>, force: bool) -> Result<SaveOutcome> {
    let p = rel(&path)?;
    let res = with_ws(&state, |ws| ws.save_page(&p, &body, base_hash.as_deref(), force));
    match &res {
        Err(e) => {
            // Keep the unsaved text recoverable whatever went wrong.
            let _ = with_ws(&state, |ws| ws.stash_draft(&p, &body, base_hash.as_deref()));
            log::warn!("save failed for a page: {}", e.kind());
        }
        Ok(SaveOutcome::Conflict { .. }) => {
            let _ = with_ws(&state, |ws| ws.stash_draft(&p, &body, base_hash.as_deref()));
            log::info!("save refused: file changed on disk");
        }
        Ok(_) => {}
    }
    res
}

#[tauri::command(async)]
pub fn page_save_copy(state: State<AppState>, path: String, body: String) -> Result<String> {
    with_ws(&state, |ws| Ok(ws.save_as_copy(&rel(&path)?, &body, "conflito")?.to_string()))
}

#[tauri::command(async)]
pub fn draft_stash(state: State<AppState>, path: String, body: String, base_hash: Option<String>) -> Result<()> {
    with_ws(&state, |ws| ws.stash_draft(&rel(&path)?, &body, base_hash.as_deref()))
}

#[tauri::command(async)]
pub fn draft_discard(state: State<AppState>, path: String) -> Result<()> {
    with_ws(&state, |ws| {
        ws.discard_draft(&rel(&path)?);
        Ok(())
    })
}

#[tauri::command(async)]
pub fn page_create(state: State<AppState>, parent: String, title: String, body: Option<String>) -> Result<String> {
    with_ws(&state, |ws| {
        Ok(ws.create_page(&rel(&parent)?, &title, body.as_deref().unwrap_or(""))?.to_string())
    })
}

#[tauri::command(async)]
pub fn folder_create(state: State<AppState>, parent: String, name: String) -> Result<String> {
    with_ws(&state, |ws| Ok(ws.create_folder(&rel(&parent)?, &name)?.to_string()))
}

#[tauri::command(async)]
pub fn entry_rename(state: State<AppState>, path: String, name: String) -> Result<RelocateReport> {
    with_ws(&state, |ws| ws.rename(&rel(&path)?, &name))
}

#[tauri::command(async)]
pub fn entry_move(state: State<AppState>, path: String, dest: String) -> Result<RelocateReport> {
    with_ws(&state, |ws| ws.move_to(&rel(&path)?, &rel(&dest)?))
}

#[tauri::command(async)]
pub fn page_duplicate(state: State<AppState>, path: String) -> Result<String> {
    with_ws(&state, |ws| Ok(ws.duplicate(&rel(&path)?)?.to_string()))
}

#[tauri::command(async)]
pub fn entry_delete(state: State<AppState>, path: String) -> Result<TrashEntry> {
    with_ws(&state, |ws| ws.delete(&rel(&path)?))
}

#[tauri::command(async)]
pub fn property_set(state: State<AppState>, path: String, key: String, value: Option<Value>, base_hash: Option<String>) -> Result<SaveOutcome> {
    with_ws(&state, |ws| ws.set_property(&rel(&path)?, &key, value.as_ref(), base_hash.as_deref()))
}

// ----- Navigation state -----------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NavState {
    favorites: Vec<PageSummary>,
    recents: Vec<PageSummary>,
}

#[tauri::command(async)]
pub fn nav_state(state: State<AppState>) -> Result<NavState> {
    with_ws(&state, |ws| {
        let summarize = |list: &Vec<RelPath>| list.iter().filter_map(|p| ws.index.page(p).map(|e| e.summary())).collect();
        Ok(NavState {
            favorites: summarize(&ws.state.favorites),
            recents: summarize(&ws.state.recents),
        })
    })
}

#[tauri::command(async)]
pub fn favorite_set(state: State<AppState>, path: String, on: bool) -> Result<()> {
    with_ws(&state, |ws| {
        ws.state.set_favorite(&rel(&path)?, on);
        ws.save_state()
    })
}

// ----- Search & links --------------------------------------------------------------

#[tauri::command(async)]
pub fn search(state: State<AppState>, query: SearchQuery) -> Result<Vec<SearchHit>> {
    with_ws(&state, |ws| Ok(ws.index.search(&query)))
}

#[tauri::command(async)]
pub fn quick_find(state: State<AppState>, query: String, limit: Option<usize>) -> Result<Vec<PageSummary>> {
    with_ws(&state, |ws| Ok(ws.index.quick_find(&query, limit.unwrap_or(30))))
}

#[tauri::command(async)]
pub fn tags_list(state: State<AppState>) -> Result<Vec<(String, usize)>> {
    with_ws(&state, |ws| Ok(ws.index.tags()))
}

#[tauri::command(async)]
pub fn backlinks(state: State<AppState>, path: String) -> Result<Vec<Backlink>> {
    with_ws(&state, |ws| Ok(ws.index.backlinks(&rel(&path)?)))
}

#[tauri::command(async)]
pub fn broken_links(state: State<AppState>, path: Option<String>) -> Result<Vec<BrokenLink>> {
    with_ws(&state, |ws| {
        let only = path.map(|p| rel(&p)).transpose()?;
        Ok(ws.index.broken_links(only.as_ref()))
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedLink {
    path: Option<String>,
    exists: bool,
    is_page: bool,
}

/// Resolves a link clicked in `from`: relative destination or wiki name.
#[tauri::command(async)]
pub fn link_resolve(state: State<AppState>, from: String, dest: String, wiki: bool) -> Result<ResolvedLink> {
    with_ws(&state, |ws| {
        let from = rel(&from)?;
        let target = if wiki {
            ws.index.resolve_wiki(&from, note4me_core::markdown::links::split_suffix(&dest).0)
        } else {
            note4me_core::markdown::links::resolve(&from, &dest)
        };
        Ok(match target {
            Some(t) => ResolvedLink {
                exists: ws.index.exists(&t) || t.to_abs(ws.root()).exists(),
                is_page: t.is_markdown(),
                path: Some(t.to_string()),
            },
            None => ResolvedLink {
                path: None,
                exists: false,
                is_page: false,
            },
        })
    })
}

/// Relative link text to insert in `from` pointing at `to`.
#[tauri::command(async)]
pub fn link_relative(from: String, to: String) -> Result<String> {
    Ok(note4me_core::markdown::links::relative(&rel(&from)?, &rel(&to)?))
}

// ----- Trash & history ---------------------------------------------------------------

#[tauri::command(async)]
pub fn trash_list(state: State<AppState>) -> Result<Vec<TrashEntry>> {
    with_ws(&state, |ws| Ok(ws.trash_list()))
}

#[tauri::command(async)]
pub fn trash_restore(state: State<AppState>, id: String) -> Result<String> {
    with_ws(&state, |ws| Ok(ws.trash_restore(&id)?.to_string()))
}

#[tauri::command(async)]
pub fn trash_purge(state: State<AppState>, id: String) -> Result<()> {
    with_ws(&state, |ws| ws.trash_purge(&id))
}

#[tauri::command(async)]
pub fn trash_empty(state: State<AppState>) -> Result<usize> {
    with_ws(&state, |ws| ws.trash_empty())
}

#[tauri::command(async)]
pub fn history_list(state: State<AppState>, path: String) -> Result<Vec<Version>> {
    with_ws(&state, |ws| Ok(ws.versions(&rel(&path)?)))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionView {
    content: String,
    diff: Vec<DiffLine>,
}

#[tauri::command(async)]
pub fn history_read(state: State<AppState>, path: String, timestamp: i64) -> Result<VersionView> {
    with_ws(&state, |ws| {
        let p = rel(&path)?;
        let old = ws.version_content(&p, timestamp)?;
        let current = note4me_core::fsio::read_text(&p.to_abs(ws.root()), p.as_str(), None)
            .map(|f| f.content)
            .unwrap_or_default();
        Ok(VersionView {
            diff: history::diff(&old, &current),
            content: old,
        })
    })
}

#[tauri::command(async)]
pub fn text_diff(old: String, current: String) -> Vec<DiffLine> {
    history::diff(&old, &current)
}

#[tauri::command(async)]
pub fn history_restore(state: State<AppState>, path: String, timestamp: i64) -> Result<SaveOutcome> {
    with_ws(&state, |ws| ws.restore_version(&rel(&path)?, timestamp))
}

// ----- Attachments --------------------------------------------------------------------

#[tauri::command(async)]
pub fn attachment_add(state: State<AppState>, page: String, source: PathBuf) -> Result<note4me_core::attachments::AddedAttachment> {
    with_ws(&state, |ws| ws.add_attachment(&rel(&page)?, &source))
}

#[tauri::command(async)]
pub fn attachment_add_bytes(state: State<AppState>, page: String, name: String, bytes: Vec<u8>) -> Result<note4me_core::attachments::AddedAttachment> {
    with_ws(&state, |ws| ws.add_attachment_bytes(&rel(&page)?, &name, &bytes))
}

// ----- Import / export ---------------------------------------------------------------------

#[tauri::command(async)]
pub fn import_paths(state: State<AppState>, sources: Vec<PathBuf>, dest: String) -> Result<ImportReport> {
    with_ws(&state, |ws| {
        let d = rel(&dest)?;
        let dir = if d.is_markdown() { d.children_dir() } else { d };
        let report = import_export::import(ws.root(), &sources, &dir)?;
        ws.reindex();
        Ok(report)
    })
}

#[tauri::command(async)]
pub fn export_page(state: State<AppState>, path: String, dest: PathBuf, include_subpages: bool) -> Result<ExportReport> {
    with_ws(&state, |ws| import_export::export_page(ws.root(), &rel(&path)?, &dest, include_subpages))
}

#[tauri::command(async)]
pub fn export_vault(state: State<AppState>, dest: PathBuf) -> Result<ExportReport> {
    with_ws(&state, |ws| import_export::export_vault(ws.root(), &dest))
}

// ----- Collections -----------------------------------------------------------------------

#[tauri::command(async)]
pub fn collection_query(state: State<AppState>, folder: String, view: Option<CollectionView>) -> Result<CollectionResult> {
    with_ws(&state, |ws| {
        let f = rel(&folder)?;
        let f = if f.is_markdown() { f.children_dir() } else { f };
        let view = match view {
            Some(v) => v,
            None => ws
                .state
                .views
                .get(f.as_str())
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default(),
        };
        Ok(collections::query(&ws.index, &f, &view))
    })
}

#[tauri::command(async)]
pub fn collection_view_get(state: State<AppState>, folder: String) -> Result<CollectionView> {
    with_ws(&state, |ws| {
        let f = rel(&folder)?;
        let f = if f.is_markdown() { f.children_dir() } else { f };
        Ok(ws
            .state
            .views
            .get(f.as_str())
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default())
    })
}

#[tauri::command(async)]
pub fn collection_view_save(state: State<AppState>, folder: String, view: CollectionView) -> Result<()> {
    with_ws(&state, |ws| {
        let f = rel(&folder)?;
        let f = if f.is_markdown() { f.children_dir() } else { f };
        ws.state.views.insert(f.to_string(), serde_json::to_value(view).unwrap());
        ws.save_state()
    })
}

/// Creates a record (page) in a collection, applying the view's template.
#[tauri::command(async)]
pub fn collection_add(state: State<AppState>, folder: String, title: String) -> Result<String> {
    with_ws(&state, |ws| {
        let f = rel(&folder)?;
        let dir = if f.is_markdown() { f.children_dir() } else { f.clone() };
        let view: CollectionView = ws
            .state
            .views
            .get(dir.as_str())
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();
        let page = ws.create_page(&f, &title, "")?;
        for (k, v) in &view.template {
            ws.set_property(&page, k, Some(v), None)?;
        }
        Ok(page.to_string())
    })
}

// ----- System integration ------------------------------------------------------------------

#[tauri::command(async)]
pub fn reveal_in_finder(app: AppHandle, state: State<AppState>, path: String) -> Result<()> {
    use tauri_plugin_opener::OpenerExt;
    let abs = with_ws(&state, |ws| Ok(rel(&path)?.to_abs(ws.root())))?;
    app.opener().reveal_item_in_dir(abs).map_err(|e| CoreError::Validation(e.to_string()))
}

/// Reveals an export destination chosen by the user in a save dialog.
#[tauri::command(async)]
pub fn reveal_abs(app: AppHandle, path: PathBuf) -> Result<()> {
    use tauri_plugin_opener::OpenerExt;
    if !path.is_absolute() || !path.exists() {
        return Err(CoreError::NotFound(
            path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        ));
    }
    app.opener().reveal_item_in_dir(path).map_err(|e| CoreError::Validation(e.to_string()))
}

#[tauri::command(async)]
pub fn open_with_default_app(app: AppHandle, state: State<AppState>, path: String) -> Result<()> {
    use tauri_plugin_opener::OpenerExt;
    let abs = with_ws(&state, |ws| {
        let p = rel(&path)?;
        note4me_core::paths::ensure_within(ws.root(), &p.to_abs(ws.root()))?;
        Ok(p.to_abs(ws.root()))
    })?;
    app.opener()
        .open_path(abs.display().to_string(), None::<&str>)
        .map_err(|e| CoreError::Validation(e.to_string()))
}

/// Opens web and mail links in the default app. Other schemes (file:,
/// javascript:, custom app schemes) are refused.
#[tauri::command(async)]
pub fn open_external(app: AppHandle, url: String) -> Result<()> {
    use tauri_plugin_opener::OpenerExt;
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("mailto:")) {
        return Err(CoreError::Validation("apenas links http, https e mailto podem ser abertos".into()));
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| CoreError::Validation(e.to_string()))
}

pub fn config_dir(app: &AppHandle) -> PathBuf {
    // Debug builds can be pointed at a throwaway configuration (E2E tests).
    if cfg!(debug_assertions) {
        if let Ok(dir) = std::env::var("NOTE4ME_CONFIG_DIR") {
            return PathBuf::from(dir);
        }
    }
    app.path().app_config_dir().unwrap_or_else(|_| PathBuf::from("."))
}

// ----- End-to-end test hooks (debug builds with NOTE4ME_E2E_OUT only) -------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct E2eConfig {
    vault: String,
    mode: String,
}

fn e2e_enabled() -> bool {
    cfg!(debug_assertions) && std::env::var("NOTE4ME_E2E_OUT").is_ok()
}

#[tauri::command(async)]
pub fn e2e_config() -> Option<E2eConfig> {
    if !e2e_enabled() {
        return None;
    }
    Some(E2eConfig {
        vault: std::env::var("NOTE4ME_E2E_VAULT").ok()?,
        mode: std::env::var("NOTE4ME_E2E_MODE").unwrap_or_else(|_| "smoke".into()),
    })
}

/// Simulates another editor writing a file (bypasses the app on purpose).
#[tauri::command(async)]
pub fn e2e_write_file(state: State<AppState>, path: String, content: String) -> Result<()> {
    if !e2e_enabled() {
        return Err(CoreError::Validation("disponível apenas em testes".into()));
    }
    let abs = with_ws(&state, |ws| Ok(rel(&path)?.to_abs(ws.root())))?;
    std::fs::write(abs, content).map_err(|e| CoreError::from_io(e, &path))
}

#[tauri::command(async)]
pub fn e2e_read_file(state: State<AppState>, path: String) -> Result<String> {
    if !e2e_enabled() {
        return Err(CoreError::Validation("disponível apenas em testes".into()));
    }
    let abs = with_ws(&state, |ws| Ok(rel(&path)?.to_abs(ws.root())))?;
    std::fs::read_to_string(abs).map_err(|e| CoreError::from_io(e, &path))
}

/// Tour mode: announces the current screen so a script can capture it.
#[tauri::command(async)]
pub fn e2e_mark(name: String) -> Result<()> {
    if !e2e_enabled() {
        return Err(CoreError::Validation("disponível apenas em testes".into()));
    }
    let out = std::env::var("NOTE4ME_E2E_OUT").unwrap();
    std::fs::write(format!("{out}.mark"), name).map_err(|e| CoreError::from_io(e, "marca"))
}

#[tauri::command(async)]
pub fn e2e_finish(app: AppHandle, report: Value) -> Result<()> {
    if !e2e_enabled() {
        return Err(CoreError::Validation("disponível apenas em testes".into()));
    }
    let out = std::env::var("NOTE4ME_E2E_OUT").unwrap();
    std::fs::write(&out, serde_json::to_vec_pretty(&report).unwrap()).map_err(|e| CoreError::from_io(e, "relatório"))?;
    app.exit(0);
    Ok(())
}
