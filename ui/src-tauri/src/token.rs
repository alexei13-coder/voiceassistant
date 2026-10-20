//! Токен IPC: один на запуск оболочки, передаётся ядру в `JARVIS_IPC_TOKEN`, а UI — через
//! команду `core_connection`. Никогда не попадает в лог: `Display` нет, `Debug` скрывает значение,
//! получить его можно только явно через `as_str()`.

use std::fmt;

const TOKEN_BYTES: usize = 32;

pub struct IpcToken(String);

impl IpcToken {
    pub fn generate() -> Result<Self, getrandom::Error> {
        let mut bytes = [0u8; TOKEN_BYTES];
        getrandom::fill(&mut bytes)?;
        let hex = bytes
            .iter()
            .fold(String::with_capacity(TOKEN_BYTES * 2), |mut acc, byte| {
                use fmt::Write;
                let _ = write!(acc, "{byte:02x}");
                acc
            });
        Ok(Self(hex))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Защита от случайной утечки: убирает токен из строки, которую собираемся записать в лог.
    pub fn redact<'a>(&self, text: &'a str) -> std::borrow::Cow<'a, str> {
        if text.contains(self.as_str()) {
            text.replace(self.as_str(), "***").into()
        } else {
            text.into()
        }
    }
}

impl fmt::Debug for IpcToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("IpcToken(***)")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_64_lowercase_hex_chars_and_unique() {
        let a = IpcToken::generate().unwrap();
        let b = IpcToken::generate().unwrap();
        assert_eq!(a.as_str().len(), 64);
        assert!(a
            .as_str()
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_ne!(a.as_str(), b.as_str());
    }

    #[test]
    fn never_shows_in_debug_or_redacted_text() {
        let token = IpcToken::generate().unwrap();
        assert!(!format!("{token:?}").contains(token.as_str()));
        let line = format!("token={}", token.as_str());
        assert_eq!(token.redact(&line), "token=***");
        assert_eq!(token.redact("обычная строка"), "обычная строка");
    }
}
