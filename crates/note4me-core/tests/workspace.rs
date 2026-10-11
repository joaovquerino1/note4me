//! Integration tests for vault operations and the Markdown integrity rules.

use note4me_core::index::SearchQuery;
use note4me_core::workspace::{EntryKind, SaveOutcome, Workspace, WorkspaceOptions};
use note4me_core::RelPath;
use std::fs;
use std::path::Path;

fn p(s: &str) -> RelPath {
    RelPath::parse(s).unwrap()
}

fn open(dir: &Path) -> Workspace {
    Workspace::open(dir, WorkspaceOptions::default()).unwrap()
}

fn hash_of(ws: &Workspace, rel: &str) -> String {
    ws.read_page(&p(rel)).unwrap().hash
}

fn saved_hash(o: SaveOutcome) -> String {
    match o {
        SaveOutcome::Saved { hash, .. } | SaveOutcome::Unchanged { hash } => hash,
        other => panic!("expected save, got {other:?}"),
    }
}

#[test]
fn create_page_writes_a_real_markdown_file() {
    let d = tempfile::tempdir().unwrap();
    let mut ws = open(d.path());
    let rel = ws.create_page(&RelPath::root(), "Projeto A", "# Projeto A\n\nConteúdo.\n").unwrap();
    assert_eq!(rel.as_str(), "Projeto A.md");
    let on_disk = fs::read_to_string(d.path().join("Projeto A.md")).unwrap();
    assert!(on_disk.starts_with("---\nid: "));
    assert!(on_disk.ends_with("\n# Projeto A\n\nConteúdo.\n"));
    // A second page with the same title gets a distinct name.
    let rel2 = ws.create_page(&RelPath::root(), "Projeto A", "").unwrap();
    assert_eq!(rel2.as_str(), "Projeto A 2.md");
}

#[test]
fn subpages_live_in_folder_beside_the_page() {
    let d = tempfile::tempdir().unwrap();
    let mut ws = open(d.path());
    let parent = ws.create_page(&RelPath::root(), "Projetos", "").unwrap();
    let child = ws.create_page(&parent, "Projeto B", "").unwrap();
    assert_eq!(child.as_str(), "Projetos/Projeto B.md");
    let root = ws.list_dir(&RelPath::root()).unwrap();
    assert_eq!(root.len(), 1, "the children folder is merged into its page");
    assert_eq!(root[0].kind, EntryKind::Page);
    assert!(root[0].has_children);
    let kids = ws.list_dir(root[0].children_dir.as_ref().unwrap()).unwrap();
    assert_eq!(kids[0].name, "Projeto B");
}

#[test]
fn save_preserves_frontmatter_bom_and_crlf() {
    let d = tempfile::tempdir().unwrap();
    let original = b"\xEF\xBB\xBF---\r\ncustom: {keep: me}\r\n# comment\r\n---\r\n# T\r\n\r\nold\r\n";
    fs::write(d.path().join("Nota.md"), original).unwrap();
    let mut ws = open(d.path());
    let doc = ws.read_page(&p("Nota.md")).unwrap();
    assert_eq!(doc.body, "# T\n\nold\n");
    assert_eq!(doc.properties["custom"]["keep"], "me");
    ws.save_page(&p("Nota.md"), "# T\n\nnew\n", Some(&doc.hash), false).unwrap();
    let bytes = fs::read(d.path().join("Nota.md")).unwrap();
    assert_eq!(
        bytes,
        b"\xEF\xBB\xBF---\r\ncustom: {keep: me}\r\n# comment\r\n---\r\n# T\r\n\r\nnew\r\n".to_vec()
    );
}

#[test]
fn reopen_without_changes_is_byte_identical() {
    let d = tempfile::tempdir().unwrap();
    let original = "---\nz: 1\na: [b, c]\n---\n\nTexto *qualquer*  \ncom quebra.\n";
    fs::write(d.path().join("A.md"), original).unwrap();
    let mut ws = open(d.path());
    let doc = ws.read_page(&p("A.md")).unwrap();
    let out = ws.save_page(&p("A.md"), &doc.body, Some(&doc.hash), false).unwrap();
    assert!(matches!(out, SaveOutcome::Unchanged { .. }));
    assert_eq!(fs::read_to_string(d.path().join("A.md")).unwrap(), original);
}

#[test]
fn external_edit_is_detected_and_never_silently_overwritten() {
    let d = tempfile::tempdir().unwrap();
    fs::write(d.path().join("A.md"), "v1\n").unwrap();
    let mut ws = open(d.path());
    let base = hash_of(&ws, "A.md");
    // Another editor changes the file.
    fs::write(d.path().join("A.md"), "edited elsewhere\n").unwrap();
    let changed = ws.apply_fs_events(&[d.path().canonicalize().unwrap().join("A.md")]);
    assert_eq!(changed, vec![p("A.md")]);
    let out = ws.save_page(&p("A.md"), "my edit\n", Some(&base), false).unwrap();
    match out {
        SaveOutcome::Conflict { disk_body, deleted, .. } => {
            assert_eq!(disk_body.as_deref(), Some("edited elsewhere\n"));
            assert!(!deleted);
        }
        other => panic!("expected conflict, got {other:?}"),
    }
    assert_eq!(fs::read_to_string(d.path().join("A.md")).unwrap(), "edited elsewhere\n");
    // Forcing keeps the external version in history.
    ws.save_page(&p("A.md"), "my edit\n", Some(&base), true).unwrap();
    assert_eq!(fs::read_to_string(d.path().join("A.md")).unwrap(), "my edit\n");
    let versions = ws.versions(&p("A.md"));
    assert_eq!(ws.version_content(&p("A.md"), versions[0].timestamp).unwrap(), "edited elsewhere\n");
}

#[test]
fn deleted_on_disk_is_a_conflict() {
    let d = tempfile::tempdir().unwrap();
    fs::write(d.path().join("A.md"), "v1").unwrap();
    let mut ws = open(d.path());
    let base = hash_of(&ws, "A.md");
    fs::remove_file(d.path().join("A.md")).unwrap();
    let out = ws.save_page(&p("A.md"), "x", Some(&base), false).unwrap();
    assert!(matches!(out, SaveOutcome::Conflict { deleted: true, .. }));
    assert!(!d.path().join("A.md").exists());
}

#[test]
fn conflict_copy_keeps_both_versions() {
    let d = tempfile::tempdir().unwrap();
    fs::write(d.path().join("A.md"), "disk").unwrap();
    let mut ws = open(d.path());
    let copy = ws.save_as_copy(&p("A.md"), "mine", "conflito").unwrap();
    assert_eq!(copy.as_str(), "A (conflito).md");
    assert_eq!(fs::read_to_string(d.path().join("A.md")).unwrap(), "disk");
    assert_eq!(fs::read_to_string(d.path().join("A (conflito).md")).unwrap(), "mine");
}

#[test]
fn rename_updates_links_everywhere() {
    let d = tempfile::tempdir().unwrap();
    let r = d.path();
    fs::create_dir_all(r.join("Estudos/Rust")).unwrap();
    fs::write(r.join("Estudos/Rust.md"), "Veja [sub](Rust/Ownership.md).\n").unwrap();
    fs::write(r.join("Estudos/Rust/Ownership.md"), "Volta: [pai](../Rust.md)\n").unwrap();
    fs::write(r.join("Home.md"), "[Rust](Estudos/Rust.md#topo) [[Rust]] [ext](https://rust-lang.org)\n").unwrap();
    let mut ws = open(r);
    let report = ws.rename(&p("Estudos/Rust.md"), "Rust Lang").unwrap();
    assert_eq!(report.path.as_ref().unwrap().as_str(), "Estudos/Rust Lang.md");
    assert!(r.join("Estudos/Rust Lang/Ownership.md").exists(), "children folder renamed too");
    assert_eq!(
        fs::read_to_string(r.join("Home.md")).unwrap(),
        "[Rust](Estudos/Rust%20Lang.md#topo) [[Rust Lang]] [ext](https://rust-lang.org)\n"
    );
    assert_eq!(
        fs::read_to_string(r.join("Estudos/Rust Lang.md")).unwrap(),
        "Veja [sub](Rust%20Lang/Ownership.md).\n"
    );
    assert_eq!(
        fs::read_to_string(r.join("Estudos/Rust Lang/Ownership.md")).unwrap(),
        "Volta: [pai](../Rust%20Lang.md)\n"
    );
    assert!(ws.index.broken_links(None).is_empty());
    assert_eq!(ws.index.backlinks(&p("Estudos/Rust Lang.md")).len(), 2);
}

#[test]
fn move_rewrites_relative_links_of_moved_page() {
    let d = tempfile::tempdir().unwrap();
    let r = d.path();
    fs::create_dir_all(r.join("Anexos")).unwrap();
    fs::write(r.join("Anexos/x.png"), b"png").unwrap();
    fs::write(r.join("A.md"), "![i](Anexos/x.png) [b](B.md)\n").unwrap();
    fs::write(r.join("B.md"), "[a](A.md)\n").unwrap();
    fs::create_dir_all(r.join("Pasta")).unwrap();
    let mut ws = open(r);
    let report = ws.move_to(&p("A.md"), &p("Pasta")).unwrap();
    assert_eq!(report.path.unwrap().as_str(), "Pasta/A.md");
    assert_eq!(fs::read_to_string(r.join("Pasta/A.md")).unwrap(), "![i](../Anexos/x.png) [b](../B.md)\n");
    assert_eq!(fs::read_to_string(r.join("B.md")).unwrap(), "[a](Pasta/A.md)\n");
    assert!(ws.index.broken_links(None).is_empty());
}

#[test]
fn cannot_move_into_itself_or_overwrite() {
    let d = tempfile::tempdir().unwrap();
    let mut ws = open(d.path());
    let a = ws.create_page(&RelPath::root(), "A", "").unwrap();
    let child = ws.create_page(&a, "Filho", "").unwrap();
    assert!(ws.move_to(&a, &child).is_err());
    ws.create_page(&RelPath::root(), "B", "").unwrap();
    let err = ws.rename(&a, "B").unwrap_err();
    assert_eq!(err.kind(), "alreadyExists");
    assert!(d.path().join("A.md").exists());
}

#[test]
fn delete_and_restore_from_trash() {
    let d = tempfile::tempdir().unwrap();
    let mut ws = open(d.path());
    let a = ws.create_page(&RelPath::root(), "A", "conteúdo").unwrap();
    ws.create_page(&a, "Filho", "").unwrap();
    let entry = ws.delete(&a).unwrap();
    assert!(!d.path().join("A.md").exists());
    assert!(!d.path().join("A").exists());
    assert!(ws.index.page(&a).is_none());
    assert_eq!(ws.trash_list().len(), 1);
    // Something new now occupies the old name.
    ws.create_page(&RelPath::root(), "A", "novo").unwrap();
    let restored = ws.trash_restore(&entry.id).unwrap();
    assert_eq!(restored.as_str(), "A (restaurado).md");
    assert!(d.path().join("A (restaurado)/Filho.md").exists());
    assert!(fs::read_to_string(d.path().join("A (restaurado).md")).unwrap().ends_with("conteúdo"));
    assert!(ws.trash_list().is_empty());
}

#[test]
fn deleting_the_index_or_metadata_never_loses_content() {
    let d = tempfile::tempdir().unwrap();
    {
        let mut ws = open(d.path());
        let a = ws.create_page(&RelPath::root(), "A", "palavra-chave").unwrap();
        ws.state.set_favorite(&a, true);
        ws.save_state().unwrap();
        let h = hash_of(&ws, "A.md");
        ws.save_page(&a, "palavra-chave atualizada", Some(&h), false).unwrap();
    }
    fs::remove_dir_all(d.path().join(".note4me")).unwrap();
    let ws = open(d.path());
    let hits = ws.index.search(&SearchQuery {
        text: "atualizada".into(),
        ..Default::default()
    });
    assert_eq!(hits.len(), 1);
    assert!(fs::read_to_string(d.path().join("A.md")).unwrap().ends_with("palavra-chave atualizada"));
}

#[test]
fn invalid_files_do_not_affect_others() {
    let d = tempfile::tempdir().unwrap();
    fs::write(d.path().join("ruim.md"), [0xC3u8, 0x28]).unwrap();
    fs::write(d.path().join("yaml ruim.md"), "---\na: [x\n---\ncorpo legível\n").unwrap();
    fs::write(d.path().join("boa.md"), "ok").unwrap();
    let ws = open(d.path());
    assert_eq!(ws.read_page(&p("ruim.md")).unwrap_err().kind(), "invalidEncoding");
    let y = ws.read_page(&p("yaml ruim.md")).unwrap();
    assert!(y.frontmatter_error.is_some());
    assert_eq!(y.body, "corpo legível\n");
    assert_eq!(ws.read_page(&p("boa.md")).unwrap().body, "ok");
}

#[test]
fn saving_a_page_with_invalid_frontmatter_keeps_it_verbatim() {
    let d = tempfile::tempdir().unwrap();
    let original = "---\na: [x\n---\ncorpo\n";
    fs::write(d.path().join("y.md"), original).unwrap();
    let mut ws = open(d.path());
    let doc = ws.read_page(&p("y.md")).unwrap();
    ws.save_page(&p("y.md"), "corpo novo\n", Some(&doc.hash), false).unwrap();
    assert_eq!(fs::read_to_string(d.path().join("y.md")).unwrap(), "---\na: [x\n---\ncorpo novo\n");
    assert!(ws.set_property(&p("y.md"), "b", Some(&serde_json::json!(1)), None).is_err());
}

#[test]
fn properties_edit_is_surgical() {
    let d = tempfile::tempdir().unwrap();
    fs::write(d.path().join("A.md"), "---\n# nota\nstatus: rascunho\nextra: 'x'\n---\ncorpo\n").unwrap();
    let mut ws = open(d.path());
    let h = hash_of(&ws, "A.md");
    let h2 = saved_hash(ws.set_property(&p("A.md"), "status", Some(&serde_json::json!("pronto")), Some(&h)).unwrap());
    assert_eq!(
        fs::read_to_string(d.path().join("A.md")).unwrap(),
        "---\n# nota\nstatus: pronto\nextra: 'x'\n---\ncorpo\n"
    );
    // A stale hash is rejected.
    assert!(matches!(
        ws.set_property(&p("A.md"), "status", None, Some(&h)).unwrap(),
        SaveOutcome::Conflict { .. }
    ));
    ws.set_property(&p("A.md"), "status", None, Some(&h2)).unwrap();
    assert_eq!(fs::read_to_string(d.path().join("A.md")).unwrap(), "---\n# nota\nextra: 'x'\n---\ncorpo\n");
}

#[test]
fn rejects_paths_outside_vault() {
    let d = tempfile::tempdir().unwrap();
    let ws = open(d.path());
    assert!(RelPath::parse("../x.md").is_err());
    assert_eq!(ws.read_page(&p(".note4me/state.json")).unwrap_err().kind(), "invalidPath");
}

#[test]
fn history_restore_snapshots_current_first() {
    let d = tempfile::tempdir().unwrap();
    let mut opts = WorkspaceOptions::default();
    opts.history.min_interval_secs = 0;
    let mut ws = Workspace::open(d.path(), opts).unwrap();
    let a = ws.create_page(&RelPath::root(), "A", "v1").unwrap();
    let h = hash_of(&ws, "A.md");
    let h = saved_hash(ws.save_page(&a, "v2", Some(&h), false).unwrap());
    std::thread::sleep(std::time::Duration::from_millis(5));
    ws.save_page(&a, "v3", Some(&h), false).unwrap();
    let versions = ws.versions(&a);
    assert_eq!(versions.len(), 2);
    let oldest = versions.last().unwrap().timestamp;
    assert!(ws.version_content(&a, oldest).unwrap().ends_with("v1"));
    ws.restore_version(&a, oldest).unwrap();
    assert!(fs::read_to_string(d.path().join("A.md")).unwrap().ends_with("v1"));
    assert!(ws.versions(&a).iter().any(|v| ws.version_content(&a, v.timestamp).unwrap().ends_with("v3")));
}

#[test]
fn drafts_are_offered_after_failed_save() {
    let d = tempfile::tempdir().unwrap();
    let mut ws = open(d.path());
    let a = ws.create_page(&RelPath::root(), "A", "disk").unwrap();
    ws.stash_draft(&a, "unsaved work", None).unwrap();
    let doc = ws.read_page(&a).unwrap();
    assert_eq!(doc.draft.unwrap().body, "unsaved work");
    ws.save_page(&a, "unsaved work", Some(&doc.hash), false).unwrap();
    assert!(ws.read_page(&a).unwrap().draft.is_none());
}

#[test]
fn duplicate_gets_new_id() {
    let d = tempfile::tempdir().unwrap();
    let mut ws = open(d.path());
    let a = ws.create_page(&RelPath::root(), "A", "x").unwrap();
    let b = ws.duplicate(&a).unwrap();
    assert_eq!(b.as_str(), "A (cópia).md");
    let ida = ws.read_page(&a).unwrap().properties["id"].clone();
    let idb = ws.read_page(&b).unwrap().properties["id"].clone();
    assert_ne!(ida, idb);
}

#[test]
fn manual_order_and_natural_sort() {
    let d = tempfile::tempdir().unwrap();
    for n in ["Nota 10", "Nota 2", "Ábaco", "zeta"] {
        fs::write(d.path().join(format!("{n}.md")), "").unwrap();
    }
    let mut ws = open(d.path());
    let names: Vec<String> = ws.list_dir(&RelPath::root()).unwrap().into_iter().map(|e| e.name).collect();
    assert_eq!(names, vec!["Ábaco", "Nota 2", "Nota 10", "zeta"]);
    ws.reorder(&RelPath::root(), vec!["zeta.md".into()]).unwrap();
    let names: Vec<String> = ws.list_dir(&RelPath::root()).unwrap().into_iter().map(|e| e.name).collect();
    assert_eq!(names[0], "zeta");
}
