//! Process-wide application state shared by the command handlers.

use note4me_core::settings::Settings;
use note4me_core::themes::Theme;
use note4me_core::workspace::Workspace;
use notify_debouncer_mini::{notify::RecommendedWatcher, Debouncer};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

pub struct AppState {
    pub config_dir: PathBuf,
    pub settings: Mutex<Settings>,
    pub workspace: Arc<Mutex<Option<Workspace>>>,
    pub watcher: Mutex<Option<Debouncer<RecommendedWatcher>>>,
}

impl AppState {
    pub fn new(config_dir: PathBuf) -> AppState {
        let settings = Settings::load(&config_dir.join("settings.json"));
        AppState {
            config_dir,
            settings: Mutex::new(settings),
            workspace: Arc::new(Mutex::new(None)),
            watcher: Mutex::new(None),
        }
    }

    pub fn settings_path(&self) -> PathBuf {
        self.config_dir.join("settings.json")
    }

    pub fn themes_dir(&self) -> PathBuf {
        self.config_dir.join("themes")
    }

    /// Custom themes saved by the user (invalid files are skipped).
    pub fn custom_themes(&self) -> Vec<Theme> {
        let mut out: Vec<Theme> = std::fs::read_dir(self.themes_dir())
            .into_iter()
            .flatten()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
            .filter_map(|e| std::fs::read_to_string(e.path()).ok())
            .filter_map(|json| note4me_core::themes::import(&json).ok().map(|(t, _)| t))
            .collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    }
}
