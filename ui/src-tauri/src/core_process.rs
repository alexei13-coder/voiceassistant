//! Процесс ядра: запуск в отдельной группе процессов (Job Object на Windows), разбор stdout,
//! перезапуск после падения, аварийный стоп и корректное завершение (docs/protocol.md §2–§4).

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Mutex, TryLockError};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::async_runtime::{self, Receiver};
use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::process::{CommandChild, CommandEvent, TerminatedPayload};
use tauri_plugin_shell::ShellExt;
use tokio::sync::{watch, Mutex as AsyncMutex};

use crate::core_protocol::{CoreMessage, ShellMessage};
use crate::line_buffer::LineBuffer;
use crate::logging::CORE_TARGET;
use crate::restart_policy::RestartPolicy;
use crate::stop::{StopKind, StopTracker};
use crate::token::IpcToken;
use crate::{core_command, hotkeys, lock, window};

const CORE_STATUS_EVENT: &str = "core-status";
const PROTOCOL_VERSION: u32 = 1;
const READY_TIMEOUT: Duration = Duration::from_secs(20);
const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);
/// Сколько ждать, пока поток записи в stdin отпустит процесс ядра, прежде чем убить ядро по PID.
const CHILD_LOCK_WAIT: Duration = Duration::from_secs(1);
const CHILD_LOCK_POLL: Duration = Duration::from_millis(50);
/// Сколько последних строк stderr показать в логе оболочки, если ядро упало:
/// при сбое до настройки логирования ядра (например, в сборке PyInstaller) больше их нигде нет.
const STDERR_TAIL_LINES: usize = 20;
const GAVE_UP_MESSAGE: &str = "Ядро постоянно падает — смотрите logs/core.log и logs/shell.log. \
                               Двойное нажатие «Стоп» перезапустит его.";
/// Код выхода ядра «ошибка аргументов» (docs/configuration.md). argparse печатает причину
/// только в stderr, а его хвост попадает в лог оболочки.
const BAD_ARGUMENTS_EXIT_CODE: i32 = 2;
const BAD_ARGUMENTS_MESSAGE: &str = "Ядро не приняло параметры запуска — смотрите logs/shell.log";

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum CoreStatus {
    Starting,
    Ready,
    Crashed,
    Restarting,
    Fatal,
}

#[derive(Debug, Clone, Serialize)]
struct CoreStatusEvent {
    status: CoreStatus,
    message: Option<String>,
}

/// Ответ команды `core_connection`.
#[derive(Serialize)]
pub struct CoreConnection {
    port: u16,
    token: String,
}

#[derive(Debug, Clone)]
enum Readiness {
    Pending,
    Ready(u16),
    /// Ядро остановлено и само не поднимется до аварийного стопа: оно прислало `fatal`,
    /// не запустилось или падало раз за разом. UI получает статус `fatal` с этим сообщением.
    Failed(String),
}

#[derive(Debug, Default)]
struct Lifecycle {
    /// Номер текущего процесса. События процессов с другим номером (уже убитых) игнорируются.
    generation: u64,
    /// Текущий процесс прислал `fatal`: его завершение — не повод для перезапуска.
    fatal: bool,
    restarts: RestartPolicy,
}

pub struct CoreManager {
    app: AppHandle,
    token: IpcToken,
    /// Упорядочивает «убить — запустить»: аварийный стоп, перезапуск после падения и выход
    /// не должны пересекаться, иначе можно получить два ядра или ядро после выхода.
    transitions: AsyncMutex<()>,
    state: Mutex<Lifecycle>,
    child: Arc<Mutex<Option<CommandChild>>>,
    /// PID процесса в `child`, 0 — ядро не запущено. По нему ядро убивается, даже когда `child`
    /// занят зависшей записью в stdin (см. `take_child`).
    child_pid: AtomicU32,
    /// Очередь строк в stdin ядра. Пишет отдельный поток: обработчики клавиш и трея работают
    /// в главном потоке и не должны ждать канал.
    stdin: mpsc::Sender<Vec<u8>>,
    readiness: watch::Sender<Readiness>,
    /// Наибольший номер процесса, который уже завершился.
    exited: watch::Sender<u64>,
    quitting: AtomicBool,
    quit_finished: AtomicBool,
    stop_presses: Mutex<StopTracker>,
}

impl CoreManager {
    pub fn new(app: AppHandle) -> Result<Arc<Self>, Box<dyn std::error::Error>> {
        let child = Arc::new(Mutex::new(None));
        Ok(Arc::new(Self {
            app,
            token: IpcToken::generate()?,
            transitions: AsyncMutex::new(()),
            state: Mutex::default(),
            stdin: spawn_stdin_writer(Arc::clone(&child))?,
            child,
            child_pid: AtomicU32::new(0),
            readiness: watch::Sender::new(Readiness::Pending),
            exited: watch::Sender::new(0),
            quitting: AtomicBool::new(false),
            quit_finished: AtomicBool::new(false),
            stop_presses: Mutex::default(),
        }))
    }

    pub async fn start(self: Arc<Self>) {
        let _transition = self.transitions.lock().await;
        self.emit(CoreStatus::Starting, None);
        self.spawn_locked();
    }

    /// Порт и токен для UI; ждёт `ready` не дольше 20 с.
    pub async fn connection(&self) -> Result<CoreConnection, String> {
        const TIMEOUT_MESSAGE: &str = "Ядро не ответило за 20 секунд — смотрите logs/core.log";
        let mut readiness = self.readiness.subscribe();
        let settled = tokio::time::timeout(
            READY_TIMEOUT,
            readiness.wait_for(|state| !matches!(state, Readiness::Pending)),
        )
        .await;
        let state = match settled {
            Ok(Ok(state)) => state.clone(),
            Ok(Err(_)) => return Err("Оболочка завершает работу".into()),
            Err(_) => return Err(TIMEOUT_MESSAGE.into()),
        };
        match state {
            Readiness::Ready(port) => Ok(CoreConnection {
                port,
                token: self.token.as_str().to_owned(),
            }),
            Readiness::Failed(message) => {
                // Событие могло уйти до того, как UI подписался (например, `fatal` при старте),
                // поэтому каждый отказ повторяет его: так UI покажет причину, а не «нет связи».
                self.emit(CoreStatus::Fatal, Some(message.clone()));
                Err(message)
            }
            Readiness::Pending => Err(TIMEOUT_MESSAGE.into()),
        }
    }

    /// Аварийный стоп: убить всё дерево процессов ядра и запустить его заново.
    pub async fn emergency_restart(self: &Arc<Self>) {
        let _transition = self.transitions.lock().await;
        if self.is_quitting() {
            return;
        }
        log::warn!("Аварийный стоп: дерево процессов ядра убивается и запускается заново");
        self.readiness.send_replace(Readiness::Pending);
        self.emit(CoreStatus::Restarting, None);
        self.kill_child().await;
        // Ручной перезапуск (в том числе из `fatal`) начинает новую серию попыток: иначе после
        // отказа первое же падение снова оставило бы ядро остановленным, без перезапусков.
        lock(&self.state).restarts.reset();
        self.spawn_locked();
    }

    /// «Стоп» из трея или горячей клавиши; второе нажатие за 2 с — аварийный стоп.
    pub fn request_stop(self: &Arc<Self>, soft: ShellMessage) {
        let kind = lock(&self.stop_presses).press(Instant::now());
        match kind {
            StopKind::Soft => self.send(&soft),
            StopKind::Emergency => {
                let this = Arc::clone(self);
                async_runtime::spawn(async move { this.emergency_restart().await });
            }
        }
    }

    /// Отправить сообщение в stdin ядра. Если ядро сейчас не запущено, сообщение теряется:
    /// новое ядро начинает с чистого состояния, и старые нажатия ему не нужны.
    pub fn send(&self, message: &ShellMessage) {
        log::debug!("→ ядро: {message:?}");
        if self.stdin.send(message.to_line()).is_err() {
            log::warn!("Поток записи в stdin ядра остановлен");
        }
    }

    /// Отмечает начало выхода из приложения. `false` — выход уже начат.
    pub fn begin_quit(&self) -> bool {
        !self.quitting.swap(true, Ordering::SeqCst)
    }

    /// Ядро уже остановлено, приложению можно завершаться.
    pub fn quit_finished(&self) -> bool {
        self.quit_finished.load(Ordering::SeqCst)
    }

    /// Корректное завершение: `shutdown` в stdin, до 2 с на выход, затем принудительно.
    pub async fn shutdown(&self) {
        let _transition = self.transitions.lock().await;
        let generation = lock(&self.state).generation;
        // По PID, а не по `child`: его может держать зависшая запись в stdin.
        let running = self.child_pid.load(Ordering::SeqCst) != 0;
        if running {
            self.send(&ShellMessage::Shutdown);
            let mut exited = self.exited.subscribe();
            let graceful =
                tokio::time::timeout(SHUTDOWN_GRACE, exited.wait_for(|&last| last >= generation))
                    .await
                    .is_ok_and(|waited| waited.is_ok());
            if graceful {
                log::info!("Ядро завершилось по запросу");
            } else {
                log::warn!("Ядро не завершилось за 2 с — останавливается принудительно");
            }
            // И после штатного выхода: в группе могли остаться дочерние процессы.
            self.kill_child().await;
        }
        self.quit_finished.store(true, Ordering::SeqCst);
    }

    /// Последний рубеж при выходе из цикла событий: синхронно убить то, что осталось.
    pub fn kill_now(&self) {
        let pid = self.child_pid.swap(0, Ordering::SeqCst);
        if pid == 0 {
            return;
        }
        if let Some(child) = take_child(&self.child, pid) {
            if let Err(err) = child.kill() {
                log::warn!("Не удалось остановить ядро при выходе: {err}");
            }
        }
    }

    fn is_quitting(&self) -> bool {
        self.quitting.load(Ordering::SeqCst)
    }

    fn is_current(&self, generation: u64) -> bool {
        lock(&self.state).generation == generation
    }

    /// Запуск нового процесса. Вызывать только под `transitions`.
    fn spawn_locked(self: &Arc<Self>) {
        if self.is_quitting() {
            return;
        }
        let generation = {
            let mut state = lock(&self.state);
            state.generation += 1;
            state.fatal = false;
            state.generation
        };
        self.readiness.send_replace(Readiness::Pending);
        match self.spawn_process() {
            Ok((events, child)) => {
                let pid = child.pid();
                log::info!("Ядро запущено, pid {pid}");
                // `child` сейчас пуст (прежний процесс забрал kill_child), поэтому поток записи
                // не держит его долго и блокировка здесь не зависнет.
                *lock(&self.child) = Some(child);
                self.child_pid.store(pid, Ordering::SeqCst);
                let this = Arc::clone(self);
                async_runtime::spawn(async move { this.pump(generation, events).await });
            }
            Err(message) => {
                log::error!("{message}");
                self.fail(message);
            }
        }
    }

    fn spawn_process(&self) -> Result<(Receiver<CommandEvent>, CommandChild), String> {
        let spec = core_command::resolve(&self.app)?;
        log::info!(
            "Запуск ядра: {} {:?}",
            spec.program.to_string_lossy(),
            spec.args
        );
        let mut command = self
            .app
            .shell()
            .command(&spec.program)
            .args(&spec.args)
            .env("SWYVORN_IPC_TOKEN", self.token.as_str())
            .env("PYTHONUTF8", "1")
            // Байты как есть: строки собирает LineBuffer, а не плагин.
            .set_raw_out(true)
            // Job Object на Windows / группа процессов в POSIX: kill() убивает всё дерево PyInstaller.
            .set_process_group(true);
        if let Some(dir) = &spec.current_dir {
            command = command.current_dir(dir);
        }
        command
            .spawn()
            .map_err(|err| format!("Не удалось запустить ядро: {err}"))
    }

    /// Читает события процесса до его завершения. stdout и stderr читаются постоянно,
    /// иначе ядро повиснет на переполненном канале.
    async fn pump(self: Arc<Self>, generation: u64, mut events: Receiver<CommandEvent>) {
        let mut stdout = LineBuffer::default();
        let mut stderr = LineBuffer::default();
        let mut stderr_tail = VecDeque::with_capacity(STDERR_TAIL_LINES);
        let mut exit = None;
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(chunk) => {
                    for line in stdout.push(&chunk) {
                        self.handle_stdout_line(generation, &line);
                    }
                }
                CommandEvent::Stderr(chunk) => {
                    for line in stderr.push(&chunk) {
                        self.handle_stderr_line(&line, &mut stderr_tail);
                    }
                }
                CommandEvent::Error(err) => log::warn!("Ошибка канала ядра: {err}"),
                CommandEvent::Terminated(payload) => exit = Some(payload),
                _ => {}
            }
        }
        if let Some(line) = stdout.finish() {
            self.handle_stdout_line(generation, &line);
        }
        if let Some(line) = stderr.finish() {
            self.handle_stderr_line(&line, &mut stderr_tail);
        }
        self.exited
            .send_modify(|last| *last = (*last).max(generation));
        self.on_exit(generation, exit, stderr_tail).await;
    }

    fn handle_stdout_line(&self, generation: u64, line: &str) {
        let line = line.trim();
        if line.is_empty() {
            return;
        }
        match serde_json::from_str::<CoreMessage>(line) {
            Ok(message) => self.handle_message(generation, message),
            Err(err) => {
                let shown: String = self.token.redact(line).chars().take(200).collect();
                log::warn!("Непонятная строка в stdout ядра ({err}): {shown}");
            }
        }
    }

    fn handle_message(&self, generation: u64, message: CoreMessage) {
        if !self.is_current(generation) {
            return;
        }
        match message {
            CoreMessage::Ready {
                port,
                protocol,
                hotkeys,
            } => {
                if protocol != PROTOCOL_VERSION {
                    log::warn!(
                        "Ядро говорит на протоколе {protocol}, оболочка — на {PROTOCOL_VERSION}"
                    );
                }
                log::info!("Ядро готово, порт {port}");
                self.readiness.send_replace(Readiness::Ready(port));
                self.emit(CoreStatus::Ready, None);
                // Регистрация ждёт главный поток — не держим им рабочий поток асинхронного рантайма.
                let app = self.app.clone();
                async_runtime::spawn_blocking(move || hotkeys::apply(&app, &hotkeys));
            }
            CoreMessage::ShowWindow => window::reveal(&self.app),
            CoreMessage::Fatal { message } => {
                log::error!("Фатальная ошибка ядра: {message}");
                lock(&self.state).fatal = true;
                self.fail(message);
            }
        }
    }

    fn handle_stderr_line(&self, line: &str, tail: &mut VecDeque<String>) {
        let line = self.token.redact(line.trim_end());
        if line.is_empty() {
            return;
        }
        log::debug!(target: CORE_TARGET, "{line}");
        if tail.len() == STDERR_TAIL_LINES {
            tail.pop_front();
        }
        tail.push_back(line.into_owned());
    }

    async fn on_exit(
        self: Arc<Self>,
        generation: u64,
        exit: Option<TerminatedPayload>,
        stderr_tail: VecDeque<String>,
    ) {
        let transition = self.transitions.lock().await;
        let fatal = {
            let state = lock(&self.state);
            if state.generation != generation || self.is_quitting() {
                // Процесс убит намеренно (аварийный стоп или выход) — реагировать не на что.
                return;
            }
            state.fatal
        };
        // Лидер группы завершился; добиваем возможных потомков и освобождаем дескрипторы.
        self.kill_child().await;
        if fatal {
            log::info!("Ядро завершилось после фатальной ошибки — без перезапуска");
            return;
        }

        let reason = describe_exit(exit.as_ref());
        log::error!("Ядро аварийно завершилось: {reason}");
        for line in &stderr_tail {
            log::warn!(target: CORE_TARGET, "stderr: {line}");
        }
        let code = exit.as_ref().and_then(|payload| payload.code);
        let delay = restart_delay(code, &mut lock(&self.state).restarts, Instant::now());
        let delay = match delay {
            Ok(delay) => delay,
            Err(message) => {
                log::error!("{message}");
                self.fail(message.into());
                return;
            }
        };
        self.readiness.send_replace(Readiness::Pending);
        self.emit(CoreStatus::Crashed, Some(reason));
        let retired = lock(&self.state).generation;
        drop(transition);

        log::info!("Перезапуск ядра через {} с", delay.as_secs());
        tokio::time::sleep(delay).await;
        let _transition = self.transitions.lock().await;
        // За время паузы ядро могли уже перезапустить аварийным стопом или начать выход.
        if lock(&self.state).generation != retired || self.is_quitting() {
            return;
        }
        self.emit(CoreStatus::Restarting, None);
        self.spawn_locked();
    }

    /// Убивает текущий процесс со всей группой и делает его события устаревшими.
    async fn kill_child(&self) {
        lock(&self.state).generation += 1;
        let pid = self.child_pid.swap(0, Ordering::SeqCst);
        if pid == 0 {
            return;
        }
        let child = Arc::clone(&self.child);
        // Ожидание `child` и kill() (он ждёт завершения процесса) — блокирующие вызовы.
        let stopped = async_runtime::spawn_blocking(move || match take_child(&child, pid) {
            Some(child) => child.kill(),
            None => Ok(()),
        });
        match stopped.await {
            Ok(Ok(())) => log::info!("Процессы ядра остановлены, pid {pid}"),
            Ok(Err(err)) => log::warn!("Не удалось остановить ядро, pid {pid}: {err}"),
            Err(err) => log::warn!("Остановка ядра прервана, pid {pid}: {err}"),
        }
    }

    /// Ядро остаётся остановленным до аварийного стопа (он запускает его заново),
    /// UI показывает «Ядро не запускается» с этой причиной.
    fn fail(&self, message: String) {
        self.readiness
            .send_replace(Readiness::Failed(message.clone()));
        self.emit(CoreStatus::Fatal, Some(message));
    }

    fn emit(&self, status: CoreStatus, message: Option<String>) {
        log::debug!("core-status: {status:?} {message:?}");
        let event = CoreStatusEvent { status, message };
        if let Err(err) = self.app.emit(CORE_STATUS_EVENT, event) {
            log::warn!("Не удалось отправить core-status: {err}");
        }
    }
}

fn spawn_stdin_writer(
    child: Arc<Mutex<Option<CommandChild>>>,
) -> std::io::Result<mpsc::Sender<Vec<u8>>> {
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    std::thread::Builder::new()
        .name("core-stdin".into())
        .spawn(move || {
            for line in rx {
                let mut child = lock(&child);
                match child.as_mut() {
                    Some(child) => {
                        if let Err(err) = child.write(&line) {
                            log::warn!("Не удалось отправить сообщение ядру: {err}");
                        }
                    }
                    None => log::debug!("Ядро не запущено — сообщение отброшено"),
                }
            }
        })?;
    Ok(tx)
}

/// Забирает процесс ядра из `slot`, не завися от потока записи в stdin. Тот держит `slot`
/// всю запись, а запись в канал (буфер ~4 КиБ на Windows) встаёт, пока ядро не читает stdin, —
/// зависшее ядро заблокировало бы так и аварийный стоп, и выход. Поэтому `slot` ждём не дольше
/// `CHILD_LOCK_WAIT`, а затем убиваем дерево процессов по `pid`: канал рвётся, запись
/// завершается ошибкой, и поток отпускает `slot`.
fn take_child<T>(slot: &Mutex<Option<T>>, pid: u32) -> Option<T> {
    let deadline = Instant::now() + CHILD_LOCK_WAIT;
    loop {
        match slot.try_lock() {
            Ok(mut guard) => return guard.take(),
            Err(TryLockError::Poisoned(poisoned)) => return poisoned.into_inner().take(),
            Err(TryLockError::WouldBlock) if Instant::now() < deadline => {
                std::thread::sleep(CHILD_LOCK_POLL);
            }
            Err(TryLockError::WouldBlock) => break,
        }
    }
    log::warn!("Ядро не читает stdin — дерево процессов убивается по pid {pid}");
    if let Err(err) = kill_tree(pid) {
        log::warn!("Не удалось убить ядро по pid {pid}: {err}");
    }
    lock(slot).take()
}

/// Убивает ядро вместе с потомками в обход `CommandChild` (см. `take_child`).
#[cfg(windows)]
fn kill_tree(pid: u32) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};

    // Без этого флага у консольной taskkill мелькнуло бы окно.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    // PID не достанется чужому процессу: `CommandChild` в `child` держит открытый дескриптор ядра.
    let taskkill = std::env::var_os("SystemRoot")
        .map(|root| PathBuf::from(root).join("System32").join("taskkill.exe"))
        .unwrap_or_else(|| "taskkill.exe".into());
    let status = Command::new(taskkill)
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(std::io::Error::other(format!("taskkill: {status}")))
    }
}

/// Убивает ядро вместе с потомками в обход `CommandChild` (см. `take_child`).
#[cfg(unix)]
fn kill_tree(pid: u32) -> std::io::Result<()> {
    // Ядро — лидер своей группы процессов (`set_process_group`), номер группы равен его PID.
    // 0 означал бы собственную группу оболочки.
    let pgid = libc::pid_t::try_from(pid)
        .ok()
        .filter(|&pgid| pgid > 0)
        .ok_or(std::io::ErrorKind::InvalidInput)?;
    // SAFETY: killpg только отправляет сигнал и не трогает память процесса.
    if unsafe { libc::killpg(pgid, libc::SIGKILL) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// Пауза перед перезапуском упавшего ядра или причина больше его не запускать:
/// её показывают как `fatal`, и ядро ждёт аварийного стопа.
fn restart_delay(
    code: Option<i32>,
    restarts: &mut RestartPolicy,
    now: Instant,
) -> Result<Duration, &'static str> {
    if code == Some(BAD_ARGUMENTS_EXIT_CODE) {
        // С теми же аргументами ядро откажет снова — перезапуск только скрыл бы причину.
        return Err(BAD_ARGUMENTS_MESSAGE);
    }
    restarts.next_delay(now).ok_or(GAVE_UP_MESSAGE)
}

/// Короткое описание причины выхода для `core-status` (UI показывает его в баннере).
fn describe_exit(exit: Option<&TerminatedPayload>) -> String {
    match exit {
        // NTSTATUS-коды Windows (0xC0000005 и т.п.) приходят отрицательными — в hex они узнаваемее.
        Some(TerminatedPayload {
            code: Some(code), ..
        }) if *code < 0 => format!("код выхода 0x{:08X}", *code as u32),
        Some(TerminatedPayload {
            code: Some(code), ..
        }) => format!("код выхода {code}"),
        Some(TerminatedPayload {
            signal: Some(signal),
            ..
        }) => format!("сигнал {signal}"),
        _ => "причина неизвестна".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exit(code: Option<i32>, signal: Option<i32>) -> TerminatedPayload {
        TerminatedPayload { code, signal }
    }

    #[test]
    fn describes_exit_reason() {
        assert_eq!(describe_exit(Some(&exit(Some(1), None))), "код выхода 1");
        assert_eq!(
            describe_exit(Some(&exit(Some(-1073741819), None))),
            "код выхода 0xC0000005"
        );
        assert_eq!(describe_exit(Some(&exit(None, Some(9)))), "сигнал 9");
        assert_eq!(describe_exit(None), "причина неизвестна");
    }

    #[test]
    fn core_status_event_matches_protocol() {
        let event = CoreStatusEvent {
            status: CoreStatus::Restarting,
            message: None,
        };
        assert_eq!(
            serde_json::to_string(&event).unwrap(),
            r#"{"status":"restarting","message":null}"#
        );
    }

    #[test]
    fn gives_up_as_fatal_until_manual_restart() {
        let mut restarts = RestartPolicy::default();
        let now = Instant::now();
        for _ in 0..5 {
            assert!(restart_delay(Some(1), &mut restarts, now).is_ok());
        }
        // Шестое падение за минуту — отказ: ядро ждёт аварийного стопа, а не «перезапускаю…».
        assert_eq!(
            restart_delay(Some(1), &mut restarts, now),
            Err(GAVE_UP_MESSAGE)
        );
        // Аварийный стоп сбрасывает счётчик: новое ядро снова перезапускается после падения.
        restarts.reset();
        assert_eq!(
            restart_delay(None, &mut restarts, now),
            Ok(Duration::from_secs(1))
        );
    }

    #[test]
    fn bad_arguments_are_fatal_without_spending_attempts() {
        let mut restarts = RestartPolicy::default();
        let now = Instant::now();
        assert_eq!(
            restart_delay(Some(BAD_ARGUMENTS_EXIT_CODE), &mut restarts, now),
            Err(BAD_ARGUMENTS_MESSAGE)
        );
        assert_eq!(
            restart_delay(Some(1), &mut restarts, now),
            Ok(Duration::from_secs(1))
        );
    }

    #[test]
    fn takes_free_child_without_killing() {
        let slot = Mutex::new(Some("ядро"));
        let started = Instant::now();
        // PID 0: если бы take_child дошёл до kill_tree, тот бы отказался.
        assert_eq!(take_child(&slot, 0), Some("ядро"));
        assert!(started.elapsed() < CHILD_LOCK_WAIT);
        assert_eq!(take_child(&slot, 0), None);
    }

    /// Ядро, которое не читает stdin, не должно блокировать остановку: поток записи
    /// висит на полном канале с захваченным `child`, а take_child всё равно его забирает.
    #[cfg(unix)]
    #[test]
    fn hung_stdin_write_does_not_block_kill() {
        use std::io::Write;
        use std::os::unix::process::{CommandExt, ExitStatusExt};
        use std::process::{Command, Stdio};

        let child = Command::new("sleep")
            .arg("30")
            .stdin(Stdio::piped())
            .process_group(0)
            .spawn()
            .unwrap();
        let pid = child.id();
        let slot = Arc::new(Mutex::new(Some(child)));
        let (locked_tx, locked_rx) = mpsc::channel();
        let writer = {
            let slot = Arc::clone(&slot);
            std::thread::spawn(move || {
                let mut guard = lock(&slot);
                let stdin = guard.as_mut().unwrap().stdin.as_mut().unwrap();
                locked_tx.send(()).unwrap();
                // Намного больше буфера канала: `sleep` его не читает, запись встаёт.
                stdin.write_all(&vec![b'\n'; 1 << 20])
            })
        };
        locked_rx.recv().unwrap();

        let started = Instant::now();
        let mut child = take_child(&slot, pid).expect("процесс забран из slot");
        assert!(started.elapsed() >= CHILD_LOCK_WAIT);
        assert!(
            writer.join().unwrap().is_err(),
            "запись прервана разрывом канала"
        );
        assert_eq!(child.wait().unwrap().signal(), Some(libc::SIGKILL));
    }
}
