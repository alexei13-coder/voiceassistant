// Мост к Rust-оболочке Tauri. Вне Tauri (обычный браузер при разработке) — заглушки.
// Имена команд и событий — docs/protocol.md §4.

import type { CoreConnectionInfo, CoreStatusEvent } from '../protocol'

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** Порт и токен WebSocket ядра. В Tauri — от оболочки, в браузере — из переменных Vite или URL. */
export async function getCoreConnection(): Promise<CoreConnectionInfo> {
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core')
    return invoke<CoreConnectionInfo>('core_connection')
  }
  const params = new URLSearchParams(window.location.search)
  const port = Number(params.get('port') ?? import.meta.env.VITE_CORE_PORT ?? 8765)
  const token = params.get('token') ?? import.meta.env.VITE_CORE_TOKEN ?? ''
  return { port, token }
}

/** Аварийный стоп: оболочка убивает дерево процессов ядра и перезапускает его. */
export async function emergencyStop(): Promise<boolean> {
  if (!isTauri()) return false
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('emergency_stop')
  return true
}

/** Подписка на состояние процесса ядра. Возвращает функцию отписки. */
export async function onCoreStatus(cb: (e: CoreStatusEvent) => void): Promise<() => void> {
  if (!isTauri()) return () => {}
  const { listen } = await import('@tauri-apps/api/event')
  return listen<CoreStatusEvent>('core-status', (event) => cb(event.payload))
}

export const windowControls = {
  async minimize(): Promise<void> {
    if (!isTauri()) return
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    await getCurrentWindow().minimize()
  },
  async toggleMaximize(): Promise<void> {
    if (!isTauri()) return
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    await getCurrentWindow().toggleMaximize()
  },
  /** Закрыть окно = спрятать в трей (ассистент продолжает работать). */
  async hideToTray(): Promise<void> {
    if (!isTauri()) return
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    await getCurrentWindow().hide()
  },
}
