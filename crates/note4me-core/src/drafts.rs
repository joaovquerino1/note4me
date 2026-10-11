//! Crash/failed-save recovery drafts.
//!
//! When a save cannot be completed (conflict, permissions, full disk, the app
//! closing with pending edits), the unsaved body is written to
//! `.note4me/drafts/<key>.json`. On the next open the UI offers to restore
//! or discard it. Drafts are removed after a successful save.

use crate::error::Result;
use crate::fsio;
use crate::paths::RelPath;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub path: RelPath,
    pub body: String,
    /// Hash of the file the draft was based on.
    pub base_hash: Option<String>,
    pub saved_at: i64,
}

fn file(meta_dir: &Path, path: &RelPath) -> PathBuf {
    let key = blake3::hash(path.as_str().as_bytes()).to_hex()[..24].to_string();
    meta_dir.join("drafts").join(format!("{key}.json"))
}

pub fn stash(meta_dir: &Path, draft: &Draft) -> Result<()> {
    let f = file(meta_dir, &draft.path);
    fsio::ensure_dir(f.parent().unwrap(), "rascunhos")?;
    fsio::atomic_write(&f, &serde_json::to_vec(draft).unwrap(), "rascunho")
}

pub fn get(meta_dir: &Path, path: &RelPath) -> Option<Draft> {
    let bytes = std::fs::read(file(meta_dir, path)).ok()?;
    serde_json::from_slice(&bytes).ok().filter(|d: &Draft| &d.path == path)
}

pub fn discard(meta_dir: &Path, path: &RelPath) {
    let _ = std::fs::remove_file(file(meta_dir, path));
}

pub fn list(meta_dir: &Path) -> Vec<Draft> {
    std::fs::read_dir(meta_dir.join("drafts"))
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .filter_map(|e| serde_json::from_slice(&std::fs::read(e.path()).ok()?).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stash_get_discard() {
        let d = tempfile::tempdir().unwrap();
        let p = RelPath::parse("A.md").unwrap();
        let draft = Draft {
            path: p.clone(),
            body: "texto".into(),
            base_hash: Some("h".into()),
            saved_at: 1,
        };
        stash(d.path(), &draft).unwrap();
        assert_eq!(get(d.path(), &p), Some(draft));
        assert_eq!(list(d.path()).len(), 1);
        discard(d.path(), &p);
        assert!(get(d.path(), &p).is_none());
    }
}
