//! Recoverable deletion.
//!
//! Deleting a page moves its file (and its sub-page folder, if any) into
//! `.note4me/trash/<entry>/` together with a small manifest recording the
//! original location. Restoring moves it back, choosing a new name if the
//! original one is now taken. Only "empty trash" deletes permanently.

use crate::error::{CoreError, Result};
use crate::fsio;
use crate::paths::RelPath;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrashEntry {
    pub id: String,
    /// Original path of the page file or folder.
    pub original: RelPath,
    pub deleted_at: i64,
    pub is_folder: bool,
    /// Original path of the sub-page folder that was trashed alongside.
    pub children: Option<RelPath>,
}

pub struct Trash {
    dir: PathBuf,
}

impl Trash {
    pub fn new(meta_dir: &Path) -> Trash {
        Trash { dir: meta_dir.join("trash") }
    }

    fn entry_dir(&self, id: &str) -> Result<PathBuf> {
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Err(CoreError::Validation("identificador de lixeira inválido".into()));
        }
        Ok(self.dir.join(id))
    }

    /// Moves `item` (and optionally `children`) from the vault into the trash.
    pub fn put(&self, root: &Path, item: &RelPath, children: Option<&RelPath>, now: i64) -> Result<TrashEntry> {
        let id = format!("{now}-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
        let dir = self.entry_dir(&id)?;
        fsio::ensure_dir(&dir, "lixeira")?;
        let abs = item.to_abs(root);
        let is_folder = abs.is_dir();
        std::fs::rename(&abs, dir.join("item")).map_err(|e| CoreError::from_io(e, item.as_str()))?;
        let mut moved_children = None;
        if let Some(c) = children {
            let cabs = c.to_abs(root);
            if cabs.is_dir() {
                if let Err(e) = std::fs::rename(&cabs, dir.join("children")) {
                    // Undo the first move so nothing ends up half-deleted.
                    let _ = std::fs::rename(dir.join("item"), &abs);
                    let _ = std::fs::remove_dir_all(&dir);
                    return Err(CoreError::from_io(e, c.as_str()));
                }
                moved_children = Some(c.clone());
            }
        }
        let entry = TrashEntry {
            id,
            original: item.clone(),
            deleted_at: now,
            is_folder,
            children: moved_children,
        };
        fsio::write_new(&dir.join("entry.json"), &serde_json::to_vec_pretty(&entry).unwrap(), "lixeira")?;
        Ok(entry)
    }

    pub fn list(&self) -> Vec<TrashEntry> {
        let mut out: Vec<TrashEntry> = std::fs::read_dir(&self.dir)
            .into_iter()
            .flatten()
            .filter_map(|e| e.ok())
            .filter_map(|e| serde_json::from_slice(&std::fs::read(e.path().join("entry.json")).ok()?).ok())
            .collect();
        out.sort_by_key(|e| std::cmp::Reverse(e.deleted_at));
        out
    }

    /// Restores an entry; returns the path it was restored to.
    pub fn restore(&self, root: &Path, id: &str) -> Result<RelPath> {
        let dir = self.entry_dir(id)?;
        let entry: TrashEntry = serde_json::from_slice(&std::fs::read(dir.join("entry.json")).map_err(|e| CoreError::from_io(e, "lixeira"))?)
            .map_err(|_| CoreError::Validation("registro da lixeira corrompido".into()))?;
        let parent = entry.original.parent().unwrap_or_else(RelPath::root);
        fsio::ensure_dir(&parent.to_abs(root), parent.as_str())?;
        let target = if entry.original.to_abs(root).exists() || entry.children.as_ref().is_some_and(|c| c.to_abs(root).exists()) {
            let ext = if entry.is_folder { None } else { entry.original.extension() };
            crate::paths::unique_child(root, &parent, &format!("{} (restaurado)", entry.original.stem()), ext)?
        } else {
            entry.original.clone()
        };
        std::fs::rename(dir.join("item"), target.to_abs(root)).map_err(|e| CoreError::from_io(e, target.as_str()))?;
        if entry.children.is_some() && dir.join("children").exists() {
            let cdir = target.children_dir();
            if !cdir.to_abs(root).exists() {
                std::fs::rename(dir.join("children"), cdir.to_abs(root)).map_err(|e| CoreError::from_io(e, cdir.as_str()))?;
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
        Ok(target)
    }

    pub fn purge(&self, id: &str) -> Result<()> {
        let dir = self.entry_dir(id)?;
        std::fs::remove_dir_all(&dir).map_err(|e| CoreError::from_io(e, "lixeira"))
    }

    pub fn empty(&self) -> Result<usize> {
        let entries = self.list();
        for e in &entries {
            self.purge(&e.id)?;
        }
        Ok(entries.len())
    }
}
