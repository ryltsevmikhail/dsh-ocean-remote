import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { fullFingerprint, type TrustedPeer } from './identity-store.js'

export type PeerApprovalInput = Omit<TrustedPeer, 'fingerprint' | 'trustedAt'>
export interface PendingPeerApproval {
  deviceId: string
  name: string
  platform: string
  fullFingerprint: string
  generation: string
  createdAt: number
  expiresAt: number
  epochId: string
  role: 'host' | 'client'
  origin?: string
}
export interface PeerApprovalAction { deviceId: string; generation: string }
export interface ApprovePeerAction extends PeerApprovalAction { fullFingerprint: string }
export interface PeerApprovalStore {
  trustedPeer(id: string): TrustedPeer | undefined
  trustPeer(input: PeerApprovalInput, options?: { provenance: 'manual' }): Promise<TrustedPeer>
}
export interface PeerApprovalQueueOptions {
  epochId: string
  role: 'host' | 'client'
  origin?: string
  /** Monotonic milliseconds, not wall-clock timestamps. */
  now?: () => number
  onChange?: (pending: PendingPeerApproval[]) => void
}
interface Candidate {
  input: PeerApprovalInput
  dto: PendingPeerApproval
  busy: boolean
  revisedAt: number
}
const TTL = 5 * 60_000
const COOLDOWN = 5_000
const CAPACITY = 32

/** Ephemeral authority for exactly one live role/owner epoch. No connection waiters. */
export class PeerApprovalQueue {
  private readonly pending = new Map<string, Candidate>()
  private readonly tombstones = new Map<string, number>()
  private readonly options: PeerApprovalQueueOptions
  private readonly instance = randomUUID()
  private lastNow = -Infinity
  private closed = false
  private indeterminateStore = false
  private flight: Promise<void> = Promise.resolve()

  constructor(private readonly store: PeerApprovalStore, options: PeerApprovalQueueOptions) {
    if (!options.epochId || !['host', 'client'].includes(options.role)) throw new Error('invalid approval scope')
    this.options = { ...options }
  }

  /** Known exact pins (including legacy pins) are honored without rewriting them. */
  request(input: PeerApprovalInput): PendingPeerApproval | undefined {
    this.assertOpen()
    const peer = validateInput(input)
    const now = this.sweep()
    const known = this.store.trustedPeer(peer.deviceId)
    if (known) {
      if (known.publicKey !== peer.publicKey) throw new Error('trusted peer key changed')
      return undefined
    }
    const existing = this.pending.get(peer.deviceId)
    if (existing?.busy) throw new Error('approval busy')
    if (existing?.input.publicKey === peer.publicKey) return { ...existing.dto }
    if (this.tombstones.has(peer.deviceId)) throw new Error('approval cooldown')
    if (existing && now - existing.revisedAt < COOLDOWN) throw new Error('approval revision cooldown')
    if (!existing && this.pending.size >= CAPACITY) throw new Error('approval queue full')
    const dto: PendingPeerApproval = {
      deviceId: peer.deviceId, name: peer.name, platform: peer.platform,
      fullFingerprint: fullFingerprint(peer.publicKey),
      generation: `${this.instance}:${randomUUID()}`,
      createdAt: now, expiresAt: now + TTL,
      epochId: this.options.epochId, role: this.options.role,
      ...(this.options.origin === undefined ? {} : { origin: this.options.origin }),
    }
    this.pending.set(peer.deviceId, { input: peer, dto, busy: false, revisedAt: existing ? now : -Infinity })
    this.emit()
    return { ...dto }
  }

  list(): PendingPeerApproval[] {
    this.sweep()
    return this.snapshot()
  }

  /** Acceptance is synchronous; persistence is serialized. Close cannot undo dispatched IO. */
  approve(action: ApprovePeerAction): Promise<TrustedPeer> {
    let candidate: Candidate
    try {
      this.assertOpen()
      this.sweep()
      candidate = this.candidate(action)
      if (!/^[0-9A-F]{64}$/.test(action.fullFingerprint) || action.fullFingerprint !== candidate.dto.fullFingerprint) {
        throw new Error('full fingerprint mismatch')
      }
      this.assertNoChangedPin(candidate)
      candidate.busy = true
    } catch (error) { return Promise.reject(error) }
    const accepted = candidate
    const operation = this.flight.then(async () => {
      // Another accepted approval may have made persistence indeterminate.
      if (this.indeterminateStore) throw new Error('indeterminate store; recreate approval authority')
      this.assertNoChangedPin(accepted)
      const known = this.store.trustedPeer(accepted.input.deviceId)
      let result: TrustedPeer
      if (known) result = { ...known }
      else {
        try {
          result = await this.store.trustPeer({ ...accepted.input }, { provenance: 'manual' })
        } catch (error) {
          this.indeterminateStore = true
          throw error
        }
      }
      this.pending.delete(accepted.input.deviceId)
      this.emit()
      return { ...result }
    })
    const settled = operation.finally(() => { accepted.busy = false })
    this.flight = settled.then(() => undefined, () => undefined)
    return settled
  }

  reject(action: PeerApprovalAction): void {
    this.assertOpen()
    const now = this.sweep()
    const candidate = this.candidate(action)
    this.pending.delete(candidate.input.deviceId)
    this.tombstone(candidate.input.deviceId, now)
    this.emit()
  }

  async close(): Promise<void> {
    this.closed = true
    await this.flight
    this.pending.clear()
    this.tombstones.clear()
    this.emit()
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('approval queue closed')
    if (this.indeterminateStore) throw new Error('indeterminate store; recreate approval authority')
  }
  private candidate(action: PeerApprovalAction): Candidate {
    const candidate = this.pending.get(action.deviceId)
    if (!candidate || candidate.dto.generation !== action.generation) throw new Error('stale approval generation')
    if (candidate.busy) throw new Error('approval busy')
    return candidate
  }
  private assertNoChangedPin(candidate: Candidate): void {
    const known = this.store.trustedPeer(candidate.input.deviceId)
    if (known && known.publicKey !== candidate.input.publicKey) throw new Error('trusted peer key changed')
  }
  private sweep(): number {
    const sampled = (this.options.now ?? (() => performance.now()))()
    if (!Number.isFinite(sampled)) throw new Error('invalid approval clock')
    const now = this.lastNow = Math.max(this.lastNow, sampled)
    let changed = false
    for (const [id, candidate] of this.pending) {
      if (!candidate.busy && now >= candidate.dto.expiresAt) {
        this.pending.delete(id)
        this.tombstone(id, now)
        changed = true
      }
    }
    for (const [id, until] of this.tombstones) if (now >= until) this.tombstones.delete(id)
    if (changed) this.emit()
    return now
  }
  private tombstone(id: string, now: number): void {
    this.tombstones.delete(id)
    if (this.tombstones.size >= CAPACITY) this.tombstones.delete(this.tombstones.keys().next().value!)
    this.tombstones.set(id, now + COOLDOWN)
  }
  private snapshot(): PendingPeerApproval[] { return [...this.pending.values()].map(candidate => ({ ...candidate.dto })) }
  private emit(): void {
    // Status observers are not authority and cannot turn a successful commit into failure.
    try { this.options.onChange?.(this.snapshot()) } catch { /* observer isolation */ }
  }
}

function validateInput(input: PeerApprovalInput): PeerApprovalInput {
  if (!input || typeof input !== 'object') throw new Error('invalid peer descriptor')
  for (const [value, max] of [[input.deviceId, 256], [input.name, 80], [input.platform, 40]] as const) {
    if (typeof value !== 'string' || value.length < 1 || value.length > max) throw new Error('invalid peer descriptor')
  }
  if (typeof input.publicKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.publicKey)
    || Buffer.from(input.publicKey, 'base64url').length !== 32
    || Buffer.from(input.publicKey, 'base64url').toString('base64url') !== input.publicKey) throw new Error('invalid peer public key')
  if (input.membershipId !== undefined && (typeof input.membershipId !== 'string' || !input.membershipId || input.membershipId.length > 256)) {
    throw new Error('invalid peer membership')
  }
  return { deviceId: input.deviceId, name: input.name, platform: input.platform, publicKey: input.publicKey,
    ...(input.membershipId === undefined ? {} : { membershipId: input.membershipId }) }
}
