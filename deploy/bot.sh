#!/usr/bin/env bash
# Two Boots — бот заявок (twoboots-botorder) на том же сервере, что и сайт.
#
#   bash /opt/twoboots/deploy/bot.sh
#
# Первый запуск ставит бота и создаёт /etc/twoboots-bot.env — впишите туда переменные бота
# из Railway и запустите скрипт ещё раз: он включит бота и переключит сайт на него.
# Скрипт можно запускать повторно: данные бота (подписчики, заявки) не трогаются.
set -euo pipefail

BOT_REPO="${BOT_REPO:-https://github.com/FalconZWZ/twoboots-botorder.git}"
BOT_BRANCH="${BOT_BRANCH:-main}"
BOT_DIR=/opt/twoboots-bot
BOT_DATA=/var/lib/twoboots-bot
BOT_ENV=/etc/twoboots-bot.env          # ваши настройки бота — правится руками
BOT_FIXED_ENV=/etc/twoboots-bot.fixed.env
BOT_PORT=8080
SITE_ENV=/etc/twoboots.env
SITE_DIR=/opt/twoboots

say() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
as_app() { runuser -u twoboots -- env HOME=/var/cache/twoboots-npm "$@"; }

main() {
[ "$(id -u)" = 0 ] || { echo "Запустите от root (или через sudo)"; exit 1; }
id twoboots >/dev/null 2>&1 || { echo "Сначала установите сайт: deploy/install.sh"; exit 1; }

say "Проверяю связь с Telegram"
if ! curl -s -m 15 -o /dev/null https://api.telegram.org/; then
  echo "⚠ С этого сервера нет связи с api.telegram.org — бот здесь работать не сможет."
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
say "Python"
apt-get update -y >/dev/null && apt-get install -y python3 python3-venv git >/dev/null

say "Код бота из GitHub"
mkdir -p "$BOT_DATA"
chown twoboots:twoboots "$BOT_DATA"
if [ ! -d "$BOT_DIR/.git" ]; then
  if ! git clone -q --depth 50 --branch "$BOT_BRANCH" "$BOT_REPO" "$BOT_DIR"; then
    echo "⚠ Не удалось скачать $BOT_REPO."
    echo "  Если репозиторий приватный — сделайте его публичным (в нём нет паролей) или"
    echo "  укажите адрес с токеном: BOT_REPO=https://ТОКЕН@github.com/... bash $0"
    exit 1
  fi
fi
chown -R twoboots:twoboots "$BOT_DIR"
as_app git -C "$BOT_DIR" fetch -q origin "$BOT_BRANCH"
as_app git -C "$BOT_DIR" reset -q --hard "origin/$BOT_BRANCH"

say "Зависимости"
[ -x "$BOT_DIR/.venv/bin/python" ] || as_app python3 -m venv "$BOT_DIR/.venv"
as_app "$BOT_DIR/.venv/bin/pip" install -q --disable-pip-version-check -r "$BOT_DIR/requirements.txt"

say "Настройки"
cat > "$BOT_FIXED_ENV" <<CONF
# Задаётся установщиком — не меняйте. Свои настройки пишите в $BOT_ENV
HOST=127.0.0.1
PORT=$BOT_PORT
SUBSCRIBERS_PATH=$BOT_DATA/subscribers.json
BOT_BRANCH=$BOT_BRANCH
CONF
if [ ! -f "$BOT_ENV" ]; then
  cat > "$BOT_ENV" <<CONF
# Бот заявок — настройки. После изменения выполните: bash $SITE_DIR/deploy/bot.sh
# Скопируйте сюда переменные из Railway → сервис БОТА → Variables → Raw Editor.
# Нужны BOT_TOKEN, PHONES, ADMIN_PHONES, WEBHOOK_SECRET. PORT, HOST и SUBSCRIBERS_PATH
# копировать НЕ нужно.
CONF
  chmod 600 "$BOT_ENV"
fi

cat > /etc/systemd/system/twoboots-bot.service <<UNIT
[Unit]
Description=Two Boots order bot
After=network-online.target
Wants=network-online.target

[Service]
User=twoboots
WorkingDirectory=$BOT_DIR
EnvironmentFile=$BOT_ENV
EnvironmentFile=$BOT_FIXED_ENV
ExecStart=$BOT_DIR/.venv/bin/python main.py
Restart=always
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/twoboots-bot-update.service <<UNIT
[Unit]
Description=Two Boots bot: pull the latest version from GitHub

[Service]
Type=oneshot
ExecStart=/bin/bash $SITE_DIR/deploy/bot-update.sh
UNIT
cat > /etc/systemd/system/twoboots-bot-update.timer <<UNIT
[Unit]
Description=Two Boots bot: check GitHub for a new version every 5 minutes

[Timer]
OnBootSec=3min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload

if ! grep -qE '^BOT_TOKEN=.+' "$BOT_ENV" || ! grep -qE '^WEBHOOK_SECRET=.+' "$BOT_ENV"; then
  cat <<NEXT

  Бот установлен, но ещё не настроен.
   1) Остановите бота на Railway (иначе два бота будут мешать друг другу в Telegram).
   2) Впишите его переменные из Railway:   nano $BOT_ENV
   3) Запустите этот скрипт ещё раз:        bash $SITE_DIR/deploy/bot.sh
NEXT
  exit 0
fi

say "Запускаю бота"
systemctl enable -q twoboots-bot twoboots-bot-update.timer
systemctl restart twoboots-bot
systemctl start twoboots-bot-update.timer
OK=
for _ in $(seq 1 30); do
  sleep 1
  if curl -fsS "http://127.0.0.1:$BOT_PORT/health" >/dev/null 2>&1; then OK=1; break; fi
done
if [ -z "$OK" ]; then
  echo "⚠ Бот не запустился. Логи: journalctl -u twoboots-bot -n 50"
  exit 1
fi

say "Переключаю сайт на этого бота"
# Сайт должен знать тот же секрет, что и бот
SECRET="$(grep -E '^WEBHOOK_SECRET=' "$BOT_ENV" | tail -1 | cut -d= -f2-)"
sed -i -E '/^(BOTORDER_URL|BOTORDER_SECRET)=/d' "$SITE_ENV"
{
  echo "BOTORDER_URL=\"http://127.0.0.1:$BOT_PORT/submit\""
  echo "BOTORDER_SECRET=$SECRET"
} >> "$SITE_ENV"
systemctl restart twoboots

cat <<DONE

  ✅ Бот заявок работает на этом сервере, сайт отправляет заказы в него.

  Каждый получатель заявок должен один раз открыть бота в Telegram, нажать /start
  и «Поделиться номером» — список подписчиков на новом сервере пока пустой.

  Логи бота:  journalctl -u twoboots-bot -f
DONE
}

main "$@"
