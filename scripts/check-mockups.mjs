#!/usr/bin/env node
// Responsive and accessibility smoke test for the design mockups
// (docs/design/fork/mockups/*.html, UX-08/UX-10).
//
// Rendering needs Playwright, which is intentionally not a repository dependency, so
// this is a local design QA step. When Playwright is unavailable the script FAILS
// instead of pretending the check ran; pass --allow-skip to record a deliberate skip.
// Usage:
//   node scripts/check-mockups.mjs [--allow-skip] [--write-shots]
//   PLAYWRIGHT=/path/to/playwright/index.mjs node scripts/check-mockups.mjs
//   CHROME=/usr/bin/google-chrome-stable ... (overrides the browser binary)

import { readdir, writeFile } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const root = new URL('..', import.meta.url)
const mockups = new URL('docs/design/fork/mockups/', root)
const args = new Set(process.argv.slice(2))
const allowSkip = args.has('--allow-skip')
const writeShots = args.has('--write-shots')
const VIEWPORTS = [
  { name: 'narrow', width: 360, height: 900, scale: 2 },
  { name: 'tablet', width: 768, height: 1024, scale: 1 },
  { name: 'desktop', width: 1440, height: 900, scale: 1 },
  // 200% browser zoom halves the layout viewport: 1440x900 becomes ~720x450 (UX-09).
  // An 8 px scrollbar leaves ~712 px of usable width, so 705 is checked as well.
  { name: 'zoom200', width: 720, height: 450, scale: 1 },
  { name: 'zoom200scrolled', width: 705, height: 450, scale: 1 },
]

async function loadPlaywright() {
  // Candidates may already be file: URLs (import.meta.url) or bare specifiers.
  const candidates = [
    process.env.PLAYWRIGHT,
    new URL('../.local/browser-check/node_modules/playwright/index.mjs', import.meta.url).href,
    'playwright',
  ].filter(Boolean)
  const problems = []
  for (const candidate of candidates) {
    try {
      return { module: await import(candidate.startsWith('file:') ? candidate : pathToFileURL(candidate).href) }
    } catch (error) {
      problems.push(`${candidate}: ${String(error?.message ?? error).slice(0, 140)}`)
    }
  }
  return { problems }
}

const loaded = await loadPlaywright()
if (loaded.problems !== undefined) {
  console.error('Playwright is not available, so the mockup layout was NOT measured:')
  for (const problem of loaded.problems) console.error(`- ${problem}`)
  if (allowSkip) {
    console.error('Skipping deliberately (--allow-skip).')
    process.exit(0)
  }
  console.error('Install Playwright or set PLAYWRIGHT; pass --allow-skip to skip on purpose.')
  process.exit(1)
}

/** Launch the bundled browser first, then fall back to a system one. */
async function launch(playwright) {
  const attempts = [{ label: 'bundled chromium' }]
  const chrome = process.env.CHROME ?? '/usr/bin/google-chrome-stable'
  attempts.push({ label: chrome, executablePath: chrome })
  const problems = []
  for (const attempt of attempts) {
    try {
      return await playwright.chromium.launch({
        headless: true,
        chromiumSandbox: true,
        args: ['--no-proxy-server'],
        ...(attempt.executablePath === undefined ? {} : { executablePath: attempt.executablePath }),
      })
    } catch (error) {
      problems.push(`${attempt.label}: ${String(error?.message ?? error).slice(0, 120)}`)
    }
  }
  throw new Error(`no browser could be launched:\n- ${problems.join('\n- ')}`)
}

const files = (await readdir(mockups)).filter(name => name.endsWith('.html')).sort()
if (files.length === 0) throw new Error('no mockup html files found')

const failures = []
const browser = await launch(loaded.module)
try {
  for (const file of files) {
    const url = new URL(file, mockups).href
    const expectedSha = Number(/data-sha-count="(\d+)"/u.exec(await readFile(new URL(file, mockups), 'utf8'))?.[1] ?? '0')
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: viewport.scale })
      try {
        const page = await context.newPage()
        // Reduced motion must be honoured: no decorative animation may survive it.
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await page.goto(url, { waitUntil: 'load' })
        const report = await page.evaluate(() => {
          const doc = document.documentElement
          const accessibleName = node => {
            const direct = node.getAttribute('aria-label')?.trim()
            if (direct) return direct
            const labelledBy = node.getAttribute('aria-labelledby')
            if (labelledBy) {
              const text = labelledBy.split(/\s+/u).map(id => document.getElementById(id)?.textContent ?? '').join(' ').trim()
              if (text !== '') return text
            }
            if (node.id !== '') {
              const explicit = document.querySelector(`label[for="${CSS.escape(node.id)}"]`)
              if (explicit !== null) return explicit.textContent?.trim() ?? ''
            }
            const wrapping = node.closest('label')
            if (wrapping !== null) return wrapping.textContent?.trim() ?? ''
            if (node instanceof HTMLInputElement && ['submit', 'button', 'reset'].includes(node.type)) return (node.value ?? '').trim()
            if (node.getAttribute('title')) return node.getAttribute('title').trim()
            return (node.textContent ?? '').trim()
          }
          const controls = [...document.querySelectorAll('button, input, select, textarea, a[href], [role="switch"]')]
          const unnamed = controls.filter(node => accessibleName(node) === '').map(node => node.outerHTML.slice(0, 90))
          const sha = [...document.querySelectorAll('.sha')].map(node => ({
            length: (node.textContent ?? '').replace(/\s+/gu, '').length,
            clipped: node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1,
          }))
          const focusIssues = []
          // Disabled controls cannot take focus and are exempt (WCAG 2.1.1).
          for (const node of document.querySelectorAll('button, a[href], input, select, textarea')) {
            if (node.disabled === true) continue
            node.focus()
            const style = getComputedStyle(node)
            const outline = style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0
            const shadow = style.boxShadow !== 'none' && style.boxShadow.includes('rgb')
            if (!outline && !shadow) focusIssues.push(node.outerHTML.slice(0, 70))
          }
          return {
            overflow: doc.scrollWidth > doc.clientWidth + 1,
            scrollWidth: doc.scrollWidth,
            clientWidth: doc.clientWidth,
            sha,
            unnamed,
            focusIssues,
            headings: [...document.querySelectorAll('h1, h2, h3')].map(node => node.tagName),
            animated: [...document.querySelectorAll('body *')]
              .filter(node => {
                const style = getComputedStyle(node)
                const duration = Number.parseFloat(style.animationDuration) || 0
                return style.animationName !== 'none' && duration > 0
              })
              .map(node => node.outerHTML.slice(0, 60)),
            smallTargets: [...document.querySelectorAll('button, a[href], input, select, [role="switch"]')]
              .filter(node => node.disabled !== true)
              // A checkbox inside its label is tapped through the label.
              .map(node => ({ html: node.outerHTML.slice(0, 60), ...node.closest('label')?.getBoundingClientRect().toJSON() ?? node.getBoundingClientRect().toJSON() }))
              // WCAG 2.2 requires 24x24 (2.5.8) and recommends 44x44 (2.5.5); this fork
              // keeps a documented internal minimum of 32 in both dimensions.
              .filter(rect => rect.width > 0 && rect.height > 0 && (rect.width < 32 || rect.height < 32))
              .map(rect => `${rect.html} (${Math.round(rect.width)}x${Math.round(rect.height)}px)`),
          }
        })
        const where = `${file} @${viewport.name}`
        const before = failures.length
        if (report.overflow) failures.push(`${where}: page scrolls horizontally (${report.scrollWidth} > ${report.clientWidth})`)
        if (report.sha.length !== expectedSha) failures.push(`${where}: expected ${expectedSha} SHA fields, found ${report.sha.length}`)
        for (const item of report.sha) {
          if (item.length !== 64) failures.push(`${where}: a SHA field has ${item.length} characters instead of 64`)
          if (item.clipped) failures.push(`${where}: a SHA field is clipped`)
        }
        if (report.unnamed.length > 0) failures.push(`${where}: controls without an accessible name: ${report.unnamed.join(' | ')}`)
        if (report.focusIssues.length > 0) failures.push(`${where}: controls without a visible focus indicator: ${report.focusIssues.join(' | ')}`)
        if (!report.headings.includes('H2')) failures.push(`${where}: no section heading (h2) for navigation`)
        if (report.animated.length > 0) failures.push(`${where}: animation survives reduced motion: ${report.animated.join(' | ')}`)
        if (report.smallTargets.length > 0) failures.push(`${where}: tap targets under 32px: ${report.smallTargets.join(' | ')}`)
        if (writeShots) {
          // Screenshots must not show the focus ring left by the checks above.
          await page.evaluate(() => document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined)
          await writeFile(new URL(`${file.replace(/\.html$/u, '')}-${viewport.name}.png`, mockups),
            await page.screenshot({ fullPage: true }))
        }
        console.log(`${failures.length === before ? 'ok  ' : 'FAIL'} ${where.padEnd(42)} ${report.scrollWidth}/${report.clientWidth} px, ${report.sha.length} SHA, ${report.focusIssues.length} focus issues, ${report.smallTargets.length} small targets`)
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
