// Секция боковой колонки: маленькая подпись сверху и содержимое — без рамок и подложек.

import type { ReactNode } from 'react'

interface SectionProps {
  title: string
  /** Справа от подписи: тихий счётчик и т. п. */
  aside?: ReactNode
  className?: string
  children: ReactNode
}

export function Section({ title, aside, className, children }: SectionProps) {
  return (
    <section className={className ? `section ${className}` : 'section'} aria-label={title}>
      <header className="section__head">
        <h2 className="section__label">{title}</h2>
        {aside !== undefined && <span className="section__aside">{aside}</span>}
      </header>
      {children}
    </section>
  )
}
