/**
 * Credential-free native-Tern lab using Omnara's REAL runChat, React hooks,
 * generated SDK client, and SSE transport against a loopback fixture.
 *
 * This exercises the real CLI terminal boundary; the backend has no agent,
 * provider, credential, external network, or shell execution.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

import { createOmnaraClient } from '@omnara/sdk'

import { runChat } from '../chat.tsx'
import { resolveTernPresentation } from './config.ts'

const fixtureId = (prefix: string, n: number): string =>
  prefix +
  '_' +
  'a'.repeat(24) +
  String.fromCharCode(97 + (Math.floor(n / 26) % 26)) +
  String.fromCharCode(97 + (n % 26))

const scope = {
  orgID: fixtureId('org', 1),
  projectID: fixtureId('proj', 1),
  agentID: fixtureId('agt', 1),
}
const root = `/v1/orgs/${scope.orgID}/projects/${scope.projectID}/agents`
const agentPath = root + '/' + scope.agentID
const timestamp = (): string => new Date().toISOString()
const agent = {
  id: scope.agentID,
  org_id: scope.orgID,
  project_id: scope.projectID,
  name: 'Tern Loopback Fixture',
  state: 'active' as const,
  activity: { state: 'idle' as 'idle' | 'running' | 'waiting_on_interaction', last_activity_at: timestamp() },
  created_at: timestamp(),
  updated_at: timestamp(),
}

interface EventRecord {
  event_kind: string
  sequence: number
  [key: string]: unknown
}
interface InteractionRecord {
  id: string
  org_id: string
  project_id: string
  agent_id: string
  tool_call_id: string
  interaction_kind: 'question'
  state: 'open' | 'resolved'
  request: { title: string; questions: { prompt: string; options: { label: string }[] }[] }
  created_at: string
  resolution?: { answers: { option_indices: number[]; text?: string }[] }
  resolved_at?: string
}
const events: EventRecord[] = []
const streams = new Set<ServerResponse>()
let interaction: InteractionRecord | undefined
let sequence = 0
let turn = 0
let busy = false
let responseTimers = new Set<ReturnType<typeof setTimeout>>()

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(value))
}

function broadcast(event: EventRecord | object): void {
  if ('event_kind' in event && 'sequence' in event) events.push(event as EventRecord)
  for (const stream of streams) stream.write('data: ' + JSON.stringify(event) + '\n\n')
}

async function requestBody(req: IncomingMessage): Promise<unknown> {
  let text = ''
  for await (const chunk of req) {
    text += (chunk as Buffer).toString('utf8')
    if (Buffer.byteLength(text, 'utf8') > 1_048_576) throw new RangeError('Fixture input too large')
  }
  return JSON.parse(text)
}

function completeTurn(turnIndex: number, input: string): void {
  const evt = {
    id: fixtureId('evt', ++sequence),
    org_id: scope.orgID,
    project_id: scope.projectID,
    agent_id: scope.agentID,
    turn_id: fixtureId('trn', turnIndex),
    turn_sequence: turnIndex,
    is_opening_event: false as const,
    sequence,
    event_kind: 'model_output' as const,
    model_call_context_id: fixtureId('mcc', turnIndex),
    stop_reason: 'end_turn' as const,
    content_blocks: [{ type: 'text' as const, text: 'Fixture echo: ' + input }],
    created_at: timestamp(),
  }
  busy = false
  agent.activity.state = 'idle'
  broadcast(evt)
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    if (req.method === 'GET' && path === agentPath) {
      json(res, 200, { agent, machine_ids: [], mcp_connections: [] })
      return
    }
    if (req.method === 'GET' && path === root) {
      json(res, 200, { data: url.searchParams.has('parent_agent_id') ? [] : [agent], next_cursor: null })
      return
    }
    if (req.method === 'GET' && path === agentPath + '/events') {
      const before = Number(url.searchParams.get('before_sequence') ?? '0')
      const page = before > 0 ? events.filter((event) => event.sequence < before) : events
      json(res, 200, {
        data: page.slice(-100),
        next_after_sequence: sequence,
        next_before_sequence: null,
        has_more: false,
      })
      return
    }
    if (req.method === 'GET' && path === agentPath + '/events/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      streams.add(res)
      const after = Number(req.headers['last-event-id'] ?? url.searchParams.get('after_sequence') ?? '0')
      for (const event of events) {
        if (event.sequence > after) res.write('data: ' + JSON.stringify(event) + '\n\n')
      }
      res.write(': fixture connected\n\n')
      req.on('close', () => streams.delete(res))
      return
    }
    if (req.method === 'GET' && path === agentPath + '/inputs/backlog') {
      json(res, 200, { data: [], next_cursor: null })
      return
    }
    if (req.method === 'GET' && path === agentPath + '/interactions') {
      json(res, 200, { data: interaction?.state === 'open' ? [interaction] : [], next_cursor: null })
      return
    }
    if (req.method === 'POST' && path === agentPath + '/inputs') {
      const body = await requestBody(req)
      if (body === null || typeof body !== 'object' || !('content_blocks' in body) ||
        !Array.isArray(body.content_blocks)) {
        json(res, 400, { error: 'Invalid input body', code: 'invalid_argument' })
        return
      }
      const blocks = body.content_blocks as { type?: string; text?: string }[]
      const text = blocks.filter((block) => block.type === 'text' && block.text != null)
        .map((block) => block.text).join('\n')
      const inputID = fixtureId('ain', turn + 1)
      const createdAt = timestamp()
      const input = {
        id: inputID,
        agent_id: scope.agentID,
        state: 'received',
        delivery_mode: 'immediate' as const,
        input_kind: 'content' as const,
        content_blocks: blocks,
        queued_at: createdAt,
      }
      const currentTurn = ++turn
      busy = true
      agent.activity.state = 'running'
      broadcast({
        id: fixtureId('evt', ++sequence),
        org_id: scope.orgID,
        project_id: scope.projectID,
        agent_id: scope.agentID,
        turn_id: fixtureId('trn', currentTurn),
        turn_sequence: currentTurn,
        is_opening_event: true,
        sequence,
        event_kind: 'agent_input',
        agent_input_id: inputID,
        input_kind: 'content',
        content_blocks: blocks,
        created_at: createdAt,
      })
      json(res, 201, { agent_input: input })
      if (text.trim().startsWith('/ask')) {
        interaction = {
          id: fixtureId('int', currentTurn),
          org_id: scope.orgID,
          project_id: scope.projectID,
          agent_id: scope.agentID,
          tool_call_id: fixtureId('tcl', currentTurn),
          interaction_kind: 'question',
          state: 'open',
          request: {
            title: 'Loopback approval simulation',
            questions: [{ prompt: 'Continue the fixture turn?', options: [{ label: 'Yes' }, { label: 'No' }] }],
          },
          created_at: timestamp(),
        }
        agent.activity.state = 'waiting_on_interaction'
        broadcast({
          tool_call_id: interaction.tool_call_id,
          agent_id: scope.agentID,
          state: 'waiting',
          interaction_update: { id: interaction.id, interaction_kind: 'question', state: 'open' },
        })
      } else {
        const timer = setTimeout(() => {
          responseTimers.delete(timer)
          completeTurn(currentTurn, text)
        }, 1_200)
        responseTimers.add(timer)
      }
      return
    }
    if (req.method === 'POST' && interaction != null &&
      path === agentPath + '/interactions/' + interaction.id + '/resolve') {
      const answers = await requestBody(req)
      const resolved = {
        ...interaction,
        state: 'resolved' as const,
        resolution: answers,
        resolved_at: timestamp(),
      }
      interaction = resolved as InteractionRecord
      json(res, 200, resolved)
      broadcast({
        tool_call_id: interaction.tool_call_id,
        agent_id: scope.agentID,
        state: 'completed',
        interaction_update: { id: interaction.id, interaction_kind: 'question', state: 'resolved' },
      })
      completeTurn(turn, 'interaction resolved')
      return
    }
    json(res, 404, { error: 'Unknown fixture route', code: 'not_found' })
  } catch (error) {
    if (res.headersSent) res.destroy(error instanceof Error ? error : undefined)
    else json(res, error instanceof RangeError ? 413 : 400, { error: 'Invalid fixture request', code: 'invalid_argument' })
  }
})

async function main(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Run the native lab inside a TTY (Tern or an ordinary pty)')
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address == null || typeof address === 'string') throw new Error('Fixture port unavailable')
  const baseUrl = `http://127.0.0.1:${address.port}/v1`
  process.stderr.write('Omnara/Tern loopback fixture at ' + baseUrl +
    ' (local only; no credentials or model calls)\n')
  process.stderr.write('Send text, emoji or multiline. Send /ask for an Ink-owned interaction. Quit with /quit or Ctrl-C.\n')
  try {
    const client = createOmnaraClient({ baseUrl })
    await runChat(
      client,
      scope,
      resolveTernPresentation({ ternLive: process.argv.includes('--tern-live') }),
    )
  } finally {
    for (const timer of responseTimers) clearTimeout(timer)
    responseTimers.clear()
    for (const stream of streams) stream.end()
    streams.clear()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

void main().catch((error: unknown) => {
  process.stderr.write('Native fixture failed: ' + String(error) + '\n')
  process.exitCode = 1
})
