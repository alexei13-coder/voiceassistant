//! Rust-оболочка «Джарвиса»: окно HUD, трей, глобальные горячие клавиши, автозапуск,
//! запуск и аварийная остановка Python-ядра. Решений оболочка не принимает — всё решает ядро.

mod commands;
mod core_command;
mod core_process;
mod core_protocol;
mod hotkeys;
mod line_buffer;
mod logging;
mod restart_policy;
mod stop;
mod token;
mod tray;
mod window;

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use tauri::{async_runtime, AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;

use crate::core_process::CoreManager;
use crate::hotkeys::HotkeyRegistry;

/// Аргумент, с которым ОС запускает приложение при входе в систему: окно не показываем.
const AUTOSTART_ARG: &str = "--autostart";

pub fn run() {
    tauri::Builder::default()
        // Первым: второй экземпляр должен завершиться раньше, чем запустит своё ядро.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if !args.iter().any(|arg| arg == AUTOSTART_ARG) {
                window::reveal(app);
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![AUTOSTART_ARG]),
        ))
        .manage(HotkeyRegistry::default())
        .invoke_handler(tauri::generate_handler![
            commands::core_connection,
            commands::emergency_stop
        ])
        .setup(|app| {
            let handle = app.handle();
            // Без лога (например, папка данных недоступна для записи) ассистент всё равно работает.
            if let Err(err) = handle.plugin(logging::plugin(handle)) {
                eprintln!("Лог оболочки недоступен: {err}");
            }
            log::info!("Джарвис {} запускается", app.package_info().version);

            let core = CoreManager::new(handle.clone())?;
            app.manage(Arc::clone(&core));
            tray::create(handle)?;
            if !std::env::args().any(|arg| arg == AUTOSTART_ARG) {
                window::reveal(handle);
            }
            async_runtime::spawn(core.start());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Крестик и Alt+F4 прячут окно в трей: ассистент продолжает работать.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == window::MAIN_WINDOW {
                    api.prevent_close();
                    if let Err(err) = window.hide() {
                        log::warn!("Не удалось спрятать окно: {err}");
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("не удалось собрать приложение Tauri")
        .run(|app, event| match event {
            RunEvent::ExitRequested { api, .. } => {
                // Выход только после корректной остановки ядра; quit() сам вызовет exit снова.
                if !app.state::<Arc<CoreManager>>().quit_finished() {
                    api.prevent_exit();
                    quit(app);
                }
            }
            RunEvent::Exit => app.state::<Arc<CoreManager>>().kill_now(),
            _ => {}
        });
}

/// Выход из приложения: корректно остановить ядро (до 2 с), затем завершиться.
pub(crate) fn quit(app: &AppHandle) {
    let core = Arc::clone(app.state::<Arc<CoreManager>>().inner());
    if !core.begin_quit() {
        return;
    }
    log::info!("Выход: останавливаю ядро");
    let app = app.clone();
    async_runtime::spawn(async move {
        core.shutdown().await;
        app.exit(0);
    });
}

/// Блокировка без паники из-за отравления: состояние оболочки остаётся пригодным
/// и после паники в другом потоке, а падать из-за неё целиком хуже.
pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
