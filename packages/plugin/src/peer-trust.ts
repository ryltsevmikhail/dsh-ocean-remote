import { fullFingerprint, type HostIdentity, type IdentityStore } from './identity-store.js'
import type { PeerApprovalQueue, PendingPeerApproval } from './peer-approval.js'

export interface PeerTrustView {
  role: 'host' | 'client'
  epochId: string
  available: boolean
  self?: { deviceId: string; fullFingerprint: string }
  pending: PendingPeerApproval[]
  trusted: Array<{ deviceId: string; name: string; platform: string; fullFingerprint: string; provenance: 'manual' | 'legacy'; trustedAt: number }>
}

/** Explicit projection: neither private keys nor raw peer keys cross the facade. */
export function buildPeerTrustView(role: PeerTrustView['role'], epochId: string, available: boolean, identity: HostIdentity | undefined, store: IdentityStore, queue?: PeerApprovalQueue): PeerTrustView {
  return {
    role, epochId, available,
    ...(identity === undefined ? {} : { self: { deviceId: identity.deviceId, fullFingerprint: fullFingerprint(identity.publicKey) } }),
    pending: available ? queue?.list() ?? [] : [],
    trusted: identity === undefined ? [] : store.listTrustedPeers().map(peer => ({
      deviceId: peer.deviceId, name: peer.name, platform: peer.platform,
      fullFingerprint: fullFingerprint(peer.publicKey), provenance: peer.provenance ?? 'legacy', trustedAt: peer.trustedAt,
    })),
  }
}
