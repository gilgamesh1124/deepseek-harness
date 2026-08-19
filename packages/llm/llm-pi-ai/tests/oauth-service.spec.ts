import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { AuthEvent } from '@earendil-works/pi-ai'
import { LlmOauth } from '../src/oauth-service.ts'
import type { PiAiAdapter } from '../src/adapter.ts'

/**
 * A scripted pi-ai adapter whose login emits the device code synchronously
 * (as a real flow does) and then settles the credential some time later, so a
 * login start answers with the code while a follow-up status reports the
 * credential landed. Everything else is a recorded stub.
 */
function fakeAdapter() {
  let authenticated = false
  const adapter = {
    authStatus: vi.fn(async (): Promise<{ type: 'oauth' } | undefined> =>
      authenticated ? { type: 'oauth' } : undefined),
    logout: vi.fn(async () => { authenticated = false }),
    login: vi.fn(async (_provider: string, _type: 'oauth', interaction: { notify(event: AuthEvent): void }) => {
      interaction.notify({ type: 'device_code', userCode: 'ABCD-1234', verificationUri: 'https://auth.example/device' })
      await new Promise<void>((resolve) => { setTimeout(() => { authenticated = true; resolve() }, 30) })
    }),
  }
  return { adapter: adapter as unknown as PiAiAdapter, methods: adapter }
}

describe('LlmOauth', () => {
  it('reports authenticated status from the adapter for a supported provider', async () => {
    const { adapter, methods } = fakeAdapter()
    methods.authStatus.mockResolvedValue({ type: 'oauth' })
    const ctx = new Context()
    const service = new LlmOauth(ctx, adapter)
    await expect(service.status('openai-codex')).resolves.toEqual({ authenticated: true, type: 'oauth' })
    expect(methods.authStatus).toHaveBeenCalledWith('openai-codex')
    await ctx.fiber.dispose()
  })

  it('reports not authenticated when the adapter holds no credential', async () => {
    const { adapter } = fakeAdapter()
    const ctx = new Context()
    const service = new LlmOauth(ctx, adapter)
    await expect(service.status('openai-codex')).resolves.toEqual({ authenticated: false })
    await ctx.fiber.dispose()
  })

  it('refuses providers the catalog does not authenticate through OAuth', async () => {
    const { adapter } = fakeAdapter()
    const ctx = new Context()
    const service = new LlmOauth(ctx, adapter)
    await expect(service.status('openai')).rejects.toThrow(/does not offer an OAuth login method/)
    await expect(service.login('openai')).rejects.toThrow(/does not offer an OAuth login method/)
    await expect(service.logout('openai')).rejects.toThrow(/does not offer an OAuth login method/)
    await ctx.fiber.dispose()
  })

  it('delegates logout to the adapter', async () => {
    const { adapter, methods } = fakeAdapter()
    const ctx = new Context()
    const service = new LlmOauth(ctx, adapter)
    await service.logout('openai-codex')
    expect(methods.logout).toHaveBeenCalledWith('openai-codex')
    await ctx.fiber.dispose()
  })

  it('returns the device code quickly and reports authenticated after the flow lands', async () => {
    const { adapter } = fakeAdapter()
    const ctx = new Context()
    const service = new LlmOauth(ctx, adapter)

    const start = await service.login('openai-codex')
    // The code is captured from the flow's first notify event, before the
    // flow (which persists the credential 30ms later) settles.
    expect(start).toEqual({
      loginUrl: undefined,
      userCode: 'ABCD-1234',
      verificationUri: 'https://auth.example/device',
      authenticated: false,
    })
    // The background login persists the credential shortly after; a re-check
    // reports it authenticated.
    await vi.waitFor(async () => {
      await expect(service.status('openai-codex')).resolves.toEqual({ authenticated: true, type: 'oauth' })
    }, { timeout: 1000 })
    // The single-run guard released the provider once the login settled.
    expect(service.loginRunning('openai-codex')).toBe(false)
    await ctx.fiber.dispose()
  })

  it('refuses a second concurrent login for the same provider', async () => {
    const { adapter, methods } = fakeAdapter()
    // Hold the first login's promise unresolved (after emitting its code) so the
    // guard stays armed; the first login returns the code quickly.
    methods.login.mockImplementation((_provider, _type, interaction: { notify(event: AuthEvent): void }) => {
      interaction.notify({ type: 'device_code', userCode: 'ABCD-1234', verificationUri: 'https://auth.example/device' })
      return new Promise<void>(() => {})
    })
    const ctx = new Context()
    const service = new LlmOauth(ctx, adapter)
    await service.login('openai-codex')
    await expect(service.login('openai-codex')).rejects.toThrow(/already running/)
    await ctx.fiber.dispose()
  })
})
