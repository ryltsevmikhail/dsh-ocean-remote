import { chmod, mkdtemp, readFile, rm, stat, writeFile, symlink, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { generateKeyPair } from '@dsh-remote/crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fingerprint, fullFingerprint, IdentityInvalidError, IdentityStore, serverStorageDirectory } from '../src/identity-store.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('IdentityStore', () => {
  it('creates and reloads one stable device identity', async () => {
    const directory = await temporaryDirectory()
    const first = await new IdentityStore({ directory }).loadOrCreate('Workstation')
    const second = await new IdentityStore({ directory }).loadOrCreate('Renamed workstation')
    expect(second).toMatchObject({ deviceId: first.deviceId, publicKey: first.publicKey, privateKey: first.privateKey, name: 'Renamed workstation' })
    expect(first.deviceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    if (process.platform !== 'win32') {
      expect((await stat(join(directory, 'device.key'))).mode & 0o777).toBe(0o600)
    }
  })

  it('persists trusted peers without private material', async () => {
    const hostDirectory = await temporaryDirectory()
    const clientDirectory = await temporaryDirectory()
    const hostStore = new IdentityStore({ directory: hostDirectory })
    await hostStore.loadOrCreate('Host')
    const client = await new IdentityStore({ directory: clientDirectory }).loadOrCreate('Client')
    await hostStore.trustPeer({ deviceId: client.deviceId, name: client.name, platform: 'linux', publicKey: client.publicKey })
    const stored = await readFile(join(hostDirectory, 'trusted-peers.json'), 'utf8')
    expect(stored).toContain(client.publicKey)
    expect(stored).not.toContain(client.privateKey)
    expect(hostStore.isTrusted(client.deviceId, client.publicKey)).toBe(true)
  })

  it('fails closed for incomplete or overly permissive identity files', async () => {
    const incomplete = await temporaryDirectory()
    await writeFile(join(incomplete, 'device.json'), '{}')
    await expect(new IdentityStore({ directory: incomplete }).loadOrCreate('Host')).rejects.toBeInstanceOf(IdentityInvalidError)

    if (process.platform !== 'win32') {
      const permissive = await temporaryDirectory()
      await new IdentityStore({ directory: permissive }).loadOrCreate('Host')
      await chmod(join(permissive, 'device.key'), 0o644)
      await expect(new IdentityStore({ directory: permissive }).loadOrCreate('Host')).rejects.toThrow(/0600/)
    }
  })

  it('shares a serialized lane, clones and invalidations without losing concurrent updates', async () => {
    const directory = await temporaryDirectory()
    const a = new IdentityStore({ directory })
    const b = new IdentityStore({ directory: join(directory, '.') })
    await Promise.all([a.loadOrCreate('Host'), b.loadOrCreate('Host')])
    const first = peer('one')
    const second = peer('two')
    await Promise.all([a.trustPeer(first), b.trustPeer(second)])
    expect(a.listTrustedPeers()).toHaveLength(2)
    expect(b.listTrustedPeers()).toHaveLength(2)
    a.current().name = 'mutated'
    a.trustedPeer('one')!.publicKey = 'mutated'
    a.listTrustedPeers()[0]!.name = 'mutated'
    expect(b.current().name).toBe('Host')
    expect(b.trustedPeer('one')).toMatchObject(first)
    await b.revokePeer('one')
    expect(a.isTrusted('one', first.publicKey)).toBe(false)
    const before = a.current().deviceId
    await b.reset('New host')
    expect(a.current().deviceId).not.toBe(before)
    expect(a.listTrustedPeers()).toEqual([])
    await a.close()
    await b.close()
  })

  it('never changes existing pins, timestamps, metadata or legacy provenance', async () => {
    const directory = await temporaryDirectory()
    const store = new IdentityStore({ directory })
    await store.loadOrCreate('Host')
    const input = peer('legacy')
    const original = await store.trustPeer(input)
    const persisted = await readFile(join(directory, 'trusted-peers.json'), 'utf8')
    expect(original).not.toHaveProperty('provenance')
    expect(await store.trustPeer({ ...input, name: 'renamed', membershipId: 'new' }, { provenance: 'manual' })).toEqual(original)
    await expect(store.trustPeer({ ...input, publicKey: generateKeyPair().publicKey })).rejects.toMatchObject({ code: 'PEER_KEY_CHANGED' })
    expect(await readFile(join(directory, 'trusted-peers.json'), 'utf8')).toBe(persisted)
    expect(await store.trustPeer(peer('manual'), { provenance: 'manual' })).toMatchObject({ provenance: 'manual' })
    await store.close()
    const reload = new IdentityStore({ directory })
    await reload.loadOrCreate('Host')
    expect(reload.trustedPeer('legacy')).toEqual(original)
    await reload.close()
  })

  it('does not publish or persist candidates when a write fails before rename', async () => {
    const directory = await temporaryDirectory()
    let fail = false
    const store = new IdentityStore({ directory, writeCheckpoint(phase) { if (fail && phase === 'beforeRename') throw new Error('injected') } })
    await store.loadOrCreate('Host')
    const original = await store.trustPeer(peer('original'))
    const before = await readFile(join(directory, 'trusted-peers.json'), 'utf8')
    fail = true
    await expect(store.trustPeer(peer('rejected'))).rejects.toThrow('injected')
    await expect(store.revokePeer('original')).rejects.toThrow('injected')
    expect(store.listTrustedPeers()).toEqual([original])
    expect(await readFile(join(directory, 'trusted-peers.json'), 'utf8')).toBe(before)
    expect((await readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([])
    expect(await readdir(directory)).not.toContain('.identity-indeterminate')
    await store.close()
  })

  it('blocks all instances and later opens after an uncertain postrename commit', async () => {
    const directory = await temporaryDirectory()
    let fail = false
    const a = new IdentityStore({ directory, writeCheckpoint(phase) { if (fail && phase === 'afterRename') throw new Error('directory fsync fault') } })
    const b = new IdentityStore({ directory })
    await a.loadOrCreate('Host')
    await b.loadOrCreate('Host')
    fail = true
    await expect(a.trustPeer(peer('uncertain'), { provenance: 'manual' })).rejects.toMatchObject({ code: 'INDETERMINATE' })
    expect(() => a.listTrustedPeers()).toThrow(/reconciliation/)
    expect(() => b.isTrusted('uncertain', 'anything')).toThrow(/reconciliation/)
    await expect(b.reset('Host')).rejects.toMatchObject({ code: 'INDETERMINATE' })
    expect(await readdir(directory)).toContain('.identity-indeterminate')
    await a.close()
    await b.close()
    await expect(new IdentityStore({ directory }).loadOrCreate('Host')).rejects.toMatchObject({ code: 'IDENTITY_IN_USE' })
  })

  it('reloads and validates peer files on every mutation rather than overwriting corruption', async () => {
    const directory = await temporaryDirectory()
    const store = new IdentityStore({ directory })
    await store.loadOrCreate('Host')
    const original = await store.trustPeer(peer('external'))
    await writeFile(join(directory, 'trusted-peers.json'), JSON.stringify({ schemaVersion: 1, peers: [{ ...original, fingerprint: 'wrong' }] }))
    await expect(store.trustPeer(peer('next'))).rejects.toMatchObject({ code: 'IDENTITY_INVALID' })
    await expect(store.revokePeer('external')).rejects.toMatchObject({ code: 'IDENTITY_INVALID' })
    expect(await readFile(join(directory, 'trusted-peers.json'), 'utf8')).toContain('wrong')
    await store.close()
  })

  it('merges fresh validated disk state inside each mutation', async () => {
    const directory = await temporaryDirectory()
    const store = new IdentityStore({ directory })
    await store.loadOrCreate('Host')
    const external = { ...peer('external'), trustedAt: 123, fingerprint: '' }
    external.fingerprint = fingerprint(external.publicKey)
    await writeFile(join(directory, 'trusted-peers.json'), JSON.stringify({ schemaVersion: 1, peers: [external] }))
    await store.trustPeer(peer('new'))
    expect(store.trustedPeer('external')).toEqual(external)
    expect(store.listTrustedPeers()).toHaveLength(2)
    await store.close()
  })

  it('rejects legacy malformed keys and duplicate peers without rotating identity', async () => {
    const directory = await temporaryDirectory()
    const store = new IdentityStore({ directory })
    const identity = await store.loadOrCreate('Host')
    const pin = await store.trustPeer(peer('one'))
    for (const peers of [[pin, pin], [{ ...pin, publicKey: pin.publicKey + '=' }]]) {
      await writeFile(join(directory, 'trusted-peers.json'), JSON.stringify({ schemaVersion: 1, peers }))
      await expect(store.loadOrCreate('Host')).rejects.toMatchObject({ code: 'IDENTITY_INVALID' })
      expect(JSON.parse(await readFile(join(directory, 'device.json'), 'utf8')).deviceId).toBe(identity.deviceId)
    }
    await store.close()
  })

  it('keeps legacy 48-bit fingerprints and validates full canonical 256-bit fingerprints', () => {
    const key = Buffer.alloc(32, 9).toString('base64url')
    const full = createHash('sha256').update(Buffer.alloc(32, 9)).digest('hex').toUpperCase()
    expect(fullFingerprint(key)).toBe(full)
    expect(fullFingerprint(key)).toMatch(/^[A-F0-9]{64}$/)
    expect(fingerprint(key)).toBe(full.slice(0, 12).match(/.{4}/g)!.join(' '))
    for (const bad of [key + '=', key + '\n', Buffer.alloc(31).toString('base64url'), Buffer.alloc(33).toString('base64url'), key.slice(0, -1) + 'l', '!'.repeat(43)]) {
      expect(() => fullFingerprint(bad)).toThrow()
    }
  })

  it('holds an exclusive private lease until last close and rejects closed mutations', async () => {
    const directory = await temporaryDirectory()
    const a = new IdentityStore({ directory })
    const b = new IdentityStore({ directory })
    await a.loadOrCreate('Host')
    await b.loadOrCreate('Host')
    const lease = await readFile(join(directory, '.identity-owner'), 'utf8')
    expect(JSON.parse(lease)).toMatchObject({ pid: process.pid })
    expect((await stat(join(directory, '.identity-owner'))).mode & 0o777).toBe(0o600)
    await a.close()
    expect(await readFile(join(directory, '.identity-owner'), 'utf8')).toBe(lease)
    await expect(a.trustPeer(peer('closed'))).rejects.toThrow(/closed/)
    await b.close()
    expect(await readdir(directory)).not.toContain('.identity-owner')
    await b.close()
    const foreign = JSON.stringify({ nonce: 'foreign-owner', pid: 99999999 })
    await writeFile(join(directory, '.identity-owner'), foreign, { mode: 0o600 })
    const c = new IdentityStore({ directory })
    await expect(c.loadOrCreate('Host')).rejects.toMatchObject({ code: 'IDENTITY_IN_USE' })
    await c.close()
    expect(await readFile(join(directory, '.identity-owner'), 'utf8')).toBe(foreign)
  })

  it('does not remove replaced owner leases or foreign files during reset', async () => {
    const directory = await temporaryDirectory()
    const store = new IdentityStore({ directory })
    await store.loadOrCreate('Host')
    await writeFile(join(directory, 'foreign.txt'), 'keep me')
    const lease = await readFile(join(directory, '.identity-owner'), 'utf8')
    await store.reset('Reset')
    expect(await readFile(join(directory, 'foreign.txt'), 'utf8')).toBe('keep me')
    expect(await readFile(join(directory, '.identity-owner'), 'utf8')).toBe(lease)
    await writeFile(join(directory, '.identity-owner'), JSON.stringify({ nonce: 'replacement' }))
    await expect(store.close()).rejects.toMatchObject({ code: 'IDENTITY_IN_USE' })
    expect(await readFile(join(directory, '.identity-owner'), 'utf8')).toContain('replacement')
  })

  it('rejects symlink roots, permissive roots and symlink reset targets without touching targets', async () => {
    const root = await temporaryDirectory()
    const target = await temporaryDirectory()
    const link = join(root, 'link')
    await symlink(target, link)
    await expect(new IdentityStore({ directory: link }).loadOrCreate('Host')).rejects.toMatchObject({ code: 'IDENTITY_INVALID' })
    if (process.platform !== 'win32') {
      await chmod(target, 0o755)
      await expect(new IdentityStore({ directory: target }).loadOrCreate('Host')).rejects.toMatchObject({ code: 'IDENTITY_INVALID' })
      expect((await stat(target)).mode & 0o777).toBe(0o755)
    }
    const directory = await temporaryDirectory()
    const store = new IdentityStore({ directory })
    await store.loadOrCreate('Host')
    const foreign = join(root, 'foreign')
    await writeFile(foreign, 'untouched')
    await rm(join(directory, 'device.key'))
    await symlink(foreign, join(directory, 'device.key'))
    await expect(store.reset('Host')).rejects.toMatchObject({ code: 'IDENTITY_INVALID' })
    expect(await readFile(foreign, 'utf8')).toBe('untouched')
    await store.close()
  })

  it('isolates Host and Client identities by normalized Server origin', async () => {
    const root = await temporaryDirectory()
    const firstHost = serverStorageDirectory(root, 'https://one.example.com', 'host')
    const firstClient = serverStorageDirectory(root, 'https://one.example.com', 'client')
    const secondHost = serverStorageDirectory(root, 'https://two.example.com', 'host')
    expect(firstHost).not.toBe(firstClient)
    expect(firstHost).not.toBe(secondHost)
    expect(serverStorageDirectory(root, 'https://one.example.com/', 'host')).toBe(firstHost)
  })
})

function peer(deviceId: string) {
  return { deviceId, name: deviceId, platform: 'linux', publicKey: generateKeyPair().publicKey }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-remote-plugin-'))
  directories.push(directory)
  return directory
}
