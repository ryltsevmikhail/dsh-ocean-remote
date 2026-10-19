import type { StatusFeed } from '../status-stream.js'
import { createPeerTrustPanel } from './peer-trust-panel.js'
import type { ClientReact, LocalTrustControl, RemoteStatus } from './types.js'

/** An ordinary footer entry, independent of Plugins-page inventory or role. */
export function createPeerTrustAction(React: ClientReact) {
  const h = React.createElement
  const PeerTrustPanel = createPeerTrustPanel(React)
  const label = 'Доверие устройств'
  return function PeerTrustAction(props: {
    control: <T>(endpoint: string, payload?: unknown) => Promise<T>
    localTrustControl?: LocalTrustControl
    signal?: AbortSignal
    statusFeed: StatusFeed<RemoteStatus>
  }): unknown {
    const [open, setOpen] = React.useState(false)
    const [scopeKey, setScopeKey] = React.useState<string | undefined>(undefined)
    const trigger = React.useRef<HTMLButtonElement | null>(null)
    const dialog = React.useRef<HTMLElement | null>(null)
    const closeButton = React.useRef<HTMLButtonElement | null>(null)

    React.useEffect(() => {
      let previous: string | undefined
      return props.statusFeed.subscribe(status => {
        // Missing/unavailable status is not evidence of a different server.
        if (typeof status.serverUrl !== 'string') return
        if (status.serverUrl === previous) return
        previous = status.serverUrl
        setScopeKey(previous)
        setOpen(false)
      })
    }, [props.statusFeed])

    React.useEffect(() => {
      if (!open) return
      const root = dialog.current
      if (!root) return
      const close = (): void => setOpen(false)
      const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          close()
        } else if (event.key === 'Tab') {
          const items = Array.from(root.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])'))
            .filter(item => item.tabIndex >= 0 && item.getClientRects().length > 0)
          const first = items[0] ?? closeButton.current
          const last = items[items.length - 1] ?? first
          if (event.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) {
            event.preventDefault()
            last?.focus()
          } else if (!event.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) {
            event.preventDefault()
            first?.focus()
          }
        }
      }
      const onFocus = (event: FocusEvent): void => {
        if (!root.contains(event.target as Node)) closeButton.current?.focus()
      }
      closeButton.current?.focus()
      document.addEventListener('keydown', onKeyDown, true)
      document.addEventListener('focusin', onFocus, true)
      props.signal?.addEventListener('abort', close, { once: true })
      if (props.signal?.aborted) close()
      return () => {
        document.removeEventListener('keydown', onKeyDown, true)
        document.removeEventListener('focusin', onFocus, true)
        props.signal?.removeEventListener('abort', close)
        trigger.current?.focus()
      }
    }, [open, props.signal])

    return h(React.Fragment, null,
      h('style', null, '.dshRemoteTrustButton{min-width:36px;min-height:36px;padding:0 8px;font:inherit;font-size:12px}.dshRemoteTrustBackdrop{box-sizing:border-box;pointer-events:auto;-webkit-app-region:no-drag}.dshRemoteTrustDialog{box-sizing:border-box;width:min(760px,100%);max-height:calc(100dvh - 40px);overflow:auto;overscroll-behavior:contain}.dshRemoteTrustDialog .dshRemoteSettings{min-width:0}.dshRemoteTrustDialog code{overflow-wrap:anywhere}.dshRemoteTrustDialog :focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}'),
      h('button', {
        type: 'button', ref: trigger,
        className: 'dshRemoteModeButton dshRemoteTrustButton',
        'aria-label': label, title: label, 'aria-haspopup': 'dialog', 'aria-expanded': open,
        onClick: () => setOpen(true),
      }, 'Ключи'),
      open ? h('div', { className: 'dshRemoteBackdrop dshRemoteTrustBackdrop' },
        h('section', {
          ref: dialog, className: 'dshRemoteDialog dshRemoteTrustDialog',
          role: 'dialog', 'aria-modal': true, 'aria-label': label,
        },
        h('div', { className: 'dshRemoteHeader' },
          h('strong', null, label),
          h('button', { type: 'button', ref: closeButton, 'aria-label': 'Закрыть', onClick: () => setOpen(false) }, '×')),
        // Unmounting on close/server change discards drafts and aborts panel reads.
        // The panel itself remains the owner of per-role/epoch/generation drafts.
        h(PeerTrustPanel, {
          key: scopeKey ?? 'unknown-server', scopeKey,
          control: props.control, localTrustControl: props.localTrustControl, signal: props.signal,
        }))) : null)
  }
}
