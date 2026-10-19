# Необязательный маршрут Ocean при host VPN

Это **не часть обычного запуска**. Нужен только для проверенной Linux-схемы, где native Tailscale использует rules 5210/5270, а host VPN перехватывает forwarded Docker-трафик через table 2022 с priority 9000+. Для другого окружения helper откажется применять исключение. Не включать его «на всякий случай».

На bigpc временный контролируемый эксперимент показал: направление только Ocean Tailscale-трафика мимо host VPN восстановило HTTPS после холодного запуска без обратного ping. Временное правило было удалено, полный исходный snapshot policy rules совпал. Общая конфигурация VPN не редактировалась, его служба и рабочий DSH не перезапускались.

## Что делает helper

[Python helper](../apps/server/scripts/ocean-route-helper.py) обслуживает единственное правило: priority 8990, protocol 193, **source=/32 текущего Tailscale-контейнера + incoming interface его отдельного transport bridge → lookup main**. Это весь forwarded IPv4 данного сетевого агента, включая WireGuard, STUN и служебный HTTPS; не анализ «только WireGuard-пакетов». IPv6 и остальные источники не меняются. Tailscale и его внешние службы увидят обычный WAN IP вместо VPN exit IP. Прикладной Ocean не подключён к transport-сети.

До применения проверяются:

- один Compose project/service с каноническими container IDs и закреплённым official image digest;
- исходные Entrypoint/Cmd, отсутствие host network/privileged/добавленных caps/devices/ports;
- отдельный Tailscale state volume, принадлежность networks, единственный workload на transport;
- отсутствие другого контейнера в namespace sidecar, включая ссылки через short ID;
- app только на internal IPv4 isolated backend, без Docker IPv6 и published ports;
- native Tailscale policy до priority 8990, VPN после него и отсутствие чужого правила на этом приоритете.

Правило обновляется при смене IP/bridge или убирается при утрате защитных условий. Это polling со сном пять секунд **после** обнаружения: Docker/ip-запросы имеют свои timeout, поэтому жёсткой пятисекундной гарантии нет. Изменения привилегированных акторов не могут быть транзакционно заблокированы этим кодом.

В root-only runtime хранится write-ahead receipt точного владения правилом. При остановке/аварийном завершении [unit](../apps/server/ocean-route.service) запускает cleanup, которому не нужны Docker или исправная конфигурация. Неоднозначный набор правил (например, чужой fwmark/dst/UID-selector с тем же broad delete tuple) **не удаляется**: receipt сохраняется, требуется разбор администратором. Не удалять receipt вручную и не использовать `ip rule flush` или голый `ip rule del pref 8990`.

## Права и границы

Это отдельная доверенная **host-служба root**, а не увеличение привилегий контейнеров. Ей нужны CAP_NET_ADMIN и доступ к host Docker Unix socket для metadata. Даже с systemd hardening это не защита от Docker/root-администратора. Helper не извлекает Config.Env/пароли, не скачивает images, не меняет VPN-файлы или native Tailscale/Serve и не выполняет команды из конфигурации.

Код устанавливать только после ревью из доверенной копии форка. Проверки без root:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest discover -s apps/server/scripts -p test_ocean_route_helper.py -v
```

## Установка администратором

Сначала закончить [отдельный tailnet deploy](tailnet-ocean.ru.md) и проверить фактические labels/images/networks. Зарезервировать priority 8990 только под этот helper. Каталог конфигурации, скрипт и unit ниже должны **отсутствовать**; при EEXIST остановиться, не перезаписывать прежнюю службу. Сохранить защищённые исходные snapshots `ip -N -d -4 -j rule show` и host Serve вне Git.

Из проверенного корня репозитория в административном терминале:

```sh
set -eu
for path in /etc/dsh-ocean-remote /usr/local/libexec/dsh-ocean-route.py /etc/systemd/system/dsh-ocean-route.service; do
  test ! -e "$path"
  test ! -L "$path"
done
test ! -L /usr/local/libexec
if test ! -e /usr/local/libexec; then install -d -m 0755 /usr/local/libexec; fi
install -d -m 0700 /etc/dsh-ocean-remote
install -m 0755 apps/server/scripts/ocean-route-helper.py /usr/local/libexec/dsh-ocean-route.py
install -m 0644 apps/server/ocean-route.service /etc/systemd/system/dsh-ocean-route.service
install -m 0600 apps/server/ocean-route.example.json /etc/dsh-ocean-remote/route.json
```

В route.json вручную задать ровно `project` и `image` из [примера](../apps/server/ocean-route.example.json). image — **тот же immutable официальный RepoDigest**, что в проверенном Compose. Пустой image намеренно не работает. Каталог 0700, файл 0600, владелец root; в нём нет account/password/auth key. Не копировать в него весь .env.

```sh
systemctl daemon-reload
systemctl start dsh-ocean-route.service
systemctl status dsh-ocean-route.service
```

До enable проверить настоящее правило, валидный клиентский HTTPS, холодный restart sidecar, Compose recreate с прежними volumes/node identity и обновление source IP. Затем **stop → точное удаление своего правила/receipt и равенство исходных native policy/Serve snapshots → start**. Только после успешной приёмки:

```sh
systemctl enable dsh-ocean-route.service
```

Состояние и журналы:

```sh
systemctl status dsh-ocean-route.service
journalctl -u dsh-ocean-route.service -n 30 --no-pager
ip -N -d -4 -j rule show
```

Журнал намеренно не печатает Docker Env, исходные исключения или конфигурационные значения. При смене Tailscale image нужно отдельно проверить новый digest и обновить root config; не снимать pin ради автоматического старта.

## Откат

```sh
systemctl disable --now dsh-ocean-route.service
```

Проверить отсутствие именно своего правила и сохранность остальных. Файлы/receipt не удалять до подтверждения cleanup. При повреждённом receipt или неоднозначных kernel selectors остановиться для ручного разбора, а не удалять политики по одному приоритету. Без исключения Tailscale-контейнер вновь пользуется исходным VPN-путём: прежняя проблема обнаружения peer может вернуться.

Обычный stop/start, sidecar restart, backend IP change и pair recreate проверяются отдельно. **Перезагрузка host/Docker daemon и долговременный SLA этим не доказываются**; работающий bigpc ради такой проверки не перезагружать. Экспирация/approval ключа Tailscale также остаются обязанностью владельца.
