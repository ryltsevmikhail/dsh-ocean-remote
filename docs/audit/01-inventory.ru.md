# 01. Инвентаризация компонентов и поверхностей

Основание: чтение кода и документации на HEAD `ed702fd`. Runtime не запускался, секреты не читались. Всё ниже — «установлено из кода», если не указано иное. Приоритеты и решения — в [backlog](03-backlog.ru.md), статусы сценариев — в [матрице](02-matrix.ru.md).

## Состав монорепозитория

Все пакеты имеют версию `0.5.13` (унаследована от upstream). Собственных версий у форка нет.

| Компонент | Путь | Назначение |
| --- | --- | --- |
| `ds-harness-remote` | корень | workspace, entry плагина |
| `@dsh-remote/server` | `apps/server` | single-account relay + веб-консоль |
| `@dsh-remote/protocol` | `packages/protocol` | схемы, `PROTOCOL_VERSION=1` |
| `@dsh-remote/crypto` | `packages/crypto` | Noise IK |
| `@dsh-remote/webrtc` | `packages/webrtc` | relay/WebRTC транспорт |
| `@dsh-remote/client-core` | `packages/client-core` | общий клиент |
| `ds-harness-remote` (plugin) | `packages/plugin` | DSH Host/Client |
| `@dsh-remote/android`, `-browser`, VS Code | `apps/*` | отдельные клиенты, форк их не дорабатывал |

Форк содержит **12 собственных коммитов** (от `fd95eb3` до `ed702fd` включительно). Ещё 7 коммитов после тега `v0.5.13` принадлежат upstream; всего после тега 19.

## Ocean: HTTP-поверхности

Одна SPA-страница обслуживается по `GET /`, `/app`, `/app/login`, `/app/remote` (`apps/server/src/server.ts:87-94`); маршрут меняется только на клиенте через `history.replaceState`. Отдельных страниц устройств/настроек нет.

| Метод | Путь | Доступ |
| --- | --- | --- |
| GET | `/health`, `/healthz`, `/ready` | без auth |
| POST | `/api/v1/auth/login` | аккаунт + пароль |
| GET | `/api/v1/auth/me` | cookie/Bearer |
| POST | `/api/v1/auth/logout` | cookie/Bearer |
| GET | `/api/v1/account/devices` | аккаунт |
| POST | `/api/v1/devices/register`, `/api/v1/devices/register-owned-role` | аккаунт / устройство иной роли |
| POST | `/api/v1/auth/refresh` | refresh token |
| DELETE | `/api/v1/devices/self` | device Bearer |
| GET | `/api/v1/me`, `/api/v1/devices`, `/api/v1/devices/:id`, `/:id/presence` | device Bearer |
| WS | `/ws/v1/connect` | hello + accessToken |

Реализация: `apps/server/src/server.ts:81-148`, `apps/server/src/gateway.ts:23-28`.

**Чего на сервере нет**, хотя плагин, приложение или документация на это рассчитывают:

| Отсутствующий маршрут | Кто рассчитывает |
| --- | --- |
| `/api/v1/turn/credentials` | `packages/plugin/src/server-api.ts:378`, только при WebRTC-offer |
| `/api/v1/auth/oauth/*` | `packages/plugin/src/server-api.ts:172-258`; 404 превращается в пустой список провайдеров |
| `/api/v1/devices/register-with-code` | `packages/plugin/src/server-api.ts:280`, `cli.ts:112-117` |
| Обмен browser-token | `packages/protocol/src/index.ts:890-908`, `apps/browser/src/server-api.ts:19` (браузерное приложение, не плагин) |

Эти же маршруты описаны как существующие в `docs/server.md:166-172,332-336` и `docs/protocol.md:303`. Отзыва чужих устройств, approve/block, смены пароля и роли тоже нет: единственное действие — `DELETE /api/v1/devices/self`.

## Ocean: веб-консоль

Два состояния в одном компоненте (`apps/server/web/src/main.tsx`): форма входа (99-120) и таблица устройств (121-143) с кнопками «Обновить» и «Выйти». Ссылки: лицензии и GitHub. Никаких действий с устройствами, кроме просмотра.

## Ocean: аутентификация и сессии

- Один аккаунт из переменных окружения; регистрации аккаунта нет. Пароль проверяется сравнением с env-значением за постоянное время (`server.ts:102`, `store.ts:12`); `scrypt`-хэш используется только для инвалидации токенов при смене пароля (`store.ts:24-28`).
- Веб-сессия живёт в памяти: TTL 8 часов, до 256 сессий (`server.ts:42,104-107`). Перезапуск сервера разлогинивает веб-консоль.
- Cookie `dsh_session`: `HttpOnly`, `SameSite=Strict`, без `Domain`, `Secure` только при https `PUBLIC_URL` (`server.ts:63`).
- CSRF: проверка `Origin` по `PUBLIC_URL` и `Sec-Fetch-Site: cross-site` (403). CSRF-токенов нет (`server.ts:86-96`).
- Rate limit: 240/мин на API, 20/мин на вход, ключ — адрес сокета без `X-Forwarded-For`, поэтому за прокси лимит общий на прокси (`server.ts:47,73,98,100`).
- Device-токены: access 1 час, refresh 30 дней, на диске только sha256; refresh одноразовый, повтор инвалидирует все токены устройства (`store.ts:54-83`).

## Ocean: модель устройств

- Роли только `host` и `client`; `deviceId`, ключ и роль неизменяемы, отозванное устройство не может зарегистрироваться повторно (`store.ts:45-50`).
- Presence — производная от живых WebSocket-соединений; `lastSeenAt` обновляется только при hello (`store.ts:85-91`).
- Отзыв существует только для себя; отдельного состояния «заблокировано» нет.
- `/account/devices` отдаёт `identityKey` всех устройств (`server.ts:78-80`), интерфейс его не показывает.

## Плагин: загрузка и конфигурация

- Единственный entry: `apply(ctx, entry)` (`packages/plugin/src/index.ts:96`). Обязательные сервисы SDK — `settings`, `connection`, `typertGateway`; опционально `apiProxy`, `webServer`, `loader`, `subprocess`, `fileViewerHost`.
- Без «carrier» плагин регистрирует только control plane и ждёт появления `apiProxy` (`index.ts:147-156`).
- Конфиг (`packages/plugin/src/config.ts:92-232`): `enabled`, `role` (`host|client|both`, по умолчанию `host`), `serverUrl` (в zod опционален `config.ts:147-148`, подставляется из `DSH_REMOTE_SERVER` `:179-180`; обязателен для entry-схемы и CLI `cli.ts:262`), `deviceName`, `terminal.enabled`, `hostControl.enabled`, `loopback.ports`, `forceRelay`, `logLevel`, `reconnect`, `codex.*`, `cursor.*`, `acp.*`.
- **Широкие значения по умолчанию:** `terminal.enabled=true`, `acp.enabled=true`, `codex.enabled=true`, бэкенды `pi`/`claude`/`opencode` включены (`config.ts:176-177,192,223`). То есть установка «по умолчанию» открывает больше, чем описано в инструкциях форка.
- **`role` почти не влияет на runtime:** Host-runtime создаётся и стартует всегда, Client — при заданном `serverUrl` (`index.ts:225-267`). Роль используется только для выбора каталогов identity, статуса и авто-авторизации.
- Легаси-сокращение `acp.backend/command/args/cwd` принимается zod и применяется в `resolveConfig`, но отсутствует в схеме настроек (`config.ts:118,164`), поэтому через профиль не задаётся.

## Плагин: Host

- Стартует `HostServerApi` и `HostServerConnection` только при заданном `serverUrl`; Codex и ACP запускаются в фоне, ошибка только логируется (`service.ts:250-273`).
- На каждое соединение создаётся отдельный `RpcRouter` с 43 методами и лимитом 128 одновременных вызовов (`rpc-router.ts:26-231`).
- Возможности объявляются только при выполнении условий: терминал — по конфигу, Codex — если доступен бинарь, ACP — если есть включённые бэкенды, plugin routes — если найден диспетчер, file viewer — если есть сервис, preview — если список портов непустой (`service.ts:587-614`).
- Reconnect с экспоненциальным backoff и jitter; терминальные коды авторизации останавливают повтор (`server-connection.ts:164-211,852-870`); коды 4002/4003/4004 обрабатываются отдельно (`:301-318`).

## Плагин: Client

- Создаётся только при `serverUrl` и наличии `connection` (`index.ts:251-264`), пересоздаётся при смене сервера.
- **Автоматического переподключения нет:** после закрытия канала нужен явный `mode.set` (`client-connection.ts:170-184`).
- Control-поверхность — локальный HTTP `/ds-harness-remote/<endpoint>`; список методов в `client-control.ts:59-315` и `control-runtime.ts:100-177`.
- Preview реализован (`preview.open`), но вызовов в коде нет, `preview.close` отсутствует; закрытие происходит только при уходе в local/close (`client-runtime.ts:297-300,752-772`).

## Плагин: транспорт

- Реализованы relay по WebSocket и WebRTC LAN/P2P/TURN; порядок попыток `direct → turn → relay`, при `forceRelay` — только relay (`client-connection.ts:91-158`).
- Таймауты: Noise IK 10 с (`client-secure-transport.ts:121`), hello Host 10 с (`server-connection.ts:227`), control handshake адаптивного транспорта 15 с (`packages/webrtc/src/adaptive-transport.ts:135-140`), согласование direct WebRTC 12 с (`client-runtime-contract.ts:49`), RPC-дедлайн 60 с (`client-connection.ts:141`).
- **Сервер не отдаёт TURN-креды**, поэтому путь TURN на собственном Ocean фактически недоступен; сервер также объявляет `webrtcEnabled:false` (`gateway.ts:88`).

## Плагин: доверие и идентичность

- Файлы `device.json`, `device.key`, `trusted-peers.json` в `$DSH_HOME/remote` либо в `servers/<hash>/<role>/`; права 0700/0600, симлинки запрещены (`identity-store.ts:329-358`).
- Один writer на каталог через `.identity-owner`; двухфазная запись с маркером `.identity-indeterminate` и ручным восстановлением (`identity-store.ts:105-131,288-326`).
- Ручное подтверждение: очередь с TTL 5 минут, cooldown 5 с, ёмкостью 32, точным `^[0-9A-F]{64}$` и `provenance:'manual'` (`peer-approval.ts:38-40,58-128`); старые пины показываются как `legacy`.
- Подтверждать можно только из аутентифицированного loopback HTTP: проверяются сокет, canonical `host` с реальным портом, отсутствие `Forwarded`, `Origin` и `Sec-Fetch-Site` (`control-route.ts:144-159`, `control-runtime.ts:102-104`).

## Пользовательские поверхности в DSH

| Слот | Что видит пользователь |
| --- | --- |
| `shell.overlay` | полоса remote-сессии с транспортом, E2E-бейджем, «Exit» |
| `sidebar.footer.action` (−20) | «Remote» — окно входа, списка Hosts, каталогов |
| `sidebar.footer.action` (−19) | «Ключи» — модалка доверия |
| `plugins.row.config`, `plugins.bundle.config` | карточка настроек (регистрируется дважды) |

TUI: команда `/remote` (`status`, `login`, `logout`, `config` → «Host configuration is not supported yet»).

**Пробелы UI на момент инвентаризации (часть уже закрыта):** кнопки «Connect»/«Retry» нет — соединение инициируется кликом по Host (закрыто: повтор после сбоя); выбора роли и входа Host нет в карточках (закрыто: карточка «Настройка»); список сессий не проверялся (позже подтверждено частично, см. [матрицу](02-matrix.ru.md)).

## Документация: расхождения с кодом

| Утверждение | Факт |
| --- | --- |
| `README.md:120`, `README.en.md:108`, `README.zh.md:110` — сервер по умолчанию `https://dsh.r2049.cn` | Дефолта нет: адрес задаётся явно в конфиге или `DSH_REMOTE_SERVER` (`config.ts:147-148,179-180`); обязателен для CLI и entry-схемы (`cli.ts:262`) |
| `README.md:50,71,74,86` — установка `ds-harness-remote@0.5.13` из npm | В npm опубликован upstream-пакет, не форк |
| `docs/installation.md:16,64` — `curl https://dsh.r2049.cn/app/install.sh` | Чужой домен и чужой скрипт |
| `README.md:60` — P2P и TURN-узлы по всему миру | Собственный сервер relay-only, TURN-кредов нет |
| `docs/self-host-ocean.ru.md:11` — использовать `compose.yaml` за прокси | `compose.yaml` биндит `127.0.0.1` и ставит `PUBLIC_URL=http://localhost:8080` |
| `apps/server/README.md:80` — пример тега `v0.4.15` | Версия 0.5.13 |
| `docs/manual-peer-trust.ru.md` вводная часть — «вручную повторите Connect/Retry»; шаги 6 и 8 — «повторите Connect» | Отдельной кнопки «Connect»/«Retry» в интерфейсе нет: соединение стартует кликом по Host |
| `gateway.ts:88` — `serverVersion:'self-hosted/0.1.0'` | Манифесты 0.5.13 |

Дополнительно README содержит десятки ссылок на upstream-сервисы (веб-приложение, APK, iOS, npm, dshfind, star-history), а интерфейс плагина — ссылки «Star us on GitHub» и «Read the documentation» на репозиторий upstream (`workspaces.ts:937`, `settings.ts:301`).

## Лицензии и заимствования

Заимствованный UI из текущего дерева удалён (коммит `1c00c2f`): Ant Design нет в манифестах и lock-файле, изображения удалены. Тексты сторонних лицензий собираются скриптом и публикуются (`apps/server/scripts/build-notices.mjs`, `server.ts:86`). В истории Git удалённые файлы остаются — это признано в [обзоре лицензий](../license-review.ru.md). Лицензии базовых Docker-образов и Tailscale вне области notices.

## Что требует реального прогона

Cookie и вход в браузере через прокси; WS после истечения часового access-токена; деградация без TURN/OAuth; реальный P2P/TURN и `selectedPath`; два Client одновременно; отзыв активного устройства; смена ключа на живой паре; терминал на реальном PTY; запуск Codex/ACP-бинарей; несовпадение версий DSH на двух инсталляциях; stale lease и indeterminate на реальной ФС; `enabled:false` и смена сервера через живой Loader.
