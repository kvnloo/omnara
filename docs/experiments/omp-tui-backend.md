# Experiment: OMP TUI as an Omnara frontend

Companion OMP branch: `kvnloo/oh-my-pi:exp/omnara-backend`.

## Result so far

The first dogfood slice does **not** require an Omnara backend change.

Omnara's existing public agent API already exposes the runtime boundary OMP needs:

- `POST /inputs` — submit user input with an idempotency key.
- `GET /events` — hydrate durable timeline history.
- `GET /events/stream?stream_deltas=true` — resumable SSE for live output.
- `GET /tool-calls?include_subagents=true` — authoritative tool lifecycle.
- `GET /interactions?state=open&include_subagents=true` — human-in-the-loop prompts.
- `POST /interactions/{interaction_id}/resolve` — resolve an interaction on its owning agent.
- `POST /cancel` — interrupt the active agent.
- `GET /agents/{agent_id}` — agent/model metadata.

The OMP experiment consumes those APIs directly. This branch remains isolated so any
server-side gap discovered during dogfooding has a place to land without changing
Omnara main prematurely.

## Boundary

```text
OMP InteractiveMode / Composer / transcript / TSP / Tern
                        ↓
              thin Omnara adapter
                        ↓
        Omnara REST + resumable SSE
                        ↓
             Omnara durable agent
```

OMP owns presentation. Omnara remains authoritative for the remote agent timeline,
tools, interactions, subagents and cancellation.

## Event ownership

Durable Omnara events remain source of truth:

- `agent_input`
- `model_output`
- `tool_result`
- `context_checkpoint`

Streaming `model_output_delta` frames are presentation-only previews. Tool update
notifications trigger reconciliation against the authoritative tool-call list.

The adapter follows Omnara's own terminal-event rule: a model output is terminal
when it is not a `max_tokens` continuation and contains no tool calls. Durable
control events also settle the OMP surface.

## Human interaction

The experiment projects Omnara interactions into OMP's existing native selector
and text-input surfaces. It never invents user consent. Multi-select remains open
until we add an exact UI mapping.

## Provenance

- Omnara's public agent/event/tool/interaction contracts: the Omnara team.
- OMP InteractiveMode, TUI, native TSP and Tern implementation: Can Bölük / Stencil Labs.
- Backend-inversion experiment and comparison with the Hermes spike: Kevin Rajan.

This is a dogfood experiment, not an upstream architecture recommendation.
