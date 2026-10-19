# 05. Надёжность и эксплуатация

Статус: черновик. Зависимости: 02–04. [Общие правила](README.md).

## Цель

Пользователь отличает временный обрыв от потери прав/данных, может безопасно обновить и восстановить собственный Ocean/плагин, собрать диагностику без секретов. «Работает после одного restart» не превращается в обещание SLA.

## Требования

- **OPS-01. Слои health.** Раздельно показывать process readiness, Ocean HTTPS/API, account auth, Host presence, trust, Noise/transport и native API readiness. HTTP 200 health не означает готовность coding-сессии.
- **OPS-02. Reconnect policy.** Retry только retryable failures, с bounded backoff/jitter и отменой при logout/смене цели. Revoked/invalid/changed-key/approval-required не лечатся бесконечным reconnect. Нельзя ресендить prompt/tool как часть reconnect.
- **OPS-03. Восстановление UI.** Видны disconnected/reconnecting/needs-action/indeterminate; после reload данные сверяются с Host. Нет локального fallback, выдаваемого за удалённую историю.
- **OPS-04. Restart.** Client, Host, Ocean и Tailscale sidecar перезапускаются независимо в тестовой среде. Сохраняются нужные volumes/identity/pins/history; временные handles и старые callbacks не возрождаются.
- **OPS-05. Несколько клиентов.** Обрыв/смена цели/отзыв A не закрывает транспорт и ресурсы B. Общий Host state не удаляется из-за закрытия одного UI.
- **OPS-06. Ресурсы.** После повторных connect/disconnect/cancel закрыты owned sockets/subscriptions и временные процессы; preview/PTY handles учитываются для включённых capabilities, для исключённых проверяется отказ их самостоятельных маршрутов. До прогона согласуются список counters, baseline и окно стабилизации (предложение: 30 секунд после прекращения активности). Допустимые bounded persistent caches перечисляются с пределами и исключаются из ephemeral baseline, а не объявляются утечкой постфактум. Пределы очередей/frames/requests ограничены.
- **OPS-07. Diagnostics.** Пользователь получает safe code, слой отказа, retryability, timestamp/correlation и следующее действие. Export содержит версии/несекретные state transitions, не Env dumps, cookies, private keys, prompts/tool output, полные auth URLs или credential JSON.
- **OPS-08. Backup.** До update определён защищённый набор state: server account/device metadata, нужные volumes/TS identity, peer pins и native session данные по native контракту. Backup не публикуется, шифруется или имеет явно согласованную безопасную защиту и проверенные права. Backup сам может содержать secrets.
- **OPS-09. Consistency.** Не копировать live database/credential stores произвольно. Использовать согласованный quiesce/native snapshot; фиксировать версию/формат и restore prerequisites. Не смешивать backups разных identities/серверов.
- **OPS-10. Update.** Показать текущую/целевую версию и schema compatibility, выполнить backup и preflight, применить артефакт, выполнить health + native smoke. До реализации/прогона выбрать конкретную поддерживаемую пару source → target artifacts (digest/версии) и schemas для update/rollback, включая backup compatibility. Если такой пары ещё нет, соответствующая приёмка остаётся открытой/заблокированной, а не заменяется mock или image pull. Не мигрировать рабочий DSH или root/network state неявно.
- **OPS-11. Rollback.** Downgrade разрешён только при совместимой schema. В противном случае — контролируемый restore совместимого backup после остановки writers; не запускать старую версию поверх новых metadata и не убирать provenance поля вручную ради старого parser.
- **OPS-12. Recovery.** Документированы stale owner lease, incomplete identity и indeterminate commit. Нельзя удалять lock/marker на живом writer или генерировать новый key молча. Без доказанного безопасного автоматического восстановления допускается понятный ручной offline workflow.
- **OPS-13. Network boundaries.** Docker/Serve/route changes ограничены собственными ресурсами. Preview не открывает app/control interfaces. Обновление проверяет отсутствие новых host published ports, лишних caps и ослабленного TLS/auth.
- **OPS-14. Ответственность autostart.** Штатный stop завершает owned runtime и снимает lease; autostart явно выбирается пользователем. Поддержанные systemd/Docker restart policy задокументированы отдельно, без обещания повторного запуска рабочего профиля из тестового setup.

## Матрица сбоев

| Сбой | Что проверять |
| --- | --- |
| Client UI reload/закрытие | Host history сохраняется; нет дубля send/owned handles |
| Client process restart | Сохранились identity/pins/settings; auth корректно переоценена |
| Host restart | Client видит обрыв, после readiness сверяет native snapshot |
| Ocean restart | Сохраняется server state; auth expiry обрабатывается, не обходится |
| Sidecar restart/recreate/IP change | HTTPS/маршрут восстанавливается без изменения чужой сети |
| Временный network blackhole/packet delay | Bounded retry, cancel responsiveness, нет ghost approval |
| Auth expired/revoked | Refresh только где разрешён; revoked не становится offline retry loop |
| Disk full/permission/I/O failure | Нет ложного save/grant, indeterminate явно блокирует опасное действие |
| Второй writer/аварийный выход | Сохранность identity и понятный recovery, без unsafe lock stealing |
| Upgrade failure | Нет запуска несовместимого старого writer; предусмотрен безопасный rollback |

## Предлагаемый приёмочный профиль, не SLA

После согласования стенда: 20 циклов connect/disconnect, по 3 штатных restart Client/Host/Ocean/sidecar и 30 минут работы двух Clients. Согласованные короткие network outages — до 30 секунд; после возвращения сети/готовности сервисов ожидание восстановления до 60 секунд. Эти числа — **целевые критерии теста**, не уже измеренные результаты или обещание production availability. Если native SDK требует других значений, изменение оформляется решением до прогона, не задним числом.

Destructive I/O проверяется injection/копией данных, не заполнением рабочего диска. Host/Docker-daemon reboot не входит автоматически: нужен отдельный безопасный стенд и разрешение, затем отдельная строка отчёта.

## Приёмка

- **OPS-AC1:** матрица выполнена для включённых компонентов; для каждого сбоя есть воспроизводимый результат, UI state и отсутствие нарушения trust.
- **OPS-AC2:** нет дублированных prompt/tool effects из-за транспорта и неограниченного роста owned resources в согласованном цикле; ephemeral counters возвращаются к согласованному baseline в согласованное окно стабилизации, persistent caches остаются в заранее заданных пределах.
- **OPS-AC3:** backup восстановлен в отдельную изолированную копию; совпадают нужные identity/pins/session данные и native smoke проходит.
- **OPS-AC4:** один реальный поддержанный upgrade и rollback воспроизводимы с соответствующими schema/backup. Нельзя выдавать image pull без restore проверки за rollback.
- **OPS-AC5:** safe diagnostic export проверен secret canary-тестами и ручным ревью; нет доступа к данным рабочего профиля.
- **OPS-AC6:** остановлены только созданные тестовые процессы, сняты test forwards/rules, постоянные approved сервисы и чужие политики не изменены.
