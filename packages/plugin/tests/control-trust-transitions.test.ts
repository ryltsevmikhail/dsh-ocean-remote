import { describe, expect, it, vi } from 'vitest'
import type { ClientModeRuntime, HostAuthorizationControl } from '../src/client-runtime.js'
import { resolveConfig, type Config } from '../src/config.js'
import type { ControlRouteHandler } from '../src/control-route.js'
import { PluginControlRuntime, type PluginAssociation, type PluginSettingsBinding } from '../src/control-runtime.js'

// settingsView probes executable availability: keep these unit tests independent
// of installed providers, home directories, and the process environment.
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFileSync: vi.fn(() => { throw new Error('synthetic unavailable executable') }),
}))
vi.mock('../src/codex/domain.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/codex/domain.js')>(),
  codexBinaryCandidates: () => ['synthetic-codex'],
}))
vi.mock('../src/acp/gateway.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/acp/gateway.js')>(),
  cursorBinaryCandidates: () => ['synthetic-cursor'],
}))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function settingsBinding(): PluginSettingsBinding {
  let current: Config = { role: 'host', serverUrl: 'https://synthetic.example', deviceName: 'synthetic-device' }
  return { get: () => current, replace: async next => { current = next } }
}

// Explicitly inject the trusted-local unit context, not transport authentication.
// Authenticated HTTP authority is covered separately by local-peer-approval.test.ts.
function unitControl(runtime: PluginControlRuntime) {
  return runtime as unknown as {
    handle: ControlRouteHandler
    association(serverUrl: string, role: 'host' | 'client'): Promise<PluginAssociation | undefined>
  }
}
const local = { localApproval: true }
const action = { role: 'client', deviceId: 'synthetic-peer', generation: 'synthetic-generation', fullFingerprint: 'A'.repeat(64) }
const busy = { ok: false, error: { details: { remoteCode: 'AUTHORITY_BUSY' } } }

function facade() {
  return {
    peerTrustStatus: vi.fn(() => ({ available: true })),
    approvePeer: vi.fn(async () => undefined),
    rejectPeer: vi.fn(),
    invalidatePeerApprovals: vi.fn(async () => undefined),
    handleControl: vi.fn(async () => ({ ok: true as const, value: {} })),
  }
}

describe('control trust authority transitions (unit)', () => {
  it.each(['client.account.login', 'client.account.qr.start'])(
    '%s holds the guard until settlement and never dispatches overlapping trust or account actions', async endpoint => {
      const started = deferred()
      const gate = deferred()
      const client = facade()
      client.handleControl.mockImplementation(async () => {
        started.resolve()
        await gate.promise
        return { ok: true, value: {} }
      })
      const control = unitControl(new PluginControlRuntime(resolveConfig({ deviceName: 'synthetic-device' }),
        '/unused-synthetic-unit-directory', undefined, client as unknown as ClientModeRuntime, undefined))
      const signal = new AbortController().signal
      const login = control.handle(endpoint, { email: 'synthetic@example.invalid', password: 'synthetic-password' }, signal)
      try {
        await started.promise
        for (const blocked of ['trust.approve', 'trust.reject', 'client.account.login', 'client.account.qr.start']) {
          await expect(control.handle(blocked, action, signal, local)).resolves.toMatchObject(busy)
        }
        expect(client.approvePeer).not.toHaveBeenCalled()
        expect(client.rejectPeer).not.toHaveBeenCalled()
        expect(client.handleControl).toHaveBeenCalledTimes(1)
        gate.resolve()
        await expect(login).resolves.toMatchObject({ ok: true })
        await expect(control.handle('trust.approve', action, signal, local)).resolves.toMatchObject({ ok: true })
        expect(client.approvePeer).toHaveBeenCalledOnce()
        expect(client.approvePeer).toHaveBeenCalledWith({
          deviceId: action.deviceId, generation: action.generation, fullFingerprint: action.fullFingerprint,
        })
      } finally {
        gate.resolve()
        await login
      }
    },
  )

  it('invalidates both old authorities before same-URL Host-to-Client replacement and selects only new facades', async () => {
    const settings = settingsBinding()
    const oldHost = facade()
    const oldClient = facade()
    const newHost = facade()
    const newClient = facade()
    const invalidationGate = deferred()
    const invalidationStarted = deferred()
    oldClient.invalidatePeerApprovals.mockImplementation(async () => {
      invalidationStarted.resolve()
      await invalidationGate.promise
    })
    const switchServer = vi.fn(async (next: ReturnType<typeof resolveConfig>) => {
      expect(next).toMatchObject({ role: 'client', serverUrl: 'https://synthetic.example' })
      expect(oldHost.invalidatePeerApprovals).toHaveBeenCalledOnce()
      expect(oldClient.invalidatePeerApprovals).toHaveBeenCalledOnce()
      expect(settings.get()).toMatchObject({ role: 'client' })
      return { client: newClient as unknown as ClientModeRuntime, host: newHost as unknown as HostAuthorizationControl }
    })
    const control = unitControl(new PluginControlRuntime(resolveConfig(settings.get()), '/unused-synthetic-unit-directory', settings,
      oldClient as unknown as ClientModeRuntime, oldHost as unknown as HostAuthorizationControl, switchServer))
    // Bypass credential/identity stores and owned-role network authorization.
    control.association = vi.fn(async (): Promise<PluginAssociation> => ({ method: 'account', account: 'synthetic@example.invalid' }))
    const signal = new AbortController().signal
    const switching = control.handle('settings.role.set', { role: 'client' }, signal)
    try {
      await invalidationStarted.promise
      expect(switchServer).not.toHaveBeenCalled()
      await expect(control.handle('trust.approve', action, signal, local)).resolves.toMatchObject(busy)
      invalidationGate.resolve()
      await expect(switching).resolves.toMatchObject({ ok: true, value: { config: { role: 'client' } } })
      expect(switchServer).toHaveBeenCalledOnce()
      for (const role of ['host', 'client']) {
        await expect(control.handle('trust.approve', { ...action, role }, signal, local)).resolves.toMatchObject({ ok: true })
      }
      expect(oldHost.approvePeer).not.toHaveBeenCalled()
      expect(oldClient.approvePeer).not.toHaveBeenCalled()
      expect(newHost.approvePeer).toHaveBeenCalledOnce()
      expect(newClient.approvePeer).toHaveBeenCalledOnce()
      await control.handle('client.account.providers', {}, signal)
      expect(newClient.handleControl).toHaveBeenCalledOnce()
      expect(oldClient.handleControl).not.toHaveBeenCalled()
    } finally {
      invalidationGate.resolve()
      await switching
    }
  })
})
