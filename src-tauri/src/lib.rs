//! note4me desktop shell: wires the Rust core to the webview UI.

mod commands;
mod fonts;
mod menu;
mod state;
mod watcher;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .target(tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                    file_name: Some("note4me".into()),
                }))
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = commands::config_dir(app.handle());
            app.manage(state::AppState::new(dir));
            let menu = menu::build(app.handle())?;
            app.set_menu(menu)?;
            app.on_menu_event(|app, event| menu::forward(app, event.id().as_ref()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::settings_get,
            commands::settings_set,
            commands::typography_presets,
            commands::fonts_list,
            commands::themes_list,
            commands::theme_validate,
            commands::theme_save,
            commands::theme_import_file,
            commands::theme_export_file,
            commands::theme_delete,
            commands::vault_open,
            commands::vault_current,
            commands::vault_close,
            commands::vault_create,
            commands::vault_reindex,
            commands::abs_path,
            commands::tree_list,
            commands::tree_reorder,
            commands::folders_list,
            commands::page_read,
            commands::page_save,
            commands::page_save_copy,
            commands::draft_stash,
            commands::draft_discard,
            commands::page_create,
            commands::folder_create,
            commands::entry_rename,
            commands::entry_move,
            commands::page_duplicate,
            commands::entry_delete,
            commands::property_set,
            commands::nav_state,
            commands::favorite_set,
            commands::search,
            commands::quick_find,
            commands::tags_list,
            commands::backlinks,
            commands::broken_links,
            commands::link_resolve,
            commands::link_relative,
            commands::trash_list,
            commands::trash_restore,
            commands::trash_purge,
            commands::trash_empty,
            commands::history_list,
            commands::history_read,
            commands::history_restore,
            commands::text_diff,
            commands::attachment_add,
            commands::attachment_add_bytes,
            commands::import_paths,
            commands::export_page,
            commands::export_vault,
            commands::collection_query,
            commands::collection_view_get,
            commands::collection_view_save,
            commands::collection_add,
            commands::reveal_in_finder,
            commands::reveal_abs,
            commands::open_with_default_app,
            commands::open_external,
            commands::e2e_config,
            commands::e2e_write_file,
            commands::e2e_read_file,
            commands::e2e_finish,
            commands::e2e_mark,
        ])
        .run(tauri::generate_context!())
        .expect("error while running note4me");
}
