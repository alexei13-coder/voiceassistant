// Данные имитации ядра (?mock=1): стартовая лента, журнал, память, расходы и заготовленные ответы
// для каждого статуса «мозга». Поведение — в mockCore.ts.

import { memoryKeyLabel } from '../labels'
import type {
  ActionEntry,
  BrainInfo,
  BrainStatus,
  ChatMessage,
  ConfirmationRequest,
  MemoryFact,
  UsageTotals,
} from '../protocol'

export const MOCK_MODEL = 'claude-opus-5-5'

/** Тексты как в docs/brain.md («Ошибки API»). */
const BRAIN_MESSAGES: Record<BrainStatus, string | null> = {
  ready: null,
  demo: null,
  no_key:
    'Ключ API не задан. Добавьте строку ANTHROPIC_API_KEY=… в %APPDATA%\\Swyvorn\\.env — ядро подхватит её без перезапуска.',
  invalid_key: 'Ключ API не подошёл. Проверьте его в console.anthropic.com → API Keys.',
  offline: 'Нет связи с Claude. Проверьте интернет.',
  limit: 'Достигнут месячный лимит расходов ($5). Поднимите [llm] monthly_limit_usd в settings.toml или дождитесь нового месяца.',
}

export function brainInfo(status: BrainStatus): BrainInfo {
  return { status, model: MOCK_MODEL, web_search: true, message: BRAIN_MESSAGES[status] }
}

/** Статусы, в которых «Claude» отвечает (offline — запрос всё равно уходит). */
export function canAnswer(status: BrainStatus): boolean {
  return status === 'ready' || status === 'offline'
}

// ---------- расходы ----------

export function totals(cost: number, tokens: Partial<Omit<UsageTotals, 'cost_usd'>> = {}): UsageTotals {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    web_searches: 0,
    ...tokens,
    cost_usd: cost,
  }
}

export function addTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_tokens: a.cache_read_tokens + b.cache_read_tokens,
    cache_write_tokens: a.cache_write_tokens + b.cache_write_tokens,
    web_searches: a.web_searches + b.web_searches,
    cost_usd: a.cost_usd + b.cost_usd,
  }
}

/** Условные цены имитации, $ за миллион токенов; настоящая таблица — в ядре. */
const PRICE_PER_MTOK = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }

/** Расход одного ответа: системный промпт читается из кэша, растут вход и выход. */
export function turnUsage(promptChars: number, replyChars: number): UsageTotals {
  const input = 1200 + Math.ceil(promptChars / 3)
  const output = 40 + Math.ceil(replyChars / 3)
  const cacheRead = 6_200
  const cost =
    (input * PRICE_PER_MTOK.input + output * PRICE_PER_MTOK.output + cacheRead * PRICE_PER_MTOK.cacheRead) / 1_000_000
  return totals(cost, { input_tokens: input, output_tokens: output, cache_read_tokens: cacheRead })
}

export interface UsageSeed {
  session: UsageTotals
  month: UsageTotals
  limit: number
}

export function seedUsage(status: BrainStatus): UsageSeed {
  const session = totals(0.021, { input_tokens: 2_460, output_tokens: 318, cache_read_tokens: 12_400, cache_write_tokens: 1_850 })
  const month = totals(0.37, {
    input_tokens: 38_900,
    output_tokens: 6_120,
    cache_read_tokens: 214_000,
    cache_write_tokens: 21_300,
    web_searches: 4,
  })
  switch (status) {
    case 'ready':
    case 'offline':
      return { session, month, limit: 5 }
    case 'limit':
      return { session, month: { ...month, cost_usd: 5.02 }, limit: 5 }
    default:
      return { session: totals(0), month: totals(0), limit: 0 }
  }
}

// ---------- память ----------

export function seedMemory(status: BrainStatus, now: number): MemoryFact[] {
  if (status === 'no_key') return []
  const at = now - 14 * 60_000
  return [
    { key: 'address_form', value: 'шеф', updated_at: at },
    { key: 'user_name', value: 'Алексей', updated_at: at },
  ]
}

// ---------- лента и журнал ----------

export const PORTS_ANSWER = [
  'Встроенной командой `Get-NetTCPConnection`, шеф:',
  '',
  '- **слушающие порты** — `-State Listen`;',
  '- *активные соединения* — `-State Established`;',
  '- процесс по номеру — `Get-Process -Id <PID>`.',
  '',
  '```powershell',
  'Get-NetTCPConnection -State Listen |',
  '  Sort-Object LocalPort |',
  '  Select-Object LocalAddress, LocalPort, OwningProcess',
  '```',
  '',
  'Подробнее — в [документации Microsoft](https://learn.microsoft.com/powershell/module/nettcpip/get-nettcpconnection).',
].join('\n')

/** Живой ход при запуске: вопрос → «печатает» → потоковый ответ. */
export const OPENING_QUESTION = 'А какой процесс держит порт 8080?'
export const OPENING_ANSWER = [
  'Одной строкой:',
  '',
  '```powershell',
  'Get-Process -Id (Get-NetTCPConnection -LocalPort 8080).OwningProcess',
  '```',
  '',
  'Если порт свободен, команда вернёт ошибку — значит, его никто не занял.',
].join('\n')

/** Ответ на произвольную реплику: честно признаётся, что это имитация, и подсказывает, что попробовать. */
export function genericAnswer(text: string): string {
  return [
    `Это имитация ядра, шеф: настоящий Claude здесь не отвечает. Вы написали: „${text}“.`,
    '',
    '| Попробуйте | Что будет |',
    '|---|---|',
    '| «запомни, …» | факт появится в «Памяти» |',
    '| «Стоп» во время ответа | ответ оборвётся с пометкой |',
  ].join('\n')
}

/** «запомни, что …» → значение для памяти (до 200 символов, как в ядре). */
export function rememberRequest(text: string): string | null {
  const match = /^запомни[,:]?\s+(?:что\s+)?(.+)$/is.exec(text.trim())
  return match ? match[1].trim().slice(0, 200) : null
}

type NextId = (prefix: string) => string

export function seedHistory(status: BrainStatus, now: number, nextId: NextId): ChatMessage[] {
  const min = 60_000
  const msg = (role: ChatMessage['role'], text: string, ago: number): ChatMessage => ({
    id: nextId('m'),
    role,
    text,
    streaming: false,
    created_at: now - ago,
  })
  switch (status) {
    case 'no_key':
      return []
    case 'invalid_key':
      return [msg('user', 'Привет! Ты на связи?', 2 * min), msg('system', BRAIN_MESSAGES.invalid_key ?? '', 2 * min - 1500)]
    case 'demo':
      return [
        msg('system', 'Демо-режим: голос и «мозг» подключим на следующих этапах. Реальные действия не выполняются.', 9 * min),
        msg('user', 'Какая сейчас загрузка процессора?', 8 * min),
        msg('assistant', 'Процессор загружен на 18\u00a0%, память — на 43\u00a0%. Всё в норме, сэр.', 8 * min - 4000),
        msg('user', 'Открой папку «Загрузки»', 5 * min),
        msg('assistant', 'Открываю «Загрузки».', 5 * min - 2500),
      ]
    default:
      return [
        msg('user', 'Привет! Обращайся ко мне «шеф». Меня зовут Алексей.', 14 * min),
        msg('assistant', 'Принято, шеф. Запомнил и обращение, и имя.', 14 * min - 3000),
        msg('user', 'Как в PowerShell посмотреть, какие порты сейчас заняты?', 6 * min),
        msg('assistant', PORTS_ANSWER, 6 * min - 5000),
      ]
  }
}

/** Запись журнала об инструменте памяти remember (риск safe — без подтверждения). */
export function rememberEntry(id: string, createdAt: number, key: string, value: string): ActionEntry {
  return {
    id,
    created_at: createdAt,
    tool: 'remember',
    title: `Запомнить: ${memoryKeyLabel(key)} — «${value}»`,
    risk: 'safe',
    status: 'ok',
    decision: 'auto',
    detail: null,
    duration_ms: 3,
  }
}

export function seedActions(status: BrainStatus, now: number, nextId: NextId): ActionEntry[] {
  const min = 60_000
  if (status === 'no_key' || status === 'invalid_key') return []
  if (status !== 'demo') {
    const at = now - 14 * min + 2000
    return [
      rememberEntry(nextId('a'), at, 'address_form', 'шеф'),
      rememberEntry(nextId('a'), at + 1, 'user_name', 'Алексей'),
    ]
  }
  const entry = (e: Omit<ActionEntry, 'id' | 'demo'>): ActionEntry => ({ ...e, id: nextId('a'), demo: true })
  return [
    entry({
      created_at: now - 8 * min,
      tool: 'system.metrics',
      title: 'Показатели системы',
      risk: 'safe',
      status: 'ok',
      decision: 'auto',
      detail: 'ЦП 18 %, ОЗУ 43 %',
      duration_ms: 12,
    }),
    entry({
      created_at: now - 5 * min,
      tool: 'files.open',
      title: 'Открыть папку «Загрузки»',
      risk: 'safe',
      status: 'ok',
      decision: 'auto',
      detail: null,
      duration_ms: 230,
    }),
    entry({
      created_at: now - 3 * min,
      tool: 'shell.run',
      title: 'Очистить кэш DNS',
      risk: 'confirm',
      status: 'denied',
      decision: 'denied',
      detail: 'Отклонено пользователем',
      duration_ms: null,
    }),
    entry({
      created_at: now - 2 * min,
      tool: 'registry.write',
      title: 'Изменить автозапуск в реестре',
      risk: 'forbidden',
      status: 'forbidden',
      decision: 'forbidden',
      detail: 'Запись в реестр запрещена политикой безопасности',
      duration_ms: null,
    }),
  ]
}

// ---------- подтверждение (демо этапа 1) ----------

export function confirmationRequest(id: string, buttonOnly: boolean): ConfirmationRequest {
  return {
    action_id: id,
    nonce: `nonce-${id}-${Math.random().toString(36).slice(2, 10)}`,
    title: 'Переместить в корзину 3 файла',
    spoken_text: 'Нашёл 3 старых скриншота в «Загрузках». Переместить их в корзину?',
    details: [
      'C:\\Users\\Пользователь\\Downloads\\Снимок экрана 2026-08-02 101512.png — 1,2 МБ',
      'C:\\Users\\Пользователь\\Downloads\\Снимок экрана 2026-08-14 184033.png — 860 КБ',
      'C:\\Users\\Пользователь\\Downloads\\Снимок экрана 2026-09-01 090207.png — 2,4 МБ',
    ],
    command:
      "Get-ChildItem -LiteralPath \"$env:USERPROFILE\\Downloads\" -Filter 'Снимок экрана*.png' | " +
      'Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } | ' +
      "ForEach-Object { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($_.FullName, 'OnlyErrorDialogs', 'SendToRecycleBin') }",
    command_language: 'powershell',
    code_analysis: [
      'Затрагивает только 3 файла в папке «Загрузки»',
      'Файлы попадают в корзину — их можно восстановить',
      'Нет сетевых обращений и повышения прав',
    ],
    model_explanation: 'Команда находит скриншоты старше 30 дней и отправляет их в корзину.',
    risk: 'confirm',
    button_only: buttonOnly,
    timeout_ms: 15_000,
    expires_at: null,
    demo: true,
  }
}
