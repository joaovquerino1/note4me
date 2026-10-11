//! A vault opened by the app: page operations with integrity guarantees.
//!
//! Layout rules (documented in `docs/FORMATO.md`):
//! * a page is `Name.md`; its sub-pages live in the folder `Name/` beside it;
//! * a folder without a same-named page is a plain section;
//! * `.note4me/` holds optional, rebuildable app data.

use crate::attachments::{self, AddedAttachment, AttachmentOptions};
use crate::drafts::{self, Draft};
use crate::error::{CoreError, Result};
use crate::fsio::{self, TextFormat};
use crate::history::{self, History, HistoryOptions};
use crate::index::{modified_ms, Index, IndexOptions};
use crate::markdown::{frontmatter, links};
use crate::paths::{ensure_within, sanitize_name, unique_child, RelPath, META_DIR};
use crate::state::VaultState;
use crate::trash::{Trash, TrashEntry};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WorkspaceOptions {
    /// Add `id` and `created` frontmatter to pages created by the app.
    pub new_page_frontmatter: bool,
    pub max_file_bytes: u64,
    pub history: HistoryOptions,
    pub attachments: AttachmentOptions,
}

impl Default for WorkspaceOptions {
    fn default() -> Self {
        WorkspaceOptions {
            new_page_frontmatter: true,
            max_file_bytes: IndexOptions::default().max_file_bytes,
            history: HistoryOptions::default(),
            attachments: AttachmentOptions::default(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EntryKind {
    Page,
    Folder,
    File,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeEntry {
    pub path: RelPath,
    pub name: String,
    pub kind: EntryKind,
    /// Folder whose content shows as this entry's children, if any.
    pub children_dir: Option<RelPath>,
    pub has_children: bool,
    pub modified: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageDoc {
    pub path: RelPath,
    pub title: String,
    pub body: String,
    pub frontmatter: Option<String>,
    pub properties: Map<String, Value>,
    pub frontmatter_error: Option<String>,
    pub hash: String,
    pub format: TextFormat,
    pub modified: i64,
    pub read_only: bool,
    pub draft: Option<Draft>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum SaveOutcome {
    Saved {
        hash: String,
        modified: i64,
    },
    Unchanged {
        hash: String,
    },
    /// The file changed on disk since `base_hash`; nothing was written.
    Conflict {
        disk_hash: Option<String>,
        disk_body: Option<String>,
        deleted: bool,
    },
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RelocateReport {
    pub path: Option<RelPath>,
    pub moves: Vec<(RelPath, RelPath)>,
    pub links_updated: usize,
    pub pages_updated: Vec<RelPath>,
    pub errors: Vec<String>,
}

pub struct Workspace {
    root: PathBuf,
    meta: PathBuf,
    pub index: Index,
    pub state: VaultState,
    history: History,
    trash: Trash,
    pub opts: WorkspaceOptions,
}

impl Workspace {
    pub fn open(root: &Path, opts: WorkspaceOptions) -> Result<Workspace> {
        let root = root.canonicalize().map_err(|e| CoreError::from_io(e, root.display().to_string()))?;
        if !root.is_dir() {
            return Err(CoreError::InvalidPath("a pasta do espaço de trabalho não é um diretório".into()));
        }
        let meta = root.join(META_DIR);
        let index = Index::build(
            &root,
            IndexOptions {
                max_file_bytes: opts.max_file_bytes,
            },
        );
        let state = VaultState::load(&meta);
        Ok(Workspace {
            history: History::new(&meta, opts.history),
            trash: Trash::new(&meta),
            root,
            meta,
            index,
            state,
            opts,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn meta_dir(&self) -> &Path {
        &self.meta
    }

    pub fn set_options(&mut self, opts: WorkspaceOptions) {
        let reindex = opts.max_file_bytes != self.opts.max_file_bytes;
        self.history.opts = opts.history;
        self.opts = opts;
        if reindex {
            self.reindex();
        }
    }

    /// Rebuilds the index from the Markdown files.
    pub fn reindex(&mut self) {
        self.index = Index::build(
            &self.root,
            IndexOptions {
                max_file_bytes: self.opts.max_file_bytes,
            },
        );
    }

    /// Creates `.note4me/` with an explanatory README and a `.gitignore`.
    fn ensure_meta(&self) -> Result<()> {
        if self.meta.is_dir() {
            return Ok(());
        }
        fsio::ensure_dir(&self.meta, META_DIR)?;
        let readme = "Esta pasta guarda dados opcionais do note4me: histórico de versões,\nlixeira, rascunhos de recuperação e preferências da barra lateral.\n\nO conteúdo das suas páginas está nos arquivos .md fora desta pasta.\nApagar esta pasta não apaga nenhuma página.\n";
        let _ = fsio::write_new(&self.meta.join("LEIA-ME.txt"), readme.as_bytes(), "LEIA-ME");
        let _ = fsio::write_new(&self.meta.join(".gitignore"), b"history/\ntrash/\ndrafts/\n*.corrupt\n", ".gitignore");
        Ok(())
    }

    pub fn save_state(&self) -> Result<()> {
        self.ensure_meta()?;
        self.state.save(&self.meta)
    }

    fn abs(&self, rel: &RelPath) -> Result<PathBuf> {
        if rel.components().next() == Some(META_DIR) {
            return Err(CoreError::InvalidPath(rel.to_string()));
        }
        let abs = rel.to_abs(&self.root);
        ensure_within(&self.root, &abs)?;
        Ok(abs)
    }

    fn page_path(&self, rel: &RelPath) -> Result<PathBuf> {
        if !rel.is_markdown() {
            return Err(CoreError::InvalidPath(format!("{rel} não é um arquivo Markdown")));
        }
        self.abs(rel)
    }

    // ----- Tree -------------------------------------------------------------

    pub fn list_dir(&self, dir: &RelPath) -> Result<Vec<TreeEntry>> {
        let abs = self.abs(dir)?;
        let rd = std::fs::read_dir(&abs).map_err(|e| CoreError::from_io(e, dir.as_str()))?;
        let mut pages = Vec::new();
        let mut dirs = Vec::new();
        let mut files = Vec::new();
        for e in rd.filter_map(|e| e.ok()) {
            let Some(name) = e.file_name().to_str().map(str::to_string) else { continue };
            if name.starts_with('.') {
                continue;
            }
            let Ok(rel) = dir.join(&name) else { continue };
            let Ok(ft) = e.file_type() else { continue };
            let modified = e.metadata().map(|m| modified_ms(&m)).unwrap_or(0);
            if ft.is_dir() {
                dirs.push((rel, modified));
            } else if ft.is_file() {
                if rel.is_markdown() {
                    pages.push((rel, modified));
                } else {
                    files.push((rel, modified));
                }
            }
        }
        let dir_has_visible = |p: &RelPath| {
            std::fs::read_dir(p.to_abs(&self.root))
                .map(|rd| rd.filter_map(|e| e.ok()).any(|e| !e.file_name().to_string_lossy().starts_with('.')))
                .unwrap_or(false)
        };
        let mut out = Vec::new();
        let lower_dirs: Vec<String> = dirs.iter().map(|(d, _)| d.as_str().to_lowercase()).collect();
        for (p, m) in &pages {
            let cdir = p.children_dir();
            let has_dir = lower_dirs.contains(&cdir.as_str().to_lowercase());
            let cdir = if has_dir {
                dirs.iter()
                    .find(|(d, _)| d.as_str().eq_ignore_ascii_case(cdir.as_str()))
                    .map(|(d, _)| d.clone())
            } else {
                None
            };
            let has_children = cdir.as_ref().is_some_and(dir_has_visible);
            out.push(TreeEntry {
                name: p.stem().to_string(),
                path: p.clone(),
                kind: EntryKind::Page,
                children_dir: cdir,
                has_children,
                modified: *m,
            });
        }
        let page_dirs: Vec<String> = pages.iter().map(|(p, _)| p.children_dir().as_str().to_lowercase()).collect();
        for (d, m) in &dirs {
            if page_dirs.contains(&d.as_str().to_lowercase()) {
                continue;
            }
            out.push(TreeEntry {
                name: d.file_name().to_string(),
                path: d.clone(),
                kind: EntryKind::Folder,
                children_dir: Some(d.clone()),
                has_children: dir_has_visible(d),
                modified: *m,
            });
        }
        for (f, m) in files {
            out.push(TreeEntry {
                name: f.file_name().to_string(),
                path: f,
                kind: EntryKind::File,
                children_dir: None,
                has_children: false,
                modified: m,
            });
        }
        let order = self.state.order.get(dir.as_str());
        let pos = |e: &TreeEntry| order.and_then(|o| o.iter().position(|n| n == e.path.file_name())).unwrap_or(usize::MAX);
        let rank = |k: EntryKind| match k {
            EntryKind::Folder => 0,
            EntryKind::Page => 1,
            EntryKind::File => 2,
        };
        out.sort_by(|a, b| {
            pos(a)
                .cmp(&pos(b))
                .then(rank(a.kind).cmp(&rank(b.kind)))
                .then_with(|| natural_cmp(&a.name, &b.name))
        });
        Ok(out)
    }

    /// Plain folders (not the sub-page folders of pages), for "move to" pickers.
    pub fn folders(&self, limit: usize) -> Vec<RelPath> {
        let walker = walkdir::WalkDir::new(&self.root)
            .min_depth(1)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| !e.file_name().to_string_lossy().starts_with('.'));
        let mut out = Vec::new();
        for e in walker.filter_map(|e| e.ok()) {
            if !e.file_type().is_dir() {
                continue;
            }
            let Ok(rel) = RelPath::from_abs(&self.root, e.path()) else { continue };
            let page_twin = e.path().with_extension("md");
            if page_twin.is_file() {
                continue;
            }
            out.push(rel);
            if out.len() >= limit {
                break;
            }
        }
        out.sort_by(|a, b| natural_cmp(a.as_str(), b.as_str()));
        out
    }

    pub fn reorder(&mut self, dir: &RelPath, names: Vec<String>) -> Result<()> {
        self.state.order.insert(dir.to_string(), names);
        self.save_state()
    }

    // ----- Reading and saving ----------------------------------------------

    pub fn read_page(&self, rel: &RelPath) -> Result<PageDoc> {
        let abs = self.page_path(rel)?;
        let file = fsio::read_text(&abs, rel.as_str(), Some(self.opts.max_file_bytes))?;
        let meta = std::fs::metadata(&abs).map_err(|e| CoreError::from_io(e, rel.as_str()))?;
        let split = frontmatter::split(&file.content);
        let (properties, frontmatter_error) = match split.yaml.map(frontmatter::parse) {
            None => (Map::new(), None),
            Some(Ok(p)) => (p, None),
            Some(Err(e)) => (Map::new(), Some(e.to_string())),
        };
        let draft = drafts::get(&self.meta, rel).filter(|d| d.body != split.body);
        Ok(PageDoc {
            path: rel.clone(),
            title: rel.stem().to_string(),
            body: split.body.to_string(),
            frontmatter: split.yaml.map(str::to_string),
            properties,
            frontmatter_error,
            hash: file.hash,
            format: file.format,
            modified: modified_ms(&meta),
            read_only: meta.permissions().readonly(),
            draft,
        })
    }

    fn history_key(&self, rel: &RelPath) -> String {
        history::key_for(self.index.page(rel).and_then(|p| p.id.as_deref()), rel)
    }

    /// Saves a new body, keeping the frontmatter currently on disk.
    ///
    /// Refuses (returns `Conflict`) when the file on disk is no longer the
    /// version identified by `base_hash`, unless `force` is set — in which
    /// case the disk version is first preserved in the history.
    pub fn save_page(&mut self, rel: &RelPath, body: &str, base_hash: Option<&str>, force: bool) -> Result<SaveOutcome> {
        let abs = self.page_path(rel)?;
        let disk = match fsio::read_text(&abs, rel.as_str(), None) {
            Ok(f) => Some(f),
            Err(CoreError::NotFound(_)) => None,
            Err(e) => return Err(e),
        };
        let key = self.history_key(rel);
        match &disk {
            None if base_hash.is_some() && !force => {
                return Ok(SaveOutcome::Conflict {
                    disk_hash: None,
                    disk_body: None,
                    deleted: true,
                });
            }
            Some(d) if base_hash.is_some_and(|h| h != d.hash) => {
                if !force {
                    let body = frontmatter::split(&d.content).body.to_string();
                    return Ok(SaveOutcome::Conflict {
                        disk_hash: Some(d.hash.clone()),
                        disk_body: Some(body),
                        deleted: false,
                    });
                }
                self.ensure_meta()?;
                self.history.snapshot(&key, rel, &d.content, true)?;
            }
            _ => {}
        }
        let (content, format) = match &disk {
            Some(d) => {
                let sp = frontmatter::split(&d.content);
                (format!("{}{}", &d.content[..sp.block_len], body), d.format)
            }
            None => (body.to_string(), TextFormat::default()),
        };
        if let Some(d) = &disk {
            if d.content == content {
                drafts::discard(&self.meta, rel);
                return Ok(SaveOutcome::Unchanged { hash: d.hash.clone() });
            }
            if self.history.opts.enabled {
                self.ensure_meta()?;
                self.history.snapshot(&key, rel, &d.content, false)?;
            }
        } else if let Some(parent) = abs.parent() {
            fsio::ensure_dir(parent, rel.as_str())?;
        }
        let bytes = fsio::encode_text(&content, format);
        fsio::atomic_write(&abs, &bytes, rel.as_str())?;
        drafts::discard(&self.meta, rel);
        self.index.refresh(&self.root, rel);
        let modified = std::fs::metadata(&abs).map(|m| modified_ms(&m)).unwrap_or(0);
        Ok(SaveOutcome::Saved {
            hash: fsio::hash_bytes(&bytes),
            modified,
        })
    }

    /// Changes one frontmatter property with the same conflict rules as saving.
    pub fn set_property(&mut self, rel: &RelPath, key: &str, value: Option<&Value>, base_hash: Option<&str>) -> Result<SaveOutcome> {
        let abs = self.page_path(rel)?;
        let disk = fsio::read_text(&abs, rel.as_str(), None)?;
        if base_hash.is_some_and(|h| h != disk.hash) {
            let body = frontmatter::split(&disk.content).body.to_string();
            return Ok(SaveOutcome::Conflict {
                disk_hash: Some(disk.hash),
                disk_body: Some(body),
                deleted: false,
            });
        }
        let content = match value {
            Some(v) => frontmatter::set_field(&disk.content, key, v)?,
            None => frontmatter::remove_field(&disk.content, key)?,
        };
        if content == disk.content {
            return Ok(SaveOutcome::Unchanged { hash: disk.hash });
        }
        let bytes = fsio::encode_text(&content, disk.format);
        fsio::atomic_write(&abs, &bytes, rel.as_str())?;
        self.index.refresh(&self.root, rel);
        let modified = std::fs::metadata(&abs).map(|m| modified_ms(&m)).unwrap_or(0);
        Ok(SaveOutcome::Saved {
            hash: fsio::hash_bytes(&bytes),
            modified,
        })
    }

    pub fn stash_draft(&self, rel: &RelPath, body: &str, base_hash: Option<&str>) -> Result<()> {
        self.ensure_meta()?;
        drafts::stash(
            &self.meta,
            &Draft {
                path: rel.clone(),
                body: body.to_string(),
                base_hash: base_hash.map(str::to_string),
                saved_at: history::now_ms(),
            },
        )
    }

    pub fn discard_draft(&self, rel: &RelPath) {
        drafts::discard(&self.meta, rel);
    }

    /// Saves `body` as a new sibling page `Name (conflito).md` — the safe
    /// way out of a conflict that keeps both versions.
    pub fn save_as_copy(&mut self, rel: &RelPath, body: &str, suffix: &str) -> Result<RelPath> {
        let parent = rel.parent().unwrap_or_else(RelPath::root);
        let name = sanitize_name(&format!("{} ({suffix})", rel.stem()))?;
        let new = unique_child(&self.root, &parent, &name, Some("md"))?;
        fsio::write_new(&self.abs(&new)?, body.as_bytes(), new.as_str())?;
        self.index.refresh(&self.root, &new);
        Ok(new)
    }

    // ----- Creating ----------------------------------------------------------

    /// Directory that receives new children of `parent` (page or folder).
    fn container_of(&self, parent: &RelPath) -> RelPath {
        if parent.is_markdown() {
            parent.children_dir()
        } else {
            parent.clone()
        }
    }

    pub fn create_page(&mut self, parent: &RelPath, title: &str, body: &str) -> Result<RelPath> {
        let dir = self.container_of(parent);
        let name = sanitize_name(title)?;
        let dir_abs = self.abs(&dir)?;
        fsio::ensure_dir(&dir_abs, dir.as_str())?;
        let rel = unique_child(&self.root, &dir, &name, Some("md"))?;
        let mut content = String::new();
        if self.opts.new_page_frontmatter {
            content.push_str(&frontmatter::new_page_header(&new_id(), &now_rfc3339()));
            if !body.is_empty() {
                content.push('\n');
            }
        }
        content.push_str(body);
        fsio::write_new(&self.abs(&rel)?, content.as_bytes(), rel.as_str())?;
        self.index.refresh(&self.root, &rel);
        Ok(rel)
    }

    pub fn create_folder(&mut self, parent: &RelPath, name: &str) -> Result<RelPath> {
        let dir = self.container_of(parent);
        let name = sanitize_name(name)?;
        let rel = unique_child(&self.root, &dir, &name, None)?;
        let abs = self.abs(&rel)?;
        std::fs::create_dir_all(&abs).map_err(|e| CoreError::from_io(e, rel.as_str()))?;
        Ok(rel)
    }

    pub fn duplicate(&mut self, rel: &RelPath) -> Result<RelPath> {
        let abs = self.page_path(rel)?;
        let file = fsio::read_text(&abs, rel.as_str(), None)?;
        let mut content = file.content.clone();
        if let Some(yaml) = frontmatter::split(&content).yaml {
            if frontmatter::parse(yaml).is_ok_and(|p| p.contains_key("id")) {
                content = frontmatter::set_field(&content, "id", &Value::String(new_id()))?;
            }
        }
        let parent = rel.parent().unwrap_or_else(RelPath::root);
        let new = unique_child(&self.root, &parent, &format!("{} (cópia)", rel.stem()), Some("md"))?;
        fsio::write_new(&self.abs(&new)?, &fsio::encode_text(&content, file.format), new.as_str())?;
        self.index.refresh(&self.root, &new);
        Ok(new)
    }

    // ----- Renaming and moving ----------------------------------------------

    pub fn rename(&mut self, rel: &RelPath, new_name: &str) -> Result<RelocateReport> {
        let abs = self.abs(rel)?;
        if !abs.exists() {
            return Err(CoreError::NotFound(rel.to_string()));
        }
        let parent = rel.parent().unwrap_or_else(RelPath::root);
        let clean = sanitize_name(new_name)?;
        let is_page = rel.is_markdown();
        let new = if is_page {
            parent.join(&format!("{clean}.{}", rel.extension().unwrap_or("md")))?
        } else {
            parent.join(&clean)?
        };
        if &new == rel {
            return Ok(RelocateReport {
                path: Some(new),
                ..Default::default()
            });
        }
        let mut moves = vec![(rel.clone(), new.clone())];
        if is_page && rel.children_dir().to_abs(&self.root).is_dir() {
            moves.push((rel.children_dir(), new.children_dir()));
        }
        let stems = if is_page {
            vec![(rel.stem().to_string(), new.stem().to_string())]
        } else {
            Vec::new()
        };
        self.relocate(moves, stems, new)
    }

    /// Moves a page (with its sub-pages) or folder into `dest`, which may be a
    /// folder or a page (meaning "make it a sub-page of that page").
    pub fn move_to(&mut self, rel: &RelPath, dest: &RelPath) -> Result<RelocateReport> {
        let dest_dir = self.container_of(dest);
        let own_dir = if rel.is_markdown() { rel.children_dir() } else { rel.clone() };
        if dest_dir.starts_with(&own_dir) || &dest_dir == rel {
            return Err(CoreError::Validation("não é possível mover uma página para dentro dela mesma".into()));
        }
        if rel.parent().as_ref() == Some(&dest_dir) {
            return Ok(RelocateReport {
                path: Some(rel.clone()),
                ..Default::default()
            });
        }
        fsio::ensure_dir(&self.abs(&dest_dir)?, dest_dir.as_str())?;
        let new = dest_dir.join(rel.file_name())?;
        let mut moves = vec![(rel.clone(), new.clone())];
        if rel.is_markdown() && rel.children_dir().to_abs(&self.root).is_dir() {
            moves.push((rel.children_dir(), new.children_dir()));
        }
        self.relocate(moves, Vec::new(), new)
    }

    fn relocate(&mut self, moves: Vec<(RelPath, RelPath)>, stem_renames: Vec<(String, String)>, primary: RelPath) -> Result<RelocateReport> {
        // 1. Validate every destination before touching anything.
        for (from, to) in &moves {
            let to_abs = self.abs(to)?;
            let case_only = from.as_str().to_lowercase() == to.as_str().to_lowercase();
            if to_abs.exists() && !case_only {
                return Err(CoreError::AlreadyExists(to.to_string()));
            }
            self.abs(from)?;
        }
        // 2. Work out which pages need link updates while the index still
        //    describes the old layout.
        let map = |t: &RelPath| moves.iter().find_map(|(f, to)| t.rebase(f, to));
        let old_prefixes: Vec<RelPath> = moves.iter().map(|m| m.0.clone()).collect();
        let mut targets: Vec<(RelPath, RelPath)> = self.index.pages().filter_map(|p| map(&p.path).map(|n| (p.path.clone(), n))).collect();
        for p in self.index.pages_linking_into(&old_prefixes) {
            if !targets.iter().any(|(o, _)| o == &p) {
                targets.push((p.clone(), p));
            }
        }
        let keys_before: Vec<(RelPath, String)> = targets.iter().map(|(o, _)| (o.clone(), self.history_key(o))).collect();
        // 3. Move on disk; roll back earlier moves if a later one fails.
        let mut done: Vec<(PathBuf, PathBuf)> = Vec::new();
        for (from, to) in &moves {
            let (fa, ta) = (from.to_abs(&self.root), to.to_abs(&self.root));
            if let Err(e) = std::fs::rename(&fa, &ta) {
                for (a, b) in done.iter().rev() {
                    let _ = std::fs::rename(b, a);
                }
                return Err(CoreError::from_io(e, from.as_str()));
            }
            done.push((fa, ta));
        }
        let mut report = RelocateReport {
            path: Some(primary),
            moves: moves.clone(),
            ..Default::default()
        };
        // 4. Rewrite links.
        for (old_self, new_self) in &targets {
            match self.rewrite_links_in(old_self, new_self, &map, &stem_renames) {
                Ok(0) => {}
                Ok(n) => {
                    report.links_updated += n;
                    report.pages_updated.push(new_self.clone());
                }
                Err(e) => report.errors.push(format!("{new_self}: {e}")),
            }
        }
        // 5. Bring derived data up to date.
        for (from, to) in &moves {
            self.index.forget_prefix(from);
            self.index.refresh(&self.root, to);
            self.state.rebase(from, to);
        }
        for updated in &report.pages_updated {
            self.index.refresh(&self.root, updated);
        }
        for (old, key) in keys_before {
            if let Some(new) = map(&old) {
                let new_key = self.history_key(&new);
                let _ = self.history.rekey(&key, &new_key);
            }
        }
        let _ = self.save_state();
        Ok(report)
    }

    fn rewrite_links_in(
        &mut self,
        old_self: &RelPath,
        new_self: &RelPath,
        map: &dyn Fn(&RelPath) -> Option<RelPath>,
        stems: &[(String, String)],
    ) -> Result<usize> {
        let abs = self.abs(new_self)?;
        let file = fsio::read_text(&abs, new_self.as_str(), Some(self.opts.max_file_bytes))?;
        let sp = frontmatter::split(&file.content);
        let (body, n) = links::rewrite(sp.body, old_self, new_self, map, stems);
        if n == 0 {
            return Ok(0);
        }
        let content = format!("{}{}", &file.content[..sp.block_len], body);
        if self.history.opts.enabled {
            self.ensure_meta()?;
            let key = self.history_key(old_self);
            let _ = self.history.snapshot(&key, new_self, &file.content, true);
        }
        fsio::atomic_write(&abs, &fsio::encode_text(&content, file.format), new_self.as_str())?;
        Ok(n)
    }

    // ----- Deleting ------------------------------------------------------------

    pub fn delete(&mut self, rel: &RelPath) -> Result<TrashEntry> {
        self.abs(rel)?;
        self.ensure_meta()?;
        let children = rel.is_markdown().then(|| rel.children_dir());
        let entry = self.trash.put(&self.root, rel, children.as_ref(), history::now_ms())?;
        self.index.forget_prefix(rel);
        if let Some(c) = &entry.children {
            self.index.forget_prefix(c);
        }
        self.state.forget(rel);
        let _ = self.save_state();
        Ok(entry)
    }

    pub fn trash_list(&self) -> Vec<TrashEntry> {
        self.trash.list()
    }

    pub fn trash_restore(&mut self, id: &str) -> Result<RelPath> {
        let p = self.trash.restore(&self.root, id)?;
        self.index.refresh(&self.root, &p);
        if p.is_markdown() {
            self.index.refresh(&self.root, &p.children_dir());
        }
        Ok(p)
    }

    pub fn trash_purge(&self, id: &str) -> Result<()> {
        self.trash.purge(id)
    }

    pub fn trash_empty(&self) -> Result<usize> {
        self.trash.empty()
    }

    // ----- History ---------------------------------------------------------------

    pub fn versions(&self, rel: &RelPath) -> Vec<history::Version> {
        self.history.list(&self.history_key(rel))
    }

    pub fn version_content(&self, rel: &RelPath, ts: i64) -> Result<String> {
        self.history.read(&self.history_key(rel), ts)
    }

    /// Replaces the page with an old version, after snapshotting the current one.
    pub fn restore_version(&mut self, rel: &RelPath, ts: i64) -> Result<SaveOutcome> {
        let key = self.history_key(rel);
        let old = self.history.read(&key, ts)?;
        let abs = self.page_path(rel)?;
        let current = fsio::read_text(&abs, rel.as_str(), None)?;
        self.ensure_meta()?;
        self.history.snapshot(&key, rel, &current.content, true)?;
        let bytes = fsio::encode_text(&old, current.format);
        fsio::atomic_write(&abs, &bytes, rel.as_str())?;
        self.index.refresh(&self.root, rel);
        let modified = std::fs::metadata(&abs).map(|m| modified_ms(&m)).unwrap_or(0);
        Ok(SaveOutcome::Saved {
            hash: fsio::hash_bytes(&bytes),
            modified,
        })
    }

    // ----- Attachments -------------------------------------------------------------

    pub fn add_attachment(&mut self, page: &RelPath, source: &Path) -> Result<AddedAttachment> {
        let a = attachments::add_from_path(&self.root, page, source, &self.opts.attachments)?;
        self.index.refresh(&self.root, &a.path);
        Ok(a)
    }

    pub fn add_attachment_bytes(&mut self, page: &RelPath, name: &str, bytes: &[u8]) -> Result<AddedAttachment> {
        let a = attachments::add_bytes(&self.root, page, name, bytes, &self.opts.attachments)?;
        self.index.refresh(&self.root, &a.path);
        Ok(a)
    }

    // ----- External changes ----------------------------------------------------------

    /// Applies file-system events reported by the watcher. Returns the
    /// vault paths that were affected.
    pub fn apply_fs_events(&mut self, paths: &[PathBuf]) -> Vec<RelPath> {
        let mut changed = Vec::new();
        for p in paths {
            let Ok(rel) = RelPath::from_abs(&self.root, p) else { continue };
            if rel.is_root() || rel.is_hidden() || p.file_name().is_some_and(|n| n.to_string_lossy().starts_with(".note4me-tmp-")) {
                continue;
            }
            if p.exists() {
                self.index.refresh(&self.root, &rel);
            } else {
                self.index.forget_prefix(&rel);
            }
            if !changed.contains(&rel) {
                changed.push(rel);
            }
        }
        changed
    }
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn now_rfc3339() -> String {
    time::OffsetDateTime::now_utc()
        .replace_nanosecond(0)
        .unwrap()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

/// Case-insensitive comparison that orders "Nota 2" before "Nota 10".
pub fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let (la, lb) = (crate::index::fold(a), crate::index::fold(b));
    let mut ia = la.chars().peekable();
    let mut ib = lb.chars().peekable();
    loop {
        match (ia.peek().copied(), ib.peek().copied()) {
            (None, None) => return a.cmp(b),
            (None, _) => return std::cmp::Ordering::Less,
            (_, None) => return std::cmp::Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let mut na = String::new();
                while let Some(c) = ia.peek().copied().filter(char::is_ascii_digit) {
                    na.push(c);
                    ia.next();
                }
                let mut nb = String::new();
                while let Some(c) = ib.peek().copied().filter(char::is_ascii_digit) {
                    nb.push(c);
                    ib.next();
                }
                let ord = na
                    .trim_start_matches('0')
                    .len()
                    .cmp(&nb.trim_start_matches('0').len())
                    .then_with(|| na.trim_start_matches('0').cmp(nb.trim_start_matches('0')));
                if ord != std::cmp::Ordering::Equal {
                    return ord;
                }
            }
            (Some(x), Some(y)) => {
                if x != y {
                    return x.cmp(&y);
                }
                ia.next();
                ib.next();
            }
        }
    }
}
