#!/usr/bin/env bash
# Ложа: установка на чистый VPS (Ubuntu 22.04+ / Debian 12+) одной командой от root:
#
#   curl -fsSL https://raw.githubusercontent.com/alexz081231/lozha/main/install.sh | bash
#
# Скрипт ставит Node.js, ffmpeg, nginx, yt-dlp, настраивает сервис и HTTPS и в конце печатает адрес и пароль.
# Его можно запускать повторно: код обновится, данные и аккаунты останутся.
#
# Необязательные переменные (перед bash):
#   LOZHA_DOMAIN=kino.example.com   свой домен (его A-запись уже должна вести на этот сервер);
#                                   без него берётся адрес вида 1-2-3-4.sslip.io — тоже с настоящим HTTPS
#   LOZHA_OWNER=Имя                 логин владельца (по умолчанию «Пользователь»)
#   LOZHA_OWNER_PASSWORD=...        пароль владельца (по умолчанию случайный; задаётся только при первой установке)
#   LOZHA_EMAIL=me@example.com      почта для Let's Encrypt (необязательно)
#   LOZHA_REPO, LOZHA_BRANCH        откуда брать код (по умолчанию этот репозиторий, ветка main)
#
# Пример со своим доменом:  curl -fsSL <ссылка> | LOZHA_DOMAIN=kino.example.com bash
set -Eeuo pipefail
trap 'echo "✗ Ошибка на строке $LINENO. Исправь причину и запусти установку ещё раз: она безопасно повторяется." >&2' ERR

REPO="${LOZHA_REPO:-https://github.com/alexz081231/lozha}"
BRANCH="${LOZHA_BRANCH:-main}"
APP=/var/www/lozha
DATA=/var/lib/lozha
UPDATE_ONLY=0
[ "${1:-}" = "--update" ] && UPDATE_ONLY=1

say()  { printf '\033[1m▸ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; trap - ERR; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Запусти от root (на VPS обычно так и есть) или добавь sudo: curl ... | sudo bash"
command -v apt-get >/dev/null 2>&1 || die "Нужен Ubuntu или Debian (не нашёл apt-get)."
[ -d /run/systemd/system ] || die "Нужен systemd."

export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
APT=(apt-get -o DPkg::Lock::Timeout=300 -y -qq)

node_ok() {
  command -v node >/dev/null 2>&1 &&
    node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=5)?0:1)'
}

# ───────────────────────── 1. Пакеты и Node.js ─────────────────────────
if (( ! UPDATE_ONLY )); then
  say "Ставлю пакеты (nginx, ffmpeg, git, certbot)…"
  "${APT[@]}" update
  "${APT[@]}" install ca-certificates curl git ffmpeg nginx certbot

  if ! node_ok; then
    say "Ставлю Node.js 22…"
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
    "${APT[@]}" install nodejs
  fi
fi
node_ok || die "Нужен Node.js 22.5 или новее, а стоит: $(node -v 2>/dev/null || echo 'ничего')."
NODE_BIN="$(command -v node)"

# ───────────────────────── 2. Пользователь и папки ─────────────────────────
if (( ! UPDATE_ONLY )); then
  id lozha >/dev/null 2>&1 || useradd --system --no-create-home --home-dir "$DATA" --shell /usr/sbin/nologin lozha
  install -d -o lozha -g lozha -m 750 "$DATA"
  install -d -m 755 "$APP" /var/www/letsencrypt
  # nginx сам отдаёт видео из папки данных, поэтому ему нужно право читать её
  usermod -aG lozha www-data
fi

# ───────────────────────── 3. Код ─────────────────────────
# При обновлении код уже подтянула команда lozha-update.
if (( ! UPDATE_ONLY )); then
  say "Скачиваю Ложу ($BRANCH)…"
  [ -d "$APP/.git" ] || git -C "$APP" init -q
  git -C "$APP" remote add origin "$REPO" 2>/dev/null || git -C "$APP" remote set-url origin "$REPO"
  git -C "$APP" fetch -q --depth 1 origin "$BRANCH"
  git -C "$APP" reset -q --hard FETCH_HEAD
fi

say "Ставлю зависимости и yt-dlp…"
(cd "$APP" && npm install --omit=dev --ignore-scripts --no-audit --no-fund --silent)
runuser -u lozha -- env HOME="$DATA" LOZHA_BIN="$DATA/bin" node "$APP/scripts/setup.mjs" --quiet || warn "yt-dlp не поставился — загрузка по ссылке заработает после «lozha-update»."

# ───────────────────────── 4. Сервис ─────────────────────────
say "Настраиваю сервис…"
sed "s|/usr/bin/node|$NODE_BIN|" "$APP/deploy/lozha.service" > /etc/systemd/system/lozha.service

FIRST=0
if [ ! -f "$DATA/lozha.db" ]; then
  FIRST=1
  OWNER="${LOZHA_OWNER:-Пользователь}"
  PASS="${LOZHA_OWNER_PASSWORD:-$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | cut -c1-14)}"
  # Логин и пароль нужны только при самом первом запуске: передаём их через окружение systemd, а не пишем в файл сервиса
  systemctl set-environment "LOZHA_OWNER=$OWNER" "LOZHA_OWNER_PASSWORD=$PASS"
fi

systemctl daemon-reload
systemctl enable lozha >/dev/null 2>&1
systemctl restart lozha

up=0
for _ in $(seq 1 40); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/me || true)" = "200" ] && { up=1; break; }
  sleep 0.5
done
systemctl unset-environment LOZHA_OWNER LOZHA_OWNER_PASSWORD 2>/dev/null || true
if (( ! up )); then
  journalctl -u lozha -n 30 --no-pager >&2 || true
  die "Сервис не запустился (журнал выше)."
fi

# ───────────────────────── 5. Команда обновления ─────────────────────────
cat > /usr/local/bin/lozha-update <<EOF
#!/usr/bin/env bash
# Обновляет Ложу до последней версии из $REPO ($BRANCH). Данные не трогает.
set -e
[ "\$(id -u)" -eq 0 ] || { echo "Запусти от root: sudo lozha-update"; exit 1; }
git -C $APP fetch -q --depth 1 origin $BRANCH
git -C $APP reset -q --hard FETCH_HEAD
exec bash $APP/install.sh --update
EOF
chmod 755 /usr/local/bin/lozha-update

if (( UPDATE_ONLY )); then
  say "Обновлено и перезапущено."
  exit 0
fi

# ───────────────────────── 6. nginx и HTTPS ─────────────────────────
detect_ip() {
  local u ip
  for u in https://api.ipify.org https://ifconfig.me https://icanhazip.com; do
    ip="$(curl -4 -fsS --max-time 5 "$u" 2>/dev/null | tr -d '[:space:]')" || true
    if [[ "$ip" =~ ^[0-9]+(\.[0-9]+){3}$ ]]; then echo "$ip"; return 0; fi
  done
  return 1
}

DOMAIN="${LOZHA_DOMAIN:-}"
if [ -z "$DOMAIN" ]; then
  IP="$(detect_ip || true)"
  [ -n "$IP" ] && DOMAIN="${IP//./-}.sslip.io"
fi
[ -z "$DOMAIN" ] || [[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || die "Странный домен: $DOMAIN"

SITE=/etc/nginx/sites-available/lozha
EXAMPLE="$APP/deploy/nginx.conf.example"

# Конфиг без HTTPS: берём из примера только основной блок и убираем из него всё про сертификаты
make_http_conf() {
  awk -v name="${DOMAIN:-_}" '
    /^server[[:space:]]*\{/ { n++ }
    n < 2 { next }
    /ssl_certificate|ssl_protocols|ssl_session|Strict-Transport-Security/ { next }
    /listen \[::\]:443/ { print "    listen [::]:80 default_server;"; next }
    /listen 443/        { print "    listen 80 default_server;"; next }
    /server_name/       { print "    server_name " name ";"; next }
    index($0, "location ~ /\\.") { print "    location ^~ /.well-known/acme-challenge/ { root /var/www/letsencrypt; }" }
    { print }
  ' "$EXAMPLE"
}

nginx_apply() {
  if ! nginx -t >/dev/null 2>&1; then nginx -t >&2 || true; return 1; fi
  systemctl restart nginx
}

say "Настраиваю nginx…"
rm -f /etc/nginx/sites-enabled/default
ln -sf "$SITE" /etc/nginx/sites-enabled/lozha
make_http_conf > "$SITE"
systemctl enable nginx >/dev/null 2>&1
nginx_apply || die "nginx не принял конфиг (см. выше)."

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null
fi

SCHEME=http
HOSTNAME_SHOWN="${DOMAIN:-}"
if [ -n "$DOMAIN" ]; then
  CERT="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
  if [ ! -s "$CERT" ]; then
    say "Получаю сертификат HTTPS для $DOMAIN…"
    CB=(certbot certonly --webroot -w /var/www/letsencrypt -d "$DOMAIN" --non-interactive --agree-tos --deploy-hook "systemctl reload nginx")
    if [ -n "${LOZHA_EMAIL:-}" ]; then CB+=(-m "$LOZHA_EMAIL"); else CB+=(--register-unsafely-without-email); fi
    "${CB[@]}" >/tmp/lozha-certbot.log 2>&1 || warn "Сертификат не выдали (подробности: /tmp/lozha-certbot.log). Сайт пока работает без HTTPS."
  fi
  if [ -s "$CERT" ]; then
    sed "s/example\.com/$DOMAIN/g" "$EXAMPLE" > "$SITE"
    if nginx_apply; then
      SCHEME=https
    else
      warn "nginx не принял конфиг с HTTPS — возвращаю вариант без него."
      make_http_conf > "$SITE"; nginx_apply || die "nginx не запускается."
    fi
  fi
fi

# ───────────────────────── 7. Проверка ─────────────────────────
say "Проверяю, что всё работает…"
systemctl is-active --quiet lozha || die "Сервис lozha не работает."
if [ "$SCHEME" = https ]; then
  code="$(curl -sk -o /dev/null -w '%{http_code}' --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/me" || true)"
else
  code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/api/me || true)"
fi
[ "$code" = "200" ] || die "Сайт через nginx отвечает кодом ${code:-—}. Смотри: journalctl -u nginx -u lozha -n 50"
runuser -u www-data -- test -x "$DATA" || warn "nginx не может читать $DATA — видео могут не открываться. Попробуй: systemctl restart nginx"

if [ -n "$HOSTNAME_SHOWN" ]; then URL="$SCHEME://$HOSTNAME_SHOWN"; else URL="http://<адрес-сервера>"; fi

if (( FIRST )); then
  umask 077
  printf 'Адрес:  %s\nЛогин:  %s\nПароль: %s\n' "$URL" "$OWNER" "$PASS" > /root/lozha-login.txt
fi

cat <<EOF

  ✔ Ложа установлена

  Адрес:   $URL
EOF
if (( FIRST )); then
  cat <<EOF
  Логин:   $OWNER
  Пароль:  $PASS
           (записан в /root/lozha-login.txt; смени его в «Настройки» → «Профиль»)
EOF
else
  echo "  Аккаунты и данные остались прежними."
fi
cat <<EOF

  Друзей зови через «Друзья» → «Пригласить».
  Обновить до новой версии:  lozha-update
  Логи сервиса:              journalctl -u lozha -f
EOF
[ "$SCHEME" = https ] || echo "
  Адрес без HTTPS: голосовой чат в браузере работать не будет. Чтобы включить HTTPS, направь домен на этот сервер
  и запусти установку снова с LOZHA_DOMAIN=твой.домен"
echo
