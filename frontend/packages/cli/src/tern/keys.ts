/**
 * Pty keys for the native Tern composer.
 *
 * Under TSP, Tern shows its caret in a focused `editor` but the text model
 * stays the program's: ordinary keys still arrive as pty input, and only
 * native-selection edits, caret moves and atomic sends arrive as events.
 * While Ink is suspended these keys keep the Ink composer's semantics.
 */
import type { ComposerSnapshot } from './composer.ts'

export type TernComposerKey =
  | { kind: 'text'; text: string }
  | { kind: 'backspace' }
  | { kind: 'submit' }
  | { kind: 'quit' }

const ESC = '\x1b'
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

/**
 * Length of the ECMA-48 CSI sequence at the start of `value`: 0 when it is not
 * a CSI, -1 when it is a CSI prefix that the next chunk may complete.
 */
function csiLength(value: string): number {
  if (!value.startsWith('\x1b[')) return 0
  let index = 2
  while (
    index < value.length &&
    value.charCodeAt(index) >= 0x30 &&
    value.charCodeAt(index) <= 0x3f
  ) {
    index += 1
  }
  while (
    index < value.length &&
    value.charCodeAt(index) >= 0x20 &&
    value.charCodeAt(index) <= 0x2f
  ) {
    index += 1
  }
  if (index === value.length) return -1
  const final = value.charCodeAt(index)
  return final >= 0x40 && final <= 0x7e ? index + 1 : 0
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export class TernComposerKeyDecoder {
  private pending = ''
  private paste: string | null = null

  push(chunk: string): TernComposerKey[] {
    const keys: TernComposerKey[] = []
    let text = ''
    const flushText = (): void => {
      if (text !== '') keys.push({ kind: 'text', text })
      text = ''
    }

    let rest = this.pending + chunk
    this.pending = ''
    while (rest !== '') {
      if (this.paste != null) {
        const end = rest.indexOf(PASTE_END)
        if (end === -1) {
          const keep = partialSuffix(rest, PASTE_END)
          this.paste += rest.slice(0, rest.length - keep)
          this.pending = rest.slice(rest.length - keep)
          break
        }
        text += (this.paste + rest.slice(0, end)).replace(/\r\n?/g, '\n')
        this.paste = null
        rest = rest.slice(end + PASTE_END.length)
        continue
      }

      if (rest.startsWith(ESC)) {
        if (rest.startsWith(PASTE_START)) {
          this.paste = ''
          rest = rest.slice(PASTE_START.length)
          continue
        }
        const csi = csiLength(rest)
        if (csi > 0) {
          if (rest.startsWith('\x1b[3~')) {
            flushText()
            keys.push({ kind: 'backspace' })
          }
          rest = rest.slice(csi)
          continue
        }
        if (csi < 0 || rest === '\x1bO') {
          this.pending = rest
          break
        }
        if (rest.startsWith('\x1b\r')) {
          // Ink reads meta+return as return.
          flushText()
          keys.push({ kind: 'submit' })
          rest = rest.slice(2)
          continue
        }
        // A lone escape, SS3 function key or meta chord: the Ink composer ignores these.
        rest = rest.slice(
          rest.startsWith('\x1bO') ? 3 : rest[1] === ESC ? 1 : Math.min(2, rest.length),
        )
        continue
      }

      const char = rest.charAt(0)
      rest = rest.slice(1)
      if (char === '\r') {
        flushText()
        keys.push({ kind: 'submit' })
      } else if (char === '\x7f' || char === '\b') {
        flushText()
        keys.push({ kind: 'backspace' })
      } else if (char === '\x03') {
        flushText()
        keys.push({ kind: 'quit' })
      } else if (char === '\n' || char >= ' ') {
        text += char
      }
    }
    flushText()
    return keys
  }
}

function partialSuffix(value: string, marker: string): number {
  for (let length = Math.min(value.length, marker.length - 1); length > 0; length -= 1) {
    if (value.endsWith(marker.slice(0, length))) return length
  }
  return 0
}

export function applyTernComposerKey(
  snapshot: ComposerSnapshot,
  key: Extract<TernComposerKey, { kind: 'text' | 'backspace' }>,
): ComposerSnapshot {
  const cursor = Math.min(Math.max(Math.trunc(snapshot.cursor), 0), snapshot.text.length)
  const before = snapshot.text.slice(0, cursor)
  const after = snapshot.text.slice(cursor)
  if (key.kind === 'text') {
    return { cursor: cursor + key.text.length, text: before + key.text + after }
  }
  let start = before.length
  for (const segment of graphemes.segment(before)) start = segment.index
  return { cursor: start, text: before.slice(0, start) + after }
}
