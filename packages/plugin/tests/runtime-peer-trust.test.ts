import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.js'
import type { SafeLogger } from '../src/logging.js'
import { IdentityStore, fullFingerprint } from '../src/identity-store.js'
import { HostPluginRuntime } from '../src/service.js'
import { ClientModeRuntime } from '../src/client-runtime.js'
import type { PeerApprovalQueue } from '../src/peer-approval.js'
import type { ClientServerApi } from '../src/server-api.js'
import type { TypertGatewayLike } from '../src/typert-gateway-contract.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as SafeLogger
async function fixture(role: 'host' | 'client') {
  const directory = await mkdtemp(join(tmpdir(), 'runtime-peer-trust-')); directories.push(directory)
  const store = new IdentityStore({ directory })
  const config = resolveConfig({ role, codex: { enabled: false }, acp: { enabled: false }, hostControl: { enabled: false } })
  const runtime = role === 'host'
    ? new HostPluginRuntime(config, store, undefined, logger)
    : new ClientModeRuntime(config, store, { bindIdentity: vi.fn(), close: vi.fn() } as unknown as ClientServerApi, undefined, { invoke: vi.fn(async () => undefined) } as unknown as TypertGatewayLike, logger)
  return { runtime, store, directory }
}
const peer = { deviceId: 'phone', name: 'Phone', platform: 'test', publicKey: Buffer.alloc(32, 7).toString('base64url') }
function queue(runtime: HostPluginRuntime | ClientModeRuntime): PeerApprovalQueue {
  return (runtime as unknown as { peerApprovals: PeerApprovalQueue }).peerApprovals
}

describe('runtime peer trust authority', () => {
  for (const role of ['host', 'client'] as const) {
    it(`${role} projects safe DTOs and requires an explicit full-fingerprint approval`, async () => {
      const { runtime, store } = await fixture(role)
      expect(runtime.peerTrustStatus()).toMatchObject({ role, available: false, pending: [], trusted: [] })
      await expect(runtime.approvePeer({ deviceId: 'phone', generation: 'x', fullFingerprint: 'x' })).rejects.toMatchObject({ code: 'PEER_APPROVAL_UNAVAILABLE' })
      try {
        await runtime.start()
        const candidate = queue(runtime).request(peer)!
        expect(store.trustedPeer(peer.deviceId)).toBeUndefined()
        expect(runtime.peerTrustStatus().pending).toEqual([candidate])
        await runtime.approvePeer({ ...candidate, fullFingerprint: fullFingerprint(peer.publicKey) })
        expect(runtime.peerTrustStatus().trusted[0]).toMatchObject({ provenance: 'manual', fullFingerprint: fullFingerprint(peer.publicKey) })
        expect(JSON.stringify(runtime.peerTrustStatus())).not.toMatch(/privateKey|publicKey/)
        const oldQueue = queue(runtime)
        await runtime.invalidatePeerApprovals()
        expect(() => oldQueue.request({ ...peer, deviceId: 'other' })).toThrow()
        expect(() => runtime.rejectPeer(candidate)).toThrow(expect.objectContaining({ code: 'PEER_APPROVAL_UNAVAILABLE' }))
      } finally { await runtime.close() }
    })

    it(`${role} releases the identity lease even when resource cleanup fails`, async () => {
      const { runtime, store, directory } = await fixture(role)
      await runtime.start()
      const closeStore = vi.spyOn(store, 'close')
      if (role === 'host') vi.spyOn((runtime as HostPluginRuntime).connections, 'close').mockRejectedValue(new Error('cleanup failed'))
      else (runtime as unknown as { server: { close: () => void } }).server.close = () => { throw new Error('cleanup failed') }
      const first = runtime.close()
      expect(runtime.close()).toBe(first)
      await expect(first).rejects.toThrow()
      expect(closeStore).toHaveBeenCalledTimes(1)
      const reopened = new IdentityStore({ directory })
      try { await expect(reopened.loadOrCreate('reopened')).resolves.toBeDefined() } finally { await reopened.close() }
      expect(runtime.peerTrustStatus().available).toBe(false)
    })
  }

  it('drains accepted approval before durable revocation and keeps failures closed', async () => {
    const { runtime, store } = await fixture('host')
    const host = runtime as HostPluginRuntime
    try {
      await host.start()
      const oldEpoch = host.peerTrustStatus().epochId
      const candidate = queue(host).request(peer)!
      const approval = host.approvePeer(candidate)
      const revocation = host.revokePeer(peer.deviceId)
      expect(host.peerTrustStatus().available).toBe(false)
      await approval
      await expect(revocation).resolves.toBe(true)
      expect(store.trustedPeer(peer.deviceId)).toBeUndefined()
      expect(host.peerTrustStatus().epochId).not.toBe(oldEpoch)
      const next = queue(host).request(peer)!
      vi.spyOn(store, 'revokePeer').mockRejectedValueOnce(new Error('durability failed'))
      await expect(host.revokePeer(peer.deviceId)).rejects.toThrow('durability failed')
      // A failed revocation must not leave the Host unable to approve anything.
      expect(host.peerTrustStatus().available).toBe(true)
      // The queue was renewed, so a fresh candidate is required.
      await expect(host.approvePeer(queue(host).request(peer)!)).resolves.toMatchObject({ deviceId: peer.deviceId })
    } finally { await host.close() }
  })

  it('does not relabel an exact legacy pin as manual', async () => {
    const { runtime, store } = await fixture('host')
    try {
      await runtime.start()
      await store.trustPeer(peer)
      expect(queue(runtime).request(peer)).toBeUndefined()
      expect(runtime.peerTrustStatus().trusted[0]?.provenance).toBe('legacy')
    } finally { await runtime.close() }
  })
})
