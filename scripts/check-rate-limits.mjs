#!/usr/bin/env node
// Verifies the self-hosted Ocean rate limits on a throwaway local server:
// 20 login attempts per minute and 240 API requests per minute, keyed by socket IP.
// No external services, no real credentials.
//
// Usage: node scripts/check-rate-limits.mjs

import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ACCOUNT = 'limits@example.invalid'
const PASSWORD = 'limits-check-password'
const LOGIN_LIMIT = 20
const API_LIMIT = 240
const serverPath = new URL('../apps/server/dist/server.js', import.meta.url).pathname

const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer()
  probe.once('error', reject)
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address()
    probe.close(() => resolve(port))
  })
})

async function withServer(run) {
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const directory = await mkdtemp(join(tmpdir(), 'ocean-limits-'))
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createRemoteServer } from ${JSON.stringify(pathToFileURL(serverPath).href)}
    const app = createRemoteServer({ account: ${JSON.stringify(ACCOUNT)}, password: ${JSON.stringify(PASSWORD)}, dataFile: ${JSON.stringify(join(directory, 'state.json'))}, publicUrl: ${JSON.stringify(origin)} })
    app.server.listen(${port}, '127.0.0.1', () => console.log('ready'))
    process.on('SIGTERM', () => { void app.close().then(() => process.exit(0)) })
  `], { stdio: ['ignore', 'pipe', 'pipe'] })
  const stop = async () => {
    const exited = new Promise(resolve => child.once('exit', resolve))
    child.kill('SIGTERM')
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 5_000)
    await exited
    clearTimeout(timer)
  }
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not start')), 30_000)
      child.stdout.on('data', chunk => { if (String(chunk).includes('ready')) { clearTimeout(timer); resolve() } })
      child.once('exit', code => reject(new Error(`server exited early (${code})`)))
    })
    return await run(origin)
  } finally {
    // Never leak a child process or a temp directory, even on failure.
    await stop().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
}

const post = async (origin, path, body) => {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  return { status: response.status, cookies: response.headers.get('set-cookie') }
}

const results = {}
const API_BUDGET_AFTER_LOGIN = API_LIMIT - 1

// 1. Login limit: the first LOGIN_LIMIT attempts pass the limiter (401), then 429.
results.login = await withServer(async origin => {
  const statuses = []
  for (let attempt = 0; attempt < LOGIN_LIMIT + 3; attempt += 1) {
    statuses.push((await post(origin, '/api/v1/auth/login', { email: ACCOUNT, password: 'wrong-password-000' })).status)
  }
  const firstLimited = statuses.indexOf(429)
  const healthAfter = await fetch(`${origin}/healthz`)
  return { statuses, firstLimited, healthStaysOk: healthAfter.status === 200 }
})

// 2. API limit: the login itself consumes one of the 240 slots, and health stays open.
results.api = await withServer(async origin => {
  const login = await post(origin, '/api/v1/auth/login', { email: ACCOUNT, password: PASSWORD })
  const cookie = (login.cookies ?? '').split(';')[0]
  let firstLimited = -1
  let successCount = 0
  for (let attempt = 0; attempt < API_LIMIT + 5; attempt += 1) {
    const response = await fetch(`${origin}/api/v1/account/devices`, { headers: { cookie } })
    if (response.status === 429) { firstLimited = attempt; break }
    if (response.status === 200) successCount += 1
  }
  const health = await fetch(`${origin}/healthz`)
  return { firstLimited, successCount, healthStaysOk: health.status === 200 }
})

const failures = []
if (results.login.firstLimited !== LOGIN_LIMIT) failures.push(`login limiter fired at attempt ${results.login.firstLimited}, expected ${LOGIN_LIMIT + 1}`)
if (!results.login.statuses.slice(0, LOGIN_LIMIT).every(status => status === 401)) failures.push('login rejected valid attempts too early')
if (!results.login.healthStaysOk) failures.push('/healthz was rate limited')
if (results.api.successCount !== API_BUDGET_AFTER_LOGIN) failures.push(`API allowed ${results.api.successCount} requests, expected ${API_BUDGET_AFTER_LOGIN} after the login slot`)
if (results.api.firstLimited !== API_BUDGET_AFTER_LOGIN) failures.push(`API limiter fired at request ${results.api.firstLimited}, expected ${API_BUDGET_AFTER_LOGIN}`)
if (!results.api.healthStaysOk) failures.push('/healthz was rate limited during API load')

results.api.budgetAfterLogin = API_BUDGET_AFTER_LOGIN
console.log(JSON.stringify(results, null, 2))
if (failures.length > 0) {
  console.error(`\nRate limit failures:\n- ${failures.join('\n- ')}`)
  process.exitCode = 1
} else {
  console.log(`\nRate limits behave as documented: ${LOGIN_LIMIT}/min login, ${API_LIMIT}/min API (login consumes one slot), health checks stay open.`)
}
