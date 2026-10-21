// Ответ ассистента в Markdown (GFM). Безопасно: сырой HTML не исполняется (rehype-raw не
// подключён — теги видны как текст), картинки не загружаются, ссылки не уводят webview —
// клик по ссылке копирует адрес.

import { memo, useDeferredValue, useMemo, type ComponentProps } from 'react'
import Markdown, { type Components, type ExtraProps, type Options } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CopyText } from '../CopyText'
import { rehypeTail, remarkSoftBreaks } from './plugins'
import './Markdown.css'

/** До такой длины инлайн-код не переносится: «-State Listen» по частям не читается. */
const SHORT_CODE_CHARS = 28

const LINK_DONE = 'Ссылка скопирована'
const LINK_FAILED = 'Не удалось скопировать ссылку'

const REMARK_PLUGINS: Options['remarkPlugins'] = [remarkGfm, remarkSoftBreaks]
const REMARK_REHYPE_OPTIONS: Options['remarkRehypeOptions'] = {
  footnoteLabel: 'Примечания',
  footnoteBackLabel: 'Вернуться к тексту',
}

function MarkdownLink({ href, children }: ComponentProps<'a'> & ExtraProps) {
  // Якоря сносок и адреса, которые отбросил urlTransform (javascript: и т. п.), — просто текст.
  if (!href || href.startsWith('#')) return <>{children}</>
  return (
    <CopyText value={href} className="md__link" done={LINK_DONE} failed={LINK_FAILED}>
      {children}
    </CopyText>
  )
}

/** Картинки не загружаем: внешний адрес выдал бы, что ответ прочитан, и отвлекал бы от текста. */
function MarkdownImage({ src, alt }: ComponentProps<'img'> & ExtraProps) {
  const label = alt?.trim() || 'изображение'
  if (typeof src !== 'string' || !src) return <>{label}</>
  return (
    <CopyText value={src} className="md__link" done={LINK_DONE} failed={LINK_FAILED}>
      {label}
    </CopyText>
  )
}

function MarkdownCode({ node: _node, className, children, ...props }: ComponentProps<'code'> & ExtraProps) {
  // Текст блока кода всегда кончается переводом строки — так блок отличается от инлайн-кода.
  const short = typeof children === 'string' && children.length <= SHORT_CODE_CHARS && !children.includes('\n')
  const classes = [className, short && 'md__nowrap'].filter(Boolean).join(' ')
  return (
    <code className={classes || undefined} {...props}>
      {children}
    </code>
  )
}

/** Широкая таблица прокручивается сама, а не растягивает колонку диалога. */
function MarkdownTable({ node: _node, ...props }: ComponentProps<'table'> & ExtraProps) {
  return (
    <div className="md__table">
      <table {...props} />
    </div>
  )
}

const COMPONENTS: Components = { a: MarkdownLink, code: MarkdownCode, img: MarkdownImage, table: MarkdownTable }

type RehypePlugins = Options['rehypePlugins']

/** Граница memo: при срочной перерисовке с прежним (отложенным) текстом разбор не повторяется. */
const MarkdownBody = memo(function MarkdownBody({ text, rehypePlugins }: { text: string; rehypePlugins: RehypePlugins }) {
  return (
    <Markdown
      remarkPlugins={REMARK_PLUGINS}
      remarkRehypeOptions={REMARK_REHYPE_OPTIONS}
      rehypePlugins={rehypePlugins}
      components={COMPONENTS}
    >
      {text}
    </Markdown>
  )
})

interface MessageMarkdownProps {
  text: string
  /** Ответ ещё печатается — в конце мигает курсор. */
  streaming: boolean
  /** Приглушённая пометка ядра в конце: «(остановлено)», «(ответ обрезан)». */
  suffix: string | null
}

export function MessageMarkdown({ text, streaming, suffix }: MessageMarkdownProps) {
  // Дельты потока приходят чаще кадров: отложенный текст даёт React пропускать промежуточные разборы.
  const deferredText = useDeferredValue(text)
  const rehypePlugins = useMemo<RehypePlugins>(() => [[rehypeTail, { caret: streaming, suffix }]], [streaming, suffix])
  return (
    <div className="md">
      <MarkdownBody text={deferredText} rehypePlugins={rehypePlugins} />
    </div>
  )
}
