# Ocean в отдельном узле Tailscale

Это отдельный тестовый relay, не замена работающему DSH. Ocean получает **собственный hostname Tailscale**, отличный от имени bigpc. Разные HTTPS-порты одного hostname не изолируют Cookie, поэтому такой вариант здесь не используется. Host-only Cookie Ocean не отправляется соседним приложениям на hostname bigpc.

Два независимых контейнера: официальный Tailscale в userspace-режиме и сервер Ocean. Serve обращается к `http://server:8080` по внутреннему Docker DNS. Backend-сеть — `internal: true` с `gateway_mode_ipv4: isolated`: у её bridge нет host gateway-адреса. Ocean подключён только к ней, без исходящего доступа наружу. Tailscale подключён к backend и отдельной transport-сети для своей работы. Нужна версия Docker с поддержкой isolated gateway (в этой приёмке Docker 29.9); не удалять это ограничение ради совместимости со старым engine. Tailscale Serve предоставляет приватный HTTPS 443 отдельного узла. Общая network namespace намеренно **не используется**: проверка на Docker 29.9 показала, что restart sidecar оставляет приложение в старой namespace. Порты хоста не публикуются. В контейнеры не передаются host network, NET_ADMIN, /dev/net/tun или Docker socket. Native tailscaled, его SSH/теги и существующие Serve-маршруты не меняются. При перехвате Docker-трафика host VPN может понадобиться отдельный согласованный host route helper, описанный ниже; сам Compose его не устанавливает. Caddy и публичный домен не нужны. Обычная bridge без isolated была бы доступна host-local процессам напрямую, несмотря на отсутствие опубликованных портов; поэтому здесь дополнительно проверяется isolated gateway. Docker/root-администратор всё равно может войти в namespace, читать контейнеры/volumes и секреты: это не защита от администратора bigpc. Поведение isolated описано в [документации Docker](https://docs.docker.com/engine/network/port-publishing/#gateway-modes).

## Предварительные условия — до любого up

- Уже проверенный локальный образ Ocean: [журнал этапов](ocean-progress.ru.md). Сверить полный image ID с проверкой; pull_policy: never не защищает от локального retag. Для запуска использовать image ID.
- Официальный tailscale/tailscale:stable скачать отдельно, проверить, затем сохранить его immutable RepoDigest в DSH_TAILSCALE_IMAGE. Тег stable не является постоянной версией. Проверка лицензий Node/OS/Tailscale-образов не подменяется приложенческими MIT notices.
- Нужны доступ в вашу tailnet, MagicDNS/HTTPS и ручное подтверждение нового узла владельцем. Не выдавать агенту auth key. Если tailnet требует approval или блокирует узел ACL — получить согласование владельца, не менять общие ACL самостоятельно.
- **До запуска** убедиться, что новый каталог, Compose project dsh-ocean-remote-test, его контейнеры/networks/volumes и желаемое имя узла не принадлежат прежней службе. Создание каталога должно отказать при EEXIST. Не использовать готовые чужие volumes и не reconciliation-ить существующий project.
- Сохранить host `tailscale serve status --json` в защищённый файл, чтобы после запуска убедиться, что существующий Serve bigpc остался неизменным. Сами команды настройки Serve выполнять только внутри нового контейнера.

## Подготовка

Создать новый каталог 0700. Скопировать туда из apps/server три файла: compose.tailnet.yaml, tailscale-serve.json и .env.tailnet.example (последний — как .env). У .env должны быть права 0600. **Несекретному** tailscale-serve.json дать права 0444: root-процесс без CAP_DAC_OVERRIDE иначе может не прочитать bind-файл владельца UID1000 с правами 0600. Каталог оставить 0700, .env и snapshot не открывать; не помещать их в Git. Не добавлять capabilities ради обхода этой ошибки.

Задать в .env:

```dotenv
DSH_OCEAN_IMAGE=sha256:VERIFIED_LOCAL_IMAGE_ID
DSH_TAILSCALE_IMAGE=tailscale/tailscale@sha256:VERIFIED_OFFICIAL_IMAGE_DIGEST
DSH_OCEAN_NODE_NAME=ocean-remote-test
DSH_SERVER_PUBLIC_URL=https://ocean-remote-test.tailnet-name.ts.net
DSH_SERVER_ACCOUNT=owner@example.com
DSH_SERVER_PASSWORD='YOUR_UNIQUE_RANDOM_PASSWORD'
```

Это шаблон, не рабочие credentials. Пароль — уникальный, случайный, желательно от 24 символов. Значения с `$` заключать в одинарные кавычки. Не выводить в чат/log .env, полный Compose config или inspect Env.

Все команды ниже выполнять из контролируемой среды без унаследованных DSH_* и COMPOSE_*, которые могут перекрывать .env. Project name всегда задавать явно. `config --quiet` проверяет синтаксис, а не совпадение реальных image ID, сети и hostname — эти проверки обязательны отдельно, без вывода пароля.

Файл tailscale-serve.json содержит `${TS_CERT_DOMAIN}` — это подстановка **самого containerboot**, не shell/Compose. Она должна соответствовать фактическому сертификатному имени нового узла. Не заменять её hostname bigpc.

```sh
docker compose --project-name dsh-ocean-remote-test --env-file .env -f compose.tailnet.yaml config --quiet
docker compose --project-name dsh-ocean-remote-test --env-file .env -f compose.tailnet.yaml up -d tailscale
```

При первом запуске открыть URL авторизации, созданный новым tailscaled, и подтвердить отдельное устройство в своей tailnet. Не использовать `tailscale up` на хосте. Локальное состояние нового узла сохраняется в отдельном tailnet-state volume; не удалять его при обычных перезапусках. Boot timeout увеличен, чтобы владелец успел подтвердить вход.

Проверить статус нового узла:

```sh
docker compose --project-name dsh-ocean-remote-test --env-file .env -f compose.tailnet.yaml exec tailscale tailscale status --json
```

Сверить фактический Self.DNSName с DSH_SERVER_PUBLIC_URL: имя может получить суффикс при конфликте. Скорректировать только наш .env **до запуска сервера**. Дождаться Running и разрешения выдачи HTTPS-сертификата. Не подменять URL непроверенным/общим hostname.

```sh
docker compose --project-name dsh-ocean-remote-test --env-file .env -f compose.tailnet.yaml up -d server
docker compose --project-name dsh-ocean-remote-test --env-file .env -f compose.tailnet.yaml ps
```

Проверить health сервера; отсутствие published ports; у server UID1000; у tailnet TS_USERSPACE=true, caps dropped, без tun/host/socket mounts; Serve config **нового узла** содержит только его HTTPS->server:8080 и не имеет включённого AllowFunnel. Также подтвердить: backend network Internal=true, EnableIPv6=false, gateway_mode_ipv4=isolated; у её Linux bridge нет IPv4 gateway-адреса; Docker IPv6 выключен, у server нет назначенного Docker IPv6 и IPv6-listener на 8080 (kernel link-local IPv6 на bridge может присутствовать и не считается доказательством dual-stack изоляции); прямой HTTP-запрос с хоста к container IP:8080 не должен получать ответ backend; проверять именно HTTP, а не один connect(), потому что локальный VPN/proxy может синтетически подтверждать TCP; server подключён только к backend, Tailscale — к backend и transport. Это runtime-проверки конкретного engine, а не следствие одного `ports: []`. Если маршрут на container IP перехватывает host VPN/proxy, отсутствие HTTP-ответа фиксировать только как наблюдение: это не независимое доказательство firewall-изоляции и не основание отключать VPN или менять глобальные маршруты. Host Serve JSON должен остаться равным исходному. Само слово Serve в команде не заменяет проверку отсутствия Funnel.

## Приёмка с ноутбука

```sh
curl --fail https://ocean-remote-test.tailnet-name.ts.net/healthz
```

Не использовать `-k`: сертификат должен быть валиден для отдельного имени. Проверить в браузере вход/выход и Secure+HttpOnly+SameSite Cookie; доставку страницы и лицензий; WebSocket Upgrade по wss://.../ws/v1/connect. Открытие транспорта не доказывает account authorization или Noise-сессию. Для устройств указывать один и тот же **HTTPS origin без пути**.

Плагин не устанавливается и работающий DSH не перезапускается этим шагом. Дальнейшая межмашинная приёмка — в отдельных пользовательских DSH-профилях. Терминал означает полноценные права пользователя хоста; регистрация аккаунта пока участвует в доверии новым устройствам, до отдельного этапа ручного подтверждения.

## Если host VPN ломает обнаружение peer

Не отключать VPN и не открывать наружу HTTP-порт. Для проверенной схемы bigpc есть [отдельный необязательный маршрутный сервис](tailnet-route.ru.md): только IPv4 официального Tailscale-контейнера выходит через обычный WAN, остальная host-политика сохраняется. Это отдельная согласуемая root-операция с собственным stop/cleanup, не скрытый шаг Compose.

## Остановка и восстановление

```sh
docker compose --project-name dsh-ocean-remote-test --env-file .env -f compose.tailnet.yaml stop
```

Не использовать `tailscale serve reset` на хосте, глобальные Docker stop/prune или `down -v`. Server-data и tailnet-state — два отдельных чувствительных volume; делать защищённые резервные копии остановленного состояния. Контейнеры независимы; связь идёт через стабильное имя сервиса `server`, а не container ID/network_mode. Проверять restart каждого контейнера и Compose recreate с сохранением обоих volumes, hostname и image digest. restart policy не является контроллером health/ACL; восстановление после перезагрузки Docker/хоста и долговременная устойчивость всё равно требуют отдельной приёмки. Простое удаление state создаст новую сетевую личность, а не «починит» старую.

Полное удаление нового узла из tailnet — отдельное согласованное действие через его identity, не logout/reset bigpc. Реализация official userspace/TS_AUTH_ONCE/TS_SERVE_CONFIG: [containerboot upstream](https://github.com/tailscale/tailscale/blob/main/cmd/containerboot/main.go); изменяемый main не является фиксацией версии используемого образа.
