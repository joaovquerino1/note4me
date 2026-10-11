//! Links inside Markdown bodies.
//!
//! note4me writes internal links as ordinary, relative Markdown links —
//! `[Rust](../Estudos/Rust.md)` — which GitHub, VS Code, Obsidian, Typora and
//! most static-site generators understand. Wiki links (`[[Rust]]`) found in
//! imported vaults are read and kept, resolved by page name.
//!
//! Extraction uses pulldown-cmark so links inside code blocks and code spans
//! are ignored. Rewriting replaces only the destination bytes of each link.

use crate::paths::RelPath;
use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, CONTROLS};
use pulldown_cmark::{Event, LinkType, Options, Parser, Tag};
use serde::Serialize;
use std::ops::Range;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LinkKind {
    Markdown,
    Image,
    Wiki,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawLink {
    pub kind: LinkKind,
    /// Destination exactly as written (still percent-encoded).
    pub dest: String,
    /// Byte range of the destination inside the body.
    pub dest_range: Range<usize>,
    /// Byte range of the whole link (for context snippets).
    pub range: Range<usize>,
}

/// Characters escaped when writing a relative link. Spaces and parentheses
/// must be encoded for the link to parse everywhere.
const LINK_ESCAPE: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'(')
    .add(b')')
    .add(b'<')
    .add(b'>')
    .add(b'#')
    .add(b'?')
    .add(b'%')
    .add(b'[')
    .add(b']');

pub fn extract(body: &str) -> Vec<RawLink> {
    let mut out = Vec::new();
    let opts = Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS | Options::ENABLE_WIKILINKS;
    for (event, range) in Parser::new_ext(body, opts).into_offset_iter() {
        let Event::Start(tag) = event else { continue };
        let (kind, link_type, dest) = match tag {
            Tag::Link { link_type, dest_url, .. } => (LinkKind::Markdown, link_type, dest_url),
            Tag::Image { link_type, dest_url, .. } => (LinkKind::Image, link_type, dest_url),
            _ => continue,
        };
        let slice = &body[range.clone()];
        match link_type {
            LinkType::Inline => {
                if let Some(r) = inline_dest_range(slice) {
                    let abs = range.start + r.start..range.start + r.end;
                    out.push(RawLink {
                        kind,
                        dest: body[abs.clone()].to_string(),
                        dest_range: abs,
                        range: range.clone(),
                    });
                }
            }
            LinkType::WikiLink { .. } => {
                // `[[target|alias]]` — the destination is the text before `|`.
                let inner_start = range.start + slice.find("[[").map(|i| i + 2).unwrap_or(0);
                let inner = &body[inner_start..];
                let len = dest.len().min(inner.len());
                if inner.starts_with(dest.as_ref()) {
                    out.push(RawLink {
                        kind: LinkKind::Wiki,
                        dest: dest.to_string(),
                        dest_range: inner_start..inner_start + len,
                        range: range.clone(),
                    });
                }
            }
            // Reference-style links keep their destination in a definition
            // elsewhere; autolinks are always external.
            _ => {}
        }
    }
    out
}

/// Finds the destination inside `[text](dest "title")`.
fn inline_dest_range(slice: &str) -> Option<Range<usize>> {
    if !slice.ends_with(')') {
        return None;
    }
    // The destination follows the last `](` that opens a balanced `(...)`
    // reaching the end of the slice.
    let bytes = slice.as_bytes();
    let mut search_end = slice.len();
    while let Some(pos) = slice[..search_end].rfind("](") {
        let open = pos + 1;
        if closes_at_end(bytes, open) {
            let mut start = open + 1;
            while start < slice.len() && matches!(bytes[start], b' ' | b'\t' | b'\n') {
                start += 1;
            }
            if bytes.get(start) == Some(&b'<') {
                let close = slice[start..].find('>')? + start;
                return Some(start + 1..close);
            }
            let mut end = start;
            let mut depth = 0i32;
            while end < slice.len() {
                match bytes[end] {
                    b'\\' => end += 1,
                    b'(' => depth += 1,
                    b')' if depth == 0 => break,
                    b')' => depth -= 1,
                    b' ' | b'\t' | b'\n' => break,
                    _ => {}
                }
                end += 1;
            }
            return Some(start..end.min(slice.len()));
        }
        search_end = pos;
    }
    None
}

fn closes_at_end(bytes: &[u8], open: usize) -> bool {
    let mut depth = 0i32;
    let mut i = open;
    let mut in_angle = false;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 1,
            b'<' => in_angle = true,
            b'>' => in_angle = false,
            b'(' if !in_angle => depth += 1,
            b')' if !in_angle => {
                depth -= 1;
                if depth == 0 {
                    return i == bytes.len() - 1;
                }
            }
            _ => {}
        }
        i += 1;
    }
    false
}

/// A destination is local when it has no URL scheme, is not absolute and is
/// not a pure `#fragment`.
pub fn is_local(dest: &str) -> bool {
    if dest.is_empty() || dest.starts_with('#') || dest.starts_with('/') || dest.starts_with("//") {
        return false;
    }
    if let Some(colon) = dest.find(':') {
        let scheme = &dest[..colon];
        if !scheme.is_empty() && scheme.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.')) {
            return false;
        }
    }
    true
}

/// Splits `path#frag` / `path?query` into the path and the suffix to keep.
pub fn split_suffix(dest: &str) -> (&str, &str) {
    match dest.find(['#', '?']) {
        Some(i) => (&dest[..i], &dest[i..]),
        None => (dest, ""),
    }
}

/// Resolves a relative destination written in `from` (a file) to a vault path.
pub fn resolve(from: &RelPath, dest: &str) -> Option<RelPath> {
    if !is_local(dest) {
        return None;
    }
    let (path, _) = split_suffix(dest);
    let decoded = percent_decode_str(path).decode_utf8().ok()?;
    let mut parts: Vec<String> = from.parent().map(|p| p.components().map(str::to_string).collect()).unwrap_or_default();
    for seg in decoded.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            s => parts.push(s.to_string()),
        }
    }
    RelPath::parse(&parts.join("/")).ok().filter(|p| !p.is_root())
}

/// Percent-encodes one path segment for use in a link destination.
pub fn encode_segment(s: &str) -> String {
    utf8_percent_encode(s, LINK_ESCAPE).to_string()
}

/// The relative destination to write in `from` for a link to `to`.
pub fn relative(from: &RelPath, to: &RelPath) -> String {
    let parent = from.parent().unwrap_or_else(RelPath::root);
    let base: Vec<&str> = parent.components().collect();
    let target: Vec<&str> = to.components().collect();
    let common = base.iter().zip(&target).take_while(|(a, b)| a == b).count();
    let mut segs: Vec<String> = std::iter::repeat_n("..".to_string(), base.len() - common).collect();
    segs.extend(target[common..].iter().map(|s| utf8_percent_encode(s, LINK_ESCAPE).to_string()));
    segs.join("/")
}

/// Rewrites links in a body after paths changed.
///
/// * `old_self` / `new_self`: where the page containing `body` lived before
///   and lives now (equal if the page itself did not move).
/// * `map`: maps an old target path to its new path (or `None` if unchanged).
/// * `renamed_stems`: old page name → new page name, for wiki links.
///
/// Returns the new body and the number of links changed.
pub fn rewrite(
    body: &str,
    old_self: &RelPath,
    new_self: &RelPath,
    map: &dyn Fn(&RelPath) -> Option<RelPath>,
    renamed_stems: &[(String, String)],
) -> (String, usize) {
    let mut edits: Vec<(Range<usize>, String)> = Vec::new();
    for link in extract(body) {
        match link.kind {
            LinkKind::Markdown | LinkKind::Image => {
                let Some(target) = resolve(old_self, &link.dest) else { continue };
                let new_target = map(&target).unwrap_or_else(|| target.clone());
                if new_target == target && old_self == new_self {
                    continue;
                }
                let (_, suffix) = split_suffix(&link.dest);
                let new_dest = format!("{}{}", relative(new_self, &new_target), suffix);
                if new_dest != link.dest {
                    edits.push((link.dest_range, new_dest));
                }
            }
            LinkKind::Wiki => {
                let (name, suffix) = split_suffix(&link.dest);
                let name_only = name.rsplit('/').next().unwrap_or(name);
                let stem = name_only.strip_suffix(".md").unwrap_or(name_only);
                if let Some((_, new)) = renamed_stems.iter().find(|(old, _)| old.eq_ignore_ascii_case(stem)) {
                    edits.push((link.dest_range, format!("{new}{suffix}")));
                }
            }
        }
    }
    let count = edits.len();
    let mut out = body.to_string();
    edits.sort_by_key(|e| std::cmp::Reverse(e.0.start));
    for (range, text) in edits {
        out.replace_range(range, &text);
    }
    (out, count)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> RelPath {
        RelPath::parse(s).unwrap()
    }

    #[test]
    fn extracts_inline_links_and_skips_code() {
        let body = "Veja [Rust](../Estudos/Rust.md#intro) e ![img](anexos/a%20b.png \"t\").\n\n`[x](no.md)`\n\n```\n[y](no.md)\n```\n[[Banco de Dados|BD]] <https://x.y>";
        let links = extract(body);
        let dests: Vec<_> = links.iter().map(|l| (l.kind, l.dest.as_str())).collect();
        assert_eq!(
            dests,
            vec![
                (LinkKind::Markdown, "../Estudos/Rust.md#intro"),
                (LinkKind::Image, "anexos/a%20b.png"),
                (LinkKind::Wiki, "Banco de Dados")
            ]
        );
        for l in &links {
            assert_eq!(&body[l.dest_range.clone()], l.dest);
        }
    }

    #[test]
    fn handles_angle_and_paren_destinations() {
        let body = "[a](<Minha Nota.md>) [b](nota_(1).md)";
        let d: Vec<_> = extract(body).into_iter().map(|l| l.dest).collect();
        assert_eq!(d, vec!["Minha Nota.md", "nota_(1).md"]);
    }

    #[test]
    fn local_detection() {
        assert!(is_local("Nota.md"));
        assert!(is_local("../a/b.md#x"));
        assert!(!is_local("https://example.com"));
        assert!(!is_local("mailto:a@b.c"));
        assert!(!is_local("#section"));
        assert!(!is_local("/etc/passwd"));
    }

    #[test]
    fn resolves_and_relativises() {
        let from = p("Projetos/Projeto A.md");
        assert_eq!(resolve(&from, "../Estudos/Rust.md").unwrap(), p("Estudos/Rust.md"));
        assert_eq!(resolve(&from, "Projeto%20B.md#x").unwrap(), p("Projetos/Projeto B.md"));
        assert!(resolve(&from, "../../fora.md").is_none());
        assert_eq!(relative(&from, &p("Estudos/Banco de Dados.md")), "../Estudos/Banco%20de%20Dados.md");
        assert_eq!(relative(&p("Home.md"), &p("Home/Filho.md")), "Home/Filho.md");
        assert_eq!(relative(&from, &p("Projetos/Projeto A/Sub.md")), "Projeto%20A/Sub.md");
    }

    #[test]
    fn rewrites_after_target_move() {
        let body = "Link [R](../Estudos/Rust.md#t) e [ext](https://x.y) e [[Rust]].";
        let me = p("Projetos/A.md");
        let map = |t: &RelPath| t.rebase(&p("Estudos/Rust.md"), &p("Linguagens/Rust Lang.md"));
        let (out, n) = rewrite(body, &me, &me, &map, &[("Rust".into(), "Rust Lang".into())]);
        assert_eq!(out, "Link [R](../Linguagens/Rust%20Lang.md#t) e [ext](https://x.y) e [[Rust Lang]].");
        assert_eq!(n, 2);
    }

    #[test]
    fn rewrites_own_links_when_page_moves() {
        let body = "[irmão](B.md) ![i](img/x.png)";
        let (out, n) = rewrite(body, &p("Pasta/A.md"), &p("Outra/Funda/A.md"), &|_| None, &[]);
        assert_eq!(out, "[irmão](../../Pasta/B.md) ![i](../../Pasta/img/x.png)");
        assert_eq!(n, 2);
    }
}
