import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Credential } from '@earendil-works/pi-ai'
import { FileCredentialStore } from '../src/oauth-store.ts'

const homes: string[] = []

afterEach(async () => {
  await Promise.all(homes.map(home => rm(home, { recursive: true, force: true })))
  homes.length = 0
})

async function storeAt(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'oauth-store-'))
  homes.push(home)
  return join(home, 'credentials.json')
}

const oauth: Credential = { type: 'oauth', access: 'access-1', refresh: 'refresh-1', expires: 1_700_000_000_000 }
const apiKey: Credential = { type: 'api_key', key: 'key-1' }

describe('FileCredentialStore', () => {
  it('reads undefined for a provider that has never been stored', async () => {
    const store = new FileCredentialStore(await storeAt())
    await expect(store.read('openai-codex')).resolves.toBeUndefined()
    await expect(store.list()).resolves.toEqual([])
  })

  it('persists a credential through modify and reads it back from a fresh store', async () => {
    const path = await storeAt()
    const first = new FileCredentialStore(path)
    await expect(first.modify('openai-codex', async () => oauth)).resolves.toEqual(oauth)
    expect(await readFile(path, 'utf8')).toContain('"access-1"')

    const second = new FileCredentialStore(path)
    await expect(second.read('openai-codex')).resolves.toEqual(oauth)
    await expect(second.list()).resolves.toEqual([{ providerId: 'openai-codex', type: 'oauth' }])
  })

  it('stores api_key credentials too', async () => {
    const path = await storeAt()
    const store = new FileCredentialStore(path)
    await store.modify('gateway', async () => apiKey)
    await expect(store.read('gateway')).resolves.toEqual(apiKey)
  })

  it('modify leaving the entry unchanged returns the current credential and does not overwrite', async () => {
    const path = await storeAt()
    const store = new FileCredentialStore(path)
    await store.modify('openai-codex', async () => oauth)
    await expect(store.modify('openai-codex', async () => undefined)).resolves.toEqual(oauth)
  })

  it('modify fans out concurrent writes without losing either provider', async () => {
    const path = await storeAt()
    const store = new FileCredentialStore(path)
    await Promise.all([
      store.modify('openai-codex', async () => oauth),
      store.modify('gateway', async () => apiKey),
    ])
    await expect(store.read('openai-codex')).resolves.toEqual(oauth)
    await expect(store.read('gateway')).resolves.toEqual(apiKey)
  })

  it('delete removes a stored credential and leaves other providers intact', async () => {
    const path = await storeAt()
    const store = new FileCredentialStore(path)
    await store.modify('openai-codex', async () => oauth)
    await store.modify('gateway', async () => apiKey)
    await store.delete('openai-codex')
    await expect(store.read('openai-codex')).resolves.toBeUndefined()
    await expect(store.read('gateway')).resolves.toEqual(apiKey)
  })

  it('delete of an absent provider is a no-op', async () => {
    const store = new FileCredentialStore(await storeAt())
    await expect(store.delete('openai-codex')).resolves.toBeUndefined()
  })

  it('fails loud on a malformed document', async () => {
    const path = await storeAt()
    const store = new FileCredentialStore(path)
    await store.modify('openai-codex', async () => oauth)
    await import('node:fs/promises').then(({ writeFile }) =>
      writeFile(path, 'not json'))
    await expect(store.read('openai-codex')).rejects.toThrow()
  })

  it('fails loud on a stored credential with an unknown type', async () => {
    const path = await storeAt()
    const store = new FileCredentialStore(path)
    await store.modify('openai-codex', async () => oauth)
    await import('node:fs/promises').then(({ writeFile }) =>
      writeFile(path, JSON.stringify({ 'openai-codex': { type: 'magic' } })))
    await expect(store.read('openai-codex')).rejects.toThrow(/unknown type/)
  })

  it('rejects a document that is not a JSON object', async () => {
    const path = await storeAt()
    await import('node:fs/promises').then(({ writeFile }) =>
      writeFile(path, '[1, 2, 3]'))
    const store = new FileCredentialStore(path)
    await expect(store.read('openai-codex')).rejects.toThrow(/not a JSON object/)
  })
})
