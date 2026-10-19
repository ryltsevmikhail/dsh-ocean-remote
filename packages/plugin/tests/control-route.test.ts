import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { registerControlRoute, type ControlRouteHandler } from '../src/control-route.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
const body = JSON.stringify({ type: 'client-request', rpcId: '1', method: 'trust.approve', payload: { localApproval: true } })
describe('control invocation authority', () => {
  it('uses real gated loopback HTTP metadata, not payload flags', async () => {
    let route!: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
    const handler = vi.fn<ControlRouteHandler>(async () => ({ ok: true, value: {} }))
    registerControlRoute({ requestRejection: req => req.headers.cookie === 'session=valid' ? undefined : 401,
      rpc: { handle: vi.fn() } }, handler, { register: value => { route = value.handler; return () => {} } })
    const server = createServer((req, res) => {
      if (req.headers['test-nonlocal']) Object.defineProperty(req.socket, 'remoteAddress', { value: '198.51.100.2' })
      void route(req, res)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
    const port = (server.address() as { port: number }).port
    const send = (headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/ds-harness-remote/trust.approve',
        headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, cookie: 'session=valid', 'content-type': 'application/json', ...headers } }, res => {
        res.resume(); res.on('end', () => resolve(res.statusCode!))
      }); req.on('error', reject); req.end(body)
    })
    expect(await send({})).toBe(200)
    expect(handler.mock.calls.at(-1)?.[3]).toEqual({ localApproval: true })
    for (const headers of ([{ origin: 'http://evil.test' }, { origin: '' }, { forwarded: 'for=127.0.0.1' },
      { 'x-forwarded-anything': 'yes' }, { 'test-nonlocal': 'true' }, { 'sec-fetch-site': 'cross-site' }, { host: `evil.test:${port}` }, { host: '127.0.0.1:1' }] as Array<Record<string, string>>)) {
      expect(await send(headers)).toBe(200)
      expect(handler.mock.calls.at(-1)?.[3]).toEqual({ localApproval: false })
    }
    const count = handler.mock.calls.length
    expect(await send({ cookie: '' })).toBe(401)
    expect(handler).toHaveBeenCalledTimes(count)
    for (const socket of [{ remoteAddress: '127.0.0.1', localAddress: '127.0.0.1', localPort: port },
      { remoteAddress: '198.51.100.2', localAddress: '127.0.0.1', localPort: port }]) {
      const fake = Object.assign(Readable.from([body]), { socket, method: 'POST', url: '/ds-harness-remote/trust.approve',
        headers: { cookie: 'session=valid', host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' } })
      await route(fake as unknown as IncomingMessage, { writeHead() {}, end() {} } as unknown as ServerResponse)
      expect(handler.mock.calls.at(-1)?.[3]).toEqual({ localApproval: false })
    }
  })
  it('overrides forged fallback RPC authority even when the native router ignores options', async () => {
    let rpc!: ControlRouteHandler
    const handler = vi.fn<ControlRouteHandler>(async () => ({ ok: true, value: {} }))
    registerControlRoute({ rpc: { handle: (_channel, callback) => { rpc = callback; return async () => {} } } }, handler)
    await rpc('trust.approve', { localApproval: true }, new AbortController().signal, { localApproval: true })
    expect(handler.mock.calls[0]?.[3]).toEqual({ localApproval: false })
  })
})
