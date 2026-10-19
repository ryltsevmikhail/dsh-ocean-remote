import { describe, expect, it } from 'vitest'
import { buildDiagnostics } from '../src/diagnostics.js'

const fullFingerprint = 'AB'.repeat(32)
const deviceId = '0f8c2b1e-1111-4222-8333-444455556666'

describe('support diagnostics', () => {
  it('keeps only the server origin', () => {
    const report = buildDiagnostics({
      role: 'client', mode: 'remote', pluginVersion: '0.5.13',
      serverUrl: 'https://user:pass@ocean.example.com:8443/base?token=secret#frag',
    })
    expect(report.server).toEqual({ origin: 'https://ocean.example.com:8443' })
    expect(JSON.stringify(report)).not.toContain('secret')
    expect(JSON.stringify(report)).not.toContain('pass')
  })

  it('shortens identifiers and never includes a full fingerprint', () => {
    const report = buildDiagnostics({
      role: 'client', mode: 'remote', pluginVersion: '0.5.13',
      device: { id: deviceId, name: 'laptop', platform: 'linux' },
      transport: { connected: true, mode: 'Relay', target: deviceId },
    })
    expect(report.device?.idPrefix).toBe(deviceId.slice(0, 8))
    expect(report.transport?.targetPrefix).toBe(deviceId.slice(0, 8))
    const text = JSON.stringify(report)
    expect(text).not.toContain(deviceId)
    expect(text).not.toContain(fullFingerprint)
  })

  it('reports that an error happened without quoting the message', () => {
    const report = buildDiagnostics({
      role: 'host', mode: 'local', pluginVersion: '0.5.13',
      error: 'connect to https://user:pass@ocean.example.com/?token=abc failed',
    })
    expect(report.error).toEqual({ present: true })
    const text = JSON.stringify(report)
    expect(text).not.toContain('token=abc')
    expect(text).not.toContain('pass')
  })

  it('omits optional sections instead of inventing values', () => {
    const report = buildDiagnostics({ role: 'host', mode: 'local', pluginVersion: '0.5.13' })
    expect(report).not.toHaveProperty('server')
    expect(report).not.toHaveProperty('device')
    expect(report).not.toHaveProperty('trust')
    expect(report).not.toHaveProperty('features')
    expect(report.error).toEqual({ present: false })
    expect(report.schemaVersion).toBe(1)
  })
})
