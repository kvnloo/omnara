# Omnara CLI

Command-line interface for [Omnara](https://omnara.com): launch and manage agents, organizations, integrations, and MCP servers.

## Installation

```sh
npx omnara
```

## Usage

```sh
omnara login
omnara --help
```

Requires Node.js 22 or later.

## Native Tern presentation (downstream experiment)

`omnara agents chat <agent-id>` runs the existing Ink CLI in any terminal.
Inside a compatible Tern terminal, TSP v1 negotiates an **idle-only native
composer by default**. The draft and send path remain Omnara-owned. On a
submitted/running turn or a permission/question interaction, native ownership
closes and Ink handles transcript, tools, backlog, subagents and approvals.
Unsupported Tern capabilities, evicted/rejected surfaces, or transport errors
also return to Ink. No separate backend or credential path is introduced.

Optional live projection from the historical #14/#15 slices is **off by default**.
To enable native message/tool/backlog/status and direct-subagent projections,
including native composition while busy, use either:

```sh
omnara agents chat <agent-id> --tern-live
OMNARA_TERN_LIVE=1 omnara agents chat <agent-id>
```

Live mode requires the negotiated native node kinds. Without them, busy turns
fall back to Ink. Permission/question interactions always remain Ink-owned.
Set `OMNARA_TERN_NATIVE=0` or use `--no-tern` for the ordinary Ink UI. The
disable switch wins if both opt-in and disable options are supplied.
Neither mode moves approvals, agent runtime, event history or SDK semantics into
Tern. #11's `agents bridge-omp` backend-inversion experiment is excluded.

Development checks from the repository root (`Node >=24`, `pnpm@11.22.0`):

```sh
cd frontend
pnpm install --frozen-lockfile
pnpm --filter omnara test
pnpm --filter omnara typecheck
pnpm --filter omnara build
cd ..
make web-static-check
```

The focused **kernel PTY regression** (POSIX + Python 3 standard library, no
providers or credentials) is included in `pnpm --filter omnara test`. Run it
separately to isolate raw tty and UTF-8 input failures:

```sh
cd frontend
pnpm --filter omnara exec vitest run src/tern/pty.test.ts
```

It forks a real OS PTY, launches `runChat` with the real React hooks and SDK
against the existing localhost fixture, and checks fragmented UTF-8 input,
batched ordinary keys, bracketed multiline paste, interleaved APCs, `/ask`,
the Ink-owned question and cooked quit at the exact SDK boundary. The owned
peer only supplies TSP hello/ACK; **it is not the Tern application**. The
test is skipped on Windows or when Python 3 is unavailable. Install Python 3
before accepting this gate.

These checks are not a native terminal acceptance receipt. To run the real
`runChat` CLI, `@omnara/sdk` client, and `@omnara/react` hooks against a
self-contained, credential-free loopback HTTP/SSE fixture inside Tern:

```sh
cd frontend
pnpm --filter omnara exec tsx src/tern/lab.ts
pnpm --filter omnara exec tsx src/tern/lab.ts --tern-live
```

The second command enables live transcript and direct-subagent projection. Send
`/ask` for an Ink-owned fixture interaction, or ordinary multilingual/multiline
text for a delayed synthetic turn. The lab binds only to 127.0.0.1 and makes
no provider calls. Exercise both modes in an owned Tern/pty session, including
atomic send exactly once, busy/idle handoff, interactions, resize, focus, theme,
reconnect, eviction/error fallback and terminal exit. Protocol fixtures and
mounted Ink tests are not proof of actual native Tern behavior.

Tern/TSP and the original OMP native-presentation work: **Can Bölük /
Stencil Labs**. The native seam follows the Hermes × Tern contributors'
application-authoritative presentation approach. Omnara contributors own
the existing durable runtime, React chat state, SDK and Ink CLI.

## Documentation

See the [Omnara docs](https://docs.omnara.com) and the [GitHub repository](https://github.com/omnara-ai/omnara).

## License

Apache-2.0

## Project integrations

Each project integration owns its provider identity, credentials, and optional launcher.
Create a disconnected draft, connect its account, then choose launch settings.
Names are immutable: 1–32 letters, numbers, or hyphens, starting with a letter.

With an organization and project selected:

```sh
omnara integrations definitions
omnara integrations create --body '{"name":"engineering","integration_kind":"slack_thread","settings":{}}'
omnara integrations list
```

Use the returned integration ID as `INTEGRATION_ID`; keep it as `SLACK_INTEGRATION_ID` for the launcher
example below. Connect Slack through browser authorization using an existing
Slack app:

```sh
omnara integrations slack "$INTEGRATION_ID" --client-id "$SLACK_CLIENT_ID" \
  --client-secret "$SLACK_CLIENT_SECRET" --signing-secret "$SLACK_SIGNING_SECRET"
omnara integrations slack --help
omnara integrations get "$INTEGRATION_ID"
```

`integrations slack` also supports automatic Slack app creation with `--app-name` and
`--app-configuration-token`. Reconnecting preserves the saved launcher settings.

For GitHub or Discord, create a project credential with `secrets create`, or reuse
an existing credential of the matching provider kind. Read `setup_revision` from
`integrations get` before configuring the integration. The server verifies the credentials and
rejects a stale revision.

```sh
omnara integrations create --body '{"name":"reviewer","integration_kind":"github_pr","settings":{}}'
# Set INTEGRATION_ID to this new integration's ID and SETUP_REVISION to its current setup_revision.
omnara integrations configure "$INTEGRATION_ID" --expected-setup-revision "$SETUP_REVISION" \
  --provider-tenant-id "$GITHUB_APP_ID" --provider-account-ref "$GITHUB_INSTALLATION_ID" \
  --credential-secret-id "$SECRET_ID"
omnara integrations configure --help
```

GitHub uses its numeric App ID and Installation ID; the credential's App ID must
match. Discord uses its Application ID and discovers the bot User ID from its token. Configure Discord's
interaction public key with `--provider-config '{"public_key":"YOUR_64_HEX_PUBLIC_KEY"}'`
before using a launcher or interaction handler. Discord launchers include a handler by default. Set its
Interactions Endpoint URL to
`https://YOUR_OMNARA_HOST/api/integrations/discord/APPLICATION_ID/interactions`.
Omnara manages one Gateway connection per saved Discord integration.

`integrations update` replaces the integration's settings. Only `settings` belongs in
an update; name and `integration_kind` are supplied on create.

```sh
omnara integrations update "$SLACK_INTEGRATION_ID" --body '{
  "settings": {"launcher": {"profiles": ["aprf_aeaqcaibaeaqcaibaeaqcaibae"]}}
}'
omnara integrations profiles "$SLACK_INTEGRATION_ID" --profile-ids "$PROFILE_ID" --profile-ids "$SECOND_PROFILE_ID"
```

Slack and Discord launchers contain only ordered, distinct public profile IDs:
one starts immediately; several offer a menu selecting exactly one. Slack launches
from mentions wherever the bot can receive messages, and from DMs without a mention.
Discord launches from mentions in servers where the bot has access; DMs do not launch.
Manage channel access in Slack or Discord. `integrations profiles` preserves the
integration's other settings.

GitHub uses `launcher.profile`, `launcher.trigger` (`mention`, `pull_request_opened`, or `both`),
and optional `launcher.repository_id`. PR-open launches, mention launches and comments
that direct agents require repository write access. The definitions catalog
publishes each integration's complete settings schema in `capabilities.settings`.

Select tools and interaction handlers independently in agent configurations:
tools use keys such as `int__engineering__post_message`, and interaction handlers
use `engineering: {}`. Tool entries accept permissions, enabled state and deferral.
For the shipped thread and PR tools, destinations come from the integration-agent
conversation context assigned by provider/scheduled launches. These tools fail
without that context; their arguments cannot choose another destination. Integrations can
also define standalone tools that use their credentials without a conversation.
Shipped interaction handlers use the assigned conversation and accept empty arguments.
Incoming subscriptions belong to the integration and are attached via
launch requests or the integration subscriptions API.
`integrations get` and `integrations definitions` show optional
`capabilities.subscription.conversation_schema`. Attachments specify the integration
and conversation; the integration determines which activity is forwarded. Tools and
handlers expose static `input_schema`. A launcher adds its provider's missing tools and
handler to future agents; editing settings does not rewrite existing agents.

```sh
omnara integrations disconnect "$INTEGRATION_ID"
omnara integrations delete "$INTEGRATION_ID"
```

Disconnect stops provider access for that integration and keeps its setup for reconnecting.
Delete removes that integration and revokes its capabilities. Other integrations keep their own
lifecycle, including integrations sharing a credential. Existing agents and history remain
usable through the dashboard and API.
