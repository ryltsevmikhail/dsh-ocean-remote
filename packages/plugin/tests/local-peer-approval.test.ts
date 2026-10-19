import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPair } from '@dsh-remote/crypto'
import { PluginControlRuntime } from '../src/control-runtime.js'
import { resolveConfig } from '../src/config.js'
import { fingerprint } from '../src/identity-store.js'
import { PeerApprovalQueue } from '../src/peer-approval.js'
import type { TrustedPeer } from '../src/identity-store.js'
import type { ClientModeRuntime, HostAuthorizationControl, HostConnectionHandle } from '../src/client-runtime.js'
import type { ControlRouteHandler } from '../src/control-route.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
function fixture(role: 'host' | 'client') {
  const peers = new Map<string, TrustedPeer>()
  const store = {
    trustedPeer: (id: string) => peers.get(id),
    trustPeer: vi.fn(async (input: Omit<TrustedPeer, 'fingerprint' | 'trustedAt'>) => {
      const peer: TrustedPeer = { ...input, fingerprint: fingerprint(input.publicKey), trustedAt: Date.now(), provenance: 'manual' }
      peers.set(peer.deviceId, peer)
      return peer
    }),
  }
  const queue = new PeerApprovalQueue(store, { epochId: 'current-entry', role })
  const pending = queue.request({ deviceId: 'candidate', name: 'Candidate', platform: 'linux', publicKey: generateKeyPair().publicKey })!
  const facade = {
    peerTrustStatus: () => ({ role, epochId: 'current-entry', available: true, pending: queue.list(), trusted: [] }),
    approvePeer: queue.approve.bind(queue), rejectPeer: queue.reject.bind(queue),
  }
  const runtime = new PluginControlRuntime(resolveConfig({ enabled: true, role, serverUrl: 'https://relay.example.test', codex: { enabled: false }, acp: { enabled: false } }),
    '/unused-test-directory', undefined,
    role === 'client' ? facade as unknown as ClientModeRuntime : undefined,
    role === 'host' ? facade as unknown as HostAuthorizationControl : undefined)
  cleanup.push(() => queue.close())
  return { peers, store, queue, pending, runtime }
}
const wire = (method: string, payload: unknown) => ({ type: 'client-request', rpcId: 'test-local-only', method, payload })
describe('manual peer approval local carrier boundary', () => {
  it.each(['host', 'client'] as const)('never mutates %s trust through RPC fallback, even with forged authority', async role => {
    const f = fixture(role)
    let handler!: ControlRouteHandler
    const connection = { rpc: { handle: (_channel: string, next: ControlRouteHandler) => { handler = next; return async () => {} } } } as unknown as HostConnectionHandle
    const dispose = f.runtime.register(connection)
    cleanup.push(dispose)
    const payload = { role, deviceId: f.pending.deviceId, generation: f.pending.generation, fullFingerprint: f.pending.fullFingerprint, localApproval: true }
    for (const method of ['trust.approve', 'trust.reject']) {
      const result = await handler(method, payload, new AbortController().signal, { localApproval: true })
      expect(result).toMatchObject({ ok: false, error: { details: { remoteCode: 'LOCAL_APPROVAL_REQUIRED' } } })
    }
    expect(f.store.trustPeer).not.toHaveBeenCalled()
    expect(f.queue.list()).toHaveLength(1)
    expect(await handler('trust.status', {}, new AbortController().signal)).toMatchObject({ ok: true, value: { localApproval: false } })
  })

  it.each(['host', 'client'] as const)('requires actual local HTTP plus exact %s generation/full hash', async role => {
    const f = fixture(role)
    let route!: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
    const connection = { requestRejection: (req: { headers: Record<string, unknown> }) => req.headers.cookie === 'local-owner' ? undefined : 401,
      rpc: { handle: vi.fn() } } as unknown as HostConnectionHandle
    const dispose = f.runtime.register(connection, { register: value => { route = value.handler; return () => {} } })
    cleanup.push(dispose)
    const server = createServer((req, res) => { void route(req, res) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
    const port = (server.address() as { port: number }).port
    const send = (payload: unknown, origin = `http://127.0.0.1:${port}`) => new Promise<{ result: { ok: boolean } }>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path: '/ds-harness-remote/trust.approve', method: 'POST',
        headers: { cookie: 'local-owner', origin, 'content-type': 'application/json' } }, response => {
        let body = ''; response.setEncoding('utf8'); response.on('data', data => { body += data }); response.on('end', () => resolve(JSON.parse(body)))
      })
      req.on('error', reject); req.end(JSON.stringify(wire('trust.approve', payload)))
    })
    const action = { role, deviceId: f.pending.deviceId, generation: f.pending.generation, fullFingerprint: f.pending.fullFingerprint }
    expect((await send(action, 'http://untrusted.example')).result.ok).toBe(false)
    expect((await send({ ...action, fullFingerprint: action.fullFingerprint.slice(0, 12) })).result.ok).toBe(false)
    expect((await send({ ...action, fullFingerprint: action.fullFingerprint.toLowerCase() })).result.ok).toBe(false)
    expect((await send({ ...action, generation: 'previous-entry' })).result.ok).toBe(false)
    expect(f.store.trustPeer).not.toHaveBeenCalled()
    expect((await send(action)).result.ok).toBe(true)
    expect(f.store.trustPeer).toHaveBeenCalledOnce()
    expect(f.peers.get(action.deviceId)?.provenance).toBe('manual')
    expect((await send(action)).result.ok).toBe(false)
  })
})
