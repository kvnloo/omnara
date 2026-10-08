import {
  type AgentChatStatus,
  type AgentInputBacklogItem,
  backlogInputPreview,
  blockText,
  type OmnaraUIMessage,
} from '@omnara/react'
import * as schemas from '@omnara/sdk/zod'
import * as z from 'zod'

import type { TspJson, TspJsonObject } from './protocol.ts'

export interface TernLiveNode extends TspJsonObject {
  id: string
  k: string
  p?: TspJsonObject
  c?: readonly TernLiveNode[]
}

export type TernLiveOp = readonly TspJson[]

type MessagePart = OmnaraUIMessage['parts'][number]
type ToolPart = Extract<MessagePart, { type: 'dynamic-tool' }>

const zToolOutput = z.object({
  outcome: schemas.zToolCallOutcome,
  contentBlocks: z.array(schemas.zToolResultContentBlock),
})

const zTextPair = z.tuple([z.string(), z.string()])

const clip = (value: string, max = 4096): string =>
  value.length <= max ? value : `${value.slice(0, max)}…`

const stableMessageId = (message: Pick<OmnaraUIMessage, 'id'>): string =>
  `omnara:message:${message.id}`

const stablePartId = (message: OmnaraUIMessage, part: MessagePart): string =>
  `${stableMessageId(message)}:part:${part.id}`

function toolInputText(part: ToolPart): string | undefined {
  if (part.input === undefined) return undefined
  try {
    const text = JSON.stringify(part.input, null, 2)
    return text === '{}' ? undefined : clip(text)
  } catch {
    return undefined
  }
}

function withChildren(node: TernLiveNode, children: readonly TernLiveNode[]): TernLiveNode {
  if (children.length > 0) node.c = children
  return node
}

function toolNode(part: ToolPart): TernLiveNode {
  const id = `omnara:tool:${part.toolCallId}`
  const children: TernLiveNode[] = []
  const input = toolInputText(part)
  if (input != null) {
    children.push({
      id: `${id}:input`,
      k: 'code',
      p: { lang: 'json', text: input },
    })
  }

  if (part.state === 'output-error') {
    if (part.errorText.trim() !== '') {
      children.push({
        id: `${id}:error`,
        k: 'text',
        p: { text: clip(part.errorText), tone: 'error' },
      })
    }
    return withChildren(
      {
        id,
        k: 'tool',
        p: {
          name: part.toolName,
          title: part.toolName,
          status: 'error',
          collapsible: true,
          collapsed: false,
        },
      },
      children,
    )
  }

  if (part.state === 'output-available') {
    const parsed = zToolOutput.safeParse(part.output)
    if (parsed.success) {
      let resultIndex = 0
      for (const block of parsed.data.contentBlocks) {
        if (block.type !== 'text' && block.type !== 'structured_data') continue
        const text = blockText(block).trim()
        if (text === '') continue
        children.push({
          id: `${id}:result:${String(resultIndex)}`,
          k: block.type === 'structured_data' ? 'code' : 'text',
          p:
            block.type === 'structured_data'
              ? { lang: 'json', text: clip(text) }
              : { text: clip(text), tone: parsed.data.outcome === 'failed' ? 'error' : 'muted' },
        })
        resultIndex += 1
      }
      const status =
        parsed.data.outcome === 'succeeded'
          ? 'done'
          : parsed.data.outcome === 'canceled'
            ? 'cancelled'
            : 'error'
      return withChildren(
        {
          id,
          k: 'tool',
          p: {
            name: part.toolName,
            title: part.toolName,
            status,
            collapsible: true,
            collapsed: status === 'done',
          },
        },
        children,
      )
    }
  }

  return withChildren(
    {
      id,
      k: 'tool',
      p: {
        name: part.toolName,
        title: part.toolName,
        status: 'running',
        collapsible: true,
        collapsed: false,
      },
    },
    children,
  )
}

function userNode(message: OmnaraUIMessage): TernLiveNode | null {
  const text = message.parts
    .flatMap((part) => (part.type === 'text' && part.text.trim() !== '' ? [part.text] : []))
    .join('\n')
  const media = message.parts.filter((part) => part.type === 'data-media')
  if (text === '' && media.length === 0) return null

  const id = stableMessageId(message)
  const suffix =
    media.length === 0
      ? ''
      : `\n\n[${String(media.length)} attachment${media.length === 1 ? '' : 's'}]`

  return {
    id,
    k: 'card',
    p: { role: 'omp.user', tone: 'user' },
    c: [{ id: `${id}:text`, k: 'md', p: { text: `${text}${suffix}`.trim() } }],
  }
}

function assistantNodes(message: OmnaraUIMessage): TernLiveNode[] {
  const nodes: TernLiveNode[] = []
  for (const part of message.parts) {
    const id = stablePartId(message, part)
    if (part.type === 'text' && part.text.trim() !== '') {
      nodes.push({ id, k: 'md', p: { text: part.text } })
    } else if (part.type === 'dynamic-tool') {
      nodes.push(toolNode(part))
    } else if (part.type === 'data-model-error') {
      nodes.push({ id, k: 'text', p: { text: part.data.text, tone: 'error' } })
    } else if (part.type === 'data-agent-config') {
      nodes.push({
        id,
        k: 'text',
        p: { text: `agent config ${part.data.action}`, tone: 'muted' },
      })
    } else if (part.type === 'data-media') {
      nodes.push({
        id,
        k: 'text',
        p: {
          text: `[media${part.data.filename == null ? '' : ` ${part.data.filename}`}]`,
          tone: 'muted',
        },
      })
    }
  }
  return nodes
}

export function projectTernMessages(messages: readonly OmnaraUIMessage[]): readonly TernLiveNode[] {
  const nodes: TernLiveNode[] = []
  for (const message of messages) {
    if (message.role === 'user') {
      const node = userNode(message)
      if (node != null) nodes.push(node)
    } else {
      nodes.push(...assistantNodes(message))
    }
  }
  return nodes
}

export function projectTernBacklog(
  inputs: readonly AgentInputBacklogItem[],
): readonly TernLiveNode[] {
  let queued = 0
  return inputs.map((input) => {
    const state =
      input.delivery_mode === 'steering'
        ? 'sending'
        : input.delivery_mode === 'optimistic'
          ? 'pending'
          : queued++ === 0
            ? 'next'
            : `queued #${String(queued)}`
    return {
      id: `omnara:backlog:${input.id}`,
      k: 'text',
      p: { text: `[${state}] ${backlogInputPreview(input).text}`, tone: 'muted' },
    }
  })
}

export function projectTernSession({
  messages,
  backlog,
  status,
  isWorking,
  hasOlderMessages,
}: {
  messages: readonly OmnaraUIMessage[]
  backlog: readonly AgentInputBacklogItem[]
  status: AgentChatStatus
  isWorking: boolean
  hasOlderMessages: boolean
}): readonly TernLiveNode[] {
  const nodes: TernLiveNode[] = []
  if (hasOlderMessages) {
    nodes.push({
      id: 'omnara:history:older',
      k: 'text',
      p: { text: 'older history omitted', tone: 'muted' },
    })
  }
  nodes.push(...projectTernMessages(messages))
  nodes.push(...projectTernBacklog(backlog))

  if (status === 'submitted' || isWorking || status === 'error') {
    nodes.push({
      id: 'omnara:status',
      k: 'text',
      p: {
        text: status === 'submitted' ? 'sending…' : status === 'error' ? 'chat error' : 'working…',
        tone: status === 'error' ? 'error' : 'muted',
      },
    })
  }
  return nodes
}

const sameLiveValue = (left: TspJson | undefined, right: TspJson | undefined): boolean =>
  left === right || JSON.stringify(left) === JSON.stringify(right)

export function reconcileTernLiveNodes(
  parent: string,
  previous: readonly TernLiveNode[],
  next: readonly TernLiveNode[],
): TernLiveOp[] {
  const ops: TernLiveOp[] = []
  const oldById = new Map(previous.map((node) => [node.id, node]))
  const nextIds = new Set(next.map((node) => node.id))
  const order = previous.map((node) => node.id).filter((id) => nextIds.has(id))

  for (const old of previous) {
    if (!nextIds.has(old.id)) ops.push(['del', old.id])
  }

  const backwards = next
    .map((node, index) => ({ node, before: next[index + 1]?.id ?? null }))
    .reverse()
  for (const { node, before } of backwards) {
    const old = oldById.get(node.id)

    if (old == null || old.k !== node.k) {
      if (old != null) {
        ops.push(['del', old.id])
        const at = order.indexOf(old.id)
        if (at >= 0) order.splice(at, 1)
      }
      ops.push(['add', node.id, parent, before, node])
      const anchor = before === null ? order.length : order.indexOf(before)
      order.splice(anchor < 0 ? order.length : anchor, 0, node.id)
      continue
    }

    const at = order.indexOf(node.id)
    if ((order[at + 1] ?? null) !== before) {
      ops.push(['move', node.id, parent, before])
      if (at >= 0) order.splice(at, 1)
      const anchor = before === null ? order.length : order.indexOf(before)
      order.splice(anchor < 0 ? order.length : anchor, 0, node.id)
    }

    const oldProps = old.p ?? {}
    const props = node.p ?? {}
    const patch: Record<string, TspJson> = {}

    for (const key of new Set([...Object.keys(oldProps), ...Object.keys(props)])) {
      const beforeValue = oldProps[key]
      const nextValue = props[key]
      if (sameLiveValue(beforeValue, nextValue)) continue

      const textPair = key === 'text' ? zTextPair.safeParse([beforeValue, nextValue]) : null
      if (textPair?.success === true) {
        const [beforeText, nextText] = textPair.data
        const append = nextText.startsWith(beforeText)
        ops.push([
          'text',
          node.id,
          append ? 'append' : 'replace',
          append ? nextText.slice(beforeText.length) : nextText,
        ])
      } else {
        patch[key] = nextValue ?? null
      }
    }

    if (Object.keys(patch).length > 0) ops.push(['set', node.id, patch])
    ops.push(...reconcileTernLiveNodes(node.id, old.c ?? [], node.c ?? []))
  }

  return ops
}
