import { describe, expect, it } from 'vitest'
import { authUrlInstructions, CommandInteraction, deviceCodeInstructions } from '../src/interaction.ts'

describe('CommandInteraction', () => {
  it('answers the method select from the caller answers', async () => {
    const interaction = new CommandInteraction({ method: 'device' })
    await expect(interaction.prompt({ type: 'select', message: 'method?', options: [] })).resolves.toBe('device')
  })

  it('answers a manual_code prompt from the pasted code', async () => {
    const interaction = new CommandInteraction({ method: 'browser', manualCode: 'the-code' })
    await expect(interaction.prompt({ type: 'manual_code', message: 'paste code' })).resolves.toBe('the-code')
  })

  it('rejects a select with no answer', async () => {
    const interaction = new CommandInteraction()
    await expect(interaction.prompt({ type: 'select', message: 'method?', options: [] })).rejects.toThrow(/method/)
  })

  it('rejects prompts the command channel cannot collect', async () => {
    const interaction = new CommandInteraction({ method: 'device' })
    await expect(interaction.prompt({ type: 'text', message: 'name?' })).rejects.toThrow(/cannot collect/)
    await expect(interaction.prompt({ type: 'secret', message: 'token?' })).rejects.toThrow(/cannot collect/)
  })

  it('captures notify events in order for the caller to render', () => {
    const interaction = new CommandInteraction({ method: 'device' })
    interaction.notify({ type: 'device_code', userCode: 'ABCD', verificationUri: 'https://x/device' })
    interaction.notify({ type: 'progress', message: 'waiting' })
    expect(interaction.events()).toHaveLength(2)
  })
})

describe('deviceCodeInstructions / authUrlInstructions', () => {
  it('renders device code instructions with a default validity window', () => {
    const text = deviceCodeInstructions({ type: 'device_code', userCode: 'ABCD', verificationUri: 'https://x' })
    expect(text).toBeDefined()
    expect(text).toContain('https://x')
    expect(text).toContain('ABCD')
  })

  it('renders an authorization URL instruction', () => {
    expect(authUrlInstructions({ type: 'auth_url', url: 'https://auth', instructions: 'go' })).toContain('https://auth')
  })

  it('returns nothing for unrelated events', () => {
    expect(deviceCodeInstructions({ type: 'progress', message: 'x' })).toBeUndefined()
    expect(authUrlInstructions({ type: 'progress', message: 'x' })).toBeUndefined()
  })
})
