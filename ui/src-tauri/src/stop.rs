//! «Стоп» дважды за 2 секунды — аварийная остановка ядра (docs/protocol.md §3).

use std::time::{Duration, Instant};

const DOUBLE_PRESS_WINDOW: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopKind {
    /// Обычный «Стоп»: ядро само отменяет текущий ход.
    Soft,
    /// Повторное нажатие: оболочка убивает дерево процессов ядра и перезапускает его.
    Emergency,
}

#[derive(Debug, Default)]
pub struct StopTracker {
    last_soft: Option<Instant>,
}

impl StopTracker {
    pub fn press(&mut self, now: Instant) -> StopKind {
        match self.last_soft.take() {
            Some(prev) if now.duration_since(prev) <= DOUBLE_PRESS_WINDOW => StopKind::Emergency,
            _ => {
                self.last_soft = Some(now);
                StopKind::Soft
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_press_within_window_is_emergency() {
        let mut tracker = StopTracker::default();
        let t0 = Instant::now();
        assert_eq!(tracker.press(t0), StopKind::Soft);
        assert_eq!(
            tracker.press(t0 + Duration::from_millis(1500)),
            StopKind::Emergency
        );
        // После аварийного стопа отсчёт начинается заново.
        assert_eq!(
            tracker.press(t0 + Duration::from_millis(1700)),
            StopKind::Soft
        );
    }

    #[test]
    fn slow_presses_stay_soft() {
        let mut tracker = StopTracker::default();
        let t0 = Instant::now();
        assert_eq!(tracker.press(t0), StopKind::Soft);
        assert_eq!(tracker.press(t0 + Duration::from_secs(3)), StopKind::Soft);
        assert_eq!(tracker.press(t0 + Duration::from_secs(6)), StopKind::Soft);
    }
}
