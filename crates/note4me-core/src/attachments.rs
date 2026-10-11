//! Attachments: files copied into the vault and referenced with relative
//! links, so a copied folder keeps working anywhere.

use crate::error::{CoreError, Result};
use crate::fsio;
use crate::markdown::links;
use crate::paths::{sanitize_name, unique_child, RelPath};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "mode", content = "folder")]
pub enum AttachmentLocation {
    /// One vault-level folder, e.g. `Anexos/`.
    VaultFolder(String),
    /// The same folder as the page.
    SameFolder,
    /// A sub-folder next to the page, e.g. `Projetos/anexos/`.
    Subfolder(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AttachmentOptions {
    pub location: AttachmentLocation,
    pub max_bytes: u64,
}

impl Default for AttachmentOptions {
    fn default() -> Self {
        AttachmentOptions {
            location: AttachmentLocation::VaultFolder("Anexos".into()),
            max_bytes: 200 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddedAttachment {
    pub path: RelPath,
    /// Relative destination to insert in the page's Markdown.
    pub link: String,
    pub name: String,
    pub is_image: bool,
}

pub fn is_image(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".heic", ".avif", ".bmp", ".tif", ".tiff"]
        .iter()
        .any(|e| lower.ends_with(e))
}

fn target_dir(page: &RelPath, opts: &AttachmentOptions) -> Result<RelPath> {
    let page_dir = page.parent().unwrap_or_else(RelPath::root);
    match &opts.location {
        AttachmentLocation::VaultFolder(f) => RelPath::parse(f),
        AttachmentLocation::SameFolder => Ok(page_dir),
        AttachmentLocation::Subfolder(f) => page_dir.join(&sanitize_name(f)?),
    }
}

/// Splits `foto final.PNG` into a sanitised stem and extension.
fn safe_name(original: &str) -> Result<(String, Option<String>)> {
    let (stem, ext) = match original.rfind('.') {
        Some(i) if i > 0 => (&original[..i], Some(original[i + 1..].to_string())),
        _ => (original, None),
    };
    let ext = ext.filter(|e| !e.is_empty() && e.len() <= 10 && e.chars().all(|c| c.is_ascii_alphanumeric()));
    Ok((sanitize_name(stem).unwrap_or_else(|_| "anexo".into()), ext))
}

/// Copies an external file into the vault. Never overwrites: name clashes
/// get a numeric suffix.
pub fn add_from_path(root: &Path, page: &RelPath, source: &Path, opts: &AttachmentOptions) -> Result<AddedAttachment> {
    let meta = std::fs::metadata(source).map_err(|e| CoreError::from_io(e, "anexo"))?;
    if !meta.is_file() {
        return Err(CoreError::Validation("apenas arquivos podem ser anexados".into()));
    }
    if meta.len() > opts.max_bytes {
        return Err(CoreError::TooLarge(
            source.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        ));
    }
    let original = source
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| CoreError::InvalidName("anexo".into()))?;
    let (stem, ext) = safe_name(original)?;
    let dir = target_dir(page, opts)?;
    fsio::ensure_dir(&dir.to_abs(root), dir.as_str())?;
    let dest = unique_child(root, &dir, &stem, ext.as_deref())?;
    crate::paths::ensure_within(root, &dest.to_abs(root))?;
    fsio::copy_new(source, &dest.to_abs(root), dest.as_str())?;
    Ok(AddedAttachment {
        link: links::relative(page, &dest),
        name: dest.file_name().to_string(),
        is_image: is_image(dest.file_name()),
        path: dest,
    })
}

/// Stores pasted bytes (e.g. a screenshot from the clipboard).
pub fn add_bytes(root: &Path, page: &RelPath, file_name: &str, bytes: &[u8], opts: &AttachmentOptions) -> Result<AddedAttachment> {
    if bytes.len() as u64 > opts.max_bytes {
        return Err(CoreError::TooLarge(file_name.to_string()));
    }
    let (stem, ext) = safe_name(file_name)?;
    let dir = target_dir(page, opts)?;
    fsio::ensure_dir(&dir.to_abs(root), dir.as_str())?;
    let dest = unique_child(root, &dir, &stem, ext.as_deref())?;
    crate::paths::ensure_within(root, &dest.to_abs(root))?;
    fsio::write_new(&dest.to_abs(root), bytes, dest.as_str())?;
    Ok(AddedAttachment {
        link: links::relative(page, &dest),
        name: dest.file_name().to_string(),
        is_image: is_image(dest.file_name()),
        path: dest,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copies_without_overwriting() {
        let vault = tempfile::tempdir().unwrap();
        let ext = tempfile::tempdir().unwrap();
        let src = ext.path().join("foto: final.PNG");
        std::fs::write(&src, b"png").unwrap();
        let page = RelPath::parse("Projetos/A.md").unwrap();
        let opts = AttachmentOptions::default();
        let a = add_from_path(vault.path(), &page, &src, &opts).unwrap();
        assert_eq!(a.path.as_str(), "Anexos/foto- final.PNG");
        assert_eq!(a.link, "../Anexos/foto-%20final.PNG");
        assert!(a.is_image);
        let b = add_from_path(vault.path(), &page, &src, &opts).unwrap();
        assert_eq!(b.path.as_str(), "Anexos/foto- final 2.PNG");
        let sub = AttachmentOptions {
            location: AttachmentLocation::Subfolder("anexos".into()),
            ..Default::default()
        };
        let c = add_bytes(vault.path(), &page, "colado.png", b"x", &sub).unwrap();
        assert_eq!(c.path.as_str(), "Projetos/anexos/colado.png");
        assert_eq!(c.link, "anexos/colado.png");
    }

    #[test]
    fn enforces_size_limit() {
        let vault = tempfile::tempdir().unwrap();
        let opts = AttachmentOptions {
            max_bytes: 2,
            ..Default::default()
        };
        let err = add_bytes(vault.path(), &RelPath::parse("A.md").unwrap(), "x.bin", b"abc", &opts).unwrap_err();
        assert_eq!(err.kind(), "tooLarge");
    }
}
