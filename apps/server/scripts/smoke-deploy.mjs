import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

// Run against pnpm deploy output, never against an installed DSH profile.
if (!process.argv[2]) throw new Error('Usage: node scripts/smoke-deploy.mjs <deployment-directory>')
const deployment = await realpath(resolve(process.argv[2]))
await stat(join(deployment, 'dist/main.js'))
const temporaryRoot = await realpath(tmpdir())
const temporary = await mkdtemp(join(temporaryRoot, 'ocean-deploy-smoke-'))
const dataFile = join(temporary, 'state.json')
const account = 'smoke@example.invalid'
const password = randomBytes(32).toString('base64url')
let child
let origin
const interrupted = new AbortController()
let cleanupPromise
function cleanup() {
  return cleanupPromise ??= (async () => {
    await stop()
    // Delete only the exact temporary directory this process created.
    assert.equal(dirname(temporary), temporaryRoot)
    assert(basename(temporary).startsWith('ocean-deploy-smoke-'))
    assert.equal(await realpath(temporary), temporary)
    await rm(temporary, { recursive: true, force: true })
  })()
}
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(signal, () => {
    interrupted.abort()
    void cleanup().then(() => process.exit(code), () => process.exit(1))
  })
}

let stopPromise
function stop() {
  if (stopPromise) return stopPromise
  const current = child
  if (!current) return Promise.resolve()
  stopPromise = (async () => {
    if (current.exitCode !== null || current.signalCode !== null) return
    const exited = once(current, 'exit')
    current.kill('SIGTERM')
    const force = setTimeout(() => current.kill('SIGKILL'), 5000)
    force.unref()
    try { await exited } finally { clearTimeout(force) }
  })().finally(() => {
    if (child === current) child = undefined
    stopPromise = undefined
  })
  return stopPromise
}
async function start() {
  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const port = reservation.address().port
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
  origin = `http://127.0.0.1:${port}`
  interrupted.signal.throwIfAborted()
  child = spawn(process.execPath, [join(deployment, 'dist/main.js')], {
    cwd: deployment,
    env: { ...process.env, NODE_ENV: 'production', DSH_SERVER_HOST: '127.0.0.1', DSH_SERVER_PORT: String(port),
      DSH_SERVER_ACCOUNT: account, DSH_SERVER_PASSWORD: password, DSH_SERVER_PUBLIC_URL: origin, DSH_SERVER_DATA_FILE: dataFile },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  let startError
  child.on('error', error => { startError = error })
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    interrupted.signal.throwIfAborted()
    if (startError || child.exitCode !== null || child.signalCode !== null) throw new Error('Deployed server failed to start.')
    try {
      const response = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(500) })
      if (response.ok) return
    } catch { /* bounded readiness retry, not a service restart */ }
    await delay(100)
  }
  throw new Error('Deployed server readiness timed out.')
}
async function request(path, { body, headers = {} } = {}) {
  return fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) })
}
try {
  const license = await readFile(join(deployment, 'dist/LICENSE'), 'utf8')
  const notices = await readFile(join(deployment, 'dist/THIRD_PARTY_NOTICES.txt'), 'utf8')
  assert(license.includes('DSH Remote contributors'), 'Project license missing')
  for (const id of ['ws@8.21.3', 'zod@3.25.76', 'react@18.3.1', 'react-dom@18.3.1', 'scheduler@0.23.2', 'loose-envify@1.4.0', 'js-tokens@4.0.0']) {
    const section = notices.split(`${'='.repeat(72)}\n${id}\n\n`)[1]?.split('='.repeat(72))[0]
    assert(section?.includes('Permission is hereby granted, free of charge'), 'Full audited dependency license missing')
    assert(section.includes('THE SOFTWARE IS PROVIDED'), 'License disclaimer missing')
  }
  assert.deepEqual((await readdir(join(deployment, 'node_modules'))).sort(), ['@dsh-remote', 'ws', 'zod'])
  assert.deepEqual(await readdir(join(deployment, 'node_modules/@dsh-remote')), ['protocol'])
  for (const name of ['ws', 'zod']) {
    const runtimeLicense = await readFile(join(deployment, 'node_modules', name, 'LICENSE'), 'utf8')
    assert(notices.includes(runtimeLicense), 'Runtime LICENSE differs from packaged notices')
  }
  await start()
  for (const path of ['/', '/app/login', '/app/remote']) {
    const response = await request(path, { headers: { 'Sec-Fetch-Site': 'cross-site' } })
    assert.equal(response.status, 200, 'Public console route unavailable')
    assert.match(response.headers.get('content-type'), /text\/html/)
    const html = await response.text()
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"\s]+)"/g)].map(match => match[1])
    assert(assets.length >= 2, 'Built UI assets absent')
    for (const asset of assets) assert.equal((await request(asset)).status, 200, 'Packaged asset unavailable')
  }
  const legal = await request('/THIRD_PARTY_NOTICES.txt')
  assert.equal(legal.status, 200)
  assert.match(legal.headers.get('content-type'), /text\/plain/)
  assert.equal(await legal.text(), notices)
  assert.equal((await request('/api/v1/account/devices')).status, 401)
  assert.equal((await request('/api/v1/auth/login', { body: { email: account, password: 'incorrect-password' } })).status, 401)
  const login = await request('/api/v1/auth/login', { body: { email: account, password } })
  assert.equal(login.status, 200)
  for (const attribute of ['HttpOnly', 'SameSite=Strict', 'Path=/']) {
    assert(login.headers.get('set-cookie')?.includes(attribute), 'Session cookie protection missing')
  }
  const cookie = login.headers.get('set-cookie').split(';')[0]
  assert.equal((await request('/api/v1/account/devices', { headers: { Cookie: cookie } })).status, 200)
  assert.equal((await request('/api/v1/account/devices', { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' } })).status, 403)
  assert.equal((await request('/api/v1/auth/login', { body: { email: account, password }, headers: { Origin: 'https://attacker.invalid' } })).status, 403)
  const registration = await request('/api/v1/devices/register', { headers: { Cookie: cookie }, body: { v: 1, device: {
    deviceId: randomUUID(), role: 'client', name: 'deploy-smoke', platform: 'linux', clientVersion: 'smoke', identityKey: randomBytes(32).toString('base64url'),
  } } })
  assert.equal(registration.status, 200)
  const credentials = await registration.json()
  assert.equal((await request('/api/v1/me', { headers: { Authorization: `Bearer ${credentials.accessToken}` } })).status, 200)
  const state = await readFile(dataFile, 'utf8')
  for (const secret of [password, credentials.accessToken, credentials.refreshToken]) assert(!state.includes(secret), 'Plaintext secret in persisted state')
  if (process.platform !== 'win32') assert.equal((await stat(dataFile)).mode & 0o777, 0o600)
  assert.equal((await request('/api/v1/auth/logout', { body: {}, headers: { Cookie: cookie } })).status, 200)
  assert.equal((await request('/api/v1/account/devices', { headers: { Cookie: cookie } })).status, 401)
  const activeLogin = await request('/api/v1/auth/login', { body: { email: account, password } })
  assert.equal(activeLogin.status, 200)
  const activeCookie = activeLogin.headers.get('set-cookie').split(';')[0]
  assert.equal((await request('/api/v1/account/devices', { headers: { Cookie: activeCookie } })).status, 200)
  await stop()
  await start()
  assert.equal((await request('/api/v1/account/devices', { headers: { Cookie: activeCookie } })).status, 401, 'Restart retained an active web session')
  assert.equal((await request('/api/v1/me', { headers: { Authorization: `Bearer ${credentials.accessToken}` } })).status, 200, 'Device credentials did not survive restart')
  assert.equal((await request('/api/v1/account/devices', { headers: { Cookie: cookie } })).status, 401)
  console.log('PASS: deployed entry/assets/licenses, Cookie auth, cross-site denial, device registration, secret digests, restart persistence')
} finally {
  await cleanup()
}
