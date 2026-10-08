import { describe, expect, it } from 'vitest'

import {
  applyTernComposerEdit,
  TERN_COMPOSER_ID,
  TERN_SURFACE_ID,
  TernComposerTransport,
} from './composer.ts'
import {
  decodeTspEvent,
  decodeTspHello,
  encodeTspHelloQuery,
  parseTspApc,
  type TspJson,
} from './protocol.ts'

describe('Omnara TSP protocol', () => {
  it('identifies Omnara and requests edit/send', () => {
    const wire = encodeTspHelloQuery()
    const q = parseTspApc(wire.slice(2, -2))
    expect(q?.verb).toBe('q')
    expect(JSON.parse(q?.body ?? '')).toMatchObject({ app: 'omnara', features: ['edit', 'send'] })
  })
  it('decodes hello and rejects malformed events', () => {
    expect(
      decodeTspHello(
        'tsp;r;' +
          JSON.stringify({ r: 'hello', v: 1, term: 'tern', kinds: ['col', 'editor'], credits: 1 }),
      )?.term,
    ).toBe('tern')
    expect(decodeTspEvent('tsp;e;{}')).toBeNull()
  })
})
describe('TSP boundary parsing', () => {
  const event = (body: TspJson) => decodeTspEvent('tsp;e;' + JSON.stringify(body))
  it('decodes the composer events Omnara consumes', () => {
    expect(event({ ev: 'ack', sf: 'omnara:session', s: 3 })).toEqual({
      ev: 'ack',
      sf: 'omnara:session',
      s: 3,
    })
    const edit = { ev: 'edit', sf: 's', id: 'c', from: 0, to: 1, text: 'é', cursor: 1, len: 2 }
    expect(event(edit)).toEqual(edit)
    expect(event({ ev: 'send', sf: 's', id: 'c', text: 'hi\nthere' })).toEqual({
      ev: 'send',
      sf: 's',
      id: 'c',
      text: 'hi\nthere',
    })
    expect(event({ ev: 'gone', ids: ['a'] })).toEqual({ ev: 'gone', ids: ['a'] })
  })
  it('rejects incomplete events, other verbs and non-JSON bodies', () => {
    expect(event({ ev: 'edit', sf: 's', id: 'c', from: 0, to: 1, text: 'x', cursor: 1 })).toBeNull()
    expect(event({ ev: 'send', sf: 's', id: 'c' })).toBeNull()
    expect(event({ ev: 'unknown' })).toBeNull()
    expect(decodeTspEvent('tsp;r;{"ev":"theme","dark":true}')).toBeNull()
    expect(decodeTspEvent('tsp;e;not json')).toBeNull()
  })
  it('keeps a hello whose optional fields are malformed, without those fields', () => {
    const hello = decodeTspHello(
      'tsp;r;' +
        JSON.stringify({ r: 'hello', v: 1, term: 'tern', kinds: ['col'], apc: 'big', credits: 2 }),
    )
    expect(hello).toEqual({ r: 'hello', v: 1, term: 'tern', kinds: ['col'], credits: 2 })
    expect(
      decodeTspHello('tsp;r;' + JSON.stringify({ r: 'hello', v: '1', term: 't', kinds: [] })),
    ).toBeNull()
  })
})
describe('composer parity', () => {
  it('applies edits only to the version Tern saw', () => {
    const e = {
      ev: 'edit',
      sf: TERN_SURFACE_ID,
      id: TERN_COMPOSER_ID,
      from: 1,
      to: 3,
      text: 'X',
      cursor: 2,
      len: 4,
    } as const
    expect(applyTernComposerEdit('abcd', e)).toEqual({ cursor: 2, text: 'aXd' })
    expect(applyTernComposerEdit('abcde', e)).toBeNull()
  })
  it('coalesces while frame credit is in flight', () => {
    const writes: string[] = []
    const t = new TernComposerTransport((x) => writes.push(x), {
      r: 'hello',
      v: 1,
      term: 'tern',
      kinds: ['col', 'editor'],
      credits: 1,
    })
    t.start({ cursor: 0, text: '' }, true)
    t.update({ cursor: 1, text: 'a' }, true)
    t.update({ cursor: 2, text: 'ab' }, true)
    expect(writes).toHaveLength(2)
    t.handleEvent({ ev: 'ack', sf: TERN_SURFACE_ID, s: 1 })
    expect(writes).toHaveLength(3)
    expect(writes[2]).toContain('ab')
  })
})
