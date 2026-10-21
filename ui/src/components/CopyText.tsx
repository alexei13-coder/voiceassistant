// Текст, который по клику копирует значение в буфер обмена и коротко сообщает об этом в ленте.
// Так показываются ссылки из ответов: webview никуда не переходит (открытие в браузере — этап 4).

import type { KeyboardEvent, ReactNode } from 'react'
import { copyText } from '../platform/clipboard'
import { useSwyvorn } from '../store'

interface CopyTextProps {
  value: string
  /** Сообщение после копирования, например «Ссылка скопирована». */
  done: string
  /** Сообщение, если буфер обмена недоступен. */
  failed: string
  className: string
  children: ReactNode
}

async function copyWithFlash(value: string, done: string, failed: string): Promise<void> {
  const ok = await copyText(value)
  useSwyvorn.getState().showFlash(ok ? done : failed, ok ? 'ok' : 'warn')
}

export function CopyText({ value, done, failed, className, children }: CopyTextProps) {
  const copy = () => void copyWithFlash(value, done, failed)
  const onKeyDown = (e: KeyboardEvent<HTMLSpanElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    copy()
  }
  // span, а не button: длинная ссылка должна переноситься внутри строки, как обычный текст.
  return (
    <span className={className} role="button" tabIndex={0} title={value} onClick={copy} onKeyDown={onKeyDown}>
      {children}
    </span>
  )
}
