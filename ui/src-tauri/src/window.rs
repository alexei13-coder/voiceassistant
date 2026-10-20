//! Главное окно HUD: показать из трея, по второму запуску или по просьбе ядра.

use tauri::{AppHandle, Manager, Runtime};

pub const MAIN_WINDOW: &str = "main";

/// Показывает, разворачивает из свёрнутого состояния и фокусирует главное окно.
pub fn reveal<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        log::warn!("Главное окно не найдено");
        return;
    };
    let result = window
        .show()
        .and_then(|()| window.unminimize())
        .and_then(|()| window.set_focus());
    if let Err(err) = result {
        log::warn!("Не удалось показать окно: {err}");
    }
}
