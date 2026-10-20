import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const run = promisify(execFile)

describe('documented palette contrast', () => {
  it('keeps every checked pair at WCAG AA in both themes', async () => {
    // The script owns the rules; this test only guarantees it stays wired into CI
    // and that the current palette passes (docs/design/fork/03-ui-kit.ru.md, UX-09).
    const script = fileURLToPath(new URL('../../../scripts/check-contrast.mjs', import.meta.url))
    const { stdout } = await run(process.execPath, [script])
    expect(stdout).toContain('All checked pairs meet WCAG AA.')
  }, 30_000)
})
