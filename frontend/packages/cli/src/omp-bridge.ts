import { createInterface } from 'node:readline'

import {
  type AgentEvent,
  type AgentInput,
  type AgentInteraction,
  type InteractionAnswer,
  type OmnaraClient,
  sdk,
} from '@omnara/sdk'
import {
  listAgentInteractionsOptions,
  listQueuedBacklogInputsOptions,
} from '@omnara/sdk/tanstack'
import {
  type AgentChatData,
  type AgentChatProjection,
  type AgentChatScope,
  AgentChatSession,
  agentChatHistoryQueryKey,
  type OmnaraUIMessage,
  projectAgentChat,
  sequenceNumber,
} from '@omnara/react'
import { type InfiniteData, QueryClient, QueryObserver } from '@tanstack/react-query'
import * as z from 'zod'

const historyPageSize = 100
const backlogQuery = { limit: 100 } as const
const openInteractionsQuery = { state: 'open', limit: 100, include_subagents: true } as const

type RpcId = number | string

interface BridgeSnapshot {
  agent: {
    id: string
    name?: string
    state?: string
  }
  messages: Array<{ key: string; message: OmnaraUIMessage }>
  backlogInputs: AgentChatProjection['backlogInputs']
  status: AgentChatProjection['status']
  isWorking: boolean
  interaction?: AgentInteraction
  hasOlderHistory: boolean
  error?: string
  streamError?: string
}

const zRpcRequest = z.object({
  jsonrpc: z.literal('2.0').optional(),
  id: z.union([z.number(), z.string()]),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
})

const zSendParams = z.object({ text: z.string().min(1) })
const zResolveParams = z.object({
  interaction_id: z.string().min(1),
  target_agent_id: z.string().min(1),
  answers: z.array(
    z.object({
      option_indices: z.array(z.number().int().nonnegative()),
      text: z.string().optional(),
    }),
  ),
})

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function writeFrame(frame: unknown): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`)
}

function messageKey(message: OmnaraUIMessage, events: AgentEvent[]): string {
  if (message.id.startsWith('local:')) {
    const localID = message.id.slice('local:'.length)
    return `input:${localID}`
  }
  const eventID = message.metadata?.eventId
  if (eventID != null) {
    const event = events.find((candidate) => candidate.id === eventID)
    if (event?.event_kind === 'agent_input' && event.input_idempotency_key != null) {
      return `input:${event.input_idempotency_key}`
    }
  }
  return message.id
}

export function bridgeMessageKey(message: OmnaraUIMessage, events: AgentEvent[]): string {
  return messageKey(message, events)
}

export async function runOmpBridge(
  client: OmnaraClient,
  scope: AgentChatScope,
): Promise<void> {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
      },
    },
  })

  const [{ data: history }, { data: agentResult }] = await Promise.all([
    sdk.listEvents({
      client,
      path: scope,
      query: { before_sequence: 0, limit: historyPageSize },
    }),
    sdk.getAgent({ client, path: scope }),
  ])

  const newestHistorySequence = sequenceNumber(history.data.at(-1)?.sequence)
  queryClient.setQueryData<InfiniteData<{ data: AgentEvent[] }>>(
    agentChatHistoryQueryKey(scope),
    {
      pages: [history],
      pageParams: [0],
    },
  )

  const backlogOptions = listQueuedBacklogInputsOptions({
    client,
    path: scope,
    query: backlogQuery,
  })
  const interactionOptions = listAgentInteractionsOptions({
    client,
    path: scope,
    query: openInteractionsQuery,
  })

  await Promise.all([
    queryClient.ensureQueryData(backlogOptions),
    queryClient.ensureQueryData(interactionOptions),
  ])

  const session = new AgentChatSession({
    client,
    queryClient,
    ...scope,
  })
  session.start(newestHistorySequence)

  let snapshotQueued = false
  let closed = false

  const buildData = (): AgentChatData => {
    const live = session.getData()
    const liveEvents = live.events.filter(
      (event) => sequenceNumber(event.sequence) > newestHistorySequence,
    )
    const backlog = queryClient.getQueryData<{ data: AgentInput[] }>(backlogOptions.queryKey)
    return {
      ...live,
      events: [...history.data, ...liveEvents],
      backlogInputs: backlog?.data ?? [],
      hasOlderEvents: history.next_before_sequence != null,
    }
  }

  const buildSnapshot = (): BridgeSnapshot => {
    const data = buildData()
    const projection = projectAgentChat(data)
    const interactions = queryClient.getQueryData<{ data: AgentInteraction[] }>(
      interactionOptions.queryKey,
    )
    return {
      agent: {
        id: scope.agentID,
        name: agentResult.agent.name,
        state: agentResult.agent.state,
      },
      messages: projection.messages.map((message) => ({
        key: messageKey(message, data.events),
        message,
      })),
      backlogInputs: projection.backlogInputs,
      status: projection.status,
      isWorking: projection.isWorking,
      interaction: interactions?.data[0],
      hasOlderHistory: data.hasOlderEvents,
      error: data.error?.message,
      streamError: data.streamError?.message,
    }
  }

  const emitSnapshot = () => {
    if (closed || snapshotQueued) return
    snapshotQueued = true
    queueMicrotask(() => {
      snapshotQueued = false
      if (closed) return
      writeFrame({ jsonrpc: '2.0', method: 'snapshot', params: buildSnapshot() })
    })
  }

  const unsubscribeSession = session.subscribe(emitSnapshot)
  const backlogObserver = new QueryObserver(queryClient, backlogOptions)
  const interactionObserver = new QueryObserver(queryClient, interactionOptions)

  const unsubscribeBacklog = backlogObserver.subscribe((result) => {
    session.confirmBacklogInputs(result.data?.data ?? [])
    emitSnapshot()
  })
  const unsubscribeInteractions = interactionObserver.subscribe(() => emitSnapshot())

  writeFrame({
    jsonrpc: '2.0',
    method: 'ready',
    params: {
      agent_id: scope.agentID,
      org_id: scope.orgID,
      project_id: scope.projectID,
    },
  })
  emitSnapshot()

  const respond = (id: RpcId, result: unknown) => {
    writeFrame({ jsonrpc: '2.0', id, result })
  }
  const reject = (id: RpcId, error: unknown) => {
    writeFrame({
      jsonrpc: '2.0',
      id,
      error: { code: -32000, message: errorMessage(error) },
    })
  }

  const reader = createInterface({ input: process.stdin, crlfDelay: Infinity })
  try {
    for await (const line of reader) {
      if (!line.trim()) continue
      const parsed = zRpcRequest.safeParse(JSON.parse(line))
      if (!parsed.success) {
        writeFrame({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: 'invalid bridge request' },
        })
        continue
      }
      const { id, method, params = {} } = parsed.data
      try {
        if (method === 'ping') {
          respond(id, { ok: true })
          continue
        }
        if (method === 'message.send') {
          const input = zSendParams.parse(params)
          const projection = projectAgentChat(buildData())
          const backlog = projection.backlogInputs
          const live = session.getData()
          const placement =
            projection.isWorking || backlog.length > 0 || live.localInputs.length > 0
              ? 'backlog'
              : 'conversation'
          await session.sendMessage({ text: input.text }, placement)
          respond(id, { accepted: true, placement })
          continue
        }
        if (method === 'agent.cancel') {
          const { data } = await sdk.cancelAgent({ client, path: scope })
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: backlogOptions.queryKey }),
            queryClient.invalidateQueries({ queryKey: interactionOptions.queryKey }),
          ])
          respond(id, data)
          continue
        }
        if (method === 'interaction.resolve') {
          const input = zResolveParams.parse(params)
          const { data } = await sdk.resolveAgentInteraction({
            client,
            path: {
              orgID: scope.orgID,
              projectID: scope.projectID,
              agentID: input.target_agent_id,
              interactionID: input.interaction_id,
            },
            body: { answers: input.answers as InteractionAnswer[] },
          })
          await queryClient.invalidateQueries({ queryKey: interactionOptions.queryKey })
          respond(id, data)
          continue
        }
        writeFrame({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `unknown bridge method: ${method}` },
        })
      } catch (error) {
        reject(id, error)
      }
    }
  } finally {
    closed = true
    unsubscribeInteractions()
    unsubscribeBacklog()
    unsubscribeSession()
    session.disconnect()
    queryClient.clear()
  }
}
