import { describe, expect, it } from 'vitest'

import type { AgentEvent } from '@omnara/sdk'
import type { OmnaraUIMessage } from '@omnara/react'

import { bridgeMessageKey } from './omp-bridge.ts'

describe('OMP bridge message identity', () => {
  it('keeps optimistic and durable user messages on the same key', () => {
    const optimistic = {
      id: 'local:req-123',
      role: 'user',
      parts: [],
    } as OmnaraUIMessage
    expect(bridgeMessageKey(optimistic, [])).toBe('input:req-123')

    const durable = {
      id: 'evt-message',
      role: 'user',
      parts: [],
      metadata: { eventId: 'evt-1' },
    } as OmnaraUIMessage
    const events = [
      {
        id: 'evt-1',
        event_kind: 'agent_input',
        input_idempotency_key: 'req-123',
      },
    ] as AgentEvent[]

    expect(bridgeMessageKey(durable, events)).toBe('input:req-123')
  })

  it('leaves stable assistant turn keys untouched', () => {
    const assistant = {
      id: 'turn:trn_123',
      role: 'assistant',
      parts: [],
    } as OmnaraUIMessage

    expect(bridgeMessageKey(assistant, [])).toBe('turn:trn_123')
  })
})
