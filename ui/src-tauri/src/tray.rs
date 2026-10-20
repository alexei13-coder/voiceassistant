//! Значок в трее: ассистент живёт здесь, когда окно спрятано.

use std::sync::Arc;

use tauri::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{include_image, AppHandle, Manager, Wry};
use tauri_plugin_autostart::ManagerExt;

use crate::core_process::CoreManager;
use crate::core_protocol::{ShellMessage, TrayAction};
use crate::window;

const TRAY_ID: &str = "main";
const MENU_SHOW: &str = "show";
const MENU_MUTE: &str = "mute";
const MENU_STOP: &str = "stop";
const MENU_AUTOSTART: &str = "autostart";
const MENU_QUIT: &str = "quit";

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, MENU_SHOW, "Показать", true, None::<&str>)?;
    let mute = MenuItem::with_id(app, MENU_MUTE, "Не слушать", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, MENU_STOP, "Стоп", true, None::<&str>)?;
    // Автозапуск по умолчанию выключен — его включает сам пользователь. Галочка отражает
    // запись в системе (реестр Windows), а не сохранённую настройку.
    let autostart = CheckMenuItem::with_id(
        app,
        MENU_AUTOSTART,
        "Запускать при входе в Windows",
        true,
        autostart_enabled(app),
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "Выход", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &mute, &stop, &separator, &autostart, &quit])?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(include_image!("icons/tray.png"))
        .tooltip("SWYVORN")
        .menu(&menu)
        // Левый клик открывает окно, меню — по правому.
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| on_menu_event(app, event, &autostart))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                window::reveal(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn on_menu_event(app: &AppHandle, event: MenuEvent, autostart: &CheckMenuItem<Wry>) {
    let core = app.state::<Arc<CoreManager>>();
    match event.id().as_ref() {
        MENU_SHOW => window::reveal(app),
        MENU_MUTE => core.send(&ShellMessage::Tray {
            action: TrayAction::MuteToggle,
        }),
        MENU_STOP => core.request_stop(ShellMessage::Tray {
            action: TrayAction::Stop,
        }),
        MENU_AUTOSTART => toggle_autostart(app, autostart),
        MENU_QUIT => crate::quit(app),
        other => log::warn!("Неизвестный пункт меню трея: {other}"),
    }
}

/// Переключает автозапуск (с аргументом `--autostart`: окно при входе не показывается)
/// и ставит галочку по тому, что получилось на самом деле, — запись в системе может не удаться.
fn toggle_autostart(app: &AppHandle, item: &CheckMenuItem<Wry>) {
    let autolaunch = app.autolaunch();
    // Новое значение берём из записи в системе, а не из галочки: меню переключает её само.
    match autolaunch.is_enabled() {
        Ok(true) => match autolaunch.disable() {
            Ok(()) => log::info!("Автозапуск при входе в систему выключен"),
            Err(err) => log::warn!("Не удалось выключить автозапуск: {err}"),
        },
        Ok(false) => match autolaunch.enable() {
            Ok(()) => log::info!("Автозапуск при входе в систему включён"),
            Err(err) => log::warn!("Не удалось включить автозапуск: {err}"),
        },
        Err(err) => log::warn!("Не удалось проверить автозапуск: {err}"),
    }
    if let Err(err) = item.set_checked(autostart_enabled(app)) {
        log::warn!("Не удалось обновить пункт автозапуска в трее: {err}");
    }
}

fn autostart_enabled(app: &AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or_else(|err| {
        log::warn!("Не удалось проверить автозапуск: {err}");
        false
    })
}
