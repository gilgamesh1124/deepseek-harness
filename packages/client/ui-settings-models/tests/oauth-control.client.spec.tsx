// @vitest-environment jsdom
/** The OAuth login/logout control rendered beside the api-key field for the OAuth-native provider. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import type { RpcResponse, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { ProviderEditor } from '../src/client/ProviderEditor.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

let nextRpc = 0
function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: `r-${nextRpc++}` as never, result: { ok: true, value } }
}

/** The pi-ai namespace profile shape the catalog route resolves in. */
const PiAiConfig = Schema.object({
  providers: Schema.dict(Schema.object({
    apiKeyEnv: Schema.string().role('credential-ref'),
    baseURL: Schema.string(),
  })),
})

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

function face() {
  return {
    credentials: {
      describe: vi.fn(async () => ok({ credentials: {} })),
      set: vi.fn(),
    },
    settings: { describe: vi.fn(), mutate: vi.fn() },
    llm: { providers: vi.fn(), models: vi.fn(), discoverModels: vi.fn() },
  }
}

function renderCodex(oauthState: Parameters<typeof ProviderEditor>[0]['oauthState'], oauthActions: Parameters<typeof ProviderEditor>[0]['oauthActions']) {
  render(
    <ProviderEditor
      provider="openai-codex"
      displayName="openai-codex"
      namespace={codexNamespace()}
      settingsPath={['providers', 'openai-codex']}
      api={face() as never}
      t={key => en[key]}
      readOnly={false}
      oauthState={oauthState}
      oauthActions={oauthActions}
      onClose={vi.fn()}
    />,
  )
}

describe('ProviderEditor OAuth control', () => {
  it('renders the OAuth login controls for the Codex route alongside the key field', () => {
    renderCodex(undefined, {
      oauthStatus: vi.fn(), oauthLogout: vi.fn(), oauthLoginStart: vi.fn(),
    })
    expect(screen.getByText(en.keyInput)).toBeTruthy()
    // Not logged in by default, with a 登录 button.
    expect(screen.getByText(en.oauthLoggedOut)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.oauthLogin })).toBeTruthy()
  })

  it('starts a device login and shows the returned verification URL and code while pending', () => {
    const oauthLoginStart = vi.fn()
    renderCodex({
      authenticated: false, pending: true, userCode: 'ABCD-1234', verificationUri: 'https://auth.example/device',
    }, { oauthStatus: vi.fn(), oauthLogout: vi.fn(), oauthLoginStart })

    // The pending state keeps the login button busy and reveals the code.
    expect(screen.getByText('ABCD-1234')).toBeTruthy()
    expect(screen.getByText(/https:\/\/auth\.example\/device/)).toBeTruthy()
    const busyButton = screen.getByRole('button', { name: en.oauthStarting })
    expect((busyButton as HTMLButtonElement).disabled).toBe(true)
  })

  it('calls oauthLoginStart with the device method when logged-out and no login is pending', () => {
    const oauthLoginStart = vi.fn()
    renderCodex({ authenticated: false }, { oauthStatus: vi.fn(), oauthLogout: vi.fn(), oauthLoginStart })
    fireEvent.click(screen.getByRole('button', { name: en.oauthLogin }))
    expect(oauthLoginStart).toHaveBeenCalledWith('openai-codex', 'device')
  })

  it('shows the browser authorization URL when the pending login returned only that', () => {
    renderCodex({
      authenticated: false, pending: true, loginUrl: 'https://auth.example/start',
    }, { oauthStatus: vi.fn(), oauthLogout: vi.fn(), oauthLoginStart: vi.fn() })
    expect(screen.getByText(en.oauthOpenUrl)).toBeTruthy()
    const link = screen.getByRole('link', { name: en.oauthOpenUrl })
    expect(link.getAttribute('href')).toBe('https://auth.example/start')
    // No device code or verification URL were returned, so neither renders.
    expect(screen.queryByText(en.oauthOpenVerification)).toBeNull()
    expect(screen.queryByText(en.oauthEnterCode)).toBeNull()
  })

  it('shows logged-in with a logout button once authenticated, and logs out on click', () => {
    const oauthLogout = vi.fn()
    renderCodex({ authenticated: true }, { oauthStatus: vi.fn(), oauthLogout, oauthLoginStart: vi.fn() })
    expect(screen.getByText(en.oauthLoggedIn)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.oauthLogout }))
    expect(oauthLogout).toHaveBeenCalledWith('openai-codex')
  })

  it('surfaces an OAuth operation failure text', () => {
    renderCodex({ authenticated: false, error: 'login failed' }, {
      oauthStatus: vi.fn(), oauthLogout: vi.fn(), oauthLoginStart: vi.fn(),
    })
    expect(screen.getByText('login failed')).toBeTruthy()
  })
})
