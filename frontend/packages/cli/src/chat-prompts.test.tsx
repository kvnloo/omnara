import { PassThrough } from 'node:stream'

import { Box, render, Text } from 'ink'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { TextInput } from './chat-prompts.tsx'
import { TernTerminal } from './tern/terminal.ts'

class FakeTty extends PassThrough {
  readonly isTTY = true
  isRaw = false

  setRawMode(value: boolean): void {
    this.isRaw = value
  }
}

function FallbackComposer({
  onSend,
  renderCount,
}: {
  onSend: (text: string) => void
  renderCount: number
}) {
  const [draft, setDraft] = useState('')
  return (
    <Box flexDirection="column">
      <Text>{renderCount}</Text>
      <TextInput
        value={draft}
        onChange={setDraft}
        onSubmit={(text) => {
          setDraft('')
          onSend(text)
        }}
      />
    </Box>
  )
}

function mount(onSend: (text: string) => void) {
  const source = new FakeTty()
  const output = Object.assign(new PassThrough(), {
    isTTY: true,
    columns: 100,
    rows: 30,
  })
  output.on('data', () => undefined)
  const terminal = new TernTerminal(source, output)
  const app = render(<FallbackComposer onSend={onSend} renderCount={0} />, {
    stdin: terminal.inkStdin(),
    stdout: output,
    patchConsole: false,
    exitOnCtrlC: false,
  })

  return {
    source,
    rerender: (count: number) => {
      app.rerender(<FallbackComposer onSend={onSend} renderCount={count} />)
    },
    dispose: () => {
      app.unmount()
      terminal.dispose()
    },
  }
}

describe('Ink fallback composer receives real PTY input', () => {
  it('submits the exact /ask bytes once across split reads before React commits', async () => {
    const onSend = vi.fn()
    const fixture = mount(onSend)
    try {
      await vi.waitFor(() => {
        expect(fixture.source.isRaw).toBe(true)
      })
      fixture.source.write('/')
      fixture.source.write('a')
      fixture.source.write('sk\r')
      await vi.waitFor(() => {
        expect(onSend).toHaveBeenCalledTimes(1)
        expect(onSend).toHaveBeenCalledWith('/ask')
      })
    } finally {
      fixture.dispose()
    }
  })

  it('preserves sequential PTY bytes with intervening renders and later Enter', async () => {
    const onSend = vi.fn()
    const fixture = mount(onSend)
    try {
      await vi.waitFor(() => {
        expect(fixture.source.isRaw).toBe(true)
      })
      for (const [index, part] of ['/', 'a', 's', 'k'].entries()) {
        fixture.source.write(part)
        fixture.rerender(index + 1)
        await Promise.resolve()
      }
      fixture.source.write('\r')
      await vi.waitFor(() => {
        expect(onSend).toHaveBeenCalledTimes(1)
        expect(onSend).toHaveBeenCalledWith('/ask')
      })
    } finally {
      fixture.dispose()
    }
  })

  it('retains Unicode characters and grapheme backspace across rapid reads', async () => {
    const onSend = vi.fn()
    const fixture = mount(onSend)
    try {
      await vi.waitFor(() => {
        expect(fixture.source.isRaw).toBe(true)
      })
      fixture.source.write('hello 👩‍👩‍👧')
      fixture.source.write('\x7f')
      fixture.source.write('🌍\r')
      await vi.waitFor(() => {
        expect(onSend).toHaveBeenCalledTimes(1)
        expect(onSend).toHaveBeenCalledWith('hello 🌍')
      })
    } finally {
      fixture.dispose()
    }
  })

  it('submits each Enter in one coalesced Ink input read without losing either prompt', async () => {
    const onSend = vi.fn()
    const fixture = mount(onSend)
    try {
      await vi.waitFor(() => {
        expect(fixture.source.isRaw).toBe(true)
      })
      fixture.source.write('first\rsecond\r')
      await vi.waitFor(() => {
        expect(onSend).toHaveBeenCalledTimes(2)
        expect(onSend).toHaveBeenNthCalledWith(1, 'first')
        expect(onSend).toHaveBeenNthCalledWith(2, 'second')
      })
    } finally {
      fixture.dispose()
    }
  })

  it('keeps carriage returns inside an Ink bracketed paste literal until a later Enter', async () => {
    const onSend = vi.fn()
    const fixture = mount(onSend)
    try {
      await vi.waitFor(() => {
        expect(fixture.source.isRaw).toBe(true)
      })
      fixture.source.write('\x1b[200~line one\r\n世界\x1b[201~')
      expect(onSend).not.toHaveBeenCalled()
      fixture.source.write('\r')
      await vi.waitFor(() => {
        expect(onSend).toHaveBeenCalledTimes(1)
        expect(onSend).toHaveBeenCalledWith('line one\r\n世界')
      })
    } finally {
      fixture.dispose()
    }
  })
})
