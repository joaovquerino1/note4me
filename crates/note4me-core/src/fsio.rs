//! Low-level, integrity-focused file I/O.
//!
//! * Writes go to a temporary file in the same directory, are flushed with
//!   `fsync`, then atomically renamed over the destination. A crash leaves
//!   either the old or the new file — never a truncated one.
//! * Text is decoded strictly as UTF-8. A byte-order mark and CRLF line
//!   endings are remembered and restored on write, so opening and saving a
//!   file never changes those properties behind the user's back.

use crate::error::{CoreError, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum LineEnding {
    #[default]
    Lf,
    Crlf,
}

/// Encoding details of a text file, needed to write it back faithfully.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TextFormat {
    pub bom: bool,
    pub line_ending: LineEnding,
}

#[derive(Debug, Clone)]
pub struct TextFile {
    /// Content with the BOM removed and line endings normalised to `\n`.
    pub content: String,
    pub format: TextFormat,
    /// Hash of the raw bytes on disk; used to detect external changes.
    pub hash: String,
}

pub fn hash_bytes(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex()[..32].to_string()
}

pub fn decode_text(bytes: &[u8], label: &str) -> Result<TextFile> {
    let hash = hash_bytes(bytes);
    let (bom, body) = match bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        Some(rest) => (true, rest),
        None => (false, bytes),
    };
    let text = std::str::from_utf8(body).map_err(|_| CoreError::InvalidEncoding(label.to_string()))?;
    let crlf = text.contains("\r\n");
    let content = if crlf { text.replace("\r\n", "\n") } else { text.to_string() };
    Ok(TextFile {
        content,
        format: TextFormat {
            bom,
            line_ending: if crlf { LineEnding::Crlf } else { LineEnding::Lf },
        },
        hash,
    })
}

pub fn encode_text(content: &str, format: TextFormat) -> Vec<u8> {
    let mut out = Vec::with_capacity(content.len() + 8);
    if format.bom {
        out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    match format.line_ending {
        LineEnding::Lf => out.extend_from_slice(content.as_bytes()),
        LineEnding::Crlf => {
            // Normalise first so that "\r\n" in the input does not become "\r\r\n".
            let normal = content.replace("\r\n", "\n");
            out.extend_from_slice(normal.replace('\n', "\r\n").as_bytes());
        }
    }
    out
}

pub fn read_text(path: &Path, label: &str, max_bytes: Option<u64>) -> Result<TextFile> {
    if let Some(limit) = max_bytes {
        let meta = fs::metadata(path).map_err(|e| CoreError::from_io(e, label))?;
        if meta.len() > limit {
            return Err(CoreError::TooLarge(label.to_string()));
        }
    }
    let bytes = fs::read(path).map_err(|e| CoreError::from_io(e, label))?;
    decode_text(&bytes, label)
}

/// Atomically replaces (or creates) `path` with `bytes`.
pub fn atomic_write(path: &Path, bytes: &[u8], label: &str) -> Result<()> {
    let dir = path.parent().ok_or_else(|| CoreError::InvalidPath(label.to_string()))?;
    let existing_perms = fs::metadata(path).ok().map(|m| m.permissions());
    let mut tmp = tempfile::Builder::new()
        .prefix(".note4me-tmp-")
        .suffix(".part")
        .tempfile_in(dir)
        .map_err(|e| CoreError::from_io(e, label))?;
    tmp.write_all(bytes).map_err(|e| CoreError::from_io(e, label))?;
    tmp.as_file().sync_all().map_err(|e| CoreError::from_io(e, label))?;
    let perms = existing_perms.unwrap_or_else(default_permissions);
    let _ = fs::set_permissions(tmp.path(), perms);
    tmp.persist(path).map_err(|e| CoreError::from_io(e.error, label))?;
    // Persist the rename itself (best effort; not all file systems support it).
    if let Ok(d) = fs::File::open(dir) {
        let _ = d.sync_all();
    }
    Ok(())
}

/// Writes `bytes` to a new file, failing if it already exists. Used where an
/// overwrite would be a bug (e.g. creating a page or copying an attachment).
pub fn write_new(path: &Path, bytes: &[u8], label: &str) -> Result<()> {
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| CoreError::from_io(e, label))?;
    f.write_all(bytes).map_err(|e| CoreError::from_io(e, label))?;
    f.sync_all().map_err(|e| CoreError::from_io(e, label))?;
    Ok(())
}

#[cfg(unix)]
fn default_permissions() -> fs::Permissions {
    use std::os::unix::fs::PermissionsExt;
    fs::Permissions::from_mode(0o644)
}

#[cfg(not(unix))]
fn default_permissions() -> fs::Permissions {
    fs::metadata(".").map(|m| m.permissions()).unwrap()
}

pub fn ensure_dir(path: &Path, label: &str) -> Result<()> {
    fs::create_dir_all(path).map_err(|e| CoreError::from_io(e, label))
}

/// Copies a file without ever overwriting the destination.
pub fn copy_new(src: &Path, dst: &Path, label: &str) -> Result<()> {
    if dst.exists() {
        return Err(CoreError::AlreadyExists(label.to_string()));
    }
    fs::copy(src, dst).map(|_| ()).map_err(|e| CoreError::from_io(e, label))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_bom_and_crlf() {
        let raw = b"\xEF\xBB\xBF# T\r\n\r\nl1\r\n";
        let f = decode_text(raw, "x").unwrap();
        assert_eq!(f.content, "# T\n\nl1\n");
        assert!(f.format.bom);
        assert_eq!(f.format.line_ending, LineEnding::Crlf);
        assert_eq!(encode_text(&f.content, f.format), raw.to_vec());
    }

    #[test]
    fn rejects_invalid_utf8() {
        let err = decode_text(&[0x66, 0xFF, 0xFE], "bad.md").unwrap_err();
        assert_eq!(err.kind(), "invalidEncoding");
    }

    #[test]
    fn atomic_write_replaces_content_and_leaves_no_temp() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.md");
        atomic_write(&p, b"one", "a.md").unwrap();
        atomic_write(&p, b"two", "a.md").unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"two");
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains("note4me-tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn write_new_refuses_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.md");
        write_new(&p, b"one", "a.md").unwrap();
        assert_eq!(write_new(&p, b"two", "a.md").unwrap_err().kind(), "alreadyExists");
        assert_eq!(fs::read(&p).unwrap(), b"one");
    }

    #[test]
    fn size_limit() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("big.md");
        fs::write(&p, vec![b'a'; 2048]).unwrap();
        assert_eq!(read_text(&p, "big.md", Some(1024)).unwrap_err().kind(), "tooLarge");
    }
}
