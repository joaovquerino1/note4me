//! Rough performance measurements on a synthetic vault.
//! Run with: cargo run --release -p note4me-core --example bench [pages]

use note4me_core::index::SearchQuery;
use note4me_core::workspace::{Workspace, WorkspaceOptions};
use note4me_core::RelPath;
use std::time::Instant;

fn main() {
    let n: usize = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(5000);
    let dir = tempfile::tempdir().unwrap();
    let words = [
        "rust",
        "markdown",
        "projeto",
        "estudo",
        "banco",
        "dados",
        "ownership",
        "índice",
        "programação",
        "tarefa",
    ];
    let t = Instant::now();
    for i in 0..n {
        let folder = dir.path().join(format!("Pasta {}", i % 50));
        std::fs::create_dir_all(&folder).unwrap();
        let mut body = format!("---\ntags: [t{}]\nstatus: s{}\n---\n# Nota {i}\n\n", i % 20, i % 5);
        for p in 0..30 {
            body.push_str(&format!(
                "Parágrafo {p} sobre {} e {} com [link](../Pasta%20{}/Nota%20{}.md).\n\n",
                words[(i + p) % 10],
                words[(i * 7 + p) % 10],
                ((i + 50) % n) % 50,
                (i + 50) % n
            ));
        }
        std::fs::write(folder.join(format!("Nota {i}.md")), body).unwrap();
    }
    println!("gerar {n} páginas: {:?}", t.elapsed());
    let t = Instant::now();
    let mut ws = Workspace::open(dir.path(), WorkspaceOptions::default()).unwrap();
    println!("abrir + indexar: {:?} ({} páginas)", t.elapsed(), ws.index.len());
    for q in ["programacao", "ownership banco", "\"sobre rust\"", "tag:t3 dados"] {
        let t = Instant::now();
        let hits = ws.index.search(&SearchQuery {
            text: q.into(),
            ..Default::default()
        });
        println!("buscar {q:?}: {:?} ({} resultados)", t.elapsed(), hits.len());
    }
    let t = Instant::now();
    let r = ws.index.quick_find("nota 42", 30);
    println!("quick find: {:?} ({} resultados)", t.elapsed(), r.len());
    let t = Instant::now();
    let entries = ws.list_dir(&RelPath::parse("Pasta 7").unwrap()).unwrap();
    println!("listar pasta com {} itens: {:?}", entries.len(), t.elapsed());
    let page = RelPath::parse("Pasta 0/Nota 0.md").unwrap();
    let doc = ws.read_page(&page).unwrap();
    let t = Instant::now();
    ws.save_page(&page, &format!("{}\nNova linha.", doc.body), Some(&doc.hash), false).unwrap();
    println!("salvar página (atômico + reindexar): {:?}", t.elapsed());
    let t = Instant::now();
    let bl = ws.index.backlinks(&page);
    println!("backlinks: {:?} ({})", t.elapsed(), bl.len());
    let t = Instant::now();
    let rep = ws.rename(&RelPath::parse("Pasta 1/Nota 1.md").unwrap(), "Nota Um").unwrap();
    println!(
        "renomear com reescrita de links: {:?} ({} links em {} páginas)",
        t.elapsed(),
        rep.links_updated,
        rep.pages_updated.len()
    );
}
