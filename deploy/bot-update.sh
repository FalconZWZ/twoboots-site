#!/usr/bin/env bash
# Two Boots — автообновление бота заявок (таймер twoboots-bot-update, каждые 5 минут).
# Как deploy/update.sh для сайта: забирает новую версию из GitHub, перезапускает бота,
# а если он не поднялся — возвращает предыдущую.
set -euo pipefail
BOT_DIR=/opt/twoboots-bot
PORT="$(grep -E '^PORT=' /etc/twoboots-bot.fixed.env | cut -d= -f2)"
BRANCH="$(grep -E '^BOT_BRANCH=' /etc/twoboots-bot.fixed.env | cut -d= -f2)"; BRANCH="${BRANCH:-main}"
as_app() { runuser -u twoboots -- env HOME=/var/cache/twoboots-npm "$@"; }
deps() { as_app "$BOT_DIR/.venv/bin/pip" install -q --disable-pip-version-check -r "$BOT_DIR/requirements.txt"; }
healthy() {
  for _ in $(seq 1 30); do
    sleep 1
    curl -fsS "http://127.0.0.1:${PORT:-8080}/health" >/dev/null 2>&1 && return 0
  done
  return 1
}

cd "$BOT_DIR"
as_app git fetch -q origin "$BRANCH"
OLD="$(as_app git rev-parse HEAD)"
NEW="$(as_app git rev-parse "origin/$BRANCH")"
[ "$OLD" = "$NEW" ] && exit 0
FAILED_FILE=/var/lib/twoboots-bot/.update-failed
[ -f "$FAILED_FILE" ] && [ "$(cat "$FAILED_FILE")" = "$NEW" ] && exit 0

echo "Обновление бота ${OLD:0:7} → ${NEW:0:7}"
as_app git reset -q --hard "$NEW"
DEPS_CHANGED=0
as_app git diff --quiet "$OLD" "$NEW" -- requirements.txt || DEPS_CHANGED=1
[ "$DEPS_CHANGED" = 1 ] && deps
systemctl restart twoboots-bot
if healthy; then
  rm -f "$FAILED_FILE"
  echo "Готово: бот работает на ${NEW:0:7}"
  exit 0
fi
echo "$NEW" > "$FAILED_FILE"

echo "Новая версия бота не запустилась — возвращаю ${OLD:0:7}" >&2
as_app git reset -q --hard "$OLD"
[ "$DEPS_CHANGED" = 1 ] && deps
systemctl restart twoboots-bot
healthy && echo "Откат выполнен, бот работает на ${OLD:0:7}" >&2
exit 1
