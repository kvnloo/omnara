import {
  encodeTspJson,
  OMNARA_TSP_PROGRAM_FEATURES,
  type TspEvent,
  type TspHello,
  type TspJson,
} from './protocol.ts'

export const TERN_SURFACE_ID = 'omnara:session'
export const TERN_COMPOSER_ID = 'omnara:composer'
export interface ComposerSnapshot {
  cursor: number
  text: string
}

const clamp = (n: number, max: number) =>
  Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 0), max) : 0
export function applyTernComposerEdit(
  current: string,
  event: Extract<TspEvent, { ev: 'edit' }>,
): ComposerSnapshot | null {
  if (event.len !== current.length) return null
  const from = clamp(event.from, current.length),
    to = Math.max(from, clamp(event.to, current.length))
  const text = current.slice(0, from) + event.text + current.slice(to)
  return { cursor: clamp(event.cursor, text.length), text }
}
export const supportsTernComposer = (hello: TspHello) =>
  hello.kinds.includes('col') &&
  hello.kinds.includes('editor') &&
  OMNARA_TSP_PROGRAM_FEATURES.includes('edit')
export class TernComposerTransport {
  private acked = 0
  private credits: number
  private limit: number
  private seq = 0
  private started = false
  private last: ComposerSnapshot = { cursor: 0, text: '' }
  private lastSendable = false
  private pending: { snapshot: ComposerSnapshot; sendable: boolean } | null = null
  constructor(
    private write: (data: string) => void,
    hello: TspHello,
  ) {
    this.credits = Math.max(1, Math.trunc(hello.credits ?? 2))
    this.limit = Math.max(4, Math.trunc(hello.apc ?? 65_536))
  }
  start(snapshot: ComposerSnapshot, sendable: boolean) {
    if (this.started) return
    this.started = true
    this.last = snapshot
    this.lastSendable = sendable
    this.write(
      encodeTspJson(
        'o',
        { id: TERN_SURFACE_ID, mode: 'inline', role: 'omnara.session', title: 'Omnara' },
        this.limit,
      ),
    )
    this.ops([
      [
        'add',
        'main',
        TERN_SURFACE_ID,
        null,
        { id: 'main', k: 'col', c: [{ id: 'omnara:title', k: 'text', p: { text: 'Omnara' } }] },
      ],
      [
        'add',
        'dock',
        TERN_SURFACE_ID,
        null,
        {
          id: 'dock',
          k: 'col',
          c: [
            {
              id: TERN_COMPOSER_ID,
              k: 'editor',
              p: {
                cursor: snapshot.cursor,
                maxLines: 12,
                role: 'omnara.composer',
                sendable,
                text: snapshot.text,
              },
            },
          ],
        },
      ],
      ['add', 'layer', TERN_SURFACE_ID, null, { id: 'layer', k: 'col', c: [] }],
      ['focus', TERN_COMPOSER_ID],
    ])
  }
  update(snapshot: ComposerSnapshot, sendable: boolean) {
    if (!this.started) return
    if (
      snapshot.text === this.last.text &&
      snapshot.cursor === this.last.cursor &&
      sendable === this.lastSendable
    )
      return
    if (this.seq - this.acked >= this.credits) {
      this.pending = { snapshot, sendable }
      return
    }
    this.last = snapshot
    this.lastSendable = sendable
    this.ops([
      ['set', TERN_COMPOSER_ID, { cursor: snapshot.cursor, sendable, text: snapshot.text }],
    ])
  }
  handleEvent(event: TspEvent) {
    if (event.ev !== 'ack' || event.sf !== TERN_SURFACE_ID) return
    this.acked = Math.max(this.acked, Math.min(event.s, this.seq))
    if (this.pending && this.seq - this.acked < this.credits) {
      const p = this.pending
      this.pending = null
      this.update(p.snapshot, p.sendable)
    }
  }
  stop() {
    if (!this.started) return
    this.started = false
    this.pending = null
    this.write(encodeTspJson('x', { id: TERN_SURFACE_ID, keep: false }, this.limit))
  }
  private ops(ops: TspJson[]) {
    this.seq++
    this.write(encodeTspJson('f', { ops, s: this.seq, sf: TERN_SURFACE_ID }, this.limit))
  }
}
