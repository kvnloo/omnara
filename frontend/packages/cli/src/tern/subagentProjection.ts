import type { Agent } from '@omnara/sdk'

import type { TernLiveNode } from './liveProjection.ts'

type TernAgentStatus = 'running' | 'idle' | 'parked'

function statusOf(agent: Agent): TernAgentStatus | undefined {
  if (agent.state === 'archived' || agent.activity?.state === 'archived') return 'parked'
  switch (agent.activity?.state) {
    case 'running':
      return 'running'
    case 'waiting_on_interaction':
      return 'parked'
    case 'idle':
      return 'idle'
    default:
      return undefined
  }
}

export function projectTernSubagents(
  agents: readonly Agent[],
  truncated = false,
): readonly TernLiveNode[] {
  const nodes: TernLiveNode[] = agents.map((agent) => {
    const status = statusOf(agent)
    const name = agent.name.trim() || agent.subagent_key || agent.id
    const model =
      agent.model == null
        ? undefined
        : `${agent.model.provider_config}/${agent.model.name}`

    return {
      id: `omnara:agent:${agent.id}`,
      k: 'agent',
      p: {
        name,
        ...(status == null ? {} : { status }),
        ...(model == null ? {} : { model }),
        depth: 1,
        collapsible: true,
        collapsed: true,
      },
    }
  })

  if (truncated) {
    nodes.push({
      id: 'omnara:agents:truncated',
      k: 'text',
      p: { text: 'more direct subagents omitted', tone: 'muted' },
    })
  }

  return nodes
}
