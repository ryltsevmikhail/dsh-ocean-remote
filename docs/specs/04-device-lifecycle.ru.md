# 04. Полный жизненный цикл устройств

Статус: черновик. Зависимости: 01, 02. Действующий [manual trust](../manual-peer-trust.ru.md) — база, не предмет отката к auto-trust. [Общие правила](README.md).

## Цель

Пользователь управляет не только первым approval, но и отказом, отзывом активного доступа, потерей устройства, сменой ключей и legacy pins. Действия доступны из поддержанного UI, имеют понятную область и не требуют редактировать credential JSON.

## Модель полномочий

Account membership, Host identity, Client identity, pin и live connection — разные сущности. Device name не является идентичностью. Одна машина может иметь отдельные Host и Client ключи. Удаление pin не равно отзыву server credential; logout не должен обещать удалённый отзыв при недоступном Ocean.

## Требования

- **DEV-01. Список.** Для каждой роли показываются собственный ID/полный SHA-256, known/pending/rejected/changed/revoked состояние в соответствующей области, provenance manual/legacy и доступность сети. Нет ложного общего зелёного «доверено» только из account authorization.
- **DEV-02. Добавление.** Discovery не выдаёт доверие. Первый доступ требует действующих account прав, двустороннего локального exact full-SHA approval и Noise possession proof. Короткий fingerprint сохраняется лишь для совместимости, не нового подтверждения.
- **DEV-03. Pending.** Сохранить generation/epoch/role/origin binding, TTL, ограничения очереди и cooldown. Duplicate/churn/expiry не позволяют подтвердить старый или другой ключ. Accept/reject/close races имеют определённый исход.
- **DEV-04. Отказ.** Reject удаляет конкретный pending без pin и не отзывает чужое устройство. Повторный запрос после cooldown виден как новое решение, без скрытого разрешения по старой кнопке.
- **DEV-05. Локальное снятие доверия.** Пользователь может удалить конкретный pin из локальной роли. Это отдельное явно названное действие; оно закрывает соответствующий active channel и не разрешает автоматическое повторное закрепление. Следующая попытка снова требует approval.
- **DEV-06. Отзыв на Ocean.** Пользователь может отозвать конкретный device credential/membership. Новые auth/refresh/connect отозванного credential отклоняются. Live control/relay connections этого устройства закрываются; локальные runtime сессии не продолжают давать доступ из stale cached authorization.
- **DEV-07. Завершение отзыва.** Полный revoke success требует durable server deny и подтверждённого закрытия/инвалидации заявленных live channels на Host. Ответ Ocean сам по себе не доказывает прекращение активного доступа. Предлагаемый конечный timeout операции — 30 секунд, уточняется до реализации; недоступный Host/потерянный invalidate ACK даёт pending/partial outcome с указанием неподтверждённой стороны. При недоступном Ocean разрешена локальная блокировка с состоянием «локально запрещено, удалённый отзыв не подтверждён». Reconnect сначала переоценивает отзыв и не возвращает stale доступ. Нельзя показывать частичный результат как полный отзыв.
- **DEV-08. Граница уже запущенных действий.** Новые операции отзываемого peer прекращаются. Его streams и cancellable owned requests закрываются; PTY/preview — для capabilities, включённых аудитом. Для исключённых самостоятельных функций проверяются недоступность UI и отказ маршрутов согласно объявленному native контракту. Действие, уже переданное native tool, может быть неотменяемым: UI сообщает неопределённый/завершённый эффект, а не обещает rollback внешнего мира. Независимые Host tasks и ресурсы других peers не уничтожаются.
- **DEV-09. Смена ключа.** Известный ID с другим key всегда конфликт, без overwrite/approve-as-new обхода. Легитимная ротация проходит явно обозначенный путь новой identity и повторной проверки; старые полномочия отзываются в заявленной области.
- **DEV-10. Потеря устройства.** Доступен сценарий отзыва с оставшейся доверенной стороны/Ocean owner. Не требуется владеть потерянным private key. Описано, что при компрометации Host с полным OS доступом простого удаления pin недостаточно.
- **DEV-11. Legacy.** Старые pins не считаются вручную подтверждёнными. Если предлагается их переверификация, она проходит отдельное явное действие с полным SHA и корректным provenance, не косметическое переименование metadata.
- **DEV-12. Lifecycle isolation.** Logout, server/role/entry switch и shutdown блокируют новые decisions в старой authority и упорядочивают уже принятый durable commit. Отзыв, конкурирующий с approval, не может вернуть отозванный pin после завершённого revoke.
- **DEV-13. Надёжное хранение.** Нет публикации нового grant до успешного commit. Неопределённый commit — fail closed/reconciliation, не silent success. Single-writer lease и mixed-version ограничения остаются явными; не красть lock по таймеру.
- **DEV-14. Local authority.** Approve/reject и новые операции локального pin-management доступны только проверенному локальному оператору. Не расширять encrypted RPC/preview allowlist ради удобства. Remote owner-management Ocean защищается собственной auth/CSRF политикой и не подменяет локальную проверку ключей.
- **DEV-15. История действий.** Минимальные events: роль, nonsecret device ID, тип решения, результат, источник manual/legacy, время и correlation ID. Не журналировать private keys, пароли, bearer/cookies или bootstrap URLs. Полный public fingerprint допустим в защищённой карточке, не обязателен в общих логах.

## Обязательные негативные сценарии

1. Неверный полный SHA, lower-case/short input, stale generation, expired/rejected candidate.
2. Membership отозван между discovery и connect; revoked во время refresh/handshake/stream.
3. Pin approval и revoke одновременно; logout/server switch во время записи.
4. A отозван, B продолжает работать; одинаковые display names не мешают выбрать правильный ID.
5. Действующий peer пробует approve через fallback RPC/preview; local-only граница сохранена.
6. Disk failure/indeterminate marker, другой writer, попытка сменить known key.
7. Ocean/Host недоступен при отзыве, invalidate/ACK задержан или потерян: конечный timeout, честный partial outcome и локальная блокировка, а не зелёный success; после reconnect отозванное право не восстанавливается.
8. Trusted peer обращается к запрещённым native/control routes и пробует обойти file/preview policy через canonicalization/symlink. Проверяется заявленная native политика, а не вымышленная более строгая sandbox; все paths/files синтетические.

## Приёмка

- **DEV-AC1:** новый Client и новый Host проходят полный самостоятельный UI workflow, без ручного RPC/JSON.
- **DEV-AC2:** после завершённого revoke нет нового доступа/refresh и закрыт соответствующий live channel. Остаточные необратимые tool effects описаны, а не выданы за отменённые.
- **DEV-AC3:** снятие pin/revoke/logout различимы пользователю, действуют только на заявленные role/ID/origin и переживают restart.
- **DEV-AC4:** concurrency/fault негативы автоматизированы, а active revoke/два Client и повторный вход проверены реально на целевой версии.
- **DEV-AC5:** legacy provenance не подделывается, lost-device/rotation recovery воспроизводимы без ослабления trust.

## Решения аудита, необходимые до реализации

Точный backend API отзыва и live-connection registry; максимальное допустимое окно cached authorization при потере связи с Ocean и механизм его ограничения; поддерживаемая native cancellation семантика; место списка known pins и owner events; безопасная процедура offline recovery. До определения cached-auth контракта нельзя обещать мгновенный полный отзыв изолированного P2P peer. Имена новых endpoints и schema migration выбираются после этого, не предполагаются готовыми.
