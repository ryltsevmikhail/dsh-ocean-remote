// Reconnect backoff for the Client. Pure so the schedule can be reasoned about and
// tested without timers, sockets or a remote Host.

export interface ReconnectTiming {
  initialDelayMs: number
  maxDelayMs: number
  /** Fraction of the delay applied as ± jitter, 0..1. */
  jitter: number
}

/** Give up after this many consecutive attempts; the operator still has the manual retry. */
export const MAX_RECONNECT_ATTEMPTS = 6

/** Delay before the next attempt: exponential, capped, with symmetric jitter. */
export function reconnectDelay(attempt: number, timing: ReconnectTiming, random: () => number = Math.random): number {
  const step = Math.max(0, Math.min(attempt, 30))
  const base = Math.min(timing.maxDelayMs, timing.initialDelayMs * 2 ** step)
  const spread = Math.max(0, Math.min(1, timing.jitter)) * base
  // random() in [0,1) → offset in (-spread, +spread]
  const offset = (random() * 2 - 1) * spread
  return Math.max(0, Math.round(base + offset))
}

/** Attempts stop when the failure is not worth retrying (trust, auth, incompatible Host). */
export function shouldRetry(error: unknown): boolean {
  const retryable = (error as { retryable?: unknown } | undefined)?.retryable
  if (retryable === false) return false
  const code = (error as { code?: unknown } | undefined)?.code
  if (typeof code !== 'string') return true
  return !['PEER_APPROVAL_REQUIRED', 'PEER_IDENTITY_MISMATCH', 'AUTH_REQUIRED', 'AUTH_INVALID',
    'FEATURE_NOT_SUPPORTED', 'CONNECTION_REPLACED', 'HOST_VERSION_UNSUPPORTED'].includes(code)
}
