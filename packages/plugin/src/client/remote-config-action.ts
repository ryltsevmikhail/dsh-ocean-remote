import { dialogTabStops } from './dialog-focus.js'
import type { StatusFeed } from '../status-stream.js'
import type { ClientReact, LocalTrustControl, RemoteStatus } from './types.js'

/** Always-reachable settings surface: server, role and Host sign-in without the Plugins page. */
export function createRemoteConfigAction(React: ClientReact, RemotePluginOptions: unknown) {
  const h = React.createElement
  const labelKey = 'remoteConfigLabel'
  const Options = RemotePluginOptions as (props: {
    control: <T>(endpoint: string, payload?: unknown) => Promise<T>
    localTrustControl?: LocalTrustControl
    signal?: AbortSignal
    statusFeed: StatusFeed<RemoteStatus>
    t: (key: string, params?: Record<string, string | number>) => string
    view?: 'summary' | 'page'
  }) => unknown

  return function RemoteConfigAction(props: {
    control: <T>(endpoint: string, payload?: unknown) => Promise<T>
    localTrustControl?: LocalTrustControl
    signal?: AbortSignal
    statusFeed: StatusFeed<RemoteStatus>
    t: (key: string, params?: Record<string, string | number>) => string
  }): unknown {
    const [open, setOpen] = React.useState(false)
    const [scopeKey, setScopeKey] = React.useState<string | undefined>(undefined)
    const trigger = React.useRef<HTMLButtonElement | null>(null)
    const dialog = React.useRef<HTMLElement | null>(null)
    const closeButton = React.useRef<HTMLButtonElement | null>(null)

    React.useEffect(() => {
      // Seed from the current frame: an unseeded 'previous' would close the modal
      // on the very first status push.
      let previous = props.statusFeed.getSnapshot()?.serverUrl
      return props.statusFeed.subscribe(status => {
        // Missing status is not evidence of a different Server.
        if (typeof status.serverUrl !== 'string') return
        if (status.serverUrl === previous) return
        previous = status.serverUrl
        // Remount the card for the new Server without discarding the dialog the
        // user just opened to change that Server.
        setScopeKey(status.serverUrl)
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
          const items = dialogTabStops(root)
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
      h('style', null, '.dshRemoteConfigButton{min-width:36px;min-height:36px;padding:0 8px;font:inherit;font-size:12px}.dshRemoteConfigBackdrop{box-sizing:border-box;pointer-events:auto;-webkit-app-region:no-drag}.dshRemoteConfigDialog{box-sizing:border-box;width:min(760px,100%);max-height:calc(100dvh - 40px);overflow:auto;overscroll-behavior:contain}.dshRemoteConfigDialog .dshRemoteSettings{min-width:0}.dshRemoteConfigDialog :focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}'),
      h('button', {
        type: 'button', ref: trigger,
        className: 'dshRemoteModeButton dshRemoteConfigButton',
        'aria-label': props.t(labelKey), title: props.t(labelKey), 'aria-haspopup': 'dialog', 'aria-expanded': open,
        onClick: () => setOpen(true),
      }, props.t('remoteConfigOpen')),
      open ? h('div', { className: 'dshRemoteBackdrop dshRemoteConfigBackdrop' },
        h('section', {
          ref: dialog, className: 'dshRemoteDialog dshRemoteConfigDialog',
          role: 'dialog', 'aria-modal': true, 'aria-label': props.t(labelKey),
        },
        h('div', { className: 'dshRemoteHeader' },
          h('strong', null, props.t(labelKey)),
          h('button', { type: 'button', ref: closeButton, 'aria-label': props.t('closeAction'), onClick: () => setOpen(false) }, '×')),
        // Remounting on close/server change drops unsaved drafts instead of replaying them.
        h(Options, {
          key: scopeKey ?? 'unknown-server',
          control: props.control, localTrustControl: props.localTrustControl, signal: props.signal,
          statusFeed: props.statusFeed, t: props.t, view: 'page',
        }))) : null)
  }
}
