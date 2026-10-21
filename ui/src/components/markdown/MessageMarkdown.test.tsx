import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Root } from 'hast'
import { MessageMarkdown } from './MessageMarkdown'
import { appendTail } from './plugins'

const render = (text: string, streaming = false, suffix: string | null = null) =>
  renderToStaticMarkup(<MessageMarkdown text={text} streaming={streaming} suffix={suffix} />)

describe('MessageMarkdown: безопасность', () => {
  it('сырой HTML не исполняется — теги видны как текст', () => {
    const html = render('Текст <script>alert(1)</script> и <b onclick="x()">жирный</b>')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<b ')
    expect(html).toContain('&lt;script&gt;')
  })

  it('ссылка не уводит webview: нет href, адрес — в подсказке, клик копирует', () => {
    const html = render('См. [документацию](https://learn.microsoft.com/powershell) и https://example.com')
    expect(html).not.toContain('<a')
    expect(html).not.toContain('href=')
    expect(html).toContain('title="https://learn.microsoft.com/powershell"')
    expect(html).toContain('role="button"')
    expect(html).toContain('title="https://example.com"')
  })

  it('опасный адрес ссылки отбрасывается и остаётся просто текстом', () => {
    const html = render('[нажми](javascript:alert(1))')
    expect(html).not.toContain('javascript')
    expect(html).not.toContain('role="button"')
    expect(html).toContain('нажми')
  })

  it('картинки не загружаются — вместо них подпись-ссылка', () => {
    const html = render('![схема сети](https://example.com/a.png)')
    expect(html).not.toContain('<img')
    expect(html).toContain('схема сети')
    expect(html).toContain('title="https://example.com/a.png"')
  })
})

describe('MessageMarkdown: разметка', () => {
  it('списки, жирный, курсив, код и таблица', () => {
    const html = render(
      [
        '- **жирный** и *курсив*, `Get-Process`',
        '- второй',
        '',
        '```powershell',
        'Get-NetTCPConnection -State Listen',
        '```',
        '',
        '| Порт | Процесс |',
        '|---|---|',
        '| 8080 | node.exe |',
      ].join('\n'),
    )
    expect(html).toContain('<ul>')
    expect(html).toContain('<strong>жирный</strong>')
    expect(html).toContain('<em>курсив</em>')
    expect(html).toContain('<code class="md__nowrap">Get-Process</code>')
    expect(html).toContain('<pre><code class="language-powershell">Get-NetTCPConnection -State Listen\n</code></pre>')
    expect(html).toContain('<div class="md__table"><table>')
    expect(html).toContain('<td>node.exe</td>')
  })

  it('короткий инлайн-код не переносится, длинный — переносится', () => {
    expect(render('флаг `-State Established`')).toContain('<code class="md__nowrap">-State Established</code>')
    const long = 'C:\\Users\\Алексей\\AppData\\Roaming\\Swyvorn\\logs\\core.log'
    expect(render(`файл \`${long}\``)).toContain(`<code>${long}</code>`)
  })

  it('одиночный перевод строки — новая строка, пустая строка — новый абзац', () => {
    const html = render('строка один\nстрока два\n\nабзац')
    expect(html).toBe('<div class="md"><p>строка один<br/>\nстрока два</p>\n<p>абзац</p></div>')
  })

  it('курсор потока — сразу за последним словом, внутри последнего пункта', () => {
    const html = render('Шаги:\n\n- первый\n- второй', true)
    expect(html).toContain('<li>второй<span class="md__caret" aria-hidden="true"></span></li>')
    expect(render('Готово.')).not.toContain('md__caret')
  })

  it('пометка ядра — приглушённо в конце текста', () => {
    const html = render('Сейчас посмотрю', false, '(остановлено)')
    expect(html).toBe('<div class="md"><p>Сейчас посмотрю <span class="md__suffix">(остановлено)</span></p></div>')
  })
})

describe('appendTail', () => {
  const codeTree = (): Root => ({
    type: 'root',
    children: [
      {
        type: 'element',
        tagName: 'pre',
        properties: {},
        children: [{ type: 'element', tagName: 'code', properties: {}, children: [{ type: 'text', value: 'dir\n' }] }],
      },
      { type: 'text', value: '\n' },
    ],
  })

  it('в незакрытом блоке кода курсор стоит до хвостового перевода строки', () => {
    const tree = codeTree()
    appendTail(tree, { caret: true, suffix: null })
    const code = (tree.children[0] as { children: Array<{ children: unknown[] }> }).children[0]
    expect(code.children).toEqual([
      { type: 'text', value: 'dir' },
      { type: 'element', tagName: 'span', properties: { className: ['md__caret'], ariaHidden: 'true' }, children: [] },
      { type: 'text', value: '\n' },
    ])
  })

  it('пометка после кода — отдельным абзацем, а не внутри кода', () => {
    const tree = codeTree()
    appendTail(tree, { caret: false, suffix: '(остановлено)' })
    expect(tree.children).toHaveLength(3)
    expect(tree.children[2]).toMatchObject({
      tagName: 'p',
      children: [{ tagName: 'span', properties: { className: ['md__suffix'] }, children: [{ value: '(остановлено)' }] }],
    })
  })

  it('пустой ответ: пометка всё равно видна, без пометки и курсора дерево не меняется', () => {
    const empty: Root = { type: 'root', children: [] }
    appendTail(empty, { caret: false, suffix: null })
    expect(empty.children).toEqual([])
    appendTail(empty, { caret: false, suffix: '(остановлено)' })
    expect(empty.children).toHaveLength(1)
  })
})
