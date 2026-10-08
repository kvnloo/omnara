import type { Agent } from '@omnara/sdk'
import { describe, expect, it } from 'vitest'

import { projectTernSubagents } from './subagentProjection.ts'

const agent = (patch: Partial<Agent> = {}): Agent => ({
  id: 'agt_child',
  org_id: 'org',
  project_id: 'project',
  state: 'active',
  name: 'reviewer',
  parent_agent_id: 'agt_root',
  subagent_key: 'review',
  activity: { state: 'running', last_activity_at: '2026-10-08T00:00:00Z' },
  model: { provider_config: 'openrouter', name: 'model-x' },
  created_at: '2026-10-08T00:00:00Z',
  updated_at: '2026-10-08T00:00:00Z',
  ...patch,
})

describe('native Omnara subagents', () => {
  it('keeps the Omnara agent id as stable native identity', () => {
    const running = projectTernSubagents([agent()])[0]
    const idle = projectTernSubagents([
      agent({ activity: { state: 'idle', last_activity_at: '2026-10-08T00:01:00Z' } }),
    ])[0]

    expect(running?.id).toBe('omnara:agent:agt_child')
    expect(idle?.id).toBe(running?.id)
    expect(running).toMatchObject({
      k: 'agent',
      p: {
        name: 'reviewer',
        status: 'running',
        model: 'openrouter/model-x',
        depth: 1,
      },
    })
    expect(idle?.p?.status).toBe('idle')
  })

  it('maps waiting and archived state without inventing completion', () => {
    expect(
      projectTernSubagents([
        agent({
          activity: {
            state: 'waiting_on_interaction',
            last_activity_at: '2026-10-08T00:01:00Z',
          },
        }),
      ])[0]?.p?.status,
    ).toBe('parked')

    const archived = projectTernSubagents([
      agent({
        state: 'archived',
        activity: { state: 'archived', last_activity_at: '2026-10-08T00:01:00Z' },
      }),
    ])[0]
    expect(archived?.p?.status).toBe('parked')
    expect(JSON.stringify(archived)).not.toContain('"done"')
  })

  it('marks pagination truncation instead of implying a complete list', () => {
    const nodes = projectTernSubagents([agent()], true)
    expect(nodes.at(-1)).toMatchObject({
      id: 'omnara:agents:truncated',
      p: { text: 'more direct subagents omitted' },
    })
  })
})
