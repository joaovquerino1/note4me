//! Importing existing Markdown and exporting pages or whole vaults.
//!
//! Imports copy files into the vault (sources are never modified or moved).
//! Exports copy out of the vault into a new folder — they never write into an
//! existing folder's files.

use crate::error::{CoreError, Result};
use crate::fsio;
use crate::markdown::{frontmatter, links};
use crate::paths::{ensure_within, sanitize_name, unique_child, RelPath, META_DIR};
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub imported_pages: usize,
    pub imported_files: usize,
    /// Items stored under a different name to avoid overwriting.
    pub renamed: Vec<(String, String)>,
    pub warnings: Vec<String>,
    pub skipped: Vec<String>,
    pub root_items: Vec<RelPath>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReport {
    pub destination: PathBuf,
    pub pages: usize,
    pub attachments: usize,
    /// Links that point to pages not included in the export.
    pub external_links: Vec<String>,
    pub missing: Vec<String>,
}

const MAX_IMPORT_FILES: usize = 50_000;

/// Copies files and folders from outside the vault into `dest_dir`.
pub fn import(root: &Path, sources: &[PathBuf], dest_dir: &RelPath) -> Result<ImportReport> {
    let mut report = ImportReport::default();
    let dest_abs = dest_dir.to_abs(root);
    fsio::ensure_dir(&dest_abs, dest_dir.as_str())?;
    ensure_within(root, &dest_abs)?;
    let canon_root = root.canonicalize().map_err(|e| CoreError::from_io(e, "vault"))?;
    let mut budget = MAX_IMPORT_FILES;
    for src in sources {
        let canon = src.canonicalize().map_err(|e| CoreError::from_io(e, display_name(src)))?;
        if canon.starts_with(&canon_root) {
            report.skipped.push(format!("{} já está dentro do espaço de trabalho", display_name(src)));
            continue;
        }
        let item = import_item(root, &canon, dest_dir, &mut report, &mut budget)?;
        if let Some(i) = item {
            report.root_items.push(i);
        }
    }
    Ok(report)
}

fn display_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

fn import_item(root: &Path, src: &Path, dest_dir: &RelPath, report: &mut ImportReport, budget: &mut usize) -> Result<Option<RelPath>> {
    let name = display_name(src);
    if name.starts_with('.') {
        return Ok(None);
    }
    let meta = std::fs::symlink_metadata(src).map_err(|e| CoreError::from_io(e, &name))?;
    if meta.file_type().is_symlink() {
        report.skipped.push(format!("{name}: links simbólicos não são importados"));
        return Ok(None);
    }
    if *budget == 0 {
        report
            .skipped
            .push(format!("{name}: limite de {MAX_IMPORT_FILES} arquivos por importação atingido"));
        return Ok(None);
    }
    if meta.is_dir() {
        let clean = sanitize_name(&name)?;
        let target = unique_child(root, dest_dir, &clean, None)?;
        if target.file_name() != name {
            report.renamed.push((name.clone(), target.file_name().to_string()));
        }
        std::fs::create_dir(target.to_abs(root)).map_err(|e| CoreError::from_io(e, target.as_str()))?;
        let mut children: Vec<PathBuf> = std::fs::read_dir(src)
            .map_err(|e| CoreError::from_io(e, &name))?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .collect();
        children.sort();
        for c in children {
            import_item(root, &c, &target, report, budget)?;
        }
        return Ok(Some(target));
    }
    *budget -= 1;
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], Some(&name[i + 1..])),
        _ => (name.as_str(), None),
    };
    let is_md = ext.is_some_and(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown"));
    let clean = sanitize_name(stem).unwrap_or_else(|_| "importado".into());
    let target = unique_child(root, dest_dir, &clean, ext.map(|e| if is_md { "md" } else { e }))?;
    if target.file_name() != name {
        report.renamed.push((name.clone(), target.file_name().to_string()));
    }
    fsio::copy_new(src, &target.to_abs(root), target.as_str())?;
    if is_md {
        report.imported_pages += 1;
        match fsio::read_text(&target.to_abs(root), target.as_str(), None) {
            Err(_) => report.warnings.push(format!("{}: não está em UTF-8; será aberto somente para leitura", target)),
            Ok(f) => {
                if let Some(y) = frontmatter::split(&f.content).yaml {
                    if frontmatter::parse(y).is_err() {
                        report.warnings.push(format!("{}: frontmatter YAML inválido (mantido sem alterações)", target));
                    }
                }
            }
        }
    } else {
        report.imported_files += 1;
    }
    Ok(Some(target))
}

/// Exports one page (optionally with its sub-pages) into a new folder under
/// `dest_parent`, copying every local file it links to into `anexos/` and
/// rewriting those links so the export is self-contained.
pub fn export_page(root: &Path, page: &RelPath, dest_parent: &Path, include_subpages: bool) -> Result<ExportReport> {
    let folder_name = sanitize_name(page.stem())?;
    let dest = unique_dir(dest_parent, &folder_name)?;
    let mut report = ExportReport {
        destination: dest.clone(),
        ..Default::default()
    };
    let mut pages = vec![page.clone()];
    if include_subpages {
        let cdir = page.children_dir().to_abs(root);
        if cdir.is_dir() {
            for e in walkdir::WalkDir::new(&cdir).into_iter().filter_map(|e| e.ok()) {
                if e.file_type().is_file() {
                    if let Ok(rel) = RelPath::from_abs(root, e.path()) {
                        if rel.is_markdown() && !rel.is_hidden() {
                            pages.push(rel);
                        }
                    }
                }
            }
        }
    }
    let base = page.parent().unwrap_or_else(RelPath::root);
    let in_export = |p: &RelPath| pages.contains(p);
    let mut copied: Vec<(RelPath, String)> = Vec::new();
    for pg in &pages {
        let file = fsio::read_text(&pg.to_abs(root), pg.as_str(), None)?;
        let sp = frontmatter::split(&file.content);
        let out_rel = pg.rebase(&base, &RelPath::root()).unwrap_or_else(|| RelPath::parse(pg.file_name()).unwrap());
        let mut edits = Vec::new();
        for l in links::extract(sp.body) {
            if l.kind == links::LinkKind::Wiki {
                continue;
            }
            let Some(target) = links::resolve(pg, &l.dest) else { continue };
            if target.is_markdown() {
                if !in_export(&target) {
                    report.external_links.push(format!("{pg} → {}", l.dest));
                }
                continue;
            }
            let src = target.to_abs(root);
            if !src.is_file() {
                report.missing.push(format!("{pg} → {}", l.dest));
                continue;
            }
            let stored = match copied.iter().find(|(t, _)| t == &target) {
                Some((_, name)) => name.clone(),
                None => {
                    let adir = dest.join("anexos");
                    fsio::ensure_dir(&adir, "anexos")?;
                    let name = unique_file_name(&adir, target.file_name());
                    fsio::copy_new(&src, &adir.join(&name), &name)?;
                    report.attachments += 1;
                    copied.push((target.clone(), name.clone()));
                    name
                }
            };
            let depth = out_rel.components().count() - 1;
            let prefix = "../".repeat(depth);
            let (_, suffix) = links::split_suffix(&l.dest);
            let new_dest = format!("{prefix}anexos/{}{suffix}", links::encode_segment(&stored));
            edits.push((l.dest_range, new_dest));
        }
        let mut body = sp.body.to_string();
        edits.sort_by_key(|e| std::cmp::Reverse(e.0.start));
        for (r, t) in edits {
            body.replace_range(r, &t);
        }
        let content = format!("{}{}", &file.content[..sp.block_len], body);
        let out_abs = out_rel.to_abs(&dest);
        fsio::ensure_dir(out_abs.parent().unwrap(), "exportação")?;
        fsio::write_new(&out_abs, &fsio::encode_text(&content, file.format), out_rel.as_str())?;
        report.pages += 1;
    }
    Ok(report)
}

fn unique_dir(parent: &Path, name: &str) -> Result<PathBuf> {
    for n in 1..1000 {
        let candidate = if n == 1 { parent.join(name) } else { parent.join(format!("{name} {n}")) };
        if !candidate.exists() {
            std::fs::create_dir_all(&candidate).map_err(|e| CoreError::from_io(e, name))?;
            return Ok(candidate);
        }
    }
    Err(CoreError::AlreadyExists(name.to_string()))
}

fn unique_file_name(dir: &Path, name: &str) -> String {
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    let mut n = 1;
    loop {
        let candidate = if n == 1 { name.to_string() } else { format!("{stem} {n}{ext}") };
        if !dir.join(&candidate).exists() {
            return candidate;
        }
        n += 1;
    }
}

/// Copies the whole vault (without `.note4me/`) into a new folder.
pub fn export_vault(root: &Path, dest_parent: &Path) -> Result<ExportReport> {
    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "note4me".into());
    let dest = unique_dir(dest_parent, &name)?;
    let canon_dest = dest.canonicalize().map_err(|e| CoreError::from_io(e, "destino"))?;
    if canon_dest.starts_with(root.canonicalize().map_err(|e| CoreError::from_io(e, "vault"))?) {
        let _ = std::fs::remove_dir(&dest);
        return Err(CoreError::Validation("o destino não pode ficar dentro do espaço de trabalho".into()));
    }
    let mut report = ExportReport {
        destination: dest.clone(),
        ..Default::default()
    };
    let walker = walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || e.file_name() != META_DIR);
    for e in walker.filter_map(|e| e.ok()) {
        let Ok(rel) = e.path().strip_prefix(root) else { continue };
        if rel.as_os_str().is_empty() {
            continue;
        }
        let target = dest.join(rel);
        if e.file_type().is_dir() {
            fsio::ensure_dir(&target, "exportação")?;
        } else if e.file_type().is_file() {
            fsio::copy_new(e.path(), &target, &rel.display().to_string())?;
            if rel.extension().is_some_and(|x| x == "md") {
                report.pages += 1;
            } else {
                report.attachments += 1;
            }
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn imports_without_overwriting_and_reports() {
        let vault = tempfile::tempdir().unwrap();
        let ext = tempfile::tempdir().unwrap();
        fs::create_dir_all(ext.path().join("Obsidian/img")).unwrap();
        fs::write(ext.path().join("Obsidian/Nota.md"), "# Nota\n![](img/a.png)").unwrap();
        fs::write(ext.path().join("Obsidian/img/a.png"), b"png").unwrap();
        fs::write(ext.path().join("Obsidian/ruim.md"), [0xFFu8]).unwrap();
        fs::write(ext.path().join("Obsidian/.oculto"), b"x").unwrap();
        fs::write(ext.path().join("Solta.markdown"), "x").unwrap();
        fs::write(vault.path().join("Solta.md"), "existente").unwrap();
        let r = import(
            vault.path(),
            &[ext.path().join("Obsidian"), ext.path().join("Solta.markdown")],
            &RelPath::root(),
        )
        .unwrap();
        assert_eq!(r.imported_pages, 3);
        assert_eq!(r.imported_files, 1);
        assert!(vault.path().join("Obsidian/img/a.png").exists());
        assert!(!vault.path().join("Obsidian/.oculto").exists());
        assert_eq!(fs::read_to_string(vault.path().join("Solta.md")).unwrap(), "existente");
        assert!(vault.path().join("Solta 2.md").exists());
        assert!(r.warnings.iter().any(|w| w.contains("UTF-8")));
        assert!(r.renamed.iter().any(|(_, to)| to == "Solta 2.md"));
    }

    #[test]
    fn exports_page_with_attachments() {
        let vault = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        let r = vault.path();
        fs::create_dir_all(r.join("Recursos")).unwrap();
        fs::create_dir_all(r.join("Proj/A")).unwrap();
        fs::write(r.join("Recursos/foto 1.png"), b"img").unwrap();
        fs::write(
            r.join("Proj/A.md"),
            "---\nid: x\n---\n![f](../Recursos/foto%201.png) [b](B.md) [s](A/Sub.md) ![m](nao.png)\n",
        )
        .unwrap();
        fs::write(r.join("Proj/A/Sub.md"), "![f](../../Recursos/foto%201.png)\n").unwrap();
        let rep = export_page(r, &RelPath::parse("Proj/A.md").unwrap(), out.path(), true).unwrap();
        assert_eq!(rep.pages, 2);
        assert_eq!(rep.attachments, 1);
        assert_eq!(rep.external_links, vec!["Proj/A.md → B.md"]);
        assert_eq!(rep.missing.len(), 1);
        let a = fs::read_to_string(out.path().join("A/A.md")).unwrap();
        assert!(a.starts_with("---\nid: x\n---\n![f](anexos/foto%201.png) [b](B.md) [s](A/Sub.md)"));
        let sub = fs::read_to_string(out.path().join("A/A/Sub.md")).unwrap();
        assert_eq!(sub, "![f](../anexos/foto%201.png)\n");
        assert!(out.path().join("A/anexos/foto 1.png").exists());
    }

    #[test]
    fn exports_whole_vault_without_metadata() {
        let vault = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        fs::create_dir_all(vault.path().join(".note4me/history")).unwrap();
        fs::write(vault.path().join(".note4me/state.json"), "{}").unwrap();
        fs::create_dir_all(vault.path().join("P")).unwrap();
        fs::write(vault.path().join("P/A.md"), "a").unwrap();
        let rep = export_vault(vault.path(), out.path()).unwrap();
        assert_eq!(rep.pages, 1);
        assert!(rep.destination.join("P/A.md").exists());
        assert!(!rep.destination.join(".note4me").exists());
        assert!(export_vault(vault.path(), vault.path()).is_err());
    }
}
