# Протокол обмена (версия 2)

Этот документ — единственный источник правды о том, как общаются три части приложения:

```
┌──────────── UI (React в WebView2) ────────────┐
│  только показывает события и шлёт команды     │
└───────▲───────────────────────────┬───────────┘
        │ WebSocket 127.0.0.1        │ Tauri invoke / events
        │ (события ядра, команды UI) │ (порт, токен, аварийный стоп, окно)
┌───────┴────────────┐       ┌──────▼─────────────────────────┐
│ Python-ядро        │◄─────►│ Rust-оболочка Tauri            │
│ (вся логика)       │ stdio │ (трей, горячие клавиши, запуск │
└────────────────────┘ JSONL │  и аварийная остановка ядра)   │
                             └────────────────────────────────┘
```

Решения о рисках и выполнении действий принимает **только ядро**. UI и оболочка ничего не выполняют сами.

---

## 1. WebSocket: ядро ⇄ UI

### 1.1 Подключение и защита

- Адрес: `ws://127.0.0.1:<port>/ws`. Ядро слушает **только** `127.0.0.1`.
- Порт:
  - в продакшене — случайный свободный (`--port 0`), ядро сообщает его оболочке сообщением `ready` (см. §2);
  - в режиме разработки — `--port` (по умолчанию `8765`).
- **Проверка Origin при рукопожатии.** Разрешённые значения:
  - всегда: `http://tauri.localhost`, `https://tauri.localhost`, `tauri://localhost`;
  - только с флагом `--dev`: `http://localhost:1420`, `http://127.0.0.1:1420`.
  - Любой другой Origin, а также отсутствующий заголовок Origin → HTTP `403`, соединение не открывается.
- **Токен.** Первое сообщение клиента обязано быть `{"type":"auth","token":"<token>"}` и прийти в течение **3 секунд**. Иначе или при неверном токене соединение закрывается с кодом `4401`.
  - Сравнение токена — только через `hmac.compare_digest`.
  - Токен передаётся ядру в переменной окружения `SWYVORN_IPC_TOKEN`. В режиме `--dev` без этой переменной ядро генерирует токен само и печатает его в **stderr** (stdout зарезервирован, см. §2).
  - Прочитав токен и ключ API, ядро удаляет `SWYVORN_IPC_TOKEN` и `ANTHROPIC_API_KEY` из окружения своего процесса: дальше они живут только в памяти, и дочерние процессы ядра (например, PowerShell на этапе 4) их не наследуют.
  - Токен никогда не пишется в лог (фильтр секретов вырезает его).
- Максимум **4** одновременных клиента; пятый закрывается с кодом `4429`.
- Максимальный размер сообщения от клиента — **64 КиБ**; больше → закрытие с кодом `1009`.
- После успешного `auth` ядро присылает `hello` (снимок состояния), затем поток событий.

### 1.2 Конверт

Каждое сообщение — JSON-объект с полем `type` (строка). Сообщения ядра дополнительно содержат `ts` — время отправки в миллисекундах Unix epoch.

- Неизвестный `type` от клиента → `error` с `code: "unknown_type"`.
- Невалидный JSON или неверные поля → `error` с `code: "bad_message"`.
- Команда, недоступная в текущем режиме (например `demo` без демо-режима) → `error` с `code: "not_allowed"`.
- Неожиданная ошибка в обработчике команды → `error` с `code: "internal"`; соединение остаётся открытым.
- Клиент, который не успевает принимать события, отключается с кодом `1013` (сначала отбрасываются устаревшие `audio_level` и `metrics`). Он должен переподключиться и получит свежий `hello`.

### 1.3 Состояния ассистента

| `state` | Подпись в UI | Смысл |
|---|---|---|
| `idle` | ОЖИДАНИЕ | ждёт слова-триггера или команды |
| `listening` | СЛУШАЮ | записывает речь пользователя |
| `thinking` | ДУМАЮ | запрос к модели / обработка |
| `speaking` | ГОВОРЮ | озвучивает ответ |
| `awaiting_confirmation` | ЖДУ ПОДТВЕРЖДЕНИЯ | ждёт «да»/кнопку для рискованного действия |
| `executing` | ВЫПОЛНЯЮ | выполняется инструмент |
| `error` | ОШИБКА | кратковременная индикация ошибки |
| `stopped` | ОСТАНОВЛЕНО | сработала кнопка «Стоп»; через ~0,8 с ядро само переходит в `idle` |

Разрешённые переходы (ядро обязано их соблюдать, всё прочее — ошибка программы):

```
idle                  → listening, thinking, speaking, executing, error, stopped
listening             → idle, thinking, error, stopped
thinking              → idle, speaking, awaiting_confirmation, executing, listening, error, stopped
speaking              → idle, listening, thinking, awaiting_confirmation, executing, error, stopped
awaiting_confirmation → idle, executing, speaking, error, stopped
executing             → idle, thinking, speaking, error, stopped
error                 → idle, stopped
stopped               → idle
```

Переход в то же состояние — не ошибка, а no-op (событие не отправляется).

### 1.4 Типы данных

```ts
type AssistantState = 'idle' | 'listening' | 'thinking' | 'speaking'
  | 'awaiting_confirmation' | 'executing' | 'error' | 'stopped'

type Risk = 'safe' | 'confirm' | 'forbidden'

interface ChatMessage {
  id: string                       // уникальный, генерирует ядро
  role: 'user' | 'assistant' | 'system'
  text: string
  streaming: boolean               // true, пока идут chat_delta
  created_at: number               // ms epoch
}

interface ActionEntry {
  id: string
  created_at: number               // ms epoch
  tool: string                     // машинное имя инструмента, напр. "weather"
  title: string                    // человеческое описание по-русски
  risk: Risk
  status: 'pending' | 'awaiting_confirmation' | 'running' | 'ok' | 'error'
        | 'denied' | 'cancelled' | 'timeout' | 'forbidden' | 'stopped'
  decision?: 'auto' | 'confirmed_voice' | 'confirmed_button' | 'confirmed_text'
           | 'denied' | 'timeout' | 'unclear' | 'forbidden' | 'stopped'
  detail?: string | null           // результат или причина
  duration_ms?: number | null
  demo?: boolean                   // true — демонстрационная запись, ничего не выполнялось
}

interface ConfirmationRequest {
  action_id: string
  nonce: string                    // одноразовый; подтверждение без него не принимается
  title: string                    // "Переместить в корзину 3 файла"
  spoken_text: string              // что ассистент произносит вслух
  details: string[]                // полный список объектов/параметров для экрана
  command: string | null           // полный текст команды терминала, если есть
  command_language: 'powershell' | null
  code_analysis: string[]          // что выяснил код (не модель)
  model_explanation: string | null // объяснение модели, помечается «может быть неточным»
  risk: 'confirm'
  button_only: boolean             // true — голосового или текстового «да» недостаточно, нужна кнопка; «нет» — любым способом (проверяет ядро)
  timeout_ms: number               // 15000
  expires_at: number | null        // ms epoch; null, пока вопрос ещё произносится
  demo: boolean
}

interface Metrics {
  cpu_percent: number              // 0..100
  ram_percent: number              // 0..100
  ram_used_mb: number
  ram_total_mb: number
  net_up_bps: number               // байт/с
  net_down_bps: number             // байт/с
  uptime_s: number                 // сколько работает ядро
  time_iso: string                 // локальное время с часовым поясом, ISO 8601
}

interface Hotkeys {
  activate: string                 // "Ctrl+Alt+J"
  stop: string                     // "Ctrl+Alt+Escape"
  stop_fallback: string            // "Ctrl+Alt+Backspace"
  mute: string                     // "Ctrl+Alt+M"
  repeat: string                   // "Ctrl+Alt+R"
  screen: string                   // "Ctrl+Alt+S"
}

// ---- этап 2: «мозг» (docs/brain.md) ----

type BrainStatus = 'ready' | 'no_key' | 'invalid_key' | 'offline' | 'limit' | 'demo'

interface BrainInfo {
  status: BrainStatus
  model: string                    // "claude-opus-5-5"
  web_search: boolean              // включён ли поиск в интернете
  message: string | null           // пояснение по-русски для статусов кроме ready/demo
}

interface UsageTotals {
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  web_searches: number
  cost_usd: number                 // оценка по таблице цен
}

interface MemoryFact {
  key: string                      // snake_case, напр. "address_form"
  value: string
  updated_at: number               // ms epoch
}
```

Протокол версии 2 = версия 1 + поля и сообщения этапа 2 (`brain`, `usage`, `memory`). Обе стороны собираются вместе, поэтому совместимость со старой версией не поддерживается.

### 1.5 Сообщения ядро → UI

| `type` | Поля | Когда |
|---|---|---|
| `hello` | `protocol: 2`, `core_version`, `state`, `demo: bool`, `assistant_name`, `wake_word` (произношение имени кириллицей, напр. «Свайворн»), `address_form`, `model`, `hotkeys: Hotkeys`, `ui: {reduced_motion: bool}`, `muted: bool`, `history: ChatMessage[]` (последние ≤ 100), `actions: ActionEntry[]` (последние ≤ 200), `confirmation: ConfirmationRequest \| null`, `brain: BrainInfo`, `usage: {session: UsageTotals, month: UsageTotals, monthly_limit_usd: number}` (0 — без лимита), `memory: MemoryFact[]` | сразу после успешного `auth` |
| `state` | `state`, `reason: string \| null` | при каждом переходе |
| `audio_level` | `source: 'mic' \| 'tts'`, `level: number` (0..1) | не чаще 30 раз в секунду, только в `listening` (mic) и `speaking` (tts) |
| `metrics` | все поля `Metrics` | раз в секунду |
| `chat_message` | `message: ChatMessage` | создать или заменить сообщение по `id` |
| `chat_delta` | `id`, `delta: string` | дописать текст к сообщению |
| `chat_done` | `id` | сообщение завершено (`streaming = false`) |
| `action` | `entry: ActionEntry` | создать или обновить запись журнала по `id` |
| `confirmation_request` | `request: ConfirmationRequest` | нужно подтверждение |
| `confirmation_countdown` | `action_id`, `expires_at` | вопрос договорён, пошёл отсчёт 15 с |
| `confirmation_resolved` | `action_id`, `outcome: 'confirmed' \| 'denied' \| 'timeout' \| 'cancelled' \| 'stopped' \| 'superseded'`, `via: 'voice' \| 'button' \| 'text' \| null` | подтверждение закрыто |
| `muted` | `muted: bool` | микрофон выключен/включён |
| `brain_status` | `brain: BrainInfo` | статус «мозга» изменился |
| `usage` | `session: UsageTotals`, `month: UsageTotals`, `last_turn: UsageTotals`, `monthly_limit_usd: number` | после каждого ответа Claude |
| `memory` | `facts: MemoryFact[]` (весь список) | долговременная память изменилась |
| `session_reset` | — | начат новый диалог: UI очищает ленту |
| `notice` | `level: 'info' \| 'warning' \| 'error'`, `text`, `code: string \| null` | всплывающее уведомление. Коды: `muted`, `demo_voice`, `hotkey_unavailable`, `not_available_yet`; этап 2: `brain_no_key`, `brain_invalid_key`, `brain_offline`, `brain_limit`, `brain_credit`, `brain_overloaded`, `brain_rate_limited`, `brain_model_access`, `brain_refusal`, `brain_error`. Уведомления о незарегистрированных горячих клавишах повторяются каждому новому клиенту сразу после `hello` |
| `stopped` | `source: 'button' \| 'hotkey' \| 'voice' \| 'tray' \| 'emergency'` | сработал «Стоп» |
| `pong` | — | ответ на `ping` |
| `error` | `code`, `message` | ошибка протокола |

### 1.6 Сообщения UI → ядро

| `type` | Поля | Действие ядра |
|---|---|---|
| `auth` | `token` | только первым сообщением |
| `send_text` | `text` (1..4000 символов после `strip`) | новая реплика пользователя |
| `confirm` | `action_id`, `nonce`, `decision: 'yes' \| 'no'` | принять/отклонить. Неверный `action_id` или `nonce`, истёкший срок, повтор → `error` с `code: "stale_confirmation"`, ничего не выполняется |
| `stop` | `source: 'button'` (необязательно, по умолчанию `button`) | немедленный «Стоп» (§3) |
| `mic` | `action: 'toggle' \| 'ptt_down' \| 'ptt_up'` | кнопка микрофона (на этапе 1 — демо-переход в `listening`) |
| `mute` | `muted: bool` | выключить/включить микрофон |
| `ping` | — | `pong` |
| `demo` | `action: 'start' \| 'stop' \| 'set_state' \| 'confirmation' \| 'error_flash'`, `state?: AssistantState` | только в демо-режиме: управление сценарием (для скриншотов и проверки) |
| `new_session` | — | начать новый диалог: история сессии очищается (долговременная память остаётся), всем клиентам — `session_reset` |
| `memory_delete` | `key` | удалить факт из долговременной памяти (действие пользователя, без подтверждения) |
| `memory_clear` | — | очистить долговременную память (UI сам спрашивает подтверждение у пользователя) |

**`button_only` проверяет ядро, а не UI.** На запрос с `button_only: true` ядро принимает только ответ кнопкой — сообщение `confirm` (в `confirmation_resolved` это `via: "button"`): «да» голосом или текстом отклоняется, а запрос остаётся ожидающим — до нажатия кнопки, тайм-аута или «Стопа». «Нет» принимается любым способом: отказ ничего не выполняет.

---

## 2. stdio: Rust-оболочка ⇄ ядро

- Формат: JSON Lines в UTF-8, один объект на строку. Ядро запускается с `PYTHONUTF8=1`.
- **stdout ядра зарезервирован только под этот канал.** Все логи ядра идут в stderr и в файл.
- Оболочка обязана постоянно читать stdout и stderr ядра, чтобы не заполнился буфер.

### 2.1 Ядро → оболочка (stdout)

| `type` | Поля | Смысл |
|---|---|---|
| `ready` | `port`, `protocol: 2`, `hotkeys: Hotkeys` | WebSocket слушает; оболочка регистрирует горячие клавиши и отдаёт порт UI |
| `show_window` | — | показать и сфокусировать окно (ядро шлёт его, в частности, на `hotkey/activate`) |
| `fatal` | `message` (по-русски) | ядро сейчас завершится с ошибкой; оболочка не перезапускает его и передаёт сообщение UI (`core-status` `fatal`, §4) |

### 2.2 Оболочка → ядро (stdin)

| `type` | Поля | Смысл |
|---|---|---|
| `hotkey` | `action: 'activate' \| 'ptt_down' \| 'ptt_up' \| 'stop' \| 'mute_toggle' \| 'repeat' \| 'screen'` | нажата горячая клавиша |
| `hotkey_error` | `action`, `combo`, `error` | не удалось зарегистрировать сочетание |
| `tray` | `action: 'stop' \| 'mute_toggle'` | пункт меню трея |
| `shutdown` | — | корректное завершение в течение 2 с |

- **EOF на stdin = завершиться** (оболочка упала — ядро не должно остаться сиротой).
- Флаг `--no-stdin` отключает канал (для запуска ядра без оболочки при разработке).

### 2.3 Горячая клавиша активации

Оболочка сама различает короткое нажатие и удержание `activate`-сочетания:

- отпущено раньше 350 мс → `hotkey/activate`;
- удерживается ≥ 350 мс → `hotkey/ptt_down` в момент 350 мс, затем `hotkey/ptt_up` при отпускании.

---

## 3. «Стоп»

Источники: кнопка в UI (`stop`), горячая клавиша (`hotkey/stop`), трей (`tray/stop`), голос (этап 3).

Ядро за < 100 мс:

1. отменяет все задачи текущего хода (демо-сценарий, запрос к модели, речь, инструмент);
2. закрывает ожидающее подтверждение с `outcome: "stopped"`;
3. помечает выполняющиеся записи журнала статусом `stopped`;
4. переходит в `stopped`, рассылает `stopped`, через ~0,8 с переходит в `idle`.

Таймеры и напоминания «Стоп» не трогает.

**Аварийный стоп.** Оболочка убивает всё дерево процессов ядра (Job Object) и запускает его заново, UI получает Tauri-событие `core-status` (§4) и переподключается. Когда он срабатывает, зависит от источника:

- **кнопка «Стоп» в UI** — UI сам следит за ответом ядра и вызывает команду `emergency_stop` (§4), если нет связи с ядром, если за 1 с после `stop` не пришло ни `stopped`, ни смены состояния, или если кнопку нажали второй раз за 2 с;
- **горячая клавиша и трей** — оболочка ответа ядра не отслеживает: первое нажатие уходит ядру обычным `hotkey/stop` / `tray/stop`, аварийный стоп — второе нажатие (горячей клавишей или в трее) в течение 2 с.

Аварийный стоп — и единственный способ поднять ядро из состояния `fatal` (§4).

---

## 4. Tauri-команды и события (оболочка ⇄ UI)

| Имя | Вид | Описание |
|---|---|---|
| `core_connection` | команда → `{port: number, token: string}` | ждёт `ready` от ядра (до 20 с), возвращает текущий порт и токен |
| `emergency_stop` | команда → `void` | аварийный стоп: убить дерево процессов ядра и перезапустить |
| `core-status` | событие `{status: 'starting' \| 'ready' \| 'crashed' \| 'restarting' \| 'fatal', message: string \| null}` | состояние процесса ядра |

- За `crashed` (в `message` — причина: код выхода или сигнал) всегда следует `restarting`: оболочка перезапускает упавшее ядро с паузой 1, 2, 4… с.
- `fatal` (в `message` — причина по-русски) означает, что ядро остановлено и **само не поднимется**, пока не будет вызван `emergency_stop` (двойной «Стоп», §3). Так бывает, когда процесс ядра не удалось запустить, ядро прислало `fatal` (§2.1), не приняло аргументы запуска (код выхода `2`) или когда оболочка сдалась после повторных падений: за минуту ядро упало больше 5 раз. Пока ядро в `fatal`, `core_connection` сразу возвращает ошибку с этим же текстом и повторяет событие `fatal`. Аварийный стоп начинает счёт падений заново.

Управление окном (свернуть, развернуть, спрятать в трей) UI делает через `@tauri-apps/api/window`.

---

## 5. Демо-режим (этап 1)

Пока нет «мозга» и голоса, ядро с `[demo] enabled = true` (по умолчанию на этапе 1) проигрывает сценарий, чтобы проверить интерфейс:

1. `idle` 4 с;
2. `listening` 3 с — синтетический уровень микрофона, похожий на речь;
3. реплика пользователя «Свайворн, какая сегодня погода?»;
4. `thinking` 2,5 с;
5. `speaking` ~5 с — ответ печатается потоково, уровень голоса синхронизирован с текстом; в журнал добавляется демо-запись инструмента `weather` (`risk: safe`, `status: ok`);
6. `idle` 4 с;
7. `listening` → реплика «Удали старые скриншоты из „Загрузок“» → `thinking` → `speaking` («Нашёл 3 файла… Вы уверены, {обращение}?»);
8. `awaiting_confirmation` — `confirmation_request` (`demo: true`, `timeout_ms: 15000`), затем `confirmation_countdown`;
9. ответ кнопкой или тайм-аут → запись журнала обновляется, при «да» — `executing` 1,5 с с пометкой «Демо: ничего не удалялось»;
10. `speaking` («Готово» / «Отменено») → `idle` → сценарий повторяется.

Во всех демо-записях `demo: true`, **никакие реальные действия не выполняются**.

Кнопка микрофона и `hotkey/activate` на этапе 1 имитируют прослушивание: `listening` ~4 с (или до повторного нажатия / `ptt_up`), затем `thinking`, информационное уведомление и `idle`. Если микрофон выключен (`muted`), показывается только предупреждение, а сценарий ждёт в `idle` перед каждым шагом прослушивания.

`send_text` в демо-режиме: реплика пользователя → `thinking` 1,2 с → потоковый ответ «Это демонстрационный режим: мозг подключим на этапе 2. Вы написали: „…“».

`demo/set_state` останавливает сценарий и ставит заданное состояние (для скриншотов). `demo/start` запускает сценарий заново.
