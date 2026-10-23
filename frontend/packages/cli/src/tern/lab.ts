/**
 * Credential-free native-Tern lab using Omnara's REAL runChat, React hooks,
 * generated SDK client, and SSE transport against a loopback fixture.
 *
 * This exercises the real CLI terminal boundary; the backend has no agent,
 * provider, credential, external network, or shell execution.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { createOmnaraClient } from '@omnara/sdk'
import * as schemas from '@omnara/sdk/zod'
import type * as z from 'zod'

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
const activity: z.infer<typeof schemas.zAgentActivity> = {
  state: 'idle',
  last_activity_at: timestamp(),
}
const agent = {
  id: scope.agentID,
  org_id: scope.orgID,
  project_id: scope.projectID,
  name: 'Tern Loopback Fixture',
  state: 'active',
  activity,
  created_at: timestamp(),
  updated_at: timestamp(),
} satisfies z.infer<typeof schemas.zAgent>
const childAgent = {
  ...agent,
  id: fixtureId('agt', 2),
  name: 'Loopback direct subagent',
  parent_agent_id: scope.agentID,
  subagent_key: 'native-lab',
}

interface StoredEvent {
  sequence: number
  payload: string
}
const events: StoredEvent[] = []
const streams = new Set<ServerResponse>()
let interaction: z.infer<typeof schemas.zAgentInteraction> | undefined
let sequence = 0
let turn = 0
// Captured at the real SDK HTTP boundary, not from a simulated TSP send event.
const sdkPosts: string[] = []
let interactionsOpened = 0
let interactionsResolved = 0
const responseTimers = new Set<ReturnType<typeof setTimeout>>()

function json(res: ServerResponse, status: number, payload: string | undefined): void {
  if (payload == null) throw new Error('Fixture JSON serialization failed')
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(payload)
}

function broadcast(payload: string | undefined, sequence?: number): void {
  if (payload == null) throw new Error('Fixture SSE serialization failed')
  if (sequence != null) events.push({ sequence, payload })
  for (const stream of streams) stream.write('data: ' + payload + '\n\n')
}

async function requestBody(req: IncomingMessage): Promise<string> {
  let text = ''
  for await (const chunk of req) {
    if (!Buffer.isBuffer(chunk)) throw new TypeError('Expected buffered HTTP input')
    text += chunk.toString('utf8')
    if (Buffer.byteLength(text, 'utf8') > 1_048_576) throw new RangeError('Fixture input too large')
  }
  return text
}

function completeTurn(turnIndex: number, input: string): void {
  const evt = schemas.zModelOutputEvent.parse({
    id: fixtureId('evt', ++sequence),
    org_id: scope.orgID,
    project_id: scope.projectID,
    agent_id: scope.agentID,
    turn_id: fixtureId('trn', turnIndex),
    turn_sequence: turnIndex,
    is_opening_event: false,
    sequence,
    event_kind: 'model_output',
    model_call_context_id: fixtureId('mcc', turnIndex),
    stop_reason: 'end_turn',
    content_blocks: [{ type: 'text', text: 'Fixture echo: ' + input }],
    created_at: timestamp(),
  })
  activity.state = 'idle'
  broadcast(JSON.stringify(evt), evt.sequence)
}

const server = createServer((req, res) => {
  void respond(req, res)
})

async function respond(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    if (req.method === 'GET' && path === agentPath) {
      json(res, 200, JSON.stringify({ agent, machine_ids: [], mcp_connections: [] }))
      return
    }
    if (req.method === 'GET' && path === root) {
      json(
        res,
        200,
        JSON.stringify({
          data: url.searchParams.has('parent_agent_id') ? [childAgent] : [agent],
          next_cursor: null,
        }),
      )
      return
    }
    if (req.method === 'GET' && path === agentPath + '/events') {
      const before = Number(url.searchParams.get('before_sequence') ?? '0')
      const page = before > 0 ? events.filter((event) => event.sequence < before) : events
      json(
        res,
        200,
        JSON.stringify({
          data: page
            .slice(-100)
            .map((event) => schemas.zAgentEvent.parse(JSON.parse(event.payload))),
          next_after_sequence: sequence,
          next_before_sequence: null,
          has_more: false,
        }),
      )
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
      const after = Number(
        req.headers['last-event-id'] ?? url.searchParams.get('after_sequence') ?? '0',
      )
      for (const event of events) {
        if (event.sequence > after) res.write('data: ' + event.payload + '\n\n')
      }
      res.write(': fixture connected\n\n')
      res.on('close', () => {
        streams.delete(res)
      })
      return
    }
    if (req.method === 'GET' && path === agentPath + '/inputs/backlog') {
      json(res, 200, JSON.stringify({ data: [], next_cursor: null }))
      return
    }
    if (req.method === 'GET' && path === agentPath + '/interactions') {
      json(
        res,
        200,
        JSON.stringify({
          data: interaction?.state === 'open' ? [interaction] : [],
          next_cursor: null,
        }),
      )
      return
    }
    if (req.method === 'POST' && path === agentPath + '/inputs') {
      const parsed = schemas.zCreateAgentInputBody.safeParse(JSON.parse(await requestBody(req)))
      if (!parsed.success) {
        json(res, 400, JSON.stringify({ error: 'Invalid input body', code: 'invalid_argument' }))
        return
      }
      const blocks = parsed.data.content_blocks
      const text = blocks
        .filter((block) => block.type === 'text' && block.metadata?.omnara_hidden !== 'true')
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n')
      sdkPosts.push(text)
      if (process.argv.includes('--trace-sdk')) {
        process.stderr.write('Omnara lab SDK POST text: ' + JSON.stringify(text) + '\n')
      }
      const inputID = fixtureId('ain', turn + 1)
      const createdAt = timestamp()
      const storedBlocks = blocks.filter((block) => block.type === 'text')
      const input = schemas.zAgentInput.parse({
        id: inputID,
        agent_id: scope.agentID,
        state: 'received',
        delivery_mode: 'immediate',
        input_kind: 'content',
        content_blocks: storedBlocks,
        queued_at: createdAt,
      })
      const currentTurn = ++turn
      activity.state = 'running'
      broadcast(
        JSON.stringify(
          schemas.zAgentInputEvent.parse({
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
            content_blocks: storedBlocks,
            created_at: createdAt,
          }),
        ),
        sequence,
      )
      json(res, 201, JSON.stringify({ agent_input: input }))
      if (text.trim().startsWith('/ask')) {
        interactionsOpened += 1
        interaction = schemas.zAgentInteraction.parse({
          id: fixtureId('int', currentTurn),
          org_id: scope.orgID,
          project_id: scope.projectID,
          agent_id: scope.agentID,
          tool_call_id: fixtureId('tcl', currentTurn),
          interaction_kind: 'question',
          state: 'open',
          request: {
            title: 'Loopback approval simulation',
            questions: [
              {
                prompt: 'Continue the fixture turn?',
                options: [{ label: 'Yes' }, { label: 'No' }],
              },
            ],
          },
          created_at: timestamp(),
        })
        activity.state = 'waiting_on_interaction'
        broadcast(
          JSON.stringify({
            tool_call_id: interaction.tool_call_id,
            agent_id: scope.agentID,
            state: 'waiting',
            interaction_update: { id: interaction.id, interaction_kind: 'question', state: 'open' },
          }),
        )
      } else {
        const timer = setTimeout(() => {
          responseTimers.delete(timer)
          completeTurn(currentTurn, text)
        }, 1_200)
        responseTimers.add(timer)
      }
      return
    }
    if (
      req.method === 'POST' &&
      interaction != null &&
      path === agentPath + '/interactions/' + interaction.id + '/resolve'
    ) {
      const parsed = schemas.zResolveAgentInteractionBody.safeParse(
        JSON.parse(await requestBody(req)),
      )
      if (!parsed.success) {
        json(
          res,
          400,
          JSON.stringify({ error: 'Invalid interaction answers', code: 'invalid_argument' }),
        )
        return
      }
      const resolved = schemas.zAgentInteraction.parse({
        ...interaction,
        state: 'resolved',
        resolution: { answers: parsed.data.answers },
        resolved_at: timestamp(),
      })
      interaction = resolved
      interactionsResolved += 1
      if (process.argv.includes('--trace-sdk')) {
        process.stderr.write('Omnara lab interaction resolved\n')
      }
      json(res, 200, JSON.stringify(resolved))
      broadcast(
        JSON.stringify({
          tool_call_id: interaction.tool_call_id,
          agent_id: scope.agentID,
          state: 'completed',
          interaction_update: {
            id: interaction.id,
            interaction_kind: 'question',
            state: 'resolved',
          },
        }),
      )
      completeTurn(turn, 'interaction resolved')
      return
    }
    json(res, 404, JSON.stringify({ error: 'Unknown fixture route', code: 'not_found' }))
  } catch (error) {
    if (res.headersSent) res.destroy(error instanceof Error ? error : undefined)
    else {
      json(
        res,
        error instanceof RangeError ? 413 : 400,
        JSON.stringify({
          error: 'Invalid fixture request',
          code: 'invalid_argument',
        }),
      )
    }
  }
}

function isTcpAddress(value: string | AddressInfo | null): value is AddressInfo {
  return value != null && typeof value !== 'string'
}

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
  if (!isTcpAddress(address)) throw new Error('Fixture port unavailable')
  const baseUrl = `http://127.0.0.1:${address.port}/v1`
  process.stderr.write(
    'Omnara/Tern loopback fixture at ' + baseUrl + ' (local only; no credentials or model calls)\n',
  )
  process.stderr.write(
    'Send text, emoji or multiline. Send /ask for an Ink-owned interaction. ' +
      'Quit with /quit or Ctrl-C.\n',
  )
  try {
    const client = createOmnaraClient({ baseUrl })
    await runChat(
      client,
      scope,
      resolveTernPresentation({ ternLive: process.argv.includes('--tern-live') }),
    )
    // runChat must release its native PTY ownership even on a /quit path.
    if (process.stdin.isRaw) throw new Error('runChat left the TTY in raw mode')
    if (process.argv.includes('--assert-ask')) {
      const exact = sdkPosts.filter((text) => text === '/ask').length
      const truncated = sdkPosts.filter((text) => text === '/').length
      if (
        exact !== 1 ||
        truncated !== 0 ||
        interactionsOpened !== 1 ||
        interactionsResolved !== 1
      ) {
        throw new Error(
          'Native /ask proof failed: exact=' +
            String(exact) +
            ', truncated=' +
            String(truncated) +
            ', opened=' +
            String(interactionsOpened) +
            ', resolved=' +
            String(interactionsResolved),
        )
      }
      process.stderr.write(
        'Native /ask proof: one exact SDK POST, interaction opened and resolved; TTY cooked.\n',
      )
    }
    if (process.argv.includes('--assert-pty')) {
      const expected = ['hè 🌍 第二行', 'rapid keys', 'line one\n世界\n第三行', '/ask']
      if (
        sdkPosts.length !== expected.length ||
        sdkPosts.some((text, index) => text !== expected[index]) ||
        interactionsOpened !== 1 ||
        interactionsResolved !== 1
      ) {
        throw new Error(
          'Native PTY proof failed: posts=' +
            JSON.stringify(sdkPosts) +
            ', opened=' +
            String(interactionsOpened) +
            ', resolved=' +
            String(interactionsResolved),
        )
      }
      process.stderr.write('Native PTY proof: exact SDK inputs and interaction; TTY cooked.\n')
    }
  } finally {
    for (const timer of responseTimers) clearTimeout(timer)
    responseTimers.clear()
    for (const stream of streams) stream.end()
    streams.clear()
    server.closeAllConnections()
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
  }
}

async function start(): Promise<void> {
  try {
    await main()
  } catch (error) {
    process.stderr.write('Native fixture failed: ' + String(error) + '\n')
    process.exitCode = 1
  }
}

void start()
