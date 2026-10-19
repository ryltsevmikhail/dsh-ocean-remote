// Peer keepalive: the relay does not report a closed tunnel to the other side, so
// without a periodic probe a revoked or vanished peer keeps looking connected.

/** Router-level method used as the keepalive probe; must be answered directly by the Host router. */
export const PEER_KEEPALIVE_METHOD = 'harness.transport.describe'

/** How often the Client checks that the Host still answers. */
export const PEER_KEEPALIVE_INTERVAL_MS = 20_000
/** A single probe may take this long before the peer is considered gone. */
export const PEER_KEEPALIVE_TIMEOUT_MS = 12_000

export type PeerLivenessFailure = 'timeout' | 'error'

export interface PeerLivenessOptions {
  /** Sends one round-trip request; must reject when the peer does not answer. */
  probe: (signal: AbortSignal) => Promise<unknown>
  /** Called exactly once, when the peer stops answering. The owner closes the connection. */
  onDead: (failure: PeerLivenessFailure) => void
  intervalMs?: number
  timeoutMs?: number
}

export class PeerLiveness {
  private timer?: ReturnType<typeof setInterval>
  private active?: AbortController
  private stopped = false

  constructor(private readonly options: PeerLivenessOptions) {}

  start(): void {
    if (this.stopped || this.timer !== undefined) return
    const interval = this.options.intervalMs ?? PEER_KEEPALIVE_INTERVAL_MS
    this.timer = setInterval(() => void this.tick(), interval)
    // A pending probe must not keep the process alive on its own.
    this.timer.unref?.()
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    if (this.timer !== undefined) { clearInterval(this.timer); this.timer = undefined }
    this.active?.abort()
    this.active = undefined
  }

  private fail(failure: PeerLivenessFailure): void {
    if (this.stopped) return
    this.stop()
    this.options.onDead(failure)
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.active !== undefined) return
    const controller = new AbortController()
    this.active = controller
    const timer = setTimeout(() => controller.abort(new Error('peer keepalive timeout')), this.options.timeoutMs ?? PEER_KEEPALIVE_TIMEOUT_MS)
    timer.unref?.()
    try {
      await this.options.probe(controller.signal)
      if (controller.signal.aborted) this.fail('timeout')
    } catch {
      this.fail(controller.signal.aborted ? 'timeout' : 'error')
    } finally {
      clearTimeout(timer)
      if (this.active === controller) this.active = undefined
    }
  }
}
