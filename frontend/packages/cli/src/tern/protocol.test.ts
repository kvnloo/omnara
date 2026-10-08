import { describe, expect, it } from 'vitest'
import { decodeTspHello, decodeTspEvent, encodeTspHelloQuery, parseTspApc } from './protocol.ts'
import { applyTernComposerEdit, TERN_COMPOSER_ID, TERN_SURFACE_ID, TernComposerTransport } from './composer.ts'

describe('Omnara TSP protocol',()=>{
  it('identifies Omnara and requests edit/send',()=>{const wire=encodeTspHelloQuery();const q=parseTspApc(wire.slice(2,-2));expect(q?.verb).toBe('q');expect(JSON.parse(q!.body)).toMatchObject({app:'omnara',features:['edit','send']})})
  it('decodes hello and rejects malformed events',()=>{expect(decodeTspHello('tsp;r;'+JSON.stringify({r:'hello',v:1,term:'tern',kinds:['col','editor'],credits:1}))?.term).toBe('tern');expect(decodeTspEvent('tsp;e;{}')).toBeNull()})
})
describe('composer parity',()=>{
  it('applies edits only to the version Tern saw',()=>{const e={ev:'edit',sf:TERN_SURFACE_ID,id:TERN_COMPOSER_ID,from:1,to:3,text:'X',cursor:2,len:4} as const;expect(applyTernComposerEdit('abcd',e)).toEqual({cursor:2,text:'aXd'});expect(applyTernComposerEdit('abcde',e)).toBeNull()})
  it('coalesces while frame credit is in flight',()=>{const writes:string[]=[];const t=new TernComposerTransport(x=>writes.push(x),{r:'hello',v:1,term:'tern',kinds:['col','editor'],credits:1});t.start({cursor:0,text:''},true);t.update({cursor:1,text:'a'},true);t.update({cursor:2,text:'ab'},true);expect(writes).toHaveLength(2);t.handleEvent({ev:'ack',sf:TERN_SURFACE_ID,s:1});expect(writes).toHaveLength(3);expect(writes[2]).toContain('ab')})
})
