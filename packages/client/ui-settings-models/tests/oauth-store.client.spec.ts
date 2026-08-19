/** Models page store OAuth actions: status, logout, and the login start + poll. */
import { describe, expect, it, vi } from 'vitest'
import type { RpcResponse } from '@deepseek-ai/dsh-api-remotes/client'
import { ModelsSettingsStore } from '../src/client/store.ts'

let nextRpc = 0
function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: `r-${nextRpc++}` as never, result: { ok: true, value } }
}
function fail<T>(message: string): RpcResponse<T> {
  return { rpcId: `r-${nextRpc++}` as never, result: { ok: false, error: { code: 'internal', message, details: {} } } }
}

/** A store whose OAuth wire calls are scripted; every other domain is a no-op. */
function oauthStore(overrides: {
  status?: () => Promise<RpcResponse<{ authenticated: boolean }>>
  loginStart?: () => Promise<RpcResponse<{ authenticated: boolean; userCode?: string; verificationUri?: string; loginUrl?: string }>>
  logout?: () => Promise<RpcResponse<{}>>
} = {}) {
  const status = vi.fn(async () => ok({ authenticated: false }))
  const logout = vi.fn(async () => ok({}))
  const loginStart = vi.fn(async () => ok({ authenticated: false, userCode: 'ABCD', verificationUri: 'https://device' }))
  const statusImpl = overrides.status === undefined ? status : vi.fn(overrides.status)
  const loginStartImpl = overrides.loginStart === undefined ? loginStart : vi.fn(overrides.loginStart)
  const logoutImpl = overrides.logout === undefined ? logout : vi.fn(overrides.logout)
  const api = {
    llm: {
      oauthStatus: statusImpl,
      oauthLogout: logoutImpl,
      oauthLoginStart: loginStartImpl,
    },
    settings: { describe: async () => ok({ writable: true, namespaces: [] }) },
    credentials: { describe: async () => ok({ credentials: {} }) },
  }
  const store = new ModelsSettingsStore(api as never)
  // Tighten the poll so a login-settling test runs fast and deterministically.
  store.oauthStatusIntervalMs = 5
  store.oauthStatusPollAttempts = 20
  return { store, status: statusImpl, logout: logoutImpl, loginStart: loginStartImpl }
}

describe('ModelsSettingsStore oauth', () => {
  it('oauthStatus folds the authenticated projection into the snapshot', async () => {
    const { store, status } = oauthStore({ status: async () => ok({ authenticated: true }) })
    await store.oauthStatus('openai-codex')
    expect(status).toHaveBeenCalledWith({ provider: 'openai-codex' })
    expect(store.store.getSnapshot().oauth['openai-codex']).toMatchObject({ authenticated: true })
  })

  it('oauthStatus records a business rejection as an error without throwing', async () => {
    const { store } = oauthStore({ status: async () => fail('no provider') })
    await store.oauthStatus('openai-codex')
    expect(store.store.getSnapshot().oauth['openai-codex']).toMatchObject({
      authenticated: false, error: 'no provider',
    })
  })

  it('oauthLogout clears the stored credential and reports not authenticated', async () => {
    const { store, logout } = oauthStore()
    await store.oauthLogout('openai-codex')
    expect(logout).toHaveBeenCalledWith({ provider: 'openai-codex' })
    expect(store.store.getSnapshot().oauth['openai-codex']).toMatchObject({ authenticated: false })
  })

  it('oauthLoginStart shows the device code and flips to authenticated when the flow lands', async () => {
    // The fake answers the status as authenticated only once login starts, so
    // the store's poll picks the landing up.
    let landed = false
    const { store, loginStart } = oauthStore({
      status: async () => ok({ authenticated: landed }),
      loginStart: async () => {
        landed = true
        return ok({ authenticated: false, userCode: 'ABCD', verificationUri: 'https://device' })
      },
    })
    store.oauthLoginStart('openai-codex')
    await vi.waitFor(() => {
      expect(store.store.getSnapshot().oauth['openai-codex']?.userCode).toBe('ABCD')
    })
    expect(loginStart).toHaveBeenCalledWith({ provider: 'openai-codex', method: 'device' })
    await vi.waitFor(() => {
      expect(store.store.getSnapshot().oauth['openai-codex']?.authenticated).toBe(true)
    })
  })

  it('dedupes a second loginStart for a provider still settling', async () => {
    const { store, loginStart } = oauthStore({
      status: async () => ok({ authenticated: false }),
    })
    store.oauthLoginStart('openai-codex')
    store.oauthLoginStart('openai-codex')
    expect(loginStart).toHaveBeenCalledTimes(1)
  })

  it('oauthStatus folds a transport rejection as an error without throwing', async () => {
    const { store } = oauthStore({ status: () => Promise.reject(new Error('status down')) })
    await store.oauthStatus('openai-codex')
    expect(store.store.getSnapshot().oauth['openai-codex']).toMatchObject({
      authenticated: false, error: 'status down',
    })
  })

  it('oauthLogout records a business rejection and stays not authenticated', async () => {
    const { store } = oauthStore({ logout: async () => fail('logout refused') })
    await store.oauthLogout('openai-codex')
    expect(store.store.getSnapshot().oauth['openai-codex']).toMatchObject({
      authenticated: false, error: 'logout refused',
    })
  })

  it('oauthLogout settles a transport rejection', async () => {
    const { store } = oauthStore({ logout: () => Promise.reject(new Error('logout down')) })
    await store.oauthLogout('openai-codex')
    expect(store.store.getSnapshot().oauth['openai-codex']).toMatchObject({
      authenticated: false, error: 'logout down',
    })
  })

  it('oauthLoginStart records a login-start business rejection', async () => {
    const { store } = oauthStore({ loginStart: async () => fail('login refused') })
    store.oauthLoginStart('openai-codex')
    await vi.waitFor(() => {
      expect(store.store.getSnapshot().oauth['openai-codex']?.error).toBe('login refused')
    })
    expect(store.store.getSnapshot().oauth['openai-codex']?.authenticated).toBe(false)
  })

  it('oauthLoginStart settles a login-start transport rejection', async () => {
    const store = new ModelsSettingsStore({
      llm: {
        oauthLoginStart: () => Promise.reject(new Error('login down')),
        oauthStatus: async () => ok({ authenticated: false }),
      },
      settings: { describe: async () => ok({ writable: true, namespaces: [] }) },
      credentials: { describe: async () => ok({ credentials: {} }) },
    } as never)
    store.oauthLoginStart('openai-codex')
    await vi.waitFor(() => {
      expect(store.store.getSnapshot().oauth['openai-codex']?.error).toBe('login down')
    })
  })

  it('oauthLoginStart without browser fields covers the absent-field path and times out pending', async () => {
    // The fake never authenticates and returns no device code, so the browser
    // fields stay absent and the poll runs to its window, then clears pending.
    const { store } = oauthStore({
      status: async () => ok({ authenticated: false }),
      loginStart: async () => ok({ authenticated: false }),
    })
    store.oauthStatusIntervalMs = 5
    store.oauthStatusPollAttempts = 2
    store.oauthLoginStart('openai-codex')
    await vi.waitFor(() => {
      expect(store.store.getSnapshot().oauth['openai-codex']?.pending).toBe(false)
    })
    expect(store.store.getSnapshot().oauth['openai-codex']?.userCode).toBeUndefined()
    expect(store.store.getSnapshot().oauth['openai-codex']?.verificationUri).toBeUndefined()
    expect(store.store.getSnapshot().oauth['openai-codex']?.loginUrl).toBeUndefined()
  })

  it('startLogin poll folds a status transport rejection into an error', async () => {
    let attempts = 0
    const { store } = oauthStore({
      loginStart: async () => ok({ authenticated: false, userCode: 'ABCD' }),
      status: async () => {
        attempts += 1
        return attempts === 1 ? ok({ authenticated: false }) : Promise.reject(new Error('status poll down'))
      },
    })
    store.oauthStatusIntervalMs = 5
    store.oauthStatusPollAttempts = 5
    store.oauthLoginStart('openai-codex')
    await vi.waitFor(() => {
      expect(store.store.getSnapshot().oauth['openai-codex']?.error).toBe('status poll down')
    })
  })

  it('oauthLoginStart with a browser authorization url covers the loginUrl branch and flips authenticated', async () => {
    // The fake authenticates once the login starts and the start replies with
    // only a browser authorization URL, so the loginUrl field renders and the
    // status poll reports the landing.
    let landed = false
    const { store } = oauthStore({
      status: async () => ok({ authenticated: landed }),
      loginStart: async () => {
        landed = true
        return ok({ authenticated: false, loginUrl: 'https://auth.example/start' })
      },
    })
    store.oauthStatusIntervalMs = 5
    store.oauthStatusPollAttempts = 20
    store.oauthLoginStart('openai-codex')
    await vi.waitFor(() => {
      expect(store.store.getSnapshot().oauth['openai-codex']?.loginUrl).toBe('https://auth.example/start')
    })
    await vi.waitFor(() => {
      expect(store.store.getSnapshot().oauth['openai-codex']?.authenticated).toBe(true)
    })
  })

  it('startLogin poll folds a status business rejection into an error', async () => {
    const { store } = oauthStore({
      loginStart: async () => ok({ authenticated: false, userCode: 'ABCD' }),
      status: async () => fail('poll refused'),
    })
    store.oauthStatusIntervalMs = 5
    store.oauthStatusPollAttempts = 5
    store.oauthLoginStart('openai-codex')
    await vi.waitFor(() => {
      expect(store.store.getSnapshot().oauth['openai-codex']?.error).toBe('poll refused')
    })
  })
})
