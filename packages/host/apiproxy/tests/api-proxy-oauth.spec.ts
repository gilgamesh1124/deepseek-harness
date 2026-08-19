/**
 * llm.oauth* RPC surface: the three methods delegate to the mounted `llmOauth`
 * service, map the adapter's unsupported-provider refusal onto the
 * `oauth-unsupported` wire code, and answer a clear error when the service is
 * absent. Schema round-trips for the new payloads/values live in
 * rpc-schemas.spec.ts beside the other domain schemas.
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '../src/api-proxy.ts'

/** A stable scripted request echoing its rpcId. */
function request<P>(payload: P): { rpcId: RpcId; payload: P } {
  return { rpcId: RpcId('r-1'), payload }
}

/** The scripted `llmOauth` service; the callers drive its behavior per case. */
interface ScriptedOauth {
  status: ReturnType<typeof vi.fn>
  logout: ReturnType<typeof vi.fn>
  login: ReturnType<typeof vi.fn>
}

async function harness(oauth: ScriptedOauth | undefined) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  const session = ctx.sessions.create()
  const agent = {
    id: session.id,
    session,
    status: 'running' as const,
    ctx,
    inbox: { nextTurn: [], nextStep: [] },
  } as unknown as Agent
  ctx.agents.register(agent)
  const sessionId: SessionId = session.id
  if (oauth !== undefined) ctx.provide('llmOauth', oauth as never)
  const api = createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'x', model: 'y' }), cwd: '/tmp' })
  return { ctx, api, sessionId }
}

/** The error face of a failed RPC response. */
interface ErrorResponse {
  result: { ok: true } | { ok: false; error: { code: string; message: string } }
}

/** Narrow a failed response to its error face, failing the case on success. */
function expectError(response: ErrorResponse): { code: string; message: string } {
  if (response.result.ok) throw new Error('expected an error response')
  return response.result.error
}

function scriptedOauth(): ScriptedOauth {
  return {
    status: vi.fn(async () => ({ authenticated: false })),
    logout: vi.fn(async () => undefined),
    login: vi.fn(async () => ({ authenticated: false })),
  }
}

describe('llm.oauthStatus', () => {
  it('reports the service Authenticated projection', async () => {
    const oauth = scriptedOauth()
    oauth.status.mockResolvedValue({ authenticated: true, type: 'oauth' })
    const { api } = await harness(oauth)
    const response = await api.llm.oauthStatus(request({ provider: 'openai-codex' }))
    expect(response.result).toEqual({ ok: true, value: { authenticated: true, type: 'oauth' } })
    expect(oauth.status).toHaveBeenCalledWith('openai-codex')
  })

  it('maps an unsupported provider to the oauth-unsupported wire code', async () => {
    const oauth = scriptedOauth()
    oauth.status.mockRejectedValue(new Error('llmOauth: provider "openai" does not offer an OAuth login method'))
    const { api } = await harness(oauth)
    const response = await api.llm.oauthStatus(request({ provider: 'openai' }))
    expect(response.rpcId).toBe('r-1')
    expect(response.result).toMatchObject({
      ok: false,
      error: { code: 'oauth-unsupported', details: { provider: 'openai' } },
    })
  })

  it('answers a clear error when the llm-pi-ai adapter is not mounted', async () => {
    const { api } = await harness(undefined)
    const response = await api.llm.oauthStatus(request({ provider: 'openai-codex' }))
    const error = expectError(response)
    expect(error.code).toBe('internal')
    expect(error.message).toMatch(/does not mount/)
  })
})

describe('llm.oauthLogout', () => {
  it('delegates to the service and returns an empty value', async () => {
    const oauth = scriptedOauth()
    const { api } = await harness(oauth)
    const response = await api.llm.oauthLogout(request({ provider: 'openai-codex' }))
    expect(response.result).toEqual({ ok: true, value: {} })
    expect(oauth.logout).toHaveBeenCalledWith('openai-codex')
  })

  it('folds an adapter failure into an error response', async () => {
    const oauth = scriptedOauth()
    oauth.logout.mockRejectedValue(new Error('logout exploded'))
    const { api } = await harness(oauth)
    const response = await api.llm.oauthLogout(request({ provider: 'openai-codex' }))
    expect(response.result.ok).toBe(false)
    expect(response.result).toMatchObject({ ok: false, error: { code: 'internal', message: 'logout exploded' } })
  })
})

describe('llm.oauthLoginStart', () => {
  it('defaults to the device flow and returns the captured device code', async () => {
    const oauth = scriptedOauth()
    oauth.login.mockResolvedValue({ userCode: 'ABCD-1234', verificationUri: 'https://auth.example/device', authenticated: false })
    const { api } = await harness(oauth)
    const response = await api.llm.oauthLoginStart(request({ provider: 'openai-codex' }))
    expect(response.result).toEqual({
      ok: true,
      value: { userCode: 'ABCD-1234', verificationUri: 'https://auth.example/device', authenticated: false },
    })
    expect(oauth.login).toHaveBeenCalledWith('openai-codex', 'device')
  })

  it('honors an explicit browser method and its login url', async () => {
    const oauth = scriptedOauth()
    oauth.login.mockResolvedValue({ loginUrl: 'https://auth.example/start', authenticated: false })
    const { api } = await harness(oauth)
    const response = await api.llm.oauthLoginStart(request({ provider: 'openai-codex', method: 'browser' }))
    expect(response.result).toEqual({
      ok: true,
      value: { loginUrl: 'https://auth.example/start', authenticated: false },
    })
    expect(oauth.login).toHaveBeenCalledWith('openai-codex', 'browser')
  })

  it('maps an unsupported provider to oauth-unsupported', async () => {
    const oauth = scriptedOauth()
    oauth.login.mockRejectedValue(new Error('llmOauth: provider "openai" does not offer an OAuth login method'))
    const { api } = await harness(oauth)
    const response = await api.llm.oauthLoginStart(request({ provider: 'openai' }))
    expect(response.result).toMatchObject({
      ok: false,
      error: { code: 'oauth-unsupported', details: { provider: 'openai' } },
    })
  })

  it('answers a clear error when the llm-pi-ai adapter is not mounted', async () => {
    const { api } = await harness(undefined)
    const response = await api.llm.oauthLoginStart(request({ provider: 'openai-codex' }))
    const error = expectError(response)
    expect(error.code).toBe('internal')
    expect(error.message).toMatch(/does not mount/)
  })
})
