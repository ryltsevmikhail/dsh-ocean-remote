import { describe, expect, it } from 'vitest'
import {
  TRUST_LOADING_HINT,
  TRUST_NO_SAVED_KEYS,
  pendingHint,
  showsNoSavedKeys,
} from '../src/client/peer-trust-model.js'
import type { PeerTrustView } from '../src/peer-trust.js'

const view = (overrides: Partial<PeerTrustView> = {}): PeerTrustView => ({
  role: 'host',
  epochId: 'epoch-1',
  available: true,
  pending: [],
  trusted: [],
  ...overrides,
})

const pending = (deviceId: string): PeerTrustView['pending'][number] => ({
  role: 'client',
  deviceId,
  name: 'peer',
  platform: 'linux',
  origin: 'http://127.0.0.1',
  generation: 'g1',
  fullFingerprint: 'A'.repeat(64),
  expiresAt: Date.now() + 60_000,
})

describe('trust panel model', () => {
  it('does not claim a pending count before the view exists', () => {
    expect(pendingHint(undefined)).toBe(TRUST_LOADING_HINT)
    expect(pendingHint(undefined)).not.toContain('0')
  })

  it('counts the pending requests it will render', () => {
    expect(pendingHint(view())).toContain('Ожидающие запросы: 0')
    expect(pendingHint(view({ pending: [pending('a'), pending('b')] }))).toContain('Ожидающие запросы: 2')
  })

  it('keeps the five-minute note and the changed-key rule', () => {
    const hint = pendingHint(view())
    expect(hint).toContain('до 5 минут')
    expect(hint).toContain('срок проверяет локальная служба')
    expect(hint).toContain('Изменившийся известный ключ нельзя подтвердить здесь')
  })

  it('reports an empty saved-key list only when the role is available', () => {
    expect(showsNoSavedKeys(undefined)).toBe(false)
    expect(showsNoSavedKeys(view({ available: false }))).toBe(false)
    expect(showsNoSavedKeys(view())).toBe(true)
    expect(showsNoSavedKeys(view({ trusted: [{
      deviceId: 'd', name: 'n', platform: 'linux', fullFingerprint: 'B'.repeat(64), provenance: 'manual', trustedAt: 1,
    }] }))).toBe(false)
    expect(TRUST_NO_SAVED_KEYS).toBe('Сохранённых ключей нет.')
  })
})
