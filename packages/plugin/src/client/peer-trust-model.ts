import type { PeerTrustView } from '../peer-trust.js'

/** States the panel knows: undefined means "not loaded yet", not "nothing there". */
export type TrustView = PeerTrustView | undefined

export const TRUST_PENDING_HINT = 'Ожидающие запросы: {count}. Каждый действует до 5 минут; срок проверяет локальная служба, а не часы браузера. Изменившийся известный ключ нельзя подтвердить здесь.'
export const TRUST_LOADING_HINT = 'Состояние доверия загружается…'
export const TRUST_NO_SAVED_KEYS = 'Сохранённых ключей нет.'

/** Pending requests are only counted once the panel actually has a view. */
export function pendingHint(view: TrustView): string {
  if (view === undefined) return TRUST_LOADING_HINT
  return TRUST_PENDING_HINT.replace('{count}', String(view.pending.length))
}

/** An empty saved-key list is only a fact when the role is available. */
export function showsNoSavedKeys(view: TrustView): boolean {
  return view !== undefined && view.available === true && view.trusted.length === 0
}
