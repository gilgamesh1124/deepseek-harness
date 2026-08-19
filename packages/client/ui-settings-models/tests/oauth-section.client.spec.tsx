// @vitest-environment jsdom
/** The OAuth control end-to-end through the Models section: an OAuth-native
 *  (openai-codex) row opens an editor whose login/logout buttons drive the
 *  store, whose poll flips the status line to logged-in. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import type { RpcResponse, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { ModelsSection } from '../src/client/ModelsSection.tsx'
import type { ModelsSectionInjected } from '../src/client/ModelsSection.tsx'
import { ModelsSettingsStore } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t: ModelsSectionInjected['t'] = key => en[key]

let nextRpc = 0
function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: `r-${nextRpc++}` as never, result: { ok: true, value } }
}

const PiAiConfig = Schema.object({
  providers: Schema.dict(Schema.object({
    apiKeyEnv: Schema.string().role('credential-ref'),
    baseURL: Schema.string(),
  })),
})

/** The pi-ai namespace with the OAuth-native Codex route configured. */
function codexNamespace(): SettingsNamespaceView {
  return {
    ns: 'llm-pi-ai',
    schema: JSON.parse(JSON.stringify(PiAiConfig.toJSON())) as unknown,
    value: { providers: { 'openai-codex': {} } },
    base: { providers: {} },
    user: { providers: { 'openai-codex': {} } },
    applies: 'live',
    secrets: [],
    revision: 1,
  }
}

async function mountSection(
  oauth: {
    oauthStatus?: ReturnType<typeof vi.fn>
    oauthLogout?: ReturnType<typeof vi.fn>
    oauthLoginStart?: ReturnType<typeof vi.fn>
  } = {},
) {
  const namespace = codexNamespace()
  const oauthStatus = oauth.oauthStatus ?? vi.fn(async () => ok({ authenticated: false }))
  const oauthLogout = oauth.oauthLogout ?? vi.fn(async () => ok({}))
  const oauthLoginStart = oauth.oauthLoginStart ?? vi.fn(async () => ok({ authenticated: false, userCode: 'ABCD', verificationUri: 'https://device' }))
  const face = {
    llm: {
      providers: vi.fn(() => Promise.resolve(ok({
        providers: [{
          provider: 'openai-codex', displayName: 'openai-codex',
          settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai-codex'], active: true, declared: false,
        }],
      }))),
      models: vi.fn(() => Promise.resolve(ok({ groups: [], failures: [] }))),
      discoverModels: vi.fn(),
      oauthStatus,
      oauthLogout,
      oauthLoginStart,
    },
    settings: {
      describe: vi.fn(() => Promise.resolve(ok({ writable: true, namespaces: [namespace] }))),
      update: vi.fn(),
      replace: vi.fn(),
      mutate: vi.fn(),
    },
    credentials: {
      describe: vi.fn(() => Promise.resolve(ok({ credentials: {} }))),
      set: vi.fn(),
      unset: vi.fn(),
    },
  }
  const controller = new ModelsSettingsStore(face as never)
  // Fast, deterministic login poll for the section-level flow.
  controller.oauthStatusIntervalMs = 5
  controller.oauthStatusPollAttempts = 20
  const injected: ModelsSectionInjected = {
    controller,
    useSnapshot: bindSnapshotSelector(controller.store),
    api: face as never,
    t,
  }
  await controller.load()
  render(<ModelsSection {...injected} />)
  return { controller, oauthStatus, oauthLogout, oauthLoginStart }
}

/** Open the Codex row's editor. */
function openCodexEditor(): void {
  const row = screen.getByText('openai-codex').closest('li')
  if (row === null) throw new Error('no codex row')
  fireEvent.click([...row.querySelectorAll('button')].find(button => button.textContent === en.edit) as HTMLButtonElement)
}

describe('Models section OAuth flow', () => {
  it('opens the OAuth control for the Codex row and starts a login through the store', async () => {
    const { oauthLoginStart } = await mountSection()
    openCodexEditor()

    // The editor shows the not-logged-in control and a login button.
    expect(screen.getByText(en.oauthLoggedOut)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.oauthLogin }))

    // The button's action runs through the section's oauthActions wrapper into
    // the store, which calls the wire.
    await waitFor(() => { expect(oauthLoginStart).toHaveBeenCalled() })
    expect(oauthLoginStart).toHaveBeenCalledWith({ provider: 'openai-codex', method: 'device' })
  })

  it('flips to logged-in once the store poll sees the credential land', async () => {
    // The status answers authenticated only after a login starts, so the store
    // poll picks the landing up and the status line reads logged-in.
    let landed = false
    const oauthStatus = vi.fn(async () => ok({ authenticated: landed }))
    const oauthLoginStart = vi.fn(async () => {
      landed = true
      return ok({ authenticated: false, userCode: 'ABCD', verificationUri: 'https://device' })
    })
    await mountSection({ oauthStatus, oauthLoginStart })
    openCodexEditor()

    fireEvent.click(screen.getByRole('button', { name: en.oauthLogin }))

    await waitFor(() => { expect(screen.getByText(en.oauthLoggedIn)).toBeTruthy() })
    expect(screen.getByRole('button', { name: en.oauthLogout })).toBeTruthy()
  })

  it('logs out through the section wrapper', async () => {
    const { oauthStatus, oauthLogout } = await mountSection({
      oauthStatus: vi.fn(async () => ok({ authenticated: true })),
    })
    openCodexEditor()
    // The editor primes status on open, which reports logged-in.
    await waitFor(() => { expect(oauthStatus).toHaveBeenCalled() })
    await waitFor(() => { expect(screen.getByText(en.oauthLoggedIn)).toBeTruthy() })

    fireEvent.click(screen.getByRole('button', { name: en.oauthLogout }))
    await waitFor(() => { expect(oauthLogout).toHaveBeenCalled() })
    expect(oauthLogout).toHaveBeenCalledWith({ provider: 'openai-codex' })
    void oauthStatus
  })
})
