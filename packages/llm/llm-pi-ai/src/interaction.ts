/**
 * A pi-ai `AuthInteraction` adapted to the human-command surface. Login
 * presents either the headless **device-code** flow (the command prints a one
 * time code and a verification URL, then polls until the user authorizes in a
 * browser) or the **browser** flow (the command prints the authorization URL
 * and takes the pasted code back from the caller). Every `notify` event the
 * flow emits is captured so the caller can render it, and every `prompt` is
 * answered from the caller-supplied answers — never from a stream this surface
 * does not own.
 *
 * @module dsh-llm-pi-ai/interaction
 */

import type { AuthEvent, AuthInteraction, AuthPrompt } from '@earendil-works/pi-ai'

/** Login method a `CommandInteraction` is told to answer the flow's method select with. */
export type LoginMethod = 'browser' | 'device'

/** Caller-supplied answers for a login run; prompts without an answer reject the login. */
export interface LoginAnswers {
  /** Method the flow's `select` prompt resolves to; default `device`. */
  method?: LoginMethod
  /** Value returned for a `manual_code` prompt (the browser flow's pasted authorization code). */
  manualCode?: string
}

/** Answer one prompt from the caller's answers, or reject a prompt that has no answer. */
function answerPrompt(name: 'method' | 'manualCode', answers: LoginAnswers, source: string): string {
  const value = name === 'method' ? answers.method : answers.manualCode
  if (value === undefined) {
    throw new Error(`llm-pi-ai login wanted a "${name}" answer that the command did not supply (${source})`)
  }
  return value
}

/** Resolve one prompt answer to a settled promise, so a missing answer rejects rather than throws. */
function answered(name: 'method' | 'manualCode', answers: LoginAnswers, source: string): Promise<string> {
  try {
    return Promise.resolve(answerPrompt(name, answers, source))
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)))
  }
}

/**
 * Command-backed login interaction.
 *
 * `notify` appends every flow event to a buffer the caller reads with
 * {@link events} after the run; `prompt` answers the method select from
 * {@link LoginAnswers.method} and a manual-code paste (browser flow) from
 * {@link LoginAnswers.manualCode}. Anything else is refused by throwing, so a
 * flow that needs data this command cannot collect fails loudly at the prompt
 * instead of hanging the run.
 */
export class CommandInteraction implements AuthInteraction {
  private readonly buffer: AuthEvent[] = []

  constructor(
    private readonly answers: LoginAnswers = {},
    private readonly source = 'the llm login command',
  ) {}

  notify(event: AuthEvent): void {
    this.buffer.push(event)
  }

  prompt(prompt: AuthPrompt): Promise<string> {
    if (prompt.type === 'select') return answered('method', this.answers, this.source)
    if (prompt.type === 'manual_code') return answered('manualCode', this.answers, this.source)
    // The remaining prompt types (text, secret) ask for data this channel
    // cannot collect; refusing here fails the login loudly instead of hanging.
    return Promise.reject(new Error(
      `llm-pi-ai login asked for ${prompt.type} input ("${prompt.message}"), which the command channel`
      + ' cannot collect; supply it through the browser or device-code flow instead',
    ))
  }

  /** The flow events emitted so far, in order, for the caller to render. */
  events(): readonly AuthEvent[] {
    return this.buffer
  }
}

/** Human-readable instruction for a captured device-code event, or nothing. */
export function deviceCodeInstructions(event: AuthEvent): string | undefined {
  return event.type === 'device_code'
    ? `Open ${event.verificationUri} and enter code ${event.userCode} (valid ${event.expiresInSeconds ?? 900}s).`
    : undefined
}

/** Human-readable heading for a captured authorization-URL event, or nothing. */
export function authUrlInstructions(event: AuthEvent): string | undefined {
  return event.type === 'auth_url' ? `Open ${event.url} to authorize login.` : undefined
}
