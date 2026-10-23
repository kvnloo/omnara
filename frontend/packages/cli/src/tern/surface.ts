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
  idle,
  liveProjectionEnabled,
  sendable,
  main,
  draft,
  onDraftChange,
  onQuit,
  onSend,
}: {
  terminal: TernTerminal
  enabled: boolean
  idle: boolean
  liveProjectionEnabled: boolean
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
  // React may render an older draft between successive PTY reads. Hold only the
  // latest application-owned write until its state update reaches React.
  const pendingDraftRef = useRef<string | null>(null)
  const nativeTextRef = useRef(draft)
  const cursorRef = useRef(draft.length)
  const sendableRef = useRef(sendable)
  const mainRef = useRef(main)
  const transportRef = useRef<TernComposerTransport | null>(null)

  useEffect(() => {
    callbacksRef.current = { onDraftChange, onQuit, onSend }
    sendableRef.current = sendable
    mainRef.current = main
    if (draft === pendingDraftRef.current) pendingDraftRef.current = null
    // A previous React render must not roll back uncommitted native PTY bytes.
    // When ownership ends, this ref still holds the most recent local draft.
    if (pendingDraftRef.current === null) draftRef.current = draft
  }, [draft, main, onDraftChange, onQuit, onSend, sendable])

  useEffect(() => {
    if (enabled && surface.status === 'idle') terminal.probe()
  }, [enabled, surface.status, terminal])

  const liveCapable =
    liveProjectionEnabled && surface.status === 'active' && supportsTernLiveSurface(surface.hello)
  const canOwnSurface = sendable && (idle || liveCapable)

  useEffect(() => {
    if (
      !enabled ||
      !canOwnSurface ||
      surface.status !== 'active' ||
      !supportsTernComposer(surface.hello)
    ) {
      return
    }

    const lifecycle = { cancelled: false }
    let owned = false
    let unsubscribe: (() => void) | undefined
    let unsubscribeKeys: (() => void) | undefined
    let ownedTransport: TernComposerTransport | undefined
    let resume: (() => Promise<void>) | undefined
    const hello = surface.hello
    const projectMain = liveProjectionEnabled && supportsTernLiveSurface(hello)
    let lastAtomicSend: string | undefined
    let quitting = false

    const teardown = (): void => {
      unsubscribe?.()
      unsubscribe = undefined
      unsubscribeKeys?.()
      unsubscribeKeys = undefined
      const transport = ownedTransport
      ownedTransport = undefined
      if (transportRef.current === transport) transportRef.current = null
      let failed = false
      try {
        transport?.stop()
      } catch {
        failed = true
      }
      if (owned) {
        owned = false
        try {
          terminal.endNativeOwnership()
        } catch {
          failed = true
        }
      }
      if (resume != null) {
        const restore = resume
        resume = undefined
        void restore().catch(() => {
          terminal.disableNativeSurface()
        })
      }
      if (failed) terminal.disableNativeSurface()
    }

    const quit = (): void => {
      if (lifecycle.cancelled || quitting) return
      quitting = true
      // Release native input and paste mode before resuming Ink to exit. Ink
      // may reacquire raw mode during resume; runChat.dispose() cooks it again.
      const restore = resume
      resume = undefined
      teardown()
      if (restore == null) {
        callbacksRef.current.onQuit()
        return
      }
      void restore()
        .catch(() => {
          terminal.disableNativeSurface()
        })
        .then(() => {
          callbacksRef.current.onQuit()
        })
    }

    void (async () => {
      try {
        const suspension = await suspendTerminal()
        resume = () => suspension.resume()
        // A pending Ink suspension may settle after an interaction arrives.
        if (lifecycle.cancelled) {
          teardown()
          return
        }

        owned = true
        terminal.beginNativeOwnership()
        nativeTextRef.current = draftRef.current
        cursorRef.current = draftRef.current.length

        const transport = new TernComposerTransport((data) => {
          terminal.write(data)
        }, hello)
        transportRef.current = transport
        ownedTransport = transport
        transport.start(
          { cursor: cursorRef.current, text: nativeTextRef.current },
          sendableRef.current,
          projectMain ? mainRef.current : [],
        )

        const currentMain = (): readonly TernLiveNode[] => (projectMain ? mainRef.current : [])

        const applyDraft = (next: { cursor: number; text: string }): void => {
          if (next.text !== nativeTextRef.current) lastAtomicSend = undefined
          nativeTextRef.current = next.text
          cursorRef.current = next.cursor
          draftRef.current = next.text
          pendingDraftRef.current = next.text
          callbacksRef.current.onDraftChange(next.text)
          transport.update(next, sendableRef.current, currentMain())
        }

        const submit = (text: string, fromPty = false): void => {
          if (lifecycle.cancelled || quitting || !owned || !sendableRef.current) return
          const trimmed = text.trim()
          if (trimmed === '' || (!fromPty && lastAtomicSend === text)) return
          // A repeated atomic event is suppressible until the next edit, but
          // an ordinary PTY Enter is a separate action even for equal text.
          lastAtomicSend = fromPty ? undefined : text
          nativeTextRef.current = ''
          cursorRef.current = 0
          draftRef.current = ''
          pendingDraftRef.current = ''
          callbacksRef.current.onDraftChange('')
          transport.update({ cursor: 0, text: '' }, sendableRef.current, currentMain())

          if (trimmed === '/quit' || trimmed === '/exit') {
            quit()
            return
          }

          // The native atomic payload is its own prompt, not an instruction to
          // submit the local editor. Ordinary PTY Enter retains Ink's trimming.
          void callbacksRef.current.onSend(fromPty ? trimmed : text).catch(() => undefined)
        }

        unsubscribe = terminal.subscribeEvents((event) => {
          if (lifecycle.cancelled || !owned) return
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
          // TSP native send is an independent prompt; it does not submit the
          // current PTY draft. Equality, prefixes and ACK timing are not
          // evidence that Tern supplied stale text.
          submit(event.text)
        })

        // Ordinary typing still arrives on the pty while Tern draws the editor.
        const keys = new TernComposerKeyDecoder()
        unsubscribeKeys = terminal.subscribeKeys((input) => {
          if (lifecycle.cancelled || quitting || !owned) return
          for (const key of keys.push(input)) {
            if (key.kind === 'quit') {
              quit()
              return
            }
            if (key.kind === 'submit') {
              submit(nativeTextRef.current, true)
              continue
            }
            applyDraft(
              applyTernComposerKey({ cursor: cursorRef.current, text: nativeTextRef.current }, key),
            )
          }
        })
      } catch {
        teardown()
        // A failed native setup must not leave Ink suspended or retry forever.
        terminal.disableNativeSurface()
      }
    })()

    return () => {
      lifecycle.cancelled = true
      teardown()
    }
  }, [canOwnSurface, enabled, liveProjectionEnabled, surface, suspendTerminal, terminal])

  useEffect(() => {
    const transport = transportRef.current
    if (transport == null) return

    // Do not reconcile nativeTextRef from the React prop here. Incremental
    // PTY bytes can be newer than a scheduled React render of the same draft.
    // The native model is updated synchronously before notifying React; it is
    // adopted from the canonical prop again on each new ownership lifecycle.
    const projectMain =
      liveProjectionEnabled && surface.status === 'active' && supportsTernLiveSurface(surface.hello)
    transport.update(
      { cursor: cursorRef.current, text: nativeTextRef.current },
      sendable,
      projectMain ? main : [],
    )
  }, [draft, liveProjectionEnabled, main, sendable, surface])
}
