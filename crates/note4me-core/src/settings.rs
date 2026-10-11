//! Application preferences.
//!
//! Stored as JSON in the app's configuration directory
//! (`~/Library/Application Support/app.note4me/settings.json` on macOS) —
//! never inside a vault, so appearance and typography can never change a
//! Markdown file. Every value is clamped to a supported range on load, and
//! unknown or missing fields fall back to defaults.

use crate::attachments::{AttachmentLocation, AttachmentOptions};
use crate::error::{CoreError, Result};
use crate::fsio;
use crate::history::HistoryOptions;
use crate::workspace::WorkspaceOptions;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const SETTINGS_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ThemeMode {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Density {
    Compact,
    #[default]
    Comfortable,
    Spacious,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Tristate {
    #[default]
    System,
    On,
    Off,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Align {
    #[default]
    Left,
    Justify,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Generic {
    #[default]
    Sans,
    Serif,
    Mono,
}

/// A font family plus the generic family used when it is unavailable.
/// `family` is either a system alias (`system-ui`, `ui-serif`,
/// `ui-monospace`, `ui-rounded`) or an installed family name.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FontChoice {
    pub family: String,
    #[serde(default)]
    pub generic: Generic,
}

impl FontChoice {
    pub fn new(family: &str, generic: Generic) -> Self {
        FontChoice {
            family: family.into(),
            generic,
        }
    }

    /// Family names are interpolated into CSS; allow only safe characters.
    fn sanitized(mut self, fallback: &FontChoice) -> Self {
        let ok = !self.family.is_empty()
            && self.family.len() <= 80
            && self
                .family
                .chars()
                .all(|c| c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.' | '&' | '+'));
        if !ok {
            self = fallback.clone();
        }
        self
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Appearance {
    pub mode: ThemeMode,
    pub light_theme: String,
    pub dark_theme: String,
    pub density: Density,
    pub sidebar_width: u32,
    pub sidebar_visible: bool,
    /// Show non-Markdown files (attachments) in the sidebar tree.
    pub show_files_in_sidebar: bool,
    /// Subtle shadows and transitions; off gives a flat interface.
    pub effects: bool,
}

impl Default for Appearance {
    fn default() -> Self {
        Appearance {
            mode: ThemeMode::System,
            light_theme: "light-classic".into(),
            dark_theme: "dark-classic".into(),
            density: Density::Comfortable,
            sidebar_width: 260,
            sidebar_visible: true,
            show_files_in_sidebar: false,
            effects: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Typography {
    /// Preset the values were last taken from (informational).
    pub preset: Option<String>,
    pub ui_font: FontChoice,
    pub content_font: FontChoice,
    pub heading_font: FontChoice,
    pub code_font: FontChoice,
    /// Body text size in CSS pixels.
    pub content_size: f32,
    pub weight: u16,
    pub heading_weight: u16,
    pub line_height: f32,
    /// Space after paragraphs, in em.
    pub paragraph_spacing: f32,
    /// Letter spacing, in em.
    pub letter_spacing: f32,
    /// Maximum width of the reading column in px (0 = use full width).
    pub max_width: u32,
    pub align: Align,
    pub table_size: f32,
    pub code_size: f32,
}

impl Default for Typography {
    fn default() -> Self {
        preset("default").expect("default preset exists")
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Accessibility {
    /// Interface scale in percent (80–200).
    pub ui_scale: u16,
    pub reduce_motion: Tristate,
    /// Use the high-contrast theme variants regardless of the chosen themes.
    pub high_contrast: Tristate,
    pub strong_focus: bool,
    pub underline_links: bool,
}

impl Default for Accessibility {
    fn default() -> Self {
        Accessibility {
            ui_scale: 100,
            reduce_motion: Tristate::System,
            high_contrast: Tristate::System,
            strong_focus: false,
            underline_links: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum LinkFormat {
    /// `[Título](caminho/relativo.md)` — portable everywhere.
    #[default]
    Markdown,
    /// `[[Título]]` — for vaults shared with Obsidian.
    Wiki,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Editor {
    pub autosave: bool,
    pub autosave_delay_ms: u32,
    pub spellcheck: bool,
    pub slash_menu: bool,
    pub show_word_count: bool,
    pub new_page_frontmatter: bool,
    pub link_format: LinkFormat,
    pub confirm_external_links: bool,
}

impl Default for Editor {
    fn default() -> Self {
        Editor {
            autosave: true,
            autosave_delay_ms: 800,
            spellcheck: true,
            slash_menu: true,
            show_word_count: true,
            new_page_frontmatter: true,
            link_format: LinkFormat::Markdown,
            confirm_external_links: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Files {
    pub attachment_location: AttachmentLocation,
    pub max_attachment_mb: u32,
    pub max_index_file_mb: u32,
    pub history_enabled: bool,
    pub history_interval_min: u32,
    pub history_max_versions: u32,
}

impl Default for Files {
    fn default() -> Self {
        Files {
            attachment_location: AttachmentLocation::VaultFolder("Anexos".into()),
            max_attachment_mb: 200,
            max_index_file_mb: 8,
            history_enabled: true,
            history_interval_min: 5,
            history_max_versions: 100,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub version: u32,
    pub last_vault: Option<PathBuf>,
    pub recent_vaults: Vec<PathBuf>,
    pub appearance: Appearance,
    pub typography: Typography,
    pub accessibility: Accessibility,
    pub editor: Editor,
    pub files: Files,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            version: SETTINGS_VERSION,
            last_vault: None,
            recent_vaults: Vec::new(),
            appearance: Appearance::default(),
            typography: Typography::default(),
            accessibility: Accessibility::default(),
            editor: Editor::default(),
            files: Files::default(),
        }
    }
}

fn clampf(v: f32, lo: f32, hi: f32, default: f32) -> f32 {
    if v.is_finite() {
        v.clamp(lo, hi)
    } else {
        default
    }
}

impl Settings {
    /// Brings every value into its supported range.
    pub fn normalized(mut self) -> Settings {
        let d = Typography::default();
        let t = &mut self.typography;
        t.ui_font = t.ui_font.clone().sanitized(&d.ui_font);
        t.content_font = t.content_font.clone().sanitized(&d.content_font);
        t.heading_font = t.heading_font.clone().sanitized(&d.heading_font);
        t.code_font = t.code_font.clone().sanitized(&d.code_font);
        t.content_size = clampf(t.content_size, 11.0, 40.0, d.content_size);
        t.weight = (t.weight / 100 * 100).clamp(300, 700);
        t.heading_weight = t.heading_weight.clamp(400, 900);
        t.line_height = clampf(t.line_height, 1.1, 2.6, d.line_height);
        t.paragraph_spacing = clampf(t.paragraph_spacing, 0.0, 3.0, d.paragraph_spacing);
        t.letter_spacing = clampf(t.letter_spacing, -0.05, 0.25, d.letter_spacing);
        if t.max_width != 0 {
            t.max_width = t.max_width.clamp(420, 2000);
        }
        t.table_size = clampf(t.table_size, 10.0, 32.0, d.table_size);
        t.code_size = clampf(t.code_size, 10.0, 32.0, d.code_size);
        let a = &mut self.accessibility;
        a.ui_scale = a.ui_scale.clamp(80, 200);
        let ap = &mut self.appearance;
        ap.sidebar_width = ap.sidebar_width.clamp(180, 520);
        let e = &mut self.editor;
        e.autosave_delay_ms = e.autosave_delay_ms.clamp(200, 10_000);
        let f = &mut self.files;
        f.max_attachment_mb = f.max_attachment_mb.clamp(1, 4096);
        f.max_index_file_mb = f.max_index_file_mb.clamp(1, 256);
        f.history_interval_min = f.history_interval_min.clamp(0, 1440);
        f.history_max_versions = f.history_max_versions.clamp(1, 1000);
        if let AttachmentLocation::VaultFolder(name) | AttachmentLocation::Subfolder(name) = &mut f.attachment_location {
            if crate::paths::RelPath::parse(name).map(|p| p.is_root() || p.is_hidden()).unwrap_or(true) {
                *name = "Anexos".into();
            }
        }
        self.recent_vaults.dedup();
        self.recent_vaults.truncate(10);
        self.version = SETTINGS_VERSION;
        self
    }

    pub fn load(path: &Path) -> Settings {
        match std::fs::read(path) {
            Ok(bytes) => match serde_json::from_slice::<Settings>(&bytes) {
                Ok(s) => s.normalized(),
                Err(_) => {
                    let _ = std::fs::rename(path, path.with_extension("json.corrupt"));
                    Settings::default()
                }
            },
            Err(_) => Settings::default(),
        }
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(dir) = path.parent() {
            fsio::ensure_dir(dir, "configurações")?;
        }
        let bytes = serde_json::to_vec_pretty(self).map_err(|e| CoreError::Validation(e.to_string()))?;
        fsio::atomic_write(path, &bytes, "configurações")
    }

    pub fn remember_vault(&mut self, vault: &Path) {
        self.last_vault = Some(vault.to_path_buf());
        self.recent_vaults.retain(|v| v != vault);
        self.recent_vaults.insert(0, vault.to_path_buf());
        self.recent_vaults.truncate(10);
    }

    pub fn workspace_options(&self) -> WorkspaceOptions {
        WorkspaceOptions {
            new_page_frontmatter: self.editor.new_page_frontmatter,
            max_file_bytes: self.files.max_index_file_mb as u64 * 1024 * 1024,
            history: HistoryOptions {
                enabled: self.files.history_enabled,
                min_interval_secs: self.files.history_interval_min as u64 * 60,
                max_versions: self.files.history_max_versions as usize,
            },
            attachments: AttachmentOptions {
                location: self.files.attachment_location.clone(),
                max_bytes: self.files.max_attachment_mb as u64 * 1024 * 1024,
            },
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetInfo {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
}

pub const PRESETS: [PresetInfo; 8] = [
    PresetInfo {
        id: "default",
        name: "Padrão",
        description: "Fonte do sistema, tamanho e espaçamento equilibrados.",
    },
    PresetInfo {
        id: "comfortable",
        name: "Leitura confortável",
        description: "Texto um pouco maior e mais espaço entre linhas.",
    },
    PresetInfo {
        id: "long-form",
        name: "Leitura prolongada",
        description: "Serifada do sistema, coluna estreita e linhas generosas.",
    },
    PresetInfo {
        id: "editorial",
        name: "Serifada editorial",
        description: "Georgia no texto, títulos serifados e mais peso.",
    },
    PresetInfo {
        id: "minimal-sans",
        name: "Sans-serif minimalista",
        description: "Compacta, coluna larga, títulos discretos.",
    },
    PresetInfo {
        id: "mono",
        name: "Monoespaçada",
        description: "Tudo em fonte monoespaçada, como um editor de código.",
    },
    PresetInfo {
        id: "dyslexia",
        name: "Dislexia-friendly",
        description: "Fonte de alta legibilidade, espaçamento amplo e alinhamento à esquerda.",
    },
    PresetInfo {
        id: "high-contrast",
        name: "Alto contraste",
        description: "Texto maior e mais pesado para máxima nitidez.",
    },
];

/// Returns the values of a typography preset — a starting point the user
/// can edit freely afterwards.
pub fn preset(id: &str) -> Option<Typography> {
    use Generic::*;
    let sys = FontChoice::new("system-ui", Sans);
    let serif = FontChoice::new("ui-serif", Serif);
    let mono = FontChoice::new("ui-monospace", Mono);
    let base = Typography {
        preset: Some(id.to_string()),
        ui_font: sys.clone(),
        content_font: sys.clone(),
        heading_font: sys.clone(),
        code_font: mono.clone(),
        content_size: 16.0,
        weight: 400,
        heading_weight: 650,
        line_height: 1.6,
        paragraph_spacing: 0.75,
        letter_spacing: 0.0,
        max_width: 720,
        align: Align::Left,
        table_size: 14.0,
        code_size: 14.0,
    };
    Some(match id {
        "default" => base,
        "comfortable" => Typography {
            content_size: 17.0,
            line_height: 1.72,
            paragraph_spacing: 0.9,
            max_width: 680,
            table_size: 15.0,
            code_size: 15.0,
            ..base
        },
        "long-form" => Typography {
            content_font: serif.clone(),
            heading_font: serif,
            content_size: 19.0,
            line_height: 1.8,
            paragraph_spacing: 1.0,
            max_width: 640,
            heading_weight: 600,
            ..base
        },
        "editorial" => Typography {
            content_font: FontChoice::new("Georgia", Serif),
            heading_font: FontChoice::new("ui-serif", Serif),
            content_size: 18.0,
            line_height: 1.65,
            heading_weight: 700,
            max_width: 700,
            letter_spacing: 0.003,
            ..base
        },
        "minimal-sans" => Typography {
            content_size: 15.0,
            line_height: 1.55,
            heading_weight: 600,
            max_width: 780,
            letter_spacing: -0.003,
            paragraph_spacing: 0.6,
            table_size: 13.0,
            code_size: 13.0,
            ..base
        },
        "mono" => Typography {
            content_font: mono.clone(),
            heading_font: mono.clone(),
            content_size: 14.5,
            line_height: 1.6,
            heading_weight: 700,
            max_width: 820,
            code_size: 14.0,
            table_size: 13.5,
            ..base
        },
        "dyslexia" => Typography {
            content_font: FontChoice::new("OpenDyslexic", Sans),
            heading_font: FontChoice::new("Atkinson Hyperlegible", Sans),
            content_size: 18.0,
            line_height: 1.9,
            paragraph_spacing: 1.2,
            letter_spacing: 0.035,
            max_width: 640,
            heading_weight: 700,
            table_size: 16.0,
            code_size: 16.0,
            ..base
        },
        "high-contrast" => Typography {
            content_size: 18.0,
            weight: 500,
            heading_weight: 800,
            line_height: 1.7,
            letter_spacing: 0.01,
            table_size: 16.0,
            code_size: 16.0,
            ..base
        },
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_preset_exists_and_is_in_range() {
        for p in PRESETS {
            let t = preset(p.id).unwrap();
            let s = Settings {
                typography: t.clone(),
                ..Default::default()
            }
            .normalized();
            assert_eq!(s.typography, t, "preset {} must already be normalised", p.id);
        }
        assert!(preset("nope").is_none());
    }

    #[test]
    fn clamps_out_of_range_and_unsafe_values() {
        let mut s = Settings::default();
        s.accessibility.ui_scale = 999;
        s.typography.content_size = f32::NAN;
        s.typography.line_height = 0.2;
        s.typography.content_font.family = "x; } body { display:none".into();
        s.files.attachment_location = AttachmentLocation::VaultFolder("../fora".into());
        let n = s.normalized();
        assert_eq!(n.accessibility.ui_scale, 200);
        assert_eq!(n.typography.content_size, 16.0);
        assert_eq!(n.typography.line_height, 1.1);
        assert_eq!(n.typography.content_font.family, "system-ui");
        assert_eq!(n.files.attachment_location, AttachmentLocation::VaultFolder("Anexos".into()));
    }

    #[test]
    fn load_tolerates_partial_and_corrupt_files() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("settings.json");
        std::fs::write(&p, r#"{"appearance":{"mode":"dark"},"futureField":1}"#).unwrap();
        let s = Settings::load(&p);
        assert_eq!(s.appearance.mode, ThemeMode::Dark);
        assert_eq!(s.typography, Typography::default());
        std::fs::write(&p, "{oops").unwrap();
        assert_eq!(Settings::load(&p), Settings::default());
        let s2 = Settings::default();
        s2.save(&p).unwrap();
        assert_eq!(Settings::load(&p), s2);
    }

    #[test]
    fn presentation_settings_are_independent_of_vaults() {
        // Changing presentation produces identical workspace options.
        let a = Settings::default();
        let mut b = a.clone();
        b.typography = preset("editorial").unwrap();
        b.appearance.light_theme = "ivory".into();
        b.accessibility.ui_scale = 150;
        let (oa, ob) = (a.workspace_options(), b.workspace_options());
        assert_eq!(serde_json::to_string(&oa).unwrap(), serde_json::to_string(&ob).unwrap());
    }
}
