import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { Socket, isIP } from 'node:net'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'

import { CONTROL_RPC_PREFIX, STATUS_STREAM_ENDPOINT } from './control-constants.js'
export { CONTROL_RPC_PREFIX, STATUS_STREAM_ENDPOINT, STATUS_STREAM_PATH } from './control-constants.js'

const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/
const INVALID_REQUEST_RPC_ID = 'invalid-request'

interface HostConnectionHandleLike {
  requestRejection?(request: { headers: IncomingHttpHeaders }): number | undefined
  rpc: {
    handle(
      channel: string,
      handler: ControlRouteHandler,
      options: { authority: 'loopback' | 'trusted-host' },
    ): () => Promise<void>
  }
}

export interface HostWebServerLike {
  register(route: {
    kind: 'prefix'
    path: string
    handler(req: IncomingMessage, res: ServerResponse): void | Promise<void>
  }): () => void | Promise<void>
}

/** Transport-derived authority, never accepted from RPC payloads or router tags. */
export interface ControlInvocationAuthority { localApproval: boolean }

export type ControlRouteHandler = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
  authority?: ControlInvocationAuthority,
) => Promise<RpcResult<unknown>>

/** Long-lived loopback response owner for the status event stream. */
export interface ControlStatusStreamLike {
  handle(response: ServerResponse): Promise<void>
  close(): void
}

export function registerControlRoute(
  connection: HostConnectionHandleLike,
  handler: ControlRouteHandler,
  webServer?: HostWebServerLike,
  statusStream?: ControlStatusStreamLike,
): () => Promise<void> {
  if (webServer !== undefined && connection.requestRejection !== undefined) {
    const dispose = webServer.register({
      kind: 'prefix',
      path: CONTROL_RPC_PREFIX,
      handler: (req, res) => handleControlRequest(connection, handler, req, res, statusStream),
    })
    return async () => {
      statusStream?.close()
      await dispose()
    }
  }

  // A plain RPC channel owns POST only, so the browser falls back to unary
  // status reads on hosts that do not expose the Web server route.
  return connection.rpc.handle(CONTROL_RPC_PREFIX, (endpoint, payload, signal) =>
    handler(endpoint, payload, signal, { localApproval: false }), {
    authority: 'loopback',
  })
}

async function handleControlRequest(
  connection: HostConnectionHandleLike,
  handler: ControlRouteHandler,
  req: IncomingMessage,
  res: ServerResponse,
  statusStream?: ControlStatusStreamLike,
): Promise<void> {
  const rejection = connection.requestRejection?.(req)
  if (rejection !== undefined) {
    res.writeHead(rejection)
    res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
    return
  }

  const endpoint = endpointFromPath(CONTROL_RPC_PREFIX, new URL(req.url ?? '/', 'http://dsh.internal').pathname)
  if (req.method === 'GET' && endpoint === STATUS_STREAM_ENDPOINT && statusStream !== undefined) {
    await statusStream.handle(res)
    return
  }
  if (req.method !== 'POST' || endpoint === undefined) {
    writeText(res, 404, 'not found')
    return
  }
  if (contentType(req.headers) !== 'application/json') {
    writeText(res, 415, 'content type must be application/json')
    return
  }

  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch {
    writeText(res, 400, 'body is not JSON')
    return
  }

  const message = clientRequest(body)
  if (message === undefined) {
    writeJson(res, 200, errorResponse(rpcId(body), {
      code: 'gateway/bad-request',
      message: 'invalid client-request message',
      details: { issues: [] },
    }))
    return
  }
  if (message.method !== endpoint) {
    writeJson(res, 200, errorResponse(message.rpcId, {
      code: 'gateway/bad-request',
      message: `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
      details: { issues: [] },
    }))
    return
  }

  try {
    const result = await handler(endpoint, message.payload, requestSignal(req), {
      localApproval: connection.requestRejection !== undefined && localApprovalRequest(req),
    })
    writeJson(res, 200, fullResponse(message.rpcId, result))
  } catch (error) {
    writeText(res, 500, `handler failure: ${String(error)}`)
  }
}

function loopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  const value = address.toLowerCase()
  if (value === '::1') return true
  const ipv4 = value.startsWith('::ffff:') ? value.slice(7) : value
  return isIP(ipv4) === 4 && ipv4.startsWith('127.')
}

function localApprovalRequest(req: IncomingMessage): boolean {
  const socket = req.socket
  if (!(socket instanceof Socket) || !loopbackAddress(socket.remoteAddress) ||
      !loopbackAddress(socket.localAddress) || !socket.localPort || socket.localPort <= 0) return false
  if (Object.keys(req.headers).some(name => name.toLowerCase() === 'forwarded' || name.toLowerCase().startsWith('x-forwarded'))) return false
  const site = req.headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false
  const host = req.headers.host
  const origin = req.headers.origin
  if (typeof host !== 'string' || typeof origin !== 'string') return false
  // Require canonical authority spelling and an explicit matching listening port.
  const match = /^(localhost|127(?:\.[0-9]{1,3}){3}|\[::1\]):([1-9][0-9]*)$/.exec(host)
  if (!match || Number(match[2]) !== socket.localPort) return false
  if (match[1] !== 'localhost' && match[1] !== '[::1]' && !loopbackAddress(match[1])) return false
  return origin === `http://${host}` || origin === `https://${host}`
}

function endpointFromPath(channel: string, pathname: string): string | undefined {
  if (!pathname.startsWith(`${channel}/`)) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  if (endpoint.split('/').some(segment => segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
    return undefined
  }
  return endpoint
}

function contentType(headers: IncomingHttpHeaders): string | undefined {
  const raw = headers['content-type']
  const value = Array.isArray(raw) ? raw[0] : raw
  return value?.split(';', 1)[0]?.trim().toLowerCase()
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function requestSignal(req: IncomingMessage): AbortSignal {
  const abort = new AbortController()
  req.on('close', () => {
    if (!req.complete) abort.abort()
  })
  return abort.signal
}

interface ClientRequestWire {
  type: 'client-request'
  rpcId: string
  method: string
  payload: unknown
}

function clientRequest(value: unknown): ClientRequestWire | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.type !== 'client-request' || typeof record.rpcId !== 'string' || typeof record.method !== 'string') return undefined
  return { type: 'client-request', rpcId: record.rpcId, method: record.method, payload: record.payload }
}

function rpcId(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return INVALID_REQUEST_RPC_ID
  const record = value as Record<string, unknown>
  return typeof record.rpcId === 'string' ? record.rpcId : INVALID_REQUEST_RPC_ID
}

function errorResponse(rpcId: string, error: { code: string; message: string; details: Record<string, unknown> }): Record<string, unknown> {
  return fullResponse(rpcId, { ok: false, error })
}

function fullResponse(rpcId: string, result: unknown): Record<string, unknown> {
  return { type: 'server-response', rpcId, result }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function writeText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status)
  res.end(body)
}
