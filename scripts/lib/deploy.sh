#!/usr/bin/env bash
#
# Shared plumbing for the deployment scripts — `install.sh`, `release.sh`, `upgrade.sh`,
# `uninstall.sh`.
#
# Sourced, never run. Each script sets `DRY_RUN`, `PREFIX`, `CROSSBAR_USER` and `NODE_BIN` and
# then uses what is below. Read this file first when one of those scripts seems to be doing
# something its own text does not say.
#
# What lives here rather than in one script, and why:
#
#   * Rendering the unit files. `install.sh` and `upgrade.sh` both put units into
#     `/etc/systemd/system`, and the one thing that must not differ between them is what a unit
#     says the deployment's paths are: a tree installed one way and upgraded another is a service
#     reading a different `.env` from the one its operator edits. So the rewrite is defined once,
#     against the literal paths the files in `deploy/` are written with.
#   * `run`, which prints a step before it happens, dry run or not. A dry run's transcript *is*
#     the deliverable; a real run's transcript is what the operator has when it went wrong.
#
# Written against bash 3.2 on purpose: the tarball is built on a Mac and installed on Debian, and
# both machines have to be able to read these scripts. No arrays, no `${var,,}`, no `local -n`.
#
# The transcript convention: `say`/`step` for prose, `$ ` for a command that will run, `~ ` for
# something that is a loop or a probe rather than one command, `!!` for a refusal.

# ── Output ──────────────────────────────────────────────────────────────────────
say()  { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
warn() { printf '  !! %s\n' "$*" >&2; }

# A refusal, not an error to be caught: every caller either installs the whole deployment or
# changes nothing, and a message that says what was not done is the only useful outcome.
die() {
    printf '\n!! %s\n' "$*" >&2
    exit 1
}

# ── Running things ──────────────────────────────────────────────────────────────
# Every command goes through here. Printed first and unconditionally, so `--dry-run` is the same
# transcript with the execution removed rather than a second, drifting description of it.
run() {
    printf '  $ %s\n' "$*"
    if [ "$DRY_RUN" = '1' ]; then
        return 0
    fi
    "$@"
}

# For a step that is a pipeline or needs a shell: a string, because a pipeline is not an argv.
# Only ever given paths that `require_path` has already narrowed to letters, digits and `/._-`,
# so there is nothing here for the shell to interpret.
run_pipe() {
    printf '  $ %s\n' "$1"
    if [ "$DRY_RUN" = '1' ]; then
        return 0
    fi
    /bin/sh -c "$1"
}

# A step whose shape is a loop or a probe rather than one command — waiting for health, reading
# one field out of an answer. Printed so the dry run does not go silent exactly where the
# interesting part of the script is.
would_run() {
    printf '  ~ %s\n' "$*"
}

# Run a command as the deployment's own account. Everything this phase installs has to belong to
# that account rather than to root: the service runs as it, the backup unit writes `data/` as it,
# and the next `npm ci` an operator runs from the checkout has to be able to replace a
# `node_modules/` that root owns — which, for a non-root account, it cannot.
#
# The comparison is against the name rather than against "am I root": a dry run on a workstation
# as the same account should read like the command an operator will actually type, and root
# running this for an account that happens to also be named root needs no `runuser` either.
run_as_user() {
    if [ "$CROSSBAR_USER" != "$(id -un 2>/dev/null || true)" ]; then
        run runuser -u "$CROSSBAR_USER" -- "$@"
    else
        run "$@"
    fi
}

# The owner of a path. GNU `stat` first, BSD `stat` second — the one place in these scripts that
# differs by operating system, and both forms exist on both hosts involved (a Mac builds the
# tarball, Debian runs it).
owner_of() {
    stat -c '%U' "$1" 2>/dev/null || stat -f '%Su' "$1" 2>/dev/null || printf '%s' '(unknown)'
}

# ── Refusing bad input early ────────────────────────────────────────────────────
# The usage text for `--help`: everything between the shebang and the first line of code, so the
# header a maintainer reads and what `--help` prints cannot drift apart.
usage_from() { # usage_from <script>
    sed -n '2,/^set -euo pipefail$/p' "$1" | sed -e 's/^# \{0,1\}//' -e '/^set -euo pipefail$/d'
}

# A unit file has no quoting for a path or an account name: a space in `--prefix` makes systemd
# read `WorkingDirectory=/home/a b` as two arguments, and a `&` means "the whole match" to `sed`,
# which would render a path nobody asked for. Refusing here is the difference between an install
# that stops and one that writes units that cannot start — which is the failure that looks
# installed.
require_path() { # require_path <what> <value>
    case "$2" in
        /*) ;;
        *) die "$1 must be an absolute path, not '$2'" ;;
    esac
    case "$2" in
        *[!A-Za-z0-9/._-]*) die "$1 may contain only letters, digits, '/', '.', '_' and '-', not '$2': a unit file cannot quote a path" ;;
    esac
}

require_account_name() { # require_account_name <value>
    case "$1" in
        ''|[!a-z_]*|*[!a-z0-9_-]*) die "an account name starts with a lowercase letter or '_' and holds only lowercase letters, digits, '_' and '-', not '$1'" ;;
    esac
    if [ "${#1}" -gt 32 ]; then
        die "the account name '$1' is longer than 32 characters, which is more than Linux will create"
    fi
}

require_command() { # require_command <name> <why>
    if ! command -v "$1" >/dev/null 2>&1; then
        die "no $1 on PATH, and $2"
    fi
}

require_root() {
    if [ "$(id -u)" != '0' ]; then
        die 'run this as root: it creates an account, owns the deployment directory, and writes /etc/systemd/system'
    fi
}

# systemd, not merely `systemctl`. A container or a chroot has the binary and no init, and there
# the install gets as far as putting units on disk and fails on `daemon-reload` — leaving files
# that look installed on a host that will never start them. `/run/systemd/system` is the
# directory systemd itself creates, so its absence is the fact, not an inference.
require_systemd() {
    if ! command -v systemctl >/dev/null 2>&1; then
        die 'no systemctl on PATH, so this host has no systemd — and Crossbar is installed as systemd units. Nothing was changed. (A Mac has no systemd at all: the install happens on the Linux host.)'
    fi
    if [ ! -d /run/systemd/system ]; then
        die 'systemctl is present but systemd is not running (no /run/systemd/system): this is a container or a chroot, and its units would never start. Nothing was changed.'
    fi
}

# ── Node, npm, and the version floor ────────────────────────────────────────────
# 22.5.0 is not a preference: the server uses `node:sqlite` (`DatabaseSync`, `VACUUM INTO`), which
# does not exist in anything older, so a host below the floor installs cleanly and then crash-loops
# under `Restart=always`. Checked here rather than discovered from the journal, because the
# journal is read after the deployment is already down.
NODE_FLOOR='22.5.0'

# Sets NODE_BIN / NODE_VERSION / NPM_BIN. In a dry run a missing Node is a warning and the units'
# own `/usr/bin/node` is used instead, so the plan can still be printed on a machine that is not
# the deployment host.
resolve_node() {
    local found=''
    found="$(command -v node 2>/dev/null || true)"
    if [ -z "$found" ]; then
        if [ "$DRY_RUN" = '1' ]; then
            NODE_BIN="$UNIT_NODE"
            NODE_VERSION="(not installed; the plan keeps the units' own $UNIT_NODE)"
            NPM_BIN='npm'
            warn "no node on PATH: the plan below keeps the units' own $UNIT_NODE"
            return 0
        fi
        die "no node on PATH. Crossbar needs Node $NODE_FLOOR or newer — the server uses node:sqlite, which older Node does not have — so install Node and run this again."
    fi
    NODE_BIN="$found"
    NODE_VERSION="$("$NODE_BIN" -p 'process.versions.node' 2>/dev/null || true)"
    if [ -z "$NODE_VERSION" ]; then
        die "$NODE_BIN did not answer with a version: it is not a working node"
    fi
    # `sort -V -C` is an ordering test rather than a comparison: two lines in version order, and
    # it exits non-zero when they are not. 22.10.0 beats 22.5.0 here, which a string compare gets
    # wrong and, on a version that moves every six weeks, wrong in the direction of a crash loop.
    if ! printf '%s\n' "$NODE_FLOOR" "$NODE_VERSION" | sort -V -C 2>/dev/null; then
        die "node $NODE_VERSION at $NODE_BIN is older than $NODE_FLOOR, the floor for node:sqlite"
    fi
    NPM_BIN="$(command -v npm 2>/dev/null || true)"
    if [ -z "$NPM_BIN" ]; then
        NPM_BIN="$(dirname "$NODE_BIN")/npm"
        if [ "$DRY_RUN" != '1' ] && [ ! -x "$NPM_BIN" ]; then
            die "no npm beside $NODE_BIN and none on PATH: dependencies cannot be installed"
        fi
    fi
}

# ── Reading the deployment's own file ───────────────────────────────────────────
# The version in a package.json, read with node when there is one and with `sed` when there is
# not, so a plan can be printed on a machine that is not the deployment host. This is the same
# file the server reads its own version from (`require('../package.json').version`, which is what
# `/api/health` answers with), so a tarball's name, npm's idea of this release and what a
# deployment reports after upgrading are three names for one thing.
package_version() { # package_version <package.json>
    local value=''
    if [ -n "${NODE_BIN:-}" ] && [ -x "${NODE_BIN:-/nonexistent}" ]; then
        value="$("$NODE_BIN" -p "require('$1').version" 2>/dev/null || true)"
    fi
    if [ -z "$value" ]; then
        value="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | tail -n 1)"
    fi
    printf '%s' "$value"
}

# The last assignment of a name, because that is the one systemd's `EnvironmentFile=` gives the
# service: an earlier line is not the value in force. Quotes are stripped one layer deep, which is
# all the server's own writers ever make (`src/config.js` writes bare values); anything more
# elaborate than that is not something this script should be guessing at.
env_value() { # env_value <NAME>
    if [ ! -f "$PREFIX/.env" ]; then
        return 0
    fi
    sed -n "s/^[[:space:]]*$1=//p" "$PREFIX/.env" | sed 's/^"\(.*\)"$/\1/' | tail -n 1
}

# The port the listener is on, from the file the listener reads. Hard-coding 3003 would make a
# deployment that sets `PORT` look unhealthy to the check whose whole job is to prove it healthy;
# 3003 is only the fallback, the same one `src/config.js`, `deploy/Caddyfile` and the private unit
# all use.
deployment_port() {
    local value=''
    value="$(env_value PORT || true)"
    printf '%s' "${value:-3003}"
}

# The loopback listener the units force (`HOST must remain loopback-only`), so this is the server
# itself and not a proxy that happens to be up. 30 tries of one second: a cold start creates and
# migrates the database before it listens, and a migration is not instant.
wait_for_health() { # wait_for_health [tries]
    local tries="${1:-30}" i=0 body=''
    while [ "$i" -lt "$tries" ]; do
        body="$(curl -fsS --max-time 3 "http://127.0.0.1:$(deployment_port)/api/health" 2>/dev/null || true)"
        if [ -n "$body" ]; then
            printf '%s' "$body"
            return 0
        fi
        i=$((i + 1))
        sleep 1
    done
    return 1
}

# One field out of a JSON answer. `node` rather than `sed`, because the answer is JSON and an
# expression that meets a space after the colon reads the wrong thing — and this is the value an
# upgrade's verdict rests on. A missing field is empty, not an error: the contract in
# `deploy/README.md` §3.5 is additive.
json_field() { # json_field <json> <field>
    "$NODE_BIN" -e 'const value = JSON.parse(process.argv[1])[process.argv[2]]; process.stdout.write(value === undefined || value === null ? "" : String(value));' "$1" "$2" 2>/dev/null || true
}

# ── The unit files ──────────────────────────────────────────────────────────────
# The literals the files in `deploy/` are written with. Substitution is anchored to these, so
# installing at the default path is a no-op rather than a special case, and a unit that was
# already rendered once is not rewritten a second time into something else.
UNIT_PREFIX='/home/admin/crossbar'
UNIT_USER='admin'
UNIT_NODE='/usr/bin/node'

UNIT_NAMES_CORE='crossbar.service crossbar-public.service crossbar-private.service'
UNIT_NAMES_BACKUP='crossbar-backup.service crossbar-backup.timer'
UNIT_NAMES_RELAY='crossbar-turn.service'

# Whether this host relays media, which is the only question that decides if the coturn unit is
# part of the install. `turnserver` on PATH is the same fact `deploy/README.md` §2.9 states as
# `apt install coturn`: without the package there is no relay to run, and installing the unit
# anyway leaves a failed unit for the operator to notice and reason about.
relay_is_present() {
    command -v turnserver >/dev/null 2>&1
}

# Render one unit for this deployment.
#
# The files in `deploy/` are written with production's literal paths — `/home/admin/crossbar`,
# `User=admin`, `/usr/bin/node` — and are rewritten here rather than kept as templates beside the
# originals. Deliberate: the file a person reads, reviews and diffs is the file systemd reads, so
# there is no second form to drift, and the copy in the repository stays a working example of a
# default deployment instead of a form that is valid nowhere.
#
# `|` as the `sed` delimiter because the substitution is a path and every path has `/` in it.
# `^User=admin$` is anchored so it cannot touch the prose in a comment that mentions the name.
render_unit() { # render_unit <source> <target>
    sed -e "s|$UNIT_PREFIX|$PREFIX|g" \
        -e "s|^User=$UNIT_USER\$|User=$CROSSBAR_USER|" \
        -e "s|^Group=$UNIT_USER\$|Group=$CROSSBAR_USER|" \
        -e "s|$UNIT_NODE|$NODE_BIN|g" \
        "$1" > "$2"
}

# What changed, and only that. A reader of `--dry-run` should be able to check the substitution
# without opening two files — `diff`'s own exit status is 1 when there are differences, which is
# here the expected case, so it is swallowed.
preview_unit() { # preview_unit <original> <rendered>
    diff -u "$1" "$2" | sed 's/^/       /' || true
}

# Install the given units, rendered, and reload systemd afterwards.
#
# One staging directory and one `install -m 0644` per unit, rather than `sed > /etc/systemd/…`:
# a unit file that can only be half-read is worse than a missing one, because it looks installed,
# and the mode is then a thing this file states rather than a thing the umask decides.
#
# A missing unit file returns non-zero rather than refusing outright, because the two callers have
# different work to do about it: `install.sh` has installed nothing yet and stops, while
# `upgrade.sh` has already swapped the trees and has to put the previous ones back. A set that is
# missing one file is not a release — the check is here, before any of them is written, so the
# install cannot be half-done.
#
# `daemon-reload` belongs to this function and not to its callers: without it `crossbar.service`'s
# `Wants=crossbar-public.service crossbar-private.service` is not live and neither shaping unit
# ever runs — the box looks configured and has no front door. Not a step to remember.
install_units() { # install_units <unit-dir> <unit>...
    local src="$1"
    shift
    local tmp unit
    for unit in "$@"; do
        if [ ! -f "$src/$unit" ]; then
            warn "$src/$unit is missing: refusing to install the rest of the set without it"
            return 1
        fi
    done
    tmp="$(mktemp -d)"
    for unit in "$@"; do
        render_unit "$src/$unit" "$tmp/$unit"
        if [ "$DRY_RUN" = '1' ]; then
            if cmp -s "$src/$unit" "$tmp/$unit"; then
                say "  (no change for this host: $unit)"
            else
                say "  (rendered for this host: $unit)"
                preview_unit "$src/$unit" "$tmp/$unit"
            fi
        fi
        run install -m 0644 "$tmp/$unit" "/etc/systemd/system/$unit"
    done
    rm -rf "$tmp"
    run systemctl daemon-reload
}
