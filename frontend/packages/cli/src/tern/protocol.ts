/**
 * Minimal Tern Surface Protocol v1 kernel for Omnara.
 *
 * Protocol/lifecycle follows Tern and the mature OMP implementation by
 * Can Bölük / Stencil Labs, adapted through the Hermes × Tern experiment.
 * Omnara remains authoritative for agent/runtime/chat state.
 */
const APC = '\x1b_'
const ST = '\x1b\\'
const PARAM_PATTERN = /^[A-Za-z0-9_-]+=[\x21-\x3a\x3c-\x7e]*$/

export const TSP_VERSION = 1
export const TSP_PREFIX = 'tsp;'
export const TSP_DEFAULT_APC_LIMIT = 65_536
export const OMNARA_TSP_PROGRAM_FEATURES = ['edit', 'send'] as const

export type TspVerb = 'b' | 'e' | 'f' | 'o' | 'q' | 'r' | 't' | 'x'
export type TspHello = {
  r: 'hello'; v: number; term: string; kinds: string[]; features?: string[]
  apc?: number; credits?: number; cols?: number; dark?: boolean; reduceMotion?: boolean
}
export type TspEnvelope = { verb: string; params: Record<string, string>; body: string }
export type TspEvent =
  | { ev: 'ack'; sf: string; s: number }
  | { ev: 'resize'; sf?: string; cols: number; visible?: boolean }
  | { ev: 'theme'; dark: boolean }
  | { ev: 'motion'; reduce: boolean }
  | { ev: 'visible'; sf?: string; visible: boolean }
  | { ev: 'edit'; sf: string; id: string; from: number; to: number; text: string; cursor: number; len: number }
  | { ev: 'send'; sf: string; id: string; text: string }
  | { ev: 'focus'; sf: string; id: string }
  | { ev: 'error'; sf?: string; s?: number; op?: number; msg: string }
  | { ev: 'gone'; sf?: string; ids: string[] }

let nextChunkId = 1
function splitUtf8(body: string, limit: number): string[] {
  const chunks: string[] = []
  let current = ''
  for (const cp of body) {
    if (Buffer.byteLength(current + cp, 'utf8') > limit && current !== '') {
      chunks.push(current); current = cp
    } else current += cp
  }
  chunks.push(current)
  return chunks
}
const frame = (verb: TspVerb, params: string, body: string) => APC + TSP_PREFIX + verb + params + ';' + body + ST
export function encodeTspMessage(verb: TspVerb, body: string, limit = TSP_DEFAULT_APC_LIMIT): string {
  if (Buffer.byteLength(body, 'utf8') <= limit) return frame(verb, '', body)
  const id = (nextChunkId++).toString(36)
  const chunks = splitUtf8(body, Math.max(4, Math.trunc(limit)))
  return chunks.map((chunk, i) => frame(verb, ';c=' + id + (i < chunks.length - 1 ? ';m=1' : ''), chunk)).join('')
}
export const encodeTspJson = (verb: TspVerb, value: unknown, limit = TSP_DEFAULT_APC_LIMIT) =>
  encodeTspMessage(verb, JSON.stringify(value), limit)
export function encodeTspHelloQuery(version?: string): string {
  return encodeTspJson('q', { q: 'hello', v: [TSP_VERSION], app: 'omnara', features: [...OMNARA_TSP_PROGRAM_FEATURES], ...(version ? { ver: version } : {}) })
}
export function parseTspApc(data: string): TspEnvelope | null {
  if (!data.startsWith(TSP_PREFIX)) return null
  const inner = data.slice(TSP_PREFIX.length)
  let semi = inner.indexOf(';')
  if (semi <= 0) return null
  const verb = inner.slice(0, semi), params: Record<string,string> = {}
  let pos = semi + 1
  for (;;) {
    semi = inner.indexOf(';', pos)
    if (semi === -1) break
    const segment = inner.slice(pos, semi)
    if (!PARAM_PATTERN.test(segment)) break
    const eq = segment.indexOf('=')
    params[segment.slice(0, eq)] = segment.slice(eq + 1)
    pos = semi + 1
  }
  return { verb, params, body: inner.slice(pos) }
}
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string')
const record = (v: unknown): v is Record<string,unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
export function decodeTspHello(data: string): TspHello | null {
  const e = parseTspApc(data); if (!e || e.verb !== 'r') return null
  let v: unknown; try { v = JSON.parse(e.body) } catch { return null }
  if (!record(v) || v.r !== 'hello' || typeof v.v !== 'number' || typeof v.term !== 'string' || !strings(v.kinds)) return null
  return { r:'hello', v:v.v, term:v.term, kinds:v.kinds,
    ...(strings(v.features)?{features:v.features}:{}),
    ...(typeof v.apc==='number'?{apc:v.apc}:{}), ...(typeof v.credits==='number'?{credits:v.credits}:{}),
    ...(typeof v.cols==='number'?{cols:v.cols}:{}), ...(typeof v.dark==='boolean'?{dark:v.dark}:{}),
    ...(typeof v.reduceMotion==='boolean'?{reduceMotion:v.reduceMotion}:{}) }
}
export function decodeTspEvent(data: string): TspEvent | null {
  const e=parseTspApc(data); if(!e||e.verb!=='e') return null
  let v:unknown; try{v=JSON.parse(e.body)}catch{return null}
  if(!record(v)||typeof v.ev!=='string') return null
  if(v.ev==='ack'&&typeof v.sf==='string'&&typeof v.s==='number') return v as TspEvent
  if(v.ev==='edit'&&typeof v.sf==='string'&&typeof v.id==='string'&&typeof v.from==='number'&&typeof v.to==='number'&&typeof v.text==='string'&&typeof v.cursor==='number'&&typeof v.len==='number') return v as TspEvent
  if(v.ev==='send'&&typeof v.sf==='string'&&typeof v.id==='string'&&typeof v.text==='string') return v as TspEvent
  if(v.ev==='focus'&&typeof v.sf==='string'&&typeof v.id==='string') return v as TspEvent
  if(v.ev==='theme'&&typeof v.dark==='boolean') return v as TspEvent
  if(v.ev==='motion'&&typeof v.reduce==='boolean') return v as TspEvent
  if(v.ev==='resize'&&typeof v.cols==='number') return v as TspEvent
  if(v.ev==='visible'&&typeof v.visible==='boolean') return v as TspEvent
  if(v.ev==='error'&&typeof v.msg==='string') return v as TspEvent
  if(v.ev==='gone'&&strings(v.ids)) return v as TspEvent
  return null
}
