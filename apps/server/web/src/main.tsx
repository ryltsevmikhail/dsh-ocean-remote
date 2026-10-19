import { createRoot } from 'react-dom/client'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { api, RequestError, revokeDevice, type Account, type Device, type DeviceList } from './api'
import './ocean.css'

// Ocean's deliberately small, independently authored status console.
function App() {
  const [account, setAccount] = useState<Account | null>()
  const [devices, setDevices] = useState<DeviceList>()
  const [busy, setBusy] = useState(false)
  const [loadingDevices, setLoadingDevices] = useState(false)
  const [error, setError] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [revoking, setRevoking] = useState<string>()
  const heading = useRef<HTMLHeadingElement>(null)
  const accountWasKnown = useRef(false)

  useEffect(() => {
    if (account === undefined) return
    if (accountWasKnown.current) heading.current?.focus()
    accountWasKnown.current = true
  }, [account])

  useEffect(() => {
    const controller = new AbortController()
    void api<Account>('/auth/me', undefined, controller.signal).then(value => {
      if (!controller.signal.aborted) setAccount({ account: value.account })
    }).catch(reason => {
      if (controller.signal.aborted) return
      if (!(reason instanceof RequestError && reason.status === 401)) setError(message(reason))
      setAccount(null)
    })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (!account) return
    const controller = new AbortController()
    setLoadingDevices(true)
    setError('')
    void api<DeviceList>('/account/devices', undefined, controller.signal).then(value => {
      if (!controller.signal.aborted) setDevices(value)
    }).catch(reason => {
      if (controller.signal.aborted) return
      if (reason instanceof RequestError && reason.status === 401) {
        setAccount(null)
        setDevices(undefined)
      }
      setError(message(reason))
    }).finally(() => {
      if (!controller.signal.aborted) setLoadingDevices(false)
    })
    return () => controller.abort()
  }, [account, refresh])

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const result = await api<Account>('/auth/login', { email: email.trim(), password })
      setPassword('')
      setDevices(undefined)
      setAccount({ account: result.account })
      history.replaceState(null, '', '/app/remote')
    } catch (reason) {
      setPassword('')
      setError(message(reason))
    } finally { setBusy(false) }
  }

  async function logout() {
    if (busy || loadingDevices) return
    setBusy(true)
    setError('')
    try {
      await api('/auth/logout', {})
      setDevices(undefined)
      setAccount(null)
      history.replaceState(null, '', '/app/login')
    } catch (reason) { setError(message(reason)) }
    finally { setBusy(false) }
  }

  async function revoke(device: Device) {
    if (busy || revoking !== undefined) return
    // Irreversible for that device: require an explicit confirmation naming it.
    if (!window.confirm(`Отозвать устройство «${device.name}»? Оно потеряет доступ к этому серверу и должно будет авторизоваться заново.`)) return
    setRevoking(device.deviceId)
    setError('')
    try {
      await revokeDevice(device.deviceId)
      setRefresh(value => value + 1)
    } catch (reason) { setError(message(reason)) }
    finally { setRevoking(undefined) }
  }

  const items = [...(devices?.items ?? [])].sort((a, b) => Number(b.online) - Number(a.online))
  return <div className={`ocean-console ${account ? 'dashboard' : 'auth'}`}>
    <header className="site-header">
      <a className="brand" href="/" aria-label="DSH Ocean Remote — главная">
        <span className="brand-mark" aria-hidden="true">≈</span>
        <span><strong>Ocean<span className="brand-detail"> Remote</span></strong><small>для DeepSeek Harness</small></span>
      </a>
      <span className="server-badge"><span aria-hidden="true" />Собственный сервер</span>
    </header>
    <main>
      {error && <p className="error" role="alert">{error}</p>}
      {account === undefined ? <p role="status">Проверка входа…</p> : account === null ?
        <section className="login-layout" aria-labelledby="login-title">
          <div className="login-intro">
            <span className="eyebrow">ВАШЕ РАБОЧЕЕ ПРОСТРАНСТВО</span>
            <h1>Работа остаётся.<br />Меняется только<br /><span>устройство.</span></h1>
            <p>Подключайтесь к своему Harness с другого компьютера. Сессии и инструменты продолжают работать на хосте.</p>
            <div className="intro-note"><span aria-hidden="true">↗</span><div><strong>Ваш сервер. Ваши устройства.</strong><small>Без аккаунта в сервисе автора.</small></div></div>
          </div>
          <div className="login-card">
            <span className="eyebrow">OCEAN REMOTE</span>
            <h2 id="login-title" ref={heading} tabIndex={-1}>С возвращением</h2>
            <p className="muted">Войдите в аккаунт этого сервера.</p>
            <form onSubmit={event => void login(event)}>
            <label htmlFor="account">Аккаунт</label>
            <input id="account" name="username" autoComplete="username" required maxLength={254}
              value={email} disabled={busy} onChange={event => setEmail(event.target.value)} />
            <label htmlFor="password">Пароль</label>
            <input id="password" name="password" type="password" autoComplete="current-password" required maxLength={1024}
              value={password} disabled={busy} onChange={event => setPassword(event.target.value)} />
            <button className="primary" disabled={busy || !email.trim() || !password}>{busy ? 'Подключаемся…' : 'Войти'}<span aria-hidden="true">→</span></button>
            </form>
            <p className="login-hint">Данные для входа задаёт владелец сервера.<br />Нет доступа? Обратитесь к нему.</p>
          </div>
        </section> : <section className="devices-page" aria-labelledby="devices-title">
          <div className="actions">
            <div><span className="eyebrow">ПАНЕЛЬ УПРАВЛЕНИЯ</span><h2 id="devices-title" ref={heading} tabIndex={-1}>Ваши устройства</h2></div>
            <button type="button" disabled={busy || loadingDevices} onClick={() => setRefresh(value => value + 1)}>Обновить</button>
            <button type="button" disabled={busy || loadingDevices} onClick={() => void logout()}>Выйти</button>
          </div>
          <p className="account">Аккаунт: {account.account}</p>
          <div className="connection-info"><div><span className="eyebrow">АДРЕС ПОДКЛЮЧЕНИЯ</span><code>{devices?.serverUrl ?? window.location.origin}</code></div><p>Укажите этот адрес в плагине DSH<br />на хосте и клиенте.</p></div>
          <p className="muted">Состояние ваших подключений. Чтобы продолжить сессию, откройте Remote в DSH.</p>
          {loadingDevices && <p role="status">Обновление устройств…</p>}
          {devices && <div className="device-table" tabIndex={0} role="region" aria-label="Список устройств">
            <table>
              <caption>{items.filter(item => item.online).length} из {items.length} устройств онлайн</caption>
              <thead><tr><th>Имя</th><th>Статус</th><th>Роль</th><th>Система</th><th>Плагин</th><th>DSH</th><th><span className="visually-hidden">Действия</span></th></tr></thead>
              <tbody>{items.map(item => <tr key={item.deviceId}>
                <th scope="row">{item.name}</th><td><span className={`device-status ${item.online ? 'online' : ''}`}>{item.online ? 'Онлайн' : 'Офлайн'}</span></td>
                <td>{item.role === 'host' ? 'Хост' : 'Клиент'}</td><td>{item.platform}</td>
                <td>{item.clientVersion}</td><td>{item.harnessVersion ?? '—'}</td>
                <td><button type="button" className="revoke" disabled={busy || revoking !== undefined}
                  onClick={() => void revoke(item)}>{revoking === item.deviceId ? 'Отзываем…' : 'Отозвать'}</button></td>
              </tr>)}</tbody>
            </table>
            {!items.length && <div className="empty-state"><span className="empty-symbol" aria-hidden="true">↔</span><h3>Пока ни одного устройства</h3><p>Зарегистрированных устройств пока нет.<br />Войдите в этот аккаунт через плагин DSH — и ваше устройство появится здесь.</p></div>}
          </div>}
        </section>}
    </main>
    <footer>
      <div className="footer-links"><a href="https://github.com/Ryltsevmg/dsh-ocean-remote" target="_blank" rel="noreferrer">Исходный код Ocean</a><a href="/THIRD_PARTY_NOTICES.txt">Лицензии</a></div>
      <p>Хост выполняет инструменты со своими правами. Сервер участвует в авторизации устройств; ручное доверие ключам — отдельная граница защиты.</p>
    </footer>
  </div>
}

function message(reason: unknown): string {
  return reason instanceof RequestError ? reason.message : 'Не удалось выполнить запрос. Повторите попытку.'
}

createRoot(document.getElementById('root')!).render(<App />)
