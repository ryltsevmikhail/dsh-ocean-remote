#!/usr/bin/env node
// WCAG contrast check for the surfaces this fork owns. It reads the Ocean console
// stylesheet so the palette cannot drift away from the documented AA target
// (docs/design/fork/03-ui-kit.ru.md, UX-09). Set CONTRAST_CSS to check another file.

import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const stylesheetPath = process.env.CONTRAST_CSS
  ?? new URL('../apps/server/web/src/ocean.css', import.meta.url)
const stylesheet = await readFile(stylesheetPath, 'utf8')

/** Brace-aware extraction so nested blocks (`:root` inside a media query) are complete. */
function blockFor(selector, from = 0) {
  const start = stylesheet.indexOf(selector, from)
  if (start === -1) throw new Error(`selector ${selector} not found`)
  let index = stylesheet.indexOf('{', start)
  if (index === -1) throw new Error(`selector ${selector} has no block`)
  const bodyStart = index + 1
  let depth = 0
  for (; index < stylesheet.length; index += 1) {
    if (stylesheet[index] === '{') depth += 1
    else if (stylesheet[index] === '}') {
      depth -= 1
      if (depth === 0) return stylesheet.slice(bodyStart, index)
    }
  }
  throw new Error(`selector ${selector} is not closed`)
}

function variables(block) {
  const result = new Map()
  for (const match of block.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/giu)) result.set(match[1], match[2].trim())
  return result
}

/** First declared value of a property inside a block, e.g. `background` in `:root`. */
function declaration(selector, property, from = 0) {
  const block = blockFor(selector, from)
  const match = new RegExp(`(?:^|[;{\\s])${property}\\s*:\\s*([^;]+);`, 'iu').exec(block)
  if (match === null) throw new Error(`${property} is not declared in ${selector}`)
  return match[1].trim()
}

const light = variables(blockFor(':root {'))
const darkStart = stylesheet.indexOf('@media (prefers-color-scheme: dark)')
const darkBlock = darkStart === -1 ? '' : blockFor('@media (prefers-color-scheme: dark)')
const dark = new Map([...light, ...variables(darkBlock)])
const page = {
  light: declaration(':root {', 'background').replace(/color-scheme.*$/iu, '').trim(),
  dark: darkBlock === '' ? undefined : declaration('@media (prefers-color-scheme: dark)', 'background'),
}
if (page.dark === undefined) throw new Error('dark page background is not declared')
for (const theme of ['light', 'dark']) {
  if (!/^#[0-9a-f]{3,6}$/iu.test(page[theme])) throw new Error(`${theme} page background is not a hex colour: ${page[theme]}`)
}

function parse(color) {
  const hex = color.trim()
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/iu.exec(hex)
  if (!match) throw new Error(`unsupported colour ${color}`)
  const value = match[1].length === 3 ? [...match[1]].map(c => c + c).join('') : match[1]
  return [0, 2, 4].map(index => Number.parseInt(value.slice(index, index + 2), 16) / 255)
}

function luminance([r, g, b]) {
  const channel = c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** Unrounded ratio: deciding on a rounded value would let 4.496 pass as 4.5. */
function contrast(foreground, background) {
  const [a, b] = [luminance(parse(foreground)), luminance(parse(background))].sort((x, y) => y - x)
  return (a + 0.05) / (b + 0.05)
}

// Text pairs: [label, foreground, background, minimum]. Disabled states are exempt
// under WCAG, so they are intentionally absent.
const TEXT = [
  ['ink on surface', 'ink', 'surface', 4.5],
  ['ink on page', 'ink', 'page', 4.5],
  ['muted on surface', 'muted', 'surface', 4.5],
  ['muted on page', 'muted', 'page', 4.5],
  ['muted on wash', 'muted', 'wash', 4.5],
  ['accent on surface', 'accent', 'surface', 4.5],
  ['accent on page', 'accent', 'page', 4.5],
  ['accent on wash', 'accent', 'wash', 4.5],
  ['white label on primary button', '#ffffff', 'button', 4.5],
  // State colours are semantic tokens; they must stay readable on surfaces.
  ['success on surface', 'success', 'surface', 4.5],
  ['success on page', 'success', 'page', 4.5],
  ['warning on surface', 'warning', 'surface', 4.5],
  ['danger on surface', 'danger', 'surface', 4.5],
  ['danger on error wash', 'danger', 'error-wash', 4.5],
]
// Non-text pairs (WCAG 1.4.11): interactive boundaries and the focus ring need 3:1.
const NON_TEXT = [
  ['control border on surface', 'border-strong', 'surface', 3],
  ['control border on page', 'border-strong', 'page', 3],
  ['focus ring on surface', 'accent', 'surface', 3],
  ['focus ring on page', 'accent', 'page', 3],
]

const failures = []
let checks = 0
for (const [theme, palette] of Object.entries({ light, dark })) {
  const resolved = new Map([...palette, ['page', page[theme]]])
  for (const [label, fgName, bgName, minimum] of [...TEXT, ...NON_TEXT]) {
    const fg = fgName.startsWith('#') ? fgName : resolved.get(fgName)
    const bg = bgName === 'page' ? resolved.get('page') : bgName.startsWith('#') ? bgName : resolved.get(bgName)
    if (fg === undefined || bg === undefined) throw new Error(`unknown token in "${label}" (${theme})`)
    const ratio = contrast(fg, bg)
    checks += 1
    const ok = ratio >= minimum
    if (!ok) failures.push(`${theme}: ${label} = ${ratio.toFixed(2)}:1 (< ${minimum})`)
    console.log(`${(ok ? 'ok' : 'FAIL').padEnd(4)} ${theme.padEnd(5)} ${label.padEnd(30)} ${ratio.toFixed(2)}:1 (min ${minimum})`)
  }
}

if (failures.length > 0) {
  console.error(`\nContrast failures:\n- ${failures.join('\n- ')}`)
  process.exitCode = 1
} else {
  console.log(`\nAll ${checks} checked pairs meet WCAG AA.`)
}
