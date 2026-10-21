// Секция боковой колонки: маленькая подпись сверху и содержимое — без рамок и подложек.
// Сворачиваемая секция превращает подпись в кнопку со стрелкой.

import { useId, type ReactNode } from 'react'
import { Icon } from './Icon'

interface SectionProps {
  title: string
  /** Справа от подписи: тихий счётчик и т. п. */
  aside?: ReactNode
  /** Тихие кнопки справа в заголовке. */
  tools?: ReactNode
  /** Секция сворачивается; содержимое отрисовывается только в раскрытом виде. */
  collapse?: { open: boolean; onToggle: () => void }
  className?: string
  children: ReactNode
}

export function Section({ title, aside, tools, collapse, className, children }: SectionProps) {
  const bodyId = useId()
  const classes = ['section', className, collapse && !collapse.open && 'section--collapsed'].filter(Boolean).join(' ')
  return (
    <section className={classes} aria-label={title}>
      <header className="section__head">
        <h2 className="section__label">
          {collapse ? (
            <button
              type="button"
              className="section__toggle"
              aria-expanded={collapse.open}
              aria-controls={bodyId}
              onClick={collapse.onToggle}
            >
              {title}
              <Icon name="chevronDown" className="section__chevron" />
            </button>
          ) : (
            title
          )}
        </h2>
        {aside !== undefined && <span className="section__aside">{aside}</span>}
        {tools}
      </header>
      {collapse ? (
        collapse.open && (
          <div className="section__body" id={bodyId}>
            {children}
          </div>
        )
      ) : (
        children
      )}
    </section>
  )
}
