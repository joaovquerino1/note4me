//! YAML frontmatter: reading, and surgical line-level editing.
//!
//! The app never re-emits a whole frontmatter block from a parsed model. When
//! a single property changes, only the lines belonging to that top-level key
//! are replaced; comments, key order, quoting style and unknown keys stay
//! byte-for-byte identical. Every edit is verified by re-parsing the result —
//! if the other keys would not survive unchanged, the edit is refused.

use crate::error::{CoreError, Result};
use serde_json::{Map, Value};
use yaml_rust2::{Yaml, YamlLoader};

#[derive(Debug, Clone, PartialEq)]
pub struct Split<'a> {
    /// The YAML between the delimiters (without them), if present.
    pub yaml: Option<&'a str>,
    /// Length in bytes of the whole frontmatter block including delimiters.
    pub block_len: usize,
    pub body: &'a str,
}

/// Separates the frontmatter block from the body. Only a block that starts
/// on the very first line with `---` and is closed by `---` or `...` counts.
pub fn split(content: &str) -> Split<'_> {
    let none = Split {
        yaml: None,
        block_len: 0,
        body: content,
    };
    let Some(rest) = content.strip_prefix("---\n") else {
        return none;
    };
    let mut offset = 4;
    let mut yaml_end = None;
    for line in rest.split_inclusive('\n') {
        let trimmed = line.trim_end_matches('\n').trim_end();
        if trimmed == "---" || trimmed == "..." {
            yaml_end = Some((offset, offset + line.len()));
            break;
        }
        offset += line.len();
    }
    match yaml_end {
        Some((yaml_stop, block_end)) => Split {
            yaml: Some(&content[4..yaml_stop]),
            block_len: block_end,
            body: &content[block_end..],
        },
        None => none,
    }
}

/// Parses the frontmatter into an ordered JSON object.
/// Returns `Ok(None)` when there is no frontmatter.
pub fn parse(yaml: &str) -> Result<Map<String, Value>> {
    if yaml.trim().is_empty() {
        return Ok(Map::new());
    }
    let docs = YamlLoader::load_from_str(yaml).map_err(|e| CoreError::InvalidFrontmatter(e.to_string()))?;
    match docs.into_iter().next() {
        None | Some(Yaml::Null) => Ok(Map::new()),
        Some(Yaml::Hash(h)) => {
            let mut map = Map::new();
            for (k, v) in h {
                map.insert(key_to_string(&k), yaml_to_json(&v));
            }
            Ok(map)
        }
        Some(_) => Err(CoreError::InvalidFrontmatter("o frontmatter não é um mapa de chaves e valores".into())),
    }
}

fn key_to_string(k: &Yaml) -> String {
    match k {
        Yaml::String(s) | Yaml::Real(s) => s.clone(),
        Yaml::Integer(i) => i.to_string(),
        Yaml::Boolean(b) => b.to_string(),
        _ => String::from("?"),
    }
}

fn yaml_to_json(v: &Yaml) -> Value {
    match v {
        Yaml::Real(s) => s
            .parse::<f64>()
            .ok()
            .and_then(serde_json::Number::from_f64)
            .map(Value::Number)
            .unwrap_or_else(|| Value::String(s.clone())),
        Yaml::Integer(i) => Value::from(*i),
        Yaml::String(s) => Value::String(s.clone()),
        Yaml::Boolean(b) => Value::Bool(*b),
        Yaml::Array(a) => Value::Array(a.iter().map(yaml_to_json).collect()),
        Yaml::Hash(h) => Value::Object(h.iter().map(|(k, v)| (key_to_string(k), yaml_to_json(v))).collect()),
        _ => Value::Null,
    }
}

/// Reads tags from the `tags` (or `tag`) property, accepting a list or a
/// comma/space separated string. Leading `#` is dropped.
pub fn tags_of(props: &Map<String, Value>) -> Vec<String> {
    let raw = props.get("tags").or_else(|| props.get("tag"));
    let mut tags: Vec<String> = match raw {
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(|v| match v {
                Value::String(s) => Some(s.clone()),
                Value::Number(n) => Some(n.to_string()),
                _ => None,
            })
            .collect(),
        Some(Value::String(s)) => s.split([',', ' ']).map(str::to_string).collect(),
        _ => Vec::new(),
    };
    for t in &mut tags {
        *t = t.trim().trim_start_matches('#').to_string();
    }
    tags.retain(|t| !t.is_empty());
    tags.dedup();
    tags
}

pub fn validate_key(key: &str) -> Result<()> {
    let ok = !key.is_empty()
        && key.len() <= 100
        && key.trim() == key
        && key.chars().all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | ' ' | '.'))
        && !key.starts_with('-');
    if ok {
        Ok(())
    } else {
        Err(CoreError::Validation(format!("nome de propriedade inválido: {key}")))
    }
}

/// Sets (or adds) a top-level property, returning the full new file content.
pub fn set_field(content: &str, key: &str, value: &Value) -> Result<String> {
    validate_key(key)?;
    let new_lines = render_field(key, value);
    let sp = split(content);
    let Some(yaml) = sp.yaml else {
        let body = sp.body;
        let sep = if body.starts_with('\n') || body.is_empty() { "" } else { "\n" };
        let out = format!("---\n{new_lines}---\n{sep}{body}");
        verify(&out, None, key, Some(value))?;
        return Ok(out);
    };
    let before = parse(yaml)?;
    let lines: Vec<&str> = yaml.split_inclusive('\n').collect();
    let new_yaml = match find_key_span(&lines, key) {
        Some((start, end)) => {
            let mut s: String = lines[..start].concat();
            s.push_str(&new_lines);
            s.push_str(&lines[end..].concat());
            s
        }
        None => {
            let mut s = yaml.to_string();
            if !s.is_empty() && !s.ends_with('\n') {
                s.push('\n');
            }
            s.push_str(&new_lines);
            s
        }
    };
    let out = format!("---\n{new_yaml}{}", &content[4 + yaml.len()..]);
    verify(&out, Some(&before), key, Some(value))?;
    Ok(out)
}

/// Removes a top-level property. Removing the last one drops the block.
pub fn remove_field(content: &str, key: &str) -> Result<String> {
    let sp = split(content);
    let Some(yaml) = sp.yaml else { return Ok(content.to_string()) };
    let before = parse(yaml)?;
    let lines: Vec<&str> = yaml.split_inclusive('\n').collect();
    let Some((start, end)) = find_key_span(&lines, key) else {
        return Ok(content.to_string());
    };
    let new_yaml = format!("{}{}", lines[..start].concat(), lines[end..].concat());
    let out = if new_yaml.trim().is_empty() {
        sp.body.strip_prefix('\n').unwrap_or(sp.body).to_string()
    } else {
        format!("---\n{new_yaml}{}", &content[4 + yaml.len()..])
    };
    verify(&out, Some(&before), key, None)?;
    Ok(out)
}

/// Confirms that only `key` changed and that it now holds `expected`.
fn verify(out: &str, before: Option<&Map<String, Value>>, key: &str, expected: Option<&Value>) -> Result<()> {
    let after = match split(out).yaml {
        Some(y) => parse(y)?,
        None => Map::new(),
    };
    let fail = || CoreError::Validation("a alteração do frontmatter não pôde ser aplicada com segurança".into());
    if let Some(exp) = expected {
        if !json_equivalent(after.get(key).unwrap_or(&Value::Null), exp) {
            return Err(fail());
        }
    } else if after.contains_key(key) {
        return Err(fail());
    }
    if let Some(before) = before {
        for (k, v) in before {
            if k != key && after.get(k) != Some(v) {
                return Err(fail());
            }
        }
        if after.keys().any(|k| k != key && !before.contains_key(k)) {
            return Err(fail());
        }
    }
    Ok(())
}

fn json_equivalent(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| json_equivalent(p, q)),
        _ => a == b,
    }
}

/// Locates the lines `[start, end)` that make up a top-level key.
fn find_key_span(lines: &[&str], key: &str) -> Option<(usize, usize)> {
    let start = lines.iter().position(|l| line_key(l).as_deref() == Some(key))?;
    let is_cont = |l: &str| l.starts_with(' ') || l.starts_with('\t') || l.trim_end() == "-" || l.starts_with("- ");
    let mut end = start + 1;
    while end < lines.len() {
        let l = lines[end];
        if is_cont(l) {
            end += 1;
        } else if l.trim().is_empty() {
            // Blank lines belong to the value only if more of it follows.
            let next = lines[end..].iter().position(|x| !x.trim().is_empty()).map(|i| end + i);
            match next {
                Some(n) if is_cont(lines[n]) => end = n + 1,
                _ => break,
            }
        } else {
            break;
        }
    }
    Some((start, end))
}

/// Extracts the key of a top-level `key: value` line.
fn line_key(line: &str) -> Option<String> {
    if line.starts_with([' ', '\t', '#', '-']) {
        return None;
    }
    let line = line.trim_end();
    for quote in ['"', '\''] {
        if let Some(rest) = line.strip_prefix(quote) {
            let close = rest.find(quote)?;
            let after = rest[close + 1..].trim_start();
            return after.starts_with(':').then(|| rest[..close].to_string());
        }
    }
    let colon = line.find(": ").or_else(|| line.strip_suffix(':').map(|s| s.len()))?;
    Some(line[..colon].trim_end().to_string())
}

fn render_field(key: &str, value: &Value) -> String {
    // Keys are validated to a safe character set and written plainly.
    let k = key;
    match value {
        Value::Array(items) if !items.is_empty() => {
            let mut s = format!("{k}:\n");
            for item in items {
                s.push_str(&format!("  - {}\n", scalar(item)));
            }
            s
        }
        Value::Null => format!("{k}:\n"),
        v => format!("{k}: {}\n", scalar(v)),
    }
}

fn scalar(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => {
            if needs_quotes(s) {
                serde_json::to_string(s).unwrap()
            } else {
                s.clone()
            }
        }
        // JSON is valid YAML flow syntax.
        other => serde_json::to_string(other).unwrap(),
    }
}

fn needs_quotes(s: &str) -> bool {
    if s.is_empty() || s.trim() != s {
        return true;
    }
    let first = s.chars().next().unwrap();
    if "-?:,[]{}#&*!|>'\"%@`".contains(first) {
        return true;
    }
    if s.contains(": ") || s.contains(" #") || s.ends_with(':') || s.chars().any(|c| c.is_control()) {
        return true;
    }
    let lower = s.to_ascii_lowercase();
    if matches!(lower.as_str(), "true" | "false" | "null" | "~" | "yes" | "no" | "on" | "off" | "y" | "n") {
        return true;
    }
    s.parse::<f64>().is_ok() || lower.starts_with("0x") || lower.starts_with("0o") || lower == ".inf" || lower == ".nan"
}

/// Frontmatter for a page created by the app: just a stable id and the
/// creation instant. Everything else is optional and user-controlled.
pub fn new_page_header(id: &str, created_rfc3339: &str) -> String {
    format!("---\nid: {id}\ncreated: {created_rfc3339}\n---\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const DOC: &str =
        "---\n# comentário preservado\ntitle: 'Projeto A'\ntags:\n  - projeto\n  - trabalho\nunknown_key: {a: 1, b: [x, y]}\n---\n\n# Projeto A\n\nConteúdo.\n";

    #[test]
    fn splits_frontmatter() {
        let s = split(DOC);
        assert!(s.yaml.unwrap().starts_with("# comentário"));
        assert_eq!(s.body, "\n# Projeto A\n\nConteúdo.\n");
        assert_eq!(&DOC[s.block_len..], s.body);
        assert!(split("# sem frontmatter\n---\n").yaml.is_none());
        assert!(split("---\nunterminated: true\n").yaml.is_none());
    }

    #[test]
    fn parses_props_and_tags() {
        let p = parse(split(DOC).yaml.unwrap()).unwrap();
        assert_eq!(p["title"], json!("Projeto A"));
        assert_eq!(tags_of(&p), vec!["projeto", "trabalho"]);
        assert_eq!(p["unknown_key"]["b"], json!(["x", "y"]));
        let p2 = parse("tags: \"#a, b\"").unwrap();
        assert_eq!(tags_of(&p2), vec!["a", "b"]);
    }

    #[test]
    fn invalid_yaml_is_reported() {
        assert_eq!(parse("a: [unclosed").unwrap_err().kind(), "invalidFrontmatter");
        assert!(parse("- just\n- a list").is_err());
    }

    #[test]
    fn set_field_touches_only_its_lines() {
        let out = set_field(DOC, "status", &json!("em andamento")).unwrap();
        assert!(out.starts_with("---\n# comentário preservado\ntitle: 'Projeto A'\n"));
        assert!(out.contains("unknown_key: {a: 1, b: [x, y]}\nstatus: em andamento\n---\n"));
        assert!(out.ends_with("\n# Projeto A\n\nConteúdo.\n"));

        let out = set_field(DOC, "tags", &json!(["novo"])).unwrap();
        assert!(out.contains("title: 'Projeto A'\ntags:\n  - novo\nunknown_key"));
        assert!(!out.contains("trabalho"));
    }

    #[test]
    fn set_field_creates_block_when_missing() {
        let out = set_field("# Título\n", "done", &json!(true)).unwrap();
        assert_eq!(out, "---\ndone: true\n---\n\n# Título\n");
    }

    #[test]
    fn quotes_ambiguous_strings() {
        let out = set_field("", "n", &json!("123")).unwrap();
        assert!(out.contains("n: \"123\""), "{out:?}");
        let out = set_field("", "s", &json!("a: b")).unwrap();
        assert_eq!(parse(split(&out).yaml.unwrap()).unwrap()["s"], json!("a: b"));
        let out = set_field("", "d", &json!("2026-10-10")).unwrap();
        assert!(out.contains("d: 2026-10-10\n"));
    }

    #[test]
    fn handles_unindented_sequences_and_blank_lines() {
        let doc = "---\ntags:\n- a\n\n- b\nnext: 1\n---\nbody";
        let out = set_field(doc, "tags", &json!(["c"])).unwrap();
        assert_eq!(out, "---\ntags:\n  - c\nnext: 1\n---\nbody");
    }

    #[test]
    fn refuses_to_edit_invalid_yaml() {
        let doc = "---\na: [oops\n---\nbody";
        assert!(set_field(doc, "b", &json!(1)).is_err());
    }

    #[test]
    fn remove_field_and_drop_empty_block() {
        let out = remove_field("---\na: 1\nb: 2\n---\nbody", "a").unwrap();
        assert_eq!(out, "---\nb: 2\n---\nbody");
        let out = remove_field("---\na: 1\n---\n\nbody", "a").unwrap();
        assert_eq!(out, "body");
    }

    #[test]
    fn rejects_bad_keys() {
        assert!(set_field("", "a:b", &json!(1)).is_err());
        assert!(set_field("", "", &json!(1)).is_err());
    }

    #[test]
    fn preserves_document_end_marker() {
        let doc = "---\na: 1\n...\nbody";
        let out = set_field(doc, "b", &json!(2)).unwrap();
        assert_eq!(out, "---\na: 1\nb: 2\n...\nbody");
    }
}
