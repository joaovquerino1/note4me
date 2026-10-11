//! Watches the open vault for changes made by other apps (Finder, other
//! editors, sync clients, Git) and keeps the index in step.

use crate::state::AppState;
use notify_debouncer_mini::{new_debouncer, notify::RecursiveMode, DebounceEventResult};
use std::path::Path;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

pub fn watch(app: &AppHandle, state: &AppState, root: &Path) {
    let handle = app.clone();
    let debouncer = new_debouncer(Duration::from_millis(250), move |res: DebounceEventResult| {
        let Ok(events) = res else {
            log::warn!("file watcher reported an error");
            return;
        };
        let paths: Vec<_> = events.into_iter().map(|e| e.path).collect();
        let state = handle.state::<AppState>();
        let changed = match state.workspace.lock() {
            Ok(mut guard) => match guard.as_mut() {
                Some(ws) => ws.apply_fs_events(&paths),
                None => return,
            },
            Err(_) => return,
        };
        if !changed.is_empty() {
            let list: Vec<String> = changed.iter().map(|p| p.to_string()).collect();
            let _ = handle.emit("vault:changed", list);
        }
    });
    match debouncer {
        Ok(mut d) => {
            if let Err(e) = d.watcher().watch(root, RecursiveMode::Recursive) {
                log::warn!("could not watch the vault: {e}");
            }
            *state.watcher.lock().unwrap() = Some(d);
        }
        Err(e) => log::warn!("could not start the file watcher: {e}"),
    }
}
