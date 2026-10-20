// Панель HUD: срезанные углы, уголки-скобы и заголовок с порядковым номером.

import type { ReactNode } from 'react'
import './Panel.css'

interface PanelProps {
  index: string
  title: string
  /** Справа в заголовке: счётчик, индикатор и т. п. */
  aside?: ReactNode
  className?: string
  children: ReactNode
}

export function Panel({ index, title, aside, className, children }: PanelProps) {
  return (
    <section className={className ? `panel ${className}` : 'panel'} aria-label={title}>
      <header className="panel__head">
        <span className="panel__index">{index}</span>
        <h2 className="panel__title">{title}</h2>
        <span className="panel__rule" aria-hidden="true" />
        {aside !== undefined && <span className="panel__aside">{aside}</span>}
      </header>
      {children}
    </section>
  )
}
