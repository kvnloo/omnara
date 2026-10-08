import { describe, expect, it } from 'vitest'

import { TspInputDecoder } from './terminal.ts'

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
