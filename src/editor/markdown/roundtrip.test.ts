import { describe, expect, it } from 'vitest'
import { getSchema } from '@tiptap/core'
import { Fragment, type Node as PMNode } from '@tiptap/pm/model'
import { contentExtensions } from '../schema'
import { parseMarkdown, serializeMarkdown } from './index'

const schema = getSchema(contentExtensions())

const roundtrip = (md: string) => {
  const { doc, prefix } = parseMarkdown(schema, md)
  return serializeMarkdown(doc, prefix)
}

/** Drops source info so every block is re-serialised from the model. */
function fresh(doc: PMNode): PMNode {
  const kids: PMNode[] = []
  doc.forEach((n) => kids.push(n.type.create({ ...n.attrs, mdsrc: null, mdgap: null, mdfp: null }, n.content, n.marks)))
  return schema.topNodeType.create(null, kids)
}

const freshMd = (md: string) => serializeMarkdown(fresh(parseMarkdown(schema, md).doc))

/** Semantic equality: parse both and compare models without source info. */
function sameModel(a: string, b: string) {
  const strip = (md: string) => JSON.stringify(fresh(parseMarkdown(schema, md).doc).toJSON())
  expect(strip(b)).toBe(strip(a))
}

const KITCHEN_SINK = `Intro paragraph with *emphasis*, __strong__, ~~strike~~, \`code\` and a [link](../Outra%20Pasta/Página.md#seção "título").

Setext heading
==============

### ATX heading ###

* star bullet
* second with [[Wiki Link|apelido]]
    * nested indented four

1) paren ordered
2) second

7. starts at seven
8. eight

- [ ] open task
- [x] done task

> quote line one
continued lazily
>
> second paragraph

\`\`\`rust title="x"
fn main() { println!("\`\`\`"); }
\`\`\`

    indented code

***

| Esquerda | Centro | Direita |
|:--------|:------:|--------:|
| a \\| b | **c** | 3 |

<div align="center">
  <b>HTML block</b>
</div>

Footnote ref[^1] and math $e^{i\\pi}+1=0$ and ![img](<Anexos/foto final.png>) and <kbd>Cmd</kbd>.

[^1]: The footnote text
    continued.

![[embedded.pdf]]

A [ref link][r] here.

[r]: https://example.com  "Ref"

Trailing hard break
next line\\
last line
`

describe('lossless round trip', () => {
  it('reproduces every byte of an untouched document', () => {
    expect(roundtrip(KITCHEN_SINK)).toBe(KITCHEN_SINK)
  })

  it.each([
    '',
    '\n',
    'single line without newline',
    '\n\n# heading after blank lines\n',
    '- a\n- b\n\n\n\npara after many blanks\n\n\n',
    'text\n# heading interrupting\nmore',
    '<!-- comment only -->\n',
    '| a |\n|---|\n',
  ])('keeps %j identical', (md) => {
    expect(roundtrip(md)).toBe(md)
  })
})

describe('fresh serialisation keeps meaning', () => {
  it('re-serialised kitchen sink parses to the same model', () => {
    const out = freshMd(KITCHEN_SINK)
    sameModel(KITCHEN_SINK, out)
  })

  it('writes conventional syntax', () => {
    const out = freshMd('Setext\n===\n\n+ plus\n+ bullets\n\n- [X] Task\n')
    expect(out).toBe('# Setext\n\n+ plus\n+ bullets\n\n- [x] Task\n')
  })

  it('keeps footnotes, math, embeds and inline html verbatim', () => {
    const out = freshMd('A[^n] $a_b$ ![[x.png]] <sup>2</sup> $$\\frac{1}{2}$$\n')
    expect(out).toBe('A[^n] $a_b$ ![[x.png]] <sup>2</sup> $$\\frac{1}{2}$$\n')
  })

  it('does not treat currency as math', () => {
    const { doc } = parseMarkdown(schema, 'Custa $5 e $10.\n')
    expect(JSON.stringify(doc.toJSON())).not.toContain('rawInline')
  })

  it('serialises tables with alignment and escaped pipes', () => {
    const out = freshMd('| A | B |\n|:-:|--:|\n| x \\| y | `z` |\n')
    expect(out).toBe('| A | B |\n| :---: | ---: |\n| x \\| y | `z` |\n')
  })

  it('uses a longer fence when code contains backticks', () => {
    const out = freshMd('````\n```inner```\n````\n')
    expect(out).toBe('````\n```inner```\n````\n')
  })

  it('preserves ordered list start and tight/loose spacing', () => {
    expect(freshMd('3. a\n4. b\n')).toBe('3. a\n4. b\n')
    expect(freshMd('- a\n\n- b\n')).toBe('- a\n\n- b\n')
  })

  it('encodes link destinations with spaces', () => {
    const { doc } = parseMarkdown(schema, '[x](<a b.md>)\n')
    expect(serializeMarkdown(fresh(doc))).toBe('[x](<a b.md>)\n')
  })

  it('keeps wiki links', () => {
    expect(freshMd('[[Página]] e [[Outra|apelido]]\n')).toBe('[[Página]] e [[Outra|apelido]]\n')
  })
})

describe('editing only rewrites what changed', () => {
  const doc = `# Título

Parágrafo   com    espaços estranhos e *ênfase*.

* lista com asterisco
* segundo

Outro parágrafo.
`

  it('replacing one paragraph leaves the others byte-identical', () => {
    const { doc: parsed, prefix } = parseMarkdown(schema, doc)
    const kids: PMNode[] = []
    parsed.forEach((n, _o, i) => {
      if (i === 3) kids.push(n.type.create(n.attrs, schema.text('Parágrafo editado.')))
      else kids.push(n)
    })
    const out = serializeMarkdown(schema.topNodeType.create(null, kids), prefix)
    expect(out).toBe(doc.replace('Outro parágrafo.', 'Parágrafo editado.'))
  })

  it('a new block gets blank-line separation', () => {
    const { doc: parsed, prefix } = parseMarkdown(schema, 'texto\n# título\n')
    const kids: PMNode[] = [parsed.child(0), schema.nodes.paragraph!.create(null, schema.text('novo')), parsed.child(1)]
    const out = serializeMarkdown(schema.topNodeType.create(null, kids), prefix)
    expect(out).toBe('texto\n\nnovo\n\n# título\n')
    sameModel('texto\n\nnovo\n\n# título\n', out)
  })

  it('changed block keeps reference definitions that followed it', () => {
    const md = 'Veja [x][r].\n\n[r]: https://e.com\n\nFim.\n'
    const { doc: parsed, prefix } = parseMarkdown(schema, md)
    const p0 = parsed.child(0)
    const edited = p0.type.create(p0.attrs, p0.content.append(Fragment.from(schema.text(' Mais.'))))
    const out = serializeMarkdown(schema.topNodeType.create(null, [edited, parsed.child(1)]), prefix)
    expect(out).toContain('[r]: https://e.com')
    expect(out).toContain('Fim.')
  })

  it('drops trailing empty paragraphs added for editing', () => {
    const { doc: parsed, prefix } = parseMarkdown(schema, 'a\n')
    const out = serializeMarkdown(schema.topNodeType.create(null, [parsed.child(0), schema.nodes.paragraph!.create()]), prefix)
    expect(out).toBe('a\n')
  })
})

describe('list separation', () => {
  it('keeps adjacent lists apart when re-serialised', () => {
    sameModel('- a\n- b\n\n* c\n', freshMd('- a\n- b\n\n* c\n'))
    const { doc } = parseMarkdown(schema, '- a\n')
    const two = schema.topNodeType.create(null, [fresh(doc).child(0), fresh(doc).child(0)])
    const out = serializeMarkdown(two)
    expect(parseMarkdown(schema, out).doc.childCount).toBe(2)
  })
})
