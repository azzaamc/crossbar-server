#!/usr/bin/env bash
#
# Build the artefact a deployment is upgraded from: `crossbar-server-<version>.tar.gz` and the
# `.sha256` beside it.
#
# Usage:
#   scripts/release.sh [--out DIR] [--allow-dirty] [--dry-run]
#
#   --out DIR      where to write it (absolute; default: the working directory)
#   --allow-dirty  build anyway from a tree with uncommitted changes, and say so loudly
#   --dry-run      print every command and write nothing
#
# What the tarball carries, and what it does not. It carries the code: `src/`, `public/`,
# `deploy/`, `scripts/`, `test/`, `package.json`, `package-lock.json`, `.env.example`,
# `.gitignore`, under one top-level `crossbar-server-<version>/`. It does not carry
# `node_modules` (the deployment runs `npm ci`), `.git` (the deployment is not a checkout
# anybody commits from), `.env` (one deployment's secrets) or anything under `data/` — the
# database, the directory file with its logins, the `env.previous` a write keeps, and the backups,
# which are a copy of all of it. That is the polarity `.gitignore` already draws for `data/` and
# it is drawn again here for the same reason: an artefact that carried them would ship one
# household's logins to another household's `data/` directory, and the first person to notice
# would be an operator diffing two tarballs.
#
# The tree must be clean. An artefact built from a dirty tree cannot be reproduced from a commit
# and nothing in it says which edits it carries — which is the difference between a version you
# can return to and a version you can only compare by trying it. `--allow-dirty` exists for the
# day a rehearsal needs one anyway; it is not the normal path.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/deploy.sh
. "$SCRIPT_DIR/lib/deploy.sh"
SRC="$(cd "$SCRIPT_DIR/.." && pwd)"

DRY_RUN=0
OUT="$(pwd)"
ALLOW_DIRTY=0

while [ "$#" -gt 0 ]; do
    case "$1" in
        --out) [ "$#" -ge 2 ] || die '--out needs a directory'; OUT="$2"; shift 2 ;;
        --allow-dirty) ALLOW_DIRTY=1; shift ;;
        --dry-run) DRY_RUN=1; shift ;;
        -h|--help) usage_from "$0"; exit 0 ;;
        *) die "unknown argument: $1 (try --help)" ;;
    esac
done

# An absolute path of plain characters, because the checksum step is a pipeline and a pipeline is
# a shell string: a space or an `&` in `--out` would be read as something other than a directory,
# and the artefact would be written somewhere the operator did not ask for.
case "$OUT" in
    /*) ;;
    *) die "--out must be an absolute path, not '$OUT'" ;;
esac
case "$OUT" in
    *[!A-Za-z0-9/._-]*) die "--out may contain only letters, digits, '/', '.', '_' and '-', not '$OUT'" ;;
esac

step 'the tree'
[ -f "$SRC/package.json" ] || die "no package.json at $SRC: this script belongs to the server repository"
[ -f "$SRC/src/server.js" ] || die "no src/server.js at $SRC: that is not the server repository"

# The version, from the same file the server reads it from — one source for the tarball's name,
# `npm`'s idea of this release and the version a deployment reports after an upgrade, which are
# three things an operator compares by eye.
VERSION="$(package_version "$SRC/package.json")"
if [ -z "$VERSION" ]; then
    die "could not read a version out of $SRC/package.json"
fi
say "source:  $SRC"
say "version: $VERSION"

step 'the state of the tree'
COMMIT=''
if command -v git >/dev/null 2>&1 && git -C "$SRC" rev-parse --git-dir >/dev/null 2>&1; then
    COMMIT="$(git -C "$SRC" rev-parse --short HEAD)"
    DIRTY="$(git -C "$SRC" status --porcelain)"
    say "commit:  $COMMIT"
    if [ -n "$DIRTY" ]; then
        DIRTY_COUNT="$(printf '%s\n' "$DIRTY" | wc -l | tr -d ' ')"
        warn "$DIRTY_COUNT path(s) differ from $COMMIT:"
        printf '%s\n' "$DIRTY" | sed 's/^/       /' >&2
        if [ "$ALLOW_DIRTY" != '1' ]; then
            die "an artefact built from a tree in this state cannot be reproduced from a commit, and nothing in it says which edits it carries. Commit or stash the changes, or pass --allow-dirty if this is a rehearsal."
        fi
        warn 'building anyway (--allow-dirty): this tarball is NOT reproducible from a commit.'
    else
        say 'clean: the artefact is exactly the commit above'
    fi
else
    warn 'not a git checkout: the artefact carries no commit, and nothing about it can be reproduced'
fi

# The name the rest of the world sees. Stated as an invariant rather than left implicit: an
# operator reading a tarball's name is reading what an upgrade will report as the running version.
TARBALL="crossbar-server-$VERSION.tar.gz"

step 'build'
STAGE="$(mktemp -d)"
[ -n "$STAGE" ] || die 'could not make a staging directory'
# The staging directory is what makes the exclusions observable in the dry run and keeps the tree
# out of the tarball's own path: `tar -czf` from the parent of `crossbar-server-<version>/`
# produces exactly the layout `upgrade.sh` expects (`--strip-components=1`), on GNU tar and on
# BSD tar alike, without either one's rename flag.
run install -d -m 0755 "$OUT"
run install -d -m 0755 "$STAGE/crossbar-server-$VERSION"
run tar -C "$SRC" -cf "$STAGE/tree.tar" \
    --exclude=./node_modules --exclude=./.git --exclude=./.env --exclude=./data \
    --exclude='*.log' --exclude=./.DS_Store .
run tar -C "$STAGE/crossbar-server-$VERSION" -xf "$STAGE/tree.tar"
run rm -f "$STAGE/tree.tar"
run tar -C "$STAGE" -czf "$OUT/$TARBALL" "crossbar-server-$VERSION"

# `sha256sum` on Debian, `shasum -a 256` on the Mac this may be built on. Both write
# `<hash>  <name>` and both verify with `-c`, so the file means the same thing on either host and
# the line an operator pastes to check it works in both directions.
CHECKSUM_TOOL='sha256sum'
if ! command -v sha256sum >/dev/null 2>&1; then
    if command -v shasum >/dev/null 2>&1; then
        CHECKSUM_TOOL='shasum -a 256'
    else
        die 'neither sha256sum nor shasum is on PATH, so the artefact cannot be accompanied by a checksum'
    fi
fi
run_pipe "cd $OUT && $CHECKSUM_TOOL $TARBALL > $TARBALL.sha256"
# Verified here, at the moment it is built, rather than being left as a file that looks like one.
run_pipe "cd $OUT && $CHECKSUM_TOOL -c $TARBALL.sha256"

if [ "$DRY_RUN" != '1' ]; then
    step 'the artefact'
    say "$OUT/$TARBALL"
    say "  $(du -h "$OUT/$TARBALL" | cut -f1 | tr -d ' ') on disk, $(tar -tzf "$OUT/$TARBALL" | wc -l | tr -d ' ') entries"
    say "  $(cat "$OUT/$TARBALL.sha256")"
    if [ -n "$COMMIT" ]; then
        say "  built from $COMMIT"
    fi
    say ''
    say 'On the deployment host:'
    say "  $CHECKSUM_TOOL -c $TARBALL.sha256        # from the directory it was copied to"
    say "  sudo scripts/upgrade.sh --from <path>/$TARBALL --dry-run"
fi

if [ -n "$STAGE" ]; then
    rm -rf "$STAGE"
fi
