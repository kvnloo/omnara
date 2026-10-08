# Experiment: OMP TUI as an Omnara frontend

Companion OMP branch: `kvnloo/oh-my-pi:exp/omnara-backend`.

## Result

The public Omnara backend already has the runtime semantics OMP needs. The
missing piece was an ownership-clean process boundary.

This branch now exposes:

```text
omnara agents bridge-omp <agent-id>
```

It is a renderer-neutral NDJSON JSON-RPC bridge implemented in the Omnara CLI
and backed entirely by Omnara's official TypeScript SDK.

## Boundary

```text
OMP InteractiveMode / Composer / transcript / TSP / Tern
                        ↓
             tiny JSON-RPC client
                        ↓
        omnara agents bridge-omp
                        ↓
 official SDK / schemas / resilient SSE
                        ↓
             Omnara durable agent
```

The ownership rule is the important part:

- OMP owns presentation and translates Omnara-native events into its existing
  `AgentSessionEvent` lifecycle.
- Omnara owns authentication, REST paths, generated schemas, SSE recovery,
  cursor handling, and API evolution.
- No Omnara Ink/React UI is copied into OMP.
- OMP does not maintain a second Omnara HTTP/SSE implementation.

The internal machine daemon protocol remains out of this path; it owns machines
and processes, not the durable agent conversation contract.

## Bridge requests

- `agent.get`
- `events.list`
- `tool_calls.list` with subagents
- `interactions.list` with subagents
- `input.create` with idempotency key, queued/steering delivery, and typed
  inline media attachments
- `interaction.resolve`
- `agent.cancel`
- `stream.start`
- `stream.stop`
- `ping`

Notifications:

- `ready`
- `stream.event`
- `stream.connection`
- `stream.error`

## State ownership

Durable Omnara events remain source of truth:

- `agent_input`
- `model_output`
- `tool_result`
- `context_checkpoint`

The bridge emits transient model-output deltas for presentation but relies on
Omnara's existing `openAgentEventStream` implementation for validation,
reconnection and durable cursor recovery. Tool update notifications cause the
OMP adapter to refresh authoritative tool-call state.

For user input, the bridge validates attachments with Omnara's generated
`InlineMediaContentBlock` schema and submits them through the official SDK. It
also follows Omnara's existing chat convention by adding a model-visible,
transcript-hidden source hint identifying OMP as the active surface.

## Human interaction

The OMP companion branch projects Omnara interactions into OMP's existing
native selector and text-input surfaces. It never invents user consent.
Multi-select remains open until there is an exact UI mapping.

## Dogfood

The OMP branch can invoke this checkout directly with:

```bash
OMNARA_ROOT=/path/to/kvnloo/omnara \
OMNARA_API_KEY=omnara_pat_v1_... \
OMNARA_ORG_ID=org_... \
OMNARA_PROJECT_ID=proj_... \
OMNARA_AGENT_ID=agt_... \
bun run omnara:tui
```

## Provenance

- Omnara's chat/event and resilient-streaming surfaces: Christian Sparks,
  Asher Dale, ksarangmath, and the Omnara team.
- OMP InteractiveMode, TUI, native TSP and Tern implementation: Can Bölük /
  Stencil Labs.
- OMP UI-as-client/session-host direction: André Braït.
- Backend-inversion experiment and Hermes/Omnara comparison: Kevin Rajan.

This is a dogfood experiment, not an upstream architecture recommendation.
