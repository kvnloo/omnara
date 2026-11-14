import type { Agent } from '@omnara/sdk'

import type { TernLiveNode } from './liveProjection.ts'
import type { TspJsonObject } from './protocol.ts'

type TernAgentStatus = 'running' | 'idle' | 'parked'

interface TernAgentProps extends TspJsonObject {
  name: string
  status?: TernAgentStatus
  model?: string
  depth: number
  collapsible: boolean
  collapsed: boolean
}

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

function displayName(agent: Agent): string {
  const name = agent.name.trim()
  if (name !== '') return name
  if (agent.subagent_key != null && agent.subagent_key !== '') return agent.subagent_key
  return agent.id
}

export function projectTernSubagents(
  agents: readonly Agent[],
  truncated = false,
): readonly TernLiveNode[] {
  const nodes: TernLiveNode[] = agents.map((agent) => {
    const status = statusOf(agent)
    const props: TernAgentProps = {
      name: displayName(agent),
      depth: 1,
      collapsible: true,
      collapsed: true,
    }
    if (status != null) props.status = status
    if (agent.model != null) props.model = `${agent.model.provider_config}/${agent.model.name}`

    return { id: `omnara:agent:${agent.id}`, k: 'agent', p: props }
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
