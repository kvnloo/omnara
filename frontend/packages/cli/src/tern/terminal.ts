import { type Duplex, PassThrough } from 'node:stream'

import {
  decodeTspEvent,
  decodeTspHello,
  encodeTspHelloQuery,
  TspChunkAssembler,
  TSP_MAX_INBOUND_BYTES,
  TSP_VERSION,
  type TspEvent,
  type TspHello,
} from './protocol.ts'

const TSP_START = '\x1b_tsp;'
const ST = '\x1b\\'
const BRACKETED_PASTE_ON = '\x1b[?2004h'
const BRACKETED_PASTE_OFF = '\x1b[?2004l'

function retainedPrefixLength(value: string, marker: string): number {
  const max = Math.min(value.length, marker.length - 1)
  for (let length = max; length > 0; length -= 1) {
    if (value.endsWith(marker.slice(0, length))) return length
  }
  return 0
}

/** Input parts must be dispatched in wire order, across split APC markers. */
export type TspInputPart =
  | { kind: 'input'; data: string }
  | { kind: 'tsp'; payload: string }
  | { kind: 'invalid' }

export interface TspInputChunk {
  input: string
  tsp: string[]
  parts: TspInputPart[]
  invalid?: boolean
}

export class TspInputDecoder {
  private pending = ''

  push(chunk: string): TspInputChunk {
    this.pending += chunk
    let input = ''
    const tsp: string[] = []
    const parts: TspInputPart[] = []
    const rejected = { current: false }
    const appendInput = (value: string): void => {
      if (value === '') return
      input += value
      const last = parts.at(-1)
      if (last?.kind === 'input') last.data += value
      else parts.push({ kind: 'input', data: value })
    }
    const reject = (): void => {
      rejected.current = true
      parts.push({ kind: 'invalid' })
    }

    for (;;) {
      const start = this.pending.indexOf(TSP_START)
      if (start === -1) {
        const keep = retainedPrefixLength(this.pending, TSP_START)
        appendInput(this.pending.slice(0, this.pending.length - keep))
        this.pending = this.pending.slice(this.pending.length - keep)
        break
      }

      appendInput(this.pending.slice(0, start))
      const end = this.pending.indexOf(ST, start + TSP_START.length)
      if (end === -1) {
        this.pending = this.pending.slice(start)
        if (Buffer.byteLength(this.pending, 'utf8') > TSP_MAX_INBOUND_BYTES) {
          this.pending = ''
          reject()
        }
        break
      }

      const payload = this.pending.slice(start + 2, end)
      if (Buffer.byteLength(payload, 'utf8') > TSP_MAX_INBOUND_BYTES) reject()
      else {
        tsp.push(payload)
        parts.push({ kind: 'tsp', payload })
      }
      this.pending = this.pending.slice(end + ST.length)
    }

    return rejected.current ? { input, tsp, parts, invalid: true } : { input, tsp, parts }
  }

  flush(): string {
    const input = this.pending
    this.pending = ''
    // An incomplete TSP frame must never become keyboard input on shutdown.
    return input.startsWith(TSP_START) || TSP_START.startsWith(input) ? '' : input
  }
}

/** The slice of a tty input stream the mux reads (process.stdin in production). */
export interface TernInputSource {
  readonly isTTY?: boolean
  setEncoding: (encoding: BufferEncoding) => void
  on: (event: 'data', listener: (data: string | Buffer) => void) => void
  off: (event: 'data', listener: (data: string | Buffer) => void) => void
  setRawMode?: (enabled: boolean) => void
  ref?: () => void
  unref?: () => void
  pause?: () => void
}

/** The slice of a tty output stream TSP writes to (process.stdout in production). */
export interface TernOutput {
  readonly isTTY?: boolean
  write: (data: string) => void
}

export class TernInputMux extends PassThrough {
  readonly isTTY: boolean
  private readonly decoder = new TspInputDecoder()
  private nativeOwnership = false
  private disposed = false

  constructor(private readonly source: TernInputSource) {
    super()
    this.isTTY = Boolean(source.isTTY)
    source.setEncoding('utf8')
    source.on('data', this.onSourceData)
  }

  // After dispose the real tty is released; late calls (Ink resuming its
  // suspended input while it unmounts) must not grab it again.
  setRawMode(enabled: boolean): this {
    if (!this.disposed) this.source.setRawMode?.(enabled)
    return this
  }

  ref(): this {
    if (!this.disposed) this.source.ref?.()
    return this
  }

  unref(): this {
    this.source.unref?.()
    return this
  }

  setNativeOwnership(enabled: boolean): void {
    this.nativeOwnership = enabled
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.source.off('data', this.onSourceData)
    try {
      const tail = this.decoder.flush()
      if (!this.nativeOwnership && tail !== '') this.write(tail)
      this.end()
    } finally {
      // Release all resources even if ending the stream or restoring raw mode
      // throws: Ink must not keep a detached TTY referenced.
      try {
        this.source.setRawMode?.(false)
      } finally {
        try {
          this.source.pause?.()
        } finally {
          this.source.unref?.()
        }
      }
    }
  }

  private readonly onSourceData = (data: string | Buffer): void => {
    const decoded = this.decoder.push(data.toString())
    for (const part of decoded.parts) {
      if (part.kind === 'invalid') this.emit('invalid')
      else if (part.kind === 'tsp') this.emit('tsp', part.payload)
      // Tern's keys and events share the pty; delivering either kind out of
      // order changes the authoritative draft (and can invalidate edit.len).
      else if (this.nativeOwnership) this.emit('keys', part.data)
      else this.write(part.data)
    }
  }
}

export type TernSurfaceState =
  | { status: 'idle' }
  | { status: 'probing' }
  | { status: 'unsupported' }
  | { status: 'active'; hello: TspHello }

type StateListener = () => void
type EventListener = (event: TspEvent) => void
type KeyListener = (input: string) => void

export class TernTerminal {
  readonly stdin: TernInputMux
  private state: TernSurfaceState = { status: 'idle' }
  private readonly chunks = new TspChunkAssembler()
  private readonly stateListeners = new Set<StateListener>()
  private readonly eventListeners = new Set<EventListener>()
  private readonly keyListeners = new Set<KeyListener>()
  private probeTimer: NodeJS.Timeout | undefined
  private forcedRaw = false

  constructor(
    source: TernInputSource,
    private readonly stdout: TernOutput,
  ) {
    this.stdin = new TernInputMux(source)
    this.stdin.on('tsp', this.onTsp)
    this.stdin.on('invalid', this.onInvalid)
    this.stdin.on('keys', this.onKeys)
  }

  /** The mux as Ink's `render({ stdin })` option. */
  inkStdin(): NodeJS.ReadStream {
    const stream: Duplex = this.stdin
    // SAFETY: Ink 8 reads stdin only through isTTY, setEncoding, setRawMode,
    // ref/unref, read/unshift and listeners; TernInputMux (a PassThrough that
    // forwards raw mode and ref/unref to the real tty) implements all of them.
    return stream as NodeJS.ReadStream
  }

  readonly getSnapshot = (): TernSurfaceState => this.state

  readonly subscribeState = (listener: StateListener): (() => void) => {
    this.stateListeners.add(listener)
    return () => {
      this.stateListeners.delete(listener)
    }
  }

  readonly subscribeEvents = (listener: EventListener): (() => void) => {
    this.eventListeners.add(listener)
    return () => {
      this.eventListeners.delete(listener)
    }
  }

  readonly subscribeKeys = (listener: KeyListener): (() => void) => {
    this.keyListeners.add(listener)
    return () => {
      this.keyListeners.delete(listener)
    }
  }

  probe(): void {
    if (this.state.status !== 'idle') return
    if (!this.stdin.isTTY || !this.stdout.isTTY) {
      this.setState({ status: 'unsupported' })
      return
    }

    this.setState({ status: 'probing' })
    try {
      this.stdout.write(encodeTspHelloQuery())
    } catch {
      this.disableNativeSurface()
      return
    }

    // Ink itself uses a bounded capability-query timeout for terminal protocols.
    // TSP frames are intercepted by TernInputMux, so they never reach useInput.
    this.probeTimer = setTimeout(() => {
      if (this.state.status === 'probing') this.setState({ status: 'unsupported' })
    }, 200)
  }

  /** Leave presentation to Ink when the negotiated surface becomes untrustworthy. */
  disableNativeSurface(): void {
    if (this.probeTimer != null) clearTimeout(this.probeTimer)
    this.probeTimer = undefined
    this.chunks.clear()
    // Release the mux synchronously so subsequent ordinary bytes can reach Ink
    // even before the suspended React tree has completed its cleanup.
    try {
      this.endNativeOwnership()
    } catch {
      // Always publish fallback; a rejected paste-disable write is not a reason
      // to keep raw mode or input ownership.
    }
    if (this.state.status !== 'unsupported') this.setState({ status: 'unsupported' })
  }

  beginNativeOwnership(): void {
    this.stdin.setNativeOwnership(true)
    try {
      if (this.stdin.isTTY) {
        this.stdin.ref()
        // Mark before calling setRawMode: a throwing TTY may still have changed
        // its raw state. Roll back even when the paste-enable write fails.
        this.forcedRaw = true
        this.stdin.setRawMode(true)
        this.stdout.write(BRACKETED_PASTE_ON)
      }
    } catch (error) {
      try {
        this.endNativeOwnership()
      } catch {
        // Prefer the original setup error after attempting every restoration.
      }
      throw error
    }
  }

  endNativeOwnership(): void {
    let failure: unknown
    if (this.forcedRaw) {
      try {
        this.stdout.write(BRACKETED_PASTE_OFF)
      } catch (error) {
        failure = error
      }
      try {
        this.stdin.setRawMode(false)
        this.forcedRaw = false
      } catch (error) {
        failure ??= error
      }
      try {
        this.stdin.unref()
      } catch (error) {
        failure ??= error
      }
    }
    this.stdin.setNativeOwnership(false)
    if (failure instanceof Error) throw failure
    if (failure != null) throw new Error('Failed to restore native TTY', { cause: failure })
  }

  write(data: string): void {
    this.stdout.write(data)
  }

  dispose(): void {
    if (this.probeTimer) clearTimeout(this.probeTimer)
    try {
      this.endNativeOwnership()
    } finally {
      this.stdin.off('tsp', this.onTsp)
      this.stdin.off('invalid', this.onInvalid)
      this.stdin.off('keys', this.onKeys)
      this.chunks.clear()
      this.stdin.dispose()
      this.stateListeners.clear()
      this.eventListeners.clear()
      this.keyListeners.clear()
    }
  }

  private readonly onInvalid = (): void => {
    this.disableNativeSurface()
  }

  private readonly onKeys = (input: string): void => {
    for (const listener of this.keyListeners) listener(input)
  }

  private readonly onTsp = (payload: string): void => {
    if (this.state.status === 'unsupported') return
    const complete = this.chunks.accept(payload)
    if (complete == null) return
    const hello = decodeTspHello(complete)
    if (hello) {
      if (this.probeTimer) clearTimeout(this.probeTimer)
      this.probeTimer = undefined
      this.setState(
        hello.v === TSP_VERSION ? { status: 'active', hello } : { status: 'unsupported' },
      )
      return
    }

    const event = decodeTspEvent(complete)
    if (!event || this.state.status !== 'active') return
    // No automatic replay into an evicted or rejected Tern document. Resume Ink
    // rather than assuming surface recovery, missing ACKs, or approval authority.
    if (
      (event.ev === 'gone' || event.ev === 'error') &&
      (!('sf' in event) || event.sf == null || event.sf === 'omnara:session')
    ) {
      this.disableNativeSurface()
      return
    }
    for (const listener of this.eventListeners) listener(event)
  }

  private setState(state: TernSurfaceState): void {
    this.state = state
    for (const listener of this.stateListeners) listener()
  }
}
