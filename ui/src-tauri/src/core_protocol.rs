//! Сообщения stdio-канала оболочка ⇄ ядро (docs/protocol.md §2): JSON Lines в UTF-8.

use serde::{Deserialize, Serialize};

/// Сочетания клавиш из настроек ядра (§1.4 `Hotkeys`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Hotkeys {
    pub activate: String,
    pub stop: String,
    pub stop_fallback: String,
    pub mute: String,
    pub repeat: String,
    pub screen: String,
}

/// Ядро → оболочка (stdout, §2.1).
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CoreMessage {
    Ready {
        port: u16,
        protocol: u32,
        hotkeys: Hotkeys,
    },
    ShowWindow,
    Fatal {
        message: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HotkeyAction {
    Activate,
    PttDown,
    PttUp,
    Stop,
    MuteToggle,
    Repeat,
    Screen,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TrayAction {
    Stop,
    MuteToggle,
}

/// Оболочка → ядро (stdin, §2.2).
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ShellMessage {
    Hotkey {
        action: HotkeyAction,
    },
    HotkeyError {
        action: &'static str,
        combo: String,
        error: String,
    },
    Tray {
        action: TrayAction,
    },
    Shutdown,
}

impl ShellMessage {
    /// Одна строка JSON Lines с завершающим `\n`.
    pub fn to_line(&self) -> Vec<u8> {
        let mut line = serde_json::to_vec(self).expect("сообщения оболочки всегда сериализуются");
        line.push(b'\n');
        line
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(message: ShellMessage) -> String {
        String::from_utf8(message.to_line()).unwrap()
    }

    #[test]
    fn encodes_shell_messages_exactly_as_protocol() {
        assert_eq!(
            line(ShellMessage::Hotkey {
                action: HotkeyAction::PttDown
            }),
            "{\"type\":\"hotkey\",\"action\":\"ptt_down\"}\n"
        );
        assert_eq!(
            line(ShellMessage::Tray {
                action: TrayAction::MuteToggle
            }),
            "{\"type\":\"tray\",\"action\":\"mute_toggle\"}\n"
        );
        assert_eq!(line(ShellMessage::Shutdown), "{\"type\":\"shutdown\"}\n");
        assert_eq!(
            line(ShellMessage::HotkeyError {
                action: "stop",
                combo: "Ctrl+Alt+Escape".into(),
                error: "занято".into(),
            }),
            "{\"type\":\"hotkey_error\",\"action\":\"stop\",\"combo\":\"Ctrl+Alt+Escape\",\"error\":\"занято\"}\n"
        );
    }

    #[test]
    fn decodes_ready() {
        let raw = r#"{"type":"ready","port":51234,"protocol":1,"hotkeys":{"activate":"Ctrl+Alt+J","stop":"Ctrl+Alt+Escape","stop_fallback":"Ctrl+Alt+Backspace","mute":"Ctrl+Alt+M","repeat":"Ctrl+Alt+R","screen":"Ctrl+Alt+S"}}"#;
        match serde_json::from_str::<CoreMessage>(raw).unwrap() {
            CoreMessage::Ready {
                port,
                protocol,
                hotkeys,
            } => {
                assert_eq!(port, 51234);
                assert_eq!(protocol, 1);
                assert_eq!(hotkeys.stop_fallback, "Ctrl+Alt+Backspace");
            }
            other => panic!("неожиданное сообщение: {other:?}"),
        }
    }

    #[test]
    fn decodes_show_window_and_fatal() {
        assert!(matches!(
            serde_json::from_str::<CoreMessage>(r#"{"type":"show_window"}"#).unwrap(),
            CoreMessage::ShowWindow
        ));
        match serde_json::from_str::<CoreMessage>(r#"{"type":"fatal","message":"Порт занят"}"#)
            .unwrap()
        {
            CoreMessage::Fatal { message } => assert_eq!(message, "Порт занят"),
            other => panic!("неожиданное сообщение: {other:?}"),
        }
    }

    #[test]
    fn rejects_unknown_type() {
        assert!(serde_json::from_str::<CoreMessage>(r#"{"type":"bogus"}"#).is_err());
    }
}
