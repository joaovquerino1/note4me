import type { Node as PMNode } from '@tiptap/pm/model'

const SOURCE_ATTRS = new Set(['mdsrc', 'mdgap', 'mdfp'])

/** Stable string identity of a block's content, ignoring source bookkeeping. */
export function fingerprint(node: PMNode): string {
  const json = node.toJSON() as { attrs?: Record<string, unknown> }
  if (json.attrs) {
    const attrs: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(json.attrs)) if (!SOURCE_ATTRS.has(k)) attrs[k] = v
    json.attrs = attrs
  }
  return JSON.stringify(json)
}
