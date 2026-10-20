//! Сборка строк JSON Lines из произвольных кусков вывода процесса.
//!
//! Плагин shell в режиме raw отдаёт байты как пришли из канала: в одном куске может быть
//! половина строки или несколько строк сразу, а многобайтовый символ UTF-8 может разрезаться
//! на границе куска. Поэтому декодируем только целые строки.

/// Строка длиннее — заведомо не сообщение протокола: отбрасываем её целиком,
/// чтобы зависшее без `\n` ядро не съело память оболочки.
const MAX_LINE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Default)]
pub struct LineBuffer {
    pending: Vec<u8>,
    overflow: bool,
}

impl LineBuffer {
    /// Добавляет кусок вывода и возвращает все завершённые им строки (без `\n` и `\r`).
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        let mut lines = Vec::new();
        let mut rest = chunk;
        while let Some(end) = rest.iter().position(|&b| b == b'\n') {
            let (head, tail) = rest.split_at(end);
            if self.overflow {
                self.overflow = false;
                self.pending.clear();
                log::warn!("Отброшена строка вывода ядра длиннее {MAX_LINE_BYTES} байт");
            } else {
                self.pending.extend_from_slice(head);
                lines.push(decode(&self.pending));
                self.pending.clear();
            }
            rest = &tail[1..];
        }
        if !self.overflow {
            self.pending.extend_from_slice(rest);
            if self.pending.len() > MAX_LINE_BYTES {
                self.pending.clear();
                self.overflow = true;
            }
        }
        lines
    }

    /// Остаток без завершающего `\n` — когда процесс закрыл канал.
    pub fn finish(&mut self) -> Option<String> {
        let overflow = std::mem::take(&mut self.overflow);
        let pending = std::mem::take(&mut self.pending);
        (!overflow && !pending.is_empty()).then(|| decode(&pending))
    }
}

fn decode(bytes: &[u8]) -> String {
    let bytes = bytes.strip_suffix(b"\r").unwrap_or(bytes);
    String::from_utf8_lossy(bytes).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_partial_chunks() {
        let mut buf = LineBuffer::default();
        assert!(buf.push(b"{\"type\":").is_empty());
        assert_eq!(buf.push(b"\"ready\"}\n"), vec!["{\"type\":\"ready\"}"]);
    }

    #[test]
    fn splits_several_lines_in_one_chunk() {
        let mut buf = LineBuffer::default();
        assert_eq!(buf.push(b"a\nb\r\nc"), vec!["a", "b"]);
        assert_eq!(buf.push(b"\n"), vec!["c"]);
    }

    #[test]
    fn keeps_utf8_split_across_chunks() {
        let text = "Ядро готово\n".as_bytes();
        let mut buf = LineBuffer::default();
        assert!(buf.push(&text[..3]).is_empty());
        assert_eq!(buf.push(&text[3..]), vec!["Ядро готово"]);
    }

    #[test]
    fn finish_returns_unterminated_tail() {
        let mut buf = LineBuffer::default();
        buf.push(b"tail");
        assert_eq!(buf.finish().as_deref(), Some("tail"));
        assert_eq!(buf.finish(), None);
    }

    #[test]
    fn drops_overlong_line_and_recovers() {
        let mut buf = LineBuffer::default();
        let huge = vec![b'x'; MAX_LINE_BYTES + 1];
        assert!(buf.push(&huge).is_empty());
        assert!(buf.push(b"more of the same").is_empty());
        assert_eq!(buf.push(b"\nnext\n"), vec!["next"]);
        assert_eq!(buf.finish(), None);
    }
}
