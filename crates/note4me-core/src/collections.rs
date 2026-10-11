//! Collections: database-like views over the pages of a folder.
//!
//! The data model is deliberately plain: a *record* is a page, a *field* is a
//! frontmatter property. Any tool that reads YAML frontmatter (Obsidian,
//! static-site generators, scripts) sees the same data. Only the *view*
//! (columns, filters, sort, grouping) is app-specific; it is stored in
//! `.note4me/state.json` and losing it loses no data.

use crate::index::{fold, Index, PageEntry};
use crate::paths::RelPath;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::cmp::Ordering;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FilterOp {
    Eq,
    Neq,
    Contains,
    NotContains,
    Gt,
    Lt,
    IsEmpty,
    IsNotEmpty,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Filter {
    pub key: String,
    pub op: FilterOp,
    #[serde(default)]
    pub value: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SortKey {
    pub key: String,
    #[serde(default)]
    pub desc: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CollectionView {
    /// Visible property columns, in order. Empty = all inferred columns.
    pub columns: Vec<String>,
    pub filters: Vec<Filter>,
    pub sort: Vec<SortKey>,
    pub group_by: Option<String>,
    /// Include pages in sub-folders.
    pub recursive: bool,
    /// Properties given to records created from this view.
    pub template: Map<String, Value>,
    /// "table" or "list".
    pub layout: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PropType {
    Text,
    Number,
    Date,
    Checkbox,
    Tags,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub key: String,
    pub kind: PropType,
    /// Number of records that have this property.
    pub count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub path: RelPath,
    pub title: String,
    pub modified: i64,
    pub props: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub label: Option<String>,
    pub rows: Vec<Row>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionResult {
    pub folder: RelPath,
    pub columns: Vec<Column>,
    pub groups: Vec<Group>,
    pub total: usize,
    pub matched: usize,
}

/// Properties hidden from the inferred column list (still filterable).
const INTERNAL: [&str; 1] = ["id"];

fn is_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b[..4].iter().all(u8::is_ascii_digit)
        && b[5..7].iter().all(u8::is_ascii_digit)
        && b[8..10].iter().all(u8::is_ascii_digit)
}

fn kind_of(v: &Value) -> Option<PropType> {
    match v {
        Value::Bool(_) => Some(PropType::Checkbox),
        Value::Number(_) => Some(PropType::Number),
        Value::Array(_) => Some(PropType::Tags),
        Value::String(s) if is_date(s) => Some(PropType::Date),
        Value::String(_) => Some(PropType::Text),
        _ => None,
    }
}

fn field<'a>(p: &'a PageEntry, key: &str, scratch: &'a mut Value) -> &'a Value {
    match key {
        "title" => {
            *scratch = Value::String(p.title.clone());
            scratch
        }
        "modified" => {
            *scratch = Value::from(p.modified);
            scratch
        }
        _ => p.props.get(key).unwrap_or(&Value::Null),
    }
}

fn is_empty(v: &Value) -> bool {
    match v {
        Value::Null => true,
        Value::String(s) => s.trim().is_empty(),
        Value::Array(a) => a.is_empty(),
        _ => false,
    }
}

fn as_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(as_text).collect::<Vec<_>>().join(", "),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn compare(a: &Value, b: &Value) -> Ordering {
    match (a, b) {
        (Value::Null, Value::Null) => Ordering::Equal,
        // Empty values sort last.
        (Value::Null, _) => Ordering::Greater,
        (_, Value::Null) => Ordering::Less,
        (Value::Number(x), Value::Number(y)) => x.as_f64().partial_cmp(&y.as_f64()).unwrap_or(Ordering::Equal),
        (Value::Bool(x), Value::Bool(y)) => x.cmp(y),
        _ => crate::workspace::natural_cmp(&as_text(a), &as_text(b)),
    }
}

fn matches(v: &Value, f: &Filter) -> bool {
    let contains = |needle: &Value| -> bool {
        let n = fold(&as_text(needle));
        match v {
            Value::Array(a) => a.iter().any(|x| fold(&as_text(x)) == n || fold(&as_text(x)).contains(&n)),
            other => fold(&as_text(other)).contains(&n),
        }
    };
    let equals = |needle: &Value| -> bool {
        match (v, needle) {
            (Value::Array(a), n) => a.iter().any(|x| compare(x, n) == Ordering::Equal || fold(&as_text(x)) == fold(&as_text(n))),
            (Value::Bool(b), Value::String(s)) => b.to_string() == s.to_lowercase(),
            (Value::Number(_), Value::String(s)) => s
                .parse::<f64>()
                .ok()
                .and_then(serde_json::Number::from_f64)
                .is_some_and(|n| compare(v, &Value::Number(n)) == Ordering::Equal),
            _ => compare(v, needle) == Ordering::Equal || fold(&as_text(v)) == fold(&as_text(needle)),
        }
    };
    let numeric = |needle: &Value| -> Value {
        match (v, needle) {
            (Value::Number(_), Value::String(s)) => s
                .parse::<f64>()
                .ok()
                .and_then(serde_json::Number::from_f64)
                .map(Value::Number)
                .unwrap_or(needle.clone()),
            _ => needle.clone(),
        }
    };
    match f.op {
        FilterOp::IsEmpty => is_empty(v),
        FilterOp::IsNotEmpty => !is_empty(v),
        FilterOp::Eq => equals(&f.value),
        FilterOp::Neq => !equals(&f.value),
        FilterOp::Contains => contains(&f.value),
        FilterOp::NotContains => !contains(&f.value),
        FilterOp::Gt => !is_empty(v) && compare(v, &numeric(&f.value)) == Ordering::Greater,
        FilterOp::Lt => !is_empty(v) && compare(v, &numeric(&f.value)) == Ordering::Less,
    }
}

pub fn query(index: &Index, folder: &RelPath, view: &CollectionView) -> CollectionResult {
    let members: Vec<&PageEntry> = index
        .pages()
        .filter(|p| {
            let parent = p.path.parent().unwrap_or_else(RelPath::root);
            if view.recursive {
                p.path.starts_with(folder)
            } else {
                &parent == folder
            }
        })
        .collect();
    // Infer columns.
    let mut kinds: BTreeMap<String, (Vec<PropType>, usize, usize)> = BTreeMap::new();
    let mut first_seen = 0usize;
    for p in &members {
        for (k, v) in &p.props {
            let e = kinds.entry(k.clone()).or_insert_with(|| {
                first_seen += 1;
                (Vec::new(), 0, first_seen)
            });
            e.1 += 1;
            if let Some(t) = kind_of(v) {
                e.0.push(t);
            }
        }
    }
    let mut columns: Vec<Column> = kinds
        .iter()
        .filter(|(k, _)| !INTERNAL.contains(&k.as_str()))
        .map(|(k, (ts, count, _))| {
            let kind = if !ts.is_empty() && ts.iter().all(|t| *t == ts[0]) {
                ts[0]
            } else if ts.contains(&PropType::Tags) {
                PropType::Tags
            } else {
                PropType::Text
            };
            Column {
                key: k.clone(),
                kind,
                count: *count,
            }
        })
        .collect();
    columns.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| kinds[&a.key].2.cmp(&kinds[&b.key].2)));
    if !view.columns.is_empty() {
        let mut ordered = Vec::new();
        for key in &view.columns {
            match columns.iter().find(|c| &c.key == key) {
                Some(c) => ordered.push(c.clone()),
                None => ordered.push(Column {
                    key: key.clone(),
                    kind: PropType::Text,
                    count: 0,
                }),
            }
        }
        columns = ordered;
    }
    let total = members.len();
    let mut rows: Vec<&PageEntry> = members
        .into_iter()
        .filter(|p| {
            view.filters.iter().all(|f| {
                let mut s = Value::Null;
                matches(field(p, &f.key, &mut s), f)
            })
        })
        .collect();
    rows.sort_by(|a, b| {
        for k in &view.sort {
            let (mut sa, mut sb) = (Value::Null, Value::Null);
            let ord = compare(field(a, &k.key, &mut sa), field(b, &k.key, &mut sb));
            let ord = if k.desc { ord.reverse() } else { ord };
            if ord != Ordering::Equal {
                return ord;
            }
        }
        crate::workspace::natural_cmp(&a.title, &b.title)
    });
    let matched = rows.len();
    let to_row = |p: &PageEntry| Row {
        path: p.path.clone(),
        title: p.title.clone(),
        modified: p.modified,
        props: p.props.clone(),
    };
    let groups = match &view.group_by {
        None => vec![Group {
            label: None,
            rows: rows.iter().map(|p| to_row(p)).collect(),
        }],
        Some(key) => {
            let mut groups: Vec<Group> = Vec::new();
            for p in &rows {
                let mut s = Value::Null;
                let v = field(p, key, &mut s);
                let labels: Vec<Option<String>> = match v {
                    Value::Array(a) if !a.is_empty() => a.iter().map(|x| Some(as_text(x))).collect(),
                    v if is_empty(v) => vec![None],
                    v => vec![Some(as_text(v))],
                };
                for label in labels {
                    match groups.iter_mut().find(|g| g.label == label) {
                        Some(g) => g.rows.push(to_row(p)),
                        None => groups.push(Group { label, rows: vec![to_row(p)] }),
                    }
                }
            }
            groups.sort_by(|a, b| match (&a.label, &b.label) {
                (None, None) => Ordering::Equal,
                (None, _) => Ordering::Greater,
                (_, None) => Ordering::Less,
                (Some(x), Some(y)) => crate::workspace::natural_cmp(x, y),
            });
            groups
        }
    };
    CollectionResult {
        folder: folder.clone(),
        columns,
        groups,
        total,
        matched,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::IndexOptions;
    use serde_json::json;
    use std::fs;

    fn setup() -> (tempfile::TempDir, Index) {
        let d = tempfile::tempdir().unwrap();
        let r = d.path().join("Tarefas");
        fs::create_dir_all(r.join("Antigas")).unwrap();
        fs::write(
            r.join("Comprar.md"),
            "---\nstatus: aberta\nprioridade: 2\nprazo: 2026-10-20\nfeito: false\ntags: [casa]\n---\n",
        )
        .unwrap();
        fs::write(
            r.join("Relatório.md"),
            "---\nstatus: concluída\nprioridade: 10\nprazo: 2026-10-12\nfeito: true\ntags: [trabalho, urgente]\n---\n",
        )
        .unwrap();
        fs::write(r.join("Ligar.md"), "---\nstatus: aberta\nprioridade: 1\n---\n").unwrap();
        fs::write(r.join("Antigas/Velha.md"), "---\nstatus: arquivada\n---\n").unwrap();
        let idx = Index::build(d.path(), IndexOptions::default());
        (d, idx)
    }

    fn folder() -> RelPath {
        RelPath::parse("Tarefas").unwrap()
    }

    #[test]
    fn infers_columns_and_types() {
        let (_d, idx) = setup();
        let r = query(&idx, &folder(), &CollectionView::default());
        assert_eq!(r.total, 3);
        let kind = |k: &str| r.columns.iter().find(|c| c.key == k).unwrap().kind;
        assert_eq!(kind("status"), PropType::Text);
        assert_eq!(kind("prioridade"), PropType::Number);
        assert_eq!(kind("prazo"), PropType::Date);
        assert_eq!(kind("feito"), PropType::Checkbox);
        assert_eq!(kind("tags"), PropType::Tags);
        assert_eq!(r.columns[0].key, "status", "most common first");
    }

    #[test]
    fn filters_sorts_and_groups() {
        let (_d, idx) = setup();
        let view = CollectionView {
            filters: vec![Filter {
                key: "status".into(),
                op: FilterOp::Eq,
                value: json!("aberta"),
            }],
            sort: vec![SortKey {
                key: "prioridade".into(),
                desc: true,
            }],
            ..Default::default()
        };
        let r = query(&idx, &folder(), &view);
        let titles: Vec<_> = r.groups[0].rows.iter().map(|r| r.title.as_str()).collect();
        assert_eq!(titles, vec!["Comprar", "Ligar"]);

        let numeric = CollectionView {
            filters: vec![Filter {
                key: "prioridade".into(),
                op: FilterOp::Gt,
                value: json!("2"),
            }],
            ..Default::default()
        };
        assert_eq!(query(&idx, &folder(), &numeric).matched, 1, "10 > 2 numerically");

        let grouped = CollectionView {
            group_by: Some("tags".into()),
            ..Default::default()
        };
        let g = query(&idx, &folder(), &grouped);
        let labels: Vec<_> = g.groups.iter().map(|g| g.label.clone()).collect();
        assert_eq!(labels, vec![Some("casa".into()), Some("trabalho".into()), Some("urgente".into()), None]);

        let empty = CollectionView {
            filters: vec![Filter {
                key: "prazo".into(),
                op: FilterOp::IsEmpty,
                value: Value::Null,
            }],
            ..Default::default()
        };
        assert_eq!(query(&idx, &folder(), &empty).groups[0].rows[0].title, "Ligar");

        let rec = CollectionView {
            recursive: true,
            ..Default::default()
        };
        assert_eq!(query(&idx, &folder(), &rec).total, 4);

        let by_date = CollectionView {
            sort: vec![SortKey {
                key: "prazo".into(),
                desc: false,
            }],
            ..Default::default()
        };
        let titles: Vec<_> = query(&idx, &folder(), &by_date).groups[0].rows.iter().map(|r| r.title.clone()).collect();
        assert_eq!(titles, vec!["Relatório", "Comprar", "Ligar"], "empty dates last");
    }
}
