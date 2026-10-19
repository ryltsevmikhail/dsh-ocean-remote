import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PeerLiveness } from '../src/peer-liveness.js'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('peer liveness', () => {
  it('treats an answering peer as healthy and keeps probing', async () => {
    const probe = vi.fn(async () => undefined)
    const onDead = vi.fn()
    const liveness = new PeerLiveness({ probe, onDead, intervalMs: 1000, timeoutMs: 500 })
    liveness.start()
    await vi.advanceTimersByTimeAsync(3200)
    expect(probe).toHaveBeenCalledTimes(3)
    expect(onDead).not.toHaveBeenCalled()
    liveness.stop()
  })

  it('reports a silent peer exactly once and aborts its probe', async () => {
    let observed: AbortSignal | undefined
    const probe = vi.fn((signal: AbortSignal) => {
      observed = signal
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })
    const onDead = vi.fn()
    const liveness = new PeerLiveness({ probe, onDead, intervalMs: 1000, timeoutMs: 500 })
    liveness.start()
    await vi.advanceTimersByTimeAsync(1000 + 600)
    expect(observed?.aborted).toBe(true)
    expect(onDead).toHaveBeenCalledOnce()
    expect(onDead).toHaveBeenCalledWith('timeout')
    // No further probes after the peer is declared dead.
    await vi.advanceTimersByTimeAsync(5000)
    expect(probe).toHaveBeenCalledOnce()
  })

  it('does not stack probes when the previous one is still running', async () => {
    const probe = vi.fn(() => new Promise<void>(() => undefined))
    const onDead = vi.fn()
    const liveness = new PeerLiveness({ probe, onDead, intervalMs: 1000, timeoutMs: 100_000 })
    liveness.start()
    await vi.advanceTimersByTimeAsync(5000)
    expect(probe).toHaveBeenCalledOnce()
    liveness.stop()
    expect(onDead).not.toHaveBeenCalled()
  })

  it('reports a probe failure as a dead peer and stops', async () => {
    const probe = vi.fn(async () => { throw new Error('transport closed') })
    const onDead = vi.fn()
    const liveness = new PeerLiveness({ probe, onDead, intervalMs: 1000, timeoutMs: 500 })
    liveness.start()
    await vi.advanceTimersByTimeAsync(1100)
    expect(onDead).toHaveBeenCalledWith('error')
    await vi.advanceTimersByTimeAsync(5000)
    expect(probe).toHaveBeenCalledOnce()
  })
})
