import { describe, expect, it } from 'vitest'

import { applyTernComposerKey, type TernComposerKey, TernComposerKeyDecoder } from './keys.ts'

const decode = (...chunks: string[]): TernComposerKey[] => {
  const decoder = new TernComposerKeyDecoder()
  return chunks.flatMap((chunk) => decoder.push(chunk))
}

describe('native composer pty keys', () => {
  it('decodes typed text, multi-codepoint graphemes and linefeeds as text', () => {
    expect(decode('hé👍🏽', '\n', 'x')).toEqual([
      { kind: 'text', text: 'hé👍🏽' },
      { kind: 'text', text: '\n' },
      { kind: 'text', text: 'x' },
    ])
  })

  it('maps return to submit, backspace/delete to backspace and ctrl+c to quit', () => {
    expect(decode('a\r', '\x7f', '\b', '\x1b[3~', '\x03')).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'submit' },
      { kind: 'backspace' },
      { kind: 'backspace' },
      { kind: 'backspace' },
      { kind: 'quit' },
    ])
  })

  it('ignores the keys the Ink composer ignores', () => {
    expect(
      decode('\x1b[A\x1b[B\x1b[C\x1b[D', '\t', '\x01', '\x1b', '\x1bOP', '\x1b[5~', '\x1bf'),
    ).toEqual([])
  })

  it('keeps a split escape sequence until it is complete', () => {
    expect(decode('a\x1b[', '3', '~b')).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'backspace' },
      { kind: 'text', text: 'b' },
    ])
  })

  it('inserts a bracketed paste verbatim, including newlines, without submitting', () => {
    expect(decode('\x1b[200~one\r\ntwo', '\rthree\x1b[201~')).toEqual([
      { kind: 'text', text: 'one\ntwo\nthree' },
    ])
  })
})

describe('applying keys to the authoritative draft', () => {
  it('inserts at the native caret and deletes the grapheme before it', () => {
    const typed = applyTernComposerKey({ cursor: 1, text: 'ac' }, { kind: 'text', text: 'b' })
    expect(typed).toEqual({ cursor: 2, text: 'abc' })
    expect(applyTernComposerKey({ cursor: 5, text: 'a👍🏽' }, { kind: 'backspace' })).toEqual({
      cursor: 1,
      text: 'a',
    })
    expect(applyTernComposerKey({ cursor: 0, text: 'abc' }, { kind: 'backspace' })).toEqual({
      cursor: 0,
      text: 'abc',
    })
  })

  it('clamps a stale caret before editing', () => {
    expect(applyTernComposerKey({ cursor: 99, text: 'ab' }, { kind: 'text', text: 'c' })).toEqual({
      cursor: 3,
      text: 'abc',
    })
  })
})
