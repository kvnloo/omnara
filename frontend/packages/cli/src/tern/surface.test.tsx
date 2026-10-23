import { PassThrough } from 'node:stream'

import { Text, render } from 'ink'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { TernLiveNode } from './liveProjection.ts'
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

type Mode = { enabled: boolean; idle: boolean; liveProjectionEnabled: boolean }
type Props = Mode & {
  terminal: TernTerminal
  onSend: (text: string) => Promise<void>
  main?: readonly TernLiveNode[]
}

function Harness({ terminal, onSend, main = [], ...mode }: Props) {
  const [draft, setDraft] = useState('')
  useTernComposerSurface({
    terminal,
    ...mode,
    sendable: mode.enabled,
    main,
    draft,
    onDraftChange: setDraft,
    onQuit: () => undefined,
    onSend,
  })
  return <Text>Ink draft: {draft}</Text>
}

const hello = (kinds: string[] = ['col', 'editor']) =>
  '\x1b_tsp;r;' + JSON.stringify({
    r: 'hello', v: 1, term: 'tern', kinds, credits: 2,
  }) + '\x1b\\'
const event = (data: object) => '\x1b_tsp;e;' + JSON.stringify(data) + '\x1b\\'
const send = (text: string) =>
  event({ ev: 'send', sf: 'omnara:session', id: 'omnara:composer', text })

function mount(mode: Mode, onSend: (text: string) => Promise<void>) {
  const source = new FakeTty()
  const stdout = Object.assign(new PassThrough(), {
    isTTY: true,
    columns: 100,
    rows: 35,
  })
  const writes: string[] = []
  stdout.on('data', (chunk: Buffer) => writes.push(chunk.toString()))
  const terminal = new TernTerminal(source, stdout)
  const props: Props = { ...mode, terminal, onSend }
  const app = render(<Harness {...props} />, {
    stdin: terminal.inkStdin(),
    stdout: stdout as unknown as NodeJS.WriteStream,
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
  await vi.waitFor(() => expect(fixture.terminal.getSnapshot().status).toBe('probing'))
  fixture.source.write(hello(kinds))
  await vi.waitFor(() => expect(fixture.source.isRaw).toBe(true))
  await vi.waitFor(() =>
    expect(fixture.writes.join('')).toContain('"id":"omnara:session"'),
  )
}

describe('mounted Ink/Tern composer lifecycle', () => {
  it('accepts an atomic Unicode multiline send from an empty draft once', async () => {
    const sends: string[] = []
    const fixture = mount(
      { enabled: true, idle: true, liveProjectionEnabled: false },
      async (text) => { sends.push(text) },
    )
    try {
      await activate(fixture)
      fixture.source.write(send('hello 🌿\n世界'))
      await vi.waitFor(() => expect(sends).toEqual(['hello 🌿\n世界']))
      fixture.source.write(send('hello 🌿\n世界'))
      expect(sends).toHaveLength(1)
      fixture.source.write(send('a different atomic prompt'))
      await vi.waitFor(() => expect(sends).toHaveLength(2))
      expect(sends[1]).toBe('a different atomic prompt')
    } finally {
      fixture.dispose()
    }
  })

  it('closes idle native ownership during work and an interaction, then resumes', async () => {
    const onSend = vi.fn(async (_text: string) => undefined)
    const fixture = mount(
      { enabled: true, idle: true, liveProjectionEnabled: false }, onSend,
    )
    try {
      await activate(fixture)
      fixture.rerender({ enabled: true, idle: false, liveProjectionEnabled: false })
      await vi.waitFor(() => expect(fixture.writes.join('')).toContain('\x1b[?2004l'))
      const inkInput: string[] = []
      fixture.terminal.stdin.on('data', (chunk: Buffer) => inkInput.push(chunk.toString()))
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
    const onSend = vi.fn(async (_text: string) => undefined)
    const fixture = mount(
      { enabled: true, idle: false, liveProjectionEnabled: true }, onSend,
    )
    try {
      const richKinds = ['col', 'editor', 'md', 'card', 'text', 'tool', 'code']
      await activate(fixture, richKinds)
      const main: TernLiveNode[] = [
        { id: 'omnara:message:fixture', k: 'text', p: { text: 'live projection' } },
      ]
      fixture.rerender(
        { enabled: true, idle: false, liveProjectionEnabled: true },
        main,
      )
      await vi.waitFor(() => expect(fixture.writes.join('')).toContain('live projection'))
      fixture.source.write(send('backlog payload'))
      await vi.waitFor(() => expect(onSend).toHaveBeenCalledWith('backlog payload'))
      fixture.source.write(event({ ev: 'gone', sf: 'omnara:session', ids: ['main'] }))
      await vi.waitFor(() =>
        expect(fixture.terminal.getSnapshot().status).toBe('unsupported'),
      )
    } finally {
      fixture.dispose()
    }
  })

  it('never claims busy native presentation without rich negotiated kinds', async () => {
    const fixture = mount(
      { enabled: true, idle: false, liveProjectionEnabled: true },
      vi.fn(async () => undefined),
    )
    try {
      await vi.waitFor(() => expect(fixture.terminal.getSnapshot().status).toBe('probing'))
      fixture.source.write(hello())
      await vi.waitFor(() => expect(fixture.terminal.getSnapshot().status).toBe('active'))
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
    stdout.write = ((chunk: string | Uint8Array) => {
      const value = chunk.toString()
      writes.push(value)
      if (value === '\x1b[?2004h') throw new Error('broken paste enable')
      return write(chunk)
    }) as typeof stdout.write
    const terminal = new TernTerminal(source, stdout)
    const app = render(
      <Harness terminal={terminal} enabled idle liveProjectionEnabled={false}
        onSend={async () => undefined} />,
      {
        stdin: terminal.inkStdin(),
        stdout: stdout as unknown as NodeJS.WriteStream,
        patchConsole: false,
        exitOnCtrlC: false,
      },
    )
    try {
      await vi.waitFor(() => expect(terminal.getSnapshot().status).toBe('probing'))
      source.write(hello())
      await vi.waitFor(() => expect(terminal.getSnapshot().status).toBe('unsupported'))
      expect(writes).toContain('\x1b[?2004l')
      expect(source.isRaw).toBe(false)
    } finally {
      app.unmount()
      terminal.dispose()
    }
  })
})
