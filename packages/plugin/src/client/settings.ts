import type { LocalizedMessage, Translate } from '../client-locale.js'
import type { StatusFeed } from '../status-stream.js'
import {
  connectionErrorMessage,
  connectionStatusClass,
  connectionStatusLabel,
  formatLocalTime,
  messageOf,
} from './presentation.js'
import type { ClientReact, LocalTrustControl, PluginAssociation, PluginSettingsView, RemoteStatus } from './types.js'
import { createPeerTrustPanel } from './peer-trust-panel.js'

export function createRemotePluginOptions(React: ClientReact) {
  const PeerTrustPanel = createPeerTrustPanel(React)
  function RemotePluginOptions(props: {
    control: <T>(endpoint: string, payload?: unknown) => Promise<T>
    localTrustControl?: LocalTrustControl
    signal?: AbortSignal
    statusFeed: StatusFeed<RemoteStatus>
    t: Translate
    view?: 'summary' | 'page'
  }): unknown {
    const { t } = props
    const [open, setOpen] = React.useState(props.view === 'page')
    const [serverUrl, setServerUrl] = React.useState('')
    const [portsBusy, setPortsBusy] = React.useState(false)
    const [previewPorts, setPreviewPorts] = React.useState('')
    const [roleValue, setRoleValue] = React.useState<'host' | 'client'>('host')
    const [roleBusy, setRoleBusy] = React.useState(false)
    const [hostEmail, setHostEmail] = React.useState('')
    const [hostPassword, setHostPassword] = React.useState('')
    const [hostLoginBusy, setHostLoginBusy] = React.useState(false)
    const [registrationCode, setRegistrationCode] = React.useState('')
    const [associations, setAssociations] = React.useState<Partial<Record<'host' | 'client', PluginAssociation>>>({})
    const [loaded, setLoaded] = React.useState(false)
    const [writable, setWritable] = React.useState(false)
    const [busy, setBusy] = React.useState(false)
    const [terminalEnabled, setTerminalEnabled] = React.useState(false)
    const [terminalBusy, setTerminalBusy] = React.useState(false)
    const [acpBackends, setAcpBackends] = React.useState<Array<{ id: string; enabled: boolean }>>([])
    const [acpAvailability, setAcpAvailability] = React.useState<Record<string, boolean>>({})
    const [acpChecking, setAcpChecking] = React.useState<Record<string, boolean>>({})
    const [acpCheckResults, setAcpCheckResults] = React.useState<Record<string, boolean | undefined>>({})
    const [addingAcp, setAddingAcp] = React.useState(false)
    const [acpName, setAcpName] = React.useState('')
    const [acpCommand, setAcpCommand] = React.useState('')
    const [acpArguments, setAcpArguments] = React.useState('acp')
    const [reconnectBusy, setReconnectBusy] = React.useState(false)
    const [hostStatus, setHostStatus] = React.useState<RemoteStatus['host'] | undefined>(undefined)
    const [hostName, setHostName] = React.useState('')
    const [hostDeviceId, setHostDeviceId] = React.useState('')
    const [notice, setNotice] = React.useState<LocalizedMessage | undefined>(undefined)
    const [error, setError] = React.useState<string | undefined>(undefined)
    const [settingsView, setSettingsView] = React.useState<PluginSettingsView | undefined>(undefined)
    const associationReadRun = React.useRef(0)
    const idSuffix = React.useRef(`-${Math.random().toString(36).slice(2, 8)}`).current
    const fieldId = (name: string): string => `dsh-remote-${name}${idSuffix}`
    const persistedServerUrl = settingsView?.config.serverUrl ?? ''
    const association = roleValue === 'client' ? associations.client : associations.host
    const serverDirty = settingsView !== undefined && serverUrl !== persistedServerUrl
    const draftDirty = serverDirty

    const applyAssociations = (view: PluginSettingsView): void => {
      const currentRole = view.config.role === 'client' ? 'client' : 'host'
      setAssociations(view.associations ?? (view.association === undefined ? {} : { [currentRole]: view.association }))
    }

    const applyView = (view: PluginSettingsView, updateAssociations = true): void => {
      setSettingsView(view)
      setServerUrl(view.config.serverUrl ?? '')
      setTerminalEnabled(view.config.terminal?.enabled ?? false)
      setRoleValue(view.config.role === 'client' ? 'client' : 'host')
      setPreviewPorts((view.config.loopback?.ports ?? []).join(', '))
      setAcpBackends((view.config.acp?.backends ?? []).map(item => ({ id: item.id, enabled: item.enabled !== false })))
      setAcpAvailability(view.acpAvailability ?? {})
      if (updateAssociations) applyAssociations(view)
      setWritable(view.writable)
      setLoaded(true)
    }

    const load = async (): Promise<void> => {
      const run = ++associationReadRun.current
      const [view, status] = await Promise.all([
        props.control<PluginSettingsView>('settings.get'),
        props.control<RemoteStatus>('status').catch(() => undefined),
      ])
      applyView(view, run === associationReadRun.current)
      setHostStatus(status?.host)
      setHostName(status?.deviceName ?? '')
      setHostDeviceId(status?.host?.deviceId ?? '')
    }

    React.useEffect(() => {
      void load().catch(reason => failWith(reason))
    }, [])

    React.useEffect(() => {
      let active = true
      let authorizationKey: string | undefined
      const unsubscribe = props.statusFeed.subscribe(status => {
        setHostStatus(status.host)
        setHostName(status.deviceName ?? '')
        setHostDeviceId(status.host?.deviceId ?? '')
        // Either account entry point rotates these identities on sign-out.
        // Refresh both associations on that change, without resetting drafts
        // or fetching settings for ordinary connection/statistics updates.
        const key = JSON.stringify([status.serverUrl, status.deviceId, status.host?.deviceId,
          status.host?.authorized, status.host?.account])
        if (key === authorizationKey) return
        authorizationKey = key
        const run = ++associationReadRun.current
        void props.control<PluginSettingsView>('settings.get').then(view => {
          if (active && run === associationReadRun.current) applyAssociations(view)
        }).catch(() => undefined)
      })
      return () => { active = false; unsubscribe() }
    }, [props.statusFeed])

    // Native override errors name the mechanism but not the fix; users otherwise
    // cannot tell why Save or a role switch keeps failing.
    const failWith = (reason: unknown): void => {
      const native = messageOf(reason)
      setError(/overridden by a home patch or command-line overlay/i.test(native)
        ? `${t('settingsOverridden')} (${native})`
        : native)
    }

    const save = async (event?: Event): Promise<void> => {
      event?.preventDefault()
      if (!writable || !serverDirty) return
      setBusy(true)
      setNotice(undefined)
      setError(undefined)
      try {
        const view = await props.control<PluginSettingsView>('settings.server.set', {
          serverUrl,
        })
        applyView(view)
        setNotice({ key: view.applies === 'live' ? 'serverApplied' : 'serverSaved' })
      } catch (reason) {
        failWith(reason)
      } finally {
        setBusy(false)
      }
    }

    const logout = async (): Promise<void> => {
      const run = ++associationReadRun.current
      setBusy(true)
      setError(undefined)
      setNotice(undefined)
      try {
        const view = await props.control<PluginSettingsView>('settings.logout')
        applyView(view, run === associationReadRun.current)
        setRegistrationCode('')
        setNotice({ key: 'signedOut' })
      } catch (reason) {
        failWith(reason)
      } finally {
        setBusy(false)
      }
    }

    const reconnectHost = async (): Promise<void> => {
      setReconnectBusy(true)
      setError(undefined)
      setNotice(undefined)
      try {
        const status = await props.control<RemoteStatus>('host.reconnect')
        setHostStatus(status.host)
        setNotice({ key: 'reconnectStarted' })
      } catch (reason) {
        failWith(reason)
      } finally {
        setReconnectBusy(false)
      }
    }

    const setCurrentDeviceControl = async (enabled: boolean): Promise<void> => {
      setBusy(true)
      setError(undefined)
      setNotice(undefined)
      try {
        const status = await props.control<RemoteStatus>('host.authorization.set', { enabled })
        setHostStatus(status.host)
      } catch (reason) {
        failWith(reason)
      } finally {
        setBusy(false)
      }
    }

    const setTerminalRemote = async (enabled: boolean): Promise<void> => {
      const previous = terminalEnabled
      const portsDraft = previewPorts
      setTerminalEnabled(enabled)
      setTerminalBusy(true)
      setError(undefined)
      setNotice(undefined)
      try {
        const view = await props.control<PluginSettingsView>('settings.development.set', { terminalEnabled: enabled })
        applyView(view)
        setPreviewPorts(portsDraft)
        setNotice({ key: 'terminalSaved' })
      } catch (reason) {
        setTerminalEnabled(previous)
        failWith(reason)
      } finally {
        setTerminalBusy(false)
      }
    }

    const savePreviewPorts = async (): Promise<void> => {
      setPortsBusy(true)
      setError(undefined)
      setNotice(undefined)
      try {
        const ports = previewPorts.trim() === '' ? [] : previewPorts.split(/[,，]/).map(value => Number(value.trim()))
        const view = await props.control<PluginSettingsView>('settings.development.set', { ports })
        applyView(view)
        setNotice({ key: 'developmentSaved' })
      } catch (reason) {
        failWith(reason)
      } finally {
        setPortsBusy(false)
      }
    }

    const checkAcp = async (backend: string): Promise<void> => {
      if (acpChecking[backend]) return
      setAcpChecking(current => ({ ...current, [backend]: true }))
      setAcpCheckResults(current => ({ ...current, [backend]: undefined }))
      setError(undefined)
      try {
        const view = await props.control<PluginSettingsView>('settings.get')
        applyView(view)
        const available = view.acpAvailability?.[backend] === true
        if (!available && view.writable && view.config.acp?.backends?.some(item => item.id === backend && item.enabled !== false)) {
          applyView(await props.control<PluginSettingsView>('settings.acp.set', { backend, enabled: false }))
        }
        setAcpCheckResults(current => ({ ...current, [backend]: available }))
        setNotice({ key: available ? 'acpAvailable' : 'acpUnavailable' })
        window.setTimeout(() => setAcpCheckResults(current => ({ ...current, [backend]: undefined })), 5_000)
      } catch (reason) {
        failWith(reason)
      } finally {
        setAcpChecking(current => ({ ...current, [backend]: false }))
      }
    }

    const addAcp = async (): Promise<void> => {
      setBusy(true)
      setError(undefined)
      try {
        const view = await props.control<PluginSettingsView>('settings.acp.add', {
          id: acpName.trim(), command: acpCommand.trim(), args: acpArguments.trim() === '' ? [] : acpArguments.trim().split(/\s+/),
        })
        applyView(view)
        setAddingAcp(false)
        setAcpName('')
        setAcpCommand('')
        setAcpArguments('acp')
      } catch (reason) {
        failWith(reason)
      } finally {
        setBusy(false)
      }
    }

    const removeAcp = async (backend: string): Promise<void> => {
      setBusy(true)
      setError(undefined)
      try {
        const view = await props.control<PluginSettingsView>('settings.acp.remove', { id: backend })
        applyView(view)
      } catch (reason) {
        failWith(reason)
      } finally {
        setBusy(false)
      }
    }

    const changeRole = async (next: 'host' | 'client'): Promise<void> => {
      if (next === roleValue) return
      setRoleBusy(true)
      setError(undefined)
      setNotice(undefined)
      // The Host form unmounts on role change; never resurrect a typed password.
      setHostPassword('')
      try {
        const view = await props.control<PluginSettingsView>('settings.role.set', { role: next })
        applyView(view)
        setNotice({ key: view.applies === 'restart' ? 'roleSavedRestart' : 'roleSaved' })
      } catch (reason) {
        failWith(reason)
      } finally {
        setRoleBusy(false)
      }
    }

    const submitHostLogin = async (event: Event): Promise<void> => {
      event.preventDefault()
      setHostLoginBusy(true)
      setError(undefined)
      setNotice(undefined)
      try {
        await props.control('host.account.login', { email: hostEmail.trim(), password: hostPassword })
        setNotice({ key: 'hostLoginOk' })
        applyView(await props.control<PluginSettingsView>('settings.get'))
      } catch (reason) {
        failWith(reason)
      } finally {
        // Never keep the password in component state after the attempt.
        setHostPassword('')
        setHostLoginBusy(false)
      }
    }

    const discard = (): void => {
      if (settingsView !== undefined) applyView(settingsView)
      setRegistrationCode('')
      setNotice(undefined)
      setError(undefined)
    }

    const roleSetting = React.createElement('div', { className: 'dshRemotePathField' },
      React.createElement('label', { htmlFor: fieldId('role') }, t('role')),
      React.createElement('select', {
        id: fieldId('role'), value: roleValue, disabled: busy || roleBusy || hostLoginBusy || !writable, 'aria-label': t('role'),
        onChange: (event: Event) => void changeRole((event.target as HTMLSelectElement).value === 'client' ? 'client' : 'host'),
      },
      React.createElement('option', { value: 'host' }, t('roleHost')),
      React.createElement('option', { value: 'client' }, t('roleClient'))),
      React.createElement('small', null, t('roleHint')))

    const hostLoginSetting = roleValue !== 'host' ? null : React.createElement('section', { className: 'dshRemoteDevelopmentSettings' },
      React.createElement('div', { className: 'dshRemoteSettingsTop' },
        React.createElement('div', null,
          React.createElement('strong', null, t('hostLoginTitle')),
          React.createElement('p', null, t('hostLoginHint')))),
      React.createElement('form', { className: 'dshRemoteSettings', noValidate: true, onSubmit: (event: Event) => void submitHostLogin(event) },
        React.createElement('div', { className: 'dshRemoteField' },
          React.createElement('label', { htmlFor: fieldId('host-email') }, t('serverAccountEmail')),
          React.createElement('input', {
            id: fieldId('host-email'), type: 'email', autoComplete: 'username', value: hostEmail,
            disabled: busy || hostLoginBusy || !writable, required: true,
            onChange: (event: Event) => setHostEmail((event.target as HTMLInputElement).value),
          })),
        React.createElement('div', { className: 'dshRemoteField' },
          React.createElement('label', { htmlFor: fieldId('host-password') }, t('serverAccountPassword')),
          React.createElement('input', {
            id: fieldId('host-password'), type: 'password', autoComplete: 'current-password', value: hostPassword,
            disabled: busy || hostLoginBusy || !writable, required: true,
            onChange: (event: Event) => setHostPassword((event.target as HTMLInputElement).value),
          })),
        React.createElement('button', { type: 'submit', className: 'dshRemoteSave', disabled: busy || roleBusy || hostLoginBusy || !writable || hostEmail.trim() === '' || hostPassword === '' }, t(hostLoginBusy ? 'saving' : 'hostLoginSubmit'))))

    const developmentSetting = React.createElement('section', { className: 'dshRemoteDevelopmentSettings' },
      React.createElement('div', { className: 'dshRemoteAuthorizationSetting' },
        React.createElement('div', null, React.createElement('strong', null, t('terminalRemote')),
          React.createElement('p', null, t('terminalRemoteHint'))),
        React.createElement('input', {
          type: 'checkbox', role: 'switch', checked: terminalEnabled,
          disabled: busy || terminalBusy || !writable, 'aria-label': t('terminalRemote'),
          onChange: (event: Event) => void setTerminalRemote((event.target as HTMLInputElement).checked)
        })),
      React.createElement('div', { className: 'dshRemotePathField' },
        React.createElement('label', { htmlFor: fieldId('preview-ports') }, t('previewPorts')),
        React.createElement('div', { className: 'dshRemotePortsRow' },
          React.createElement('input', {
            id: fieldId('preview-ports'), value: previewPorts, maxLength: 128, size: 24, disabled: !writable,
            placeholder: '3000, 5173', 'aria-label': t('previewPorts'),
            onChange: (event: Event) => setPreviewPorts((event.target as HTMLInputElement).value)
          }),
          React.createElement('button', {
            type: 'button', disabled: portsBusy || terminalBusy || !writable,
            onClick: () => void savePreviewPorts()
          }, t('developmentSave'))),
        React.createElement('small', null, t('previewPortsHint'))))

    const acpSetting = React.createElement('details', { className: 'dshRemoteAuthorizationSetting dshRemoteAcpSetting' },
      React.createElement('summary', null,
        React.createElement('div', { className: 'dshRemoteAcpSummaryText' },
          React.createElement('strong', null, t('agentBackends')),
          React.createElement('p', null, t('acpHint'), React.createElement('a', {
            href: 'https://github.com/liguobao/ds-harness-remote/blob/feat/cursor-remote/docs/acp-remote.md',
            target: '_blank', rel: 'noopener noreferrer',
            onClick: (event: Event) => event.stopPropagation(),
          }, t('acpDocumentation'))))),
      React.createElement('div', { className: 'dshRemoteAcpList' }, acpBackends.map(item => React.createElement('div', { key: item.id, className: 'dshRemoteAuthorizationSetting' },
        React.createElement('div', null, React.createElement('strong', null, item.id === 'codex' ? 'CodeX' : item.id === 'cursor' ? 'Cursor' : item.id === 'antigravity' ? 'AGY' : item.id === 'claude' ? 'Claude' : item.id === 'pi' ? 'Pi' : item.id === 'opencode' ? 'OpenCode' : item.id), null),
        React.createElement('span', { className: 'dshRemoteAcpCheckCell' },
          React.createElement('a', { href: `#check-acp-${item.id}`, className: `dshRemoteAcpCheckLink${acpChecking[item.id] ? ' isChecking' : acpCheckResults[item.id] === undefined ? '' : acpCheckResults[item.id] ? ' isPassed' : ' isFailed'}`, onClick: (event: Event) => { event.preventDefault(); void checkAcp(item.id) } },
            acpChecking[item.id] ? t('checkingAcp') : acpCheckResults[item.id] === undefined ? t('checkAcp') : t(acpCheckResults[item.id] ? 'acpCheckPassed' : 'acpCheckFailed'))),
        ['codex', 'cursor', 'antigravity', 'pi', 'claude', 'opencode'].includes(item.id) ? null : React.createElement('a', { href: `#remove-acp-${item.id}`, className: 'dshRemoteAcpRemoveLink', onClick: (event: Event) => { event.preventDefault(); void removeAcp(item.id) } }, t('removeAcp')),
        React.createElement('input', {
          type: 'checkbox', role: 'switch', checked: (item.id === 'codex' ? item.enabled : settingsView?.config.acp?.enabled === true && item.enabled) && acpAvailability[item.id] === true, 'aria-label': item.id, disabled: busy || !writable || acpChecking[item.id] === true || acpAvailability[item.id] !== true,
          onChange: (event: Event) => void props.control<PluginSettingsView>('settings.acp.set', { backend: item.id, enabled: (event.target as HTMLInputElement).checked }).then(view => { applyView(view); setAcpBackends((view.config.acp?.backends ?? []).map(v => ({ id: v.id, enabled: v.enabled !== false }))) }).catch(reason => failWith(reason))
        }))),
        addingAcp ? React.createElement('div', { className: 'dshRemoteAcpAddForm' },
          React.createElement('label', null, t('acpName'), React.createElement('input', { value: acpName, size: 16, placeholder: t('acpName'), 'aria-label': t('acpName'), onChange: (event: Event) => setAcpName((event.target as HTMLInputElement).value) })),
          React.createElement('label', null, t('acpCommand'), React.createElement('input', { value: acpCommand, size: 20, placeholder: t('acpCommand'), 'aria-label': t('acpCommand'), onChange: (event: Event) => setAcpCommand((event.target as HTMLInputElement).value) })),
          React.createElement('label', null, t('acpArguments'), React.createElement('input', { value: acpArguments, size: 20, placeholder: t('acpArguments'), 'aria-label': t('acpArguments'), onChange: (event: Event) => setAcpArguments((event.target as HTMLInputElement).value) })),
          React.createElement('button', { type: 'button', disabled: busy || acpName.trim() === '' || acpCommand.trim() === '', onClick: () => void addAcp() }, t('addAcp')))
          : React.createElement('a', { href: '#add-acp', className: 'dshRemoteAcpAddLink', onClick: (event: Event) => { event.preventDefault(); setAddingAcp(true) } }, t('addAcp'))))

    if (props.view === 'summary') return React.createElement('span', null, t('pluginDescription'))

    return React.createElement(props.view === 'page' ? 'div' : 'li', { className: `dshRemotePluginCard${open ? ' isOpen' : ''}${props.view === 'page' ? ' dshRemotePluginModern' : ''}` },
      React.createElement('div', { className: 'dshRemotePluginCardHeader' },
        React.createElement('button', {
          type: 'button',
          className: 'dshRemotePluginCardToggle',
          'aria-expanded': open,
          'aria-label': t(open ? 'collapseSettings' : 'expandSettings', { name: t('pluginTitle') }),
          onClick: () => setOpen(current => !current),
        },
          React.createElement('span', { className: 'dshRemotePluginCardHeading' },
            React.createElement('strong', null, t('pluginTitle')),
            React.createElement('span', null, t('pluginDescription'))),
          draftDirty
            ? React.createElement('span', { className: 'dshRemotePluginCardStatus' }, t('unsaved'))
            : association === undefined ? null : React.createElement('span', {
              className: `dshRemotePluginCardStatus${connectionStatusClass(hostStatus)}`,
            }, hostStatus === undefined ? t('associated') : connectionStatusLabel(hostStatus, t)),
          React.createElement('span', { className: 'dshRemotePluginCardChevron', 'aria-hidden': true }, '⌄'))),
      !open ? null : React.createElement('div', { className: 'dshRemotePluginCardBody' },
        React.createElement(PeerTrustPanel, {
          key: JSON.stringify([persistedServerUrl, settingsView?.config.role]),
          control: props.control, localTrustControl: props.localTrustControl, signal: props.signal,
        }),
        !loaded
          ? React.createElement('p', { className: 'dshRemoteSettingsState' }, error ?? t('loadingSettings'))
          : association !== undefined
            ? React.createElement('div', { className: 'dshRemoteSettings' },
              React.createElement('div', { className: 'dshRemoteSettingsTop' },
                React.createElement('div', { className: 'dshRemoteAssociation' },
                  React.createElement('span', null, t(association.account === undefined ? 'authorization' : 'account')),
                  React.createElement('strong', null, association.account
                    ?? t('authorizationComplete')),
                  React.createElement('p', null, association.account === undefined
                    ? serverUrl
                    : t('authorizedOn', { role: 'Remote', serverUrl })))),
              React.createElement('div', { className: 'dshRemoteHostIdentity' },
                React.createElement('div', null,
                  React.createElement('span', null, t('hostName')),
                  React.createElement('strong', null, hostName || '—')),
                React.createElement('div', null,
                  React.createElement('span', null, t('deviceId')),
                  React.createElement('code', null, hostDeviceId || '—'))),
              React.createElement('div', { className: 'dshRemoteField' },
                React.createElement('label', { htmlFor: fieldId('server-url-authorized') }, t('serverUrl')),
                React.createElement('input', {
                  id: fieldId('server-url-authorized'),
                  type: 'url',
                  value: serverUrl,
                  disabled: true,
                  required: true,
                  placeholder: '',
                  onChange: (event: Event) => { setServerUrl((event.target as HTMLInputElement).value); setNotice(undefined) },
                }),
                React.createElement('p', null, t('serverUrlHint'))),
              roleSetting,
              hostLoginSetting,
              developmentSetting,
              acpSetting,
              React.createElement('div', { className: 'dshRemoteAuthorizationSetting' },
                React.createElement('div', null,
                  React.createElement('strong', null, t('allowControlCurrentDevice')),
                  React.createElement('p', null, t('thisMachineHost'))),
                React.createElement('input', {
                  type: 'checkbox', role: 'switch', disabled: busy,
                  'aria-label': t('allowControlCurrentDevice'),
                  checked: hostStatus?.authorized === true,
                  onChange: (event: Event) => void setCurrentDeviceControl((event.target as HTMLInputElement).checked),
                })),
              React.createElement('div', { className: 'dshRemoteConnection', 'aria-live': 'polite' },
                React.createElement('div', { className: 'dshRemoteConnectionSummary' },
                  React.createElement('span', null, t('connection')),
                  React.createElement('strong', null,
                    React.createElement('span', {
                      className: `dshRemoteConnectionDot${connectionStatusClass(hostStatus)}`,
                      'aria-hidden': true,
                    }),
                    connectionStatusLabel(hostStatus, t)),
                  React.createElement('p', null, hostStatus === undefined
                    ? t('checkingConnection')
                    : hostStatus.lastActiveAt === undefined
                      ? t('neverConnected')
                      : t('lastActive', { time: formatLocalTime(hostStatus.lastActiveAt) }))),
                React.createElement('button', {
                  type: 'button',
                  className: 'dshRemoteReconnect',
                  disabled: reconnectBusy || hostStatus?.configured === false,
                  onClick: () => void reconnectHost(),
                }, t(reconnectBusy ? 'reconnectingAction' : 'reconnect'))),
              hostStatus?.error === undefined || hostStatus.online
                ? null
                : React.createElement('p', { className: 'dshRemoteConnectionIssue', role: 'status' }, connectionErrorMessage(hostStatus.error, t)),
              !writable ? React.createElement('p', { className: 'dshRemoteError' }, t('readOnly')) : null,
              React.createElement('div', { className: 'dshRemoteSettingsFooter' },
                React.createElement('p', {
                  className: error !== undefined ? 'dshRemoteError' : 'dshRemoteNotice',
                  role: error !== undefined ? 'alert' : 'status',
                }, error ?? (notice === undefined ? '' : t(notice.key, notice.params))),
                draftDirty
                  ? React.createElement(React.Fragment, null,
                    React.createElement('button', { type: 'button', className: 'dshRemoteDiscard', disabled: busy, onClick: discard }, t('discard')),
                    React.createElement('button', { type: 'button', className: 'dshRemoteSave', disabled: busy || !writable, onClick: () => void save() }, t(busy ? 'saving' : 'save')),
                    React.createElement('button', { type: 'button', className: 'dshRemoteDiscard', disabled: busy || !writable, onClick: () => void logout() }, t(busy ? 'signingOut' : 'signOut')))
                  : React.createElement('button', {
                    type: 'button',
                    className: 'dshRemoteDiscard',
                    disabled: busy || !writable,
                    onClick: () => void logout(),
                  }, t(busy ? 'signingOut' : 'signOut'))))
            : React.createElement('div', { className: 'dshRemoteSettings' },
              React.createElement('div', { className: 'dshRemoteHostIdentity' },
                React.createElement('div', null,
                  React.createElement('span', null, t('hostName')),
                  React.createElement('strong', null, hostName || '—')),
                React.createElement('div', null,
                  React.createElement('span', null, t('deviceId')),
                  React.createElement('code', null, hostDeviceId || '—'))),
              React.createElement('div', { className: 'dshRemoteField' },
                React.createElement('label', { htmlFor: fieldId('server-url') }, t('serverUrl')),
                React.createElement('input', {
                  id: fieldId('server-url'),
                  type: 'url',
                  value: serverUrl,
                  disabled: busy || !writable,
                  required: true,
                  placeholder: '',
                  onChange: (event: Event) => { setServerUrl((event.target as HTMLInputElement).value); setNotice(undefined) },
                }),
                React.createElement('p', null, t('serverUrlHint'))),
              roleSetting,
              hostLoginSetting,
              developmentSetting,
              acpSetting,
              React.createElement('p', { className: 'dshRemoteSettingsState' }, t('authorizeFromRemote')),
              !writable ? React.createElement('p', { className: 'dshRemoteError' }, t('readOnly')) : null,
              React.createElement('div', { className: 'dshRemoteSettingsFooter' },
                React.createElement('p', {
                  className: error !== undefined ? 'dshRemoteError' : 'dshRemoteNotice',
                  role: error !== undefined ? 'alert' : 'status',
                }, error ?? (notice === undefined ? '' : t(notice.key, notice.params))),
                React.createElement('button', { type: 'button', className: 'dshRemoteDiscard', disabled: busy || !draftDirty, onClick: discard }, t('discard')),
                React.createElement('button', { type: 'button', className: 'dshRemoteSave', disabled: busy || !writable || !serverDirty, onClick: () => void save() }, t(busy ? 'saving' : 'save'))))))
  }

  return RemotePluginOptions
}
