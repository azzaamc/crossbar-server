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
#   * The onboarding phase — the setup wizard and the front door it can install. Only
#     `install.sh` calls it today, and it is here for the two properties the rest of this file
#     exists for: every command it would run is printed by `--dry-run`, and it can be driven
#     against a scratch prefix on a machine with no systemd.
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

# ── Onboarding: the setup wizard, and the front door it can install ─────────────
# `install.sh` runs this between copying the code and `npm ci`. The wizard is `src/setup.js`
# through `node src/admin.js setup`, and it loads nothing but the standard library and the tree
# that is already in `$PREFIX` (`src/setup.js` requires `src/diagnostics` lazily, and says so
# when the probe is not installed yet). That is why it can run before `node_modules` exists, and
# why the directory file it writes is in place before a unit is installed rather than being the
# thing the install refuses over.

# The three settings `.env.example` carries as production's literals, rewritten for this host
# exactly as the unit files are. The wizard reads the deployment's paths out of `.env`
# (`readState` in `src/setup.js`), so a second household at another prefix would otherwise have
# its directory file written to `/home/admin/crossbar/data/directory.json` — outside the
# deployment it is installing, and a path nothing else on that host reads.
#
# Anchored to the whole line, so a value an operator has already edited is left alone, and only
# the wizard path calls it: `--no-setup` installs over the file a person edits, as it did before.
render_env_paths() { # render_env_paths
    if [ ! -f "$PREFIX/.env" ]; then
        # A dry run has copied nothing and seeded nothing, so there is no file to render. The
        # `install` above printed the one that would put it there.
        would_run "render DATA_DIR, DIRECTORY_CONFIG_PATH and WEB_ROOT in $PREFIX/.env for $PREFIX"
        return 0
    fi
    local tmp
    tmp="$(mktemp)"
    # `|` as the delimiter because the substitution is a path and every path has `/` in it; the
    # literal is `UNIT_PREFIX`, the same one `render_unit` rewrites.
    if ! sed -e "s|^DATA_DIR=$UNIT_PREFIX/data\$|DATA_DIR=$PREFIX/data|" \
             -e "s|^DIRECTORY_CONFIG_PATH=$UNIT_PREFIX/data/directory.json\$|DIRECTORY_CONFIG_PATH=$PREFIX/data/directory.json|" \
             -e "s|^WEB_ROOT=$UNIT_PREFIX/public\$|WEB_ROOT=$PREFIX/public|" \
             "$PREFIX/.env" > "$tmp"; then
        rm -f "$tmp"
        die "could not read $PREFIX/.env to render its paths for this host. Nothing was changed."
    fi
    # `cp` onto the file rather than `install`: the seeder above already gave it the deployment's
    # account as owner and 0600, and `cp` onto an existing file keeps both. An `install -o … -g …`
    # here would restate the same two facts and be the only place in these scripts that needs an
    # account with a group of its own name on the machine reading a `--dry-run`-adjacent path.
    if ! cmp -s "$PREFIX/.env" "$tmp"; then
        run cp "$tmp" "$PREFIX/.env"
    fi
    rm -f "$tmp"
}

# Whether the wizard can be given answers at all, before anything is written, so the refusal
# costs nothing. `--answers` is the unattended path and `--browser` is the wizard's own front
# end; otherwise a person has to be at a terminal, which is the one thing the wizard cannot
# supply for itself. With none of the three this refuses rather than starting a wizard that
# would write a `.env` it cannot complete — the half-install every refusal in `install.sh`
# exists to prevent. `--no-ask` is the wizard's own form of this refusal, passed below whenever
# stdin is not a terminal.
require_setup_answers() { # require_setup_answers <answers-file-or-''> <browser-or-''>
    if [ -n "$1" ] || [ -n "$2" ]; then
        # The wizard runs as the deployment's account, so an answers file root can read and that
        # account cannot — `/root/answers.json` mode 0600, which is how secrets are kept — would
        # reach the wizard as "No answers file at …". Said here with that reason, before the run.
        if [ -n "$1" ] && [ "$DRY_RUN" != '1' ] && [ "$(id -un 2>/dev/null || true)" != "$CROSSBAR_USER" ]; then
            if ! runuser -u "$CROSSBAR_USER" -- test -r "$1" 2>/dev/null; then
                die "$1 is not readable by $CROSSBAR_USER, and the wizard runs as that account, which is what owns the files it writes. Give it read access (its answers include secrets, so 0640 and a shared group, or 0600 owned by $CROSSBAR_USER), or run \`node src/admin.js setup\` by hand as that account. Nothing was installed."
            fi
        fi
        return 0
    fi
    if [ ! -t 0 ]; then
        die "there is no --answers file, no --browser front end and no terminal on stdin, so the setup wizard has nothing to answer it with and the directory file the server needs would not be written. Pass --answers <file> (\`node src/admin.js setup --help\` lists every key), run this from a terminal, or pass --no-setup and write the directory file by hand (deploy/README.md §2.4). Nothing was installed."
    fi
}

# The wizard, run in `$PREFIX` and as the deployment's own account: it reads the deployment it
# is working on from the process's working directory (`runSetup({ dir: process.cwd() })`), and
# the `.env` and directory file it writes belong to that account, not to root.
#
# `--no-ask` is passed whenever stdin is not a terminal so the intent is in the printed command
# rather than only in the wizard's own guard; a run that still cannot answer refuses with the
# names it is missing, which the failure below carries up.
run_setup_wizard() { # run_setup_wizard <answers-file-or-''> <browser-or-''>
    local answers="$1" browser="$2"
    require_setup_answers "$answers" "$browser"
    set -- src/admin.js setup
    if [ -n "$answers" ]; then set -- "$@" --answers "$answers"; fi
    if [ -n "$browser" ]; then set -- "$@" --browser; fi
    if [ ! -t 0 ]; then set -- "$@" --no-ask; fi
    if [ "$DRY_RUN" = '1' ]; then
        would_run "cd $PREFIX && $NODE_BIN $*"
        return 0
    fi
    # A subshell for the change of directory: everything after it — the probes, the writers —
    # resolves against the deployment, and the installer's own working directory is not changed
    # under the rest of the script.
    if ! ( cd "$PREFIX" && run_as_user "$NODE_BIN" "$@" ); then
        die "the setup wizard did not finish, so the directory file it writes is not in place and nothing else was installed. Its own message above says what it was missing; --answers <file> answers all of it in one go, and deploy/README.md §2.3–§2.4 is the by-hand path. What is already under $PREFIX is left as it is."
    fi
}

# The mode named in an answers file, for the dry run's benefit only: the real run reads what the
# wizard wrote. Empty when there is no file, when it does not parse, or when it names no mode —
# and the plan below then says what would follow either.
answers_mode() { # answers_mode <file-or-''>
    if [ -z "$1" ]; then return 0; fi
    "$NODE_BIN" -e 'try { const held = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(typeof held.mode === "string" ? held.mode : ""); } catch (error) { /* the wizard says what is wrong with the file, not this */ }' "$1" 2>/dev/null || true
}

# The public door: Caddy, the drop-in that hands it the same `.env` the server reads, the
# Caddyfile, and a validation of the result. Only for a deployment whose public block the wizard
# filled in, and only as root — this is `apt` and `/etc`.
#
# Nothing here starts Caddy. `crossbar-public.service` does, on every `systemctl restart
# crossbar` while public mode is in force, and it is the unit that owns the door in both
# directions (`crossbar-private.service` stops it after the grace window). A start here would be
# a second answer to "which mode is this box in", and the answer that disagrees.
install_public_front_door() { # install_public_front_door
    local dropin='/etc/systemd/system/caddy.service.d/crossbar-env.conf' tmp hostname bind
    if command -v caddy >/dev/null 2>&1; then
        say 'caddy is already installed'
    elif ! run apt-get install -y caddy; then
        die "apt could not install Caddy, and public mode is reached through it. Install it by hand (deploy/README.md §2.8 — its own package repository), then run this again: this step is re-applied, and nothing else about the deployment needs redoing."
    fi

    # A drop-in rather than an edit of the package's unit: an upgrade of Caddy replaces its unit
    # and would take an edit with it, and this is a file the installer can state and read back.
    tmp="$(mktemp)"
    {
        printf '[Service]\n'
        printf '# Crossbar: the values Caddy reads come from the same file the server reads, so there is\n'
        printf '# one copy of each. Written by scripts/install.sh; deploy/README.md §2.8 is the by-hand form.\n'
        printf 'EnvironmentFile=%s/.env\n' "$PREFIX"
    } > "$tmp"
    run install -D -m 0644 "$tmp" "$dropin"
    rm -f "$tmp"

    if [ "$DRY_RUN" != '1' ] && [ ! -f "$PREFIX/deploy/Caddyfile" ]; then
        die "there is no $PREFIX/deploy/Caddyfile to install: the tree at $PREFIX is not one this installer copied. deploy/README.md §2.8 is the by-hand version."
    fi
    run install -D -m 0644 "$PREFIX/deploy/Caddyfile" /etc/caddy/Caddyfile
    # Before the validation, because `caddy validate` is a separate process reading the file
    # systemd would give the service, and the drop-in is only live after a reload.
    run systemctl daemon-reload

    # The Caddyfile expands the public hostname and the address to bind. The generated section of
    # `.env` carries them only for the mode *in force*, so a `both` deployment being installed as
    # private has an empty `CROSSBAR_BIND_ADDRESS` there even though its public block names one:
    # validated against the public block's own values, which is what Caddy is handed whenever the
    # public door is the one open.
    hostname="$(env_value NETWORK_MODE_PUBLIC_HOSTNAME)"
    bind="$(env_value CROSSBAR_BIND_ADDRESS)"
    if [ -z "$bind" ]; then bind="$(env_value NETWORK_MODE_PUBLIC_BIND_ADDRESS)"; fi
    if [ -z "$hostname" ]; then hostname='<the public hostname the wizard writes>'; fi
    if [ -z "$bind" ]; then bind='<the public bind address the wizard writes>'; fi
    if ! run env CROSSBAR_PUBLIC_HOSTNAME="$hostname" CROSSBAR_BIND_ADDRESS="$bind" \
            PORT="$(deployment_port)" caddy validate --config /etc/caddy/Caddyfile; then
        die "Caddy is installed but its Caddyfile does not validate for $hostname, so public mode's shaper unit would start a proxy that cannot render it. Fix /etc/caddy/Caddyfile (deploy/README.md §2.8), or run with --no-setup and install the front door by hand."
    fi
    say "Caddy is installed, its Caddyfile validates for $hostname, and the drop-in gives it $PREFIX/.env."
    say "Public mode's shaper unit starts it when the units are installed and the service restarted"
    say "below; a deployment installed as private has Caddy ready and stopped until the switch. DNS,"
    say "the port forwards and the firewall are §8."
}

# The private door is Tailscale's, and its login is an interactive browser flow that belongs to
# the person: this install can do nothing about it and must not pretend otherwise. Said here
# rather than left to the next-steps list, because a private deployment whose box is not logged
# in has no door at all and nothing on the box can open one.
report_private_front_door() { # report_private_front_door
    say 'Private mode is reached through `tailscale serve`, and Tailscale'\''s own login is an'
    say 'interactive browser flow that belongs to the person, not to this install:'
    say '    sudo tailscale up            # prints the login URL; this box joins the tailnet as whoever approves it'
    say '    tailscale status             # says who this box is, before anybody is invited'
    say 'The private shaper unit runs `tailscale serve --bg <port>` on every start, so the route'
    say 'itself needs nothing here once the box is logged in (deploy/README.md §2.8, §8.1).'
}

# The front door for the modes the wizard set up. Which those are is read from the file it just
# wrote — a chosen mode's block names its hostname (`ADDRESS_QUESTIONS` in `src/setup.js` fills
# one for every mode it is asked to set up) — so there is one answer to "what was chosen" and no
# second copy to drift. A dry run has no file yet: the answers file names the mode when one was
# given, and where it does not, the plan says what would follow either.
install_front_door() { # install_front_door <answers-file-or-''>
    local public='' private='' mode=''
    if [ "$DRY_RUN" = '1' ]; then
        mode="$(answers_mode "$1")"
        case "$mode" in
            private) private=1 ;;
            public) public=1 ;;
            *) public=1; private=1 ;;
        esac
        say "the front door, for the modes the wizard sets up${mode:+ ($mode)}:"
    else
        if [ -n "$(env_value NETWORK_MODE_PUBLIC_HOSTNAME)" ]; then public=1; fi
        if [ -n "$(env_value NETWORK_MODE_PRIVATE_HOSTNAME)" ]; then private=1; fi
    fi
    if [ -n "$public" ]; then install_public_front_door; fi
    if [ -n "$private" ]; then report_private_front_door; fi
}

# The phase. `--answers` and `--browser` are the installer's passthroughs to the wizard; the
# front door follows what the wizard wrote rather than what was asked for, so a mode that was
# not set up installs nothing for it.
onboard_deployment() { # onboard_deployment <answers-file-or-''> <browser-or-''>
    run_setup_wizard "$1" "$2"
    install_front_door "$1"
}
