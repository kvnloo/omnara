import {
  encodeTspJson,
  OMNARA_TSP_PROGRAM_FEATURES,
  type TspEvent,
  type TspHello,
  type TspJson,
} from './protocol.ts'
import { reconcileTernLiveNodes, type TernLiveNode } from './liveProjection.ts'

export const TERN_SURFACE_ID = 'omnara:session'
export const TERN_COMPOSER_ID = 'omnara:composer'
export interface ComposerSnapshot {
  cursor: number
  text: string
}

const clamp = (value: number, max: number): number =>
  Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value), 0), max) : 0

export function applyTernComposerEdit(
  current: string,
  event: Extract<TspEvent, { ev: 'edit' }>,
): ComposerSnapshot | null {
  if (event.len !== current.length) return null
  const from = clamp(event.from, current.length)
  const to = Math.max(from, clamp(event.to, current.length))
  const text = current.slice(0, from) + event.text + current.slice(to)
  return { cursor: clamp(event.cursor, text.length), text }
}

export const supportsTernComposer = (hello: TspHello): boolean =>
  hello.kinds.includes('col') &&
  hello.kinds.includes('editor') &&
  OMNARA_TSP_PROGRAM_FEATURES.includes('edit')

export const supportsTernLiveSurface = (hello: TspHello): boolean =>
  supportsTernComposer(hello) &&
  ['md', 'card', 'text', 'tool', 'code'].every((kind) => hello.kinds.includes(kind))

export class TernComposerTransport {
  private acked = 0
  private credits: number
  private limit: number
  private seq = 0
  private started = false
  private last: ComposerSnapshot = { cursor: 0, text: '' }
  private lastSendable = false
  private lastMain: readonly TernLiveNode[] = []
  private pending: {
    snapshot: ComposerSnapshot
    sendable: boolean
    main: readonly TernLiveNode[]
  } | null = null

  constructor(
    private readonly write: (data: string) => void,
    hello: TspHello,
  ) {
    this.credits = Math.max(1, Math.trunc(hello.credits ?? 2))
    this.limit = Math.max(4, Math.trunc(hello.apc ?? 65_536))
  }

  start(snapshot: ComposerSnapshot, sendable: boolean, main: readonly TernLiveNode[] = []): void {
    if (this.started) return
    this.started = true
    this.last = snapshot
    this.lastSendable = sendable
    this.lastMain = main

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
        {
          id: 'main',
          k: 'col',
          c: [{ id: 'omnara:title', k: 'text', p: { text: 'Omnara' } }, ...main],
        },
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

  update(
    snapshot: ComposerSnapshot,
    sendable: boolean,
    main: readonly TernLiveNode[] = this.lastMain,
  ): void {
    if (!this.started) return

    const next = {
      cursor: clamp(snapshot.cursor, snapshot.text.length),
      text: snapshot.text,
    }

    if (this.seq - this.acked >= this.credits) {
      this.pending = { snapshot: next, sendable, main }
      return
    }

    const ops: TspJson[] = []
    if (
      next.text !== this.last.text ||
      next.cursor !== this.last.cursor ||
      sendable !== this.lastSendable
    ) {
      ops.push(['set', TERN_COMPOSER_ID, { cursor: next.cursor, sendable, text: next.text }])
    }
    ops.push(...reconcileTernLiveNodes('main', this.lastMain, main))

    this.last = next
    this.lastSendable = sendable
    this.lastMain = main
    if (ops.length > 0) this.ops(ops)
  }

  handleEvent(event: TspEvent): void {
    if (event.ev !== 'ack' || event.sf !== TERN_SURFACE_ID) return
    this.acked = Math.max(this.acked, Math.min(event.s, this.seq))
    if (this.pending != null && this.seq - this.acked < this.credits) {
      const pending = this.pending
      this.pending = null
      this.update(pending.snapshot, pending.sendable, pending.main)
    }
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    this.pending = null
    this.write(encodeTspJson('x', { id: TERN_SURFACE_ID, keep: false }, this.limit))
  }

  private ops(ops: TspJson[]): void {
    this.seq += 1
    this.write(encodeTspJson('f', { ops, s: this.seq, sf: TERN_SURFACE_ID }, this.limit))
  }
}
