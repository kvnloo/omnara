import { type Duplex, PassThrough } from 'node:stream'

import {
  decodeTspEvent,
  decodeTspHello,
  encodeTspHelloQuery,
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

/** Ordinary terminal input and the TSP payloads split out of one stdin chunk. */
export interface TspInputChunk {
  input: string
  tsp: string[]
}

export class TspInputDecoder {
  private pending = ''

  push(chunk: string): TspInputChunk {
    this.pending += chunk
    let input = ''
    const tsp: string[] = []

    for (;;) {
      const start = this.pending.indexOf(TSP_START)
      if (start === -1) {
        const keep = retainedPrefixLength(this.pending, TSP_START)
        input += this.pending.slice(0, this.pending.length - keep)
        this.pending = this.pending.slice(this.pending.length - keep)
        break
      }

      input += this.pending.slice(0, start)
      const end = this.pending.indexOf(ST, start + TSP_START.length)
      if (end === -1) {
        this.pending = this.pending.slice(start)
        break
      }

      tsp.push(this.pending.slice(start + 2, end))
      this.pending = this.pending.slice(end + ST.length)
    }

    return { input, tsp }
  }

  flush(): string {
    const input = this.pending
    this.pending = ''
    return input
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
    this.source.off('data', this.onSourceData)
    const tail = this.decoder.flush()
    if (!this.nativeOwnership && tail !== '') this.write(tail)
    this.end()
    // Hand the tty back cooked and released so the process can exit.
    this.source.setRawMode?.(false)
    this.source.pause?.()
    this.source.unref?.()
    this.disposed = true
  }

  private readonly onSourceData = (data: string | Buffer): void => {
    const decoded = this.decoder.push(data.toString())
    for (const payload of decoded.tsp) this.emit('tsp', payload)
    if (decoded.input === '') return
    // Tern still delivers ordinary keys as pty input while it shows the native
    // composer. Route them to that composer; Ink is suspended and must not see them.
    if (this.nativeOwnership) this.emit('keys', decoded.input)
    else this.write(decoded.input)
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
    this.stdin.on('keys', this.onKeys)
  }

  /** The mux as Ink's `render({ stdin })` option. */
  inkStdin(): NodeJS.ReadStream {
    const stream: Duplex = this.stdin
    // SAFETY: Ink 7 reads stdin only through isTTY, setEncoding, setRawMode,
    // ref/unref, read/unshift and listeners; TernInputMux (a PassThrough that
    // forwards raw mode and ref/unref to the real tty) implements all of them.
    return stream as NodeJS.ReadStream
  }

  readonly getSnapshot = (): TernSurfaceState => this.state

  readonly subscribeState = (listener: StateListener): (() => void) => {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  readonly subscribeEvents = (listener: EventListener): (() => void) => {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  readonly subscribeKeys = (listener: KeyListener): (() => void) => {
    this.keyListeners.add(listener)
    return () => this.keyListeners.delete(listener)
  }

  probe(): void {
    if (this.state.status !== 'idle') return
    if (!this.stdin.isTTY || !this.stdout.isTTY) {
      this.setState({ status: 'unsupported' })
      return
    }

    this.setState({ status: 'probing' })
    this.stdout.write(encodeTspHelloQuery())

    // Ink itself uses a bounded capability-query timeout for terminal protocols.
    // TSP frames are intercepted by TernInputMux, so they never reach useInput.
    this.probeTimer = setTimeout(() => {
      if (this.state.status === 'probing') this.setState({ status: 'unsupported' })
    }, 200)
  }

  beginNativeOwnership(): void {
    this.stdin.setNativeOwnership(true)
    if (this.stdin.isTTY) {
      this.stdin.ref()
      this.stdin.setRawMode(true)
      this.forcedRaw = true
      // Multi-line pastes must insert, not submit at the first newline.
      this.stdout.write(BRACKETED_PASTE_ON)
    }
  }

  endNativeOwnership(): void {
    if (this.forcedRaw) {
      this.stdout.write(BRACKETED_PASTE_OFF)
      this.stdin.setRawMode(false)
      this.forcedRaw = false
    }
    this.stdin.setNativeOwnership(false)
  }

  write(data: string): void {
    this.stdout.write(data)
  }

  dispose(): void {
    if (this.probeTimer) clearTimeout(this.probeTimer)
    this.endNativeOwnership()
    this.stdin.off('tsp', this.onTsp)
    this.stdin.off('keys', this.onKeys)
    this.stdin.dispose()
    this.stateListeners.clear()
    this.eventListeners.clear()
    this.keyListeners.clear()
  }

  private readonly onKeys = (input: string): void => {
    for (const listener of this.keyListeners) listener(input)
  }

  private readonly onTsp = (payload: string): void => {
    const hello = decodeTspHello(payload)
    if (hello) {
      if (this.probeTimer) clearTimeout(this.probeTimer)
      this.probeTimer = undefined
      this.setState(
        hello.v === TSP_VERSION ? { status: 'active', hello } : { status: 'unsupported' },
      )
      return
    }

    const event = decodeTspEvent(payload)
    if (!event || this.state.status !== 'active') return
    for (const listener of this.eventListeners) listener(event)
  }

  private setState(state: TernSurfaceState): void {
    this.state = state
    for (const listener of this.stateListeners) listener()
  }
}
