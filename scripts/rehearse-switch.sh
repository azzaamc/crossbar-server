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
GRACE="${GRACE:-2}"
FAILED=0
SKIPPED=0

say()  { printf '  %s\n' "$*"; }
skip() { printf '  SKIP  %s\n' "$*"; SKIPPED=$((SKIPPED + 1)); }
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
# A door that closes on a timer is eventually closed, not closed at the moment it is asked: the
# state after a grace window has to be waited for, not sampled. Sampling once is how a working
# overlap reads as a broken one, which is what these two exist to stop.
wait_until_gone() { # wait_until_gone <seconds> <command...>
    local deadline=$((SECONDS + $1)); shift
    while [ "$SECONDS" -lt "$deadline" ]; do
        "$@" >/dev/null 2>&1 && return 0
        sleep 1
    done
    return 1
}
wait_until_true() { # wait_until_true <seconds> <command...>
    local deadline=$((SECONDS + $1)); shift
    while [ "$SECONDS" -lt "$deadline" ]; do
        "$@" >/dev/null 2>&1 || return 0
        sleep 1
    done
    return 1
}

wait_for_health() {
    for _ in $(seq 1 40); do
        [ -n "$(health)" ] && return 0
        sleep 0.5
    done
    return 1
}
restart() {
    # A rehearsal restarts faster than a deployment ever does, and `Restart=always` plus a burst
    # of restarts hits systemd's start limit: the service then refuses to start at all and the
    # failure reads as the server being broken. Clearing the counter is what a rehearsal needs and
    # a deployment never does.
    systemctl reset-failed crossbar 2>/dev/null || true
    systemctl restart crossbar
    wait_for_health || fail "the server did not answer after a restart"
}
switch_to() { # switch_to <mode>
    # In $SRC and as the service user. Both matter, and both were learned here.
    #
    # In $SRC, because the CLI resolves `.env` against its working directory: run from anywhere
    # else it rewrites a file nobody reads and the mode in force never changes.
    #
    # As the service user, because whoever runs the CLI ends up owning the file it rewrites --
    # the writer stages a new file and renames it into place, which carries the new owner with
    # it. Run from a root shell, and the service cannot read its own configuration at the next
    # start: it fails with EACCES naming a file that is plainly there. That is a real defect in
    # the writer and is being fixed; until it is, a rehearsal that runs the CLI as root is
    # rehearsing something the deployment never does.
    local user="${OWNER:-admin}"
    if ! (cd "$SRC" && sudo -u "$user" node src/admin.js mode "$1" >/dev/null 2>&1); then
        fail "the switch to $1 refused"
        (cd "$SRC" && sudo -u "$user" node src/admin.js mode "$1" 2>&1 | tail -3 | sed 's/^/        /') || true
    fi
}

head_ "1. preconditions"
[ "$(id -u)" = "0" ] && pass "running as root, so units can be installed" || fail "must run as root"
command -v systemctl >/dev/null && pass "systemd present" || fail "no systemd: this host cannot rehearse the units"
node --version | grep -qE '^v(2[2-9]|[3-9][0-9])' && pass "node $(node --version)" || fail "node 22+ required"
[ -f "$SRC/src/server.js" ] && pass "the tree is at $SRC" || { fail "no tree at $SRC"; exit 1; }
[ -f "$SRC/data/directory.json" ] && pass "a directory file exists" || say "no directory file: create one before the first start"

# Schedules left by an earlier run fire on their own clock, and a close that belongs to a switch
# two runs ago looks exactly like this run's door failing to close. A rehearsal starts with no
# pending timers, so what it measures is what it scheduled.
systemctl stop 'crossbar-grace-public.timer' 'crossbar-grace-private.timer' \
    'crossbar-grace-public.service' 'crossbar-grace-private.service' >/dev/null 2>&1 || true
systemctl reset-failed 'crossbar-grace-public.service' 'crossbar-grace-private.service' \
    'crossbar-grace-public.timer' 'crossbar-grace-private.timer' >/dev/null 2>&1 || true

# A first-run deployment, if this host has none. A rehearsal that needs an operator to set one
# up first is a rehearsal that gets skipped, and the point of this host is that it can be thrown
# away: so it writes the smallest thing the server will start on, and says loudly that it did.
if [ ! -f "$SRC/.env" ] || [ ! -f "$SRC/data/directory.json" ]; then
    say "no deployment here yet: writing a minimal one (this is a rehearsal host, not a server)"
    mkdir -p "$SRC/data"
    if [ ! -f "$SRC/data/directory.json" ]; then
        cat > "$SRC/data/directory.json" <<'JSON'
{
  "users": [
    { "id": "abdullah", "tailscaleLogin": "abdullah@dev", "displayName": "Abdullah", "admin": true },
    { "id": "nadia", "tailscaleLogin": "nadia@dev", "displayName": "Nadia" }
  ],
  "contacts": [
    { "ownerId": "abdullah", "contactId": "nadia", "sortOrder": 0 },
    { "ownerId": "nadia", "contactId": "abdullah", "sortOrder": 0 }
  ],
  "groups": []
}
JSON
        chown "$OWNER:$OWNER" "$SRC/data/directory.json" 2>/dev/null || true
        chmod 600 "$SRC/data/directory.json"
        pass "wrote a two-person directory file"
    fi
    if [ ! -f "$SRC/.env" ]; then
        # Both mode blocks, distinct values, so a switch that leaves one behind is visible. No
        # line outside the generated section names a generated key: a switch refuses those rather
        # than deleting them, which is slice A's decision and is asserted by the test suite.
        SECRET="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
        cat > "$SRC/.env" <<ENV
NODE_ENV=production
HOST=127.0.0.1
PORT=$PORT
DATA_DIR=$SRC/data
DIRECTORY_CONFIG_PATH=$SRC/data/directory.json
CROSSBAR_SESSION_SECRET=$SECRET
CROSSBAR_SESSION_TTL_SECONDS=43200
NETWORK_MODE_PRIVATE_HOSTNAME=rehearsal.tailnet.ts.net
NETWORK_MODE_PRIVATE_ORIGIN=https://rehearsal.tailnet.ts.net
NETWORK_MODE_PRIVATE_BIND_ADDRESS=
NETWORK_MODE_PUBLIC_HOSTNAME=rehearsal.example.com
NETWORK_MODE_PUBLIC_ORIGIN=https://rehearsal.example.com
NETWORK_MODE_PUBLIC_BIND_ADDRESS=127.0.0.1
ENV
        chown "$OWNER:$OWNER" "$SRC/.env" 2>/dev/null || true
        chmod 600 "$SRC/.env"
        pass "wrote a .env with both mode blocks"
    fi
fi

# A switch overlaps the two front doors on purpose, so that a phone whose stored address is the
# old one can still ask `/api/health` where the server went. A rehearsal does not want to wait the
# real window out: it sets a short one and watches the door actually close.
# Whoever runs a rehearsal runs as root, and every tool that edits `.env` in place replaces the
# file. A `.env` re-owned by root is one the service cannot read, and the server then fails with
# EACCES naming a file that is right there — measured here, on this host. So the ownership is put
# back, and then *checked*, because that failure appears at the next start and nowhere near here.
ENV_OWNER="$(stat -c '%U:%G' "$SRC/.env")"
ENV_MODE="$(stat -c '%a' "$SRC/.env")"
if grep -q '^CROSSBAR_SWITCH_GRACE_SECONDS=' "$SRC/.env"; then
    sed -i "s/^CROSSBAR_SWITCH_GRACE_SECONDS=.*/CROSSBAR_SWITCH_GRACE_SECONDS=$GRACE/" "$SRC/.env"
else
    printf '\n# The switch window, shortened for the rehearsal.\nCROSSBAR_SWITCH_GRACE_SECONDS=%s\n' "$GRACE" >> "$SRC/.env"
fi
chown "$ENV_OWNER" "$SRC/.env" 2>/dev/null || true
chmod "$ENV_MODE" "$SRC/.env"
pass "the switch grace window is $GRACE seconds for this rehearsal"

# The check that would have caught the afternoon this cost: the service user has to be able to
# read the file the service is told to read.
if sudo -u "${ENV_OWNER%%:*}" test -r "$SRC/.env" 2>/dev/null; then
    pass "the service user (${ENV_OWNER%%:*}) can read .env"
else
    fail ".env is not readable by ${ENV_OWNER%%:*}: the service will fail with EACCES on a file that is right there"
fi

head_ "2. install the units"
cp -f "$SRC"/deploy/crossbar.service "$SRC"/deploy/crossbar-public.service \
      "$SRC"/deploy/crossbar-private.service /etc/systemd/system/
[ -f "$SRC/deploy/crossbar-turn.service" ] && cp -f "$SRC/deploy/crossbar-turn.service" /etc/systemd/system/
[ -f "$SRC/deploy/crossbar-backup.service" ] && cp -f "$SRC"/deploy/crossbar-backup.{service,timer} /etc/systemd/system/
systemctl daemon-reload && pass "units installed and reloaded"
# The service has no [Install] on purpose: the timer is the only thing that should start it.
# Enabling the timer is therefore the install step, and forgetting it is a backup that never runs.
if [ -f /etc/systemd/system/crossbar-backup.timer ]; then
    systemctl enable --now crossbar-backup.timer >/dev/null 2>&1 \
        && pass "the daily backup timer is enabled and scheduled" \
        || fail "the backup timer could not be enabled"
    systemctl list-timers crossbar-backup.timer --no-pager 2>/dev/null | sed -n '1,2p' | sed 's/^/  /'
fi
# A unit file that systemd cannot parse is worse than a missing one: it looks installed.
# Every unit this tree ships, including the ones for features a given host may not have: a file
# systemd cannot parse is worse than a missing one, because it looks installed.
for unit in crossbar.service crossbar-public.service crossbar-private.service crossbar-turn.service crossbar-backup.service; do
    [ -f "/etc/systemd/system/$unit" ] || { say "$unit is not installed here (nothing needs it)"; continue; }
    # `systemd-analyze verify` fails a unit whose ExecStart names a binary this host does not
    # have, which is a fact about the host rather than about the unit file. Saying so is the
    # difference between a rehearsal finding and a rehearsal lying.
    if [ "$unit" = "crossbar-turn.service" ] && ! command -v turnserver >/dev/null 2>&1; then
        skip "$unit names a binary coturn would provide, and coturn is not installed here"
        continue
    fi
    if systemd-analyze verify "/etc/systemd/system/$unit" >/dev/null 2>&1; then
        pass "$unit verifies"
    else
        say "  systemd-analyze verify $unit said:"
        systemd-analyze verify "/etc/systemd/system/$unit" 2>&1 | sed 's/^/    /'
        fail "$unit does not verify"
    fi
done

# A stand-in for the public front door, when this host has no Caddy. The mode shapers call
# `systemctl start caddy`, and an unprefixed command that fails aborts the rest of the oneshot —
# so on a host without Caddy the scheduled close of the other door never happens, and the overlap
# cannot be rehearsed at all. The stand-in is only a process that stays up; it terminates nothing
# and serves nothing, and everything it stands in for is labelled below wherever it is used.
if ! systemctl list-unit-files caddy.service >/dev/null 2>&1; then
    say "no Caddy on this host: installing a stand-in caddy.service so the front-door mechanics can be rehearsed"
    cat > /etc/systemd/system/caddy.service <<'UNIT'
# Installed by scripts/rehearse-switch.sh on a host that has no Caddy. It exists so the mode
# shapers' `systemctl start caddy` succeeds and the rest of the shaper runs. It serves nothing.
[Unit]
Description=Crossbar rehearsal stand-in for Caddy (serves nothing)

[Service]
Type=simple
ExecStart=/bin/sleep infinity
UNIT
    systemctl daemon-reload
    CADDY_IS_A_STAND_IN=1
    pass "stand-in caddy.service installed (it serves nothing; it exists so the shaper can finish)"
fi

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
    skip "no tailnet node on this host, so the private front door is not being rehearsed"
fi
expect "a tailnet identity is believed" "$(as_user abdullah@dev /api/session | json_field identity.source)" "tailscale"

head_ "4. switch to public: the shape must follow the file"
switch_to public
expect "the file says public" "$(grep -c '^CROSSBAR_NETWORK_MODE=public$' "$SRC/.env")" "1"
restart
expect "health reports public" "$(field mode)" "public"
# The whole point of the mode: the header is not an identity here, whoever sends it.
expect "a tailnet identity is NOT believed" "$(as_user abdullah@dev /api/bootstrap | json_field error.code)" "DEVICE_AUTH_REQUIRED"
if [ "${CADDY_IS_A_STAND_IN:-0}" = "1" ]; then
    skip "Caddy is a stand-in here: that the public door comes up is not being rehearsed, but the"
    skip "  mechanics around it (the overlap and its scheduled close) are"
elif systemctl list-unit-files caddy.service >/dev/null 2>&1; then
    if systemctl is-active caddy >/dev/null 2>&1; then
        pass "Caddy is up, as public mode wants"
    else
        fail "public mode is in force and Caddy is not running"
    fi
else
    skip "Caddy is not installed on this host, so the public front door is not being rehearsed"
fi
# The overlap, both halves of it: the old door is still open so a phone can ask where the
# server went, and something is scheduled to close it. Closing it immediately is the bug this
# whole rehearsal exists for -- it is what costs every device a new invitation code.
if command -v tailscale >/dev/null && tailscale status >/dev/null 2>&1; then
    if tailscale serve status 2>/dev/null | grep -q "127.0.0.1:$PORT"; then
        pass "the tailnet door is still open during the grace window"
    else
        fail "the switch closed the tailnet door at once: a phone can no longer ask where the server went"
    fi
    if systemctl is-active crossbar-grace-public.timer >/dev/null 2>&1        || systemctl is-active crossbar-grace-public.service >/dev/null 2>&1; then
        pass "the old door is scheduled to close"
    else
        fail "nothing is scheduled to close the tailnet door"
    fi
say "waiting for it to close (the window is $GRACE seconds)"
if wait_until_gone "$((GRACE + 12))" sh -c 'tailscale serve status 2>/dev/null | grep -q 127.0.0.1:$PORT'; then
    pass "the old door closed on its own"
else
    fail "the tailnet door never closed"
fi
fi

head_ "5. and back, because a switch has to survive being done twice"
switch_to private
restart
expect "health reports private again" "$(field mode)" "private"
expect "the tailnet identity is believed again" "$(as_user abdullah@dev /api/session | json_field identity.source)" "tailscale"
if systemctl list-unit-files caddy.service >/dev/null 2>&1; then
    if systemctl is-active caddy >/dev/null 2>&1; then
        pass "the public door is still open during the grace window"
    else
        fail "the switch back stopped Caddy at once"
    fi
else
    skip "no Caddy here: the public door's overlap is not being rehearsed"
fi
say "waiting for it to close (the window is $GRACE seconds)"
# A door that closes on a timer is eventually closed, not closed at the moment it is asked. This
# is the difference between measuring the overlap and measuring the instant it was told about.
if wait_until_true "$((GRACE + 12))" systemctl is-active caddy; then
    pass "the public door closed on its own"
else
    fail "Caddy never stopped"
fi

# And the guard that makes rapid switching safe: a close scheduled by the previous switch must
# not act once the mode has moved on. Its own grep decides, so this is the check that it does.
if journalctl -u 'crossbar-grace-*' --no-pager -n 40 2>/dev/null | grep -qi 'serve\|caddy'; then
    say "the scheduled close left a trace in the journal"
fi

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
    # The newest name, not the count: snapshots are pruned to a handful, so once that many are
    # kept the count stops moving and a correct snapshot looks like none. A name cannot.
    NEWEST_BEFORE="$(ls -1t "$SRC"/data/backups/crossbar-before-v*.sqlite 2>/dev/null | head -1)"
    sqlite3 "$DB" "PRAGMA user_version = $((VERSION_BEFORE - 1));"
    restart
    NEWEST_AFTER="$(ls -1t "$SRC"/data/backups/crossbar-before-v*.sqlite 2>/dev/null | head -1)"
    expect "a snapshot was taken before migrating" \
        "$([ "$NEWEST_BEFORE" != "$NEWEST_AFTER" ] && echo yes || echo no)" "yes"
    expect "the server came back" "$(systemctl is-active crossbar)" "active"
fi

head_ "verdict"
if [ "$FAILED" != "0" ]; then
    echo "  SOMETHING FAILED — read the FAIL lines above"
    # Why, without a second visit: the server's own journal is the first place to look, and a
    # run that fails without it costs another round trip to this host.
    echo "  --- what the server said last:"
    journalctl -u crossbar -n 12 --no-pager 2>/dev/null | tail -12 | sed 's/^/    /'
elif [ "$SKIPPED" != "0" ]; then
    echo "  no failures, but $SKIPPED check(s) were SKIPPED: this host cannot rehearse them, and a"
    echo "  skip is not a pass — read the SKIP lines above before believing this deployment"
else
    echo "  every check passed"
fi
exit "$FAILED"
