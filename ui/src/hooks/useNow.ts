// Общий секундный «тик» для часов. Один таймер на всё приложение, перерисовываются
// только компоненты, которые вызвали useNow().

import { useSyncExternalStore } from 'react'

const listeners = new Set<() => void>()
let now = Date.now()
let timer: ReturnType<typeof setTimeout> | null = null

function schedule(): void {
  // Выравниваем по границе секунды, чтобы часы не отставали на долю секунды.
  timer = setTimeout(tick, 1000 - (Date.now() % 1000) + 5)
}

function tick(): void {
  now = Date.now()
  for (const listener of listeners) listener()
  schedule()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    now = Date.now()
    schedule()
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }
}

const getSnapshot = () => now

/** Текущее время (мс), обновляется раз в секунду. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot)
}
