#!/usr/bin/env bash
# Two Boots — установка сайта на чистый VPS с Ubuntu 22.04 / 24.04.
#
# Запуск на сервере от root (одной строкой):
#   curl -fsSL https://raw.githubusercontent.com/FalconZWZ/twoboots-site/main/deploy/install.sh | bash
# После того как DNS указывает на этот сервер — HTTPS-сертификат:
#   bash /opt/twoboots/deploy/install.sh ssl ваша@почта.ru
#
# Скрипт можно запускать повторно: он ничего не ломает и не трогает данные и настройки.
set -euo pipefail

REPO="${REPO:-https://github.com/FalconZWZ/twoboots-site.git}"
BRANCH="${BRANCH:-main}"
APP_DIR=/opt/twoboots
DATA_DIR=/var/lib/twoboots
ENV_FILE=/etc/twoboots.env          # ваши настройки (почта, Telegram…) — правится руками
FIXED_ENV=/etc/twoboots.fixed.env   # то, что задаёт сам сервер (порт, папка данных)
WWW=www.two-boots.ru
APEX=two-boots.ru
PORT=3000

NPM_HOME=/var/cache/twoboots-npm

say() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
# git/npm run as the unprivileged "twoboots" user with a HOME it can write to
as_app() { runuser -u twoboots -- env HOME="$NPM_HOME" "$@"; }

# Everything runs inside main(), called on the last line: with `curl … | bash` the whole
# script is read before anything executes, so no command can swallow the rest of it.
main() {
[ "$(id -u)" = 0 ] || { echo "Запустите от root (или через sudo)"; exit 1; }

if [ "${1:-}" = "ssl" ]; then
  EMAIL="${2:-}"
  [ -n "$EMAIL" ] || { echo "Укажите почту: bash $0 ssl you@mail.ru"; exit 1; }
  say "Получаю бесплатный сертификат Let's Encrypt для $WWW и $APEX"
  if ! certbot --nginx --non-interactive --agree-tos -m "$EMAIL" --redirect -d "$WWW" -d "$APEX"; then
    echo "Для $APEX не вышло (скорее всего, его A-запись ещё не указывает на этот сервер) — выпускаю только для $WWW"
    certbot --nginx --non-interactive --agree-tos -m "$EMAIL" --redirect -d "$WWW"
  fi
  say "Готово: https://$WWW — сертификат будет продлеваться автоматически"
  exit 0
fi

export DEBIAN_FRONTEND=noninteractive
say "Устанавливаю системные пакеты"
apt-get update -y
apt-get install -y curl git nginx ufw ca-certificates openssl certbot python3-certbot-nginx

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  say "Устанавливаю Node.js 20"
  if curl -fsSL https://deb.nodesource.com/setup_20.x | bash -; then
    apt-get install -y nodejs
  else
    apt-get install -y nodejs npm   # запасной вариант — Node из Ubuntu
  fi
fi
NODE_BIN="$(command -v node)"

# Маленьким серверам (1 ГБ) нужен swap, чтобы установка зависимостей не упала от нехватки памяти
if [ "$(free -m | awk '/Mem:/{print $2}')" -lt 1800 ] && ! swapon --show | grep -q .; then
  say "Добавляю swap 1 ГБ"
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

say "Пользователь и папки"
id twoboots >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin twoboots
mkdir -p "$DATA_DIR" "$NPM_HOME"
chown -R twoboots:twoboots "$DATA_DIR" "$NPM_HOME"

say "Код сайта из GitHub"
if [ ! -d "$APP_DIR/.git" ]; then
  git clone --depth 50 "$REPO" "$APP_DIR"
fi
chown -R twoboots:twoboots "$APP_DIR"
as_app git -C "$APP_DIR" fetch -q origin "$BRANCH"
as_app git -C "$APP_DIR" reset -q --hard "origin/$BRANCH"
say "Зависимости (npm ci)"
(cd "$APP_DIR" && as_app npm ci --omit=dev --no-audit --no-fund)

say "Настройки"
cat > "$FIXED_ENV" <<CONF
# Задаётся установщиком — не меняйте. Свои настройки пишите в $ENV_FILE
PORT=$PORT
DATA_DIR=$DATA_DIR
BRANCH=$BRANCH
NODE_ENV=production
CONF
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<CONF
# Two Boots — настройки сайта. После изменения выполните: systemctl restart twoboots
# Скопируйте сюда переменные из Railway → сервис → Variables → Raw Editor
# (строки вида KEY="значение"). PORT и DATA_DIR копировать НЕ нужно.
SESSION_SECRET=$(openssl rand -hex 32)
# SMTP_HOST="mail.hosting.reg.ru"
# SMTP_PORT="465"
# SMTP_USER="no-reply@two-boots.ru"
# SMTP_PASS="..."
# MAIL_FROM="Two Boots <no-reply@two-boots.ru>"
# OWNER_EMAIL="..."
# TELEGRAM_BOT_TOKEN="..."
# TELEGRAM_CHAT_ID="..."
# BOTORDER_URL="..."
# BOTORDER_SECRET="..."
CONF
  chmod 600 "$ENV_FILE"
fi

say "Автозапуск сайта (systemd)"
cat > /etc/systemd/system/twoboots.service <<UNIT
[Unit]
Description=Two Boots website
After=network-online.target
Wants=network-online.target

[Service]
User=twoboots
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
EnvironmentFile=$FIXED_ENV
ExecStart=$NODE_BIN server.js
Restart=always
RestartSec=3
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT

say "Автообновление из GitHub каждые 2 минуты"
cat > /etc/systemd/system/twoboots-update.service <<UNIT
[Unit]
Description=Two Boots: pull the latest version from GitHub

[Service]
Type=oneshot
ExecStart=/bin/bash $APP_DIR/deploy/update.sh
UNIT
cat > /etc/systemd/system/twoboots-update.timer <<UNIT
[Unit]
Description=Two Boots: check GitHub for a new version every 2 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=2min

[Install]
WantedBy=timers.target
UNIT

say "nginx"
# IPv6 listeners only where the kernel supports IPv6 (on some VPS it's switched off,
# and nginx refuses to start with a [::] listen line there)
if [ -e /proc/net/if_inet6 ]; then V6="listen [::]:80;"; V6D="listen [::]:80 default_server;"; else V6=""; V6D=""; fi
cat > /etc/nginx/sites-available/twoboots <<NGINX
# two-boots.ru → www.two-boots.ru (адрес сайта один — www)
server {
    listen 80;
    $V6
    server_name $APEX;
    return 301 https://$WWW\$request_uri;
}

server {
    listen 80 default_server;
    $V6D
    server_name $WWW;

    # фото товаров и восстановление из резервной копии
    client_max_body_size 500m;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
    }
}
NGINX
ln -sf /etc/nginx/sites-available/twoboots /etc/nginx/sites-enabled/twoboots
rm -f /etc/nginx/sites-enabled/default
nginx -t

say "Файрвол: открыты только SSH, 80 и 443"
ufw allow OpenSSH >/dev/null
ufw allow 'Nginx Full' >/dev/null
ufw --force enable >/dev/null

systemctl daemon-reload
systemctl enable --now twoboots
systemctl enable --now twoboots-update.timer
systemctl reload nginx

say "Проверяю, что сайт запустился"
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then OK=1; break; fi
  sleep 1
done
IP="$(curl -fsS -4 --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
if [ "${OK:-}" = 1 ]; then
  cat <<DONE

  ✅ Сайт установлен и работает на этом сервере.

  IP-адрес сервера: $IP
  Проверка (до смены DNS): откройте в браузере  http://$IP

  Дальше:
   1) Впишите настройки из Railway:   nano $ENV_FILE
      затем:                            systemctl restart twoboots
   2) В reg.ru поменяйте DNS: www и @ → A-запись $IP
   3) Когда DNS обновится (5–30 мин):  bash $APP_DIR/deploy/install.sh ssl ваша@почта.ru

  Логи сайта:  journalctl -u twoboots -f
DONE
else
  echo "⚠ Сайт не ответил. Посмотрите логи: journalctl -u twoboots -n 100"
  exit 1
fi
}

main "$@"
