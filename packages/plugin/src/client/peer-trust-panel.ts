import type { ClientReact, LocalTrustControl, PeerTrustStatus } from './types.js'
import { TRUST_NO_SAVED_KEYS, pendingHint, showsNoSavedKeys } from './peer-trust-model.js'

type Draft = { checked: boolean; fingerprint: string }
const fullSha256 = /^[0-9A-F]{64}$/

export function createPeerTrustPanel(React: ClientReact) {
  const h = React.createElement
  return function PeerTrustPanel(props: {
    control: <T>(endpoint: string, payload?: unknown) => Promise<T>
    localTrustControl?: LocalTrustControl
    signal?: AbortSignal
  }): unknown {
    const [status, setStatus] = React.useState<PeerTrustStatus | undefined>(undefined)
    const [drafts, setDrafts] = React.useState<Record<string, Draft>>({})
    const [busy, setBusy] = React.useState(false)
    const [error, setError] = React.useState('')
    const lifetime = React.useRef<AbortController | undefined>(undefined)
    const locked = React.useRef(false)
    const keyOf = (role: string, epoch: string, deviceId: string, generation: string): string => JSON.stringify([role, epoch, deviceId, generation])
    const apply = (next: PeerTrustStatus): void => {
      setStatus(next)
      const keys = new Set<string>()
      for (const role of ['host', 'client'] as const) {
        const view = next[role]
        if (view?.role !== role) continue
        for (const item of view.pending) keys.add(keyOf(role, view.epochId, item.deviceId, item.generation))
      }
      setDrafts(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => keys.has(key))))
    }
    const refresh = async (signal: AbortSignal): Promise<void> => {
      const next = props.localTrustControl
        ? await props.localTrustControl<PeerTrustStatus>('trust.status', {}, signal)
        : await props.control<PeerTrustStatus>('trust.status', {})
      if (!signal.aborted) apply(next)
    }
    const runRefresh = async (): Promise<void> => {
      const signal = lifetime.current?.signal
      if (!signal || signal.aborted || locked.current) return
      locked.current = true
      setBusy(true)
      setError('')
      try { await refresh(signal) }
      catch { if (!signal.aborted) { setStatus(undefined); setDrafts({}); setError('Не удалось обновить состояние доверия. Обновите вручную.') } }
      finally { if (!signal.aborted) { locked.current = false; setBusy(false) } }
    }
    React.useEffect(() => {
      const controller = new AbortController()
      lifetime.current = controller
      locked.current = false
      setStatus(undefined)
      setDrafts({})
      const abort = (): void => controller.abort()
      props.signal?.addEventListener('abort', abort, { once: true })
      if (props.signal?.aborted) controller.abort()
      void runRefresh()
      return () => { controller.abort(); props.signal?.removeEventListener('abort', abort) }
    }, [props.control, props.localTrustControl, props.signal])

    const mutate = async (role: 'host' | 'client', deviceId: string, generation: string, fullFingerprint: string, epochId: string, approve: boolean): Promise<void> => {
      const signal = lifetime.current?.signal
      const key = keyOf(role, epochId, deviceId, generation)
      const draft = drafts[key]
      if (!signal || signal.aborted || locked.current || !props.localTrustControl || status?.localApproval !== true) return
      const view = status[role]
      const candidate = view?.pending.find(item => item.deviceId === deviceId && item.generation === generation)
      if (!view?.available || view.role !== role || view.epochId !== epochId || candidate?.role !== role || candidate.epochId !== epochId || candidate.fullFingerprint !== fullFingerprint) return
      if (approve && (view.trusted.some(pin => pin.deviceId === deviceId && pin.fullFingerprint !== fullFingerprint) || !draft?.checked || !fullSha256.test(fullFingerprint) || draft.fingerprint !== fullFingerprint)) return
      locked.current = true
      setBusy(true)
      setError('')
      try {
        await props.localTrustControl(approve ? 'trust.approve' : 'trust.reject', {
          role, deviceId, generation, ...(approve ? { fullFingerprint } : {}),
        }, signal)
        if (!signal.aborted) setDrafts(previous => { const next = { ...previous }; delete next[key]; return next })
      } catch {
        if (!signal.aborted) setError('Действие не выполнено. Запрос мог измениться или истечь; обновите состояние и проверьте ключ заново.')
      } finally {
        if (!signal.aborted) {
          try { await refresh(signal) }
          catch { if (!signal.aborted) { setStatus(undefined); setDrafts({}); setError('Не удалось обновить состояние доверия. Обновите вручную.') } }
        }
        if (!signal.aborted) { locked.current = false; setBusy(false) }
      }
    }
    // Removing a pin is irreversible for that peer: confirm before calling the local endpoint.
    const revoke = async (role: 'host' | 'client', deviceId: string, name: string): Promise<void> => {
      const signal = lifetime.current?.signal
      if (!signal || signal.aborted || locked.current || !props.localTrustControl || status?.localApproval !== true) return
      if (typeof window === 'undefined' || typeof window.confirm !== 'function') {
        setError('Подтверждение недоступно в этом окне. Действие отменено.')
        return
      }
      if (!window.confirm(`Снять доверие с устройства ${name}? Следующее подключение потребует нового подтверждения ключа.`)) return
      locked.current = true
      setBusy(true)
      setError('')
      try {
        const result = await props.localTrustControl<{ revoked?: boolean }>('trust.revoke', { role, deviceId }, signal)
        if (result?.revoked === false) setError('Ключ уже не сохранён: обновите список и проверьте состояние.')
      } catch {
        if (!signal.aborted) setError('Не удалось снять доверие. Обновите состояние и повторите.')
      } finally {
        if (!signal.aborted) {
          try { await refresh(signal) }
          catch { if (!signal.aborted) { setStatus(undefined); setError('Не удалось обновить состояние доверия. Обновите вручную.') } }
        }
        if (!signal.aborted) { locked.current = false; setBusy(false) }
      }
    }

    const writable = !!props.localTrustControl && status?.localApproval === true
    return h('section', { className: 'dshRemoteSettings', 'aria-label': 'Доверие устройствам' },
      h('h3', null, 'Доверие устройствам — SHA-256'),
      h('p', null, 'Сначала Client подтверждает Host, затем Host подтверждает Client. Передайте собственный ключ ДРУГОГО устройства по независимому доверенному каналу. Не копируйте вслепую ключ из запроса.'),
      h('p', null, 'После обоих подтверждений вручную повторите существующее действие «Подключить» (Connect / Retry). Подтверждение само не подключает устройство.'),
      !writable ? h('p', { className: 'dshRemoteNotice' }, 'Только просмотр. Для подтверждения откройте локальный DSH Web на этом компьютере; удалённый RPC не даёт права подтверждать ключи.') : null,
      h('button', { type: 'button', disabled: busy || props.signal?.aborted, onClick: () => void runRefresh() }, busy ? 'Обновление…' : 'Обновить доверие'),
      error ? h('p', { className: 'dshRemoteError', role: 'alert' }, error) : null,
      ...(['host', 'client'] as const).map(role => {
        const view = status?.[role]
        const validView = view?.role === role ? view : undefined
        return h('section', { key: role, className: 'dshRemoteField' },
          h('h4', null, role === 'host' ? 'Host — ключ принимающей стороны' : 'Client — ключ подключающейся стороны'),
          !validView?.available ? h('p', null, 'Роль недоступна.') : null,
          h('p', null, 'Собственный Device ID: ', h('code', { className: 'dshRemoteSha' }, validView?.self?.deviceId ?? '—')),
          h('p', null, 'Собственный полный SHA-256: ', h('code', { className: 'dshRemoteSha' }, validView?.self?.fullFingerprint ?? '—')),
          h('p', null, pendingHint(validView)),
          ...(validView?.pending ?? []).map(item => {
            const key = keyOf(role, validView!.epochId, item.deviceId, item.generation)
            const draft = drafts[key] ?? { checked: false, fingerprint: '' }
            const update = (change: Partial<Draft>): void => setDrafts(previous => ({ ...previous, [key]: { ...(previous[key] ?? { checked: false, fingerprint: '' }), ...change } }))
            const knownChanged = validView!.trusted.some(pin => pin.deviceId === item.deviceId && pin.fullFingerprint !== item.fullFingerprint)
            const disabled = busy || !writable || !validView!.available || item.role !== role || item.epochId !== validView!.epochId || knownChanged
            return h('div', { key, className: 'dshRemoteField' },
              h('strong', null, 'Недоверенное имя запроса: ', item.name),
              h('p', null, 'Device ID: ', h('code', { className: 'dshRemoteSha' }, item.deviceId), '; платформа: ', item.platform),
              h('p', null, 'Недоверенный origin: ', item.origin ?? 'не указан'),
              h('p', null, 'Полный SHA-256 запроса: ', h('code', { className: 'dshRemoteSha' }, item.fullFingerprint)),
              knownChanged ? h('p', { className: 'dshRemoteError' }, 'Известный ключ изменился. Подтверждение запрещено.') : null,
              h('label', null, h('input', { type: 'checkbox', checked: draft.checked, disabled, onChange: (event: Event) => update({ checked: (event.target as HTMLInputElement).checked }) }), 'Сверил полный SHA-256 на другом устройстве'),
              h('label', null, 'Введите полный SHA-256 с другого устройства (64 символа 0–9, A–F):', h('input', {
                type: 'text', value: draft.fingerprint, disabled, autoComplete: 'off', spellCheck: false, autoCapitalize: 'off',
                'aria-label': `Полный SHA-256: ${role} ${item.deviceId}`,
                onChange: (event: Event) => update({ fingerprint: (event.target as HTMLInputElement).value }),
              })),
              h('button', { type: 'button', 'data-variant': 'primary', disabled: disabled || !draft.checked || !fullSha256.test(draft.fingerprint) || draft.fingerprint !== item.fullFingerprint, onClick: () => void mutate(role, item.deviceId, item.generation, item.fullFingerprint, validView!.epochId, true) }, 'Подтвердить ключ'),
              h('button', { type: 'button', disabled: busy || !writable, onClick: () => void mutate(role, item.deviceId, item.generation, item.fullFingerprint, validView!.epochId, false) }, 'Отклонить'))
          }),
          h('h4', null, 'Сохранённые ключи'),
          showsNoSavedKeys(validView) ? h('p', null, TRUST_NO_SAVED_KEYS) : null,
          ...(validView?.trusted ?? []).map(pin => h('div', { key: pin.deviceId },
            h('p', null, pin.name, ' — Device ID: ', pin.deviceId, '; платформа: ', pin.platform),
            h('code', { className: 'dshRemoteSha' }, pin.fullFingerprint),
            h('p', null, pin.provenance === 'manual' ? 'Подтверждён вручную.' : 'Legacy: происхождение подтверждения неизвестно; не считается ручным подтверждением.'),
            h('button', {
              type: 'button', 'data-variant': 'danger', disabled: busy || !writable || validView?.available !== true || validView?.role !== role,
              'aria-label': `Снять доверие: ${role} ${pin.deviceId}`,
              onClick: () => void revoke(role, pin.deviceId, pin.name),
            }, 'Снять доверие'))))
      }))
  }
}
