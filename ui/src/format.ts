// Форматирование чисел, времени и дат для HUD. Русская локаль задана вручную, а не через Intl:
// так вывод одинаков в любом WebView2 и не зависит от языковых пакетов Windows.

const WEEKDAYS_FULL = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота']
const MONTHS_GENITIVE = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
]

const RATE_UNITS = ['КБ/с', 'МБ/с', 'ГБ/с']

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** Число с десятичной запятой, как принято в русском тексте. */
export function decimalRu(value: number, digits: number): string {
  return value.toFixed(digits).replace('.', ',')
}

function safeNumber(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
}

/** «20:41:05» */
export function formatClock(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
}

/** «20:41» — часы в верхней панели и время реплики в диалоге. */
export function formatTimeShort(ms: number): string {
  const d = new Date(ms)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** «20:41:05» по метке времени в мс. */
export function formatTimeLong(ms: number): string {
  return formatClock(new Date(ms))
}

/** «понедельник, 19 октября 2026» */
export function formatFullDate(date: Date): string {
  return `${WEEKDAYS_FULL[date.getDay()]}, ${date.getDate()} ${MONTHS_GENITIVE[date.getMonth()]} ${date.getFullYear()}`
}

/**
 * Скорость сети из байт/с. Единица переключается на 1000, а не на 1024, чтобы число
 * не разрасталось до четырёх цифр и не прыгала ширина строки.
 */
export function formatRate(bytesPerSecond: number): string {
  const bps = safeNumber(bytesPerSecond)
  if (bps < 1000) return `${Math.round(bps)} Б/с`
  let value = bps / 1024
  let unit = 0
  while (value >= 1000 && unit < RATE_UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${decimalRu(value, value < 100 ? 1 : 0)} ${RATE_UNITS[unit]}`
}

/** Мегабайты → гигабайты с одним знаком: «11,8». */
export function formatGigabytes(megabytes: number): string {
  return decimalRu(safeNumber(megabytes) / 1024, 1)
}

/** «11,8 / 31,9 ГБ» */
export function formatMemory(usedMb: number, totalMb: number): string {
  return `${formatGigabytes(usedMb)} / ${formatGigabytes(totalMb)} ГБ`
}

/** Длительность действия: «120 мс», «1,5 с», «42 с», «2 мин 05 с». */
export function formatDuration(ms: number): string {
  const v = safeNumber(ms)
  if (v < 1000) return `${Math.round(v)} мс`
  if (v < 10_000) return `${decimalRu(v / 1000, 1)} с`
  const totalSeconds = Math.round(v / 1000)
  if (totalSeconds < 60) return `${totalSeconds} с`
  return `${Math.floor(totalSeconds / 60)} мин ${pad2(totalSeconds % 60)} с`
}

/** Время работы ядра: «00:12:34», после суток — «1 д 02:03:04». */
export function formatUptime(seconds: number): string {
  const total = Math.floor(safeNumber(seconds))
  const days = Math.floor(total / 86_400)
  const h = Math.floor((total % 86_400) / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const clock = `${pad2(h)}:${pad2(m)}:${pad2(s)}`
  return days > 0 ? `${days} д ${clock}` : clock
}

/** Процент целым числом в пределах 0..100. */
export function formatPercent(value: number): string {
  return String(Math.round(Math.min(100, safeNumber(value))))
}

/** Сокращает длинные имена клавиш, чтобы подсказка помещалась на кнопке. */
export function formatHotkey(combo: string): string {
  return combo
    .split('+')
    .map((key) => key.trim())
    .filter(Boolean)
    .map((key) => (key.toLowerCase() === 'escape' ? 'Esc' : key))
    .join('+')
}
