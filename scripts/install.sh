#!/usr/bin/env bash
#
# Install a Crossbar deployment on this host.
#
# This is `deploy/README.md` §2.2–§2.6 as one command. What it does, in order:
#
#   1. the account (§2.1), the deployment directory, and the code — the checkout it lives in, or
#      `--source` copied to `--prefix`;
#   2. the data directory, and the `.env` the server reads (seeded from `.env.example` and left
#      for a person to fill in);
#   3. **the directory file**, which it refuses to continue without — the server will not start
#      without one, and an install that finishes "successfully" over a missing directory file is
#      a service that crash-loops for a reason the operator has to go and find;
#   4. `npm ci --omit=dev` in the deployment's own account;
#   5. the units, rendered for this host's paths and installed, `daemon-reload`, the service
#      enabled and started, and the backup **timer** enabled — the backup service has no
#      `[Install]` on purpose, so enabling the timer *is* the install step and forgetting it is a
#      backup that never runs;
#   6. `/api/health`, so "installed" means "answering" rather than "the files are in /etc".
#
# It runs as root on a host with systemd, and refuses rather than half-installing. On a host
# without systemd — a Mac, a container — it says so and stops: an install that reports success and
# leaves no service running is the worst outcome, because it looks like a working deployment until
# the first reboot.
#
# Usage:
#   sudo scripts/install.sh [--prefix DIR] [--user NAME] [--source DIR] [--with-relay] [--dry-run]
#
#   --prefix DIR   where the deployment runs        (env CROSSBAR_HOME, default /home/admin/crossbar)
#   --user NAME    the account that runs it         (env CROSSBAR_USER, default admin)
#   --source DIR   the tree to install from         (default: the checkout this script is in)
#   --with-relay   install the coturn relay unit even if it is not obvious this host relays
#   --dry-run      print every command and change nothing
#
# Idempotent: every step either already holds or is re-applied, so a second run is how a unit that
# was edited by hand gets put back, and how a host that failed at §3 above is finished after the
# file is written.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/deploy.sh
. "$SCRIPT_DIR/lib/deploy.sh"

DRY_RUN=0
PREFIX="${CROSSBAR_HOME:-/home/admin/crossbar}"
CROSSBAR_USER="${CROSSBAR_USER:-admin}"
SOURCE="$(cd "$SCRIPT_DIR/.." && pwd)"
WITH_RELAY=''

usage() {
    usage_from "$0"
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --prefix) [ "$#" -ge 2 ] || die '--prefix needs a directory'; PREFIX="$2"; shift 2 ;;
        --user)   [ "$#" -ge 2 ] || die '--user needs an account name'; CROSSBAR_USER="$2"; shift 2 ;;
        --source) [ "$#" -ge 2 ] || die '--source needs a directory'; [ -d "$2" ] || die "--source $2 is not a directory"; SOURCE="$(cd "$2" && pwd)"; shift 2 ;;
        --with-relay) WITH_RELAY=1; shift ;;
        --dry-run) DRY_RUN=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) die "unknown argument: $1 (try --help)" ;;
    esac
done

# The two values that end up inside a unit file, refused unless they are shaped like what they are
# (§`require_path` in the library). Checked before anything runs, so a typo costs nothing.
require_path 'prefix' "$PREFIX"
require_account_name "$CROSSBAR_USER"

step 'preconditions'
if [ ! -d "$SOURCE" ]; then
    die "--source $SOURCE is not a directory"
fi
if [ ! -f "$SOURCE/src/server.js" ]; then
    die "there is no Crossbar tree at $SOURCE (no src/server.js): --source points at a checkout or an unpacked release, not at a deployment"
fi
resolve_node
say "source:  $SOURCE"
say "prefix:  $PREFIX"
say "account: $CROSSBAR_USER"
say "node:    $NODE_BIN  ($NODE_VERSION)"
if [ "$DRY_RUN" = '1' ]; then
    say 'dry run: every command below is printed and none is executed, and nothing is refused for'
    say '         being missing — a real run stops at the directory file and at a missing systemd.'
else
    # The host's own capability first, then the privilege: on a machine without systemd the
    # operator cannot fix it by trying again with sudo, and being told "run as root" there sends
    # them round the wrong loop.
    require_systemd
    require_root
    require_command curl 'the health check at the end is what makes "installed" mean "answering"'
    require_command runuser "the deployment's own account has to own what this installs"
fi

# ── 1. The account ──────────────────────────────────────────────────────────────
step 'the account'
if id -u "$CROSSBAR_USER" >/dev/null 2>&1; then
    say "the account $CROSSBAR_USER already exists"
else
    # `--user-group` for a group of the account's own name, because the units say
    # `Group=<account>`: a distribution whose `useradd` does not make one (Debian's does, by
    # USERGROUPS_ENAB) would install a unit naming a group that does not exist, and systemd
    # refuses that at start — an install that looks finished and never runs.
    run useradd --create-home --shell /bin/bash --user-group "$CROSSBAR_USER"
fi
if [ "$DRY_RUN" != '1' ] && command -v getent >/dev/null 2>&1; then
    if ! getent group "$CROSSBAR_USER" >/dev/null; then
        die "there is no group named $CROSSBAR_USER, and every unit says Group=$CROSSBAR_USER; systemd refuses a unit whose group does not resolve. Create it (groupadd $CROSSBAR_USER) or pass --user with an account that already has a group of its own name. Nothing was changed."
    fi
fi

# ── 2. The deployment directory ─────────────────────────────────────────────────
# The code, and only the code, when the source is somewhere else. The same polarity `.gitignore`
# draws for `data/`: the database, the directory file with its logins, the backups and this host's
# `.env` are never carried from a source tree, and neither are its installed dependencies or git's
# own directory.
#
# Two steps through a temporary archive rather than one `tar | tar`, so a dry run prints the
# exclusion list as two real argv — the exclusions are the part of this step worth reading.
copy_code() { # copy_code <from> <to>
    local archive
    archive="$(mktemp)"
    run tar -C "$1" -cf "$archive" \
        --exclude=./node_modules --exclude=./.git --exclude=./.env --exclude=./data \
        --exclude='*.log' --exclude=./.DS_Store .
    run tar -C "$2" -xf "$archive"
    rm -f "$archive"
}

step 'the deployment directory'
if [ "$SOURCE" = "$PREFIX" ]; then
    say "installing in place: the tree is already at $PREFIX, so nothing is copied"
else
    run install -d -o "$CROSSBAR_USER" -g "$CROSSBAR_USER" -m 0755 "$PREFIX"
    copy_code "$SOURCE" "$PREFIX"
    # A just-copied tree is root's; it has to be the account's. The service runs as that account,
    # the backup unit writes `data/` as it, and the next `npm ci` an operator runs from the
    # checkout has to be able to replace `node_modules/` — which a root-owned one is not, for
    # anybody else.
    run chown -R "$CROSSBAR_USER:$CROSSBAR_USER" "$PREFIX"
fi

# ── 3. The data directory, and the file the server reads ────────────────────────
# Created only when it is missing, so a second run does not reset the mode of a directory the
# operator has deliberately changed. 0700 because it holds the database, the directory file's
# logins, and the backups, which are a copy of both.
step 'the data directory'
if [ -d "$PREFIX/data" ]; then
    say "already there: $PREFIX/data"
else
    run install -d -o "$CROSSBAR_USER" -g "$CROSSBAR_USER" -m 0700 "$PREFIX/data"
fi

step 'the configuration file'
if [ -f "$PREFIX/.env" ]; then
    say "keeping the .env that is already there"
else
    if [ ! -f "$SOURCE/.env.example" ]; then
        die "there is no $PREFIX/.env and no $SOURCE/.env.example to start one from: copy the template into place yourself (deploy/README.md §2.3), then run this again"
    fi
    run install -o "$CROSSBAR_USER" -g "$CROSSBAR_USER" -m 0600 "$SOURCE/.env.example" "$PREFIX/.env"
    say 'seeded .env from .env.example. It is a template: HOST/PORT, DATA_DIR, DIRECTORY_CONFIG_PATH,'
    say 'CROSSBAR_SESSION_SECRET and one block per mode have to be filled in before this is useful'
    say '(deploy/README.md §2.3).'
fi

# The two paths the server will read, from the file the server will read. `deployment_port` and
# `env_value` in the library take the *last* assignment, which is the one systemd's
# `EnvironmentFile=` gives the service, so this cannot disagree with what will actually run.
DATA_DIR_SETTING="$(env_value DATA_DIR || true)"
DIRECTORY_PATH="$(env_value DIRECTORY_CONFIG_PATH || true)"
DATA_DIR_SETTING="${DATA_DIR_SETTING:-$PREFIX/data}"
DIRECTORY_PATH="${DIRECTORY_PATH:-$DATA_DIR_SETTING/directory.json}"
say "data directory: $DATA_DIR_SETTING"
say "directory file: $DIRECTORY_PATH"

# The units name `<prefix>/data` in `ReadWritePaths=`, and that is the only place the service may
# write. A `DATA_DIR` somewhere else is not something this script can fix: the server would run,
# and then the console's settings writes and the backup would fail with EROFS — the exact class of
# silent-looking failure the hardened units exist to avoid. Said here, loudly, rather than
# discovered later.
if [ "$DATA_DIR_SETTING" != "$PREFIX/data" ]; then
    warn "DATA_DIR is $DATA_DIR_SETTING, but the units allow the service to write $PREFIX/data only"
    warn "(ReadWritePaths=). Either set DATA_DIR back, or render the units by hand. The server will"
    warn 'start either way; the console and the backup are what will fail.'
fi

# A `.env` or a `data/` that root created is one the service account cannot rewrite — settings
# saved from the console fail with EROFS, and the backup fails on its own `data/backups` directory.
# Reported with the fix rather than fixed silently: these are files an operator may have placed
# deliberately, and this install's job is to say what the service needs.
if [ "$DRY_RUN" != '1' ]; then
    for path in "$PREFIX/.env" "$PREFIX/data"; do
        if [ -e "$path" ] && [ "$(owner_of "$path")" != "$CROSSBAR_USER" ]; then
            warn "$path belongs to $(owner_of "$path"), not $CROSSBAR_USER: the service will read it and"
            warn "fail to write it. Fix with: chown -R $CROSSBAR_USER:$CROSSBAR_USER $path"
        fi
    done
fi

# ── 4. The directory file: refuse, loudly, and say exactly what to write ────────
# The refusal lives in a function so that a dry run prints the message a real run would give,
# word for word, rather than a summary of it. That matters on a workstation, which is where
# somebody plans an install before they have the host: the fix is a file they have to write, and
# the plan should be where they read what goes in it.
refuse_missing_directory_file() {
    cat >&2 <<EOF

!! There is no directory file at
     $DIRECTORY_PATH
   and the server refuses to start without one, so this install stops here rather than
   installing a service that cannot come up.

   Write one, then run this installer again:

       cp $SOURCE/data/directory.example.json $DIRECTORY_PATH
       chmod 600 $DIRECTORY_PATH
       \$EDITOR $DIRECTORY_PATH

   It is JSON with a \`users\` array: at least one person, at least one of them \`"admin": true\`.
   The smallest file the server will start on:

       { "users": [ { "id": "you", "displayName": "You", "admin": true } ] }

   In private mode a person is found by their tailnet login, so add
   \`"tailscaleLogin": "you@example.ts.net"\` to each one; in public mode a device key identifies
   the caller and a login is a record of who somebody is elsewhere. The whole shape, and the
   other two refusals (no people, no administrator who is not suspended), are in
   deploy/README.md §2.4.

   Nothing was installed: no unit was written and no service was enabled. What is already at
   $PREFIX (the account, the data directory, \`.env\`) is left as it is and is safe to keep.
EOF
}

step 'the directory file'
if [ -f "$DIRECTORY_PATH" ]; then
    say "a directory file is in place: $DIRECTORY_PATH"
elif [ "$DRY_RUN" = '1' ]; then
    say 'a real run stops here, with this (and installs no unit):'
    refuse_missing_directory_file
    say ''
else
    refuse_missing_directory_file
    exit 1
fi

# ── 5. Dependencies ─────────────────────────────────────────────────────────────
# `--prefix` so the printed command is the one that runs: `npm ci` deletes `node_modules` and
# rebuilds it from `package-lock.json`, which is the only way to get the tree the artefact was
# tested with. It needs the registry or a warm npm cache; there is no build step and `node:sqlite`
# is Node's own, so nothing else about the install needs the network.
#
# As the deployment's account rather than as root, so the tree it writes belongs to the account
# that has to replace it next time.
step 'dependencies'
run_as_user "$NPM_BIN" ci --prefix "$PREFIX" --omit=dev --no-audit --no-fund

# ── 6. The units ────────────────────────────────────────────────────────────────
# Rendered for this host's prefix, account and node binary (§`render_unit` in the library) and
# never edited in the repository: the repository's copies stay a working example of a default
# deployment, and the file systemd reads is the file a person can read back from /etc.
step 'the units'
TO_INSTALL="$UNIT_NAMES_CORE $UNIT_NAMES_BACKUP"
if [ -n "$WITH_RELAY" ] || relay_is_present; then
    TO_INSTALL="$TO_INSTALL $UNIT_NAMES_RELAY"
    say 'coturn is on this host, so the relay unit is part of this install (deploy/README.md §2.9)'
else
    say 'no turnserver on this host, so crossbar-turn.service is not installed (deploy/README.md §2.9)'
fi
# Which tree the units are read from. The deployment's own, once it is there — that is the tree
# that will run. In a dry run nothing has been copied, so the source's copies are what the copy
# would have put there: the same files, rendered for the same host.
UNIT_SOURCE="$PREFIX/deploy"
if [ ! -d "$UNIT_SOURCE" ]; then
    UNIT_SOURCE="$SOURCE/deploy"
    say "rendering from $UNIT_SOURCE (a dry run has copied nothing into $PREFIX)"
fi
# Unquoted on purpose: this is the list, and bash 3.2 has no arrays.
# shellcheck disable=SC2086
if ! install_units "$UNIT_SOURCE" $TO_INSTALL; then
    die "no unit was installed and no service was enabled: see the message above. Nothing else was changed."
fi
if [ -n "$WITH_RELAY" ] || relay_is_present; then
    run install -D -m 0644 "$UNIT_SOURCE/coturn.conf" /etc/crossbar/coturn.conf
    # The package's own unit would race this one for the same ports and whichever loses looks like
    # the one that does not work. `crossbar-turn.service` also `Conflicts=` it, so this is about
    # what starts at boot rather than about the run itself — and a host whose coturn came from
    # somewhere without a unit is not a reason to stop the install.
    if ! run systemctl disable --now coturn; then
        warn "could not disable the package's coturn unit; it may not exist on this host."
        warn 'crossbar-turn.service Conflicts= with it, so it will not run beside the relay either way.'
    fi
fi

# ── 7. Enable, and start ────────────────────────────────────────────────────────
step 'enable, and start'
# Enable without `--now`: the start is the `restart` below, which is one code path whether this is
# a first install or a second run over a running deployment.
run systemctl enable crossbar
# The timer, not the service: `crossbar-backup.service` has no `[Install]` on purpose — enabling it
# would run one backup at boot — and the timer is the only thing that schedules it. This line is
# the difference between a daily backup and none.
run systemctl enable --now crossbar-backup.timer
# `restart`, not `start`: a second run over a running deployment has to re-apply the mode's shape,
# and the two shaping units are oneshots that only run as part of starting the server.
run systemctl restart crossbar

if [ "$DRY_RUN" = '1' ]; then
    HEALTH_NOTE='until it answers, up to 30s'
    if [ ! -f "$PREFIX/.env" ]; then
        HEALTH_NOTE="$HEALTH_NOTE; a dry run has written no .env, so the 3003 default is shown"
    fi
    would_run "curl -fsS http://127.0.0.1:$(deployment_port)/api/health   ($HEALTH_NOTE)"
else
    if ! HEALTH="$(wait_for_health 30)"; then
        die "the units are installed and enabled, but the server has not answered /api/health after 30 seconds — which is not an install. Look at: journalctl -u crossbar -n 50 --no-pager, then systemctl status crossbar. Nothing was removed."
    fi
    say "health: $HEALTH"
    say "version: $(json_field "$HEALTH" version)   mode: $(json_field "$HEALTH" mode)   origin: $(json_field "$HEALTH" origin)"
fi

# ── 8. What is left for a person ────────────────────────────────────────────────
step 'next steps'
say "  cd $PREFIX"
say "  sudo -u $CROSSBAR_USER node src/admin.js mode       # which mode the file is in, and that it loads"
say "  sudo -u $CROSSBAR_USER node src/admin.js status     # the running configuration and the counts"
say "  sudo -u $CROSSBAR_USER node src/admin.js doctor     # every line OK before anybody is invited"
say "  sudo -u $CROSSBAR_USER node src/admin.js password   # the console's password, at /admin"
say "  sudo -u $CROSSBAR_USER node src/admin.js enroll --user <login>   # one invitation, printed once"
say ''
say '  journalctl -u crossbar -f                            # what it is saying'
say '  systemctl list-timers crossbar-backup.timer          # the daily backup, and when it next runs'
say '  systemctl status crossbar crossbar-backup.timer'
say ''
say 'Public mode also needs Caddy: the drop-in that gives it this .env, the Caddyfile, DNS, the'
say 'port forwards and the firewall — all of it in deploy/README.md §2.8, and the host facts the'
say 'software cannot see in §8. The relay is §2.9.'
exit 0
