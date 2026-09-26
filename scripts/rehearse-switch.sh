#!/usr/bin/env bash
#
# A rehearsal of a real mode switch, on a host that has systemd and (for the private half) a
# tailnet node.
#
# Why this is a script and not a test: a switch is one command and one restart, and nearly
# everything that can go wrong with it is *outside* the file — which front door is open, whether
# the box came back in the shape the file names, whether the things the file feeds (the relay,
# the timers) followed it, whether the database survived its migration. A test runner cannot ask
# any of those questions, because none of them are about a value in JavaScript. So they are asked
# here, on a host that can be thrown away.
#
# DO NOT RUN THIS ON A DEPLOYMENT ANYBODY IS USING. It installs units, starts and stops services,
# rewrites `.env`, migrates the database and takes backups.
#
# Usage, on the rehearsal host:
#     sudo SRC=/home/admin/crossbar ./scripts/rehearse-switch.sh
#
# The tree must already be at $SRC (the whole repository, dependencies installed or installable).
# Node 22 or newer is required; `node:sqlite` is not in anything older.

set -uo pipefail

SRC="${SRC:-/home/admin/crossbar}"
PORT="${PORT:-3003}"
OWNER="${OWNER:-admin}"
FAILED=0

say()  { printf '  %s\n' "$*"; }
head_() { printf '\n=== %s ===\n' "$*"; }
pass() { printf '  PASS  %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; FAILED=1; }

expect() { # expect <description> <actual> <wanted>
    if [ "$2" = "$3" ]; then pass "$1: $2"; else fail "$1: got '$2', wanted '$3'"; fi
}

health() { curl -s --max-time 5 "http://127.0.0.1:$PORT/api/health" 2>/dev/null; }
field()  { # field <name> — one value out of the health answer
    health | node -e '
        let raw = "";
        process.stdin.on("data", (chunk) => { raw += chunk; });
        process.stdin.on("end", () => {
            try { process.stdout.write(String(JSON.parse(raw)[process.argv[1]] ?? "")); }
            catch { process.stdout.write(""); }
        });' "$1"
}
as_user() { # as_user <login> <path> — what a tailnet member's request looks like
    curl -s --max-time 5 -H "Tailscale-User-Login: $1" -H "Tailscale-User-Name: $1" \
        "http://127.0.0.1:$PORT$2" 2>/dev/null
}
json_field() { node -e '
    let raw = "";
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
        try { const value = JSON.parse(raw); process.stdout.write(String(process.argv[1].split(".").reduce((a, k) => a?.[k], value) ?? "")); }
        catch { process.stdout.write(""); }
    });' "$1"
}
wait_for_health() {
    for _ in $(seq 1 40); do
        [ -n "$(health)" ] && return 0
        sleep 0.5
    done
    return 1
}
restart() {
    systemctl restart crossbar
    wait_for_health || fail "the server did not answer after a restart"
}
switch_to() { # switch_to <mode>
    node "$SRC/src/admin.js" mode "$1" >/dev/null || fail "the switch to $1 refused"
}

head_ "1. preconditions"
[ "$(id -u)" = "0" ] && pass "running as root, so units can be installed" || fail "must run as root"
command -v systemctl >/dev/null && pass "systemd present" || fail "no systemd: this host cannot rehearse the units"
node --version | grep -qE '^v(2[2-9]|[3-9][0-9])' && pass "node $(node --version)" || fail "node 22+ required"
[ -f "$SRC/src/server.js" ] && pass "the tree is at $SRC" || { fail "no tree at $SRC"; exit 1; }
[ -f "$SRC/data/directory.json" ] && pass "a directory file exists" || say "no directory file: create one before the first start"

head_ "2. install the units"
cp -f "$SRC"/deploy/crossbar.service "$SRC"/deploy/crossbar-public.service \
      "$SRC"/deploy/crossbar-private.service /etc/systemd/system/
[ -f "$SRC/deploy/crossbar-turn.service" ] && cp -f "$SRC/deploy/crossbar-turn.service" /etc/systemd/system/
[ -f "$SRC/deploy/crossbar-backup.service" ] && cp -f "$SRC"/deploy/crossbar-backup.{service,timer} /etc/systemd/system/
systemctl daemon-reload && pass "units installed and reloaded"
# A unit file that systemd cannot parse is worse than a missing one: it looks installed.
for unit in crossbar.service crossbar-public.service crossbar-private.service; do
    if systemd-analyze verify "/etc/systemd/system/$unit" >/dev/null 2>&1; then
        pass "$unit verifies"
    else
        say "  systemd-analyze verify $unit said:"
        systemd-analyze verify "/etc/systemd/system/$unit" 2>&1 | sed 's/^/    /'
        fail "$unit does not verify"
    fi
done

head_ "3. private mode: the file, and the box it produces"
switch_to private
expect "the file says private" "$(grep -c '^CROSSBAR_NETWORK_MODE=private$' "$SRC/.env")" "1"
systemctl enable --now crossbar >/dev/null 2>&1
restart
expect "health reports private" "$(field mode)" "private"
expect "the version is reported" "$(field version | grep -cE '^[0-9]+\.[0-9]+\.[0-9]+$')" "1"
if command -v tailscale >/dev/null && tailscale status >/dev/null 2>&1; then
    if tailscale serve status 2>/dev/null | grep -q "127.0.0.1:$PORT"; then
        pass "the tailnet serves the loopback listener"
    else
        fail "private mode is in force and nothing is serving it on the tailnet"
    fi
    if systemctl is-active caddy >/dev/null 2>&1; then fail "Caddy is running in private mode"; else pass "Caddy is not running, as private mode wants"; fi
else
    say "no tailnet node here: the private front door is not being rehearsed"
fi
expect "a tailnet identity is believed" "$(as_user abdullah@dev /api/session | json_field identity.source)" "tailscale"

head_ "4. switch to public: the shape must follow the file"
switch_to public
expect "the file says public" "$(grep -c '^CROSSBAR_NETWORK_MODE=public$' "$SRC/.env")" "1"
restart
expect "health reports public" "$(field mode)" "public"
# The whole point of the mode: the header is not an identity here, whoever sends it.
expect "a tailnet identity is NOT believed" "$(as_user abdullah@dev /api/bootstrap | json_field error.code)" "DEVICE_AUTH_REQUIRED"
if systemctl is-active caddy >/dev/null 2>&1; then pass "Caddy is up, as public mode wants"; else fail "public mode is in force and Caddy is not running"; fi
if command -v tailscale >/dev/null && tailscale status >/dev/null 2>&1; then
    if tailscale serve status 2>/dev/null | grep -q "127.0.0.1:$PORT"; then
        fail "the tailnet still serves in public mode"
    else
        pass "the tailnet stopped serving"
    fi
fi

head_ "5. and back, because a switch has to survive being done twice"
switch_to private
restart
expect "health reports private again" "$(field mode)" "private"
expect "the tailnet identity is believed again" "$(as_user abdullah@dev /api/session | json_field identity.source)" "tailscale"
if systemctl is-active caddy >/dev/null 2>&1; then fail "Caddy stayed up after switching back"; else pass "Caddy is down again"; fi

head_ "6. the file survived being switched twice"
# Everything a switch does not own has to be exactly where it was. The generated section is
# allowed to differ; nothing else is.
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
cp "$SRC/.env" "/tmp/rehearsal-env-$STAMP"
say "the file as it stands is kept at /tmp/rehearsal-env-$STAMP for inspection"
expect "the sessions secret is still set" "$(grep -c '^CROSSBAR_SESSION_SECRET=.\+' "$SRC/.env")" "1"
expect "the listener is still set" "$(grep -c "^PORT=$PORT$" "$SRC/.env")" "1"

head_ "7. the relay followed the mode, when it is installed"
if systemctl is-enabled crossbar-turn >/dev/null 2>&1; then
    if journalctl -u crossbar-private.service --no-pager -n 20 2>/dev/null | grep -q 'crossbar-turn'; then
        pass "the mode shaper asked the relay to follow"
    else
        fail "the relay is installed and the mode shaper did not move it"
    fi
else
    say "no relay installed here: coturn's realm is not being rehearsed"
fi

head_ "8. a backup can be taken, and it can be restored"
if [ -f "$SRC/deploy/crossbar-backup.service" ]; then
    systemctl start crossbar-backup.service && pass "the backup service ran"
    LATEST="$(ls -1dt "$SRC"/data/backups/*/ 2>/dev/null | head -1)"
    if [ -n "$LATEST" ]; then
        pass "a backup exists at $LATEST"
        if sqlite3 "${LATEST%/}/crossbar.sqlite" "SELECT COUNT(*) FROM users;" >/dev/null 2>&1; then
            pass "the database in it opens and answers ($(sqlite3 "${LATEST%/}/crossbar.sqlite" 'SELECT COUNT(*) FROM users;') people)"
        else
            fail "the backup database does not open"
        fi
        [ -f "${LATEST%/}/directory.json" ] && pass "the directory file is in the backup" || fail "no directory file in the backup"
    else
        fail "no backup was produced"
    fi
else
    say "no backup unit in this tree yet"
fi

head_ "9. a migration takes a snapshot before it runs"
# The one irreversible thing the server does. Faked by walking the database back a version,
# which is exactly the state an older deployment is in when a newer build starts.
DB="$SRC/data/crossbar.sqlite"
if [ -f "$DB" ]; then
    VERSION_BEFORE="$(sqlite3 "$DB" 'PRAGMA user_version;')"
    SNAPSHOTS_BEFORE="$(ls -1 "$SRC"/data/backups/crossbar-before-v*.sqlite 2>/dev/null | wc -l)"
    sqlite3 "$DB" "PRAGMA user_version = $((VERSION_BEFORE - 1));"
    restart
    SNAPSHOTS_AFTER="$(ls -1 "$SRC"/data/backups/crossbar-before-v*.sqlite 2>/dev/null | wc -l)"
    expect "a snapshot was taken before migrating" "$((SNAPSHOTS_AFTER - SNAPSHOTS_BEFORE))" "1"
    expect "the server came back" "$(systemctl is-active crossbar)" "active"
fi

head_ "verdict"
if [ "$FAILED" = "0" ]; then
    echo "  every check passed"
else
    echo "  SOMETHING FAILED — read the FAIL lines above"
fi
exit "$FAILED"
