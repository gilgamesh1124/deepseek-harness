/**
 * llm domain contract: host-scoped provider topology for configuration
 * surfaces. `llm.providers` merges the configurable-provider directory
 * (which providers CAN be configured, and where their settings live) with the
 * live route registry; `llm.models` is the session-independent model catalog
 * (the same groups as `session.models`, without a per-session selection).
 * Clients invalidate from the forwarded `llm/adapters-updated` and
 * `settings/document-updated` owner events.
 */

import type { RpcRequest, RpcResponse } from './rpc.ts'
import type { ModelCatalogFailure, ModelProviderGroup } from './sessions.ts'

/** Wire view of one configurable provider. */
export interface ConfigurableProviderView {
  /** Provider route key (`deepseek-official`, `openai`, …). */
  provider: string
  /** Human-readable name for configuration surfaces. */
  displayName: string
  /** Settings namespace whose section configures this provider. */
  settingsNs: string
  /** Path from that section's root to the provider's profile object (empty = whole section). */
  settingsPath: string[]
  /** Whether the route is currently registered (its models are requestable). */
  active: boolean
  /**
   * Whether the owning adapter knows this route only because configuration
   * declared it. Absent when the adapter draws no such distinction, so a
   * surface must treat absence as "unknown", not as "shipped".
   */
  declared?: boolean
}

/** Llm-domain unary methods (the map keys llm.* of RpcMethodMap). */
export interface LlmApi {
  /**
   * List every configurable provider with its live/dormant state, in
   * directory declaration order. Routes registered outside the directory
   * (an adapter that never declared configurability) are appended with their
   * registration identity and no settings address.
   */
  providers(request: RpcRequest<{}>): Promise<RpcResponse<{ providers: ConfigurableProviderView[] }>>

  /**
   * Host-scoped model catalog over every registered provider route: the
   * settings surface's models view, needing no session. Per-provider listing
   * failures ride `failures` without failing the sound groups.
   */
  models(request: RpcRequest<{}>): Promise<RpcResponse<{ groups: ModelProviderGroup[]; failures: ModelCatalogFailure[] }>>

  /**
   * Interrogate a provider endpoint the configuration surface is still
   * drafting, and return the models it advertises for the user to adopt.
   *
   * The payload is the draft, not a stored route: `settingsNs` selects the
   * adapter family that answers, and the rest comes from the form. `provider`
   * names the route being edited when there is one — an adapter that already
   * describes that route answers from its own registry, with better metadata
   * and no network call, and needs no endpoint. A route it does not describe is
   * asked over the wire, which is what `baseURL`, `api`, and `apiKey` are for.
   *
   * Nothing is written — the reply is candidates, and only a later
   * `settings.mutate` decides what a route serves. `apiKey` is accepted here
   * but never stored or returned; a provider whose key is already stored omits
   * it and the endpoint answers unauthenticated or refuses.
   */
  discoverModels(
    request: RpcRequest<{
      settingsNs: string
      provider?: string
      baseURL?: string
      api?: string
      apiKey?: string
    }>,
    signal?: AbortSignal,
  ): Promise<RpcResponse<{ models: DiscoveredModelView[] }>>

  /**
   * Whether one provider route currently has a durable OAuth credential. Only
   * routes the adapter family authenticates through OAuth are answered; asking
   * about another route fails with `oauth-unsupported`.
   */
  oauthStatus(request: RpcRequest<{ provider: string }>): Promise<RpcResponse<OauthStatusView>>

  /**
   * Forget the stored OAuth credential of one provider route (logout).
   * Idempotent for a route that has none.
   */
  oauthLogout(request: RpcRequest<{ provider: string }>): Promise<RpcResponse<{}>>

  /**
   * Start an OAuth login for one provider route. The device-code flow is the
   * default; the handler runs the flow to completion in the background and
   * returns the one-time code / verification URL (or the browser flow's
   * authorization URL) to show the user, before the flow settles. Re-query
   * `oauthStatus` to learn when the credential actually lands.
   */
  oauthLoginStart(
    request: RpcRequest<{ provider: string; method?: OauthMethod }>,
  ): Promise<RpcResponse<OauthLoginStartView>>
}

/** Login method a caller may select for an OAuth flow. */
export type OauthMethod = 'browser' | 'device'

/** Wire view of one provider route's OAuth state. */
export interface OauthStatusView {
  /** Whether a durable OAuth credential is currently stored for the route. */
  authenticated: boolean
  /** The stored auth method, present once authenticated; `oauth` is the only supported one. */
  type?: string
}

/** Wire view returned by an OAuth login start. */
export interface OauthLoginStartView {
  /** Authorization URL of the browser flow, when the flow opened one. */
  loginUrl?: string
  /** One-time code of the device-code flow, when the flow issued one. */
  userCode?: string
  /** Verification URL the user opens to enter {@link OauthLoginStartView.userCode}. */
  verificationUri?: string
  /** Whether the credential was already persisted by the time login returned. */
  authenticated: boolean
}

/** Wire view of one model an interrogated endpoint advertises. */
export interface DiscoveredModelView {
  /** Model id the endpoint accepts. */
  id: string
  /** Human-readable name when the endpoint supplies one. */
  name?: string
  /** Maximum combined request and response context, when disclosed. */
  contextWindow?: number
  /** Maximum output tokens, when disclosed. */
  maxTokens?: number
}
