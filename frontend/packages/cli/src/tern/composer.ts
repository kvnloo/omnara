import { reconcileTernLiveNodes, type TernLiveNode } from './liveProjection.ts'
import {
  encodeTspJson,
  TSP_VERSION,
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

const clamp = (value: number, max: number): number =>
  Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value), 0), max) : 0

export function applyTernComposerEdit(
  current: string,
  event: Extract<TspEvent, { ev: 'edit' }>,
): ComposerSnapshot | null {
  if (event.len !== current.length || event.from > event.to || event.to > current.length) {
    return null
  }
  const from = clamp(event.from, current.length)
  const to = Math.max(from, clamp(event.to, current.length))
  const text = current.slice(0, from) + event.text + current.slice(to)
  return { cursor: clamp(event.cursor, text.length), text }
}

export const supportsTernComposer = (hello: TspHello): boolean =>
  hello.v === TSP_VERSION && hello.kinds.includes('col') && hello.kinds.includes('editor')

export const supportsTernLiveSurface = (hello: TspHello): boolean =>
  supportsTernComposer(hello) &&
  ['md', 'card', 'text', 'tool', 'code'].every((kind) => hello.kinds.includes(kind))

export const supportsTernAgentSurface = (hello: TspHello): boolean =>
  supportsTernLiveSurface(hello) && hello.kinds.includes('agent')

export class TernComposerTransport {
  private acked = 0
  private credits: number
  private limit: number
  private seq = 0
  private started = false
  private closing = false
  private closed = false
  private ackWait: { target: number; finish: (acknowledged: boolean) => void } | null = null
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
    if (
      (hello.credits != null && (!Number.isSafeInteger(hello.credits) || hello.credits < 1)) ||
      (hello.apc != null && (!Number.isSafeInteger(hello.apc) || hello.apc < 128))
    ) {
      throw new RangeError('Unsupported Tern frame credit or APC limit')
    }
    this.credits = hello.credits ?? 2
    this.limit = hello.apc ?? 65_536
  }

  start(snapshot: ComposerSnapshot, sendable: boolean, main: readonly TernLiveNode[] = []): void {
    if (this.started || this.closed) return
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
    if (!this.started || this.closing) return

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
    if (
      event.ev !== 'ack' ||
      event.sf !== TERN_SURFACE_ID ||
      !Number.isSafeInteger(event.s) ||
      event.s < 1 ||
      event.s > this.seq
    ) {
      return
    }
    this.acked = Math.max(this.acked, event.s)
    if (this.ackWait != null && this.acked >= this.ackWait.target) {
      this.ackWait.finish(true)
    }
    if (!this.closing && this.pending != null && this.seq - this.acked < this.credits) {
      const pending = this.pending
      this.pending = null
      this.update(pending.snapshot, pending.sendable, pending.main)
    }
  }

  /** Freeze frame production while the last actual frame ACK is drained. */
  beginClose(): void {
    if (!this.started || this.closing) return
    this.closing = true
    this.pending = null
  }

  stop(): void {
    if (!this.started || this.closed) return
    this.beginClose()
    this.closed = true
    this.started = false
    // Close follows the final ACK on the normal quit path, rather than racing
    // the peer and leaving its frame replies for the following shell.
    this.write(encodeTspJson('x', { id: TERN_SURFACE_ID, keep: false }, this.limit))
  }

  /**
   * An ACK acknowledges a real emitted frame, not the surface-close packet.
   * Keep TSP input subscribed through the last outstanding frame ACK before
   * sending surface close or returning the tty to its next owner.
   * A missing peer must not trap exit.
   */
  waitForOutstandingAcks(timeoutMs: number): Promise<boolean> {
    if (!this.closing) throw new Error('Quiesce native frames before draining their ACKs')
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
      throw new RangeError('Invalid native ACK drain timeout')
    }
    if (this.acked >= this.seq) return Promise.resolve(true)
    this.cancelAckWait()
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (acknowledged: boolean): void => {
        if (this.ackWait?.finish === finish) this.ackWait = null
        if (timer != null) clearTimeout(timer)
        resolve(acknowledged)
      }
      this.ackWait = { target: this.seq, finish }
      timer = setTimeout(() => finish(false), timeoutMs)
    })
  }

  cancelAckWait(): void {
    this.ackWait?.finish(false)
  }

  private ops(ops: TspJson[]): void {
    this.seq += 1
    this.write(encodeTspJson('f', { ops, s: this.seq, sf: TERN_SURFACE_ID }, this.limit))
  }
}
