//! Когда перезапускать упавшее ядро: экспоненциальная пауза и не больше N попыток за окно.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

const MAX_RESTARTS: usize = 5;
const WINDOW: Duration = Duration::from_secs(60);
const BASE_DELAY: Duration = Duration::from_secs(1);

#[derive(Debug, Default)]
pub struct RestartPolicy {
    recent: VecDeque<Instant>,
}

impl RestartPolicy {
    /// Пауза перед следующим перезапуском (1 с, 2 с, 4 с…) или `None`, если за последнюю
    /// минуту попыток уже было слишком много и ядро надо оставить упавшим.
    pub fn next_delay(&mut self, now: Instant) -> Option<Duration> {
        while self
            .recent
            .front()
            .is_some_and(|&at| now.duration_since(at) >= WINDOW)
        {
            self.recent.pop_front();
        }
        if self.recent.len() >= MAX_RESTARTS {
            return None;
        }
        let delay = BASE_DELAY * (1 << self.recent.len());
        self.recent.push_back(now);
        Some(delay)
    }

    /// Забыть прошлые попытки: после ручного перезапуска счёт начинается заново.
    pub fn reset(&mut self) {
        self.recent.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backs_off_exponentially_then_gives_up() {
        let mut policy = RestartPolicy::default();
        let start = Instant::now();
        let delays: Vec<_> = (0..5)
            .map(|i| policy.next_delay(start + Duration::from_secs(i)).unwrap())
            .collect();
        assert_eq!(
            delays,
            [1, 2, 4, 8, 16].map(Duration::from_secs).to_vec(),
            "пауза удваивается"
        );
        assert_eq!(policy.next_delay(start + Duration::from_secs(10)), None);
    }

    #[test]
    fn forgets_attempts_older_than_window() {
        let mut policy = RestartPolicy::default();
        let start = Instant::now();
        for i in 0..5 {
            policy.next_delay(start + Duration::from_secs(i)).unwrap();
        }
        // Через минуту после первой попытки освобождается одно место, пауза — по оставшимся.
        assert_eq!(
            policy.next_delay(start + Duration::from_secs(60)),
            Some(Duration::from_secs(16))
        );
        // Долгая стабильная работа сбрасывает счётчик полностью.
        assert_eq!(
            policy.next_delay(start + Duration::from_secs(600)),
            Some(Duration::from_secs(1))
        );
    }

    #[test]
    fn reset_allows_restarts_after_giving_up() {
        let mut policy = RestartPolicy::default();
        let start = Instant::now();
        while policy.next_delay(start).is_some() {}
        policy.reset();
        assert_eq!(policy.next_delay(start), Some(Duration::from_secs(1)));
    }
}
