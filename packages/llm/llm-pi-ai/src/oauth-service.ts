/**
 * The `llmOauth` service: a Cordis service exposing the pi-ai OAuth commands
 * (`/llm-login`, `/llm-logout`, `/llm-auth`) as a programmatic surface for the
 * host RPC layer. Login runs the device-code (or browser) flow to completion as
 * a background task and returns the one-time code / verification URL captured
 * immediately, so a caller can show them while the flow polls for the user's
 * authorization. Status reflects whatever the durable pi-ai credential store
 * holds, so a caller re-queries it to learn when the background login landed.
 *
 * Only providers the installed catalog offers OAuth for (`openai-codex` is the
 * one shipped) are accepted; anything else fails loud rather than pretending an
 * unsupported route can log in.
 *
 * @module dsh-llm-pi-ai/oauth-service
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { AuthEvent } from '@earendil-works/pi-ai'
import type { PiAiAdapter } from './adapter.ts'
import { catalogProviderOffersOAuth } from './catalog.ts'
import { CommandInteraction } from './interaction.ts'
import type { LoginMethod } from './interaction.ts'

/** Cap on how long {@link LlmOauth.login} waits for the flow's first event. */
const LOGIN_EVENT_WAIT_MS = 5_000

/** The auth fields a login start returns to show the user. */
export interface OauthLoginStart {
  /** Authorization URL of the browser flow, when the flow opened one. */
  loginUrl?: string
  /** One-time code of the device-code flow, when the flow issued one. */
  userCode?: string
  /** Verification URL the user opens to enter {@link OauthLoginStart.userCode}. */
  verificationUri?: string
  /** Whether the credential was already persisted by the time login returned. */
  authenticated: boolean
}

/** The authentication state of one provider route. */
export interface OauthStatus {
  /** Whether a durable credential is currently stored for the route. */
  authenticated: boolean
  /** The stored auth method, present once authenticated; OAuth is the only supported one. */
  type?: 'oauth'
}

/**
 * The `llmOauth` service. One instance owns the login in-flight guard, so two
 * concurrent `login` calls for the same provider cannot both run a flow.
 */
export class LlmOauth extends Service {
  /** Background login runs, keyed by provider, settled (success or failure) to remove themselves. */
  private readonly running = new Map<string, Promise<void>>()

  /**
   * @param ctx - the Cordis context the service registers on.
   * @param adapter - the pi-ai adapter the login/logout/status operations run through.
   */
  constructor(ctx: Context, private readonly adapter: PiAiAdapter) {
    super(ctx, 'llmOauth')
  }

  /** Refuse a route the catalog does not authenticate through OAuth. */
  private assertSupported(provider: string): void {
    if (!catalogProviderOffersOAuth(provider)) {
      throw new Error(`llmOauth: provider "${provider}" does not offer an OAuth login method`)
    }
  }

  /**
   * Whether one provider route currently has a stored credential.
   * @param provider - the provider route to inspect.
   * @returns the route's auth state.
   */
  async status(provider: string): Promise<OauthStatus> {
    this.assertSupported(provider)
    const check = await this.adapter.authStatus(provider)
    if (check === undefined || check.type !== 'oauth') return { authenticated: false }
    return { authenticated: true, type: 'oauth' }
  }

  /**
   * Remove any stored credential for one provider route (logout).
   * @param provider - the provider route to forget.
   */
  async logout(provider: string): Promise<void> {
    this.assertSupported(provider)
    await this.adapter.logout(provider)
  }

  /**
   * Start (or answer for) an OAuth login for one provider. The flow runs to
   * completion as a background task; this returns as soon as the flow has
   * issued its first device code or authorization URL, which is what the caller
   * shows the user. `status` reports authenticated once the background flow
   * persists the credential.
   * @param provider - the provider route to authenticate.
   * @param method - the login method to answer the flow's method select with.
   * @returns the device-code / browser fields to present, before login settled.
   */
  async login(provider: string, method: LoginMethod = 'device'): Promise<OauthLoginStart> {
    this.assertSupported(provider)
    if (this.running.has(provider)) {
      throw new Error(`llmOauth: a login for "${provider}" is already running; wait for it or log out first`)
    }
    // Capture the interaction BEFORE the flow starts so its `notify` events are
    // buffered from the first tick and readable here immediately.
    const interaction = new CommandInteraction({ method })
    const run = this.adapter.login(provider, 'oauth', interaction)
    this.running.set(provider, run)
    void run.finally(() => { this.running.delete(provider) })
    // The device-code flow emits its one-time code almost immediately; the
    // browser flow emits its authorization URL the same way. Wait for the first
    // of them so login returns what the caller should show, even though the
    // flow itself keeps running in the background.
    const deadline = Date.now() + LOGIN_EVENT_WAIT_MS
    while (Date.now() < deadline) {
      const fields = this.fieldsOf(interaction.events())
      if (fields !== undefined) return { ...fields, authenticated: false }
      await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
    }
    // A flow that returned neither event within the window still handed its
    // interaction back; answer with nothing captured (the caller shows the
    // status line alone).
    return { authenticated: false }
  }

  /** The public fields of the latest device-code / auth-url event, when one exists. */
  private fieldsOf(events: readonly AuthEvent[]): Pick<OauthLoginStart, 'loginUrl' | 'userCode' | 'verificationUri'> | undefined {
    for (const event of events) {
      if (event.type === 'device_code') return { userCode: event.userCode, verificationUri: event.verificationUri }
      if (event.type === 'auth_url') return { loginUrl: event.url }
    }
    return undefined
  }

  /** Whether a login for one provider is currently running in the background. */
  loginRunning(provider: string): boolean {
    return this.running.has(provider)
  }
}
