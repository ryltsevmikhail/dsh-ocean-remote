import { describe, expect, it, vi } from 'vitest'
import { ClientConnection, type ClientConnectionContext } from '../src/client-connection.js'
import { HostServerConnection } from '../src/server-connection.js'

const descriptor = { deviceId: 'host-1', role: 'host', membershipId: 'member-1', identityKey: 'key', name: 'New name', platform: 'linux' }
const listed = { ...descriptor } as any
function fixture(existing?: any) {
  const request = vi.fn()
  const trustPeer = vi.fn()
  const context = {
    connectionProgressRun: 0,
    requireIdentity: () => ({}),
    server: { listDevices: async () => [listed], deviceFor: vi.fn(async () => descriptor), presenceFor: vi.fn(), authenticate: vi.fn() },
    identities: { trustedPeer: () => existing, trustPeer },
    peerApprovals: { request },
  } as unknown as ClientConnectionContext
  return { context, request, trustPeer, connection: new ClientConnection(context) }
}

describe('low-level peer approval gates', () => {
  it('rejects unknown Host before presence, authentication or transport and sanitizes the queue input', async () => {
    const f = fixture()
    await expect(f.connection.connect('host-1')).rejects.toMatchObject({ code: 'PEER_APPROVAL_REQUIRED' })
    expect(f.request).toHaveBeenCalledWith({ deviceId: 'host-1', membershipId: 'member-1', publicKey: 'key', name: 'New name', platform: 'linux' })
    expect(f.context.server.authenticate).not.toHaveBeenCalled()
    expect(f.context.server.presenceFor).not.toHaveBeenCalled()
    expect(f.trustPeer).not.toHaveBeenCalled()
  })
  it('fails closed without a queue or when the queue rejects', async () => {
    for (const queue of [undefined, { request: () => { throw new Error('full') } }]) {
      const f = fixture()
      Object.assign(f.context, { peerApprovals: queue })
      await expect(f.connection.authorizeHostPeer(listed)).rejects.toMatchObject({ code: 'PEER_APPROVAL_REQUIRED' })
      expect(f.trustPeer).not.toHaveBeenCalled()
    }
  })
  it('passively classifies unknown and conflicting Hosts without queueing or writing', async () => {
    for (const [peer, state] of [[undefined, 'unknown'], [{ publicKey: 'changed' }, 'conflict']] as const) {
      const f = fixture(peer)
      expect(await f.connection.validateHostPeer(listed)).toBe(state)
      expect(f.request).not.toHaveBeenCalled()
      expect(f.trustPeer).not.toHaveBeenCalled()
    }
  })
  it('returns exact legacy pin untouched and rejects changed keys', async () => {
    const legacy = { deviceId: 'host-1', publicKey: 'key', name: 'Old name', trustedAt: 123 }
    const f = fixture(legacy)
    expect(await f.connection.authorizeHostPeer(listed)).toBe(legacy)
    expect(legacy.trustedAt).toBe(123)
    expect(f.trustPeer).not.toHaveBeenCalled()
    expect(f.request).not.toHaveBeenCalled()
    await expect(fixture({ publicKey: 'different' }).connection.authorizeHostPeer(listed)).rejects.toMatchObject({ code: 'PEER_IDENTITY_MISMATCH' })
  })
  it('does not enqueue after descriptor await when aborted, superseded or closed', async () => {
    for (const action of ['abort', 'supersede', 'close']) {
      const f = fixture()
      let resolve!: (value: any) => void
      vi.mocked(f.context.server.deviceFor).mockImplementation(() => new Promise(r => { resolve = r }))
      const abort = new AbortController()
      const result = f.connection.connect('host-1', abort.signal)
      const outcome = expect(result).rejects.toBeDefined()
      await Promise.resolve()
      if (action === 'abort') abort.abort()
      if (action === 'supersede') f.context.connectionProgressRun++
      if (action === 'close') Object.assign(f.context, { isActive: () => false })
      resolve(descriptor)
      await outcome
      expect(f.request).not.toHaveBeenCalled()
      expect(f.trustPeer).not.toHaveBeenCalled()
    }
  })

  it('rejects unknown Client before Noise/tunnel creation, including unavailable queues', async () => {
    for (const mode of ['queue', 'absent', 'full']) {
      const request = vi.fn(() => { if (mode === 'full') throw new Error('full') })
      const trustPeer = vi.fn()
      const send = vi.fn()
      const host = new HostServerConnection({} as any, {} as any,
        { trustedPeer: () => undefined, trustPeer } as any,
        { deviceFor: async () => ({ ...descriptor, role: 'client', deviceId: 'client-1' }) } as any,
        {} as any, { warn: vi.fn() } as any, undefined, undefined, undefined, undefined,
        mode === 'absent' ? undefined : { request } as any)
      Object.assign(host, { stopped: false, socket: { readyState: 1, send } })
      await (host as any).handleConnectIncoming({ connectionId: 'c', clientDeviceId: 'client-1', clientIdentityKey: 'key', preferredTransports: ['relay'] })
      expect((host as any).tunnels.size).toBe(0)
      expect(trustPeer).not.toHaveBeenCalled()
      expect(send).toHaveBeenCalledOnce()
      expect(JSON.parse(send.mock.calls[0]![0]).type).toBe('connect.rejected')
    }
  })

  it('rejects changed Client keys without queueing or creating Noise', async () => {
    const request = vi.fn()
    const send = vi.fn()
    const trustPeer = vi.fn()
    const host = new HostServerConnection({} as any, {} as any,
      { trustedPeer: () => ({ publicKey: 'old-key', trustedAt: 1 }), trustPeer } as any,
      { deviceFor: async () => ({ ...descriptor, role: 'client', deviceId: 'client-1' }) } as any,
      {} as any, { warn: vi.fn() } as any, undefined, undefined, undefined, undefined, { request } as any)
    Object.assign(host, { stopped: false, socket: { readyState: 1, send } })
    await (host as any).handleConnectIncoming({ connectionId: 'c', clientDeviceId: 'client-1', clientIdentityKey: 'key' })
    expect(request).not.toHaveBeenCalled()
    expect(trustPeer).not.toHaveBeenCalled()
    expect((host as any).tunnels.size).toBe(0)
    expect(JSON.parse(send.mock.calls[0]![0]).type).toBe('connect.rejected')
  })

  it('ignores stale Host authorization after stop or control socket replacement', async () => {
    for (const action of ['stop', 'replace']) {
      let resolve!: (value: any) => void
      const request = vi.fn()
      const send = vi.fn()
      const host = new HostServerConnection({} as any, {} as any, { trustedPeer: vi.fn() } as any,
        { deviceFor: () => new Promise(r => { resolve = r }) } as any,
        { close: vi.fn(async () => {}) } as any, { warn: vi.fn() } as any, undefined, undefined, undefined, undefined, { request } as any)
      Object.assign(host, { stopped: false, socket: { readyState: 1, send, close: vi.fn() } })
      const pending = (host as any).handleConnectIncoming({ connectionId: 'c', clientDeviceId: 'client-1', clientIdentityKey: 'key' })
      if (action === 'stop') await host.stop()
      else Object.assign(host, { socket: { readyState: 1, send }, controlGeneration: 1 })
      resolve({ ...descriptor, role: 'client', deviceId: 'client-1' })
      await pending
      expect(request).not.toHaveBeenCalled()
      expect(send).not.toHaveBeenCalled()
      expect((host as any).tunnels.size).toBe(0)
    }
  })
})
