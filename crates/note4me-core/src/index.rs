//! In-memory index of a vault: titles, properties, tags, text, links.
//!
//! The index is derived data. It is built by scanning the Markdown files and
//! updated incrementally (per path) when files change; it is never persisted,
//! so it can never disagree with the disk across launches. `Index::build`
//! is the "reindex" operation.

use crate::fsio;
use crate::markdown::{frontmatter, links, text};
use crate::paths::{RelPath, META_DIR};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;
use std::time::UNIX_EPOCH;
use unicode_normalization::UnicodeNormalization;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkRef {
    pub kind: links::LinkKind,
    pub dest: String,
    /// Resolved vault path for relative Markdown/image links.
    pub target: Option<RelPath>,
    /// Lower-cased page name for wiki links.
    #[serde(skip)]
    pub wiki: Option<String>,
    pub context: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PageStatus {
    Ok,
    TooLarge,
    InvalidEncoding,
    InvalidFrontmatter,
}

#[derive(Debug, Clone)]
pub struct PageEntry {
    pub path: RelPath,
    pub title: String,
    pub id: Option<String>,
    pub tags: Vec<String>,
    pub props: Map<String, Value>,
    pub headings: Vec<String>,
    pub modified: i64,
    pub size: u64,
    pub words: usize,
    pub status: PageStatus,
    pub text: String,
    /// `text` folded for matching (lower-case, no diacritics), char-aligned.
    folded: Vec<char>,
    folded_title: String,
    pub links: Vec<LinkRef>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageSummary {
    pub path: RelPath,
    pub title: String,
    pub tags: Vec<String>,
    pub modified: i64,
    pub status: PageStatus,
}

impl PageEntry {
    pub fn summary(&self) -> PageSummary {
        PageSummary {
            path: self.path.clone(),
            title: self.title.clone(),
            tags: self.tags.clone(),
            modified: self.modified,
            status: self.status,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct IndexOptions {
    /// Files larger than this are listed but their text is not indexed.
    pub max_file_bytes: u64,
}

impl Default for IndexOptions {
    fn default() -> Self {
        IndexOptions {
            max_file_bytes: 8 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Default)]
pub struct Index {
    pages: BTreeMap<RelPath, PageEntry>,
    /// Non-Markdown files (attachments), for missing-attachment detection.
    files: HashSet<RelPath>,
    /// lower-cased stem → pages with that name (wiki link resolution).
    stems: HashMap<String, Vec<RelPath>>,
    opts: IndexOptions,
}

/// Case- and accent-insensitive folding with a 1:1 char mapping.
pub fn fold_char(c: char) -> char {
    let base = c.nfd().next().unwrap_or(c);
    base.to_lowercase().next().unwrap_or(base)
}

pub fn fold(s: &str) -> String {
    s.chars().map(fold_char).collect()
}

pub fn modified_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl Index {
    pub fn build(root: &Path, opts: IndexOptions) -> Index {
        let mut idx = Index { opts, ..Default::default() };
        idx.scan(root, root);
        idx
    }

    /// Indexes every visible file under `start` (which is inside `root`).
    fn scan(&mut self, root: &Path, start: &Path) {
        let opts = self.opts;
        let walker = walkdir::WalkDir::new(start)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| e.depth() == 0 || !e.file_name().to_str().is_some_and(|n| n.starts_with('.')));
        for entry in walker.filter_map(|e| e.ok()) {
            if !entry.file_type().is_file() {
                continue;
            }
            let Ok(rel) = RelPath::from_abs(root, entry.path()) else { continue };
            if rel.is_hidden() {
                continue;
            }
            if rel.is_markdown() {
                self.remove_page(&rel);
                let e = index_file(root, &rel, opts);
                self.insert(e);
            } else {
                self.files.insert(rel);
            }
        }
    }

    fn insert(&mut self, e: PageEntry) {
        self.stems.entry(e.title.to_lowercase()).or_default().push(e.path.clone());
        self.pages.insert(e.path.clone(), e);
    }

    fn remove_page(&mut self, path: &RelPath) {
        if let Some(old) = self.pages.remove(path) {
            let key = old.title.to_lowercase();
            if let Some(v) = self.stems.get_mut(&key) {
                v.retain(|p| p != path);
                if v.is_empty() {
                    self.stems.remove(&key);
                }
            }
        }
    }

    /// Re-reads one path from disk (or forgets it if it no longer exists).
    pub fn refresh(&mut self, root: &Path, path: &RelPath) {
        if path.is_hidden() || path.components().next() == Some(META_DIR) {
            return;
        }
        let abs = path.to_abs(root);
        self.remove_page(path);
        self.files.remove(path);
        if abs.is_file() {
            if path.is_markdown() {
                let e = index_file(root, path, self.opts);
                self.insert(e);
            } else {
                self.files.insert(path.clone());
            }
        } else if abs.is_dir() {
            // A directory appeared (e.g. moved in from Finder): index its content.
            self.scan(root, &abs);
        }
    }

    /// Forgets everything under `prefix` (a deleted file or directory).
    pub fn forget_prefix(&mut self, prefix: &RelPath) {
        let doomed: Vec<RelPath> = self.pages.keys().filter(|p| p.starts_with(prefix)).cloned().collect();
        for p in doomed {
            self.remove_page(&p);
        }
        self.files.retain(|f| !f.starts_with(prefix));
    }

    pub fn page(&self, path: &RelPath) -> Option<&PageEntry> {
        self.pages.get(path)
    }

    pub fn pages(&self) -> impl Iterator<Item = &PageEntry> {
        self.pages.values()
    }

    pub fn len(&self) -> usize {
        self.pages.len()
    }

    pub fn is_empty(&self) -> bool {
        self.pages.is_empty()
    }

    pub fn exists(&self, path: &RelPath) -> bool {
        self.pages.contains_key(path) || self.files.contains(path)
    }

    pub fn find_by_id(&self, id: &str) -> Option<&PageEntry> {
        self.pages.values().find(|p| p.id.as_deref() == Some(id))
    }

    /// Resolves `[[name]]` written in `from`: same folder first, then the
    /// shortest path. Accepts `Folder/Name` forms too.
    pub fn resolve_wiki(&self, from: &RelPath, name: &str) -> Option<RelPath> {
        let name = name.trim();
        let name = name.strip_suffix(".md").unwrap_or(name);
        if name.contains('/') {
            let candidate = RelPath::parse(&format!("{name}.md")).ok()?;
            if self.pages.contains_key(&candidate) {
                return Some(candidate);
            }
        }
        let stem = name.rsplit('/').next()?.to_lowercase();
        let candidates = self.stems.get(&stem)?;
        let from_dir = from.parent();
        candidates
            .iter()
            .min_by_key(|p| (p.parent() != from_dir, p.as_str().matches('/').count(), p.as_str().len()))
            .cloned()
    }

    fn link_target(&self, from: &RelPath, l: &LinkRef) -> Option<RelPath> {
        match l.kind {
            links::LinkKind::Wiki => l.wiki.as_deref().and_then(|w| self.resolve_wiki(from, w)),
            _ => l.target.clone(),
        }
    }

    /// Pages linking to `target`, with the context around each link.
    pub fn backlinks(&self, target: &RelPath) -> Vec<Backlink> {
        let mut out = Vec::new();
        for page in self.pages.values() {
            if &page.path == target {
                continue;
            }
            let contexts: Vec<String> = page
                .links
                .iter()
                .filter(|l| self.link_target(&page.path, l).as_ref() == Some(target))
                .map(|l| l.context.clone())
                .collect();
            if !contexts.is_empty() {
                out.push(Backlink {
                    path: page.path.clone(),
                    title: page.title.clone(),
                    contexts,
                });
            }
        }
        out
    }

    /// Pages whose links resolve to something under any of `prefixes`.
    pub fn pages_linking_into(&self, prefixes: &[RelPath]) -> Vec<RelPath> {
        self.pages
            .values()
            .filter(|p| {
                p.links
                    .iter()
                    .any(|l| self.link_target(&p.path, l).is_some_and(|t| prefixes.iter().any(|pre| t.starts_with(pre))))
            })
            .map(|p| p.path.clone())
            .collect()
    }

    pub fn broken_links(&self, only: Option<&RelPath>) -> Vec<BrokenLink> {
        let mut out = Vec::new();
        for page in self.pages.values() {
            if only.is_some_and(|o| o != &page.path) {
                continue;
            }
            for l in &page.links {
                let ok = match l.kind {
                    links::LinkKind::Wiki => l.wiki.as_deref().is_some_and(|w| self.resolve_wiki(&page.path, w).is_some()),
                    _ => match &l.target {
                        Some(t) => self.exists(t),
                        // Escapes the vault (`../../x`) — cannot be checked, report it.
                        None => !links::is_local(&l.dest),
                    },
                };
                if !ok {
                    out.push(BrokenLink {
                        from: page.path.clone(),
                        dest: l.dest.clone(),
                        kind: l.kind,
                    });
                }
            }
        }
        out
    }

    pub fn tags(&self) -> Vec<(String, usize)> {
        let mut counts: BTreeMap<String, usize> = BTreeMap::new();
        for p in self.pages.values() {
            for t in &p.tags {
                *counts.entry(t.clone()).or_default() += 1;
            }
        }
        counts.into_iter().collect()
    }

    /// Fuzzy title lookup for the quick switcher.
    pub fn quick_find(&self, query: &str, limit: usize) -> Vec<PageSummary> {
        let q: Vec<char> = fold(query.trim()).chars().filter(|c| !c.is_whitespace()).collect();
        let mut scored: Vec<(i64, &PageEntry)> = self
            .pages
            .values()
            .filter_map(|p| {
                if q.is_empty() {
                    return Some((-(p.modified / 1000), p));
                }
                let title_score = fuzzy_score(&p.folded_title, &q).map(|s| s + 1000);
                let path_score = fuzzy_score(&fold(p.path.as_str()), &q);
                title_score.or(path_score).map(|s| (-s, p))
            })
            .collect();
        scored.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.title.cmp(&b.1.title)));
        scored.into_iter().take(limit).map(|(_, p)| p.summary()).collect()
    }

    pub fn search(&self, q: &SearchQuery) -> Vec<SearchHit> {
        let parsed = ParsedQuery::parse(&q.text);
        let mut tags = parsed.tags.clone();
        tags.extend(q.tags.iter().map(|t| fold(t)));
        let folder = q.folder.clone().or(parsed.folder.clone());
        let mut hits = Vec::new();
        for page in self.pages.values() {
            if let Some(f) = &folder {
                if !page.path.starts_with(f) {
                    continue;
                }
            }
            if q.modified_after.is_some_and(|t| page.modified < t) || q.modified_before.is_some_and(|t| page.modified > t) {
                continue;
            }
            let page_tags: Vec<String> = page.tags.iter().map(|t| fold(t)).collect();
            if !tags.iter().all(|t| page_tags.iter().any(|pt| pt == t || pt.starts_with(&format!("{t}/")))) {
                continue;
            }
            if parsed.terms.is_empty() && (folder.is_some() || !tags.is_empty() || q.modified_after.is_some() || q.modified_before.is_some()) {
                hits.push(SearchHit {
                    path: page.path.clone(),
                    title: page.title.clone(),
                    snippet: page.text.chars().take(160).collect(),
                    score: 1,
                    matched: vec!["filter".into()],
                    modified: page.modified,
                    tags: page.tags.clone(),
                });
                continue;
            }
            if parsed.terms.is_empty() {
                continue;
            }
            let props_text = fold(&serde_json::to_string(&page.props).unwrap_or_default());
            let file_name = fold(page.path.as_str());
            let mut score = 0i64;
            let mut matched = HashSet::new();
            let mut first_body_hit: Option<(usize, usize)> = None;
            let mut all = true;
            for term in &parsed.terms {
                let mut term_hit = false;
                if page.folded_title.contains(term.as_str()) {
                    score += if page.folded_title == *term { 60 } else { 25 };
                    matched.insert("title");
                    term_hit = true;
                }
                if file_name.contains(term.as_str()) {
                    score += 4;
                    matched.insert("path");
                    term_hit = true;
                }
                if page_tags.iter().any(|t| t.contains(term.as_str())) {
                    score += 12;
                    matched.insert("tags");
                    term_hit = true;
                }
                if props_text.contains(term.as_str()) {
                    score += 6;
                    matched.insert("properties");
                    term_hit = true;
                }
                if page.headings.iter().any(|h| fold(h).contains(term.as_str())) {
                    score += 8;
                }
                let term_chars: Vec<char> = term.chars().collect();
                let occurrences = find_all(&page.folded, &term_chars, 20);
                if let Some(&first) = occurrences.first() {
                    score += 2 + occurrences.len() as i64;
                    matched.insert("content");
                    term_hit = true;
                    if first_body_hit.is_none() {
                        first_body_hit = Some((first, term_chars.len()));
                    }
                }
                if !term_hit {
                    all = false;
                    break;
                }
            }
            if !all {
                continue;
            }
            let snippet = match first_body_hit {
                Some((at, len)) => snippet_around(&page.text, at, len),
                None => page.text.chars().take(160).collect(),
            };
            let mut matched: Vec<String> = matched.into_iter().map(String::from).collect();
            matched.sort();
            hits.push(SearchHit {
                path: page.path.clone(),
                title: page.title.clone(),
                snippet,
                score,
                matched,
                modified: page.modified,
                tags: page.tags.clone(),
            });
        }
        hits.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| b.modified.cmp(&a.modified)));
        hits.truncate(q.limit.unwrap_or(200));
        hits
    }
}

fn find_all(hay: &[char], needle: &[char], max: usize) -> Vec<usize> {
    let mut out = Vec::new();
    if needle.is_empty() || needle.len() > hay.len() {
        return out;
    }
    let mut i = 0;
    while i + needle.len() <= hay.len() && out.len() < max {
        if hay[i] == needle[0] && hay[i..i + needle.len()] == *needle {
            out.push(i);
            i += needle.len();
        } else {
            i += 1;
        }
    }
    out
}

fn snippet_around(text: &str, char_at: usize, len: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    let start = char_at.saturating_sub(60);
    let end = (char_at + len + 100).min(chars.len());
    let mut s: String = chars[start..end].iter().collect::<String>().replace('\n', " ");
    if start > 0 {
        s = format!("…{}", s.trim_start());
    }
    if end < chars.len() {
        s = format!("{}…", s.trim_end());
    }
    s
}

/// Subsequence score: consecutive and word-start matches score higher.
fn fuzzy_score(hay: &str, needle: &[char]) -> Option<i64> {
    let hay: Vec<char> = hay.chars().collect();
    let mut score = 0i64;
    let mut hi = 0;
    let mut prev_match: Option<usize> = None;
    for &nc in needle {
        let mut found = None;
        while hi < hay.len() {
            if hay[hi] == nc {
                found = Some(hi);
                hi += 1;
                break;
            }
            hi += 1;
        }
        let at = found?;
        score += 1;
        if prev_match.is_some_and(|p| p + 1 == at) {
            score += 5;
        }
        if at == 0 || !hay[at - 1].is_alphanumeric() {
            score += 8;
        }
        prev_match = Some(at);
    }
    // Prefer shorter titles for equal matches.
    Some(score * 10 - hay.len() as i64 / 4)
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchQuery {
    pub text: String,
    pub folder: Option<RelPath>,
    pub tags: Vec<String>,
    /// Unix milliseconds.
    pub modified_after: Option<i64>,
    pub modified_before: Option<i64>,
    pub limit: Option<usize>,
}

#[derive(Debug, Default, PartialEq)]
struct ParsedQuery {
    terms: Vec<String>,
    tags: Vec<String>,
    folder: Option<RelPath>,
}

impl ParsedQuery {
    /// Supports plain words, "quoted phrases", `tag:x` / `#x` and `path:Pasta`.
    fn parse(input: &str) -> ParsedQuery {
        let mut out = ParsedQuery::default();
        let mut tokens = Vec::new();
        let mut cur = String::new();
        let mut quoted = false;
        for c in input.chars() {
            match c {
                '"' => {
                    if quoted && !cur.is_empty() {
                        tokens.push(std::mem::take(&mut cur));
                    }
                    quoted = !quoted;
                }
                c if c.is_whitespace() && !quoted => {
                    if !cur.is_empty() {
                        tokens.push(std::mem::take(&mut cur));
                    }
                }
                c => cur.push(c),
            }
        }
        if !cur.is_empty() {
            tokens.push(cur);
        }
        for t in tokens {
            if let Some(tag) = t.strip_prefix("tag:").or_else(|| t.strip_prefix('#').filter(|s| !s.is_empty())) {
                out.tags.push(fold(tag));
            } else if let Some(p) = t.strip_prefix("path:") {
                out.folder = RelPath::parse(p).ok();
            } else {
                out.terms.push(fold(&t));
            }
        }
        out
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: RelPath,
    pub title: String,
    pub snippet: String,
    pub score: i64,
    pub matched: Vec<String>,
    pub modified: i64,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Backlink {
    pub path: RelPath,
    pub title: String,
    pub contexts: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokenLink {
    pub from: RelPath,
    pub dest: String,
    pub kind: links::LinkKind,
}

/// Reads and indexes one Markdown file. Never fails: problems are recorded
/// in `status` so that one bad file cannot break the rest of the vault.
pub fn index_file(root: &Path, rel: &RelPath, opts: IndexOptions) -> PageEntry {
    let abs = rel.to_abs(root);
    let meta = std::fs::metadata(&abs).ok();
    let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    let modified = meta.as_ref().map(modified_ms).unwrap_or(0);
    let title = rel.stem().to_string();
    let mut entry = PageEntry {
        path: rel.clone(),
        folded_title: fold(&title),
        title,
        id: None,
        tags: Vec::new(),
        props: Map::new(),
        headings: Vec::new(),
        modified,
        size,
        words: 0,
        status: PageStatus::Ok,
        text: String::new(),
        folded: Vec::new(),
        links: Vec::new(),
    };
    let file = match fsio::read_text(&abs, rel.as_str(), Some(opts.max_file_bytes)) {
        Ok(f) => f,
        Err(e) => {
            entry.status = if e.kind() == "tooLarge" {
                PageStatus::TooLarge
            } else {
                PageStatus::InvalidEncoding
            };
            return entry;
        }
    };
    let split = frontmatter::split(&file.content);
    if let Some(yaml) = split.yaml {
        match frontmatter::parse(yaml) {
            Ok(props) => {
                entry.tags = frontmatter::tags_of(&props);
                entry.id = props.get("id").and_then(|v| v.as_str().map(str::to_string));
                entry.props = props;
            }
            Err(_) => entry.status = PageStatus::InvalidFrontmatter,
        }
    }
    let body = split.body;
    let ex = text::extract(body);
    entry.headings = ex.headings;
    entry.words = ex.words;
    entry.folded = ex.text.chars().map(fold_char).collect();
    entry.text = ex.text;
    entry.links = links::extract(body)
        .into_iter()
        .map(|l| {
            let ctx_start = floor_boundary(body, l.range.start.saturating_sub(50));
            let ctx_end = ceil_boundary(body, (l.range.end + 50).min(body.len()));
            let context = body[ctx_start..ctx_end].replace('\n', " ").trim().to_string();
            let (target, wiki) = match l.kind {
                links::LinkKind::Wiki => (None, Some(links::split_suffix(&l.dest).0.to_string())),
                _ => (links::resolve(rel, &l.dest), None),
            };
            LinkRef {
                kind: l.kind,
                dest: l.dest,
                target,
                wiki,
                context,
            }
        })
        .collect();
    entry
}

fn floor_boundary(s: &str, mut i: usize) -> usize {
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn ceil_boundary(s: &str, mut i: usize) -> usize {
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn vault() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        fs::create_dir_all(r.join("Projetos")).unwrap();
        fs::create_dir_all(r.join("Estudos")).unwrap();
        fs::create_dir_all(r.join(".note4me")).unwrap();
        fs::write(r.join("Home.md"), "# Início\n\nVeja [Rust](Estudos/Rust.md) e [[Banco de Dados]].\n").unwrap();
        fs::write(
            r.join("Projetos/Projeto A.md"),
            "---\ntags: [projeto, trabalho]\nstatus: ativo\n---\nUsa [Rust](../Estudos/Rust.md) e ![x](../img/falta.png).\n",
        )
        .unwrap();
        fs::write(r.join("Estudos/Rust.md"), "# Rust\n\nOwnership e borrowing. Programação segura.\n").unwrap();
        fs::write(r.join("Estudos/Banco de Dados.md"), "Índices e transações.\n").unwrap();
        fs::write(r.join("Estudos/ruim.md"), [0xFFu8, 0xFE]).unwrap();
        fs::write(r.join(".note4me/oculto.md"), "não indexar").unwrap();
        d
    }

    #[test]
    fn builds_and_skips_hidden() {
        let d = vault();
        let idx = Index::build(d.path(), IndexOptions::default());
        assert_eq!(idx.len(), 5);
        assert!(idx.page(&RelPath::parse(".note4me/oculto.md").unwrap()).is_none());
        assert_eq!(
            idx.page(&RelPath::parse("Estudos/ruim.md").unwrap()).unwrap().status,
            PageStatus::InvalidEncoding
        );
    }

    #[test]
    fn search_is_accent_and_case_insensitive() {
        let d = vault();
        let idx = Index::build(d.path(), IndexOptions::default());
        let hits = idx.search(&SearchQuery {
            text: "PROGRAMACAO".into(),
            ..Default::default()
        });
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path.as_str(), "Estudos/Rust.md");
        assert!(hits[0].snippet.contains("Programação"));

        let hits = idx.search(&SearchQuery {
            text: "rust".into(),
            ..Default::default()
        });
        assert_eq!(hits[0].path.as_str(), "Estudos/Rust.md", "title match ranks first");
        assert_eq!(hits.len(), 3);

        let hits = idx.search(&SearchQuery {
            text: "tag:projeto".into(),
            ..Default::default()
        });
        assert_eq!(hits.len(), 1);
        let hits = idx.search(&SearchQuery {
            text: "ativo".into(),
            ..Default::default()
        });
        assert_eq!(hits[0].matched, vec!["properties"]);
        let hits = idx.search(&SearchQuery {
            text: "rust".into(),
            folder: Some(RelPath::parse("Projetos").unwrap()),
            ..Default::default()
        });
        assert_eq!(hits.len(), 1);
        let hits = idx.search(&SearchQuery {
            text: "\"ownership e\" borrowing".into(),
            ..Default::default()
        });
        assert_eq!(hits.len(), 1);
        let hits = idx.search(&SearchQuery {
            text: "rust inexistente".into(),
            ..Default::default()
        });
        assert!(hits.is_empty());
    }

    #[test]
    fn backlinks_and_broken_links() {
        let d = vault();
        let idx = Index::build(d.path(), IndexOptions::default());
        let rust = RelPath::parse("Estudos/Rust.md").unwrap();
        let bl = idx.backlinks(&rust);
        let froms: Vec<_> = bl.iter().map(|b| b.path.as_str()).collect();
        assert_eq!(froms, vec!["Home.md", "Projetos/Projeto A.md"]);
        assert!(bl[0].contexts[0].contains("Veja [Rust]"));
        let bd = idx.backlinks(&RelPath::parse("Estudos/Banco de Dados.md").unwrap());
        assert_eq!(bd.len(), 1, "wiki links count as backlinks");
        let broken = idx.broken_links(None);
        assert_eq!(broken.len(), 1);
        assert_eq!(broken[0].dest, "../img/falta.png");
    }

    #[test]
    fn incremental_refresh() {
        let d = vault();
        let mut idx = Index::build(d.path(), IndexOptions::default());
        fs::write(d.path().join("Nova.md"), "termo-unico-xyz").unwrap();
        idx.refresh(d.path(), &RelPath::parse("Nova.md").unwrap());
        assert_eq!(
            idx.search(&SearchQuery {
                text: "termo-unico-xyz".into(),
                ..Default::default()
            })
            .len(),
            1
        );
        fs::remove_file(d.path().join("Nova.md")).unwrap();
        idx.refresh(d.path(), &RelPath::parse("Nova.md").unwrap());
        assert!(idx
            .search(&SearchQuery {
                text: "termo-unico-xyz".into(),
                ..Default::default()
            })
            .is_empty());
    }

    #[test]
    fn quick_find_prefers_title_prefix() {
        let d = vault();
        let idx = Index::build(d.path(), IndexOptions::default());
        let r = idx.quick_find("bd", 5);
        assert_eq!(r[0].title, "Banco de Dados");
        let r = idx.quick_find("proj a", 5);
        assert_eq!(r[0].title, "Projeto A");
    }

    #[test]
    fn query_parser() {
        let q = ParsedQuery::parse("#Trabalho \"duas palavras\" path:Projetos rust");
        assert_eq!(q.tags, vec!["trabalho"]);
        assert_eq!(q.terms, vec!["duas palavras", "rust"]);
        assert_eq!(q.folder.unwrap().as_str(), "Projetos");
    }
}
