/**
 * File-backed pi-ai `CredentialStore` for authenticated (OAuth / api-key)
 * provider login. Pi-ai's `Models` runs OAuth token refresh inside
 * `modify()`, so this store serializes every write through the cross-process
 * writer lock of `dsh-atomic-write`; reads stay lock-free because the atomic
 * rename commit lets a reader observe either the old or the new complete
 * document.
 *
 * The document is a JSON mapping of provider route to one pi-ai
 * `Credential`, written `0600` under a `0700` directory — the same
 * owner-only posture as the env credential store and settings. The store is
 * an app-owned token cache: an expired token is a disposable secret, so a
 * malformed document fails loud at read rather than silently logging a user
 * out without telling them why.
 *
 * @module dsh-llm-pi-ai/oauth-store
 */

import { readFile } from 'node:fs/promises'
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write'
import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai'

/** Permission bits for the store document; the file holds refresh tokens. */
const FILE_MODE = 0o600
/** Permission bits for directories the store creates; the tree holds secrets. */
const DIR_MODE = 0o700

/** A validate-and-normalize guard on one stored credential. */
function parseCredential(provider: string, raw: unknown): Credential {
  if (raw === null || typeof raw !== 'object') {
    throw new Error(`oauth-store: stored credential for "${provider}" is not an object`)
  }
  const type = (raw as { type?: unknown }).type
  if (type === undefined) {
    throw new Error(`oauth-store: stored credential for "${provider}" has no credential type`)
  }
  if (type !== 'api_key' && type !== 'oauth') {
    throw new Error(`oauth-store: stored credential for "${provider}" has unknown type "${type as string}"`)
  }
  return raw as Credential
}

/** A mutable view of the document, absent while no file has been written yet. */
interface Document {
  [provider: string]: Credential
}

/**
 * File-backed pi-ai credential store keyed by provider route.
 *
 * One document, one credential per provider — the same shape pi-ai's own
 * `auth.json` uses, so a credential written here is exactly what a native
 * pi-ai OAuth flow would persist. `modify` holds the file lock across its
 * read-apply-commit cycle so concurrent login and auto-refresh (including
 * from other processes) cannot resurrect a token another writer just rotated.
 */
export class FileCredentialStore implements CredentialStore {
  constructor(private readonly filename: string) {}

  /** Read the current document body, or an empty map for a not-yet-written file. */
  private async readDoc(): Promise<Document> {
    try {
      const text = await readFile(this.filename, 'utf8')
      const doc = JSON.parse(text) as unknown
      if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
        throw new Error(`oauth-store: ${this.filename} is not a JSON object of provider credentials`)
      }
      return doc as Document
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return {}
      throw error
    }
  }

  /** Replace the whole document atomically, creating its `0700` parent tree. */
  private async writeDoc(doc: Document): Promise<void> {
    await writeFileAtomic(this.filename, `${JSON.stringify(doc, null, 2)}\n`, {
      mode: FILE_MODE,
      dirMode: DIR_MODE,
    })
  }

  async read(providerId: string): Promise<Credential | undefined> {
    const doc = await this.readDoc()
    const raw = doc[providerId]
    return raw === undefined ? undefined : parseCredential(providerId, raw)
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const doc = await this.readDoc()
    return Object.entries(doc).map(([providerId, credential]) => ({
      providerId,
      type: parseCredential(providerId, credential).type,
    }))
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return withFileLock(this.filename, async () => {
      const doc = await this.readDoc()
      const current = doc[providerId] === undefined ? undefined : parseCredential(providerId, doc[providerId])
      const next = await fn(current)
      if (next === undefined) return current
      parseCredential(providerId, next)
      doc[providerId] = next
      await this.writeDoc(doc)
      return next
    })
  }

  async delete(providerId: string): Promise<void> {
    await withFileLock(this.filename, async () => {
      const doc = await this.readDoc()
      if (!(providerId in doc)) return
      Reflect.deleteProperty(doc, providerId)
      await this.writeDoc(doc)
    })
  }
}
