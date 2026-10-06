import { createInterface } from 'node:readline'

import {
  type AgentEventStreamFrame,
  type OmnaraClient,
  openAgentEventStream,
  sdk,
} from '@omnara/sdk'
import * as schemas from '@omnara/sdk/zod'
import * as z from 'zod'

type JsonValue = z.output<ReturnType<typeof z.json>>
type RpcId = number | string

interface OmpBridgeScope {
  orgID: string
  projectID: string
  agentID: string
}

const zRpcRequest = z.object({
  jsonrpc: z.literal('2.0').optional(),
  id: z.union([z.number(), z.string()]),
  method: z.string(),
  params: z.record(z.string(), z.json()).optional(),
})

const zLimitParams = z.object({ limit: z.number().int().min(1).max(500).optional() })
const zStreamStartParams = z.object({ after_sequence: z.number().int().nonnegative().optional() })
const zBridgeAttachment = schemas.zInlineMediaContentBlock.omit({ type: true, metadata: true })

const zInputParams = z
  .object({
    text: z.string(),
    idempotency_key: z.string().min(1),
    delivery_mode: z.enum(['queued', 'steering']).default('queued'),
    attachments: z.array(zBridgeAttachment).default([]),
  })
  .refine((input) => input.text.trim() !== '' || input.attachments.length > 0, {
    message: 'input requires text or an attachment',
  })

const ompSourceHint =
  'This message came from an OMP terminal frontend connected through Omnara. Reply with normal assistant text unless explicitly asked to message an integration.'

/** Mirrors Omnara chat surfaces: provenance is model-visible but hidden from the transcript. */
export function buildOmpInputBody(input: z.output<typeof zInputParams>) {
  return {
    content_blocks: [
      {
        type: 'text' as const,
        text: ompSourceHint,
        metadata: { omnara_hidden: 'true' },
      },
      ...(input.text.trim() === '' ? [] : [{ type: 'text' as const, text: input.text }]),
      ...input.attachments.map((attachment) => ({
        type: 'media' as const,
        media_type: attachment.media_type,
        filename: attachment.filename,
        data: attachment.data,
      })),
    ],
    delivery_mode: input.delivery_mode,
  }
}

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

export function parseOmpBridgeRequest(line: string): z.output<typeof zRpcRequest> {
  return zRpcRequest.parse(JSON.parse(line))
}

export function ompBridgeEventName(frame: AgentEventStreamFrame): string {
  if ('event_kind' in frame) return frame.event_kind
  if ('tool_call_id' in frame && 'state' in frame) return 'tool_call_update'
  return 'model_output_delta'
}

function durableEventID(frame: AgentEventStreamFrame): string | undefined {
  if (!('event_kind' in frame)) return undefined
  return String(frame.sequence)
}

function jsonValue(value: JsonValue): JsonValue {
  return z.json().parse(value)
}

function writeFrame(frame: JsonValue): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`)
}

function resultFrame(id: RpcId, result: JsonValue): JsonValue {
  return { jsonrpc: '2.0', id, result }
}

function errorFrame(id: RpcId | null, message: string, code = -32000): JsonValue {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function notify(method: string, params: JsonValue): void {
  writeFrame({ jsonrpc: '2.0', method, params })
}

/**
 * Renderer-neutral bridge for external UIs.
 *
 * Omnara owns authentication, HTTP schemas, SSE recovery and API evolution.
 * The client owns presentation. No Ink/React components cross this boundary.
 */
export async function runOmpBridge(client: OmnaraClient, scope: OmpBridgeScope): Promise<void> {
  let streamAbort: AbortController | undefined
  let streamTask: Promise<void> | undefined

  const stopStream = async () => {
    streamAbort?.abort()
    streamAbort = undefined
    await streamTask?.catch(() => undefined)
    streamTask = undefined
  }

  const startStream = (afterSequence: number) => {
    void stopStream().then(() => {
      const abort = new AbortController()
      streamAbort = abort
      streamTask = (async () => {
        try {
          const frames = openAgentEventStream({
            client,
            path: scope,
            query: { after_sequence: afterSequence, stream_deltas: true },
            signal: abort.signal,
            onConnectionStateChange(state) {
              notify('stream.connection', jsonValue(state))
            },
          })
          for await (const frame of frames) {
            const event = ompBridgeEventName(frame)
            const id = durableEventID(frame)
            const notification: {
              event: string
              id?: string
              data: AgentEventStreamFrame
            } = { event, data: frame }
            if (id != null) notification.id = id
            notify('stream.event', jsonValue(notification))
          }
        } catch (error) {
          if (abort.signal.aborted) return
          const message = error instanceof Error ? error.message : 'Omnara event stream failed'
          notify('stream.error', { message })
        }
      })()
    })
  }

  notify('ready', {
    agent_id: scope.agentID,
    org_id: scope.orgID,
    project_id: scope.projectID,
  })

  const reader = createInterface({ input: process.stdin, crlfDelay: Infinity })
  try {
    for await (const line of reader) {
      if (!line.trim()) continue

      let request: z.output<typeof zRpcRequest>
      try {
        request = parseOmpBridgeRequest(line)
      } catch {
        writeFrame(errorFrame(null, 'invalid bridge request', -32600))
        continue
      }

      const { id, method, params = {} } = request
      try {
        if (method === 'ping') {
          writeFrame(resultFrame(id, { ok: true }))
          continue
        }

        if (method === 'agent.get') {
          const { data } = await sdk.getAgent({ client, path: scope })
          writeFrame(resultFrame(id, jsonValue(data)))
          continue
        }

        if (method === 'events.list') {
          const input = zLimitParams.parse(params)
          const { data } = await sdk.listEvents({
            client,
            path: scope,
            query: { before_sequence: 0, limit: input.limit ?? 100 },
          })
          writeFrame(resultFrame(id, jsonValue(data)))
          continue
        }

        if (method === 'tool_calls.list') {
          const input = zLimitParams.parse(params)
          const { data } = await sdk.listToolCalls({
            client,
            path: scope,
            query: { include_subagents: true, limit: input.limit ?? 500 },
          })
          writeFrame(resultFrame(id, jsonValue(data)))
          continue
        }

        if (method === 'interactions.list') {
          const input = zLimitParams.parse(params)
          const { data } = await sdk.listAgentInteractions({
            client,
            path: scope,
            query: {
              state: 'open',
              include_subagents: true,
              limit: input.limit ?? 500,
            },
          })
          writeFrame(resultFrame(id, jsonValue(data)))
          continue
        }

        if (method === 'input.create') {
          const input = zInputParams.parse(params)
          const { data } = await sdk.createAgentInput({
            client,
            path: scope,
            headers: { 'Idempotency-Key': input.idempotency_key },
            body: buildOmpInputBody(input),
          })
          writeFrame(resultFrame(id, jsonValue(data)))
          continue
        }

        if (method === 'agent.cancel') {
          const { data } = await sdk.cancelAgent({ client, path: scope })
          writeFrame(resultFrame(id, jsonValue(data)))
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
            body: { answers: input.answers },
          })
          writeFrame(resultFrame(id, jsonValue(data)))
          continue
        }

        if (method === 'stream.start') {
          const input = zStreamStartParams.parse(params)
          startStream(input.after_sequence ?? 0)
          writeFrame(resultFrame(id, { started: true }))
          continue
        }

        if (method === 'stream.stop') {
          await stopStream()
          writeFrame(resultFrame(id, { stopped: true }))
          continue
        }

        writeFrame(errorFrame(id, `unknown bridge method: ${method}`, -32601))
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Omnara bridge request failed'
        writeFrame(errorFrame(id, message))
      }
    }
  } finally {
    reader.close()
    await stopStream()
  }
}
