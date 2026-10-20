import { describe, expect, it, vi } from 'vitest'
import { MAX_RECONNECT_ATTEMPTS, reconnectDelay, shouldRetry } from '../src/reconnect-policy.js'

const timing = { initialDelayMs: 1000, maxDelayMs: 8000, jitter: 0 }

describe('reconnect policy', () => {
  it('grows exponentially and stops at the cap', () => {
    const delays = [0, 1, 2, 3, 4, 5].map(attempt => reconnectDelay(attempt, timing))
    expect(delays).toEqual([1000, 2000, 4000, 8000, 8000, 8000])
    // A large attempt number must not overflow into Infinity/NaN.
    expect(reconnectDelay(1000, timing)).toBe(8000)
  })

  it('applies symmetric jitter inside the configured fraction', () => {
    const jittered = { ...timing, jitter: 0.2 }
    expect(reconnectDelay(0, jittered, () => 0)).toBe(800)
    expect(reconnectDelay(0, jittered, () => 0.5)).toBe(1000)
    expect(reconnectDelay(0, jittered, () => 0.999999)).toBe(1200)
    // Jitter can never produce a negative or non-integer delay.
    for (const random of [0, 0.1, 0.5, 0.9, 0.999]) {
      const value = reconnectDelay(3, { ...timing, jitter: 1 }, () => random)
      expect(Number.isInteger(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(0)
    }
  })

  it('keeps the attempt budget bounded', () => {
    expect(MAX_RECONNECT_ATTEMPTS).toBeGreaterThan(0)
    expect(MAX_RECONNECT_ATTEMPTS).toBeLessThanOrEqual(10)
  })

  it('stops retrying failures that a retry cannot fix', () => {
    expect(shouldRetry({ code: 'PEER_APPROVAL_REQUIRED', retryable: true })).toBe(false)
    expect(shouldRetry({ code: 'PEER_IDENTITY_MISMATCH' })).toBe(false)
    expect(shouldRetry({ code: 'AUTH_REQUIRED' })).toBe(false)
    expect(shouldRetry({ code: 'CONNECTION_REPLACED' })).toBe(false)
    expect(shouldRetry({ code: 'CONNECTION_FAILED', retryable: false })).toBe(false)
    expect(shouldRetry({ code: 'CONNECTION_FAILED', retryable: true })).toBe(true)
    expect(shouldRetry(new Error('socket hang up'))).toBe(true)
    expect(shouldRetry(undefined)).toBe(true)
  })
})
