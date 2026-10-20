// WebSocket-клиент ядра: авторизация токеном, переподключение с нарастающей паузой, пинг.
// Протокол — docs/protocol.md §1. Все сообщения ядра попадают в store.applyServerMessage.

import { getCoreConnection, onCoreStatus } from '../platform/tauri'
import type { ClientMessage, CoreConnectionInfo, CoreStatusEvent, ServerMessage } from '../protocol'
import { useJarvis, type ConnectionStatus } from '../store'

export const BACKOFF_MIN_MS = 250
export const BACKOFF_MAX_MS = 5000
export const UNAUTHORIZED_RETRY_MS = 10_000
export const PING_INTERVAL_MS = 10_000
export const MAX_MISSED_PONGS = 3
/** Код закрытия ядром при неверном или просроченном токене. */
export const CLOSE_UNAUTHORIZED = 4401
/** Код, которым клиент сам закрывает «мёртвое» или устаревшее соединение. */
const CLOSE_CLIENT_RESET = 4000

/** Пауза перед попыткой номер `attempt` (с нуля): 250 мс → 5 с, ±20 % разброса. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, attempt))
  // Разброс нужен, чтобы после перезапуска ядра окна не стучались в него строго синхронно.
  const jittered = base * (0.8 + 0.4 * random())
  return Math.round(Math.min(BACKOFF_MAX_MS, Math.max(BACKOFF_MIN_MS, jittered)))
}

/** Разбор кадра ядра. Всё, что не JSON-объект со строковым `type`, отбрасывается. */
export function parseServerMessage(data: unknown): ServerMessage | null {
  if (typeof data !== 'string') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  if (typeof (parsed as { type?: unknown }).type !== 'string') return null
  return parsed as ServerMessage
}

export interface SocketHandlers {
  onOpen: () => void
  onMessage: (data: unknown) => void
  onClose: (code: number) => void
}

/** Минимум от WebSocket, который нужен клиенту; в тестах подменяется. */
export interface SocketLike {
  isOpen: () => boolean
  send: (data: string) => void
  close: (code: number) => void
}

export type SocketFactory = (url: string, handlers: SocketHandlers) => SocketLike

export interface ConnectionDeps {
  getConnection: () => Promise<CoreConnectionInfo>
  createSocket: SocketFactory
  subscribeCoreStatus: (cb: (e: CoreStatusEvent) => void) => Promise<() => void>
  onMessage: (msg: ServerMessage) => void
  onStatus: (status: ConnectionStatus) => void
  onCoreProcess: (e: CoreStatusEvent) => void
  random?: () => number
}

function browserSocket(url: string, handlers: SocketHandlers): SocketLike {
  const ws = new WebSocket(url)
  ws.onopen = () => handlers.onOpen()
  ws.onmessage = (ev) => handlers.onMessage(ev.data)
  // onerror всегда сопровождается onclose — переподключение решается там.
  ws.onclose = (ev) => handlers.onClose(ev.code)
  return {
    isOpen: () => ws.readyState === WebSocket.OPEN,
    send: (data) => ws.send(data),
    close: (code) => ws.close(code),
  }
}

export class CoreConnection {
  private started = false
  private disposed = false
  /** Номер текущей попытки: обработчики старых сокетов и запоздавшие ответы игнорируются. */
  private generation = 0
  private socket: SocketLike | null = null
  private endpoint: CoreConnectionInfo | null = null
  private authenticated = false
  private attempt = 0
  private missedPongs = 0
  private status: ConnectionStatus = 'connecting'
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private unsubscribeCoreStatus: (() => void) | null = null

  constructor(private readonly deps: ConnectionDeps) {}

  /** Идемпотентно: повторный вызов (двойной mount в StrictMode) ничего не делает. */
  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    this.deps
      .subscribeCoreStatus((e) => this.handleCoreStatus(e))
      .then((unsubscribe) => {
        if (this.disposed) unsubscribe()
        else this.unsubscribeCoreStatus = unsubscribe
      })
      .catch((err: unknown) => console.warn('Не удалось подписаться на core-status', err))
    void this.connect()
  }

  dispose(): void {
    this.disposed = true
    this.clearRetry()
    this.dropSocket()
    this.unsubscribeCoreStatus?.()
    this.unsubscribeCoreStatus = null
  }

  /** false — нет авторизованного соединения, команда не отправлена. */
  send(msg: ClientMessage): boolean {
    const socket = this.socket
    if (!socket || !this.authenticated || !socket.isOpen()) return false
    try {
      socket.send(JSON.stringify(msg))
      return true
    } catch {
      return false
    }
  }

  private async connect(): Promise<void> {
    this.clearRetry()
    const generation = ++this.generation
    let endpoint: CoreConnectionInfo
    try {
      endpoint = await this.deps.getConnection()
    } catch (err) {
      if (generation !== this.generation || this.disposed) return
      console.warn('Ядро не сообщило порт', err)
      this.failAndRetry()
      return
    }
    if (generation !== this.generation || this.disposed) return
    this.endpoint = endpoint
    try {
      this.socket = this.deps.createSocket(`ws://127.0.0.1:${endpoint.port}/ws`, {
        onOpen: () => this.handleOpen(generation),
        onMessage: (data) => this.handleMessage(generation, data),
        onClose: (code) => this.handleClose(generation, code),
      })
    } catch (err) {
      console.warn('Не удалось открыть WebSocket', err)
      this.failAndRetry()
    }
  }

  private handleOpen(generation: number): void {
    if (generation !== this.generation || !this.socket || !this.endpoint) return
    this.socket.send(JSON.stringify({ type: 'auth', token: this.endpoint.token } satisfies ClientMessage))
    this.missedPongs = 0
    this.pingTimer = setInterval(() => this.heartbeat(), PING_INTERVAL_MS)
  }

  private handleMessage(generation: number, data: unknown): void {
    if (generation !== this.generation) return
    const msg = parseServerMessage(data)
    if (!msg) return
    if (msg.type === 'pong') this.missedPongs = 0
    if (msg.type === 'hello') {
      // hello приходит только после принятого токена — значит, связь установлена полностью.
      this.authenticated = true
      this.attempt = 0
      this.setStatus('connected')
    }
    try {
      this.deps.onMessage(msg)
    } catch (err) {
      // Битое по содержимому сообщение не должно ронять соединение.
      console.warn(`Не удалось применить сообщение ядра «${msg.type}»`, err)
    }
  }

  private handleClose(generation: number, code: number): void {
    if (generation !== this.generation) return
    this.dropSocket()
    if (code === CLOSE_UNAUTHORIZED) {
      this.setStatus('unauthorized')
      this.scheduleRetry(UNAUTHORIZED_RETRY_MS)
      return
    }
    this.failAndRetry()
  }

  private heartbeat(): void {
    // Считаем и до hello: открытый, но молчащий сокет тоже признак зависшего ядра.
    if (this.missedPongs >= MAX_MISSED_PONGS) {
      console.warn('Ядро не отвечает на ping — переподключаюсь')
      this.dropSocket()
      this.failAndRetry()
      return
    }
    this.missedPongs += 1
    try {
      this.socket?.send(JSON.stringify({ type: 'ping' } satisfies ClientMessage))
    } catch {
      // отправка не удалась — сокет закрывается, решение примет handleClose
    }
  }

  private handleCoreStatus(e: CoreStatusEvent): void {
    if (this.disposed) return
    this.deps.onCoreProcess(e)
    if (e.status === 'restarting') {
      this.reconnectNow()
      return
    }
    if (e.status !== 'ready') return
    if (this.status !== 'connected') {
      this.reconnectNow()
      return
    }
    // Ядро сообщило о готовности, а мы уже на связи: переподключаемся, только если сменился адрес.
    const current = this.endpoint
    this.deps
      .getConnection()
      .then((next) => {
        if (!current || next.port !== current.port || next.token !== current.token) this.reconnectNow()
      })
      .catch(() => this.reconnectNow())
  }

  private reconnectNow(): void {
    this.attempt = 0
    this.dropSocket()
    if (this.status === 'connected') this.setStatus('disconnected')
    void this.connect()
  }

  private failAndRetry(): void {
    this.setStatus('disconnected')
    this.scheduleRetry(backoffDelay(this.attempt, this.deps.random))
    this.attempt += 1
  }

  private scheduleRetry(delayMs: number): void {
    this.clearRetry()
    if (this.disposed) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.connect()
    }, delayMs)
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  /** Закрывает текущий сокет; его поздние события отсекаются сменой generation. */
  private dropSocket(): void {
    this.generation += 1
    if (this.pingTimer !== null) clearInterval(this.pingTimer)
    this.pingTimer = null
    this.authenticated = false
    const socket = this.socket
    this.socket = null
    if (socket) {
      try {
        socket.close(CLOSE_CLIENT_RESET)
      } catch {
        // сокет уже закрыт — это нормально
      }
    }
  }

  private setStatus(status: ConnectionStatus): void {
    if (status === this.status) return
    this.status = status
    this.deps.onStatus(status)
  }
}

// ---------- единственный экземпляр приложения ----------

type LocalCore = (msg: ClientMessage) => boolean

let instance: CoreConnection | null = null
let localCore: LocalCore | null = null

/** Запускает подключение к ядру. Повторные вызовы безопасны. */
export function startConnection(): void {
  if (instance) return
  const store = useJarvis.getState()
  instance = new CoreConnection({
    getConnection: getCoreConnection,
    createSocket: browserSocket,
    subscribeCoreStatus: onCoreStatus,
    onMessage: (msg) => useJarvis.getState().applyServerMessage(msg),
    onStatus: store.setConnection,
    onCoreProcess: (e) => store.setCoreProcess(e.status, e.message),
  })
  instance.start()
}

/** Отправить команду ядру. false — связи нет, команда не ушла. */
export function sendCommand(msg: ClientMessage): boolean {
  if (localCore) return localCore(msg)
  return instance?.send(msg) ?? false
}

/** Только для режима разработки ?mock=1: команды обрабатывает локальная имитация ядра. */
export function attachLocalCore(handler: LocalCore): void {
  localCore = handler
}
