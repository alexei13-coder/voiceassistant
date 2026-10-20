//! Команды для UI (docs/protocol.md §4). Разрешены только окну `main` (capabilities/default.json).

use std::sync::Arc;

use tauri::State;

use crate::core_process::{CoreConnection, CoreManager};

/// Порт и токен WebSocket ядра; ждёт готовности ядра до 20 с.
#[tauri::command]
pub async fn core_connection(core: State<'_, Arc<CoreManager>>) -> Result<CoreConnection, String> {
    core.connection().await
}

/// Аварийный стоп: убить дерево процессов ядра и запустить его заново.
#[tauri::command]
pub async fn emergency_stop(core: State<'_, Arc<CoreManager>>) -> Result<(), String> {
    core.emergency_restart().await;
    Ok(())
}
