import type { AgentInputBacklogItem, OmnaraUIMessage } from '@omnara/react'
import { describe, expect, it } from 'vitest'

import {
  projectTernBacklog,
  projectTernMessages,
  reconcileTernLiveNodes,
} from './liveProjection.ts'

const user = (text: string): OmnaraUIMessage => ({
  id: 'evt-1',
  role: 'user',
  parts: [{ id: 'evt-1:block:0', type: 'text', text, state: 'done' }],
})

const assistant = (text: string): OmnaraUIMessage => ({
  id: 'turn:t-1',
  role: 'assistant',
  parts: [{ id: 'call-1:block:0', type: 'text', text, state: 'streaming' }],
})

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
    const tool = {
      id: 'ctx:block:0',
      type: 'dynamic-tool',
      toolCallId: 'tool-7',
      toolName: 'read_file',
      input: { path: 'README.md' },
    } as const
    const running: OmnaraUIMessage = {
      id: 'turn:t-1',
      role: 'assistant',
      parts: [{ ...tool, state: 'input-available' }],
    }
    const done: OmnaraUIMessage = {
      ...running,
      parts: [
        {
          ...tool,
          state: 'output-available',
          output: {
            outcome: 'succeeded',
            contentBlocks: [{ type: 'text', text: 'ok' }],
          },
        },
      ],
    }

    const before = projectTernMessages([running])
    const after = projectTernMessages([done])
    expect(before[0]?.id).toBe('omnara:tool:tool-7')
    expect(after[0]?.id).toBe(before[0]?.id)
    const ops = reconcileTernLiveNodes('main', before, after)
    expect(ops.some((op) => op[0] === 'del' && op[1] === 'omnara:tool:tool-7')).toBe(false)
    expect(JSON.stringify(ops)).toContain('"done"')
  })

  it('uses durable backlog ids', () => {
    const input: AgentInputBacklogItem = {
      id: 'input-9',
      agent_id: 'agent-1',
      state: 'queued',
      delivery_mode: 'queued',
      input_kind: 'content',
      content_blocks: [{ type: 'text', text: 'follow up' }],
      queued_at: '2026-10-08T00:00:00Z',
    }
    expect(projectTernBacklog([input])[0]?.id).toBe('omnara:backlog:input-9')
  })
})
