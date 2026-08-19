# Agent Note: Auth-based login for OAuth-only providers (Codex)

Status: implemented

English | [中文](2026-08-19-auth-based-login-oauth.zh.md)

## Problem

The installed pi-ai catalog ships one provider — `openai-codex` — that
authenticates through OAuth alone. The harness previously offered no path to
authenticate it: `llm-pi-ai` built its `Models` collection with no pi-ai
credential store, ran no login flow, and withheld the route from the
configurable-provider directory because no amount of configuration could make
it work. A Codex / ChatGPT Plus/Pro member had no way to use their subscription
through dsh; requests on the route failed `Provider is not configured` before
they went out.

## Decision

`llm-pi-ai` supplies a durable pi-ai `CredentialStore` to
`createModels({ credentials })`: a new file-backed store,
`.oauth-credentials.json` under the harness home, `0600` in a `0700` directory,
cross-process write-locked through `dsh-atomic-write`. It implements pi-ai's
`read/list/modify/delete` surface; `modify` holds the writer lock across its
read-apply-commit cycle so concurrent login and auto-refresh (including from
other processes) cannot resurrect a token another writer just rotated.

With a store present, pi-ai's `Models.login()` runs the Codex OAuth flow and
persists the membership credential, `Models.getAuth()` refreshes the access
token from the refresh token inside the store's serialized `modify`, and
`Models.logout()` removes it. Because the adapter can now authenticate it, the
`openai-codex` route is offered in the configurable-provider directory alongside
api-key routes; a profile (even an empty `{}`) activates it.

Login and logout run over the human-command channel (`/llm-login`,
`/llm-logout`, `/llm-auth`) through a `CommandInteraction` that answers the
flow's method-select and manual-code prompts from the command arguments and
captures every device-code / authorization-URL event for rendering. The
headless device-code flow is the default; the browser flow takes a pasted code
via `--paste`. Store location is plugin config (`oauthStorePath`/`dshHome`), never
a secret — the file holds the token.

## Alternatives considered

**Reimplement the Codex OAuth flow in dsh** — rejected. pi-ai (already a
dependency) ships a complete, maintained `openaiCodexOAuth` (PKCE browser +
device-code flows, refresh, `toAuth` → bearer access token) and the harness
already owns token persistence patterns; reimplementing would duplicate
maintenance and drift risk with no consumer gain.

**Surfacing login through a Web RPC + settings page card only** — deferred. The
human-command channel is the first shipped surface; a dedicated Web login
card is follow-up, because the device-code flow already renders through
`ctx.commands` with no new UI.

**OS-keychain credential store** — deferred. The `0600`/`0700` file matches the
existing env-credential posture and is testable in-process; a keychain store
that the model's processes cannot read remains a sibling-package follow-up.

## Consequences

Cost: the store is file-backed, so a same-UID process can read the token like
any file the user owns (no stronger boundary than the existing env-credential
file). Real membership use needs a one-time interactive login and a live
request that keyless tests cannot cover. ChatGPT-backend use of a membership
token through a third-party client is a ToS gray zone and the endpoints drift,
so stability is not promised.

Benefit: a Codex/ChatGPT membership becomes a first-class, auto-refreshing
credentials path with no API key, durable across restarts, and the directory
no longer hides a route the user can actually configure. Auto-refresh keeps
requests working until the refresh token itself is revoked, after which a
clearly coded `AUTH` error points the user at a fresh `/llm-login`.
