import { describe, expect, it } from 'vitest'
import { connectionLayers, pickLayerDevice, pruneFailedHost } from '../src/client/presentation.js'

describe('connection layers', () => {
  it('reports trust as pending for an unknown key and no connection', () => {
    const layers = connectionLayers({ needsAuthorization: false, device: { deviceId: 'a', trustState: 'unknown' }, connectedTargetDeviceId: undefined })
    expect(layers.map(item => item.key)).toEqual(['layerAccountOk', 'layerTrustPending', 'layerTransportNone'])
  })

  it('reports a changed key as a conflict instead of trusted', () => {
    const layers = connectionLayers({ needsAuthorization: false, device: { deviceId: 'a', trustState: 'conflict' }, connectedTargetDeviceId: 'a' })
    expect(layers.map(item => item.key)).toEqual(['layerAccountOk', 'layerTrustConflict'])
  })

  it('omits the transport warning only for the actually connected Host', () => {
    const connected = connectionLayers({ needsAuthorization: false, device: { deviceId: 'a', trustState: 'trusted' }, connectedTargetDeviceId: 'a' })
    expect(connected.map(item => item.key)).toEqual(['layerAccountOk', 'layerTrustOk'])
    // A live connection to A must not hide a failed attempt to B.
    const other = connectionLayers({ needsAuthorization: false, device: { deviceId: 'b', trustState: 'trusted' }, connectedTargetDeviceId: 'a' })
    expect(other.map(item => item.key)).toEqual(['layerAccountOk', 'layerTrustOk', 'layerTransportNone'])
  })

  it('shows account sign-in as required before any Host is chosen', () => {
    const layers = connectionLayers({ needsAuthorization: true, device: undefined, connectedTargetDeviceId: undefined })
    expect(layers).toEqual([
      { key: 'layerAccountRequired', state: 'required' },
      { key: 'layerTransportNone', state: 'none' },
    ])
  })
})

describe('retry target pruning', () => {
  it('keeps an online known target and drops offline or removed ones', () => {
    const previous = { deviceId: 'a', online: true }
    expect(pruneFailedHost(previous, [{ deviceId: 'a', online: true }])).toMatchObject({ deviceId: 'a' })
    expect(pruneFailedHost(previous, [{ deviceId: 'a', online: false }])).toBeUndefined()
    expect(pruneFailedHost(previous, [{ deviceId: 'b', online: true }])).toBeUndefined()
    expect(pruneFailedHost(undefined, [])).toBeUndefined()
  })
})

describe('layer device selection', () => {
  it('describes the Host the user acted on, not the connected one', () => {
    const live = { deviceId: 'a' }
    const failed = { deviceId: 'b' }
    expect(pickLayerDevice({ failed, connected: live })).toBe(failed)
    expect(pickLayerDevice({ connected: live })).toBe(live)
    expect(pickLayerDevice({})).toBeUndefined()
    // A connected A plus a failed attempt to B must still warn about the transport.
    const layers = connectionLayers({
      needsAuthorization: false,
      device: pickLayerDevice({ failed: { deviceId: 'b', trustState: 'trusted' }, connected: { deviceId: 'a', trustState: 'trusted' } }),
      connectedTargetDeviceId: 'a',
    })
    expect(layers.map(item => item.key)).toEqual(['layerAccountOk', 'layerTrustOk', 'layerTransportNone'])
  })
})
