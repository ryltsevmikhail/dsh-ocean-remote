#!/usr/bin/env node
// WCAG contrast check for the surfaces this fork owns. It parses the Ocean console
// stylesheet so the palette cannot drift away from the documented AA target
// (docs/design/fork/03-ui-kit.ru.md, UX-09).

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const stylesheet = await readFile(new URL('apps/server/web/src/ocean.css', `file://${root}`), 'utf8')

/** Minimal CSS variable extraction: `--name: value;` inside `:root { ... }`. */
function variables(block) {
  const result = new Map()
  for (const match of block.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/giu)) result.set(match[1], match[2].trim())
  return result
}

function blockFor(selector, from = 0) {
  const start = stylesheet.indexOf(selector, from)
  if (start === -1) throw new Error(`selector ${selector} not found`)
  const open = stylesheet.indexOf('{', start)
  const close = stylesheet.indexOf('}', open)
  return stylesheet.slice(open + 1, close)
}

const light = variables(blockFor(':root {'))
const darkBlock = blockFor('@media (prefers-color-scheme: dark)')
const dark = new Map([...light, ...variables(darkBlock)])

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

function contrast(foreground, background) {
  const [a, b] = [luminance(parse(foreground)), luminance(parse(background))].sort((x, y) => y - x)
  return Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100
}

const PAGES = { '#f9fafb': { background: '#f9fafb' }, '#212327': { background: '#212327' } }
const pairs = [
  // [label, foreground variable, background variable, minimum]
  ['ink on surface', 'ink', 'surface', 4.5],
  ['ink on page', 'ink', 'bg', 4.5],
  ['muted on surface', 'muted', 'surface', 4.5],
  ['muted on page', 'muted', 'bg', 4.5],
  ['accent text on surface', 'accent', 'surface', 4.5],
  // Primary buttons paint their label on --button, not on --accent.
  ['white label on primary button', '#ffffff', 'button', 4.5],
]

const failures = []
for (const [theme, palette] of [['light', light], ['dark', dark]]) {
  const bg = palette.get('bg') ?? (theme === 'light' ? PAGES['#f9fafb'].background : PAGES['#212327'].background)
  const resolved = new Map([...palette, ['bg', bg]])
  for (const [label, fgName, bgName, minimum] of pairs) {
    const fg = resolved.get(fgName.replace('#', '')) ?? (fgName.startsWith('#') ? fgName : undefined)
    const bgValue = resolved.get(bgName.replace('#', '')) ?? (bgName.startsWith('#') ? bgName : undefined)
    if (fg === undefined || bgValue === undefined) throw new Error(`unknown token in ${label}`)
    const ratio = contrast(fg, bgValue)
    const status = ratio >= minimum ? 'ok' : 'FAIL'
    if (ratio < minimum) failures.push(`${theme}: ${label} = ${ratio}:1 (< ${minimum})`)
    console.log(`${status.padEnd(4)} ${theme.padEnd(5)} ${label.padEnd(28)} ${ratio}:1 (min ${minimum})`)
  }
}

if (failures.length > 0) {
  console.error(`\nContrast failures:\n- ${failures.join('\n- ')}`)
  process.exitCode = 1
} else {
  console.log('\nAll checked pairs meet WCAG AA.')
}
