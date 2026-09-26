#!/usr/bin/env bash
#
# Install a Crossbar deployment on this host.
#
# This is `deploy/README.md` §2.2–§2.6 as one command. What it does, in order:
#
#   1. the account (§2.1), the deployment directory, and the code — the checkout it lives in, or
#      `--source` copied to `--prefix`;
#   2. the data directory, and the `.env` the server reads (seeded from `.env.example`, with the
#      template's production paths rendered for this host);
#   3. **Tailscale**, before anything is asked (§2.8.1): installed if it is absent, `tailscaled`
#      enabled and started, and the deployment's own account named the daemon's **operator**. That
#      last line is the load-bearing one — the daemon answers only root's calls until a user is the
#      operator, so it is what lets the wizard, which runs as that account, join the tailnet itself
#      a moment later. Nothing is logged in here. It happens before the mode question because that
#      question belongs to the wizard and the join that follows it needs root work done first; a
#      public-only install ends up with Tailscale installed and never logged in, which serves
#      nothing and holds nothing;
#   4. **onboarding** — `node src/admin.js setup` (§2.2.1, §2.3–§2.4), run in `$PREFIX` as the
#      deployment's own account: it writes the mode blocks, the secrets and the **directory file**
#      in one pass. When the mode set includes private it also **joins the tailnet there**, between
#      the mode question and the private address that comes from it: `tailscale up --hostname <the
#      deployment's name>` (the deployment's own name unless `--tailscale-hostname` says otherwise,
#      because that address is what a person's phones dial and what an invitation carries), in the
#      foreground, showing Tailscale's approval link — with a key in `TS_AUTHKEY` when one was
#      given, which needs no approval. The machine's own tailnet name is then read back and offered
#      as the private address, to confirm, instead of being asked for blind. The person who chose
#      the mode is the person the link is shown to, which is the whole point of the join being
#      there. Then the front door the chosen modes need (§2.8) — Caddy for a public block, and for
#      a private one the **safety net**: the same login attempted once more for a run the wizard
#      could not join from (no terminal, a declined link, a key that did not work), the machine's
#      own name read back, and `.env` corrected through the wizard if the two disagree. The login
#      never fails the install: with no terminal it is not attempted, and a declined or timed-out
#      one leaves everything else installed and says which it was. `--no-setup` turns the phase off
#      and reproduces what this script did before: the directory file has to exist already, and it
#      says exactly what to write when it does not;
#   5. `npm ci --omit=dev` in the deployment's own account;
#   6. the units, rendered for this host's paths and installed, `daemon-reload`, the service
#      enabled and started, and the backup **timer** enabled — the backup service has no
#      `[Install]` on purpose, so enabling the timer *is* the install step and forgetting it is a
#      backup that never runs;
#   7. `/api/health`, so "installed" means "answering" rather than "the files are in /etc".
#
# It runs as root on a host with systemd, and refuses rather than half-installing. On a host
# without systemd — a Mac, a container — it says so and stops: an install that reports success and
# leaves no service running is the worst outcome, because it looks like a working deployment until
# the first reboot.
#
# Usage:
#   sudo scripts/install.sh [--prefix DIR] [--user NAME] [--source DIR] [--with-relay]
#                           [--answers FILE] [--browser] [--tailscale-authkey KEY]
#                           [--tailscale-hostname NAME] [--no-setup] [--dry-run]
#
#   --prefix DIR   where the deployment runs        (env CROSSBAR_HOME, default /home/admin/crossbar)
#   --user NAME    the account that runs it         (env CROSSBAR_USER, default admin)
#   --source DIR   the tree to install from         (default: the checkout this script is in)
#   --answers FILE the wizard's answers, as `node src/admin.js setup --answers` takes them, for an
#                  install that is not watched
#   --browser      the wizard's browser front end (`--browser`) instead of the terminal questions
#   --no-setup     do not run the wizard: the directory file has to be there already
#   --with-relay   install the coturn relay unit even if it is not obvious this host relays
#   --tailscale-authkey KEY
#                  a Tailscale auth key, for a private deployment: it joins this machine to the
#                  tailnet without the browser approval a person would otherwise do. The key is
#                  handed to `tailscale up` through TS_AUTHKEY, so it appears in no transcript and
#                  no process list. Without it the wizard runs the same login and shows the
#                  approval link in the terminal — the join happens inside the onboarding phase,
#                  before the private address is asked for, so that address is the name the login
#                  gives this machine; where there is no terminal to show the link in, it does as
#                  much as it can and leaves the exact command — with what it will do, and that
#                  re-running the installer afterwards picks the address up by itself.
#   --tailscale-hostname NAME
#                  the name the login gives this machine in the tailnet, and therefore what the
#                  private address is. The private address is `<NAME>.<tailnet>.ts.net`, and that
#                  address is what a person's phones dial and what an invitation carries — so the
#                  name should be the one they chose, not the one their VPS provider assigned the
#                  host. It defaults to the deployment's own name, the basename of `--prefix`
#                  (`crossbar-dev` for /home/admin/crossbar-dev, `crossbar` for the default
#                  /home/admin/crossbar), so a private install produces a good address with no
#                  extra flag; a basename that is not a hostname (`My_Box.v2`) is reduced to one
#                  (`my-box-v2`), because a directory name may hold characters a hostname cannot.
#                  A NAME spelled here is used as spelled and refused if it is not a hostname.
#   --dry-run      print every command and change nothing
#
# Idempotent: every step either already holds or is re-applied, so a second run is how a unit that
# was edited by hand gets put back, and how a host that failed at the missing directory file is
# finished after the file is written. The wizard is part of that: it offers what the file already
# holds as the default, keeps the secrets that are in it, and changes only what it was told to.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/deploy.sh
. "$SCRIPT_DIR/lib/deploy.sh"

DRY_RUN=0
PREFIX="${CROSSBAR_HOME:-/home/admin/crossbar}"
CROSSBAR_USER="${CROSSBAR_USER:-admin}"
SOURCE="$(cd "$SCRIPT_DIR/.." && pwd)"
WITH_RELAY=''
ANSWERS=''
BROWSER=''
NO_SETUP=''
TAILSCALE_AUTHKEY=''
# The name the login gives this machine; empty means derive it from `--prefix` below. The library
# reads `TAILSCALE_HOSTNAME` the way it reads the rest of the state, and `--tailscale-hostname` sets
# it.
TAILSCALE_HOSTNAME=''

usage() {
    usage_from "$0"
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --prefix) [ "$#" -ge 2 ] || die '--prefix needs a directory'; PREFIX="$2"; shift 2 ;;
        --user)   [ "$#" -ge 2 ] || die '--user needs an account name'; CROSSBAR_USER="$2"; shift 2 ;;
        --source) [ "$#" -ge 2 ] || die '--source needs a directory'; [ -d "$2" ] || die "--source $2 is not a directory"; SOURCE="$(cd "$2" && pwd)"; shift 2 ;;
        # Absolute, because the wizard resolves `--answers` against its own working directory —
        # which is `$PREFIX` — so a relative path the operator typed here would be looked for in
        # the deployment instead of where they typed it.
        --answers) [ "$#" -ge 2 ] || die '--answers needs a file'; [ -f "$2" ] || die "--answers $2 is not a file"; ANSWERS="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"; shift 2 ;;
        --browser) BROWSER=1; shift ;;
        --no-setup) NO_SETUP=1; shift ;;
        --with-relay) WITH_RELAY=1; shift ;;
        # A secret, and validated as one: an empty key is a typo that would otherwise reach
        # `tailscale up` as "no key at all" and leave the login to a browser without saying so.
        --tailscale-authkey) [ "$#" -ge 2 ] || die '--tailscale-authkey needs a key'; [ -n "$2" ] || die '--tailscale-authkey needs a non-empty key'; TAILSCALE_AUTHKEY="$2"; shift 2 ;;
        # A name a person spelled, so it is refused rather than reduced when it is not a hostname
        # (§`require_tailscale_hostname`): it becomes the first label of the private address, which
        # is what an invitation carries.
        --tailscale-hostname) [ "$#" -ge 2 ] || die '--tailscale-hostname needs a name'; require_tailscale_hostname "$2"; TAILSCALE_HOSTNAME="$2"; shift 2 ;;
        --dry-run) DRY_RUN=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) die "unknown argument: $1 (try --help)" ;;
    esac
done

# `--answers`, `--browser`, `--tailscale-authkey` and `--tailscale-hostname` are all answers to, or
# work of, the wizard and the front door it installs; this flag says there is no onboarding phase,
# so together they are a typo that would otherwise install nothing and say nothing about why.
if [ -n "$NO_SETUP" ] && { [ -n "$ANSWERS" ] || [ -n "$BROWSER" ] || [ -n "$TAILSCALE_AUTHKEY" ] || [ -n "$TAILSCALE_HOSTNAME" ]; }; then
    die '--no-setup turns the onboarding phase off, so --answers, --browser, --tailscale-authkey and --tailscale-hostname have nothing to run: pass one or the other'
fi

# The two values that end up inside a unit file, refused unless they are shaped like what they are
# (§`require_path` in the library). Checked before anything runs, so a typo costs nothing.
require_path 'prefix' "$PREFIX"
require_account_name "$CROSSBAR_USER"

# The name the login gives this machine in the tailnet, when the person did not name it. The private
# address is `<name>.<tailnet>.ts.net` — the address their phones dial and the one an invitation
# carries — and the deployment's own name is the one a person would choose, so a private install
# needs no extra flag to produce a good address: `/home/admin/crossbar-dev` joins as `crossbar-dev`,
# not as whatever the host's provider called it (`srv2011992` on a VPS).
#
# Defaulted here, and reduced to a hostname rather than used raw
# (§`deployment_tailscale_hostname`), because a directory name is not a hostname and this is the
# one place that knows the prefix was accepted without a name of its own. A name that was spelled
# is already validated and is left alone.
if [ -z "$TAILSCALE_HOSTNAME" ]; then
    TAILSCALE_HOSTNAME="$(deployment_tailscale_hostname "$PREFIX")"
fi

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
    say '         being missing — a real run stops at a missing systemd, and at the directory file'
    say '         only when --no-setup was passed.'
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
    if [ -n "$NO_SETUP" ]; then
        say 'seeded .env from .env.example. It is a template: HOST/PORT, DATA_DIR, DIRECTORY_CONFIG_PATH,'
        say 'CROSSBAR_SESSION_SECRET and one block per mode have to be filled in before this is useful'
        say '(deploy/README.md §2.3).'
    else
        say 'seeded .env from .env.example. The setup wizard below fills in both mode blocks, the session'
        say 'secret and the directory file, and the paths this host needs (deploy/README.md §2.3).'
    fi
fi

# Only the wizard path renders the template's production paths: it is the wizard that reads
# `DATA_DIR` and `DIRECTORY_CONFIG_PATH` out of this file and writes the directory file to where
# they point, and a second household at another prefix would otherwise get it written under
# `/home/admin/crossbar`. `--no-setup` edits and installs over the file by hand, as it did before.
if [ -z "$NO_SETUP" ]; then
    render_env_paths
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

# ── 4. Tailscale, before the questions that decide whether it is used ──────────
# The wizard joins the tailnet itself, and it can only do that as the daemon's operator. On Linux
# the daemon belongs to root and Tailscale answers nobody else until a user is named the operator,
# so `prepare_tailscale` — install it if it is absent, start `tailscaled`, `tailscale set
# --operator=<account>` — runs here, before the phase that asks anything, and nothing about it is
# a login.
#
# Before rather than inside the onboarding phase because inside it there is no root: the question
# that decides whether Tailscale is wanted at all belongs to the wizard, which runs as the
# deployment's account, and the join that answers with the private address is the same account's
# command. An install that turns out to be public-only ends the run with Tailscale installed and
# never logged in — a daemon in `NeedsLogin` serves nothing and holds nothing — and that is the
# price of the answer being available at the moment it is asked for.
#
# Not fatal: `prepare_tailscale` warns and carries on, so a host that cannot reach Tailscale's
# repository still installs. The wizard's fallback is today's behaviour (ask, and hand over the
# instructions), and the front door refuses there instead when a private deployment has no
# Tailscale at all.
if [ -z "$NO_SETUP" ]; then
    step 'tailscale'
    prepare_tailscale
fi

# ── 5. Onboarding: the wizard, the directory file, and the front door ──────────
# The server refuses to start without a directory file, so this phase is where that file comes
# from: `node src/admin.js setup` (deploy/README.md §2.2.1) is the wizard, it needs nothing but
# the standard library and the tree copied above, and it writes the mode blocks, the session
# secret and the directory file in one pass — nothing written until the whole `.env` it composes
# is complete. It runs before `node_modules` exists, which is why it is here and not after
# `npm ci`.
#
# The wizard goes first because the *mode* it asks for is what decides whether a private door is
# wanted at all (`onboard_deployment` in the library, §2.8.1). The private address is the one
# answer already on the machine — it is the name Tailscale gives this host — and as of the step
# above the machine can be made to have that name from inside the wizard, as the deployment's own
# account, before the address is asked for: the wizard runs `tailscale up --hostname <the
# deployment's name>`, shows Tailscale's approval link in this terminal, reads `Self.DNSName` back
# and offers it as the private address to confirm rather than asking blind. No key is needed for
# that; `--tailscale-authkey` only removes the approval step.
#
# The front door after the wizard is the safety net for a run that could not join there: the same
# login attempted once more (no terminal for the link, a declined approval, a key that did not
# work), the machine's own name read back, and the wizard re-run with that name when `.env`
# disagrees — the same file, every other answer and every secret kept — so the address ends up
# right by construction even on a host nothing could join from here.
#
# The login *names* the node (`TAILSCALE_HOSTNAME`, the deployment's own name unless
# `--tailscale-hostname` says otherwise): the name is not decoration, it is the first label of the
# address an invitation carries, and a login that names nothing leaves the provider's name
# (`srv2011992`) in `.env` and in every invitation built from it. A login the installer could not
# finish never stops the install; the final report's instructions are the rest.
#
# `--no-setup` turns it off and reproduces what this install did before there was a wizard: the
# directory file has to be there already, and the refusal below says exactly what to write. That
# refusal lives in a function so a dry run prints the message a real run would give, word for
# word, rather than a summary of it: somebody planning an install on a workstation should read
# what goes in the file, not a description of a check.
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

   Or leave it to the wizard, which writes this file from the people you name: run this without
   \`--no-setup\`, with \`--answers <file>\` or at a terminal.

   Nothing was installed: no unit was written and no service was enabled. What is already at
   $PREFIX (the account, the data directory, \`.env\`) is left as it is and is safe to keep.
EOF
}

if [ -n "$NO_SETUP" ]; then
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
else
    step 'onboarding'
    onboard_deployment "$ANSWERS" "$BROWSER" "$TAILSCALE_AUTHKEY"
    if [ "$DRY_RUN" = '1' ]; then
        say "a real run writes the directory file at $DIRECTORY_PATH before it installs a unit"
    else
        if [ ! -f "$DIRECTORY_PATH" ]; then
            # The wizard answers for its own outputs (`writeDeployment` refuses rather than
            # half-write), so this is the two paths disagreeing rather than a missing write: `.env`
            # was rendered for this host above, and the wizard read it. Worth stopping over — it is
            # the file the server will not start without.
            die "the wizard finished but there is no directory file at $DIRECTORY_PATH: the path .env names and the path the wizard wrote are not the same. Nothing else was installed."
        fi
        say "the directory file is in place: $DIRECTORY_PATH"
    fi
fi

# ── 6. Dependencies ─────────────────────────────────────────────────────────────
# `--prefix` so the printed command is the one that runs: `npm ci` deletes `node_modules` and
# rebuilds it from `package-lock.json`, which is the only way to get the tree the artefact was
# tested with. It needs the registry or a warm npm cache; there is no build step and `node:sqlite`
# is Node's own, so nothing else about the install needs the network.
#
# As the deployment's account rather than as root, so the tree it writes belongs to the account
# that has to replace it next time.
step 'dependencies'
run_as_user "$NPM_BIN" ci --prefix "$PREFIX" --omit=dev --no-audit --no-fund

# ── 7. The units ────────────────────────────────────────────────────────────────
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

# ── 8. Enable, and start ────────────────────────────────────────────────────────
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

# ── 9. What is left for a person ────────────────────────────────────────────────
step 'next steps'
say "  cd $PREFIX"
say "  sudo -u $CROSSBAR_USER node src/admin.js mode       # which mode the file is in, and that it loads"
say "  sudo -u $CROSSBAR_USER node src/admin.js status     # the running configuration and the counts"
say "  sudo -u $CROSSBAR_USER node src/admin.js doctor     # every line OK before anybody is invited"
say ''
say '  The onboarding phase asks the console password and the first invitation at a terminal,'
say '  and runs them there. If either was skipped, or there was no terminal to ask, they are:'
say "      sudo -u $CROSSBAR_USER node src/admin.js password                # the console's password, at /admin"
say "      sudo -u $CROSSBAR_USER node src/admin.js enroll --user <login>   # one invitation, printed once"
say ''
say '  journalctl -u crossbar -f                            # what it is saying'
say '  systemctl list-timers crossbar-backup.timer          # the daily backup, and when it next runs'
say '  systemctl status crossbar crossbar-backup.timer'
say ''
say 'A public deployment'"'"'s Caddy, its Caddyfile and the drop-in that hands it this .env were'
say 'installed and validated in the onboarding phase. What is left is what software cannot see:'
say 'the DNS record, the port forwards, the firewall, and the address the router forwards to —'
say 'deploy/README.md §2.8, with the host facts in §8.'
# Tailscale's own state, at the end, because the login is the one thing this install can still be
# waiting on: until it happens nothing on this host can check the private address the wizard was
# asked for, and an invitation built on a name that is not the machine's own opens nowhere. A
# `--no-setup` run never touched Tailscale, so `TAILSCALE_READY` keeps this off there.
if [ -n "$TAILSCALE_READY" ]; then
    TAILNET_NAME="$(tailnet_name)"
    say ''
    if [ -n "$TAILNET_NAME" ]; then
        say "Tailscale: this machine is on the tailnet as $TAILNET_NAME, and the private address in"
        say '.env is that name.'
    else
        say 'Tailscale: installed, and tailscaled is running, but this machine is not logged in yet,'
        say 'so it has no tailnet name and the private address in .env is still what the wizard wrote.'
        case "$TAILSCALE_LOGIN" in
            no-terminal)
                say 'There was no terminal here to show Tailscale'"'"'s approval link, so the login was'
                say 'not run. Run it on the host, at a terminal:'
                ;;
            failed)
                say 'The login was run here and did not finish — declined, or it timed out. Try again:'
                ;;
            *)
                say 'The one command left is:'
                ;;
        esac
        say ''
        tailnet_login_instructions
    fi
fi
say ''
say 'The relay is §2.9.'
exit 0
