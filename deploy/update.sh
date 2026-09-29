#!/usr/bin/env bash
# Two Boots — автообновление (запускается таймером twoboots-update каждые 2 минуты).
# Если в main на GitHub появилась новая версия: забирает её, при необходимости ставит
# зависимости и перезапускает сайт. Если новая версия не отвечает на /health —
# возвращает предыдущую. Вручную: systemctl start twoboots-update && journalctl -u twoboots-update -n 30
set -euo pipefail
APP_DIR=/opt/twoboots
PORT="$(grep -E '^PORT=' /etc/twoboots.fixed.env | cut -d= -f2)"
BRANCH="$(grep -E '^BRANCH=' /etc/twoboots.fixed.env | cut -d= -f2)"; BRANCH="${BRANCH:-main}"
as_app() { runuser -u twoboots -- env HOME=/var/cache/twoboots-npm "$@"; }
deps() { (cd "$APP_DIR" && as_app npm ci --omit=dev --no-audit --no-fund); }
healthy() {
  for _ in $(seq 1 30); do
    sleep 1
    curl -fsS "http://127.0.0.1:${PORT:-3000}/health" >/dev/null 2>&1 && return 0
  done
  return 1
}

cd "$APP_DIR"
as_app git fetch -q origin "$BRANCH"
OLD="$(as_app git rev-parse HEAD)"
NEW="$(as_app git rev-parse "origin/$BRANCH")"
[ "$OLD" = "$NEW" ] && exit 0
# A version that already failed its health check is not retried every 2 minutes —
# only once something newer lands in GitHub.
FAILED_FILE=/var/lib/twoboots/.update-failed
[ -f "$FAILED_FILE" ] && [ "$(cat "$FAILED_FILE")" = "$NEW" ] && exit 0

echo "Обновление ${OLD:0:7} → ${NEW:0:7}"
as_app git reset -q --hard "$NEW"
DEPS_CHANGED=0
as_app git diff --quiet "$OLD" "$NEW" -- package.json package-lock.json || DEPS_CHANGED=1
[ "$DEPS_CHANGED" = 1 ] && deps
systemctl restart twoboots
if healthy; then
  rm -f "$FAILED_FILE"
  echo "Готово: работает ${NEW:0:7}"
  exit 0
fi
echo "$NEW" > "$FAILED_FILE"

echo "Новая версия не отвечает — возвращаю ${OLD:0:7}" >&2
as_app git reset -q --hard "$OLD"
[ "$DEPS_CHANGED" = 1 ] && deps
systemctl restart twoboots
healthy && echo "Откат выполнен, сайт работает на ${OLD:0:7}" >&2
exit 1
