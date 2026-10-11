//! Optional per-vault UI state: favourites, recents, manual ordering and
//! collection views. Stored in `.note4me/state.json`. Losing this file loses
//! only those conveniences — never content.

use crate::error::Result;
use crate::fsio;
use crate::paths::RelPath;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const MAX_RECENTS: usize = 30;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct VaultState {
    pub version: u32,
    pub favorites: Vec<RelPath>,
    pub recents: Vec<RelPath>,
    /// Folder path ("" = root) → entry names in the user's manual order.
    pub order: BTreeMap<String, Vec<String>>,
    /// Folder path → saved collection (database) view configuration.
    pub views: BTreeMap<String, serde_json::Value>,
}

impl VaultState {
    pub fn file(meta_dir: &Path) -> PathBuf {
        meta_dir.join("state.json")
    }

    /// Loads the state; a missing or corrupt file yields the default state
    /// (a corrupt file is kept aside as `state.json.corrupt` for inspection).
    pub fn load(meta_dir: &Path) -> VaultState {
        let path = Self::file(meta_dir);
        match std::fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice(&bytes) {
                Ok(s) => s,
                Err(_) => {
                    let _ = std::fs::rename(&path, meta_dir.join("state.json.corrupt"));
                    VaultState::default()
                }
            },
            Err(_) => VaultState::default(),
        }
    }

    pub fn save(&self, meta_dir: &Path) -> Result<()> {
        fsio::ensure_dir(meta_dir, ".note4me")?;
        let bytes = serde_json::to_vec_pretty(self).expect("state serialises");
        fsio::atomic_write(&Self::file(meta_dir), &bytes, ".note4me/state.json")
    }

    pub fn touch_recent(&mut self, p: &RelPath) {
        self.recents.retain(|r| r != p);
        self.recents.insert(0, p.clone());
        self.recents.truncate(MAX_RECENTS);
    }

    pub fn set_favorite(&mut self, p: &RelPath, on: bool) {
        self.favorites.retain(|f| f != p);
        if on {
            self.favorites.push(p.clone());
        }
    }

    /// Keeps references valid after a rename or move.
    pub fn rebase(&mut self, from: &RelPath, to: &RelPath) {
        for list in [&mut self.favorites, &mut self.recents] {
            for p in list.iter_mut() {
                if let Some(n) = p.rebase(from, to) {
                    *p = n;
                }
            }
        }
        fn rekey<V>(map: &mut BTreeMap<String, V>, from: &RelPath, to: &RelPath) {
            let keys: Vec<String> = map.keys().cloned().collect();
            for k in keys {
                if let Ok(kp) = RelPath::parse(&k) {
                    if !kp.is_root() {
                        if let Some(n) = kp.rebase(from, to) {
                            if let Some(v) = map.remove(&k) {
                                map.insert(n.to_string(), v);
                            }
                        }
                    }
                }
            }
        }
        rekey(&mut self.order, from, to);
        rekey(&mut self.views, from, to);
        // Rename the entry inside its parent's manual order.
        if from.parent() == to.parent() {
            let parent = from.parent().map(|p| p.to_string()).unwrap_or_default();
            if let Some(names) = self.order.get_mut(&parent) {
                for n in names.iter_mut() {
                    if n == from.file_name() {
                        *n = to.file_name().to_string();
                    }
                }
            }
        }
    }

    pub fn forget(&mut self, prefix: &RelPath) {
        self.favorites.retain(|p| !p.starts_with(prefix));
        self.recents.retain(|p| !p.starts_with(prefix));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_corruption() {
        let d = tempfile::tempdir().unwrap();
        let mut s = VaultState::default();
        s.set_favorite(&RelPath::parse("A.md").unwrap(), true);
        s.save(d.path()).unwrap();
        assert_eq!(VaultState::load(d.path()), s);
        std::fs::write(VaultState::file(d.path()), b"{not json").unwrap();
        assert_eq!(VaultState::load(d.path()), VaultState::default());
        assert!(d.path().join("state.json.corrupt").exists());
    }

    #[test]
    fn rebase_updates_references() {
        let mut s = VaultState::default();
        s.set_favorite(&RelPath::parse("P/A.md").unwrap(), true);
        s.touch_recent(&RelPath::parse("P/A/sub.md").unwrap());
        s.order.insert("P".into(), vec!["A.md".into(), "B.md".into()]);
        s.order.insert("P/A".into(), vec!["sub.md".into()]);
        s.rebase(&RelPath::parse("P/A.md").unwrap(), &RelPath::parse("P/Z.md").unwrap());
        s.rebase(&RelPath::parse("P/A").unwrap(), &RelPath::parse("P/Z").unwrap());
        assert_eq!(s.favorites[0].as_str(), "P/Z.md");
        assert_eq!(s.recents[0].as_str(), "P/Z/sub.md");
        assert_eq!(s.order["P"], vec!["Z.md", "B.md"]);
        assert!(s.order.contains_key("P/Z"));
    }
}
