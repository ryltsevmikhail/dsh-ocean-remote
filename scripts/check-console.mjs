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
let server
let stopped = false
const stopServer = async () => {
  if (stopped || server === undefined) return
  stopped = true
  const exited = new Promise(resolve => server.once('exit', resolve))
  server.kill('SIGTERM')
  // Escalate if the child ignores SIGTERM; the exit listener resolves the promise.
  const timer = setTimeout(() => { server.kill('SIGKILL') }, 5_000)
  await exited
  clearTimeout(timer)
}
const serverStderr = []
server = spawn(process.execPath, ['--input-type=module', '-e', `
  import { createRemoteServer } from ${JSON.stringify(pathToFileURL(serverPath).href)}
  const app = createRemoteServer({ account: ${JSON.stringify(ACCOUNT)}, password: ${JSON.stringify(PASSWORD)}, dataFile: ${JSON.stringify(stateFile)}, publicUrl: ${JSON.stringify(origin)} })
  app.server.listen(${port}, '127.0.0.1', () => console.log('ready'))
  process.on('SIGTERM', () => { void app.close().then(() => process.exit(0)) })
`], { stdio: ['ignore', 'pipe', 'pipe'] })
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 30_000)
    server.stdout.on('data', chunk => { if (String(chunk).includes('ready')) { clearTimeout(timer); resolve() } })
    server.stderr.on('data', chunk => serverStderr.push(String(chunk).slice(0, 400)))
    server.once('exit', code => reject(new Error(`server exited early (${code})${serverStderr.length === 0 ? '' : `: ${serverStderr.join('').trim().slice(0, 300)}`}`)))
  })
} catch (error) {
  // Nothing must survive a failed start: no child process, no temp directory.
  await stopServer()
  await rm(dataDirectory, { recursive: true, force: true })
  throw error
}

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
  // Exercise the actual animated input, not transition-free dashboard buttons.
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  results.motionBaseline = await page.getByLabel('Аккаунт', { exact: true }).evaluate(input =>
    Math.max(...getComputedStyle(input).transitionDuration.split(',').map(value => parseFloat(value))))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  results.motionReduced = await page.getByLabel('Аккаунт', { exact: true }).evaluate(input =>
    Math.max(...getComputedStyle(input).transitionDuration.split(',').map(value => parseFloat(value))))
  results.reducedMotion = results.motionBaseline > 0.01 && results.motionReduced <= 0.01
  await page.emulateMedia({ reducedMotion: 'no-preference' })
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

  const tokens = await page.evaluate(async () => {
    const register = async name => {
      const bytes = new Uint8Array(32)
      crypto.getRandomValues(bytes)
      const identityKey = btoa(String.fromCharCode(...bytes)).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')
      const deviceId = crypto.randomUUID()
      const response = await fetch('/api/v1/devices/register', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ v: 1, device: { deviceId, identityKey, name, role: 'host', platform: 'linux', clientVersion: '0.5.13' } }),
      })
      if (!response.ok) throw new Error(`register failed ${response.status}`)
      const body = await response.json()
      return { deviceId, accessToken: body.accessToken, name }
    }
    // Register the offline device first: the UI must still list the online one on top.
    const offline = await register('console-check-offline')
    const online = await register('console-check-online')
    return { online, offline }
  })
  await page.getByRole('button', { name: 'Обновить', exact: true }).click()
  await page.getByText('console-check-online', { exact: true }).waitFor({ timeout: 20_000 })
  results.deviceListed = true
  results.noneOnlineBeforeSocket = (await page.locator('.device-status.online').count()) === 0
  results.captionBeforeSocket = await page.locator('table caption').innerText()

  // Presence is derived from an open control socket, so open one like a real plugin would.
  const presence = await page.evaluate(async device => {
    const endpoint = new URL('/ws/v1/connect', location.href)
    endpoint.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(endpoint.href)
    const frame = { v: 1, id: crypto.randomUUID(), type: 'hello', timestamp: Date.now(), payload: {
      role: 'host', deviceId: device.deviceId, accessToken: device.accessToken, protocols: [1],
      capabilities: ['transport.relay'], clientVersion: '0.5.13',
    } }
    const ack = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('hello.ack timeout')), 10_000)
      socket.addEventListener('message', event => {
        const parsed = JSON.parse(String(event.data))
        if (parsed.type === 'hello.ack') { clearTimeout(timer); resolve(parsed) }
        if (parsed.type === 'error') { clearTimeout(timer); reject(new Error(String(parsed.payload?.code))) }
      })
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('socket error')) })
      socket.addEventListener('open', () => socket.send(JSON.stringify(frame)))
    })
    globalThis.__consoleSocket = socket
    return { ack: ack.type, ready: socket.readyState }
  }, tokens.online)
  results.helloAck = presence.ack === 'hello.ack'

  await page.getByRole('button', { name: 'Обновить', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.device-status.online').length === 1, null, { timeout: 20_000 })
  results.onlinePresence = true
  results.caption = await page.locator('table caption').innerText()
  results.captionCorrect = results.caption.trim() === '1 из 2 устройств онлайн'
  results.onlineRowFirst = (await page.locator('table tbody tr').first().innerText()).includes('console-check-online')
  results.offlineRowShown = (await page.locator('table tbody tr').count()) === 2

  // Accessibility and layout facts that only a real browser can report.
  const a11y = await page.evaluate(() => {
    const unnamedButtons = [...document.querySelectorAll('button')].filter(button => (button.textContent ?? '').trim() === '' && !button.getAttribute('aria-label'))
    const revoke = [...document.querySelectorAll('button')].find(button => (button.textContent ?? '').includes('Отозвать'))
    return {
      caption: document.querySelector('table caption')?.textContent ?? '',
      unnamedButtons: unnamedButtons.length,
      revokeLabel: revoke?.getAttribute('aria-label') ?? '',
      tableColumns: document.querySelectorAll('table thead th').length,
    }
  })
  results.captionHasCounts = /устройств/iu.test(a11y.caption)
  results.unnamedButtons = a11y.unnamedButtons
  results.revokeLabelNamesDevice = a11y.revokeLabel.includes('console-check-online')
  results.tableColumns = a11y.tableColumns

  // Wait for this refresh's response before checking enabled controls: otherwise
  // the predicate could pass before React starts the request and disables them.
  await Promise.all([
    page.waitForResponse(response => response.url() === `${origin}/api/v1/account/devices` && response.request().method() === 'GET'),
    page.getByRole('button', { name: 'Обновить', exact: true }).click(),
  ])
  results.keyboardFocus = []
  await page.getByRole('button', { name: 'Выйти', exact: true }).waitFor({ state: 'visible' })
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(button => button.textContent === 'Обновить')?.disabled)
  // Refresh temporarily disables itself while loading; reset focus after it settles.
  await page.getByRole('button', { name: 'Обновить', exact: true }).focus()
  for (const name of ['Выйти', 'Список устройств', 'Отозвать устройство console-check-online', 'Отозвать устройство console-check-offline']) {
    await page.keyboard.press('Tab')
    results.keyboardFocus.push(await page.evaluate(expected => {
      const element = document.activeElement
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return {
        name: element.getAttribute('aria-label') ?? element.textContent?.trim(),
        expected,
        visible: element.matches('button:focus-visible, [role="region"]:focus-visible') && (element.getAttribute('aria-label') ?? element.textContent?.trim()) === expected
          && style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2
          && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
      }
    }, name))
  }

  await page.setViewportSize({ width: 360, height: 720 })
  results.noHorizontalOverflow360 = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
  await page.setViewportSize({ width: 640, height: 450 })
  results.noHorizontalOverflow640 = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
  await page.setViewportSize({ width: 1280, height: 900 })

  // Revoke the offline device first, then close the socket and revoke the online one.
  await page.getByRole('button', { name: 'Отозвать устройство console-check-offline', exact: true }).click()
  // Wait for the table to become empty: the account e-mail contains the device name,
  // so a text match would never disappear.
  await page.waitForFunction(() => document.querySelectorAll('table tbody tr').length === 1, null, { timeout: 20_000 })
  await page.evaluate(() => { globalThis.__consoleSocket?.close(); return new Promise(resolve => setTimeout(resolve, 500)) })
  await page.getByRole('button', { name: 'Отозвать устройство console-check-online', exact: true }).click()
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
  await stopServer()
  await rm(dataDirectory, { recursive: true, force: true })
}

const failures = []
if (results.wrongPasswordRejected !== true) failures.push('wrong password was not rejected on the login screen')
if (results.emptyStateShown !== true) failures.push('empty device list was not explained')
if (results.deviceListed !== true) failures.push('registered device did not appear')
if (results.helloAck !== true) failures.push('the control socket did not answer hello')
if (results.onlinePresence !== true) failures.push('a device with an open control socket was not shown online')
if (results.onlineRowFirst !== true) failures.push('online devices are not sorted first')
if (results.offlineRowShown !== true) failures.push('the offline device disappeared from the list')
if (results.noneOnlineBeforeSocket !== true) failures.push('a device was shown online before any socket opened')
if (results.captionBeforeSocket.trim() !== '0 из 2 устройств онлайн') failures.push(`caption before socket: ${results.captionBeforeSocket}`)
if (results.captionCorrect !== true) failures.push(`caption after socket: ${results.caption}`)
if (results.unnamedButtons !== 0) failures.push(`${results.unnamedButtons} buttons have no accessible name`)
if (results.revokeLabelNamesDevice !== true) failures.push('the revoke button does not name the device')
if (results.captionHasCounts !== true) failures.push('the device table caption does not state counts')
if (results.keyboardFocus?.length !== 4 || results.keyboardFocus.some(stop => !stop.visible)) failures.push('the named keyboard route has a wrong target or invisible focus ring')
if (results.reducedMotion !== true) failures.push('reduced motion did not shorten the animated login input transition')
if (results.noHorizontalOverflow360 !== true) failures.push('horizontal overflow at 360px')
if (results.noHorizontalOverflow640 !== true) failures.push('horizontal overflow at 640px (not a browser zoom test)')
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
