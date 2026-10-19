# Приёмка настоящих DSH bigpc ↔ ноутбук

Проверялись два реальных установленных DSH **0.2.0-rc.2**, не подменённые Host API. На bigpc Node 26.11.1, на ноутбуке Node 26.12.0. Relay — собственный приватный Ocean из [этапа развёртывания](tailnet-ocean.ru.md). Модельный prompt/платная генерация, Codex/ACP, терминал и исходный пользовательский профиль **не использовались**.

## Изоляция

Оба теста выполнялись обычным пользователем, не root. На каждой машине эксклюзивно создан новый private fixture с новыми:

- HOME, DSH_HOME, XDG config/cache/data/state/runtime и CODEX_HOME;
- собственным custom profile (`stage5-host` или `stage5-client`), пустым рабочим каталогом и артефактом форка;
- manifest с bundle-слоями только `@deepseek-ai/dsh-base` и `@deepseek-ai/dsh-web-app`;
- явным remote overlay вместо штатного remote bundle, который включает Codex по умолчанию.

Все model/proxy/NODE_OPTIONS/старые DSH environment variables исключены allowlist-окружением. Исходный cwd пустой: CLI читает .env не только из DSH_HOME, но и из cwd. Не копировались существующие профили, API keys, модельные credentials или Codex state. Зависимости установлены только в новом артефакте с `--ignore-scripts --legacy-peer-deps --omit=dev`; глобальная установка DSH и её зависимости не менялись.

Remote config: явный собственный HTTPS serverUrl, `forceRelay: true`, выбранная роль, `hostControl.enabled: false`, `terminal.enabled: false`, Codex/Cursor и ACP выключены. Все известные ACP backend rows также явно выключены; session-title-llm отключён, чтобы создание метаданных не запускало вспомогательную генерацию.

Native DSH запускался абсолютным Node/CLI, с `--host 127.0.0.1 --port 0 --no-open`. Только loopback, не новая публичная служба. Не запускать profile `--help` или config dump против рабочего HOME: даже help может подготовить профиль и переписать его root config. Инициализация `--from-default-profile web` копирует лишь shipped bundle list и допустима только для отсутствующего нового profile; в этой приёмке manifest был подготовлен отдельно, без этого флага.

Супервизор перехватывал stdout/stderr в памяти, не сохранял сырые логи. Native launch URL содержит process token: он находился только в отдельном private bootstrap credential record 0600 внутри fixture 0700, не в Git/чате/argv. Остановка адресовалась только созданному процессу после сверки kernel birth time, UID и process group; не использовались поиск/kill по общему имени Node/DSH. После остановки bootstrap token удаляется из записи; данные тестовых identities можно оставить для следующей проверки миграции.

## Обнаруженный дефект и граница исправления

Оба тестовых устройства успешно авторизовались на Ocean, Host был online. Но `devices` чистого Client возвращал ACCOUNT_AUTH_REQUIRED: guard требовал авторизацию его **локального** Host, хотя пользователь явно отключил Host control.

[Guard](../packages/plugin/src/client-runtime.ts) теперь допускает только точное сочетание:

- role=client;
- hostControl.enabled=false;
- Host authorized=false;
- Host error=ACCOUNT_AUTH_REQUIRED;
- Host accountRequired=true.

Это политика **текущего состояния**, не доказательство, что Host никогда прежде не авторизовывался. Не обещается исторический запрет после reset/restart. При явных DEVICE_REVOKED/AUTH_INVALID/TOKEN_EXPIRED discovery по-прежнему закрыт при любых роли/флаге/authorized. Default Host control не ослаблен. Client всё равно должен иметь identity и успешно пройти собственный `server.listDevices()`; дополнительный Host автоматически не регистрируется. Чтобы отозвать доступ Client, нужно отозвать именно его credential/role, а не полагаться на отсутствие локальной Host-авторизации.

[Регрессии](../packages/plugin/tests/client-runtime.test.ts): два варианта Client API результата и 72 отрицательных сочетания. Негативный Client API здесь mocked — это проверка распространения auth-отказа, не эксперимент с настоящим неверным credential. Полный plugin suite: **398/398, 55 файлов**; build/check и bundle verification пройдены.

## Фактическая runtime-проверка

1. Нормальная локальная cookie-auth DSH после private process-token exchange; без обхода `requestRejection` или отключения Origin fence.
2. Host и Client вошли на собственный Ocean через свои loopback control API. Пароль получался из защищённого deployment-файла только в памяти, не в командной строке или сырых логах.
3. После исправления Client увидел именно тестовый Host и установил настоящую Noise/Relay связь, `mode=remote`, `transport=Relay`, native remoteGateway=true.
4. Через реальный native `workspace/create` зарегистрирован только подготовленный каталог Host. Его прежний пустой `workspace/follow` baseline стал содержать новую строку с тем же ID/path. Это не fixture-ответ fake DSH API.
5. Изолированный системный Chrome открыл именно тестовый native DSH UI: remote Host и native workspace видны, remote plugin assets/control отвечают, uncaught page errors=0. Использовался новый browser context, не cookies/профиль работающего GUI. Prompt не отправлялся.

6. Явный mode=local подтвердил connected=false; новый mode=remote заново установил Relay/Noise связь и вернул тот же сохранённый native workspace Host. Повторный Chrome после reconnect показал точный видимый заголовок `workspace` и remote Host, ошибок страницы нет.
7. Оба тестовых процесса штатно остановлены адресно, bootstrap tokens убраны из приватных run-записей. Тестовые identities/credentials остались только в закрытых fixture для следующей миграционной проверки; рабочий DSH и постоянный Ocean relay не останавливались.

Итог также записан в [журнале этапов](ocean-progress.ru.md). Opaque relay traffic и успешная Noise-сессия не равны формальному криптографическому аудиту.

## Что этим не доказано

- Генерация настоящим LLM, оплата/лимиты провайдера и полноценный chat/agent/tool workflow.
- Codex, ACP, WebRTC/P2P/TURN, удалённый терминал и OS reboot recovery.
- Ручное доверие новым ключам: это следующий отдельный этап; прежнее same-account first-use поведение ещё не считается ручным approval.
- Безопасность от root/Docker-администратора и долговременный SLA.

На работающий DSH plugin не устанавливался, его процесс/конфигурация не перезапускались. Не публиковать private fixtures, launch URLs, identity private keys или server credential stores.
