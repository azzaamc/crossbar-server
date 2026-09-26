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
#     against a scratch prefix on a machine with no systemd. The private door is part of that
#     contract: Tailscale is installed, and the login is **run** — `tailscale up` prints a link and
#     waits for the machine to be approved — rather than left to the person, with the name that
#     login gives the machine (`--hostname`, defaulted from `--prefix` by
#     `deployment_tailscale_hostname`) read back and used to correct the private address the wizard
#     wrote. The command that name is read through is the variable `TAILSCALE_BIN`, so the decision
#     is testable without Tailscale — and the login command itself goes there too.
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

# A step whose argument is a secret: printed with the value replaced, because a `--dry-run`
# transcript is a thing people paste, and a credential in it is a credential leaked. `TS_AUTHKEY`
# is also how `tailscale up` itself prefers to be handed a key — off the command line, so it is
# not in the process list either.
run_secret() { # run_secret <VAR> <value> <command...>
    local var="$1" value="$2"
    shift 2
    printf '  $ %s=<hidden> %s\n' "$var" "$*"
    if [ "$DRY_RUN" = '1' ]; then
        return 0
    fi
    env "$var=$value" "$@"
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

# A tailnet name is not decoration: it is the first label of the private address
# (`<name>.<tailnet>.ts.net`), which is what `.env` holds and what an invitation carries, so it has
# to be a hostname — lowercase letters, digits and '-', and not starting or ending with one. A name
# the person spelled is *refused* rather than reduced: they have a name in mind, and answering with
# a different one is how an address nobody chose ends up in `.env`. (The name derived from a prefix
# is reduced instead, because a directory name is not something anybody spelled as a hostname —
# see `deployment_tailscale_hostname`.)
require_tailscale_hostname() { # require_tailscale_hostname <value>
    case "$1" in
        ''|[!a-z0-9]*|*-|*[!a-z0-9-]*) die "--tailscale-hostname must be a hostname — lowercase letters and digits, with '-' inside but not at either end — and '$1' is not: this name becomes the first label of the private address, which is the address an invitation carries" ;;
    esac
    if [ "${#1}" -gt 63 ]; then
        die "--tailscale-hostname is longer than 63 characters, which is more than one DNS label can be, and the private address is built from it"
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
        # Nothing has joined the tailnet yet at this point — the private door is the step after this
        # one — so the message is only about the wizard: what it writes is missing and no unit has
        # been installed, and the run is re-appliable once the answers are supplied.
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

# The command these steps run for Tailscale. `tailscale` on PATH is the real one; a test — or a
# host whose binary lives elsewhere — sets the variable to a stand-in, the same seam
# `src/setup.js`'s `tailnetName(command)` and `src/diagnostics.js`'s `checkTailscale(config,
# command)` take as a parameter rather than reaching for `tailscale` themselves.
TAILSCALE_BIN="${TAILSCALE_BIN:-tailscale}"

# The name the login gives this machine in the tailnet. `install.sh` sets it — it derives the
# default from `--prefix`, and `--tailscale-hostname` overrides it — and the library reads it the
# way it reads `PREFIX` and `CROSSBAR_USER`. Empty means "do not name the node", which is what a
# caller that gave none gets: `tailscale up` then keeps whatever name the host already had. The
# name is not cosmetic — the login names the node, `Self.DNSName` answers it, and that address is
# what an invitation carries — which is why the default is the deployment's own name rather than
# the host's.
TAILSCALE_HOSTNAME=''

# The deployment's own name, as a tailnet name: the basename of the prefix, because a person who
# installs at `/home/admin/crossbar-dev` calls it `crossbar-dev`, and that is the address their
# phones should dial — not `srv2011992`, which is what a VPS provider happened to call the host.
#
# Reduced to a DNS label rather than used raw, because a directory name and a hostname are not the
# same language: `require_path` allows capitals, `_` and `.`, and none of those is what Tailscale
# answers at — a `.` would make the address `my.box.<tailnet>.ts.net`, a name nobody asked for, and
# `_` is not in a hostname at all. So every run of anything else becomes one `-`, the ends are
# trimmed (a label may not start or end with one) and 63 characters is as long as a label can be.
deployment_tailscale_hostname() { # deployment_tailscale_hostname <prefix>
    local name=''
    name="$(basename "$1" | tr '[:upper:]' '[:lower:]' \
        | sed 's/[^a-z0-9][^a-z0-9]*/-/g; s/^-*//; s/-*$//' | cut -c1-63 | sed 's/-*$//')"
    printf '%s' "${name:-crossbar}"
}

# This machine's tailnet name, from the same field the wizard derives the private address from:
# `tailscale status --json`'s `Self.DNSName`, with the trailing dot dropped. Empty when Tailscale
# cannot answer — not installed, not running, or not logged in — which is an ordinary state here
# rather than a failure: the login may not have happened yet.
#
# A read, so a dry run makes it (`answers_mode` and `env_value` are read in a dry run for the same
# reason): the front-door transcript then says which name the machine answers at and whether
# `.env` agrees, which is the whole of the check below. The timeout is `src/setup.js`'s
# `TAILSCALE_TIMEOUT_MS`: the daemon answers from its socket or not at all.
tailnet_name() {
    "$NODE_BIN" -e 'const { execFileSync } = require("node:child_process"); try { const status = JSON.parse(execFileSync(process.argv[1], ["status", "--json"], { encoding: "utf8", timeout: 4000 })); process.stdout.write(String((status.Self || {}).DNSName || "").replace(/\.$/, "")); } catch { /* not installed, not running, or not logged in */ }' "$TAILSCALE_BIN" 2>/dev/null || true
}

# Set once Tailscale is installed and `tailscaled` is up, so the install's final report knows the
# private door was part of this run even when the login did not finish.
TAILSCALE_READY=''

# How the login in `install_private_front_door` ended, for the report that follows it: `already`
# (the machine was logged in before this run), `ran` (the login was run here and finished), `failed`
# (it was run here and did not finish — declined, or it timed out), `no-terminal` (there was no
# terminal to show Tailscale's link, so it was not attempted), or empty (not attempted at all).
TAILSCALE_LOGIN=''

# Tailscale itself, installed, with `tailscaled` enabled and started. Split from the login below
# because the two fail differently: this one is what private mode cannot run without, so it refuses
# when it cannot be installed, while the login is attempted and reported.
#
# Enabled and started here rather than left to the login: tailscaled is what the private shaper
# unit talks to on every start, and a box that reboots without it has no tailnet door.
install_tailscale() {
    if command -v "$TAILSCALE_BIN" >/dev/null 2>&1; then
        say 'tailscale is already installed'
    else
        say 'installing Tailscale from its official install script (which adds its own package repository)'
        if ! run_pipe 'curl -fsSL https://tailscale.com/install.sh | sh'; then
            die "Tailscale could not be installed, and private mode is reached through it. Install it by hand (https://tailscale.com/download/linux), then run this again: this step is re-applied, and nothing else about the deployment needs redoing."
        fi
    fi
    if ! run systemctl enable --now tailscaled; then
        die "tailscaled could not be enabled and started, and private mode is reached through it. The command above says why; a host whose Tailscale came without a systemd unit needs it started by whatever manages services there. Nothing else about the deployment needs redoing."
    fi
    TAILSCALE_READY=1
}

# The private door: Tailscale installed, `tailscaled` up, this machine logged in, and — through
# `Self.DNSName` — the name the private address is read back from.
#
# The login is **run here**, not left to the person. `tailscale up` prints a link and waits for the
# machine to be approved; on a headless host that link is the whole of the interaction, and it
# belongs in this terminal where the person can see it. Only when there is no terminal is it not
# attempted at all: with nowhere to show a link and nobody to approve it, the run prints the
# command instead (`report_private_front_door`).
#
# A key needs no terminal: `TS_AUTHKEY` joins the machine outright, so a keyed run attempts the
# login whether or not one is present — that is what the key is for. It is handed over in the
# environment rather than argv, so it appears in neither the process list nor the transcript.
#
# `--operator=$CROSSBAR_USER` is what makes the login *readable* afterwards. On Linux the daemon
# is root's, and Tailscale's own Linux operator-permission note is that only root manages it until
# a user is named the operator — so `tailscale status` answers for nobody else. The two things
# that ask are the wizard, which derives the private address from `tailscale status --json` while
# running as the deployment's account, and `doctor`, which runs `tailscale serve status` as it.
# Without the operator the machine joins the tailnet and that account still cannot see the name
# the private block has to hold.
#
# `--hostname` is the other half of what this login is for. A login that names nothing joins under
# the host's own name — on a VPS `srv2011992`, assigned by the provider — and that is the name an
# invitation would carry: the one nobody chose. So the name goes on the command, from
# `TAILSCALE_HOSTNAME` (defaulted by `install.sh` to the deployment's own name):
#
#     tailscale up --operator=admin --hostname crossbar-dev
#     → crossbar-dev.tailea67b0.ts.net, the name this deployment is known by.
#
# Nothing here fails the install. A declined, timed-out or failed login leaves Tailscale installed
# and `tailscaled` running with everything else, `TAILSCALE_LOGIN` says which it was, and the report
# below prints the command left for a person — the deployment is re-appliable, and re-running it
# after the login is how the address the wizard wrote is corrected.
install_private_front_door() { # install_private_front_door <authkey-or-''>
    local authkey="$1" name=''
    install_tailscale
    # Already logged in — from an earlier run, the host's own setup, or a keyed login — so there is
    # nothing to do but read the name back. `tailscale up` on a joined machine is a no-op at best
    # and a re-auth at worst.
    name="$(tailnet_name)"
    if [ -n "$name" ]; then
        TAILSCALE_LOGIN='already'
        return 0
    fi
    # No key and no terminal: the login cannot be answered, so it is not attempted. `-t 0` is the
    # same test the wizard uses to decide whether it can ask at all.
    if [ -z "$authkey" ] && [ ! -t 0 ]; then
        TAILSCALE_LOGIN='no-terminal'
        return 0
    fi
    set -- "$TAILSCALE_BIN" up "--operator=$CROSSBAR_USER"
    if [ -n "$TAILSCALE_HOSTNAME" ]; then
        set -- "$@" --hostname "$TAILSCALE_HOSTNAME"
    fi
    if [ -n "$authkey" ]; then
        if run_secret TS_AUTHKEY "$authkey" "$@"; then TAILSCALE_LOGIN='ran'; else TAILSCALE_LOGIN='failed'; fi
    else
        say "logging this machine in: \`$TAILSCALE_BIN up\` prints a link to approve this machine, here."
        if run "$@"; then TAILSCALE_LOGIN='ran'; else TAILSCALE_LOGIN='failed'; fi
    fi
}

# The login command a person is left when this installer could not finish it — written once so the
# front door's report and the install's final report cannot drift apart, and it is the *same*
# command `install_private_front_door` runs, `--hostname` included: a person who runs it joins under
# the deployment's name rather than the provider's, and re-running the installer then finds the
# machine already at the address it wanted.
tailnet_login_command() {
    if [ -n "$TAILSCALE_HOSTNAME" ]; then
        printf '%s' "$TAILSCALE_BIN up --operator=$CROSSBAR_USER --hostname $TAILSCALE_HOSTNAME"
    else
        printf '%s' "$TAILSCALE_BIN up --operator=$CROSSBAR_USER"
    fi
}

# What is left when the login did not happen: the exact command, what it will do, and that
# re-running this installer finishes the job by itself. Brief on purpose — a runbook reference is
# not an instruction, and deploy/README.md §2.8.1 is there for anyone who wants the detail. Printed
# by both the front door's report and the install's final report, so the two cannot drift.
tailnet_login_instructions() {
    say "    sudo $(tailnet_login_command)"
    say 'That prints a link and waits: open it and approve this machine. Then run this installer'
    say 'again — it reads the name the machine answers at and sets the private address from it,'
    say 'so nothing has to be guessed.'
}

# What the machine answers at, read back once the wizard has written the private block and the
# login above has been attempted: the name the tailnet gives this machine. Also where a
# disagreement with `.env` is caught — `NETWORK_MODE_PRIVATE_HOSTNAME` and its origin are what an
# invitation carries, so a name that is not this machine's own is an invitation that opens nowhere
# rather than a cosmetic slip.
#
# When there is no name, the login is what is left, and `TAILSCALE_LOGIN` says which way it was not
# done — not attempted for want of a terminal, or attempted here and unfinished. Either way the
# person gets the one command and the install goes on: the deployment is up, and one missing login
# is not a reason to call it unfinished.
report_private_front_door() { # report_private_front_door <authkey-or-''>
    local authkey="$1" name=''
    name="$(tailnet_name)"
    if [ -n "$name" ]; then
        say "this machine is on the tailnet as $name"
    else
        case "$TAILSCALE_LOGIN" in
            no-terminal)
                say 'One step here is still a person'\''s: the login, which approves this machine in a'
                say 'browser. There is no terminal here to show Tailscale'\''s link, so it was not run:'
                ;;
            failed)
                say 'The login was run here and did not finish — declined, or it timed out.'
                say 'Everything else is installed; approve this machine when you can:'
                ;;
            *)
                say 'One step here is still a person'\''s: the login, which approves this machine in a browser.'
                ;;
        esac
        tailnet_login_instructions
        say "That names $CROSSBAR_USER the tailnet operator, which is what lets the wizard and doctor"
        say 'read this machine'\''s name; both run as that account. Pass --tailscale-authkey <key> to a'
        say 'run of this installer to join without the browser; the key reaches Tailscale through'
        say 'TS_AUTHKEY, so it is printed nowhere.'
        if [ -n "$authkey" ]; then
            warn 'tailscale up was given --tailscale-authkey and this machine still reports no tailnet name:'
            warn "check \`$TAILSCALE_BIN status\`, and that the key is valid and belongs to this tailnet."
        fi
    fi
    offer_private_hostname_correction "$name"
    say 'The private shaper unit runs `tailscale serve --bg <port>` on every start, so once this'
    say 'machine is joined the route needs nothing more (deploy/README.md §2.8, §8.1).'
}

# A private block that does not name this machine is an address nobody can dial, and the question
# that wrote it was asked before the login had happened: on a first install the machine is not
# logged in yet, so the person answers from what they expect — or leaves it blank, which is allowed
# because the block needs only its origin to start. This is where that answer is caught and
# corrected, after the login, when `tailscale status` can finally answer.
#
# Corrected through the wizard, not a second writer: `run_setup_wizard_correction` runs it once
# more with the machine's own name, and it keeps the mode, every other address, the people and
# every secret from the files it wrote, so `.env` ends up right in one call.
#
# Nothing when the two already agree, and nothing when Tailscale cannot answer: a machine that is
# not logged in has no name to correct to, and the report above says so and names the one command
# left instead.
offer_private_hostname_correction() { # offer_private_hostname_correction <name-or-''>
    local name="$1" configured=''
    if [ -z "$name" ]; then return 0; fi
    configured="$(env_value NETWORK_MODE_PRIVATE_HOSTNAME || true)"
    if [ "$configured" = "$name" ]; then return 0; fi
    if [ -n "$configured" ]; then
        say "the private address in .env is $configured, and this machine answers at $name:"
    else
        say "no private address is set in .env yet, and this machine answers at $name:"
    fi
    say 'an invitation carries that address, so it has to be this machine'\''s own tailnet name.'
    say "Running the wizard again with $name; every other answer, and every secret, is kept."
    run_setup_wizard_correction "$name"
}

# The wizard again with one answer changed and no question asked. `--no-ask` is what makes this a
# correction rather than a second setup: the mode, every address but the private one, the people
# and every secret come from the `.env` and the directory file the first run wrote (`readState` in
# `src/setup.js`), and the two finishing steps — the console password and the first invitation —
# are left alone, which a correction must do rather than re-run `admin.js password`.
#
# The origin is passed with the hostname rather than left to the wizard, whose derivation applies
# only when the file holds no origin at all: correcting a hostname whose origin was derived from it
# would otherwise leave the old origin in place, and the origin is the half an invitation carries.
# A failure warns with the two lines instead of stopping: the deployment is up, and one wrong name
# is not a reason to call the whole install unfinished.
run_setup_wizard_correction() { # run_setup_wizard_correction <hostname>
    local hostname="$1"
    if [ "$DRY_RUN" = '1' ]; then
        would_run "cd $PREFIX && $NODE_BIN src/admin.js setup --no-ask --private-hostname $hostname --private-origin https://$hostname"
        return 0
    fi
    if ! ( cd "$PREFIX" && run_as_user "$NODE_BIN" src/admin.js setup --no-ask \
            --private-hostname "$hostname" --private-origin "https://$hostname" ); then
        warn "the wizard could not be re-run, so $PREFIX/.env still holds the private address it was"
        warn 'given. Set these by hand and restart the service (deploy/README.md §2.3, §2.8.1):'
        warn "    NETWORK_MODE_PRIVATE_HOSTNAME=$hostname"
        warn "    NETWORK_MODE_PRIVATE_ORIGIN=https://$hostname"
    fi
}

# The front door for the modes the wizard set up. Which those are is read from the file it just
# wrote — a mode that is configured is one whose block names what that mode needs to start
# (`MODE_REQUIRED` in `src/config.js`), which for private is its ORIGIN: the private hostname is not
# read in that mode at all, and on a fresh box the person may well have left it blank for the
# installer to fill in from the machine's own tailnet name. So there is one answer to "what was
# chosen" and no second copy to drift. A dry run has no file yet: the answers file names the mode
# when one was given, and where it does not, the plan says what would follow either.
install_front_door() { # install_front_door <answers-file-or-''> <authkey-or-''>
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
        if [ -n "$(env_value NETWORK_MODE_PRIVATE_ORIGIN)" ] || [ -n "$(env_value NETWORK_MODE_PRIVATE_HOSTNAME)" ]; then private=1; fi
    fi
    if [ -n "$public" ]; then install_public_front_door; fi
    if [ -n "$private" ]; then
        # Tailscale installed, `tailscaled` up, and the login run here: the wizard's question about
        # the private address was answered before this point, on a box that may not have had a
        # tailnet name to offer, so the report that follows reads the machine's own name back and
        # corrects what the wizard wrote.
        install_private_front_door "$2"
        report_private_front_door "$2"
    elif [ -n "$2" ]; then
        # A key with no private mode to use it on: nothing here serves through the tailnet, so the
        # key bought nothing. Said rather than left to look like a login the deployment needs.
        warn '--tailscale-authkey was given, but no private mode was set up: this deployment does not serve through the tailnet, and the key was not used.'
    fi
}

# The phase, in the order its two halves need. `--answers` and `--browser` are the installer's
# passthroughs to the wizard; the front door follows what the wizard wrote rather than what was
# asked for, so a mode that was not set up installs nothing for it.
#
# The wizard goes first because the *mode* it asks for is what decides whether there is a private
# door at all — the installer cannot know whether Tailscale is wanted before that question is
# answered. The private address is a guess at that point, because the login that gives the machine
# its tailnet name has not happened yet (`tailnetName` in `src/setup.js` is asked while the wizard
# runs, and before a login it has no name to offer); the front door's report reads the machine's own
# name back after the login and corrects `.env` with the wizard itself, so the order costs nothing
# and the address ends up right by construction.
onboard_deployment() { # onboard_deployment <answers-file-or-''> <browser-or-''> <authkey-or-''>
    run_setup_wizard "$1" "$2"
    install_front_door "$1" "$3"
}
