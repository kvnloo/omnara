import { PassThrough } from 'node:stream'

import { describe, expect, it } from 'vitest'

import { TernTerminal, TspInputDecoder } from './terminal.ts'

describe('TSP stdin filtering', () => {
  it('removes TSP APC frames while preserving ordinary terminal input', () => {
    const decoder = new TspInputDecoder()
    const first = decoder.push('ab\x1b_tsp;e;{"ev":"theme"')
    expect(first).toEqual({ input: 'ab', tsp: [] })

    const second = decoder.push(',"dark":true}\x1b\\cd')
    expect(second.input).toBe('cd')
    expect(second.tsp).toEqual(['tsp;e;{"ev":"theme","dark":true}'])
  })

  it('preserves a split marker until it can decide whether it is TSP', () => {
    const decoder = new TspInputDecoder()
    expect(decoder.push('x\x1b_ts')).toEqual({ input: 'x', tsp: [] })
    expect(decoder.push('p;e;{}\x1b\\y')).toEqual({ input: 'y', tsp: ['tsp;e;{}'] })
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
    terminal.stdin.on('data', (chunk: Buffer | string) => inkInput.push(chunk.toString()))
    const keys: string[] = []
    terminal.subscribeKeys((chunk) => keys.push(chunk))

    source.write('a')
    terminal.beginNativeOwnership()
    source.write('b\x1b_tsp;e;{"ev":"theme","dark":true}\x1b\\c')
    terminal.endNativeOwnership()
    source.write('d')

    expect(keys).toEqual(['bc'])
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
    const apc = (verb: string, body: unknown) =>
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
    terminal.stdin.on('data', (chunk: Buffer) => inkInput.push(chunk.toString()))
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
    terminal.stdin.on('data', (chunk: Buffer) => keys.push(chunk.toString()))
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
    })
    expect(decoder.flush()).toBe('')
  })
})
