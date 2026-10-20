import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoreConnectionInfo, CoreStatusEvent, ServerMessage } from '../protocol'
import type { ConnectionStatus } from '../store'
import {
  BACKOFF_MAX_MS,
  BACKOFF_MIN_MS,
  CLOSE_UNAUTHORIZED,
  CoreConnection,
  PING_INTERVAL_MS,
  UNAUTHORIZED_RETRY_MS,
  backoffDelay,
  parseServerMessage,
  type SocketHandlers,
  type SocketLike,
} from './connection'

describe('backoffDelay', () => {
  it('удваивается от 250 мс до 5 с', () => {
    const mid = () => 0.5
    expect(backoffDelay(0, mid)).toBe(250)
    expect(backoffDelay(1, mid)).toBe(500)
    expect(backoffDelay(3, mid)).toBe(2000)
    expect(backoffDelay(10, mid)).toBe(BACKOFF_MAX_MS)
  })

  it('разброс ±20 % не выходит за пределы', () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      for (const r of [0, 0.25, 0.75, 0.999]) {
        const d = backoffDelay(attempt, () => r)
        expect(d).toBeGreaterThanOrEqual(BACKOFF_MIN_MS)
        expect(d).toBeLessThanOrEqual(BACKOFF_MAX_MS)
      }
    }
    expect(backoffDelay(2, () => 0)).toBe(800)
    expect(backoffDelay(2, () => 0.999)).toBe(1200)
  })
})

describe('parseServerMessage', () => {
  it('отбрасывает всё, кроме объекта со строковым type', () => {
    expect(parseServerMessage('{oops')).toBeNull()
    expect(parseServerMessage('42')).toBeNull()
    expect(parseServerMessage('null')).toBeNull()
    expect(parseServerMessage('[{"type":"pong"}]')).toBeNull()
    expect(parseServerMessage('{"ts":1}')).toBeNull()
    expect(parseServerMessage('{"type":7}')).toBeNull()
    expect(parseServerMessage(new ArrayBuffer(4))).toBeNull()
  })

  it('принимает корректное сообщение', () => {
    expect(parseServerMessage('{"type":"pong","ts":1}')).toEqual({ type: 'pong', ts: 1 })
  })
})

class FakeSocket implements SocketLike {
  readonly sent: Array<Record<string, unknown>> = []
  closedWith: number | null = null
  private opened = false
  readonly url: string
  private readonly handlers: SocketHandlers

  constructor(url: string, handlers: SocketHandlers) {
    this.url = url
    this.handlers = handlers
  }

  isOpen = () => this.opened && this.closedWith === null
  send = (data: string) => {
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }
  close = (code: number) => {
    this.closedWith = code
  }

  serverOpen(): void {
    this.opened = true
    this.handlers.onOpen()
  }
  serverSend(raw: unknown): void {
    this.handlers.onMessage(typeof raw === 'string' ? raw : JSON.stringify(raw))
  }
  serverClose(code: number): void {
    this.opened = false
    this.handlers.onClose(code)
  }
}

const HELLO = { type: 'hello', ts: 1 }

function setup(
  endpoints: CoreConnectionInfo[] = [{ port: 9001, token: 'secret' }],
  onMessage?: (m: ServerMessage) => void,
) {
  const sockets: FakeSocket[] = []
  const statuses: ConnectionStatus[] = []
  const messages: ServerMessage[] = []
  const processes: CoreStatusEvent[] = []
  let coreStatusCb: ((e: CoreStatusEvent) => void) | null = null
  let call = 0
  const getConnection = vi.fn(async () => endpoints[Math.min(call++, endpoints.length - 1)])
  const conn = new CoreConnection({
    getConnection,
    createSocket: (url, handlers) => {
      const s = new FakeSocket(url, handlers)
      sockets.push(s)
      return s
    },
    subscribeCoreStatus: async (cb) => {
      coreStatusCb = cb
      return () => {
        coreStatusCb = null
      }
    },
    onMessage: onMessage ?? ((m) => messages.push(m)),
    onStatus: (s) => statuses.push(s),
    onCoreProcess: (e) => processes.push(e),
    random: () => 0.5,
  })
  const emitCoreStatus = (e: CoreStatusEvent) => coreStatusCb?.(e)
  const last = () => sockets[sockets.length - 1]
  return { conn, sockets, statuses, messages, processes, getConnection, emitCoreStatus, last }
}

const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms)

describe('CoreConnection', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('первым сообщением шлёт auth, связь считается установленной после hello', async () => {
    const t = setup()
    t.conn.start()
    t.conn.start() // StrictMode: повторный запуск ничего не делает
    await tick()
    expect(t.sockets).toHaveLength(1)
    expect(t.last().url).toBe('ws://127.0.0.1:9001/ws')

    t.last().serverOpen()
    expect(t.last().sent[0]).toEqual({ type: 'auth', token: 'secret' })
    expect(t.conn.send({ type: 'ping' })).toBe(false)

    t.last().serverSend(HELLO)
    expect(t.statuses).toEqual(['connected'])
    expect(t.messages.map((m) => m.type)).toEqual(['hello'])
    expect(t.conn.send({ type: 'send_text', text: 'привет' })).toBe(true)
    expect(t.last().sent[1]).toEqual({ type: 'send_text', text: 'привет' })
    t.conn.dispose()
  })

  it('мусорные кадры игнорируются, ошибка обработчика не рвёт связь', async () => {
    const t = setup()
    t.conn.start()
    await tick()
    t.last().serverOpen()
    t.last().serverSend('not json')
    t.last().serverSend({ no: 'type' })
    expect(t.messages).toHaveLength(0)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bad = setup(undefined, () => {
      throw new Error('boom')
    })
    bad.conn.start()
    await tick()
    bad.last().serverOpen()
    expect(() => bad.last().serverSend(HELLO)).not.toThrow()
    expect(bad.statuses).toEqual(['connected'])
    warn.mockRestore()
    t.conn.dispose()
    bad.conn.dispose()
  })

  it('4401 → «ошибка доступа» и медленный повтор через 10 с', async () => {
    const t = setup()
    t.conn.start()
    await tick()
    t.last().serverOpen()
    t.last().serverClose(CLOSE_UNAUTHORIZED)
    expect(t.statuses).toEqual(['unauthorized'])

    await tick(UNAUTHORIZED_RETRY_MS - 1)
    expect(t.sockets).toHaveLength(1)
    await tick(1)
    expect(t.sockets).toHaveLength(2)
    expect(t.getConnection).toHaveBeenCalledTimes(2)
    t.conn.dispose()
  })

  it('обрыв → «нет связи», нарастающая пауза и новый порт на каждой попытке', async () => {
    const t = setup([
      { port: 9001, token: 'a' },
      { port: 9002, token: 'b' },
      { port: 9003, token: 'c' },
    ])
    t.conn.start()
    await tick()
    t.last().serverOpen()
    t.last().serverSend(HELLO)
    t.last().serverClose(1006)
    expect(t.statuses).toEqual(['connected', 'disconnected'])
    expect(t.conn.send({ type: 'ping' })).toBe(false)

    await tick(249)
    expect(t.sockets).toHaveLength(1)
    await tick(1)
    expect(t.last().url).toBe('ws://127.0.0.1:9002/ws')

    t.last().serverClose(1006)
    await tick(499)
    expect(t.sockets).toHaveLength(2)
    await tick(1)
    expect(t.last().url).toBe('ws://127.0.0.1:9003/ws')

    // Успешный hello сбрасывает паузу к минимальной.
    t.last().serverOpen()
    expect(t.last().sent[0]).toEqual({ type: 'auth', token: 'c' })
    t.last().serverSend(HELLO)
    t.last().serverClose(1006)
    await tick(250)
    expect(t.sockets).toHaveLength(4)
    t.conn.dispose()
  })

  it('ошибка получения порта тоже ведёт к повтору', async () => {
    const t = setup()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    t.getConnection.mockRejectedValueOnce(new Error('ядро не готово'))
    t.conn.start()
    await tick()
    expect(t.sockets).toHaveLength(0)
    expect(t.statuses).toEqual(['disconnected'])
    await tick(250)
    expect(t.sockets).toHaveLength(1)
    warn.mockRestore()
    t.conn.dispose()
  })

  it('ping раз в 10 с; три пропущенных pong — соединение мёртвое', async () => {
    const t = setup()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    t.conn.start()
    await tick()
    t.last().serverOpen()
    t.last().serverSend(HELLO)
    const first = t.last()

    await tick(PING_INTERVAL_MS)
    expect(first.sent.at(-1)).toEqual({ type: 'ping' })
    first.serverSend({ type: 'pong', ts: 2 })

    await tick(PING_INTERVAL_MS * 3)
    expect(first.closedWith).toBeNull()
    expect(first.sent.filter((m) => m.type === 'ping')).toHaveLength(4)

    await tick(PING_INTERVAL_MS)
    expect(first.closedWith).not.toBeNull()
    expect(t.statuses.at(-1)).toBe('disconnected')
    await tick(250)
    expect(t.sockets).toHaveLength(2)
    warn.mockRestore()
    t.conn.dispose()
  })

  it('core-status: restarting переподключает сразу, ready — только при смене адреса', async () => {
    const t = setup([
      { port: 9001, token: 'a' },
      { port: 9001, token: 'a' },
      { port: 9005, token: 'z' },
    ])
    t.conn.start()
    await tick()
    t.last().serverOpen()
    t.last().serverSend(HELLO)

    t.emitCoreStatus({ status: 'ready', message: null })
    await tick()
    expect(t.sockets).toHaveLength(1)
    expect(t.processes).toEqual([{ status: 'ready', message: null }])

    t.emitCoreStatus({ status: 'restarting', message: 'аварийный стоп' })
    await tick()
    expect(t.sockets[0].closedWith).not.toBeNull()
    expect(t.sockets).toHaveLength(2)
    expect(t.last().url).toBe('ws://127.0.0.1:9005/ws')
    expect(t.statuses).toEqual(['connected', 'disconnected'])

    // Поздний close старого сокета не должен запускать лишний повтор.
    t.sockets[0].serverClose(1006)
    await tick(5000)
    expect(t.sockets).toHaveLength(2)
    t.conn.dispose()
  })

  it('dispose останавливает повторы и отписывается', async () => {
    const t = setup()
    t.conn.start()
    await tick()
    t.last().serverClose(1006)
    t.conn.dispose()
    await tick(10_000)
    expect(t.sockets).toHaveLength(1)
    t.emitCoreStatus({ status: 'ready', message: null })
    expect(t.processes).toHaveLength(0)
  })
})
