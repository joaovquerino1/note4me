//! Local version history.
//!
//! Before a page is overwritten, the previous content is copied to
//! `.note4me/history/<key>/<unix-ms>.md` — at most once per configured
//! interval, and always before a forced overwrite or a restore. History is a
//! safety net beside the files, never a replacement for them: deleting the
//! folder deletes only old versions.

use crate::error::{CoreError, Result};
use crate::fsio;
use crate::paths::RelPath;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HistoryOptions {
    pub enabled: bool,
    pub min_interval_secs: u64,
    pub max_versions: usize,
}

impl Default for HistoryOptions {
    fn default() -> Self {
        HistoryOptions {
            enabled: true,
            min_interval_secs: 300,
            max_versions: 100,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    pub timestamp: i64,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    /// "equal" | "insert" | "delete"
    pub op: &'static str,
    pub text: String,
}

/// History is keyed by the page id when the page has one (survives renames
/// done outside the app) and by its path otherwise.
pub fn key_for(id: Option<&str>, path: &RelPath) -> String {
    let basis = match id {
        Some(id) => format!("id:{id}"),
        None => format!("path:{path}"),
    };
    blake3::hash(basis.as_bytes()).to_hex()[..24].to_string()
}

pub struct History {
    dir: PathBuf,
    pub opts: HistoryOptions,
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl History {
    pub fn new(meta_dir: &Path, opts: HistoryOptions) -> History {
        History {
            dir: meta_dir.join("history"),
            opts,
        }
    }

    fn page_dir(&self, key: &str) -> PathBuf {
        self.dir.join(key)
    }

    pub fn list(&self, key: &str) -> Vec<Version> {
        let mut out: Vec<Version> = std::fs::read_dir(self.page_dir(key))
            .into_iter()
            .flatten()
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                let name = e.file_name().to_str()?.to_string();
                let ts = name.strip_suffix(".md")?.parse::<i64>().ok()?;
                Some(Version {
                    timestamp: ts,
                    size: e.metadata().ok()?.len(),
                })
            })
            .collect();
        out.sort_by_key(|v| std::cmp::Reverse(v.timestamp));
        out
    }

    pub fn read(&self, key: &str, timestamp: i64) -> Result<String> {
        let p = self.page_dir(key).join(format!("{timestamp}.md"));
        Ok(fsio::read_text(&p, "versão", None)?.content)
    }

    /// Records `content` as a past version. With `force == false` the snapshot
    /// is skipped if the newest one is younger than the interval or identical.
    pub fn snapshot(&self, key: &str, path: &RelPath, content: &str, force: bool) -> Result<bool> {
        if !self.opts.enabled || content.is_empty() {
            return Ok(false);
        }
        let versions = self.list(key);
        let now = now_ms();
        if let Some(latest) = versions.first() {
            if !force && now - latest.timestamp < (self.opts.min_interval_secs as i64) * 1000 {
                return Ok(false);
            }
            if self.read(key, latest.timestamp).ok().as_deref() == Some(content) {
                return Ok(false);
            }
        }
        let dir = self.page_dir(key);
        fsio::ensure_dir(&dir, "histórico")?;
        let mut ts = now;
        while dir.join(format!("{ts}.md")).exists() {
            ts += 1;
        }
        fsio::write_new(&dir.join(format!("{ts}.md")), content.as_bytes(), "histórico")?;
        let meta = serde_json::json!({ "path": path.as_str() });
        let _ = fsio::atomic_write(&dir.join("page.json"), meta.to_string().as_bytes(), "histórico");
        // Prune the oldest versions.
        for old in versions.iter().skip(self.opts.max_versions.saturating_sub(1)) {
            let _ = std::fs::remove_file(dir.join(format!("{}.md", old.timestamp)));
        }
        Ok(true)
    }

    /// Moves path-keyed history after a rename (id-keyed history needs nothing).
    pub fn rekey(&self, old_key: &str, new_key: &str) -> Result<()> {
        if old_key == new_key {
            return Ok(());
        }
        let from = self.page_dir(old_key);
        let to = self.page_dir(new_key);
        if from.exists() && !to.exists() {
            std::fs::rename(&from, &to).map_err(|e| CoreError::from_io(e, "histórico"))?;
        }
        Ok(())
    }
}

pub fn diff(old: &str, new: &str) -> Vec<DiffLine> {
    let d = similar::TextDiff::from_lines(old, new);
    d.iter_all_changes()
        .map(|c| DiffLine {
            op: match c.tag() {
                similar::ChangeTag::Equal => "equal",
                similar::ChangeTag::Insert => "insert",
                similar::ChangeTag::Delete => "delete",
            },
            text: c.value().trim_end_matches('\n').to_string(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshots_throttle_and_prune() {
        let d = tempfile::tempdir().unwrap();
        let h = History::new(
            d.path(),
            HistoryOptions {
                enabled: true,
                min_interval_secs: 3600,
                max_versions: 3,
            },
        );
        let p = RelPath::parse("A.md").unwrap();
        let k = key_for(None, &p);
        assert!(h.snapshot(&k, &p, "v1", false).unwrap());
        assert!(!h.snapshot(&k, &p, "v2", false).unwrap(), "throttled");
        assert!(h.snapshot(&k, &p, "v2", true).unwrap());
        assert!(!h.snapshot(&k, &p, "v2", true).unwrap(), "identical content skipped");
        h.snapshot(&k, &p, "v3", true).unwrap();
        h.snapshot(&k, &p, "v4", true).unwrap();
        let versions = h.list(&k);
        assert_eq!(versions.len(), 3);
        assert_eq!(h.read(&k, versions[0].timestamp).unwrap(), "v4");
    }

    #[test]
    fn diffs_lines() {
        let d = diff("a\nb\nc\n", "a\nB\nc\n");
        let ops: Vec<_> = d.iter().map(|l| (l.op, l.text.as_str())).collect();
        assert_eq!(ops, vec![("equal", "a"), ("delete", "b"), ("insert", "B"), ("equal", "c")]);
    }
}
