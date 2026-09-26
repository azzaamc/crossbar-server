#!/usr/bin/env bash
#
# Remove a Crossbar deployment's systemd units — and nothing else unless asked.
#
# Usage:
#   sudo scripts/uninstall.sh [--prefix DIR] [--user NAME] [--purge-data] [--dry-run]
#
#   --prefix DIR   where the deployment is       (env CROSSBAR_HOME, default /home/admin/crossbar)
#   --user NAME    the account it ran as         (env CROSSBAR_USER, default admin)
#   --purge-data   also delete the data directory and `.env`. Nothing else ever deletes them.
#   --dry-run      print every command and change nothing
#
# What it removes: the units, and the relay's rendered template when that unit was installed.
#
# What it does not remove, and says so at the end: the checkout, `.env`, and `data/` — the
# database, the directory file and the backups. Those are the deployment's data, and the only two
# things in it that cannot be reconstructed; an uninstall that deleted them by default would be an
# uninstall nobody could run to re-install. `--purge-data` is the explicit version of it, and it
# names what it is about to delete before it deletes anything.
#
# The checkout itself is left even under `--purge-data`: it is a git tree somebody may have edits
# in, this script did not create it, and `rm -rf` of a directory that is not this script's is how a
# convenience becomes a story. The last line tells the operator it is theirs to delete.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/deploy.sh
. "$SCRIPT_DIR/lib/deploy.sh"

DRY_RUN=0
PREFIX="${CROSSBAR_HOME:-/home/admin/crossbar}"
CROSSBAR_USER="${CROSSBAR_USER:-admin}"
PURGE=0

while [ "$#" -gt 0 ]; do
    case "$1" in
        --prefix) [ "$#" -ge 2 ] || die '--prefix needs a directory'; PREFIX="$2"; shift 2 ;;
        --user) [ "$#" -ge 2 ] || die '--user needs an account name'; CROSSBAR_USER="$2"; shift 2 ;;
        --purge-data) PURGE=1; shift ;;
        --dry-run) DRY_RUN=1; shift ;;
        -h|--help) usage_from "$0"; exit 0 ;;
        *) die "unknown argument: $1 (try --help)" ;;
    esac
done

require_path 'prefix' "$PREFIX"
require_account_name "$CROSSBAR_USER"

ALL_UNITS="$UNIT_NAMES_CORE $UNIT_NAMES_BACKUP $UNIT_NAMES_RELAY"

# A command whose failure is not one. systemd answers "Unit … not loaded" for a unit that is not
# installed, which is this script's ordinary case: a deployment with no relay has no
# `crossbar-turn.service`, and a second run has none of them. Refusing over it would make
# uninstall a thing you can only do once.
try() {
    if ! run "$@"; then
        printf '     (not there, or not running — nothing to do: %s)\n' "$*"
    fi
}

step 'preconditions'
say "prefix:  $PREFIX"
say "account: $CROSSBAR_USER"
if [ "$DRY_RUN" = '1' ]; then
    say 'dry run: every command below is printed and none is executed, and nothing is deleted.'
else
    require_systemd
    require_root
fi

# `--purge-data` is checked before anything is removed, so a prefix that is wrong — a parent
# directory, a home directory — refuses while the deployment is still whole. A flag that can be
# pointed at the wrong directory and delete a database is a data-loss bug with a friendly name, and
# the cheap guard against it is that the prefix has to look like a Crossbar checkout first.
if [ "$PURGE" = '1' ]; then
    step 'what --purge-data would delete'
    if [ ! -d "$PREFIX/src" ] || [ ! -f "$PREFIX/package.json" ]; then
        die "$PREFIX does not look like a Crossbar deployment (no src/ and package.json): refusing to purge data from a directory this is not sure about. Nothing was changed."
    fi
    say "  $PREFIX/data    the database, the directory file, and every backup"
    say "  $PREFIX/.env    the configuration and secrets"
    warn 'Those are the only two things in this deployment that cannot be reconstructed. Every'
    warn 'device key, invitation, push token and call record is in the database, and the backups'
    warn 'are a copy of it — copy them off this host first if you have not (deploy/README.md §4.7).'
fi

step 'stop and disable'
try systemctl disable --now crossbar
# The two mode units have no `[Install]` on purpose — they are oneshots that a restart of
# `crossbar.service` runs, not units anything enables — so there is nothing to disable, and
# `systemctl disable` says so. Stopping them is the same no-op, kept because a switch may have left
# one of them mid-run.
try systemctl stop crossbar-public crossbar-private
try systemctl stop crossbar-backup.service
try systemctl disable --now crossbar-backup.timer
try systemctl disable --now crossbar-turn

step 'remove the units'
# `rm -f` for a unit that is not there is the ordinary case, and asking whether each file exists
# first would make a dry run on a host that is not the deployment print nothing about the part of
# this script that matters. `disable` above is what removes the enabled symlinks; these are the
# files themselves.
for unit in $ALL_UNITS; do
    run rm -f "/etc/systemd/system/$unit"
done
# The relay's rendered template: read from /etc, not from the checkout, because the relay runs as
# `turnserver` and a home directory is mode 0700 (deploy/README.md §2.9). GNU `rmdir`, so the flag
# is the one on the host this runs on.
if [ -f /etc/crossbar/coturn.conf ]; then
    run rm -f /etc/crossbar/coturn.conf
    run rmdir --ignore-fail-on-non-empty /etc/crossbar
fi
# Without this the unit is still "loaded" and `systemctl status crossbar` answers `failed` for a
# deployment that no longer exists — which is confusing on the day somebody re-installs it, and is
# the difference between a clean box and one with a ghost.
run systemctl reset-failed $ALL_UNITS
run systemctl daemon-reload

if [ "$PURGE" = '1' ]; then
    step 'purge the data'
    run rm -rf "$PREFIX/data"
    run rm -f "$PREFIX/.env"
fi

step 'what is left'
if [ "$PURGE" = '1' ]; then
    say "  $PREFIX        the checkout, with its dependencies"
    say '                 (left on purpose: it is a git tree that may hold edits, and this script'
    say '                 did not create it. Delete it with `rm -rf` when you are sure.)'
    say ''
    say 'The data directory and `.env` are gone, and with them the database, the directory file and'
    say 'every backup. Anything not copied off this host does not exist anywhere else.'
else
    say "  $PREFIX/data   the database, the directory file, and the backups — untouched"
    say "  $PREFIX/.env   the configuration and secrets — untouched"
    say "  $PREFIX        the checkout — untouched"
    say ''
    say 'That is deliberate: a re-install of the same version at the same prefix picks them up, and'
    say 'nothing in this deployment is lost by removing the units. Delete them yourself, or run'
    say 'this again with --purge-data, if the intent was to lose them.'
fi
say ''
say "The account $CROSSBAR_USER is left in place. Remove it with \`userdel -r\` only after the"
say 'checkout is gone; `-r` deletes its home directory, which is where the checkout is.'
exit 0
