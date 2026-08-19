/**
 * Models settings page store: one snapshot joining the configurable-provider
 * directory (`llm.providers`), the settings namespaces (`settings.describe`),
 * and the referenced credentials (`credentials.describe`). The host stays the
 * single fact source — every mutation writes through the wire and the page
 * re-renders from the next describe, pushed or refetched.
 */

import type {
  ConfigurableProviderView, CredentialView, IApiClient, SettingsNamespaceView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { getPath, hasPath, nodeAtPath, rehydrateSchema } from '@deepseek-ai/dsh-client-schema-form'

/**
 * Any route key walks a dict schema to the same profile node, so the lookup
 * names one that cannot collide with a configured route.
 */
const PROBE_ROUTE = '\u0000probe'

/** One provider row the page renders. */
export interface ProviderRow {
  /** The directory entry (route id, display name, settings address, live state). */
  entry: ConfigurableProviderView
  /** Whether any layer configures this provider (its profile resolves). */
  configured: boolean
  /** Whether the user layer alone carries the profile (removal restores the base). */
  removable: boolean
  /** The credential reference the resolved profile names, when one does. */
  apiKeyEnv: string | undefined
  /** Credential state for {@link apiKeyEnv}, once described. */
  credential: CredentialView | undefined
}

/** Page snapshot. */
export interface ModelsSettingsState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Whole-load failure text; row-level write failures stay in the editor. */
  error: string | null
  /** Credential enrichment failure; provider/settings rows remain usable. */
  credentialError: string | null
  /** Whether the settings provider accepts writes. */
  writable: boolean
  /** Every configurable provider joined with its configured/credential state. */
  rows: readonly ProviderRow[]
  /** Namespace views by ns, for the editor's schema/layers/secrets. */
  namespaces: ReadonlyMap<string, SettingsNamespaceView>
  /** Per-provider OAuth state, keyed by provider route (populated lazily on the first OAuth action). */
  oauth: Readonly<Record<string, OauthProviderState>>
}

/**
 * Live OAuth state of one provider route, as projected from the last OAuth
 * operation. Only providers the client treats as OAuth-native populate a row.
 */
export interface OauthProviderState {
  /** Whether a durable OAuth credential is currently stored for the route. */
  authenticated: boolean
  /** Whether a login flow is known to be running in the background. */
  pending?: boolean
  /** One-time code of the last device-code login start, to show the user. */
  userCode?: string
  /** Verification URL the user opens to enter {@link OauthProviderState.userCode}. */
  verificationUri?: string
  /** Authorization URL of the last browser-flow login start, to show the user. */
  loginUrl?: string
  /** Failure text of the last OAuth operation. */
  error?: string
}

/**
 * The one provider route this adapter family authenticates through OAuth. The
 * server directory does not expose the flag, so the client derives it from the
 * route id — see the adapter's own `catalogProviderOffersOAuth`.
 */
export const OAUTH_NATIVE_PROVIDER = 'openai-codex'

/**
 * Whether a provider route is OAuth-native (its editor shows the OAuth login
 * control beside the api-key field). The directory exposes no capability flag,
 * so this is a client-side constant matching the adapter's OAuth catalog.
 * @param provider - provider route id.
 * @returns whether the route authenticates through OAuth.
 */
export function isOauthNative(provider: string): boolean {
  return provider === OAUTH_NATIVE_PROVIDER
}

/**
 * Human text for a rejected wire call. A transport failure rejects with an
 * Error; a host or a runtime can reject with anything, and the page still has
 * to say something.
 * @param error - the rejection value.
 * @returns the message to show.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Derive the conventional credential reference for a provider route: the v1
 * page never asks for an environment-variable name, so a typed key stores
 * under this derived reference and the profile records it as `apiKeyEnv`.
 * @param provider - provider route id (e.g. `anthropic`, `minimax-cn`).
 * @returns the derived reference name (e.g. `MINIMAX_CN_API_KEY`).
 */
export function deriveKeyRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

/**
 * The wire protocols a hand-declared route may name, read out of the owning
 * namespace's own schema. This stays a schema read rather than a wire field so
 * the choices the page offers cannot drift from the ones the adapter accepts:
 * both come from the same `Config`.
 * @param namespace - the namespace view whose schema declares the profile shape.
 * @returns the protocol identifiers, or an empty list when the schema has none.
 */
export function protocolChoices(namespace: SettingsNamespaceView | undefined): string[] {
  if (namespace === undefined) return []
  const node = nodeAtPath(rehydrateSchema(namespace.schema), ['providers', PROBE_ROUTE, 'api'])
  const list = (node as { type?: string; list?: readonly { value?: unknown }[] } | undefined)
  if (list?.type !== 'union' || list.list === undefined) return []
  return list.list.map(entry => entry.value).filter((value): value is string => typeof value === 'string')
}

/** The credential reference a resolved profile names (its `apiKeyEnv` field). */
function apiKeyEnvOf(namespace: SettingsNamespaceView | undefined, path: readonly string[]): string | undefined {
  if (namespace === undefined) return undefined
  const profile = getPath(namespace.value, path)
  if (typeof profile !== 'object' || profile === null) return undefined
  const ref = (profile as { apiKeyEnv?: unknown }).apiKeyEnv
  return typeof ref === 'string' && ref.length > 0 ? ref : undefined
}

/** The models settings page controller (one per settings surface). */
export class ModelsSettingsStore {
  /** The snapshot the section renders from (uSES-safe store). */
  readonly store: SnapshotStore<ModelsSettingsState> = createSnapshotStore<ModelsSettingsState>({
    status: 'idle', error: null, credentialError: null, writable: false, rows: [], namespaces: new Map(), oauth: {},
  })

  /** Latest load wins; an older response never overwrites a newer one. */
  private generation = 0
  /** Per-provider in-flight login status poll, so loginStart never starts two. */
  private readonly oauthPolls = new Map<string, Promise<void>>()
  /** Delay between login status polls (overridable for deterministic tests). */
  oauthStatusIntervalMs = 300
  /** How many status polls a login start watches before giving up. */
  oauthStatusPollAttempts = 20

  /**
   * @param api - the wire face (settings/credentials/llm domains).
   */
  constructor(private readonly api: Pick<IApiClient, 'settings' | 'credentials' | 'llm'>) {}

  /**
   * Refresh the whole page snapshot: directory and namespaces in parallel,
   * then one batched credential describe over every referenced ref. A
   * failure keeps the last good rows and surfaces the error.
   * @returns nothing; the snapshot carries the outcome.
   */
  async load(): Promise<void> {
    const generation = ++this.generation
    this.store.update((s) => { s.status = 'loading'; s.error = null })
    let providers: ConfigurableProviderView[]
    let writable: boolean
    let views: SettingsNamespaceView[]
    try {
      const [providersResponse, settingsResponse] = await Promise.all([
        this.api.llm.providers({}),
        this.api.settings.describe({}),
      ])
      if (!providersResponse.result.ok) throw new Error(providersResponse.result.error.message)
      if (!settingsResponse.result.ok) throw new Error(settingsResponse.result.error.message)
      providers = providersResponse.result.value.providers
      writable = settingsResponse.result.value.writable
      views = settingsResponse.result.value.namespaces
    } catch (error) {
      if (generation !== this.generation) return
      this.store.update((s) => {
        s.status = 'error'
        s.error = error instanceof Error ? error.message : String(error)
      })
      return
    }
    const namespaces = new Map(views.map(view => [view.ns, view]))
    const rows: ProviderRow[] = providers.map((entry) => {
      const namespace = namespaces.get(entry.settingsNs)
      const configured = namespace !== undefined
        && (entry.settingsPath.length === 0 || getPath(namespace.value, entry.settingsPath) !== undefined)
      const removable = namespace !== undefined
        && entry.settingsPath.length > 0
        && hasPath(namespace.user, entry.settingsPath)
        && !hasPath(namespace.base, entry.settingsPath)
      return {
        entry,
        configured,
        removable,
        apiKeyEnv: apiKeyEnvOf(namespace, entry.settingsPath),
        credential: undefined,
      }
    })
    const refs = [...new Set(rows.flatMap(row => row.apiKeyEnv === undefined ? [] : [row.apiKeyEnv]))]
    let credentials: Record<string, CredentialView> = {}
    let credentialError: string | null = null
    if (refs.length > 0) {
      try {
        const response = await this.api.credentials.describe({ refs })
        // Credential state is an enrichment for the Models page: neither a
        // business rejection nor a transport failure fails the load. The
        // onboarding projection below retains the failure distinction.
        if (response.result.ok) credentials = response.result.value.credentials
        else credentialError = response.result.error.message
      } catch (error) {
        credentialError = messageOf(error)
      }
    }
    if (generation !== this.generation) return
    this.store.update((s) => {
      s.status = 'ready'
      s.error = null
      s.credentialError = credentialError
      s.writable = writable
      s.rows = rows.map(row => ({
        ...row,
        ...row.apiKeyEnv !== undefined && credentials[row.apiKeyEnv] !== undefined
          ? { credential: credentials[row.apiKeyEnv] }
          : {},
      }))
      s.namespaces = namespaces
    })
  }

  /** Project one stored OAuth state into the snapshot for a provider. */
  private setOauth(provider: string, patch: Partial<OauthProviderState>): void {
    this.store.update((s) => {
      const prior = s.oauth[provider] ?? { authenticated: false }
      // Every patch merges over the current row, so a status poll or logout
      // never erases the device-code/login fields the card is still showing;
      // `authenticated` is resolved to a definite value because it is required
      // on the row while `patch` may leave it unset.
      const merged: OauthProviderState = {
        ...prior,
        ...patch,
        authenticated: 'authenticated' in patch ? patch.authenticated ?? false : prior.authenticated,
      }
      s.oauth = { ...s.oauth, [provider]: merged }
    })
  }

  /** Fetch one provider's OAuth status and fold it into the snapshot. */
  private async refreshOauthStatus(provider: string): Promise<void> {
    try {
      const response = await this.api.llm.oauthStatus({ provider })
      if (!response.result.ok) {
        this.setOauth(provider, { authenticated: false, error: response.result.error.message })
        return
      }
      const value = response.result.value
      this.setOauth(provider, { authenticated: value.authenticated })
    } catch (error) {
      // A transport failure must not surface as an unhandled rejection; the card
      // shows the failure instead and stays usable.
      this.setOauth(provider, { authenticated: false, error: messageOf(error) })
    }
  }

  /**
   * Refresh one provider's OAuth status. Callers render the `oauth` snapshot
   * row to show whether the user is currently logged in.
   * @param provider - the provider route to inspect.
   */
  async oauthStatus(provider: string): Promise<void> {
    await this.refreshOauthStatus(provider)
  }

  /**
   * Log out one provider route: forget its stored OAuth credential and fold the
   * cleared status into the snapshot.
   * @param provider - the provider route to logout.
   */
  async oauthLogout(provider: string): Promise<void> {
    try {
      const response = await this.api.llm.oauthLogout({ provider })
      if (!response.result.ok) {
        this.setOauth(provider, { authenticated: false, error: response.result.error.message })
        return
      }
      this.setOauth(provider, { authenticated: false })
    } catch (error) {
      this.setOauth(provider, { authenticated: false, error: messageOf(error) })
    }
  }

  /**
   * Start an OAuth login for one provider route (device flow by default). The
   * returned one-time code / verification URL is folded into the snapshot for
   * the card to show, and the background flow is polled until it persists the
   * credential or gives up, so the status line flips to "logged in" on its own.
   * @param provider - the provider route to authenticate.
   * @param method - the login method to request (`device` default).
   */
  oauthLoginStart(provider: string, method: 'browser' | 'device' = 'device'): void {
    const inFlight = this.oauthPolls.get(provider)
    if (inFlight !== undefined) return
    const run = this.startLogin(provider, method).finally(() => { this.oauthPolls.delete(provider) })
    this.oauthPolls.set(provider, run)
  }

  /** The single login-start+poll run; shared so double-starts are deduped. */
  private async startLogin(provider: string, method: 'browser' | 'device'): Promise<void> {
    try {
      const response = await this.api.llm.oauthLoginStart({ provider, method })
      if (!response.result.ok) {
        this.setOauth(provider, { authenticated: false, error: response.result.error.message })
        return
      }
      const start = response.result.value
      this.setOauth(provider, {
        authenticated: false,
        pending: true,
        ...start.loginUrl === undefined ? {} : { loginUrl: start.loginUrl },
        ...start.userCode === undefined ? {} : { userCode: start.userCode },
        ...start.verificationUri === undefined ? {} : { verificationUri: start.verificationUri },
      })
      this.oauthLoginDeadline = Date.now() + this.oauthStatusPollAttempts * this.oauthStatusIntervalMs
      // Poll the status until the background flow persists the credential. The
      // first check runs immediately so an already-landed login reads through.
      await this.oauthCheck(provider)
      let attempt = 0
      while (attempt < this.oauthStatusPollAttempts) {
        const row = this.store.getSnapshot().oauth[provider]
        if (row?.authenticated === true) return
        if (Date.now() >= this.oauthLoginDeadline) break
        attempt += 1
        await new Promise<void>((resolve) => { setTimeout(resolve, this.oauthStatusIntervalMs) })
        await this.oauthCheck(provider)
      }
      // The flow did not settle within the window; leave the card showing the
      // device code and "not logged in", ready to be re-checked.
      this.setOauth(provider, { pending: false })
    } catch (error) {
      this.setOauth(provider, { authenticated: false, error: messageOf(error) })
    }
  }

  /** One status read in the login poll, folding the result and error into the snapshot. */
  private async oauthCheck(provider: string): Promise<void> {
    try {
      const current = await this.api.llm.oauthStatus({ provider })
      if (!current.result.ok) {
        this.setOauth(provider, { authenticated: false, error: current.result.error.message })
        return
      }
      if (current.result.value.authenticated) this.setOauth(provider, { authenticated: true, pending: false })
    } catch (error) {
      this.setOauth(provider, { authenticated: false, error: messageOf(error) })
    }
  }

  /** Deadline stored per login run so the poll has a wall-clock cap. */
  private oauthLoginDeadline = 0
}

/**
 * Whether a joined row can serve model requests as it stands: the route is
 * registered with the adapter registry, and whatever credential its resolved
 * profile names is stored. A profile naming no reference authenticates through
 * the provider's own path (the Bedrock chain, Vertex ADC, a gateway that needs
 * nothing), as does a live route with no settings address at all, so neither
 * owes this page a key.
 * @param row - one joined provider row.
 * @returns whether the user already has this provider to talk to.
 */
export function providerUsable(row: ProviderRow): boolean {
  if (!row.entry.active) return false
  if (row.apiKeyEnv === undefined) return true
  return row.credential?.configured === true
}

/** First-run onboarding readiness derived only from the shared Models join. */
export type OnboardingReadiness =
  | { kind: 'loading' }
  | { kind: 'adapter-absent' }
  | { kind: 'provider-ready' }
  | { kind: 'credential-missing' }
  | {
    kind: 'unavailable'
    reason:
      | 'load-failed'
      | 'provider-inactive'
      | 'credentials-unavailable'
      | 'settings-read-only'
      | 'credential-read-only'
  }

/**
 * Project first-run readiness from the provider/settings/credential join used
 * by the Models page. The step exists to leave the user with a model to talk
 * to, so ANY usable provider ends it; only when none exists does the official
 * DeepSeek route — the one route the prompt can offer a key field for — decide
 * whether prompting can help. A missing official configurable-provider
 * declaration means the adapter is not repairable by navigating to Models.
 * @param state - current shared Models join snapshot.
 * @returns the onboarding state without reading a parallel fact source.
 */
export function onboardingReadiness(state: ModelsSettingsState): OnboardingReadiness {
  if ((state.status === 'idle' || state.status === 'loading') && state.rows.length === 0) {
    return { kind: 'loading' }
  }
  if (state.status === 'error') {
    return {
      kind: 'unavailable',
      reason: 'load-failed',
    }
  }
  if (state.rows.some(providerUsable)) return { kind: 'provider-ready' }
  const row = state.rows.find(candidate =>
    candidate.entry.provider === 'deepseek-official'
    && candidate.entry.settingsNs === 'llm-deepseek'
    && candidate.entry.settingsPath.length === 0)
  if (row === undefined) return { kind: 'adapter-absent' }
  if (!row.entry.active) {
    return {
      kind: 'unavailable',
      reason: 'provider-inactive',
    }
  }
  // Past the usable gate an active route names a reference it has no stored
  // credential for, so the remaining questions are all about that credential.
  if (state.credentialError !== null || row.credential === undefined) {
    return {
      kind: 'unavailable',
      reason: 'credentials-unavailable',
    }
  }
  if (!state.writable) {
    return {
      kind: 'unavailable',
      reason: 'settings-read-only',
    }
  }
  if (!row.credential.writable) {
    return {
      kind: 'unavailable',
      reason: 'credential-read-only',
    }
  }
  return { kind: 'credential-missing' }
}
