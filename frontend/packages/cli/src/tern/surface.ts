import { useApp } from 'ink'
import { useEffect, useRef, useSyncExternalStore } from 'react'

import {
  applyTernComposerEdit,
  supportsTernComposer,
  TERN_COMPOSER_ID,
  TERN_SURFACE_ID,
  TernComposerTransport,
} from './composer.ts'
import { applyTernComposerKey, TernComposerKeyDecoder } from './keys.ts'
import type { TernTerminal } from './terminal.ts'

export function useTernComposerSurface({
  terminal,
  enabled,
  draft,
  onDraftChange,
  onQuit,
  onSend,
}: {
  terminal: TernTerminal
  enabled: boolean
  draft: string
  onDraftChange: (value: string) => void
  onQuit: () => void
  onSend: (text: string) => Promise<void>
}): void {
  const { suspendTerminal } = useApp()
  const surface = useSyncExternalStore(
    terminal.subscribeState,
    terminal.getSnapshot,
    terminal.getSnapshot,
  )
  const callbacksRef = useRef({ onDraftChange, onQuit, onSend })
  const draftRef = useRef(draft)
  const nativeTextRef = useRef(draft)
  const cursorRef = useRef(draft.length)
  const sendLockedRef = useRef(false)
  const transportRef = useRef<TernComposerTransport | null>(null)

  useEffect(() => {
    callbacksRef.current = { onDraftChange, onQuit, onSend }
    draftRef.current = draft
  }, [draft, onDraftChange, onQuit, onSend])

  useEffect(() => {
    if (enabled && surface.status === 'idle') terminal.probe()
  }, [enabled, surface.status, terminal])

  useEffect(() => {
    if (!enabled || surface.status !== 'active' || !supportsTernComposer(surface.hello)) {
      return
    }

    let cancelled = false
    let unsubscribe: (() => void) | undefined
    let unsubscribeKeys: (() => void) | undefined
    let resume: (() => Promise<void>) | undefined
    const hello = surface.hello

    void (async () => {
      try {
        const suspension = await suspendTerminal()
        if (cancelled) {
          await suspension.resume()
          return
        }

        resume = suspension.resume
        terminal.beginNativeOwnership()
        nativeTextRef.current = draftRef.current
        cursorRef.current = draftRef.current.length
        sendLockedRef.current = false

        const transport = new TernComposerTransport((data) => terminal.write(data), hello)
        transportRef.current = transport
        transport.start({ cursor: cursorRef.current, text: nativeTextRef.current }, true)

        const applyDraft = (next: { cursor: number; text: string }): void => {
          nativeTextRef.current = next.text
          cursorRef.current = next.cursor
          callbacksRef.current.onDraftChange(next.text)
          transport.update(next, true)
        }

        const submit = (text: string): void => {
          if (sendLockedRef.current) return
          const trimmed = text.trim()
          if (trimmed === '') return

          sendLockedRef.current = true
          nativeTextRef.current = ''
          cursorRef.current = 0
          callbacksRef.current.onDraftChange('')
          transport.update({ cursor: 0, text: '' }, false)

          if (trimmed === '/quit' || trimmed === '/exit') {
            callbacksRef.current.onQuit()
            return
          }

          void callbacksRef.current.onSend(trimmed).catch(() => {
            sendLockedRef.current = false
            transport.update({ cursor: cursorRef.current, text: nativeTextRef.current }, true)
          })
        }

        unsubscribe = terminal.subscribeEvents((event) => {
          transport.handleEvent(event)

          if (
            !('sf' in event) ||
            event.sf !== TERN_SURFACE_ID ||
            !('id' in event) ||
            event.id !== TERN_COMPOSER_ID
          ) {
            return
          }

          if (event.ev === 'edit') {
            if (sendLockedRef.current) return
            const next = applyTernComposerEdit(nativeTextRef.current, event)
            if (next) applyDraft(next)
            return
          }

          if (event.ev !== 'send') return
          if (event.text !== nativeTextRef.current) return
          submit(event.text)
        })

        // Ordinary typing still arrives on the pty while Tern draws the editor.
        const keys = new TernComposerKeyDecoder()
        unsubscribeKeys = terminal.subscribeKeys((input) => {
          for (const key of keys.push(input)) {
            if (key.kind === 'quit') {
              callbacksRef.current.onQuit()
              return
            }
            if (key.kind === 'submit') {
              submit(nativeTextRef.current)
              continue
            }
            if (sendLockedRef.current) continue
            applyDraft(
              applyTernComposerKey({ cursor: cursorRef.current, text: nativeTextRef.current }, key),
            )
          }
        })
      } catch {
        // TSP is an optional presentation path. Ink remains the fallback.
      }
    })()

    return () => {
      cancelled = true
      unsubscribe?.()
      unsubscribeKeys?.()
      const transport = transportRef.current
      transportRef.current = null
      transport?.stop()
      terminal.endNativeOwnership()
      if (resume) void resume()
    }
  }, [enabled, surface, suspendTerminal, terminal])

  useEffect(() => {
    const transport = transportRef.current
    if (!transport || draft === nativeTextRef.current) return
    nativeTextRef.current = draft
    cursorRef.current = draft.length
    transport.update(
      { cursor: cursorRef.current, text: nativeTextRef.current },
      !sendLockedRef.current,
    )
  }, [draft])
}
