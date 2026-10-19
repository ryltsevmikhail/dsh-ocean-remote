import { describe, expect, it } from 'vitest'
import { normalizeServerUrl, resolveConfig } from '../src/config.js'

describe('plugin config', () => {
  it('applies safe defaults', () => {
    expect(resolveConfig({}, {})).toMatchObject({
      enabled: true,
      role: 'host',
      hostControl: { enabled: true },
      terminal: { enabled: false },
      forceRelay: false,
      reconnect: { enabled: true, initialDelayMs: 1_000, maxDelayMs: 30_000, jitter: 0.2 },
      codex: { enabled: false, binary: 'codex' },
      cursor: { enabled: false, binary: 'agent' },
    })
    expect(resolveConfig({}, { DSH_REMOTE_TERMINAL_ENABLED: 'true' }).terminal.enabled).toBe(true)
    expect(resolveConfig({}, { DSH_REMOTE_TERMINAL_ENABLED: 'false' }).terminal.enabled).toBe(false)
  })

  it('keeps agent surfaces off by default and derives ACP only from ACP backends', () => {
    const base = resolveConfig({}, {})
    expect(base).toMatchObject({ terminal: { enabled: false }, codex: { enabled: false }, acp: { enabled: false }, cursor: { enabled: false } })
    expect(base.acp?.backends.every(item => item.enabled === false)).toBe(true)
    // Codex has its own carrier: it must not switch the ACP master on.
    const codexOnly = resolveConfig({ codex: { enabled: true } }, {})
    expect(codexOnly.codex.enabled).toBe(true)
    expect(codexOnly.acp?.enabled).toBe(false)
    expect(codexOnly.acp?.backends.filter(item => item.id !== 'codex').every(item => item.enabled === false)).toBe(true)
    // An explicitly enabled ACP backend implies the carrier.
    const cursorOnly = resolveConfig({ codex: { enabled: false }, cursor: { enabled: true } }, {})
    expect(cursorOnly.acp?.enabled).toBe(true)
    expect(cursorOnly.cursor.enabled).toBe(true)
    expect(cursorOnly.codex.enabled).toBe(false)
    // ACP master on is still required for backend startup, and per-backend disable wins.
    const acpOn = resolveConfig({ acp: { enabled: true, backends: [{ id: 'pi', enabled: false }] } }, {})
    expect(acpOn.acp?.backends.find(item => item.id === 'pi')?.enabled).toBe(false)
    expect(acpOn.acp?.backends.find(item => item.id === 'claude')?.enabled).toBe(true)
    const backendOnly = resolveConfig({ acp: { backends: [{ id: 'claude', enabled: true }] } }, {})
    expect(backendOnly.acp?.enabled).toBe(true)
    expect(backendOnly.acp?.backends.find(item => item.id === 'claude')?.enabled).toBe(true)
    // Legacy shorthand keeps working.
    expect(resolveConfig({ acp: { enabled: true, backend: 'codex' } }, {}).codex.enabled).toBe(true)
  })

  it('keeps Codex off by default and honours explicit enable and obsolete workspace filters', () => {
    expect(resolveConfig({ codex: { enabled: false } }, {})).toMatchObject({
      codex: { enabled: false, binary: 'codex' },
    })
    expect(resolveConfig({ codex: {
      enabled: true,
      binary: '/opt/codex/bin/codex',
    } }, {})).toMatchObject({
      codex: { enabled: true, binary: '/opt/codex/bin/codex' },
    })
    expect(() => resolveConfig({ codex: { enabled: true, allowedRoots: ['/workspace'] } } as never)).toThrow()
  })

  it('preserves independent ACP launch options and scopes legacy Cursor configuration to Cursor', () => {
    const legacy = resolveConfig({ cursor: { enabled: true, binary: '/custom/cursor' } }, {})
    expect(legacy.acp?.backends.find(item => item.id === 'cursor')).toMatchObject({ enabled: true, command: '/custom/cursor' })
    expect(legacy.acp?.backends.find(item => item.id === 'antigravity')?.enabled).toBe(false)
    const config = resolveConfig({ acp: { enabled: false, backends: [
      { id: 'cursor', enabled: false },
      { id: 'antigravity', enabled: true, command: '/custom/agy', args: ['--custom'], cwd: '/host' },
    ] } }, {})
    expect(config.acp?.enabled).toBe(false)
    expect(config.acp?.backends.find(item => item.id === 'antigravity')).toEqual({
      id: 'antigravity', enabled: true, command: '/custom/agy', args: ['--custom'], cwd: '/host',
    })
  })

  it('uses one CodeX backend setting and drops unimplemented Kimi', () => {
    const config = resolveConfig({ codex: { enabled: true, binary: '/old/codex' }, acp: {
      enabled: true, backends: [{ id: 'codex', enabled: false, command: '/new/codex' }, { id: 'kimi', enabled: true }],
    } }, {})
    expect(config.codex).toEqual({ enabled: false, binary: '/new/codex' })
    expect(config.acp?.backends.some(item => item.id === 'kimi')).toBe(false)
    // Codex has its own carrier: an explicit Codex switch is not gated by the ACP master.
    expect(resolveConfig({ acp: { enabled: false, backends: [{ id: 'codex', enabled: true }] } }, {}).codex.enabled).toBe(true)
  })

  it('has no implicit server and respects explicit configuration over the environment', () => {
    expect(resolveConfig({}, {}).serverUrl).toBeUndefined()
    expect(resolveConfig({}, { DSH_REMOTE_SERVER: 'https://env.example.com/' }).serverUrl).toBe('https://env.example.com')
    expect(resolveConfig({ serverUrl: 'https://profile.example.com/' }, {
      DSH_REMOTE_SERVER: 'https://env.example.com',
    }).serverUrl).toBe('https://profile.example.com')
  })

  it('rejects insecure non-local servers and embedded credentials', () => {
    expect(() => resolveConfig({ serverUrl: 'http://remote.example.com' })).toThrow(/HTTPS/)
    expect(() => resolveConfig({ serverUrl: 'https://user:password@remote.example.com' })).toThrow(/credentials/)
    expect(() => resolveConfig({ serverUrl: 'https://remote.example.com?token=secret' })).toThrow(/query parameters/)
    expect(() => resolveConfig({ serverUrl: 'https://remote.example.com/api' })).toThrow(/without a path/)
    expect(resolveConfig({ serverUrl: 'http://localhost:8080' }).serverUrl).toBe('http://localhost:8080')
    expect(normalizeServerUrl('https://REMOTE.example.com/')).toBe('https://remote.example.com')
  })

  it('rejects an inverted reconnect range', () => {
    expect(() => resolveConfig({ reconnect: { initialDelayMs: 5_000, maxDelayMs: 1_000 } })).toThrow(/maxDelayMs/)
  })
})
