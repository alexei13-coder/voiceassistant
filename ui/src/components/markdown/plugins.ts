// Плагины разбора Markdown для ответов ассистента: переносы строк «как в мессенджере» и хвост
// сообщения (приглушённая пометка ядра и мигающий курсор) сразу за последним словом.

import type { Element, ElementContent, Root as HastRoot, Text as HastText } from 'hast'
import type { Nodes as MdNodes, Root as MdRoot } from 'mdast'

export const CARET_CLASS = 'md__caret'
export const SUFFIX_CLASS = 'md__suffix'

/**
 * Одиночный перевод строки — новая строка. По стандарту Markdown он склеивает строки в одну,
 * и тогда стихи, адреса и перечисления «через Enter» слипаются в сплошной абзац.
 */
export function remarkSoftBreaks() {
  return (tree: MdRoot) => splitSoftBreaks(tree)
}

function splitSoftBreaks(node: MdNodes): void {
  if (!('children' in node)) return
  const next: MdNodes[] = []
  for (const child of node.children) {
    if (child.type === 'text' && child.value.includes('\n')) {
      child.value.split(/\r?\n/).forEach((part, i) => {
        if (i > 0) next.push({ type: 'break' })
        if (part) next.push({ type: 'text', value: part })
      })
    } else {
      splitSoftBreaks(child)
      next.push(child)
    }
  }
  // Текст бывает только во фразовом содержимом, а там перевод строки (break) тоже допустим.
  ;(node as { children: MdNodes[] }).children = next
}

export interface TailOptions {
  /** Ответ ещё печатается — показать курсор. */
  caret: boolean
  /** Пометка ядра в конце ответа, например «(остановлено)». */
  suffix: string | null
}

/** Внутри кода и таблиц пометка выглядела бы частью содержимого — ей нужен отдельный абзац. */
const ISOLATING_TAGS = new Set(['pre', 'table'])

interface Spot {
  parent: HastRoot | Element
  index: number
  isolated: boolean
}

/** Последний непустой текст документа (обход с конца, вглубь). */
function lastTextSpot(node: HastRoot | Element, isolated: boolean): Spot | null {
  for (let i = node.children.length - 1; i >= 0; i -= 1) {
    const child = node.children[i]
    if (child.type === 'text' && child.value.trim() !== '') return { parent: node, index: i, isolated }
    if (child.type === 'element') {
      const spot = lastTextSpot(child, isolated || ISOLATING_TAGS.has(child.tagName))
      if (spot) return spot
    }
  }
  return null
}

function span(className: string, text?: string): Element {
  return {
    type: 'element',
    tagName: 'span',
    properties: text ? { className: [className] } : { className: [className], ariaHidden: 'true' },
    children: text ? [{ type: 'text', value: text }] : [],
  }
}

/** Ставит пометку и курсор за последним словом — внутри последнего абзаца, пункта или блока кода. */
export function appendTail(tree: HastRoot, { caret, suffix }: TailOptions): void {
  if (!caret && !suffix) return
  const spot = lastTextSpot(tree, false)
  const caretNodes = caret ? [span(CARET_CLASS)] : []

  if (!spot || (suffix && spot.isolated)) {
    const children = suffix ? [span(SUFFIX_CLASS, suffix), ...caretNodes] : caretNodes
    tree.children.push({ type: 'element', tagName: 'p', properties: {}, children })
    return
  }

  const text = spot.parent.children[spot.index] as HastText
  const body = text.value.trimEnd()
  // Хвостовой перевод строки (у блока кода он есть всегда) возвращаем после вставки,
  // иначе курсор уехал бы на пустую строку.
  const trailing = text.value.slice(body.length)
  const pieces: ElementContent[] = [{ ...text, value: body }]
  if (suffix) pieces.push({ type: 'text', value: ' ' }, span(SUFFIX_CLASS, suffix))
  pieces.push(...caretNodes)
  if (trailing) pieces.push({ type: 'text', value: trailing })
  ;(spot.parent.children as ElementContent[]).splice(spot.index, 1, ...pieces)
}

export function rehypeTail(options: TailOptions) {
  return (tree: HastRoot) => appendTail(tree, options)
}
