//! Colour themes: built-in palettes, validation and the import/export format.
//!
//! Themes are presentation only; they live in the app's configuration
//! directory and never touch a vault.

use crate::error::{CoreError, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const FORMAT: &str = "note4me-theme";
pub const FORMAT_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Light,
    Dark,
}

/// Every colour token a theme must define, with its purpose.
pub const TOKENS: [(&str, &str); 22] = [
    ("bg", "Fundo da área de conteúdo"),
    ("surface", "Barra lateral e painéis"),
    ("raised", "Menus, diálogos e popovers"),
    ("hover", "Fundo ao passar o cursor"),
    ("active", "Item selecionado"),
    ("border", "Bordas discretas"),
    ("borderStrong", "Bordas de campos e separadores fortes"),
    ("text", "Texto principal"),
    ("textSecondary", "Texto secundário"),
    ("textMuted", "Metadados e marcadores"),
    ("accent", "Botões principais"),
    ("accentText", "Texto sobre a cor de destaque"),
    ("link", "Links"),
    ("focus", "Anel de foco"),
    ("selection", "Seleção de texto"),
    ("codeBg", "Fundo de código"),
    ("codeText", "Texto de código"),
    ("danger", "Erros e ações destrutivas"),
    ("warning", "Alertas"),
    ("success", "Confirmações"),
    ("highlight", "Marca-texto"),
    ("shadow", "Sombra de elementos flutuantes"),
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Theme {
    #[serde(default = "format_name")]
    pub format: String,
    #[serde(default = "format_version")]
    pub version: u32,
    pub id: String,
    pub name: String,
    pub mode: Mode,
    #[serde(default)]
    pub high_contrast: bool,
    #[serde(default)]
    pub builtin: bool,
    pub colors: BTreeMap<String, String>,
}

fn format_name() -> String {
    FORMAT.into()
}

fn format_version() -> u32 {
    FORMAT_VERSION
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContrastCheck {
    pub pair: String,
    pub ratio: f64,
    pub required: f64,
    pub ok: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ThemeReport {
    pub errors: Vec<String>,
    pub checks: Vec<ContrastCheck>,
}

impl ThemeReport {
    pub fn passes(&self) -> bool {
        self.errors.is_empty() && self.checks.iter().all(|c| c.ok)
    }
}

/// Parses `#rgb`, `#rrggbb` or `#rrggbbaa`.
pub fn parse_color(s: &str) -> Option<[f64; 4]> {
    let hex = s.strip_prefix('#')?;
    if !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let ch = |i: usize, len: usize| {
        u8::from_str_radix(&hex[i..i + len], 16)
            .ok()
            .map(|v| if len == 1 { (v * 17) as f64 } else { v as f64 })
    };
    let (r, g, b, a) = match hex.len() {
        3 => (ch(0, 1)?, ch(1, 1)?, ch(2, 1)?, 255.0),
        6 => (ch(0, 2)?, ch(2, 2)?, ch(4, 2)?, 255.0),
        8 => (ch(0, 2)?, ch(2, 2)?, ch(4, 2)?, ch(6, 2)?),
        _ => return None,
    };
    Some([r, g, b, a / 255.0])
}

fn luminance(c: [f64; 4]) -> f64 {
    let lin = |v: f64| {
        let s = v / 255.0;
        if s <= 0.03928 {
            s / 12.92
        } else {
            ((s + 0.055) / 1.055).powf(2.4)
        }
    };
    0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2])
}

/// Composites `fg` (possibly translucent) over an opaque `bg`.
fn over(fg: [f64; 4], bg: [f64; 4]) -> [f64; 4] {
    let a = fg[3];
    [fg[0] * a + bg[0] * (1.0 - a), fg[1] * a + bg[1] * (1.0 - a), fg[2] * a + bg[2] * (1.0 - a), 1.0]
}

/// WCAG 2.x contrast ratio.
pub fn contrast(fg: &str, bg: &str) -> Option<f64> {
    let b = parse_color(bg)?;
    let f = over(parse_color(fg)?, b);
    let (l1, l2) = (luminance(f), luminance(b));
    let (hi, lo) = if l1 > l2 { (l1, l2) } else { (l2, l1) };
    Some(((hi + 0.05) / (lo + 0.05) * 100.0).round() / 100.0)
}

pub fn validate(theme: &Theme) -> ThemeReport {
    let mut r = ThemeReport::default();
    if theme.format != FORMAT {
        r.errors.push(format!("formato desconhecido: {}", theme.format));
    }
    if theme.version != FORMAT_VERSION {
        r.errors.push(format!("versão de formato não suportada: {}", theme.version));
    }
    if theme.id.is_empty() || theme.id.len() > 48 || !theme.id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
        r.errors
            .push("o identificador deve ter de 1 a 48 caracteres: letras minúsculas, números e hífens".into());
    }
    if theme.name.trim().is_empty() || theme.name.chars().count() > 60 || theme.name.chars().any(char::is_control) {
        r.errors.push("o nome deve ter de 1 a 60 caracteres".into());
    }
    for (key, _) in TOKENS {
        match theme.colors.get(key) {
            None => r.errors.push(format!("cor ausente: {key}")),
            Some(v) if parse_color(v).is_none() => r.errors.push(format!("cor inválida em {key}: use #rgb, #rrggbb ou #rrggbbaa")),
            _ => {}
        }
    }
    for key in theme.colors.keys() {
        if !TOKENS.iter().any(|(k, _)| k == key) {
            r.errors.push(format!("chave desconhecida: {key}"));
        }
    }
    if !r.errors.is_empty() {
        return r;
    }
    let hc = theme.high_contrast;
    let text_req = if hc { 7.0 } else { 4.5 };
    let pairs: [(&str, &str, f64); 11] = [
        ("text", "bg", text_req),
        ("text", "surface", text_req),
        ("textSecondary", "bg", text_req),
        ("textSecondary", "surface", if hc { 7.0 } else { 4.5 }),
        ("textMuted", "bg", if hc { 4.5 } else { 3.0 }),
        ("link", "bg", text_req),
        ("accentText", "accent", 4.5),
        ("codeText", "codeBg", text_req),
        ("danger", "bg", 4.5),
        ("focus", "bg", 3.0),
        ("text", "raised", text_req),
    ];
    for (fg, bg, req) in pairs {
        let ratio = contrast(&theme.colors[fg], &theme.colors[bg]).unwrap_or(0.0);
        r.checks.push(ContrastCheck {
            pair: format!("{fg} / {bg}"),
            ratio,
            required: req,
            ok: ratio >= req,
        });
    }
    r
}

/// Parses and validates an imported theme. Built-in ids cannot be replaced.
pub fn import(json: &str) -> Result<(Theme, ThemeReport)> {
    if json.len() > 64 * 1024 {
        return Err(CoreError::TooLarge("tema".into()));
    }
    let mut theme: Theme = serde_json::from_str(json).map_err(|e| CoreError::Validation(format!("JSON de tema inválido: {e}")))?;
    theme.builtin = false;
    if builtins().iter().any(|b| b.id == theme.id) {
        return Err(CoreError::Validation("este identificador pertence a um tema embutido".into()));
    }
    let report = validate(&theme);
    if !report.errors.is_empty() {
        return Err(CoreError::Validation(report.errors.join("; ")));
    }
    Ok((theme, report))
}

pub fn export(theme: &Theme) -> String {
    let mut t = theme.clone();
    t.builtin = false;
    serde_json::to_string_pretty(&t).unwrap()
}

#[allow(clippy::too_many_arguments)]
fn t(id: &str, name: &str, mode: Mode, hc: bool, c: [&str; 22]) -> Theme {
    let colors = TOKENS.iter().zip(c).map(|((k, _), v)| (k.to_string(), v.to_string())).collect();
    Theme {
        format: FORMAT.into(),
        version: FORMAT_VERSION,
        id: id.into(),
        name: name.into(),
        mode,
        high_contrast: hc,
        builtin: true,
        colors,
    }
}

/// The twelve built-in themes. Order of values follows [`TOKENS`].
pub fn builtins() -> Vec<Theme> {
    use Mode::*;
    vec![
        //                                   bg         surface    raised     hover      active     border     borderStrong text       textSec    textMuted  accent     accentText link       focus      selection    codeBg     codeText   danger     warning    success    highlight  shadow
        t(
            "light-classic",
            "Light Classic",
            Light,
            false,
            [
                "#ffffff",
                "#f7f7f5",
                "#ffffff",
                "#ecebe8",
                "#e2e1dc",
                "#e7e6e2",
                "#cfcdc7",
                "#1f1f1d",
                "#5b5a56",
                "#85847f",
                "#2f6bd6",
                "#ffffff",
                "#1d5bc4",
                "#2f6bd6",
                "#2f6bd633",
                "#f3f3f1",
                "#37352f",
                "#c42b1c",
                "#8f5a00",
                "#23784a",
                "#fff1a8",
                "#0000001a",
            ],
        ),
        t(
            "warm-paper",
            "Warm Paper",
            Light,
            false,
            [
                "#f8f3e9",
                "#efe7d7",
                "#fbf8f1",
                "#e6dcc8",
                "#dccfb6",
                "#e1d6c1",
                "#c7b89b",
                "#2e2a24",
                "#615848",
                "#8a7f6c",
                "#98461a",
                "#ffffff",
                "#87390f",
                "#b05c27",
                "#c9732f38",
                "#eee5d2",
                "#463b2c",
                "#a92e1c",
                "#835400",
                "#3c6a28",
                "#f4d97e",
                "#3b2a1422",
            ],
        ),
        t(
            "soft-gray",
            "Soft Gray",
            Light,
            false,
            [
                "#eef0f2",
                "#e3e6ea",
                "#f6f7f8",
                "#d8dce1",
                "#ccd2d9",
                "#d4d9de",
                "#b3bbc4",
                "#22262b",
                "#4f5760",
                "#737c87",
                "#47607a",
                "#ffffff",
                "#2b5785",
                "#47729e",
                "#47729e38",
                "#e0e4e8",
                "#2c333c",
                "#ad241c",
                "#835800",
                "#2b6644",
                "#efe09a",
                "#1c2a3a22",
            ],
        ),
        t(
            "ivory",
            "Ivory",
            Light,
            false,
            [
                "#fffdf5",
                "#f6f2e3",
                "#fffef9",
                "#eee8d3",
                "#e4dcc2",
                "#ebe4ce",
                "#d0c5a3",
                "#26241b",
                "#5a5643",
                "#86806a",
                "#56672b",
                "#ffffff",
                "#47591b",
                "#6c862c",
                "#a8b46a4d",
                "#f4efdc",
                "#3b382a",
                "#a5301d",
                "#855800",
                "#3d6820",
                "#f0dd86",
                "#3a331622",
            ],
        ),
        t(
            "high-contrast-light",
            "High Contrast Light",
            Light,
            true,
            [
                "#ffffff",
                "#ffffff",
                "#ffffff",
                "#e6e6e6",
                "#cccccc",
                "#000000",
                "#000000",
                "#000000",
                "#1a1a1a",
                "#3b3b3b",
                "#0037a3",
                "#ffffff",
                "#00309a",
                "#0037a3",
                "#ffd40080",
                "#efefef",
                "#000000",
                "#9e0000",
                "#5e3c00",
                "#00561d",
                "#ffe600",
                "#00000040",
            ],
        ),
        t(
            "minimal-white",
            "Minimal White",
            Light,
            false,
            [
                "#ffffff",
                "#ffffff",
                "#ffffff",
                "#f3f3f3",
                "#ebebeb",
                "#eeeeee",
                "#d9d9d9",
                "#111111",
                "#555555",
                "#858585",
                "#111111",
                "#ffffff",
                "#1a5fb4",
                "#111111",
                "#0000001c",
                "#f6f6f6",
                "#222222",
                "#bb1b26",
                "#8a5a00",
                "#24704b",
                "#fff2ad",
                "#00000014",
            ],
        ),
        t(
            "dark-classic",
            "Dark Classic",
            Dark,
            false,
            [
                "#1e1e1f",
                "#252526",
                "#2c2c2e",
                "#313133",
                "#3a3a3d",
                "#333335",
                "#4a4a4d",
                "#e6e6e3",
                "#aaaaa5",
                "#80807b",
                "#4c8dff",
                "#0a0f1a",
                "#73a9ff",
                "#73a9ff",
                "#4c8dff4d",
                "#2a2a2c",
                "#e3dfd6",
                "#ff7b72",
                "#e3b341",
                "#56d364",
                "#6b5a1e",
                "#00000080",
            ],
        ),
        t(
            "midnight",
            "Midnight",
            Dark,
            false,
            [
                "#0f1626",
                "#131c30",
                "#18233b",
                "#1c2943",
                "#24345a",
                "#1f2b45",
                "#33456b",
                "#dbe4f3",
                "#a2b2cd",
                "#7486a5",
                "#7aa2ff",
                "#0b1226",
                "#8db4ff",
                "#8db4ff",
                "#7aa2ff47",
                "#162039",
                "#cfe0ff",
                "#ff8b8b",
                "#f0c060",
                "#6ed69a",
                "#4a4420",
                "#00000099",
            ],
        ),
        t(
            "charcoal",
            "Charcoal",
            Dark,
            false,
            [
                "#242424",
                "#1b1b1b",
                "#2e2e2e",
                "#303030",
                "#3a3a3a",
                "#343434",
                "#4c4c4c",
                "#ececec",
                "#b3b3b3",
                "#8a8a8a",
                "#d6d6d6",
                "#1b1b1b",
                "#a8c7fa",
                "#e0e0e0",
                "#ffffff33",
                "#2c2c2c",
                "#e8e8e8",
                "#ff8a80",
                "#ffcc66",
                "#7bd88f",
                "#5c5222",
                "#00000080",
            ],
        ),
        t(
            "warm-dark",
            "Warm Dark",
            Dark,
            false,
            [
                "#221d18",
                "#1b1713",
                "#2c261f",
                "#302922",
                "#3b3229",
                "#362e26",
                "#4f4337",
                "#ece3d6",
                "#baac98",
                "#8e816e",
                "#e0965a",
                "#221d18",
                "#f0ad74",
                "#f0ad74",
                "#e0965a47",
                "#2a231d",
                "#f0dcc0",
                "#ff907b",
                "#f2c46d",
                "#a6d67c",
                "#5a4520",
                "#0000008c",
            ],
        ),
        t(
            "high-contrast-dark",
            "High Contrast Dark",
            Dark,
            true,
            [
                "#000000",
                "#000000",
                "#0a0a0a",
                "#1f1f1f",
                "#333333",
                "#ffffff",
                "#ffffff",
                "#ffffff",
                "#f2f2f2",
                "#cfcfcf",
                "#ffd60a",
                "#000000",
                "#7cc4ff",
                "#ffd60a",
                "#ffd60a66",
                "#141414",
                "#ffffff",
                "#ff7070",
                "#ffd60a",
                "#5cff8a",
                "#806c00",
                "#000000",
            ],
        ),
        t(
            "oled-black",
            "OLED Black",
            Dark,
            false,
            [
                "#000000",
                "#000000",
                "#0e0e0e",
                "#141414",
                "#1e1e1e",
                "#1c1c1c",
                "#303030",
                "#e8e8e8",
                "#a3a3a3",
                "#727272",
                "#5e9eff",
                "#000000",
                "#7fb2ff",
                "#7fb2ff",
                "#5e9eff4d",
                "#0e0e0e",
                "#dcdcdc",
                "#ff7a70",
                "#e8b44c",
                "#4cd47a",
                "#4d4100",
                "#000000",
            ],
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contrast_math() {
        assert_eq!(contrast("#000000", "#ffffff"), Some(21.0));
        assert_eq!(contrast("#ffffff", "#ffffff"), Some(1.0));
        assert!(contrast("#777777", "#ffffff").unwrap() < 4.5);
        assert!(parse_color("#12345").is_none());
        assert!(parse_color("red").is_none());
        assert_eq!(parse_color("#fff"), Some([255.0, 255.0, 255.0, 1.0]));
    }

    #[test]
    fn all_builtins_are_valid_and_legible() {
        let all = builtins();
        assert_eq!(all.len(), 12);
        assert_eq!(all.iter().filter(|t| t.mode == Mode::Light).count(), 6);
        for theme in &all {
            let r = validate(theme);
            assert!(r.errors.is_empty(), "{}: {:?}", theme.id, r.errors);
            for c in &r.checks {
                assert!(c.ok, "{}: {} is {} (needs {})", theme.id, c.pair, c.ratio, c.required);
            }
        }
    }

    #[test]
    fn builtins_are_visually_distinct() {
        let all = builtins();
        for (i, a) in all.iter().enumerate() {
            for b in &all[i + 1..] {
                let same = TOKENS.iter().filter(|(k, _)| a.colors[*k] == b.colors[*k]).count();
                assert!(same < 16, "{} and {} share {same} of 22 colours", a.id, b.id);
            }
        }
    }

    #[test]
    fn import_validates() {
        let mut custom = builtins()[0].clone();
        custom.id = "meu-tema".into();
        custom.name = "Meu tema".into();
        let json = export(&custom);
        let (t, report) = import(&json).unwrap();
        assert_eq!(t.id, "meu-tema");
        assert!(!t.builtin);
        assert!(report.passes());

        let mut bad = custom.clone();
        bad.colors.insert("text".into(), "url(javascript:alert(1))".into());
        assert!(import(&serde_json::to_string(&bad).unwrap()).is_err());

        let mut extra = custom.clone();
        extra.colors.insert("font".into(), "#fff".into());
        assert!(import(&serde_json::to_string(&extra).unwrap()).is_err());

        assert!(import(&export(&builtins()[1])).is_err(), "built-in ids are reserved");
        assert!(import("{").is_err());

        let mut low = custom;
        low.colors.insert("text".into(), "#dddddd".into());
        let (_, report) = import(&serde_json::to_string(&low).unwrap()).unwrap();
        assert!(!report.passes(), "low contrast is reported");
    }
}
