//! Native macOS menu bar. Custom items are forwarded to the UI as
//! `menu` events carrying the item id; standard items (copy, paste, hide,
//! quit…) use the system implementations.

use tauri::menu::{AboutMetadata, Menu, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime};

fn item<R: Runtime>(app: &AppHandle<R>, id: &str, label: &str, accel: Option<&str>) -> tauri::Result<tauri::menu::MenuItem<R>> {
    let mut b = MenuItemBuilder::with_id(id, label);
    if let Some(a) = accel {
        b = b.accelerator(a);
    }
    b.build(app)
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let about = AboutMetadata {
        name: Some("note4me".into()),
        version: Some(app.package_info().version.to_string()),
        ..Default::default()
    };
    let app_menu = SubmenuBuilder::new(app, "note4me")
        .item(&PredefinedMenuItem::about(app, Some("Sobre o note4me"), Some(about))?)
        .separator()
        .item(&item(app, "settings", "Ajustes…", Some("CmdOrCtrl+,"))?)
        .separator()
        .item(&PredefinedMenuItem::services(app, Some("Serviços"))?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, Some("Ocultar note4me"))?)
        .item(&PredefinedMenuItem::hide_others(app, Some("Ocultar Outros"))?)
        .item(&PredefinedMenuItem::show_all(app, Some("Mostrar Tudo"))?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, Some("Encerrar note4me"))?)
        .build()?;
    let file = SubmenuBuilder::new(app, "Arquivo")
        .item(&item(app, "new-page", "Nova Página", Some("CmdOrCtrl+N"))?)
        .item(&item(app, "new-subpage", "Nova Subpágina", Some("CmdOrCtrl+Shift+N"))?)
        .item(&item(app, "new-folder", "Nova Pasta", Some("CmdOrCtrl+Alt+N"))?)
        .separator()
        .item(&item(app, "open-vault", "Abrir Espaço de Trabalho…", Some("CmdOrCtrl+O"))?)
        .item(&item(app, "save-now", "Salvar Agora", Some("CmdOrCtrl+S"))?)
        .separator()
        .item(&item(app, "import-files", "Importar Arquivos Markdown…", None)?)
        .item(&item(app, "import-folder", "Importar Pasta…", None)?)
        .item(&item(app, "export-page", "Exportar Página com Anexos…", None)?)
        .item(&item(app, "export-vault", "Exportar Espaço de Trabalho…", None)?)
        .separator()
        .item(&item(app, "reveal", "Mostrar no Finder", Some("CmdOrCtrl+Alt+R"))?)
        .item(&item(app, "copy-markdown", "Copiar Markdown da Página", Some("CmdOrCtrl+Alt+C"))?)
        .separator()
        .item(&item(app, "history", "Histórico de Versões…", Some("CmdOrCtrl+Alt+H"))?)
        .item(&item(app, "trash", "Lixeira…", None)?)
        .separator()
        .item(&PredefinedMenuItem::close_window(app, Some("Fechar Janela"))?)
        .build()?;
    // Undo/redo are custom so they reach the editor's own history.
    let edit = SubmenuBuilder::new(app, "Editar")
        .item(&item(app, "undo", "Desfazer", Some("CmdOrCtrl+Z"))?)
        .item(&item(app, "redo", "Refazer", Some("CmdOrCtrl+Shift+Z"))?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, Some("Recortar"))?)
        .item(&PredefinedMenuItem::copy(app, Some("Copiar"))?)
        .item(&PredefinedMenuItem::paste(app, Some("Colar"))?)
        .item(&PredefinedMenuItem::select_all(app, Some("Selecionar Tudo"))?)
        .separator()
        .item(&item(app, "find", "Buscar no Espaço de Trabalho…", Some("CmdOrCtrl+Shift+F"))?)
        .build()?;
    let view = SubmenuBuilder::new(app, "Visualizar")
        .item(&item(app, "toggle-sidebar", "Mostrar/Ocultar Barra Lateral", Some("CmdOrCtrl+\\"))?)
        .item(&item(app, "toggle-info", "Mostrar/Ocultar Painel de Informações", Some("CmdOrCtrl+Alt+I"))?)
        .item(&item(app, "quick-open", "Ir para Página…", Some("CmdOrCtrl+P"))?)
        .separator()
        .item(&item(app, "back", "Voltar", Some("CmdOrCtrl+["))?)
        .item(&item(app, "forward", "Avançar", Some("CmdOrCtrl+]"))?)
        .separator()
        .item(&item(app, "text-bigger", "Aumentar Texto", Some("CmdOrCtrl+="))?)
        .item(&item(app, "text-smaller", "Diminuir Texto", Some("CmdOrCtrl+-"))?)
        .item(&item(app, "text-reset", "Tamanho Padrão do Texto", Some("CmdOrCtrl+0"))?)
        .separator()
        .item(&PredefinedMenuItem::fullscreen(app, Some("Tela Cheia"))?)
        .build()?;
    let window = SubmenuBuilder::new(app, "Janela")
        .item(&PredefinedMenuItem::minimize(app, Some("Minimizar"))?)
        .item(&PredefinedMenuItem::maximize(app, Some("Zoom"))?)
        .build()?;
    let help = SubmenuBuilder::new(app, "Ajuda")
        .item(&item(app, "shortcuts", "Atalhos de Teclado", Some("CmdOrCtrl+/"))?)
        .build()?;
    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window, &help])
}

pub fn forward<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let _ = app.emit("menu", id.to_string());
}
