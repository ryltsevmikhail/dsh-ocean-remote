import { createHash } from 'node:crypto'
import { generateKeyPair } from '@dsh-remote/crypto'
import { describe, expect, it, vi } from 'vitest'
import type { TrustedPeer } from '../src/identity-store.js'
import { PeerApprovalQueue, type PeerApprovalInput, type PeerApprovalQueueOptions, type PeerApprovalStore } from '../src/peer-approval.js'

function peer(deviceId = 'peer'): PeerApprovalInput {
  return { deviceId, name: 'Remote', platform: 'linux', publicKey: generateKeyPair().publicKey, membershipId: 'member' }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
function fixture(options: Partial<PeerApprovalQueueOptions> = {}) {
  let now = 100
  const pins = new Map<string, TrustedPeer>()
  const trustPeer = vi.fn<PeerApprovalStore['trustPeer']>(async input => {
    const result = { ...input, fingerprint: 'legacy fingerprint', trustedAt: 1 }
    pins.set(input.deviceId, result)
    return result
  })
  const store: PeerApprovalStore = { trustedPeer: id => pins.get(id), trustPeer }
  const queue = new PeerApprovalQueue(store, { epochId: 'owner-epoch', role: 'host', origin: 'https://example.test', now: () => now, ...options })
  return { queue, pins, store, trustPeer, advance: (ms: number) => { now += ms } }
}

describe('PeerApprovalQueue', () => {
  it('exports only cloned UI metadata, with full decoded-key SHA256 and owner scope', () => {
    const f = fixture()
    const input = peer()
    const dto = f.queue.request(input)!
    expect(dto.fullFingerprint).toBe(createHash('sha256').update(Buffer.from(input.publicKey, 'base64url')).digest('hex').toUpperCase())
    expect(dto).toMatchObject({ epochId: 'owner-epoch', role: 'host', origin: 'https://example.test' })
    expect(dto).not.toHaveProperty('publicKey')
    input.name = 'mutated'
    dto.name = 'mutated'
    const list = f.queue.list()
    list[0]!.name = 'also mutated'
    expect(f.queue.list()[0]!.name).toBe('Remote')
  })

  it('deduplicates exact keys without extending TTL or rotating generations', () => {
    const f = fixture()
    const input = peer()
    const first = f.queue.request(input)!
    f.advance(10_000)
    expect(f.queue.request(input)).toEqual(first)
    f.advance(290_000)
    expect(f.queue.list()).toEqual([])
    expect(() => f.queue.request(input)).toThrow('cooldown')
    f.advance(5_000)
    expect(f.queue.request(input)!.generation).not.toBe(first.generation)
  })

  it('rejects lowercase, short48, whitespace and stale generations without persistence', async () => {
    const f = fixture()
    const pending = f.queue.request(peer())!
    for (const fullFingerprint of [pending.fullFingerprint.toLowerCase(), pending.fullFingerprint.slice(0, 48), ` ${pending.fullFingerprint}`]) {
      await expect(f.queue.approve({ ...pending, fullFingerprint })).rejects.toThrow('fingerprint')
    }
    await expect(f.queue.approve({ ...pending, generation: 'stale' })).rejects.toThrow('stale')
    expect(f.trustPeer).not.toHaveBeenCalled()
    f.advance(300_000)
    await expect(f.queue.approve(pending)).rejects.toThrow('stale')
  })

  it('new key revisions invalidate old actions and rate-limit further churn', async () => {
    const f = fixture()
    const first = f.queue.request(peer())!
    const revised = f.queue.request(peer())!
    expect(revised.generation).not.toBe(first.generation)
    await expect(f.queue.approve(first)).rejects.toThrow('stale')
    expect(() => f.queue.reject(first)).toThrow('stale')
    expect(() => f.queue.request(peer())).toThrow('cooldown')
    f.advance(5_000)
    expect(f.queue.request(peer())!.generation).not.toBe(revised.generation)
  })

  it('reject removes pending with bounded cooldown and cannot approve afterward', async () => {
    const f = fixture()
    const input = peer()
    const pending = f.queue.request(input)!
    f.queue.reject(pending)
    await expect(f.queue.approve(pending)).rejects.toThrow('stale')
    expect(() => f.queue.request(input)).toThrow('cooldown')
    f.advance(5_000)
    expect(f.queue.request(input)).toBeDefined()
  })

  it('caps queue plus in-flight at 32 and bounds rejection tombstones', async () => {
    const f = fixture()
    const key = peer()
    const pending = Array.from({ length: 32 }, (_, index) => f.queue.request({ ...key, deviceId: `p${index}` })!)
    expect(() => f.queue.request({ ...key, deviceId: 'overflow' })).toThrow('full')
    const gate = deferred()
    f.trustPeer.mockImplementation(async input => { await gate.promise; return { ...input, fingerprint: 'fp', trustedAt: 1 } })
    const approval = f.queue.approve(pending[0]!)
    expect(() => f.queue.request({ ...key, deviceId: 'overflow' })).toThrow('full')
    gate.resolve()
    await approval
    f.queue.request({ ...key, deviceId: 'overflow' })
    for (const dto of f.queue.list()) f.queue.reject(dto)
    for (let index = 0; index < 100; index++) {
      const dto = f.queue.request({ ...key, deviceId: `churn${index}` })!
      f.queue.reject(dto)
    }
    expect((f.queue as unknown as { tombstones: Map<string, number> }).tombstones.size).toBe(32)
  })

  it('publishes removal only after manual persistence; rejects duplicates and busy churn synchronously', async () => {
    const updates: number[] = []
    const f = fixture({ onChange: list => { updates.push(list.length) } })
    const input = peer()
    const pending = f.queue.request(input)!
    const gate = deferred()
    f.trustPeer.mockImplementation(async stored => { await gate.promise; return { ...stored, fingerprint: 'fp', trustedAt: 1 } })
    const approval = f.queue.approve(pending)
    await expect(f.queue.approve(pending)).rejects.toThrow('busy')
    expect(() => f.queue.reject(pending)).toThrow('busy')
    expect(() => f.queue.request(peer())).toThrow('busy')
    expect(f.queue.list()).toHaveLength(1)
    expect(updates).toEqual([1])
    await Promise.resolve()
    expect(f.trustPeer).toHaveBeenCalledWith(input, { provenance: 'manual' })
    gate.resolve()
    expect((await approval).publicKey).toBe(input.publicKey)
    expect(f.queue.list()).toEqual([])
    expect(updates).toEqual([1, 0])
  })

  it('serializes distinct accepted commits and retains accepted flights through TTL expiry', async () => {
    const f = fixture()
    const firstInput = peer('first')
    const first = f.queue.request(firstInput)!
    const second = f.queue.request(peer('second'))!
    const gate = deferred()
    f.trustPeer.mockImplementation(async input => {
      await gate.promise
      return { ...input, fingerprint: 'fp', trustedAt: 1 }
    })
    const firstApproval = f.queue.approve(first)
    const secondApproval = f.queue.approve(second)
    firstInput.publicKey = peer().publicKey
    firstInput.membershipId = 'mutated'
    await Promise.resolve()
    expect(f.trustPeer).toHaveBeenCalledTimes(1)
    expect(f.trustPeer.mock.calls[0]![0].membershipId).toBe('member')
    expect(createHash('sha256').update(Buffer.from(f.trustPeer.mock.calls[0]![0].publicKey, 'base64url')).digest('hex').toUpperCase()).toBe(first.fullFingerprint)
    f.advance(300_001)
    expect(f.queue.list()).toHaveLength(2)
    gate.resolve()
    await Promise.all([firstApproval, secondApproval])
    expect(f.trustPeer).toHaveBeenCalledTimes(2)
    expect(f.queue.list()).toEqual([])
  })

  it('store failures retain pending and block indeterminate authority without retry', async () => {
    const f = fixture()
    const pending = f.queue.request(peer())!
    f.trustPeer.mockRejectedValue(new Error('disk failed'))
    await expect(f.queue.approve(pending)).rejects.toThrow('disk failed')
    expect(f.queue.list()).toHaveLength(1)
    await expect(f.queue.approve(pending)).rejects.toThrow('indeterminate')
    expect(() => f.queue.request(peer('other'))).toThrow('indeterminate')
    expect(() => f.queue.reject(pending)).toThrow('indeterminate')
    expect(f.trustPeer).toHaveBeenCalledTimes(1)
  })

  it('close rejects new actions immediately and awaits accepted persistence', async () => {
    const f = fixture()
    const pending = f.queue.request(peer())!
    const gate = deferred()
    f.trustPeer.mockImplementation(async input => { await gate.promise; return { ...input, fingerprint: 'fp', trustedAt: 1 } })
    const approval = f.queue.approve(pending)
    let closed = false
    const closing = f.queue.close().then(() => { closed = true })
    expect(() => f.queue.request(peer())).toThrow('closed')
    expect(() => f.queue.reject(pending)).toThrow('closed')
    await expect(f.queue.approve(pending)).rejects.toThrow('closed')
    expect(closed).toBe(false)
    gate.resolve()
    await approval
    await closing
    expect(closed).toBe(true)
    expect(f.queue.list()).toEqual([])
  })

  it('known legacy exact pins are read-only, changed keys never overwrite', async () => {
    const f = fixture()
    const input = peer()
    const legacy = { ...input, fingerprint: 'ABCD EFGH IJKL', trustedAt: 12 }
    f.pins.set(input.deviceId, legacy)
    expect(f.queue.request(input)).toBeUndefined()
    expect(f.queue.list()).toEqual([])
    expect(() => f.queue.request(peer())).toThrow('key changed')
    expect(f.trustPeer).not.toHaveBeenCalled()
    expect(f.pins.get(input.deviceId)).toEqual(legacy)
    f.pins.clear()
    const pending = f.queue.request(input)!
    f.pins.set(input.deviceId, { ...legacy, publicKey: peer().publicKey })
    await expect(f.queue.approve(pending)).rejects.toThrow('key changed')
    expect(f.trustPeer).not.toHaveBeenCalled()
  })

  it('binds generation to each instance, validates keys, clamps clock rollback, and isolates observers', async () => {
    const f = fixture({ onChange: () => { throw new Error('observer') } })
    const input = peer()
    const pending = f.queue.request(input)!
    const other = new PeerApprovalQueue(f.store, { epochId: 'owner-epoch', role: 'client' })
    other.request(input)
    await expect(other.approve(pending)).rejects.toThrow('stale')
    expect(() => f.queue.request({ ...input, publicKey: 'bad' })).toThrow('public key')
    f.advance(-100)
    expect(f.queue.request(peer('second'))!.createdAt).toBe(pending.createdAt)
    await expect(f.queue.approve(pending)).resolves.toMatchObject({ publicKey: input.publicKey })
  })
})
