//! Значок в трее: ассистент живёт здесь, когда окно спрятано.

use std::sync::Arc;

use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{include_image, AppHandle, Manager};

use crate::core_process::CoreManager;
use crate::core_protocol::{ShellMessage, TrayAction};
use crate::window;

const TRAY_ID: &str = "main";
const MENU_SHOW: &str = "show";
const MENU_MUTE: &str = "mute";
const MENU_STOP: &str = "stop";
const MENU_QUIT: &str = "quit";

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, MENU_SHOW, "Показать", true, None::<&str>)?;
    let mute = MenuItem::with_id(app, MENU_MUTE, "Не слушать", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, MENU_STOP, "Стоп", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "Выход", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &mute, &stop, &separator, &quit])?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(include_image!("icons/tray.png"))
        .tooltip("SWYVORN")
        .menu(&menu)
        // Левый клик открывает окно, меню — по правому.
        .show_menu_on_left_click(false)
        .on_menu_event(on_menu_event)
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

fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    let core = app.state::<Arc<CoreManager>>();
    match event.id().as_ref() {
        MENU_SHOW => window::reveal(app),
        MENU_MUTE => core.send(&ShellMessage::Tray {
            action: TrayAction::MuteToggle,
        }),
        MENU_STOP => core.request_stop(ShellMessage::Tray {
            action: TrayAction::Stop,
        }),
        MENU_QUIT => crate::quit(app),
        other => log::warn!("Неизвестный пункт меню трея: {other}"),
    }
}
