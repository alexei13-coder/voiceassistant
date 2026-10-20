//! Лог оболочки: `<папка данных>/logs/shell.log` рядом с `core.log` ядра, в отладке — ещё и консоль.

use std::path::PathBuf;

use log::LevelFilter;
use tauri::{plugin::TauriPlugin, AppHandle, Manager, Runtime};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};

/// Цель для строк stderr ядра. В релизе ядро само пишет их в `logs/core.log`,
/// поэтому в лог оболочки они попадают только в отладке.
pub const CORE_TARGET: &str = "core";

const DATA_DIR_ENV: &str = "SWYVORN_DATA_DIR";
const MAX_FILE_BYTES: u128 = 1024 * 1024;

pub fn plugin<R: Runtime>(app: &AppHandle<R>) -> TauriPlugin<R> {
    let mut targets = Vec::new();
    if cfg!(debug_assertions) {
        targets.push(Target::new(TargetKind::Stdout));
    }
    match data_dir(app) {
        Some(dir) => targets.push(Target::new(TargetKind::Folder {
            path: dir.join("logs"),
            file_name: Some("shell".into()),
        })),
        None => eprintln!("Папка данных не определена — лог оболочки пишется только в консоль"),
    }

    let (own_level, core_level) = if cfg!(debug_assertions) {
        (LevelFilter::Debug, LevelFilter::Debug)
    } else {
        (LevelFilter::Info, LevelFilter::Warn)
    };
    tauri_plugin_log::Builder::new()
        .clear_targets()
        .targets(targets)
        .level(LevelFilter::Warn)
        .level_for(env!("CARGO_CRATE_NAME"), own_level)
        .level_for(CORE_TARGET, core_level)
        .max_file_size(MAX_FILE_BYTES)
        .rotation_strategy(RotationStrategy::KeepSome(3))
        .timezone_strategy(TimezoneStrategy::UseLocal)
        .build()
}

/// Папка данных — по тем же правилам, что у ядра (docs/configuration.md):
/// `SWYVORN_DATA_DIR`, иначе `%APPDATA%\Swyvorn`, `~/.config/swyvorn`, `~/Library/Application Support/Swyvorn`.
fn data_dir<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    if let Some(dir) = std::env::var(DATA_DIR_ENV)
        .ok()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
    {
        return Some(PathBuf::from(dir));
    }
    let folder = if cfg!(target_os = "linux") {
        "swyvorn"
    } else {
        "Swyvorn"
    };
    app.path().config_dir().ok().map(|base| base.join(folder))
}
