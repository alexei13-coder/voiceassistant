//! Глобальные горячие клавиши из сообщения `ready`: регистрация, запасное сочетание «Стопа»
//! и различение короткого нажатия и удержания клавиши активации (docs/protocol.md §2.3).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{async_runtime, AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::core_process::CoreManager;
use crate::core_protocol::{HotkeyAction, Hotkeys, ShellMessage};
use crate::lock;

const HOLD_THRESHOLD: Duration = Duration::from_millis(350);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Binding {
    Activate,
    Stop,
    StopFallback,
    Mute,
    Repeat,
    Screen,
}

impl Binding {
    /// Имя ключа в `[hotkeys]` settings.toml — его же получает ядро в `hotkey_error.action`.
    fn name(self) -> &'static str {
        match self {
            Self::Activate => "activate",
            Self::Stop => "stop",
            Self::StopFallback => "stop_fallback",
            Self::Mute => "mute",
            Self::Repeat => "repeat",
            Self::Screen => "screen",
        }
    }
}

/// Состояние горячих клавиш в managed state приложения.
#[derive(Default)]
pub struct HotkeyRegistry {
    registered: Mutex<Registered>,
    activate: Arc<Mutex<TapHold>>,
}

#[derive(Default)]
struct Registered {
    /// Набор, зарегистрированный без ошибок. `None` — при следующем `ready` регистрируем заново
    /// (новый процесс ядра должен снова узнать о занятых сочетаниях).
    applied: Option<Hotkeys>,
    shortcuts: Vec<Shortcut>,
}

/// Регистрирует сочетания из `ready`. Блокирует до ответа главного потока — вызывать
/// из `spawn_blocking`, не из главного потока и не из обработчика клавиш.
pub fn apply(app: &AppHandle, hotkeys: &Hotkeys) {
    let registry = app.state::<HotkeyRegistry>();
    let mut registered = lock(&registry.registered);
    if registered.applied.as_ref() == Some(hotkeys) {
        return;
    }
    let global = app.global_shortcut();
    for shortcut in registered.shortcuts.drain(..) {
        if let Err(err) = global.unregister(shortcut) {
            log::warn!("Не удалось снять сочетание {shortcut}: {err}");
        }
    }

    let mut all_ok = true;
    let bindings = [
        (Binding::Activate, &hotkeys.activate),
        (Binding::Stop, &hotkeys.stop),
        (Binding::Mute, &hotkeys.mute),
        (Binding::Repeat, &hotkeys.repeat),
        (Binding::Screen, &hotkeys.screen),
    ];
    for (binding, combo) in bindings {
        match register(app, binding, combo) {
            Ok(shortcut) => registered.shortcuts.push(shortcut),
            Err(error) => {
                all_ok = false;
                report_failure(app, binding, combo, error);
                if binding == Binding::Stop {
                    let fallback = &hotkeys.stop_fallback;
                    match register(app, Binding::StopFallback, fallback) {
                        Ok(shortcut) => registered.shortcuts.push(shortcut),
                        Err(error) => report_failure(app, Binding::StopFallback, fallback, error),
                    }
                }
            }
        }
    }
    registered.applied = all_ok.then(|| hotkeys.clone());
}

/// Разбор строки вида `Ctrl+Alt+J` (регистр и пробелы вокруг `+` не важны).
fn parse(combo: &str) -> Result<Shortcut, String> {
    let combo = combo.trim();
    if combo.is_empty() {
        return Err("сочетание не задано".into());
    }
    combo
        .parse::<Shortcut>()
        .map_err(|err| format!("не удалось разобрать сочетание: {err}"))
}

fn register(app: &AppHandle, binding: Binding, combo: &str) -> Result<Shortcut, String> {
    let shortcut = parse(combo)?;
    app.global_shortcut()
        .on_shortcut(shortcut, move |app, _shortcut, event| {
            on_event(app, binding, event.state);
        })
        .map_err(|err| err.to_string())?;
    log::info!("Горячая клавиша {} = {combo}", binding.name());
    Ok(shortcut)
}

fn report_failure(app: &AppHandle, binding: Binding, combo: &str, error: String) {
    log::warn!(
        "Сочетание {combo} ({}) не зарегистрировано: {error}",
        binding.name()
    );
    app.state::<Arc<CoreManager>>()
        .send(&ShellMessage::HotkeyError {
            action: binding.name(),
            combo: combo.to_owned(),
            error,
        });
}

/// Вызывается из главного потока (нажатие) или из потока опроса клавиатуры (отпускание на Windows).
fn on_event(app: &AppHandle, binding: Binding, state: ShortcutState) {
    let core = app.state::<Arc<CoreManager>>();
    let send = |action| core.send(&ShellMessage::Hotkey { action });
    match (binding, state) {
        (Binding::Activate, ShortcutState::Pressed) => {
            let tap_hold = Arc::clone(&app.state::<HotkeyRegistry>().activate);
            let press = {
                let mut guard = lock(&tap_hold);
                let (press, stale) = guard.press();
                if let Some(action) = stale {
                    send(action);
                }
                press
            };
            let core = Arc::clone(core.inner());
            async_runtime::spawn(async move {
                tokio::time::sleep(HOLD_THRESHOLD).await;
                // Отправка под блокировкой: ptt_down не может обогнать ptt_up из обработчика отпускания.
                let mut guard = lock(&tap_hold);
                if let Some(action) = guard.hold_elapsed(press) {
                    core.send(&ShellMessage::Hotkey { action });
                }
            });
        }
        (Binding::Activate, ShortcutState::Released) => {
            let registry = app.state::<HotkeyRegistry>();
            let mut guard = lock(&registry.activate);
            if let Some(action) = guard.release() {
                send(action);
            }
        }
        (Binding::Stop | Binding::StopFallback, ShortcutState::Pressed) => {
            core.request_stop(ShellMessage::Hotkey {
                action: HotkeyAction::Stop,
            });
        }
        (Binding::Mute, ShortcutState::Pressed) => send(HotkeyAction::MuteToggle),
        (Binding::Repeat, ShortcutState::Pressed) => send(HotkeyAction::Repeat),
        (Binding::Screen, ShortcutState::Pressed) => send(HotkeyAction::Screen),
        _ => {}
    }
}

/// Короткое нажатие или удержание клавиши активации.
#[derive(Debug, Default)]
struct TapHold {
    press: u64,
    pressed: bool,
    holding: bool,
}

impl TapHold {
    /// Новое нажатие; возвращает его номер для таймера удержания. Если прошлое удержание
    /// так и не получило отпускания, сначала закрываем его `ptt_up`, чтобы ядро не слушало вечно.
    fn press(&mut self) -> (u64, Option<HotkeyAction>) {
        let stale = self.holding.then_some(HotkeyAction::PttUp);
        self.press += 1;
        self.pressed = true;
        self.holding = false;
        (self.press, stale)
    }

    /// Таймер 350 мс истёк: если клавиша всё ещё нажата — началось удержание.
    fn hold_elapsed(&mut self, press: u64) -> Option<HotkeyAction> {
        if press != self.press || !self.pressed || self.holding {
            return None;
        }
        self.holding = true;
        Some(HotkeyAction::PttDown)
    }

    fn release(&mut self) -> Option<HotkeyAction> {
        if !std::mem::take(&mut self.pressed) {
            return None;
        }
        if std::mem::take(&mut self.holding) {
            Some(HotkeyAction::PttUp)
        } else {
            Some(HotkeyAction::Activate)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri_plugin_global_shortcut::{Code, Modifiers};

    #[test]
    fn parses_default_combos() {
        let ctrl_alt = Some(Modifiers::CONTROL | Modifiers::ALT);
        let cases = [
            ("Ctrl+Alt+J", Code::KeyJ),
            ("Ctrl+Alt+Escape", Code::Escape),
            ("Ctrl+Alt+Backspace", Code::Backspace),
            ("Ctrl+Alt+M", Code::KeyM),
            ("Ctrl+Alt+R", Code::KeyR),
            ("Ctrl+Alt+S", Code::KeyS),
            (" ctrl + alt + j ", Code::KeyJ),
        ];
        for (combo, code) in cases {
            assert_eq!(
                parse(combo).unwrap(),
                Shortcut::new(ctrl_alt, code),
                "{combo}"
            );
        }
    }

    #[test]
    fn rejects_bad_combos() {
        for combo in ["", "   ", "Ctrl+Alt", "Ctrl+Alt+Nope", "Ctrl+J+K"] {
            assert!(parse(combo).is_err(), "{combo:?}");
        }
    }

    #[test]
    fn short_press_is_activate() {
        let mut tap = TapHold::default();
        let (press, stale) = tap.press();
        assert_eq!(stale, None);
        assert_eq!(tap.release(), Some(HotkeyAction::Activate));
        // Таймер этого нажатия сработал уже после отпускания — ничего не делает.
        assert_eq!(tap.hold_elapsed(press), None);
    }

    #[test]
    fn long_press_is_push_to_talk() {
        let mut tap = TapHold::default();
        let (press, _) = tap.press();
        assert_eq!(tap.hold_elapsed(press), Some(HotkeyAction::PttDown));
        assert_eq!(tap.hold_elapsed(press), None);
        assert_eq!(tap.release(), Some(HotkeyAction::PttUp));
        assert_eq!(tap.release(), None);
    }

    #[test]
    fn timer_of_previous_press_is_ignored() {
        let mut tap = TapHold::default();
        let (first, _) = tap.press();
        tap.release();
        let (second, _) = tap.press();
        assert_eq!(tap.hold_elapsed(first), None);
        assert_eq!(tap.hold_elapsed(second), Some(HotkeyAction::PttDown));
    }

    #[test]
    fn lost_release_closes_stale_hold() {
        let mut tap = TapHold::default();
        let (press, _) = tap.press();
        tap.hold_elapsed(press);
        let (_, stale) = tap.press();
        assert_eq!(stale, Some(HotkeyAction::PttUp));
        assert_eq!(tap.release(), Some(HotkeyAction::Activate));
    }

    #[test]
    fn binding_names_match_settings_keys() {
        let names = [
            Binding::Activate,
            Binding::Stop,
            Binding::StopFallback,
            Binding::Mute,
            Binding::Repeat,
            Binding::Screen,
        ]
        .map(Binding::name);
        assert_eq!(
            names,
            [
                "activate",
                "stop",
                "stop_fallback",
                "mute",
                "repeat",
                "screen"
            ]
        );
    }
}
