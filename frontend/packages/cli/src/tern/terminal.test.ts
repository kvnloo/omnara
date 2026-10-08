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

describe('native ownership input routing', () => {
  it('hands pty keys to native listeners instead of dropping them, and never to Ink', () => {
    const source = new PassThrough() as PassThrough & { isTTY?: boolean }
    source.isTTY = true
    const terminal = new TernTerminal(
      source as unknown as NodeJS.ReadStream,
      {
        isTTY: true,
        write: () => true,
      } as unknown as NodeJS.WriteStream,
    )
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
    terminal.dispose()
  })
})
