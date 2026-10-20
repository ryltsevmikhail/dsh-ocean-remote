#!/usr/bin/env node
// Reproducible browser acceptance for the Ocean console on a throwaway local server.
// No external services and no real credentials: the server is started here with a
// temporary state file, and the device is registered through the public API.
//
// Usage: node scripts/check-console.mjs [--allow-skip]
// Requires a built server (pnpm --filter './apps/server' build) and Playwright.

import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = new URL('..', import.meta.url)
const allowSkip = process.argv.includes('--allow-skip')
const ACCOUNT = 'console-check@example.invalid'
const PASSWORD = 'console-check-password'

async function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT,
    new URL('../.local/browser-check/node_modules/playwright/index.mjs', import.meta.url).href,
    'playwright',
  ].filter(Boolean)
  const problems = []
  for (const candidate of candidates) {
    try { return { module: await import(candidate.startsWith('file:') ? candidate : pathToFileURL(candidate).href) } }
    catch (error) { problems.push(`${candidate}: ${String(error?.message ?? error).slice(0, 120)}`) }
  }
  return { problems }
}

const playwright = await loadPlaywright()
if (playwright.problems !== undefined) {
  console.error('Playwright is not available, so the console was NOT exercised:')
  for (const problem of playwright.problems) console.error(`- ${problem}`)
  if (allowSkip) { console.error('Skipping deliberately (--allow-skip).'); process.exit(0) }
  process.exit(1)
}

const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer()
  probe.once('error', reject)
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address()
    probe.close(() => resolve(port))
  })
})

const port = await freePort()
const origin = `http://127.0.0.1:${port}`
const dataDirectory = await mkdtemp(join(tmpdir(), 'ocean-console-'))
const stateFile = join(dataDirectory, 'state.json')
const serverPath = new URL('../apps/server/dist/server.js', import.meta.url).pathname
const server = spawn(process.execPath, ['--input-type=module', '-e', `
  import { createRemoteServer } from ${JSON.stringify(pathToFileURL(serverPath).href)}
  const app = createRemoteServer({ account: ${JSON.stringify(ACCOUNT)}, password: ${JSON.stringify(PASSWORD)}, dataFile: ${JSON.stringify(stateFile)}, publicUrl: ${JSON.stringify(origin)} })
  app.server.listen(${port}, '127.0.0.1', () => console.log('ready'))
  process.on('SIGTERM', () => { void app.close().then(() => process.exit(0)) })
`], { stdio: ['ignore', 'pipe', 'pipe'] })
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('server did not start')), 30_000)
  server.stdout.on('data', chunk => { if (String(chunk).includes('ready')) { clearTimeout(timer); resolve() } })
  server.once('exit', code => reject(new Error(`server exited early (${code})`)))
})

const results = {}
let browser
try {
  const chromium = playwright.module.chromium
  const executablePath = process.env.CHROME ?? '/usr/bin/google-chrome-stable'
  browser = await chromium.launch({ headless: true, chromiumSandbox: true, args: ['--no-proxy-server'], ...(executablePath === '' ? {} : { executablePath }) })
    .catch(() => chromium.launch({ headless: true, chromiumSandbox: true, args: ['--no-proxy-server'] }))
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(String(error).slice(0, 120)))
  page.on('dialog', dialog => void dialog.accept())

  await page.goto(`${origin}/app/login`, { waitUntil: 'networkidle', timeout: 20_000 })
  await page.getByLabel('Аккаунт', { exact: true }).fill(ACCOUNT)
  await page.getByLabel('Пароль', { exact: true }).fill('wrong-password-000')
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  const alert = page.getByRole('alert')
  await alert.waitFor({ state: 'visible', timeout: 15_000 })
  results.wrongPasswordRejected = page.url().includes('/app/login') && (await alert.innerText()).length > 0

  await page.getByLabel('Пароль', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await page.getByRole('heading', { name: 'Ваши устройства', exact: true }).waitFor({ timeout: 20_000 })
  results.emptyStateShown = await page.getByText('Пока ни одного устройства', { exact: true }).isVisible()

  await page.evaluate(async () => {
    const bytes = new Uint8Array(32)
    crypto.getRandomValues(bytes)
    const identityKey = btoa(String.fromCharCode(...bytes)).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')
    const response = await fetch('/api/v1/devices/register', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ v: 1, device: { deviceId: crypto.randomUUID(), identityKey, name: 'console-check', role: 'host', platform: 'linux', clientVersion: '0.5.13' } }),
    })
    if (!response.ok) throw new Error(`register failed ${response.status}`)
  })
  await page.getByRole('button', { name: 'Обновить', exact: true }).click()
  await page.getByText('console-check', { exact: true }).waitFor({ timeout: 20_000 })
  results.deviceListed = true
  results.offlinePresence = (await page.locator('.device-status.online').count()) === 0
  results.caption = await page.locator('table caption').innerText()

  await page.getByRole('button', { name: /Отозвать устройство/u }).first().click()
  // Wait for the table to become empty: the account e-mail contains the device name,
  // so a text match would never disappear.
  await page.waitForFunction(() => document.querySelectorAll('table tbody tr').length === 0, null, { timeout: 20_000 })
  results.revoked = (await page.evaluate(() => fetch('/api/v1/account/devices', { credentials: 'same-origin' }).then(r => r.json()))).items.length === 0

  await page.getByRole('button', { name: 'Выйти', exact: true }).click()
  await page.getByRole('heading', { name: 'С возвращением', exact: true }).waitFor({ timeout: 20_000 })
  results.logoutReturnedToLogin = page.url().includes('/app/login')
  results.meAfterLogout = await page.evaluate(() => fetch('/api/v1/auth/me', { credentials: 'same-origin' }).then(r => r.status))
  results.pageErrors = pageErrors.length
  await context.close()
} finally {
  if (browser !== undefined) await browser.close().catch(() => undefined)
  server.kill('SIGTERM')
  await rm(dataDirectory, { recursive: true, force: true })
}

const failures = []
if (results.wrongPasswordRejected !== true) failures.push('wrong password was not rejected on the login screen')
if (results.emptyStateShown !== true) failures.push('empty device list was not explained')
if (results.deviceListed !== true) failures.push('registered device did not appear')
if (results.offlinePresence !== true) failures.push('a device without a WebSocket was shown online')
if (results.revoked !== true) failures.push('revoked device stayed in the server list')
if (results.logoutReturnedToLogin !== true) failures.push('logout did not return to the login screen')
if (results.meAfterLogout !== 401) failures.push(`session survived logout (${results.meAfterLogout})`)
if (results.pageErrors !== 0) failures.push(`${results.pageErrors} uncaught page errors`)

console.log(JSON.stringify(results, null, 2))
if (failures.length > 0) {
  console.error(`\nConsole acceptance failures:\n- ${failures.join('\n- ')}`)
  process.exitCode = 1
} else {
  console.log('\nOcean console acceptance passed on a local server.')
}
