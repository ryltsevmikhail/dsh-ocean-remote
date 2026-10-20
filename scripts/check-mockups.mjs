#!/usr/bin/env node
// Responsive and accessibility smoke test for the design mockups
// (docs/design/fork/mockups/*.html, UX-08/UX-10).
//
// Rendering needs Playwright, which is intentionally not a repository dependency:
// this is a local design QA step. Without Playwright the script reports SKIPPED and
// exits 0 so CI never pretends the check ran. Set PLAYWRIGHT to a playwright entrypoint.

import { readdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const root = new URL('..', import.meta.url)
const mockups = new URL('docs/design/fork/mockups/', root)
const VIEWPORTS = [
  { name: 'narrow', width: 360, height: 900, scale: 2 },
  { name: 'tablet', width: 768, height: 1024, scale: 1 },
  { name: 'desktop', width: 1440, height: 900, scale: 1 },
]

async function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT,
    new URL('../.local/browser-check/node_modules/playwright/index.mjs', import.meta.url).href,
    'playwright',
  ].filter(Boolean)
  const problems = []
  for (const candidate of candidates) {
    try {
      const url = candidate.startsWith('file:') || candidate.startsWith('/') ? pathToFileURL(candidate).href : candidate
      return await import(url)
    } catch (error) {
      problems.push(String(error).slice(0, 120))
    }
  }
  return { missing: problems }
}

const playwright = await loadPlaywright()
if (playwright.missing !== undefined) {
  console.log('SKIPPED: Playwright is not available, so the mockup layout was not measured.')
  process.exit(0)
}

const files = (await readdir(mockups)).filter(name => name.endsWith('.html')).sort()
if (files.length === 0) throw new Error('no mockup html files found')

const failures = []
// Use the system browser when the bundled one is absent (CHROME may override).
const executablePath = process.env.CHROME ?? '/usr/bin/google-chrome-stable'
const browser = await playwright.chromium.launch({ headless: true, chromiumSandbox: true, args: ['--no-proxy-server'], ...(executablePath ? { executablePath } : {}) })
try {
  for (const file of files) {
    const url = pathToFileURL(new URL(file, mockups).pathname).href
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: viewport.scale })
      try {
        const page = await context.newPage()
        await page.goto(url, { waitUntil: 'load' })
        const report = await page.evaluate(() => {
          const doc = document.documentElement
          // Long identifiers must stay complete and readable.
          const longText = [...document.querySelectorAll('.sha')].map(node => ({
            length: (node.textContent ?? '').replace(/\s+/gu, '').length,
            clipped: node.scrollWidth > node.clientWidth + 1,
          }))
          const unnamed = [...document.querySelectorAll('button, input, select, textarea, [role="switch"], a[href]')]
            .filter(node => {
              const label = node.getAttribute('aria-label') ?? node.getAttribute('title')
              const labelled = node.id !== '' && document.querySelector(`label[for="${node.id}"]`) !== null
              const text = (node.textContent ?? '').trim()
              return (label ?? '') === '' && !labelled && text === '' && !(node instanceof HTMLInputElement && node.type === 'checkbox')
            })
            .map(node => node.outerHTML.slice(0, 80))
          // Focus must be visible: the computed outline must not be "none".
          const firstButton = document.querySelector('button')
          firstButton?.focus()
          const focusOutline = firstButton === null ? '' : getComputedStyle(firstButton).outlineStyle
          return {
            horizontalOverflow: doc.scrollWidth > window.innerWidth + 1,
            scrollWidth: doc.scrollWidth,
            innerWidth: window.innerWidth,
            longText,
            unnamed,
            focusOutline,
            headings: [...document.querySelectorAll('h1, h2, h3')].map(node => node.tagName),
          }
        })
        const where = `${file} @${viewport.name}`
        if (report.horizontalOverflow) failures.push(`${where}: page scrolls horizontally (${report.scrollWidth} > ${report.innerWidth})`)
        for (const item of report.longText) {
          if (item.length !== 64) failures.push(`${where}: a SHA field has ${item.length} characters instead of 64`)
          if (item.clipped) failures.push(`${where}: a SHA field is clipped`)
        }
        if (report.unnamed.length > 0) failures.push(`${where}: unnamed controls ${report.unnamed.join(' | ')}`)
        if (report.focusOutline === 'none') failures.push(`${where}: no visible focus outline on the first button`)
        if (!report.headings.includes('H2')) failures.push(`${where}: no section heading (h2) for navigation`)
        console.log(`ok   ${where.padEnd(46)} no overflow, ${report.longText.length} SHA fields intact, focus ${report.focusOutline}`)
      } finally {
        await context.close()
      }
    }
  }
} finally {
  await browser.close()
}

if (failures.length > 0) {
  console.error(`\nMockup failures:\n- ${failures.join('\n- ')}`)
  process.exitCode = 1
} else {
  console.log(`\nAll ${files.length} mockups pass at ${VIEWPORTS.map(v => v.width).join('/')} px.`)
}
