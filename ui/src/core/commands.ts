// Команды из кнопок интерфейса: если связи с ядром нет — сказать об этом, а не молчать.

import type { ClientMessage } from '../protocol'
import { useSwyvorn } from '../store'
import { sendCommand } from './connection'

export function sendOrNotify(msg: ClientMessage): boolean {
  if (sendCommand(msg)) return true
  useSwyvorn.getState().addNotice('warning', 'Нет связи с ядром — команда не отправлена', 'not_sent')
  return false
}
