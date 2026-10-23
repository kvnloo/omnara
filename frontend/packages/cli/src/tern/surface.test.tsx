import { PassThrough } from 'node:stream'

import { render, Text } from 'ink'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { TernLiveNode } from './liveProjection.ts'
import type { TspJson } from './protocol.ts'
import { useTernComposerSurface } from './surface.ts'
import { TernTerminal } from './terminal.ts'

class FakeTty extends PassThrough {
  readonly isTTY = true
  isRaw = false
  refs = 0

  setRawMode(value: boolean): void {
    this.isRaw = value
  }

  ref(): void {
    this.refs += 1
  }

  unref(): void {
    this.refs = 0
  }
}

interface Mode {
  enabled: boolean
  idle: boolean
  liveProjectionEnabled: boolean
}
interface Props extends Mode {
  terminal: TernTerminal
  onSend: (text: string) => Promise<void>
  onQuit?: () => void
  main?: readonly TernLiveNode[]
}

function Harness({ terminal, onSend, onQuit = () => undefined, main = [], ...mode }: Props) {
  const [draft, setDraft] = useState('')
  useTernComposerSurface({
    terminal,
    ...mode,
    sendable: mode.enabled,
    main,
    draft,
    onDraftChange: setDraft,
    onQuit,
    onSend,
  })
  return <Text>Ink draft: {draft}</Text>
}

const hello = (kinds: string[] = ['col', 'editor']) =>
  '\x1b_tsp;r;' +
  JSON.stringify({ r: 'hello', v: 1, term: 'tern', kinds, credits: 2 }) +
  '\x1b\\'
const event = (data: TspJson) => '\x1b_tsp;e;' + JSON.stringify(data) + '\x1b\\'
const send = (text: string) =>
  event({ ev: 'send', sf: 'omnara:session', id: 'omnara:composer', text })

function mount(
  mode: Mode,
  onSend: (text: string) => Promise<void>,
  onQuit?: () => void,
) {
  const source = new FakeTty()
  const stdout = Object.assign(new PassThrough(), {
    isTTY: true,
    columns: 100,
    rows: 35,
  })
  const writes: string[] = []
  stdout.on('data', (chunk: Buffer) => {
    writes.push(chunk.toString())
  })
  const terminal = new TernTerminal(source, stdout)
  const props: Props = { ...mode, terminal, onSend, onQuit }
  const app = render(<Harness {...props} />, {
    stdin: terminal.inkStdin(),
    // SAFETY: Ink uses .write, isTTY and dimensions; the writable fixture provides them.
    stdout: stdout as NodeJS.WriteStream,
    patchConsole: false,
    exitOnCtrlC: false,
  })

  return {
    source,
    terminal,
    writes,
    rerender: (next: Mode, main?: readonly TernLiveNode[]) => {
      app.rerender(<Harness {...{ ...props, ...next, main }} />)
    },
    dispose: () => {
      app.unmount()
      terminal.dispose()
    },
  }
}

async function activate(fixture: ReturnType<typeof mount>, kinds?: string[]) {
  await vi.waitFor(() => {
    expect(fixture.terminal.getSnapshot().status).toBe('probing')
  })
  fixture.source.write(hello(kinds))
  await vi.waitFor(() => {
    expect(fixture.source.isRaw).toBe(true)
  })
  await vi.waitFor(() => {
    expect(fixture.writes.join('')).toContain('"id":"omnara:session"')
  })
}

describe('mounted Ink/Tern composer lifecycle', () => {
  it('accepts an atomic Unicode multiline send from an empty draft once', async () => {
    const sends: string[] = []
    const fixture = mount(
      { enabled: true, idle: true, liveProjectionEnabled: false },
      (text) => {
        sends.push(text)
        return Promise.resolve()
      },
    )
    try {
      await activate(fixture)
      fixture.source.write(send('hello 🌿\n世界'))
      await vi.waitFor(() => {
        expect(sends).toEqual(['hello 🌿\n世界'])
      })
      fixture.source.write(send('hello 🌿\n世界'))
      expect(sends).toHaveLength(1)
      fixture.source.write(send('a different atomic prompt'))
      await vi.waitFor(() => {
        expect(sends).toHaveLength(2)
      })
      expect(sends[1]).toBe('a different atomic prompt')
    } finally {
      fixture.dispose()
    }
  })

  it('does not drop a distinct atomic send while the previous send promise is pending', async () => {
    const sends: string[] = []
    const complete: Array<() => void> = []
    const fixture = mount(
      { enabled: true, idle: true, liveProjectionEnabled: false },
      (text) => {
        sends.push(text)
        return new Promise<void>((resolve) => {
          complete.push(resolve)
        })
      },
    )
    try {
      await activate(fixture)
      fixture.source.write(send('first 🌿'))
      fixture.source.write(send('first 🌿'))
      fixture.source.write(send('second 世界'))
      await vi.waitFor(() => {
        expect(sends).toEqual(['first 🌿', 'second 世界'])
      })
    } finally {
      for (const resolve of complete) resolve()
      fixture.dispose()
    }
  })

  it('sends exact PTY text once when typed bytes and Enter share a read', async () => {
    const onSend = vi.fn((_text: string) => Promise.resolve())
    const fixture = mount({ enabled: true, idle: true, liveProjectionEnabled: false }, onSend)
    try {
      await activate(fixture)
      fixture.source.write('hello 🌍\\n第二行\\r'.replace('\\n', '\n').replace('\\r', '\r'))
      await vi.waitFor(() => {
        expect(onSend).toHaveBeenCalledExactlyOnceWith('hello 🌍\n第二行')
      })
    } finally {
      fixture.dispose()
    }
  })

  it('assembles split reads with intervening React renders before sending /ask', async () => {
    const sent: string[] = []
    const mode = { enabled: true, idle: true, liveProjectionEnabled: false }
    const fixture = mount(mode, (text) => {
      sent.push(text)
      return Promise.resolve()
    })
    try {
      await activate(fixture)
      for (const part of ['/', 'a', 's', 'k']) {
        fixture.source.write(part)
        // Force React through unrelated props while each state update may lag.
        fixture.rerender(mode)
        await Promise.resolve()
      }
      fixture.source.write('\r')
      await vi.waitFor(() => {
        expect(sent).toEqual(['/ask'])
      })
    } finally {
      fixture.dispose()
    }
  })

  it('preserves fragmented UTF-8 bytes and a bracketed multiline paste', async () => {
    const sent: string[] = []
    const fixture = mount(
      { enabled: true, idle: true, liveProjectionEnabled: false },
      (text) => {
        sent.push(text)
        return Promise.resolve()
      },
    )
    try {
      await activate(fixture)
      const utf8 = Buffer.from('hè 🌍 第二行', 'utf8')
      for (let offset = 0; offset < utf8.length; offset += 1) {
        fixture.source.write(utf8.subarray(offset, offset + 1))
      }
      fixture.source.write('\r')
      await vi.waitFor(() => {
        expect(sent).toEqual(['hè 🌍 第二行'])
      })
      fixture.source.write('\x1b[200~line one\r\n第二行')
      fixture.source.write('\r第三行\x1b[201~\r')
      await vi.waitFor(() => {
        expect(sent).toEqual(['hè 🌍 第二行', 'line one\n第二行\n第三行'])
      })
    } finally {
      fixture.dispose()
    }
  })

  it('keeps PTY draft intact across interleaved APC ACK, resize, theme and focus', async () => {
    const sent: string[] = []
    const mode = { enabled: true, idle: true, liveProjectionEnabled: false }
    const fixture = mount(mode, (text) => {
      sent.push(text)
      return Promise.resolve()
    })
    try {
      await activate(fixture)
      fixture.source.write('/a' + event({ ev: 'ack', sf: 'omnara:session', s: 1 }))
      fixture.rerender(mode)
      fixture.source.write(event({ ev: 'resize', sf: 'omnara:session', cols: 100, visible: true }))
      fixture.source.write('s' + event({ ev: 'theme', dark: false }))
      fixture.rerender(mode)
      fixture.source.write(event({ ev: 'focus', sf: 'omnara:session', id: 'omnara:composer' }) + 'k\r')
      await vi.waitFor(() => {
        expect(sent).toEqual(['/ask'])
      })
    } finally {
      fixture.dispose()
    }
  })

  it('does not submit a stale native prefix or duplicate the PTY Enter submission', async () => {
    const sent: string[] = []
    const fixture = mount(
      { enabled: true, idle: true, liveProjectionEnabled: false },
      (text) => {
        sent.push(text)
        return Promise.resolve()
      },
    )
    try {
      await activate(fixture)
      fixture.source.write('/ask')
      fixture.source.write(send('/'))
      fixture.source.write('\r')
      await vi.waitFor(() => {
        expect(sent).toEqual(['/ask'])
      })
      // A late TSP send from the stale rendered editor is not a new prompt.
      fixture.source.write('/ask\r' + send('/'))
      await vi.waitFor(() => {
        expect(sent).toEqual(['/ask', '/ask'])
      })
    } finally {
      fixture.dispose()
    }
  })

  it('retains /ask after busy-to-idle and Ink interaction handoffs', async () => {
    const sent: string[] = []
    const mode = { enabled: true, idle: true, liveProjectionEnabled: false }
    const fixture = mount(mode, (text) => {
      sent.push(text)
      return Promise.resolve()
    })
    try {
      await activate(fixture)
      fixture.source.write('first 🌿\r')
      await vi.waitFor(() => {
        expect(sent).toEqual(['first 🌿'])
      })
      fixture.rerender({ ...mode, idle: false })
      await vi.waitFor(() => {
        expect(fixture.source.isRaw).toBe(false)
      })
      fixture.rerender({ ...mode, enabled: false })
      fixture.rerender(mode)
      await vi.waitFor(() => {
        expect(fixture.writes.filter((part) => part.includes('\x1b[?2004h')).length).toBeGreaterThan(1)
      })
      fixture.source.write('/')
      fixture.rerender(mode)
      fixture.source.write('a')
      fixture.rerender(mode)
      fixture.source.write('sk\r')
      await vi.waitFor(() => {
        expect(sent).toEqual(['first 🌿', '/ask'])
      })
    } finally {
      fixture.dispose()
    }
  })

  it('restores the terminal and exits once after /quit from real PTY bytes', async () => {
    const onQuit = vi.fn()
    const onSend = vi.fn((_text: string) => Promise.resolve())
    const fixture = mount(
      { enabled: true, idle: true, liveProjectionEnabled: false },
      onSend,
      onQuit,
    )
    try {
      await activate(fixture)
      fixture.source.write('/quit\r')
      await vi.waitFor(() => {
        expect(onQuit).toHaveBeenCalledTimes(1)
      })
      expect(onSend).not.toHaveBeenCalled()
    } finally {
      fixture.dispose()
    }
    expect(fixture.source.isRaw).toBe(false)
    expect(fixture.source.refs).toBe(0)
    expect(fixture.source.isPaused()).toBe(true)
  })

  it('closes idle native ownership during work and an interaction, then resumes', async () => {
    const onSend = vi.fn((_text: string) => Promise.resolve())
    const fixture = mount({ enabled: true, idle: true, liveProjectionEnabled: false }, onSend)
    try {
      await activate(fixture)
      fixture.rerender({ enabled: true, idle: false, liveProjectionEnabled: false })
      await vi.waitFor(() => {
        expect(fixture.writes.join('')).toContain('\x1b[?2004l')
      })
      const inkInput: string[] = []
      fixture.terminal.stdin.on('data', (chunk: Buffer) => {
        inkInput.push(chunk.toString())
      })
      fixture.source.write('z')
      expect(inkInput.join('')).toContain('z')
      fixture.rerender({ enabled: false, idle: true, liveProjectionEnabled: false })
      fixture.rerender({ enabled: true, idle: true, liveProjectionEnabled: false })
      await vi.waitFor(() => {
        expect(fixture.writes.filter((part) => part.includes('\x1b[?2004h')).length)
          .toBeGreaterThan(1)
      })
    } finally {
      fixture.dispose()
    }
  })

  it('projects explicit live nodes while busy only with opted-in capabilities', async () => {
    const onSend = vi.fn((_text: string) => Promise.resolve())
    const fixture = mount(
      { enabled: true, idle: false, liveProjectionEnabled: true }, onSend,
    )
    try {
      const richKinds = ['col', 'editor', 'md', 'card', 'text', 'tool', 'code']
      await activate(fixture, richKinds)
      const main: TernLiveNode[] = [
        { id: 'omnara:message:fixture', k: 'text', p: { text: 'live projection' } },
      ]
      fixture.rerender({ enabled: true, idle: false, liveProjectionEnabled: true }, main)
      await vi.waitFor(() => {
        expect(fixture.writes.join('')).toContain('live projection')
      })
      fixture.source.write(send('backlog payload'))
      await vi.waitFor(() => {
        expect(onSend).toHaveBeenCalledWith('backlog payload')
      })
      fixture.source.write(event({ ev: 'gone', sf: 'omnara:session', ids: ['main'] }))
      await vi.waitFor(() => {
        expect(fixture.terminal.getSnapshot().status).toBe('unsupported')
      })
    } finally {
      fixture.dispose()
    }
  })

  it('never claims busy native presentation without rich negotiated kinds', async () => {
    const fixture = mount(
      { enabled: true, idle: false, liveProjectionEnabled: true },
      vi.fn(() => Promise.resolve()),
    )
    try {
      await vi.waitFor(() => {
        expect(fixture.terminal.getSnapshot().status).toBe('probing')
      })
      fixture.source.write(hello())
      await vi.waitFor(() => {
        expect(fixture.terminal.getSnapshot().status).toBe('active')
      })
      expect(fixture.writes.join('')).not.toContain('\x1b[?2004h')
      fixture.source.write('ink input')
    } finally {
      fixture.dispose()
    }
  })

  it('releases a native surface when setup fails after Ink suspension', async () => {
    const source = new FakeTty()
    const writes: string[] = []
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 100, rows: 35 })
    const write = stdout.write.bind(stdout)
    Object.defineProperty(stdout, 'write', {
      value: (chunk: string | Uint8Array): boolean => {
        const value = chunk.toString()
        writes.push(value)
        if (value === '\x1b[?2004h') throw new Error('broken paste enable')
        return write(chunk)
      },
    })
    const terminal = new TernTerminal(source, stdout)
    const app = render(
      <Harness
        terminal={terminal}
        enabled
        idle
        liveProjectionEnabled={false}
        onSend={() => Promise.resolve()}
      />,
      {
        stdin: terminal.inkStdin(),
        // SAFETY: Ink uses .write, isTTY and dimensions; the writable fixture provides them.
        stdout: stdout as NodeJS.WriteStream,
        patchConsole: false,
        exitOnCtrlC: false,
      },
    )
    try {
      await vi.waitFor(() => {
        expect(terminal.getSnapshot().status).toBe('probing')
      })
      source.write(hello())
      await vi.waitFor(() => {
        expect(terminal.getSnapshot().status).toBe('unsupported')
      })
      expect(writes).toContain('\x1b[?2004l')
      expect(source.isRaw).toBe(false)
    } finally {
      app.unmount()
      terminal.dispose()
    }
  })
})
