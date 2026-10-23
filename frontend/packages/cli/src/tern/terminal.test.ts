import { PassThrough } from 'node:stream'

import { describe, expect, it } from 'vitest'

import { applyTernComposerEdit } from './composer.ts'
import { applyTernComposerKey, TernComposerKeyDecoder } from './keys.ts'
import type { TspJson } from './protocol.ts'
import { TernTerminal, TspInputDecoder } from './terminal.ts'

describe('TSP stdin filtering', () => {
  it('removes TSP APC frames while preserving ordinary terminal input', () => {
    const decoder = new TspInputDecoder()
    const first = decoder.push('ab\x1b_tsp;e;{"ev":"theme"')
    expect(first).toEqual({ input: 'ab', tsp: [], parts: [{ kind: 'input', data: 'ab' }] })

    const second = decoder.push(',"dark":true}\x1b\\cd')
    expect(second.input).toBe('cd')
    expect(second.tsp).toEqual(['tsp;e;{"ev":"theme","dark":true}'])
  })

  it('preserves a split marker until it can decide whether it is TSP', () => {
    const decoder = new TspInputDecoder()
    expect(decoder.push('x\x1b_ts')).toEqual({
      input: 'x',
      tsp: [],
      parts: [{ kind: 'input', data: 'x' }],
    })
    expect(decoder.push('p;e;{}\x1b\\y')).toEqual({
      input: 'y',
      tsp: ['tsp;e;{}'],
      parts: [
        { kind: 'tsp', payload: 'tsp;e;{}' },
        { kind: 'input', data: 'y' },
      ],
    })
  })
})

class FakeTtyInput extends PassThrough {
  readonly isTTY = true
}

describe('native ownership input routing', () => {
  it('hands pty keys to native listeners instead of dropping them, and never to Ink', () => {
    const source = new FakeTtyInput()
    const output: string[] = []
    const terminal = new TernTerminal(source, {
      isTTY: true,
      write: (data) => {
        output.push(data)
      },
    })
    const inkInput: string[] = []
    terminal.stdin.on('data', (chunk: Buffer | string) => {
      inkInput.push(chunk.toString())
    })
    const keys: string[] = []
    terminal.subscribeKeys((chunk) => {
      keys.push(chunk)
    })

    source.write('a')
    terminal.beginNativeOwnership()
    source.write('b\x1b_tsp;e;{"ev":"theme","dark":true}\x1b\\c')
    terminal.endNativeOwnership()
    source.write('d')

    expect(keys).toEqual(['b', 'c'])
    expect(inkInput.join('')).toBe('ad')
    // Bracketed paste is on only while the native composer owns input.
    expect(output).toEqual(['\x1b[?2004h', '\x1b[?2004l'])
    terminal.dispose()
  })
})

class RawTtyInput extends PassThrough {
  readonly isTTY = true
  isRaw = false
  refs = 0
  setRawMode(enabled: boolean): void {
    this.isRaw = enabled
  }
  ref(): void {
    this.refs += 1
  }
  unref(): void {
    this.refs = 0
  }
}

describe('terminal restore on exit', () => {
  it('leaves the tty cooked, paused and unref’d after quitting from native ownership', () => {
    const source = new RawTtyInput()
    const terminal = new TernTerminal(source, { isTTY: true, write: () => undefined })
    terminal.stdin.on('data', () => undefined)
    terminal.beginNativeOwnership()
    // Ink resumes its suspended input while it unmounts, re-enabling raw mode.
    terminal.stdin.setRawMode(true)
    terminal.stdin.ref()

    terminal.dispose()
    terminal.stdin.setRawMode(true)
    terminal.stdin.ref()

    expect(source.isRaw).toBe(false)
    expect(source.isPaused()).toBe(true)
    expect(source.refs).toBe(0)
  })
})

describe('terminal native safety fallback', () => {
  it('accepts negotiated hello and falls back for a Tern surface eviction', () => {
    const source = new RawTtyInput()
    const terminal = new TernTerminal(source, { isTTY: true, write: () => undefined })
    terminal.probe()
    const st = String.fromCharCode(27, 92)
    const apc = (verb: string, body: TspJson) =>
      String.fromCharCode(27) + '_tsp;' + verb + ';' + JSON.stringify(body) + st
    source.write(apc('r', { r: 'hello', v: 1, term: 'tern', kinds: ['col', 'editor'] }))
    expect(terminal.getSnapshot().status).toBe('active')
    source.write(apc('e', { ev: 'gone', sf: 'omnara:session', ids: ['main'] }))
    expect(terminal.getSnapshot().status).toBe('unsupported')
    terminal.dispose()
  })

  it('disables native presentation after an oversized APC without leaking it to Ink', () => {
    const source = new RawTtyInput()
    const terminal = new TernTerminal(source, { isTTY: true, write: () => undefined })
    const inkInput: string[] = []
    terminal.stdin.on('data', (chunk: Buffer) => {
      inkInput.push(chunk.toString())
    })
    terminal.probe()
    source.write(String.fromCharCode(27) + '_tsp;e;' + 'x'.repeat(1_048_577))
    expect(terminal.getSnapshot().status).toBe('unsupported')
    expect(inkInput).toEqual([])
    terminal.dispose()
  })
})

describe('ordinary terminal compatibility', () => {
  it('never claims native ownership without TTY capability', () => {
    const source = new PassThrough()
    const terminal = new TernTerminal(source, { isTTY: false, write: () => undefined })
    const keys: string[] = []
    terminal.stdin.on('data', (chunk: Buffer) => {
      keys.push(chunk.toString())
    })
    terminal.probe()
    expect(terminal.getSnapshot().status).toBe('unsupported')
    source.write('regular ink typing')
    expect(keys.join('')).toBe('regular ink typing')
    terminal.dispose()
  })

  it('does not flush an unterminated TSP APC into the Ink input stream', () => {
    const decoder = new TspInputDecoder()
    expect(decoder.push('hello' + String.fromCharCode(27) + '_tsp;e;{"ev":"send"')).toEqual({
      input: 'hello',
      tsp: [],
      parts: [{ kind: 'input', data: 'hello' }],
    })
    expect(decoder.flush()).toBe('')
  })
})

const eventApc = (data: TspJson) => '\x1b_tsp;e;' + JSON.stringify(data) + '\x1b\\'
const helloApc = (kinds: string[] = ['col', 'editor']) =>
  '\x1b_tsp;r;' + JSON.stringify({ r: 'hello', v: 1, term: 'tern', kinds }) + '\x1b\\'

describe('mixed APC and pty key ordering', () => {
  it('applies a typed key followed by a native selection edit in one read', () => {
    const source = new RawTtyInput()
    const terminal = new TernTerminal(source, { isTTY: true, write: () => undefined })
    terminal.probe()
    source.write(helloApc())
    const decoder = new TernComposerKeyDecoder()
    let draft = ''
    terminal.subscribeKeys((input) => {
      for (const key of decoder.push(input)) {
        if (key.kind === 'text' || key.kind === 'backspace') {
          draft = applyTernComposerKey({ text: draft, cursor: draft.length }, key).text
        }
      }
    })
    terminal.subscribeEvents((event) => {
      if (event.ev !== 'edit') return
      const next = applyTernComposerEdit(draft, event)
      if (next) draft = next.text
    })
    terminal.beginNativeOwnership()

    const edit = {
      ev: 'edit', sf: 'omnara:session', id: 'omnara:composer',
      from: 0, to: 1, text: 'b', cursor: 1, len: 1,
    }
    source.write('a' + eventApc(edit))
    expect(draft).toBe('b')
    source.write(eventApc({ ...edit, from: 1, to: 1, text: '🌿', cursor: 3, len: 1 }) + 'c')
    expect(draft).toBe('b🌿c')
    terminal.dispose()
  })

  it('keeps order across fragmented markers and alternating events/keys', () => {
    const source = new RawTtyInput()
    const terminal = new TernTerminal(source, { isTTY: true, write: () => undefined })
    terminal.probe()
    source.write(helloApc())
    const calls: string[] = []
    terminal.subscribeKeys((s) => {
      calls.push('key:' + s)
    })
    terminal.subscribeEvents((e) => {
      calls.push('event:' + e.ev)
    })
    terminal.beginNativeOwnership()
    const edit = eventApc({
      ev: 'edit', sf: 'omnara:session', id: 'omnara:composer',
      from: 0, to: 0, text: 'b', cursor: 1, len: 0,
    })
    source.write(edit.slice(0, 5))
    source.write(edit.slice(5) + 'a\x1b_ts')
    source.write('p;e;{"ev":"theme","dark":true}\x1b\\z')
    expect(calls).toEqual(['event:edit', 'key:a', 'event:theme', 'key:z'])
    terminal.dispose()
  })
})

describe('partial acquisition and rejected surface restoration', () => {
  it('returns to cooked Ink input when paste-enable throws after raw mode', () => {
    const source = new RawTtyInput()
    const ink: string[] = []
    const terminal = new TernTerminal(source, {
      isTTY: true,
      write: (data) => {
        if (data === '\x1b[?2004h') throw new Error('tty output failed')
      },
    })
    terminal.stdin.on('data', (data: Buffer) => ink.push(data.toString()))
    expect(() => terminal.beginNativeOwnership()).toThrow('tty output failed')
    expect(source.isRaw).toBe(false)
    expect(source.refs).toBe(0)
    source.write('ordinary input')
    expect(ink.join('')).toBe('ordinary input')
    terminal.dispose()
  })

  it('restores input after paste-disable fails and a surface is evicted', () => {
    const source = new RawTtyInput()
    const ink: string[] = []
    const terminal = new TernTerminal(source, {
      isTTY: true,
      write: (data) => {
        if (data === '\x1b[?2004l') throw new Error('paste cleanup failed')
      },
    })
    terminal.stdin.on('data', (data: Buffer) => ink.push(data.toString()))
    terminal.probe()
    source.write(helloApc())
    terminal.beginNativeOwnership()
    source.write(eventApc({ ev: 'gone', sf: 'omnara:session', ids: ['omnara:session'] }) + 'next')
    expect(terminal.getSnapshot().status).toBe('unsupported')
    expect(source.isRaw).toBe(false)
    expect(ink.join('')).toBe('next')
    terminal.dispose()
  })

  it('receives resize/theme/focus while active; fresh terminal can renegotiate', () => {
    const source = new RawTtyInput()
    const terminal = new TernTerminal(source, { isTTY: true, write: () => undefined })
    const calls: string[] = []
    terminal.subscribeEvents((event) => {
      calls.push(event.ev)
    })
    terminal.probe()
    source.write(helloApc())
    source.write(eventApc({ ev: 'resize', sf: 'omnara:session', cols: 90, visible: false }))
    source.write(eventApc({ ev: 'theme', dark: false }))
    source.write(eventApc({ ev: 'focus', sf: 'omnara:session', id: 'omnara:composer' }))
    expect(calls).toEqual(['resize', 'theme', 'focus'])
    source.write(eventApc({ ev: 'error', sf: 'omnara:session', msg: 'surface rejected' }))
    expect(terminal.getSnapshot().status).toBe('unsupported')
    terminal.dispose()

    const nextSource = new RawTtyInput()
    const restarted = new TernTerminal(nextSource, { isTTY: true, write: () => undefined })
    restarted.probe()
    nextSource.write(helloApc())
    expect(restarted.getSnapshot().status).toBe('active')
    restarted.dispose()
  })
})
