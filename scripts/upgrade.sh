#!/usr/bin/env bash
#
# Upgrade a Crossbar deployment from a release tarball, and put the previous tree and database
# back if the new one does not come up healthy.
#
# `scripts/release.sh` is the other end of this: it produces `crossbar-server-<version>.tar.gz`
# on the machine that has the repository, this runs on the deployment host as root.
#
# Usage:
#   sudo scripts/upgrade.sh --from <tarball> [--prefix DIR] [--user NAME] [--dry-run]
#
#   --from FILE    the `crossbar-server-<version>.tar.gz` to install (required)
#   --prefix DIR   where the deployment is       (env CROSSBAR_HOME, default /home/admin/crossbar)
#   --user NAME    the account it runs as        (env CROSSBAR_USER, default admin)
#   --dry-run      print every command and change nothing
#
# The order is the interesting part, and each step is there because of a way an upgrade goes
# wrong:
#
#   1. **stop the service.** A snapshot of a database somebody is writing to is not a snapshot of
#      anything in particular.
#   2. **snapshot with `src/backup.js`** — the deployment's own module, run from the tree that is
#      still in place, because it is the code that knows where this deployment keeps its data and
#      what a backup of it is called. Reimplementing the copy here would be a second answer to
#      that question, and the wrong one the day the layout changes. If it fails, nothing is
#      replaced and the service is started again: an upgrade with no way back is not one to run.
#   3. **unpack and `npm ci` beside the running tree.** A dependency that will not install, a
#      tarball that is truncated, a `package.json` that does not parse — all found while the
#      deployment is still the old one.
#   4. **swap the trees, carrying `data/` and `.env` across.** They are this host's, and the
#      tarball carries neither (that is what `release.sh` excludes them for).
#   5. **reinstall the units** from the new tree, rendered for this host's paths. A code update
#      does not install unit changes, and a build whose units were never installed is the
#      half-upgraded state that is hardest to diagnose.
#   6. **start, and ask `/api/health` for its version.** Not "is the unit active" — a unit that is
#      active and answering with the old version is an upgrade that did not happen. Anything other
#      than the new version, or no answer, is a rollback.
#
# A rollback costs every write since the snapshot. The service has been stopped since before it,
# so the only thing that can be lost is the new build's own migration — and that is the thing the
# snapshot exists for, because a migration is forward-only and an older build is not promised to
# read a file a newer one migrated.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/deploy.sh
. "$SCRIPT_DIR/lib/deploy.sh"

DRY_RUN=0
PREFIX="${CROSSBAR_HOME:-/home/admin/crossbar}"
CROSSBAR_USER="${CROSSBAR_USER:-admin}"
FROM=''

while [ "$#" -gt 0 ]; do
    case "$1" in
        --from) [ "$#" -ge 2 ] || die '--from needs a tarball path'; FROM="$2"; shift 2 ;;
        --prefix) [ "$#" -ge 2 ] || die '--prefix needs a directory'; PREFIX="$2"; shift 2 ;;
        --user) [ "$#" -ge 2 ] || die '--user needs an account name'; CROSSBAR_USER="$2"; shift 2 ;;
        --dry-run) DRY_RUN=1; shift ;;
        -h|--help) usage_from "$0"; exit 0 ;;
        *) die "unknown argument: $1 (try --help)" ;;
    esac
done

if [ -z "$FROM" ]; then
    die 'no tarball given: upgrade.sh --from <crossbar-server-<version>.tar.gz> (--help for the rest)'
fi

require_path 'prefix' "$PREFIX"
require_path '--from' "$FROM"
require_account_name "$CROSSBAR_USER"

# So a dry run says something useful in them, these are printed even on a host where they do not
# exist yet; the real run creates the ones it needs.
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
STAGE="$PREFIX.new-$STAMP"        # unpacked and installed beside the running tree
PREVIOUS="$PREFIX.previous"       # the tree this upgrade replaced — one generation, like env.previous
FAILED="$PREFIX.failed-$STAMP"    # the tree that did not come up, kept as evidence
CARRY="$PREFIX.carry-$STAMP"      # where data/ and .env sit while the trees change places

step 'preconditions'
[ -d "$PREFIX/src" ] || die "there is no deployment at $PREFIX (no src/): --prefix, or CROSSBAR_HOME, points at the wrong directory"
[ -f "$PREFIX/.env" ] || die "there is no $PREFIX/.env: the server reads its configuration from that file, and an upgrade of a deployment that has none is not something this script can do"
[ -f "$FROM" ] || die "no tarball at $FROM"
resolve_node
say "from:    $FROM"
say "prefix:  $PREFIX"
say "account: $CROSSBAR_USER"
say "node:    $NODE_BIN  ($NODE_VERSION)"
CURRENT_VERSION="$(package_version "$PREFIX/package.json")"
say "running: $CURRENT_VERSION (from $PREFIX/package.json; /api/health is the one that matters)"
if [ "$DRY_RUN" = '1' ]; then
    say 'dry run: every command below is printed and none is executed, including the rollback.'
else
    require_systemd
    require_root
    require_command curl 'the verdict at the end is what /api/health says, not what systemd says'
    require_command runuser 'the staged dependencies have to be installed as the account that will run them — and that has to fail here, before the service is stopped, rather than mid-swap'
fi

# The checksum, when the artefact arrived with one. Nothing else verifies a file that came over a
# network, and a truncated tarball fails at the least convenient moment — halfway through
# extracting over a deployment that is already stopped.
CHECKSUM_TOOL='sha256sum'
if ! command -v sha256sum >/dev/null 2>&1; then
    if command -v shasum >/dev/null 2>&1; then
        CHECKSUM_TOOL='shasum -a 256'
    else
        CHECKSUM_TOOL=''
        warn 'neither sha256sum nor shasum is on PATH, so the tarball cannot be checked against its .sha256'
    fi
fi
if [ -n "$CHECKSUM_TOOL" ] && [ -f "$FROM.sha256" ]; then
    if ! run_pipe "cd $(dirname "$FROM") && $CHECKSUM_TOOL -c $(basename "$FROM").sha256"; then
        die "the checksum in $FROM.sha256 does not match $FROM: that is a different file from the one that was released, and nothing has been changed"
    fi
elif [ ! -f "$FROM.sha256" ]; then
    warn "no $FROM.sha256 beside the tarball: there is nothing to check it against"
fi

step 'the new tree, beside the old one'
# Beside the running tree rather than over it: everything that can fail before the swap happens
# here, where the deployment is still the one that works.
run install -d -m 0755 "$STAGE"
# `--strip-components=1` because the tarball carries one top-level `crossbar-server-<version>/`:
# an extracted release is a directory like any other, and the name that carries the version is the
# name an operator reads.
run tar -xzf "$FROM" -C "$STAGE" --strip-components=1
if [ "$DRY_RUN" = '1' ]; then
    NEW_VERSION='(read from the staged package.json — the tarball name carries it too)'
    would_run "chown -R $CROSSBAR_USER:$CROSSBAR_USER $STAGE"
    would_run "$NPM_BIN --prefix $STAGE ci --omit=dev --no-audit --no-fund"
else
    [ -f "$STAGE/package.json" ] || die "$FROM did not unpack into a Crossbar tree (no package.json after stripping one component): it is not a release built by scripts/release.sh"
    NEW_VERSION="$(package_version "$STAGE/package.json")"
    if [ -z "$NEW_VERSION" ]; then
        die "the tarball's package.json has no version: refusing to upgrade to something that cannot be named"
    fi
    say "new:     $NEW_VERSION"
    # The name is what an operator compares against `/api/health`, so a mismatch is said out loud
    # rather than silently making the check below meaningless. The staged `package.json` is
    # authoritative — it is what the new process will report.
    case "$(basename "$FROM")" in
        "crossbar-server-$NEW_VERSION.tar.gz") ;;
        *) warn "$(basename "$FROM") does not read as crossbar-server-$NEW_VERSION.tar.gz; the staged package.json says $NEW_VERSION, and that is the version this upgrade will verify" ;;
    esac
    if [ "$NEW_VERSION" = "$CURRENT_VERSION" ]; then
        warn "this is the version already installed ($CURRENT_VERSION)"
    fi
    # Root unpacked it, so the tree is root's; the deployment's account has to be able to replace
    # `node_modules/` (and reads everything else). Then `npm ci` as that account, so the lockfile's
    # tree is installed the way an operator running it by hand would get it.
    run chown -R "$CROSSBAR_USER:$CROSSBAR_USER" "$STAGE"
    run_as_user "$NPM_BIN" ci --prefix "$STAGE" --omit=dev --no-audit --no-fund
fi

step 'the service, and a snapshot'
run systemctl stop crossbar
run install -d -m 0755 "$CARRY"
if [ "$DRY_RUN" = '1' ]; then
    would_run "cd $PREFIX && $NODE_BIN src/backup.js   (the snapshot, before anything is replaced)"
    SNAPSHOT='<the backup directory it prints>'
else
    # `src/backup.js` from the tree that is still in place, with that tree as the working
    # directory: the CLI reads `./.env`, and this is the deployment's own file.
    if ! SNAPSHOT_OUTPUT="$(cd "$PREFIX" && "$NODE_BIN" src/backup.js)"; then
        run systemctl start crossbar
        die "the snapshot failed, so nothing was replaced and the service is being started again: $SNAPSHOT_OUTPUT"
    fi
    say "         $SNAPSHOT_OUTPUT"
    SNAPSHOT="$(json_field "$SNAPSHOT_OUTPUT" path)"
    if [ -z "$SNAPSHOT" ] || [ ! -d "$SNAPSHOT" ]; then
        run systemctl start crossbar
        die "the snapshot did not report a directory that exists ('$SNAPSHOT'): refusing to continue without one. The service is being started again."
    fi
    say "snapshot: $SNAPSHOT"
fi

# ── The swap ────────────────────────────────────────────────────────────────────
# `mv` of a sibling directory, so every move here is a rename on one filesystem rather than a copy
# of a database. data/ and .env go into the carry directory first because the new tree does not
# contain them: they belong to this host, and the tarball is code.
step 'swap the trees'
run rm -rf "$PREVIOUS"
run mv "$PREFIX/data" "$CARRY/data"
run mv "$PREFIX/.env" "$CARRY/.env"
run mv "$PREFIX" "$PREVIOUS"
run mv "$STAGE" "$PREFIX"
run mv "$CARRY/data" "$PREFIX/data"
run mv "$CARRY/.env" "$PREFIX/.env"
# Empty by construction. It is not a documented failure and must not stop the upgrade if it is not
# — the files that matter have already moved — so it says so and carries on.
if ! run rmdir "$CARRY" 2>/dev/null; then
    warn "$CARRY was left in place: it is not empty, so something is in it that this upgrade did not put there"
fi

# The units, from the new tree, rendered for this host. Which of them are installed follows what
# is on the host rather than what the tarball contains: a deployment with no relay must not grow
# one from an upgrade.
step 'the units'
UNITS_TO_INSTALL="$UNIT_NAMES_CORE $UNIT_NAMES_BACKUP"
if [ -f /etc/systemd/system/crossbar-turn.service ]; then
    UNITS_TO_INSTALL="$UNITS_TO_INSTALL $UNIT_NAMES_RELAY"
fi
if [ "$DRY_RUN" = '1' ]; then
    say "rendering from $PREFIX/deploy, the tree in place now: the real run renders the units the"
    say 'tarball carries, so a build that changed a unit file renders differently from this preview.'
fi
# Unquoted on purpose: this is the list, and bash 3.2 has no arrays.
# shellcheck disable=SC2086
if ! install_units "$PREFIX/deploy" $UNITS_TO_INSTALL; then
    rollback "the new tree does not carry the unit files this deployment runs (see the message above)"
fi

# ── Rollback ────────────────────────────────────────────────────────────────────
# Defined here so the three ways the new build can be wrong all read the same. It stops at the
# first step that fails, on purpose: a rollback that half-happened is worse than one that stopped,
# and the operator is told which step it was.
rollback() { # rollback <why>
    printf '\n!! %s\n' "$1" >&2
    say 'rolling back: the previous tree and the snapshot'
    run systemctl stop crossbar
    # The tree that failed is kept rather than deleted: it is the evidence for whatever the reason
    # above was, and it is small next to the cost of reproducing it.
    run mv "$PREFIX/data" "$CARRY/data"
    run mv "$PREFIX/.env" "$CARRY/.env"
    run mv "$PREFIX" "$FAILED"
    run mv "$PREVIOUS" "$PREFIX"
    run mv "$CARRY/data" "$PREFIX/data"
    run mv "$CARRY/.env" "$PREFIX/.env"
    # The database, from the snapshot taken before anything was replaced. A migration is
    # forward-only, so an older build is not promised to read a file a newer one migrated — which
    # makes restoring the snapshot the safe direction and not merely the conservative one.
    if [ -d "$SNAPSHOT" ]; then
        run install -o "$CROSSBAR_USER" -g "$CROSSBAR_USER" -m 0600 "$SNAPSHOT/crossbar.sqlite" "$PREFIX/data/crossbar.sqlite"
        # A stale write-ahead log beside a replaced database is at best ignored and at worst
        # applied to a file it does not belong to.
        run rm -f "$PREFIX/data/crossbar.sqlite-wal" "$PREFIX/data/crossbar.sqlite-shm"
    fi
    # The units too, from the tree that is back in place: an upgrade reinstalls them, so a
    # rollback that did not would leave the old code reading the new units.
    # shellcheck disable=SC2086
    install_units "$PREFIX/deploy" $UNITS_TO_INSTALL
    run systemctl start crossbar
    ROLLBACK_HEALTH="$(wait_for_health 30 || true)"
    if [ -n "$ROLLBACK_HEALTH" ]; then
        say "rolled back: version $(json_field "$ROLLBACK_HEALTH" version) is answering at 127.0.0.1:$(deployment_port)/api/health"
    else
        warn "the service did not answer /api/health after the rollback either — the deployment is down, and the tree and database are the ones from before this upgrade"
    fi
    say ''
    say 'What is where now:'
    say "  $PREFIX            the tree from before the upgrade, and the database from $SNAPSHOT"
    say "  $FAILED"
    say '                        the tree that failed to come up, kept for the journal and the diff'
    say "  $SNAPSHOT"
    say '                        the snapshot taken before anything was replaced'
    say ''
    say 'Next: journalctl -u crossbar -n 50 --no-pager, and systemctl status crossbar.'
    exit 1
}

step 'start, and what it answers with'
run systemctl start crossbar
if [ "$DRY_RUN" = '1' ]; then
    would_run "curl -fsS http://127.0.0.1:$(deployment_port)/api/health   (until it answers, up to 30s)"
    would_run "on a version other than $NEW_VERSION, or on no answer: rollback — the previous tree, the snapshot, and the units that go with them"
    step 'summary (dry run)'
    say "would replace $PREFIX ($CURRENT_VERSION) with $NEW_VERSION from $FROM"
    say "would keep the previous tree at $PREVIOUS until the health check passes"
    exit 0
fi

if ! HEALTH="$(wait_for_health 30)"; then
    rollback "the new build never answered /api/health at 127.0.0.1:$(deployment_port)/api/health within 30 seconds"
fi

RUNNING_VERSION="$(json_field "$HEALTH" version)"
if [ "$RUNNING_VERSION" != "$NEW_VERSION" ]; then
    rollback "the service answered /api/health with version '$RUNNING_VERSION', not the '$NEW_VERSION' that was installed — that is the old process, or a unit that failed to take the new tree, and not an upgrade"
fi

step 'done'
say "health:  $HEALTH"
say "upgraded: $CURRENT_VERSION → $RUNNING_VERSION at $PREFIX"
say "previous tree kept at $PREVIOUS (it has no data/ and no .env — that is deliberate: one copy of"
say '         them is the deployment, and a second would be a second thing to lose). It is the'
say '         manual rollback if this upgrade has to be undone later: see deploy/README.md §5.5.'
say "snapshot: $SNAPSHOT"
say ''
say 'Worth running now, all of them from the deployment directory:'
say "  cd $PREFIX"
say "  sudo -u $CROSSBAR_USER node src/admin.js mode      # the .env still loads cleanly"
say "  sudo -u $CROSSBAR_USER node src/admin.js status"
say "  sudo -u $CROSSBAR_USER node src/admin.js doctor"
say '  journalctl -u crossbar -n 50 --no-pager'
say ''
# Printed because the automatic rollback only covers a build that will not come up. A migration
# that misbehaves under real traffic, or a phone that stops ringing, is the same recovery done
# hours later, and an operator at that point should not have to reconstruct the order from the
# script's source. deploy/README.md §5.5 is the same order with the reasoning.
say 'A rollback later, by hand — the same order this script would have used automatically:'
say '  sudo systemctl stop crossbar'
say "  sudo mkdir -p $PREFIX.carry"
say "  sudo mv $PREFIX/data $PREFIX.carry/data; sudo mv $PREFIX/.env $PREFIX.carry/.env"
say "  sudo mv $PREFIX $FAILED"
say "  sudo mv $PREVIOUS $PREFIX"
say "  sudo mv $PREFIX.carry/data $PREFIX/data; sudo mv $PREFIX.carry/.env $PREFIX/.env"
say "  sudo install -o $CROSSBAR_USER -g $CROSSBAR_USER -m 600 $SNAPSHOT/crossbar.sqlite $PREFIX/data/crossbar.sqlite"
say "  sudo rm -f $PREFIX/data/crossbar.sqlite-wal $PREFIX/data/crossbar.sqlite-shm"
say "  sudo $SCRIPT_DIR/install.sh --prefix $PREFIX --user $CROSSBAR_USER   # the previous tree's units"
say '  sudo systemctl start crossbar'
exit 0
