export interface Account { account: string }
export interface Device {
  deviceId: string; name: string; role: 'host' | 'client'; platform: string;
  clientVersion: string; harnessVersion?: string; online: boolean; lastSeenAt?: number;
}
export interface DeviceList { items: Device[]; serverUrl: string; transport: string }

export class RequestError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

// Cookie-based, same-origin only. Never persist or log the login response token.
export async function api<T>(path: string, body?: unknown, signal?: AbortSignal, method?: 'DELETE'): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/api/v1${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
    })
  } catch { throw new RequestError('Нет связи с сервером. Повторите попытку.', 0) }
  if (!response.ok) {
    const messages: Record<number, string> = {
      401: 'Вход не подтверждён. Проверьте аккаунт и пароль либо войдите заново.',
      403: 'Действие недоступно: устройство уже отозвано или у сессии нет прав.',
      404: 'Устройство не найдено: возможно, оно уже отозвано. Обновите список.',
      429: 'Слишком много запросов. Повторите попытку через минуту.',
    }
    throw new RequestError(messages[response.status] ?? 'Сервер отклонил запрос. Повторите попытку.', response.status)
  }
  try { return await response.json() as T }
  catch { throw new RequestError('Некорректный ответ сервера.', response.status) }
}

/** Owner-only: revoke another device of this account from the console session. */
export function revokeDevice(deviceId: string, signal?: AbortSignal): Promise<{ status: string }> {
  return api(`/account/devices/${encodeURIComponent(deviceId)}`, undefined, signal, 'DELETE')
}
