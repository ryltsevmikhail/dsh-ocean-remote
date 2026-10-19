import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fromBase64Url, generateKeyPair } from '@dsh-remote/crypto'
import { z } from 'zod'
import { uuidV7 } from './ids.js'

const identitySchema = z.object({
  schemaVersion: z.literal(1), deviceId: z.string().uuid(), name: z.string().min(1).max(80), publicKey: z.string().min(1),
}).strict()
const trustedPeerSchema = z.object({
  deviceId: z.string().min(1), name: z.string().min(1).max(80), platform: z.string().min(1).max(40),
  publicKey: z.string().min(1), fingerprint: z.string().min(1), trustedAt: z.number().int().nonnegative(),
  membershipId: z.string().min(1).optional(), provenance: z.literal('manual').optional(),
}).strict()
const trustedPeersSchema = z.object({ schemaVersion: z.literal(1), peers: z.array(trustedPeerSchema) }).strict()

export interface HostIdentity {
  schemaVersion: 1
  deviceId: string
  name: string
  publicKey: string
  privateKey: string
  fingerprint: string
}
export interface TrustedPeer {
  deviceId: string
  name: string
  platform: string
  publicKey: string
  fingerprint: string
  trustedAt: number
  membershipId?: string
  provenance?: 'manual'
}
export interface IdentityStoreOptions {
  directory?: string
  env?: NodeJS.ProcessEnv
  homeDirectory?: string
  /** Test-only fault injection at durable-write boundaries. */
  writeCheckpoint?: (phase: 'beforeRename' | 'afterRename', path: string) => void | Promise<void>
}
export type RemoteDeviceRole = 'host' | 'client'
export class IdentityInvalidError extends Error { readonly code = 'IDENTITY_INVALID' }
export class PeerKeyChangedError extends Error { readonly code = 'PEER_KEY_CHANGED' }
export class IdentityInUseError extends Error { readonly code = 'IDENTITY_IN_USE' }
export class IdentityIndeterminateError extends Error { readonly code = 'INDETERMINATE' }

type Lease = { nonce: string; ino: number; dev: number }
type Shared = {
  tail: Promise<unknown>; refs: number; identity?: HostIdentity; peers: Map<string, TrustedPeer>
  lease?: Lease; blocked?: IdentityIndeterminateError; retiring?: boolean
}
const states = new Map<string, Shared>()
const OWNER = '.identity-owner'
const MARKER = '.identity-indeterminate'

/** Single active writer process only. Stale leases/markers require offline administrator recovery;
 * never steal by PID or age. Network filesystems and old writers without this protocol are unsupported.
 */
export class IdentityStore {
  readonly directory: string
  private shared?: Shared
  private closed = false
  private closing?: Promise<void>
  private readonly checkpoint?: IdentityStoreOptions['writeCheckpoint']
  constructor(options: IdentityStoreOptions = {}) {
    const env = options.env ?? process.env
    this.directory = resolve(options.directory ?? join(env.DSH_HOME || join(options.homeDirectory ?? homedir(), '.dsh'), 'remote'))
    this.checkpoint = options.writeCheckpoint
  }
  private async state(): Promise<Shared> {
    if (this.closed) throw new Error('identity store is closed')
    if (this.shared) return this.shared
    await privateDirectory(this.directory)
    const canonical = await realpath(this.directory)
    if (this.closed) throw new Error('identity store is closed')
    if (this.shared) return this.shared
    let state = states.get(canonical)
    if (state?.retiring) { await state.tail; return this.state() }
    if (!state) {
      state = { tail: Promise.resolve(), refs: 0, peers: new Map() }
      states.set(canonical, state)
    }
    state.refs++
    this.shared = state
    return state
  }
  private async lane<T>(action: (state: Shared) => Promise<T>): Promise<T> {
    const state = await this.state()
    const task = state.tail.then(async () => {
      if (this.closed) throw new Error('identity store is closed')
      if (state.blocked) throw state.blocked
      await this.acquire(state)
      if (await exists(join(this.directory, MARKER))) {
        state.blocked = new IdentityIndeterminateError('identity commit requires offline reconciliation')
        throw state.blocked
      }
      return action(state)
    })
    state.tail = task.catch(() => {})
    return task
  }
  private async acquire(state: Shared): Promise<void> {
    await privateDirectory(this.directory)
    if (state.lease) { await this.verifyLease(state); return }
    const path = join(this.directory, OWNER)
    let file
    try { file = await open(path, 'wx', 0o600) } catch (error) {
      if (isCode(error, 'EEXIST')) throw new IdentityInUseError('identity directory is owned; offline recovery is required for stale leases')
      throw error
    }
    const nonce = randomBytes(32).toString('hex')
    // Retain an incomplete lease on I/O failure: uncertainty must never permit a second writer.
    try {
      await file.writeFile(JSON.stringify({ nonce, pid: process.pid }))
      await file.sync()
      const info = await file.stat()
      state.lease = { nonce, ino: info.ino, dev: info.dev }
    } finally { await file.close() }
    await syncDirectory(this.directory)
  }
  private async verifyLease(state: Shared): Promise<void> {
    const path = join(this.directory, OWNER)
    const info = await privateFile(path)
    const record = JSON.parse(await readFile(path, 'utf8'))
    if (!state.lease || info.ino !== state.lease.ino || info.dev !== state.lease.dev || record.nonce !== state.lease.nonce) {
      throw new IdentityInUseError('identity owner lease changed')
    }
  }
  async close(): Promise<void> {
    if (this.closed) return this.closing
    this.closed = true
    const state = this.shared
    if (!state) return
    const task = state.tail.then(async () => {
      state.refs--
      if (state.refs !== 0) return
      state.retiring = true
      // Keep the lease for uncertain commits, even when the last live reference closes.
      try {
        if (state.lease && !state.blocked) {
          await this.verifyLease(state)
          await unlink(join(this.directory, OWNER))
          state.lease = undefined
          await syncDirectory(this.directory)
        }
        states.delete(await realpath(this.directory))
      } finally { state.retiring = false }
    })
    state.tail = task.catch(() => {})
    this.closing = task
    await task
  }
  async loadOrCreate(deviceName: string): Promise<HostIdentity> {
    return this.lane(async state => this.load(state, deviceName))
  }
  private async load(state: Shared, deviceName: string): Promise<HostIdentity> {
    identitySchema.shape.name.parse(deviceName)
    const devicePath = join(this.directory, 'device.json')
    const keyPath = join(this.directory, 'device.key')
    const [hasDevice, hasKey] = await Promise.all([exists(devicePath), exists(keyPath)])
    if (hasDevice !== hasKey) throw new IdentityInvalidError('device identity is incomplete; repair it explicitly before reconnecting')
    try {
      // Validate peers before making any identity changes.
      const peers = await this.readPeers()
      if (!hasDevice) {
        const keys = generateKeyPair()
        await this.write(state, keyPath, `${keys.privateKey}\n`)
        await this.write(state, devicePath, json({ schemaVersion: 1, deviceId: uuidV7(), name: deviceName, publicKey: keys.publicKey }))
      }
      await privateFile(devicePath)
      await privateFile(keyPath)
      let record = identitySchema.parse(JSON.parse(await readFile(devicePath, 'utf8')))
      fullFingerprint(record.publicKey)
      const privateKey = (await readFile(keyPath, 'utf8')).trim()
      decodeKey(privateKey)
      if (generateKeyPair(fromBase64Url(privateKey)).publicKey !== record.publicKey) throw new IdentityInvalidError('device public and private keys do not match')
      if (record.name !== deviceName) {
        record = { ...record, name: deviceName }
        await this.write(state, devicePath, json(record))
      }
      if (!(await exists(join(this.directory, 'trusted-peers.json')))) await this.savePeers(state, peers)
      state.identity = { ...record, privateKey, fingerprint: fingerprint(record.publicKey) }
      state.peers = peers
      return { ...state.identity }
    } catch (error) {
      if (error instanceof IdentityIndeterminateError || error instanceof IdentityInvalidError) throw error
      throw new IdentityInvalidError(`device identity is invalid: ${safeErrorMessage(error)}`)
    }
  }
  private readable(): Shared {
    if (this.closed) throw new Error('identity store is closed')
    if (this.shared?.blocked) throw this.shared.blocked
    if (!this.shared?.identity) throw new Error('identity store has not been loaded')
    return this.shared
  }
  current(): HostIdentity { return { ...this.readable().identity! } }
  private peerState(): Map<string, TrustedPeer> {
    if (this.closed) throw new Error('identity store is closed')
    if (this.shared?.blocked) throw this.shared.blocked
    return this.shared?.peers ?? new Map()
  }
  listTrustedPeers(): TrustedPeer[] { return [...this.peerState().values()].map(peer => ({ ...peer })) }
  trustedPeer(deviceId: string): TrustedPeer | undefined {
    const peer = this.peerState().get(deviceId)
    return peer ? { ...peer } : undefined
  }
  isTrusted(deviceId: string, publicKey: string): boolean { return this.peerState().get(deviceId)?.publicKey === publicKey }
  async trustPeer(input: Omit<TrustedPeer, 'fingerprint' | 'trustedAt' | 'provenance'>, options?: { provenance?: 'manual' }): Promise<TrustedPeer> {
    return this.lane(async state => {
      this.readable()
      const peers = await this.readPeers()
      const existing = peers.get(input.deviceId)
      if (existing) {
        state.peers = peers
        if (existing.publicKey !== input.publicKey) throw new PeerKeyChangedError(`trusted peer ${input.deviceId} changed public key`)
        return { ...existing }
      }
      const candidate = trustedPeerSchema.parse({ deviceId: input.deviceId, name: input.name, platform: input.platform, publicKey: input.publicKey, ...(input.membershipId === undefined ? {} : { membershipId: input.membershipId }), fingerprint: fingerprint(input.publicKey), trustedAt: Date.now(), ...(options?.provenance === 'manual' ? { provenance: 'manual' } : {}) })
      const next = new Map(peers)
      next.set(candidate.deviceId, candidate)
      await this.savePeers(state, next)
      state.peers = next
      return { ...candidate }
    })
  }
  async revokePeer(deviceId: string): Promise<boolean> {
    return this.lane(async state => {
      this.readable()
      const peers = await this.readPeers()
      const removed = peers.delete(deviceId)
      if (removed) await this.savePeers(state, peers)
      state.peers = peers
      return removed
    })
  }
  async reset(deviceName: string): Promise<HostIdentity> {
    return this.lane(async state => {
      // Validate every target before removing anything; never recurse or touch foreign files.
      await this.readPeers()
      const paths = ['device.json', 'device.key', 'trusted-peers.json'].map(name => join(this.directory, name))
      for (const path of paths) if (await exists(path)) await privateFile(path)
      identitySchema.shape.name.parse(deviceName)
      const marker = join(this.directory, MARKER)
      const guard = await open(marker, 'wx', 0o600)
      try {
        await guard.writeFile(JSON.stringify({ operation: 'reset', nonce: state.lease!.nonce }))
        await guard.sync()
      } finally { await guard.close() }
      try {
        await syncDirectory(this.directory)
        for (const path of paths) if (await exists(path)) await unlink(path)
        await syncDirectory(this.directory)
        await unlink(marker)
        await syncDirectory(this.directory)
      } catch (error) {
        state.blocked = new IdentityIndeterminateError(`identity reset requires offline reconciliation: ${safeErrorMessage(error)}`)
        throw state.blocked
      }
      state.identity = undefined
      state.peers = new Map()
      return this.load(state, deviceName)
    })
  }
  private async readPeers(): Promise<Map<string, TrustedPeer>> {
    const path = join(this.directory, 'trusted-peers.json')
    const peers = new Map<string, TrustedPeer>()
    if (!(await exists(path))) return peers
    try {
      await privateFile(path)
      const parsed = trustedPeersSchema.parse(JSON.parse(await readFile(path, 'utf8')))
      for (const peer of parsed.peers) {
        if (peer.fingerprint !== fingerprint(peer.publicKey)) throw new Error(`trusted peer ${peer.deviceId} has an invalid fingerprint`)
        if (peers.has(peer.deviceId)) throw new Error(`trusted peer ${peer.deviceId} is duplicated`)
        peers.set(peer.deviceId, peer)
      }
      return peers
    } catch (error) {
      if (this.shared) this.shared.peers = new Map()
      throw new IdentityInvalidError(`trusted peers are invalid: ${safeErrorMessage(error)}`)
    }
  }
  private async savePeers(state: Shared, peers: Map<string, TrustedPeer>): Promise<void> {
    await this.write(state, join(this.directory, 'trusted-peers.json'), json({ schemaVersion: 1, peers: [...peers.values()] }))
  }
  private async write(state: Shared, path: string, value: string): Promise<void> {
    await this.verifyLease(state)
    if (await exists(path)) await privateFile(path)
    const temporary = `${path}.${randomBytes(16).toString('hex')}.tmp`
    const marker = join(this.directory, MARKER)
    let committed = false
    let marked = false
    try {
      const file = await open(temporary, 'wx', 0o600)
      try { await file.writeFile(value, 'utf8'); await file.sync() } finally { await file.close() }
      const guard = await open(marker, 'wx', 0o600)
      marked = true
      try { await guard.writeFile(JSON.stringify({ target: path, nonce: state.lease!.nonce })); await guard.sync() } finally { await guard.close() }
      await syncDirectory(this.directory)
      await this.checkpoint?.('beforeRename', path)
      await rename(temporary, path)
      committed = true
      await this.checkpoint?.('afterRename', path)
      await syncDirectory(this.directory)
      await unlink(marker)
      marked = false
      await syncDirectory(this.directory)
    } catch (error) {
      if (committed) {
        state.blocked = new IdentityIndeterminateError(`identity write may have committed; offline reconciliation required: ${safeErrorMessage(error)}`)
        throw state.blocked
      }
      if (marked) {
        try { await unlink(marker); await syncDirectory(this.directory) } catch {
          state.blocked = new IdentityIndeterminateError('identity write recovery failed; offline reconciliation required')
          throw state.blocked
        }
      }
      throw error
    } finally {
      // This is our unpredictable, exclusively created temporary path, never a directory.
      try { await unlink(temporary) } catch (error) { if (!isCode(error, 'ENOENT')) throw error }
    }
  }
}

export function serverStorageDirectory(root: string, serverUrl: string, role: RemoteDeviceRole): string {
  const scope = createHash('sha256').update(new URL(serverUrl).origin).digest('hex').slice(0, 24)
  return join(root, 'servers', scope, role)
}
function decodeKey(publicKey: string): Buffer {
  const bytes = Buffer.from(fromBase64Url(publicKey))
  if (bytes.length !== 32 || bytes.toString('base64url') !== publicKey) throw new IdentityInvalidError('key must be canonical base64url encoding of 32 bytes')
  return bytes
}
export function fullFingerprint(publicKey: string): string { return createHash('sha256').update(decodeKey(publicKey)).digest('hex').toUpperCase() }
export function fingerprint(publicKey: string): string { return fullFingerprint(publicKey).slice(0, 12).match(/.{1,4}/g)!.join(' ') }
async function privateDirectory(path: string): Promise<void> {
  try { await lstat(path) } catch (error) {
    if (!isCode(error, 'ENOENT')) throw error
    await mkdir(path, { recursive: true, mode: 0o700 })
  }
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())))) {
    throw new IdentityInvalidError('identity directory must be a private owned directory, not a symlink')
  }
  // Reject symlink ancestors too: canonicalization must not redirect ownership outside the requested root.
  if (await realpath(path) !== resolve(path)) throw new IdentityInvalidError('identity directory must not traverse symlinks')
}
async function privateFile(path: string) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())))) {
    throw new IdentityInvalidError('identity files must be owned regular files with private 0600 permissions')
  }
  return info
}
async function syncDirectory(path: string): Promise<void> {
  const file = await open(path, 'r')
  try { await file.sync() } finally { await file.close() }
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) { if (isCode(error, 'ENOENT')) return false; throw error }
}
function json(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n` }
function isCode(error: unknown, code: string): boolean { return error instanceof Error && 'code' in error && error.code === code }
function safeErrorMessage(error: unknown): string { return error instanceof Error ? error.message : 'invalid identity data' }
