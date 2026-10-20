import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const run = promisify(execFile)
const script = fileURLToPath(new URL('../../../scripts/check-contrast.mjs', import.meta.url))
const stylesheet = fileURLToPath(new URL('../../../apps/server/web/src/ocean.css', import.meta.url))

describe('documented palette contrast', () => {
  it('checks a fixed set of pairs and reports them all as passing', async () => {
    const { stdout } = await run(process.execPath, [script])
    // Both themes, text and non-text pairs: a collapsed palette would print fewer lines.
    const passing = stdout.split('\n').filter(line => line.startsWith('ok '))
    expect(passing).toHaveLength(36)
    expect(stdout).toContain('All 36 checked pairs meet WCAG AA.')
    expect(passing.some(line => line.includes('light') && line.includes('control border on surface'))).toBe(true)
    expect(passing.some(line => line.includes('dark') && line.includes('focus ring on surface'))).toBe(true)
  }, 30_000)

  it('fails the build on a low-contrast palette', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-contrast-'))
    try {
      // Mutate one token so the checker must fail instead of printing success.
      const css = (await readFile(stylesheet, 'utf8')).replace('--muted: #6b6b74;', '--muted: #d6d6dc;')
      const file = join(directory, 'ocean.css')
      await writeFile(file, css)
      const failure = await run(process.execPath, [script], { env: { ...process.env, CONTRAST_CSS: file } })
        .then(() => undefined, (error: unknown) => error as { code?: number; stdout?: string })
      expect(failure?.code).toBe(1)
      // The summary goes to stderr; stdout still lists the failing pair as FAIL.
      const stderr = String((failure as { stderr?: string } | undefined)?.stderr)
      expect(`${String(failure?.stdout)}${stderr}`).toContain('Contrast failures')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)
})
