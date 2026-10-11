//! Vault-relative paths and file-name rules.
//!
//! Every path that crosses the UI boundary is a [`RelPath`]: forward-slash
//! separated, relative to the vault root, with no `..`, no empty or hidden
//! components and normalised to Unicode NFC (APFS preserves whatever form it
//! is given, so we normalise to keep comparisons stable).

use crate::error::{CoreError, Result};
use serde::{Deserialize, Serialize};
use std::fmt;
use std::path::{Component, Path, PathBuf};
use unicode_normalization::UnicodeNormalization;

/// Name of the per-vault directory for optional, rebuildable app data.
pub const META_DIR: &str = ".note4me";
pub const MD_EXT: &str = "md";
const MAX_NAME_BYTES: usize = 200;

#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct RelPath(String);

impl RelPath {
    /// The vault root itself.
    pub fn root() -> Self {
        RelPath(String::new())
    }

    pub fn parse(raw: &str) -> Result<Self> {
        let raw = raw.trim_matches('/');
        if raw.is_empty() {
            return Ok(Self::root());
        }
        if raw.contains('\0') || raw.contains('\\') {
            return Err(CoreError::InvalidPath(raw.to_string()));
        }
        let mut parts = Vec::new();
        for part in raw.split('/') {
            if part.is_empty() || part == "." || part == ".." {
                return Err(CoreError::InvalidPath(raw.to_string()));
            }
            parts.push(part.nfc().collect::<String>());
        }
        Ok(RelPath(parts.join("/")))
    }

    /// Converts a path under `root` into a RelPath.
    pub fn from_abs(root: &Path, abs: &Path) -> Result<Self> {
        let rel = abs.strip_prefix(root).map_err(|_| CoreError::InvalidPath(abs.display().to_string()))?;
        let mut parts = Vec::new();
        for c in rel.components() {
            match c {
                Component::Normal(s) => parts.push(s.to_str().ok_or_else(|| CoreError::InvalidPath(rel.display().to_string()))?.to_string()),
                _ => return Err(CoreError::InvalidPath(rel.display().to_string())),
            }
        }
        Self::parse(&parts.join("/"))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn is_root(&self) -> bool {
        self.0.is_empty()
    }

    pub fn components(&self) -> impl Iterator<Item = &str> {
        self.0.split('/').filter(|s| !s.is_empty())
    }

    pub fn file_name(&self) -> &str {
        self.0.rsplit('/').next().unwrap_or("")
    }

    /// File name without the `.md` extension (for pages this is the title).
    pub fn stem(&self) -> &str {
        let name = self.file_name();
        match name.rfind('.') {
            Some(i) if i > 0 => &name[..i],
            _ => name,
        }
    }

    pub fn extension(&self) -> Option<&str> {
        let name = self.file_name();
        name.rfind('.').filter(|&i| i > 0).map(|i| &name[i + 1..])
    }

    pub fn is_markdown(&self) -> bool {
        self.extension()
            .is_some_and(|e| e.eq_ignore_ascii_case(MD_EXT) || e.eq_ignore_ascii_case("markdown"))
    }

    pub fn parent(&self) -> Option<RelPath> {
        if self.is_root() {
            return None;
        }
        Some(match self.0.rfind('/') {
            Some(i) => RelPath(self.0[..i].to_string()),
            None => RelPath::root(),
        })
    }

    pub fn join(&self, name: &str) -> Result<RelPath> {
        if self.is_root() {
            RelPath::parse(name)
        } else {
            RelPath::parse(&format!("{}/{}", self.0, name))
        }
    }

    /// `Projeto.md` → `Projeto` (the folder holding its sub-pages).
    pub fn children_dir(&self) -> RelPath {
        let s = self.0.strip_suffix(&format!(".{MD_EXT}")).unwrap_or(&self.0);
        RelPath(s.to_string())
    }

    /// `true` when `self` equals `ancestor` or lies inside it.
    pub fn starts_with(&self, ancestor: &RelPath) -> bool {
        ancestor.is_root() || self.0 == ancestor.0 || self.0.starts_with(&format!("{}/", ancestor.0))
    }

    /// Replaces the `from` prefix with `to` (used by renames and moves).
    pub fn rebase(&self, from: &RelPath, to: &RelPath) -> Option<RelPath> {
        if !self.starts_with(from) {
            return None;
        }
        let rest = &self.0[from.0.len()..];
        let rest = rest.trim_start_matches('/');
        if to.is_root() {
            RelPath::parse(rest).ok()
        } else if rest.is_empty() {
            Some(to.clone())
        } else {
            to.join(rest).ok()
        }
    }

    /// Whether this path is inside the app's metadata directory or is hidden.
    pub fn is_hidden(&self) -> bool {
        self.components().any(|c| c.starts_with('.'))
    }

    /// Absolute path under `root`. Validation already rejected traversal.
    pub fn to_abs(&self, root: &Path) -> PathBuf {
        let mut p = root.to_path_buf();
        for c in self.components() {
            p.push(c);
        }
        p
    }
}

impl TryFrom<String> for RelPath {
    type Error = CoreError;
    fn try_from(s: String) -> Result<Self> {
        RelPath::parse(&s)
    }
}

impl From<RelPath> for String {
    fn from(p: RelPath) -> String {
        p.0
    }
}

impl fmt::Display for RelPath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Turns a user-entered title into a safe, portable file-name stem.
///
/// The rules favour names that work on macOS, Windows, Linux and common sync
/// services: path separators and characters reserved on Windows are replaced
/// with `-`, control characters are removed, leading dots are stripped (they
/// would hide the file) and the length is capped.
pub fn sanitize_name(title: &str) -> Result<String> {
    let mut out = String::with_capacity(title.len());
    for ch in title.nfc() {
        match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => out.push('-'),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    let collapsed: String = out.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut name = collapsed.trim_start_matches('.').trim().trim_end_matches('.').trim().to_string();
    if name.len() > MAX_NAME_BYTES {
        let mut cut = MAX_NAME_BYTES;
        while !name.is_char_boundary(cut) {
            cut -= 1;
        }
        name.truncate(cut);
        name = name.trim_end().to_string();
    }
    if name.is_empty() {
        return Err(CoreError::InvalidName(title.to_string()));
    }
    let upper = name.to_ascii_uppercase();
    const RESERVED: [&str; 4] = ["CON", "PRN", "AUX", "NUL"];
    if RESERVED.contains(&upper.as_str())
        || (upper.len() == 4 && (upper.starts_with("COM") || upper.starts_with("LPT")) && upper.as_bytes()[3].is_ascii_digit())
    {
        name.push('_');
    }
    Ok(name)
}

/// Returns `dir/stem.ext`, or `dir/stem 2.ext`, `dir/stem 3.ext`… choosing the
/// first name that does not exist on disk (case-insensitively, because APFS is
/// case-insensitive by default). Never overwrites.
pub fn unique_child(root: &Path, dir: &RelPath, stem: &str, ext: Option<&str>) -> Result<RelPath> {
    let abs_dir = dir.to_abs(root);
    let existing: Vec<String> = match std::fs::read_dir(&abs_dir) {
        Ok(rd) => rd
            .filter_map(|e| e.ok())
            .filter_map(|e| e.file_name().to_str().map(|s| s.nfc().collect::<String>().to_lowercase()))
            .collect(),
        Err(_) => Vec::new(),
    };
    let make = |n: usize| match (ext, n) {
        (Some(e), 1) => format!("{stem}.{e}"),
        (Some(e), n) => format!("{stem} {n}.{e}"),
        (None, 1) => stem.to_string(),
        (None, n) => format!("{stem} {n}"),
    };
    for n in 1..10_000 {
        let candidate = make(n);
        if !existing.contains(&candidate.to_lowercase()) {
            return dir.join(&candidate);
        }
    }
    Err(CoreError::AlreadyExists(stem.to_string()))
}

/// Verifies that an absolute path (after resolving symlinks) stays within
/// `root`. Protects against symlinks inside the vault pointing elsewhere.
pub fn ensure_within(root: &Path, abs: &Path) -> Result<()> {
    let canon_root = root.canonicalize().map_err(|e| CoreError::from_io(e, "vault"))?;
    let mut probe = abs.to_path_buf();
    // Walk up to the nearest existing ancestor (the target may not exist yet).
    while !probe.exists() {
        if !probe.pop() {
            return Err(CoreError::InvalidPath(abs.display().to_string()));
        }
    }
    let canon = probe.canonicalize().map_err(|e| CoreError::from_io(e, abs.display().to_string()))?;
    if canon.starts_with(&canon_root) {
        Ok(())
    } else {
        Err(CoreError::InvalidPath("o caminho aponta para fora do espaço de trabalho".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_traversal_and_absolute() {
        assert!(RelPath::parse("../etc/passwd").is_err());
        assert!(RelPath::parse("a/../../b").is_err());
        assert!(RelPath::parse("a//b").is_err());
        assert!(RelPath::parse("a\\b").is_err());
        assert_eq!(RelPath::parse("/a/b.md").unwrap().as_str(), "a/b.md");
    }

    #[test]
    fn normalises_unicode() {
        let nfd = "Proje\u{0301}to.md"; // é decomposed
        let p = RelPath::parse(nfd).unwrap();
        assert_eq!(p.as_str(), "Projéto.md");
    }

    #[test]
    fn path_helpers() {
        let p = RelPath::parse("Projetos/Projeto A.md").unwrap();
        assert_eq!(p.stem(), "Projeto A");
        assert_eq!(p.parent().unwrap().as_str(), "Projetos");
        assert_eq!(p.children_dir().as_str(), "Projetos/Projeto A");
        assert!(p.is_markdown());
        let moved = p
            .rebase(&RelPath::parse("Projetos").unwrap(), &RelPath::parse("Arquivo/2026").unwrap())
            .unwrap();
        assert_eq!(moved.as_str(), "Arquivo/2026/Projeto A.md");
        assert!(!RelPath::parse("Projetos2/x.md").unwrap().starts_with(&RelPath::parse("Projetos").unwrap()));
        assert!(RelPath::parse(".note4me/state.json").unwrap().is_hidden());
    }

    #[test]
    fn sanitizes_names() {
        assert_eq!(sanitize_name("  Notas: 2026/10  ").unwrap(), "Notas- 2026-10");
        assert_eq!(sanitize_name("..oculto").unwrap(), "oculto");
        assert_eq!(sanitize_name("CON").unwrap(), "CON_");
        assert!(sanitize_name("   ").is_err());
        assert!(sanitize_name("\u{7}").is_err());
        let long = "á".repeat(300);
        assert!(sanitize_name(&long).unwrap().len() <= 200);
    }

    #[test]
    fn unique_names_never_collide() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("Nota.md"), "x").unwrap();
        std::fs::write(dir.path().join("nota 2.md"), "x").unwrap();
        let p = unique_child(dir.path(), &RelPath::root(), "Nota", Some("md")).unwrap();
        assert_eq!(p.as_str(), "Nota 3.md");
    }

    #[cfg(unix)]
    #[test]
    fn detects_symlink_escape() {
        let vault = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), vault.path().join("link")).unwrap();
        assert!(ensure_within(vault.path(), &vault.path().join("link/x.md")).is_err());
        assert!(ensure_within(vault.path(), &vault.path().join("ok/x.md")).is_ok());
    }
}
