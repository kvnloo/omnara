import type { AgentInputBacklogItem, OmnaraUIMessage } from '@omnara/react'
import { describe, expect, it } from 'vitest'

import {
  projectTernBacklog,
  projectTernMessages,
  reconcileTernLiveNodes,
} from './liveProjection.ts'

const user = (text: string): OmnaraUIMessage =>
  ({
    id: 'evt-1',
    role: 'user',
    parts: [{ id: 'evt-1:block:0', type: 'text', text, state: 'done' }],
  }) as OmnaraUIMessage

const assistant = (text: string): OmnaraUIMessage =>
  ({
    id: 'turn:t-1',
    role: 'assistant',
    parts: [{ id: 'call-1:block:0', type: 'text', text, state: 'streaming' }],
  }) as OmnaraUIMessage

describe('native live projection', () => {
  it('uses Omnara message and part ids as stable native identity', () => {
    expect(projectTernMessages([user('hello')])[0]?.id).toBe('omnara:message:evt-1')
    expect(projectTernMessages([assistant('a')])[0]?.id).toBe(
      'omnara:message:turn:t-1:part:call-1:block:0',
    )
  })

  it('turns streaming suffixes into append operations', () => {
    const before = projectTernMessages([assistant('hello')])
    const after = projectTernMessages([assistant('hello world')])
    expect(reconcileTernLiveNodes('main', before, after)).toContainEqual([
      'text',
      'omnara:message:turn:t-1:part:call-1:block:0',
      'append',
      ' world',
    ])
  })

  it('keeps a tool id stable from running to terminal state', () => {
    const running = {
      id: 'turn:t-1',
      role: 'assistant',
      parts: [
        {
          id: 'ctx:block:0',
          type: 'dynamic-tool',
          toolCallId: 'tool-7',
          toolName: 'read_file',
          state: 'input-available',
          input: { path: 'README.md' },
        },
      ],
    } as OmnaraUIMessage
    const done = {
      ...running,
      parts: [
        {
          ...running.parts[0],
          state: 'output-available',
          output: {
            outcome: 'succeeded',
            contentBlocks: [{ type: 'text', text: 'ok' }],
          },
        },
      ],
    } as OmnaraUIMessage

    const before = projectTernMessages([running])
    const after = projectTernMessages([done])
    expect(before[0]?.id).toBe('omnara:tool:tool-7')
    expect(after[0]?.id).toBe(before[0]?.id)
    const ops = reconcileTernLiveNodes('main', before, after)
    expect(ops.some((op) => op[0] === 'del' && op[1] === 'omnara:tool:tool-7')).toBe(false)
    expect(JSON.stringify(ops)).toContain('"done"')
  })

  it('uses durable backlog ids', () => {
    const input = {
      id: 'input-9',
      delivery_mode: 'queued',
      text: 'follow up',
      attachmentCount: 0,
    } as AgentInputBacklogItem
    expect(projectTernBacklog([input])[0]?.id).toBe('omnara:backlog:input-9')
  })
})
