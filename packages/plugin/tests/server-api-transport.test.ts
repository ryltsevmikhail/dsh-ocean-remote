import { createServer, type Server } from 'node:http'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPair } from '@dsh-remote/crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { HostIdentity } from '../src/identity-store.js'
import { ClientServerApi, ServerApiError } from '../src/server-api.js'
import { ServerCredentialStore } from '../src/server-credentials.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function identity(): Promise<HostIdentity> {
  const keys = generateKeyPair()
  return { schemaVersion: 1, deviceId: crypto.randomUUID(), name: 'test', publicKey: keys.publicKey, privateKey: keys.privateKey, fingerprint: 'test' }
}

async function store(): Promise<{ credentials: ServerCredentialStore; file: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-transport-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  return { credentials: new ServerCredentialStore(directory), file: join(directory, 'server-credentials.json') }
}

/** Fails when any credential record was written at all. */
async function expectNoCredentialFile(file: string): Promise<void> {
  await expect(access(file)).rejects.toMatchObject({ code: 'ENOENT' })
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  return (server.address() as { port: number }).port
}

describe('server API transport failures', () => {
  it('reports a refused connection without storing credentials', async () => {
    const { credentials, file } = await store()
    const probe = createServer()
    const port = await listen(probe)
    cleanups.pop()
    await new Promise<void>(resolve => probe.close(() => resolve()))
    const api = new ClientServerApi(`http://127.0.0.1:${port}`, credentials)
    const failure = await api.authorizeWithAccount(await identity(), 'a@b.c', 'wrong-password-000', async () => identity())
      .then(() => undefined, (reason: unknown) => reason)
    expect(failure).toBeInstanceOf(ServerApiError)
    // A closed port must surface as a transport failure, not as an auth verdict.
    expect((failure as ServerApiError).code).toBe('CONNECTION_FAILED')
    await expectNoCredentialFile(file)
  })

  it('reports a TLS failure when the endpoint does not speak HTTPS', async () => {
    const { credentials, file } = await store()
    const plain = createServer((_request, response) => { response.writeHead(200); response.end('{}') })
    const port = await listen(plain)
    const api = new ClientServerApi(`https://127.0.0.1:${port}`, credentials)
    const failure = await api.authorizeWithAccount(await identity(), 'a@b.c', 'wrong-password-000', async () => identity())
      .then(() => undefined, (reason: unknown) => reason)
    expect(failure).toBeInstanceOf(ServerApiError)
    expect((failure as ServerApiError).code).toBe('CONNECTION_FAILED')
    await expectNoCredentialFile(file)
  })

  it('maps a bare 401 from a real socket to AUTH_INVALID and keeps the store empty', async () => {
    const { credentials, file } = await store()
    // No JSON envelope: the code must come from the HTTP status mapping, not the body.
    const server = createServer((_request, response) => { response.writeHead(401); response.end() })
    const port = await listen(server)
    const api = new ClientServerApi(`http://127.0.0.1:${port}`, credentials)
    const failure = await api.authorizeWithAccount(await identity(), 'a@b.c', 'wrong-password-000', async () => identity())
      .then(() => undefined, (reason: unknown) => reason)
    expect(failure).toBeInstanceOf(ServerApiError)
    expect((failure as ServerApiError).code).toBe('AUTH_INVALID')
    await expectNoCredentialFile(file)
  })
})
