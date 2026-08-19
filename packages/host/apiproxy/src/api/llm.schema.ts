/**
 * llm domain zod schemas (names derived from map keys: llmProvidersRequestSchema /
 * llmProvidersValueSchema / llmModelsRequestSchema / llmModelsValueSchema).
 */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import type { ConfigurableProviderView, DiscoveredModelView, OauthLoginStartView, OauthStatusView } from './llm.ts'
import { modelCatalogFailureSchema, modelProviderGroupSchema } from './sessions.schema.ts'

/** ConfigurableProviderView row of llm.providers. */
export const configurableProviderViewSchema = z.object({
  provider: z.string().min(1),
  displayName: z.string().min(1),
  settingsNs: z.string(),
  settingsPath: z.array(z.string()),
  active: z.boolean(),
  declared: z.boolean().optional(),
}) satisfies z.ZodType<Wire<ConfigurableProviderView>>

/** llm.providers request payload. */
export const llmProvidersRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'llm.providers'>>>

/** llm.providers response value. */
export const llmProvidersValueSchema = z.object({
  providers: z.array(configurableProviderViewSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'llm.providers'>>>

/** llm.models request payload. */
export const llmModelsRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'llm.models'>>>

/** llm.models response value. */
export const llmModelsValueSchema = z.object({
  groups: z.array(modelProviderGroupSchema),
  failures: z.array(modelCatalogFailureSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'llm.models'>>>

/** DiscoveredModelView row of llm.discoverModels. */
export const discoveredModelViewSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  contextWindow: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
}) satisfies z.ZodType<Wire<DiscoveredModelView>>

/** llm.discoverModels request payload. */
export const llmDiscoverModelsRequestSchema = z.object({
  settingsNs: z.string().min(1),
  provider: z.string().min(1).optional(),
  baseURL: z.string().min(1).optional(),
  api: z.string().min(1).optional(),
  // Write-only at the host: used for this one interrogation, never stored and
  // never returned. It does ride the client's outgoing envelope like every
  // other secret-bearing payload (`credentials.set`, `settings.update`), which
  // `subscribeEnvelopes()` observers can see — redacting that tap is a
  // configuration-plane-wide change, not this method's to make alone.
  apiKey: z.string().min(1).optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'llm.discoverModels'>>>

/** llm.discoverModels response value. */
export const llmDiscoverModelsValueSchema = z.object({
  models: z.array(discoveredModelViewSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'llm.discoverModels'>>>

/** OauthStatusView row of llm.oauthStatus. */
export const oauthStatusViewSchema = z.object({
  authenticated: z.boolean(),
  type: z.string().optional(),
}) satisfies z.ZodType<Wire<OauthStatusView>>

/** llm.oauthStatus request payload. */
export const llmOauthStatusRequestSchema = z.object({
  provider: z.string().min(1),
}) satisfies z.ZodType<Wire<RequestPayload<'llm.oauthStatus'>>>

/** llm.oauthStatus response value. */
export const llmOauthStatusValueSchema = z.object({
  authenticated: z.boolean(),
  type: z.string().optional(),
}) satisfies z.ZodType<Wire<ResponseValue<'llm.oauthStatus'>>>

/** llm.oauthLogout request payload. */
export const llmOauthLogoutRequestSchema = z.object({
  provider: z.string().min(1),
}) satisfies z.ZodType<Wire<RequestPayload<'llm.oauthLogout'>>>

/** llm.oauthLogout response value. */
export const llmOauthLogoutValueSchema = z.object({}) satisfies z.ZodType<Wire<ResponseValue<'llm.oauthLogout'>>>

/** OauthLoginStartView row of llm.oauthLoginStart. */
export const oauthLoginStartViewSchema = z.object({
  loginUrl: z.string().optional(),
  userCode: z.string().optional(),
  verificationUri: z.string().optional(),
  authenticated: z.boolean(),
}) satisfies z.ZodType<Wire<OauthLoginStartView>>

/** llm.oauthLoginStart request payload. */
export const llmOauthLoginStartRequestSchema = z.object({
  provider: z.string().min(1),
  method: z.enum(['browser', 'device']).optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'llm.oauthLoginStart'>>>

/** llm.oauthLoginStart response value. */
export const llmOauthLoginStartValueSchema = z.object({
  loginUrl: z.string().optional(),
  userCode: z.string().optional(),
  verificationUri: z.string().optional(),
  authenticated: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'llm.oauthLoginStart'>>>
