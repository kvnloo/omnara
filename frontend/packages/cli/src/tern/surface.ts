import { useApp } from 'ink'
import { useEffect, useRef, useSyncExternalStore } from 'react'

import {
  applyTernComposerEdit,
  supportsTernComposer,
  supportsTernLiveSurface,
  TERN_COMPOSER_ID,
  TERN_SURFACE_ID,
  TernComposerTransport,
} from './composer.ts'
import { applyTernComposerKey, TernComposerKeyDecoder } from './keys.ts'
import type { TernLiveNode } from './liveProjection.ts'
import type { TernTerminal } from './terminal.ts'

export function useTernComposerSurface({
  terminal,
  enabled,
  sendable,
  main,
  draft,
  onDraftChange,
  onQuit,
  onSend,
}: {
  terminal: TernTerminal
  enabled: boolean
  sendable: boolean
  main: readonly TernLiveNode[]
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
  const sendableRef = useRef(sendable)
  const mainRef = useRef(main)
  const transportRef = useRef<TernComposerTransport | null>(null)

  useEffect(() => {
    callbacksRef.current = { onDraftChange, onQuit, onSend }
    draftRef.current = draft
    sendableRef.current = sendable
    mainRef.current = main
  }, [draft, main, onDraftChange, onQuit, onSend, sendable])

  useEffect(() => {
    if (enabled && surface.status === 'idle') terminal.probe()
  }, [enabled, surface.status, terminal])

  const liveCapable = surface.status === 'active' && supportsTernLiveSurface(surface.hello)
  const canOwnSurface = sendable || liveCapable

  useEffect(() => {
    if (
      !enabled ||
      !canOwnSurface ||
      surface.status !== 'active' ||
      !supportsTernComposer(surface.hello)
    ) {
      return
    }

    let cancelled = false
    const isCancelled = (): boolean => cancelled
    let owned = false
    let unsubscribe: (() => void) | undefined
    let unsubscribeKeys: (() => void) | undefined
    let resume: (() => Promise<void>) | undefined
    const hello = surface.hello
    const projectMain = supportsTernLiveSurface(hello)

    void (async () => {
      try {
        const suspension = await suspendTerminal()
        // The effect cleanup may have run while suspendTerminal was pending.
        if (isCancelled()) {
          await suspension.resume()
          return
        }

        resume = () => suspension.resume()
        terminal.beginNativeOwnership()
        owned = true
        nativeTextRef.current = draftRef.current
        cursorRef.current = draftRef.current.length

        const transport = new TernComposerTransport((data) => {
          terminal.write(data)
        }, hello)
        transportRef.current = transport
        transport.start(
          { cursor: cursorRef.current, text: nativeTextRef.current },
          sendableRef.current,
          projectMain ? mainRef.current : [],
        )

        const currentMain = (): readonly TernLiveNode[] => (projectMain ? mainRef.current : [])

        const applyDraft = (next: { cursor: number; text: string }): void => {
          nativeTextRef.current = next.text
          cursorRef.current = next.cursor
          callbacksRef.current.onDraftChange(next.text)
          transport.update(next, sendableRef.current, currentMain())
        }

        const submit = (text: string): void => {
          if (!sendableRef.current) return
          const trimmed = text.trim()
          if (trimmed === '') return

          nativeTextRef.current = ''
          cursorRef.current = 0
          callbacksRef.current.onDraftChange('')
          transport.update({ cursor: 0, text: '' }, sendableRef.current, currentMain())

          if (trimmed === '/quit' || trimmed === '/exit') {
            callbacksRef.current.onQuit()
            return
          }

          void callbacksRef.current.onSend(trimmed).catch(() => undefined)
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
            const next = applyTernComposerEdit(nativeTextRef.current, event)
            if (next != null) applyDraft(next)
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
            applyDraft(
              applyTernComposerKey({ cursor: cursorRef.current, text: nativeTextRef.current }, key),
            )
          }
        })
      } catch {
        // TSP is optional presentation. Existing Ink remains authoritative fallback.
      }
    })()

    return () => {
      cancelled = true
      unsubscribe?.()
      unsubscribeKeys?.()
      const transport = transportRef.current
      transportRef.current = null
      transport?.stop()
      if (owned) terminal.endNativeOwnership()
      if (resume != null) void resume()
    }
  }, [canOwnSurface, enabled, surface, suspendTerminal, terminal])

  useEffect(() => {
    const transport = transportRef.current
    if (transport == null) return

    if (draft !== nativeTextRef.current) {
      nativeTextRef.current = draft
      cursorRef.current = draft.length
    }

    const projectMain = surface.status === 'active' && supportsTernLiveSurface(surface.hello)
    transport.update(
      { cursor: cursorRef.current, text: nativeTextRef.current },
      sendable,
      projectMain ? main : [],
    )
  }, [draft, main, sendable, surface])
}
