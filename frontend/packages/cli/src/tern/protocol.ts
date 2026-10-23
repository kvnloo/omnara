/**
 * Minimal Tern Surface Protocol v1 kernel for Omnara.
 *
 * Protocol/lifecycle follows Tern and the mature OMP implementation by
 * Can Bölük / Stencil Labs, adapted through the Hermes × Tern experiment.
 * Omnara remains authoritative for agent/runtime/chat state.
 */
import * as z from 'zod'

const APC = '\x1b_'
const ST = '\x1b\\'
const PARAM_PATTERN = /^[A-Za-z0-9_-]+=[\x21-\x3a\x3c-\x7e]*$/

export const TSP_VERSION = 1
export const TSP_PREFIX = 'tsp;'
export const TSP_DEFAULT_APC_LIMIT = 65_536
/** Bounds the incoming message, including reassembled edit payloads. */
export const TSP_MAX_INBOUND_BYTES = 1_048_576
export const TSP_MIN_APC_LIMIT = 128
export const OMNARA_TSP_PROGRAM_FEATURES = ['edit', 'send'] as const

export type TspVerb = 'b' | 'e' | 'f' | 'o' | 'q' | 'r' | 't' | 'x'

/** JSON a TSP message body may carry. */
export type TspJson = string | number | boolean | null | readonly TspJson[] | TspJsonObject
export interface TspJsonObject {
  readonly [key: string]: TspJson | undefined
}

const optional = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined)

// Tern adds fields over time; unknown or malformed optional fields are dropped.
const zTspHello = z.object({
  r: z.literal('hello'),
  v: z.number(),
  term: z.string(),
  kinds: z.array(z.string()),
  features: optional(z.array(z.string())),
  apc: optional(z.number()),
  credits: optional(z.number()),
  cols: optional(z.number()),
  dark: optional(z.boolean()),
  reduceMotion: optional(z.boolean()),
})
export type TspHello = z.infer<typeof zTspHello>

export interface TspEnvelope {
  verb: string
  params: Record<string, string>
  body: string
}

const zTspEvent = z.discriminatedUnion('ev', [
  z.object({ ev: z.literal('ack'), sf: z.string(), s: z.number().int().positive() }),
  z.object({
    ev: z.literal('resize'),
    sf: z.string().optional(),
    cols: z.number().int().nonnegative(),
    visible: z.boolean().optional(),
  }),
  z.object({ ev: z.literal('theme'), dark: z.boolean() }),
  z.object({ ev: z.literal('motion'), reduce: z.boolean() }),
  z.object({ ev: z.literal('visible'), sf: z.string().optional(), visible: z.boolean() }),
  z.object({
    ev: z.literal('edit'),
    sf: z.string(),
    id: z.string(),
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
    text: z.string(),
    cursor: z.number().int().nonnegative(),
    len: z.number().int().nonnegative(),
  }),
  z.object({ ev: z.literal('send'), sf: z.string(), id: z.string(), text: z.string() }),
  z.object({ ev: z.literal('focus'), sf: z.string(), id: z.string() }),
  z.object({
    ev: z.literal('error'),
    sf: z.string().optional(),
    s: z.number().optional(),
    op: z.number().optional(),
    msg: z.string(),
  }),
  z.object({ ev: z.literal('gone'), sf: z.string().optional(), ids: z.array(z.string()) }),
])
export type TspEvent = z.infer<typeof zTspEvent>

let nextChunkId = 1
function splitUtf8(body: string, limit: number): string[] {
  const chunks: string[] = []
  let current = ''
  let bytes = 0
  for (const cp of body) {
    const size = Buffer.byteLength(cp, 'utf8')
    if (bytes + size > limit && current !== '') {
      chunks.push(current)
      current = ''
      bytes = 0
    }
    current += cp
    bytes += size
  }
  if (current !== '') chunks.push(current)
  return chunks
}
const frame = (verb: TspVerb, params: string, body: string) =>
  APC + TSP_PREFIX + verb + params + ';' + body + ST

/** The peer's APC limit applies to the complete escape sequence, not just JSON. */
export function encodeTspMessage(
  verb: TspVerb,
  body: string,
  limit = TSP_DEFAULT_APC_LIMIT,
): string {
  if (!Number.isSafeInteger(limit) || limit < TSP_MIN_APC_LIMIT) {
    throw new RangeError('Invalid TSP APC limit')
  }
  const single = frame(verb, '', body)
  if (Buffer.byteLength(single, 'utf8') <= limit) return single
  const id = (nextChunkId++).toString(36)
  const continuation = ';c=' + id + ';m=1'
  const budget = limit - Buffer.byteLength(frame(verb, continuation, ''), 'utf8')
  if (budget < 4) throw new RangeError('TSP APC limit too small for UTF-8')
  const chunks = splitUtf8(body, budget)
  return chunks
    .map((chunk, i) => frame(verb, ';c=' + id + (i < chunks.length - 1 ? ';m=1' : ''), chunk))
    .join('')
}
export const encodeTspJson = (verb: TspVerb, value: TspJson, limit = TSP_DEFAULT_APC_LIMIT) =>
  encodeTspMessage(verb, JSON.stringify(value), limit)
export function encodeTspHelloQuery(version?: string): string {
  return encodeTspJson('q', {
    q: 'hello',
    v: [TSP_VERSION],
    app: 'omnara',
    features: [...OMNARA_TSP_PROGRAM_FEATURES],
    ver: version,
  })
}
export function parseTspApc(data: string): TspEnvelope | null {
  if (!data.startsWith(TSP_PREFIX)) return null
  const inner = data.slice(TSP_PREFIX.length)
  let semi = inner.indexOf(';')
  if (semi <= 0) return null
  const verb = inner.slice(0, semi),
    params: Record<string, string> = {}
  let pos = semi + 1
  for (;;) {
    semi = inner.indexOf(';', pos)
    if (semi === -1) break
    const segment = inner.slice(pos, semi)
    if (!PARAM_PATTERN.test(segment)) break
    const eq = segment.indexOf('=')
    const name = segment.slice(0, eq)
    // Only recognized framing parameters can precede a JSON body.
    if (name !== 'c' && name !== 'm') break
    params[name] = segment.slice(eq + 1)
    pos = semi + 1
  }
  return { verb, params, body: inner.slice(pos) }
}
function parseBody(envelope: TspEnvelope | null, verb: TspVerb): string | null {
  return envelope?.verb === verb ? envelope.body : null
}
function parseJson<T extends z.ZodType>(body: string | null, schema: T): z.infer<T> | null {
  if (body == null) return null
  try {
    const parsed = schema.safeParse(JSON.parse(body))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
export function decodeTspHello(data: string): TspHello | null {
  return parseJson(parseBody(parseTspApc(data), 'r'), zTspHello)
}
export function decodeTspEvent(data: string): TspEvent | null {
  return parseJson(parseBody(parseTspApc(data), 'e'), zTspEvent)
}

/**
 * Assemble peer chunked APC frames before validating JSON. A partial body is
 * never routed to Ink, a composer, or the event decoder.
 */
export class TspChunkAssembler {
  private readonly partial = new Map<string, { chunks: string[]; bytes: number }>()

  accept(payload: string): string | null {
    const message = parseTspApc(payload)
    if (message == null) return null
    const id = message.params.c
    if (id === undefined) return payload
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null
    const key = `${message.verb}:${id}`
    const previous = this.partial.get(key)
    const bytes = (previous?.bytes ?? 0) + Buffer.byteLength(message.body, 'utf8')
    if (bytes > TSP_MAX_INBOUND_BYTES || (message.params.m != null && message.params.m !== '1')) {
      this.partial.delete(key)
      return null
    }
    if (message.params.m === '1') {
      // One peer must not pin memory with an unbounded number of incomplete IDs.
      if (previous == null && this.partial.size >= 8) this.partial.clear()
      this.partial.set(key, {
        chunks: [...(previous?.chunks ?? []), message.body],
        bytes,
      })
      return null
    }
    if (previous == null) return null
    this.partial.delete(key)
    return `${TSP_PREFIX}${message.verb};${previous.chunks.join('')}${message.body}`
  }

  clear(): void {
    this.partial.clear()
  }
}
