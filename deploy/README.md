# Running a Crossbar deployment

Crossbar is one Node process and one SQLite file. What runs it is in this directory: the
systemd units, the Caddyfile that fronts it in public mode, the coturn template for a relay,
and this document — which is the runbook for the three things an operator does to a live
deployment (switch modes, back it up and restore it, upgrade and roll back), and the
step-by-step for installing a second household.

> **Verification status — 2026-09-26.**
>
> Written by reading the code and the unit files. The integration owner has since **run it on
> production** — a real box, a real tailnet, a real public hostname — and what that measured is
> recorded with each claim below and in §3.4. Still **not** verified:
>
> - ~~the unit files at all~~ — `sudo systemd-analyze verify` is clean on all of them, and both
>   modes have been switched against the live deployment: `crossbar-private`, `crossbar-public`,
>   both grace units, `caddy` and `crossbar-turn` were each observed doing their job, including
>   the relay's realm following the mode. `scripts/rehearse-switch.sh` has still never been
>   executed anywhere — it says on its first line not to run it on a deployment anybody is using,
>   which is now the reason not to;
> - ~~the switch overlap in a running box (§3.4)~~ — **measured on production, 2026-09-26**: the
>   new door opened before the old one closed, both doors answered for the whole window, the
>   close fired from its own timer, and the guard refused a stale grace left over from the other
>   mode. §3.4 records the responses;
> - whether a switch made from the **console** (§3.1) reshapes the box. The console exits the
>   process for systemd's `Restart=always` to start again rather than running
>   `systemctl restart`, and whether that re-runs the two shaping units is not established
>   here. What was measured is the writer the console's switch goes through, under the unit's own
>   hardening and as the service user — it succeeds (§3.2). The route itself has not been driven
>   end to end, because that needs a browser session;
> - the backup timer firing, and the restore in §4.4 being rehearsed. `runBackup` is covered
>   by tests in this tree; the unit wiring and the restore were not;
> - ~~`origin` in `GET /api/health`~~ (§3.5) — present and in use: a real device compared it,
>   adopted the new origin and kept its device key, across both directions of a switch;
> - the four distribution scripts (`scripts/install.sh`, `release.sh`, `upgrade.sh`,
>   `uninstall.sh`). `bash -n` is clean on all of them and every `--dry-run` was read on macOS —
>   where there is no systemd, so a real run refuses at that check and says so. The tarball in
>   §5.1 was built for real and its checksum verified, and the parts of `upgrade.sh` that decide
>   the verdict (`/api/health` over loopback, the version field, and the failure direction) were
>   exercised against a stub. **No install, upgrade or uninstall has been run on a Linux host**:
>   that is the rehearsal host, and §2.10 and §5.1 list what to check there;
> - the installer's **onboarding phase** — the Tailscale preparation, the setup wizard and the front
>   door it installs (§2.2.1, `scripts/lib/deploy.sh`). `bash -n` is clean on both the script and the
>   library; `--dry-run` was read on macOS against a scratch prefix and prints the whole phase (the
>   Tailscale step before the wizard — the vendor install line when the binary is absent,
>   `systemctl enable --now tailscaled`, `tailscale set --operator=<account>` — then the wizard
>   command with `TAILSCALE_HOSTNAME=<name>` in its environment and `TS_AUTHKEY=<hidden>` when a key
>   was given, the directory file it writes, and the front door plan for the mode the answers file
>   names) while creating nothing. The phase's own functions were then driven against scratch
>   prefixes with a real Node 22: with `--answers` they wrote a complete tree — the private block in
>   `.env`, a generated 64-hex session secret, `DATA_DIR`/`DIRECTORY_CONFIG_PATH` rendered for the
>   scratch prefix, and `data/directory.json` with one administrator — a second run kept the session
>   secret and rewrote the same directory file, and with no answers and no terminal the phase
>   refused, named `--answers`, and wrote no directory file.
> - **the wizard's join**, which is the part of this the owner asked for, and the one thing here
>   that is exercised inside a real pseudo-terminal: with `tailscale` on `PATH` as a stand-in whose
>   daemon has no `Self.DNSName` until its own `up` is run, the real wizard under a pty showed the
>   mode question (answered *Both*) → the join running in the foreground and printing its approval
>   link → the machine's own name read back → the private `HOSTNAME` field holding
>   `crossbar-dev.tailea67b0.ts.net` as a value to confirm, with `ORIGIN` derived from it, and the
>   file written from those answers. `test/setup-finish.test.js` covers both directions of it: the
>   join runs before the address question and the name it got is what is offered and written, and a
>   join that does not finish leaves the question reading as it always did — the address typed, not
>   invented — with the command, what it does and what to do after printed beside it. The library's
>   own invocation was driven **for real** as well, not only printed: `run_setup_wizard` against a
>   scratch prefix with a stand-in `tailscale` on `PATH` and a key, which ran the child as
>   `TS_AUTHKEY=<hidden> env TAILSCALE_HOSTNAME=crossbar-dev <node> src/admin.js setup …`, joined
>   through the stand-in (`up --hostname crossbar-dev`, then `status --json` to read the name back),
>   and wrote `NETWORK_MODE_PRIVATE_HOSTNAME=crossbar-dev.tailea67b0.ts.net` into `.env`. That run
>   is also what shows the child's argv is executable rather than merely printed: `--dry-run` prints
>   a composed line, not the argv. `test/install-order.test.js` covers the phase end to end through
>   `scripts/install.sh`: Tailscale installed,
>   started and its operator named before the wizard, the key and the node's name travelling to the
>   wizard in its environment and nowhere else, the front door's login attempted with a terminal or
>   a key and not with neither, a login that fails leaving the install standing with the instruction
>   block printed, a finished login reading the machine's own name back and correcting `.env`
>   through the one `--no-ask` wizard run, and an agreeing name printing neither.
> - **the dev VPS** (`crossbar-dev-vps`, a real Debian host with a real `tailscaled`), driven over
>   ssh for the one claim the whole design rests on: `sudo -u admin tailscale status --json` answers
>   the deployment account with `BackendState: NeedsLogin` and no `DNSName`, and `sudo -u admin
>   timeout 15 tailscale up --hostname crossbar-join-probe` — the wizard's own command, as that
>   account — printed a real `https://login.tailscale.com/a/…` link and was killed by the timeout
>   (exit 124) with the daemon left in `NeedsLogin`, no CLI process left running, and nothing
>   approved. Also checked there: `setup --operator=admin` is idempotent on a daemon already in that
>   state, which is what the installer's step runs every time.
>   **What that does not cover is the real thing end to end**: no full Linux install, so `npm ci`,
>   the units, `/api/health`, the Caddy install and `caddy validate`, and an *approved* Tailscale
>   login were never run — §2.10 is the list;
> - **the APNs key's blast radius and what to do when it leaks** (§2.7) — written from Apple's
>   documentation, not measured on a deployment: no key here has been revoked or rotated, so the
>   procedure is Apple's instruction restated rather than a rehearsal, and it is worth the trust
>   Apple's own help pages get. The file mode and owner it asks for (0600, the deployment's own
>   account) is this repository's convention for the other two credentials — `.env` and the
>   directory file — not a posture a deployment was watched enforcing on a `.p8`;
> - **the relay ring path** (§2.7.1) — written from the relay's own documentation and source, and not
>   exercised end to end: the credential does not exist here, and a local relay cannot reach Apple at
>   all (its test runtime has no HTTP/2). What is measured is everything up to the wire —
>   `src/pushrelay.js` and its two call sites, against a stub relay, in `test/pushrelay.test.js`: the
>   request shapes, the derived per-device `request_id`, the refusal vocabulary, a `410` clearing the
>   token, and the credential appearing in no log line. Whether a deployed relay reaches APNs is
>   unverified by its own authors as well, so the live gate is a device that rings;
> - ~~the full server test suite on the merged tree~~ — 177 tests, 177 pass, 0 fail, 0 skipped,
>   the operator path's five and the `doctor` checks' five included.
>
> Everywhere a step depends on one of those, the text says so rather than reading as measured.

---

## 1. The shape of a deployment

Public mode is for a directory that is not on a tailnet and reaches Crossbar over the open
internet. The shape is one always-on host behind a home router:

```
client ── HTTPS/WSS :443 ──▶ Caddy ──▶ 127.0.0.1:3003   (the Crossbar server)
client ── STUN/TURN ──────▶ coturn :3478 + relay range  (media, only when it must be relayed)
```

Caddy terminates TLS and the Crossbar server keeps its loopback-only listener; the backend
is never exposed. The listener is forced: `HOST` other than `127.0.0.1`, `::1` or `localhost`
is refused at start-up with `HOST must remain loopback-only`. That is what lets the server
treat "the connection came from loopback" as "it came from the proxy", which is the
assumption both modes rest on.

Both modes run the same server, and what differs is which front door is open: Caddy in public
mode, and Tailscale serving that same loopback listener in private mode.

| | private | public |
| --- | --- | --- |
| The way in | `tailscale serve` on the tailnet | Caddy on the public hostname |
| Identity | the `Tailscale-User-Login` header, believed because it arrived from the local proxy | a per-device key; nothing in the request is believed |
| Required in `.env` | the tailnet block | `NETWORK_MODE_PUBLIC_HOSTNAME`, an origin naming it, `CROSSBAR_SESSION_SECRET` |
| Device key required | no (available if a secret is set) | yes |

The mode, not the door, decides the trust posture: in public mode the identity header is not
believed at all, and in private mode Caddy strips it from anything arriving from outside
(`Caddyfile`, the `request_header -Tailscale-User-*` block). **Both claims are specified and
are to be measured on a scratch host** — see §3.4.

---

## 2. Installing a second household

### 2.1 Host assumptions

- A Linux host with systemd and a fixed local address, which is where the software's
  assumptions end. Whether the ISP puts the connection behind CGNAT, whether the router
  forwards ports, whether the hostname resolves — **the software cannot see any of that**.
  §8 is the list of those facts.
- A non-root account that owns the checkout. Everything below assumes `admin` and
  `/home/admin/crossbar`, which is what the unit files in `deploy/` hard-code; a different user
  or path is what `scripts/install.sh --prefix … --user …` renders the units for (§2.5).
- **Node 22.5.0 or newer** (`package.json` `engines`). The server uses `node:sqlite`
  (`DatabaseSync`, `VACUUM INTO`), which does not exist in older Node. Check with
  `node --version` before anything else.

### 2.2 The checkout and its dependencies

```bash
sudo useradd --create-home --shell /bin/bash admin     # if the host has no such account
sudo -u admin git clone <this repository> /home/admin/crossbar
cd /home/admin/crossbar
npm ci --omit=dev
```

There is no build step: two runtime dependencies (`ws`, `web-push`) plus Node's own
`node:sqlite`, and nothing to compile.

**`scripts/install.sh` is §2.2–§2.6 as one command**, and is the path to prefer. It does the same
steps in the same order, with the refusals written down where they cannot be forgotten:

```bash
sudo scripts/install.sh --dry-run                          # every command, nothing run
sudo scripts/install.sh                                    # in place, as admin, at /home/admin/crossbar
sudo scripts/install.sh --prefix /home/other --user other   # a second household elsewhere
sudo scripts/install.sh --answers /root/answers.json        # unattended: the wizard is not asked anything (§2.2.1)
sudo scripts/install.sh --tailscale-authkey tskey-auth-…    # a private deployment: join the tailnet with no browser approval (§2.8.1)
sudo scripts/install.sh --no-setup                          # today's behaviour: write .env and the directory file by hand first
```

It renders the unit files' hardcoded paths for this host (§2.5), prepares Tailscale before anything
is asked — installed if it is absent, `tailscaled` started, and the deployment's account named the
daemon's operator, which is what lets the wizard join the tailnet itself (§2.8.1) — installs
dependencies as the account that owns the tree, runs the setup wizard to write the mode blocks, the
session secret and the directory file (§2.2.1), creates the data directory, enables the service
**and the backup timer**, and finishes by waiting for `/api/health` — so "installed" means answering
rather than "the files are in `/etc`". It also refuses on a host without systemd rather than
reporting success with no service; on macOS, where this was written, that refusal is the whole of a
real run.

Everything below is what it is doing, and what to do by hand if you would rather — or if a step
fails and you want to see it.

### 2.2.1 The setup wizard — what the installer now asks

`scripts/install.sh` no longer stops over a missing directory file. After running `npm ci` it runs
the deployment's own wizard, `node src/admin.js setup`, in `$PREFIX` and as the deployment's own
account — the account that owns the two files it writes. The wizard is **not** standard-library-only:
its public-mode checks load `src/diagnostics`, which requires `ws`, so the dependencies have to be
installed first — a host with no `node_modules` fails the phase with `Cannot find module 'ws'`.

What it asks, and where each answer lands:

| it asks | it writes |
| --- | --- |
| **how much of the wizard to walk** — Basic or Advanced (`--approach basic` or `--approach advanced` for the unattended path) | nothing: it decides which of the questions below are asked |
| which modes this deployment is reached in (`--mode private`, `public` or `both`) | one block per mode, `NETWORK_MODE_<MODE>_*` in `.env` |
| the hostname and origin of each mode, and the public bind address — the private one offered as this machine's own tailnet name, which the wizard joins the tailnet to get (§2.8.1) | the same block (§2.3) |
| who is in the directory — a display name per person, from which the id is derived | the directory file (§2.4) |
| the call relay, when it is not this server, and the relay a phone is rung through | `CROSSBAR_TURN_HOST` and `CROSSBAR_TURN_SHARED_SECRET`, `CROSSBAR_PUSH_RELAY_URL` |
| nothing about the session secret | it generates one, or keeps the one the file holds |
| whether to set the console password, and (advanced only) whether to invite somebody — both default yes, both at the end of a terminal run | the password hash and one invitation (§2.7), each made by its own command in the same terminal |

**Every question is one line, and the reasoning that used to be inside a question is here.**
A screen that shows the current step rather than a growing list is the reason: a question that
carries four lines of explanation cannot be redrawn in place, and a person who has already read
what a tailnet is does not need it again above the menu. What a question still has to say it
says in its own line; what it does not is in this section and in the summary the run ends with —
which is where a person reads what they got, including what a blank answer chose.

**The first question is how much of the wizard to walk.** *Basic* asks three things — the modes,
the people and the console password — and works out everything else a machine can: the private
address from the tailnet name the join read back, the public origin as the public name with
`https://` in front, the bind address from this host's own addresses (a globally routable one
preferred over a private one, because that is what a name can point at), the call relay as this
server, and the secrets by generating them. **The one address it still asks for is a public
name**, because a domain you own is a fact about that domain and nothing on the machine can
derive it; a run that needs one says so rather than inventing it. *Advanced* walks every step
with the same detection and the same auto-derived defaults as before, so Enter keeps taking the
suggested value. `--approach` chooses either way from a flag or from an `--answers` file, and with
no terminal and no answer the run is advanced — a run that was not told to be short must not
quietly derive.

**A person is named by their display name, and the id everybody else knows them by is derived
from it**: lower case, spaces become `-`, and nothing but lower-case letters, digits and `-`
survives — `O'Brien` is `obrien`, `Abdullah Al-Faisal` is `abdullah-al-faisal`. A name that
derives nothing is asked again, and the derived id is said back beside the question and named in
the summary, so nobody has to work out what they will be shown as. The id may still be given
outright in an `--answers` file or a `--people` file, which is what a script that needs a specific
id should do; the rule is `shortIdFrom` in `src/setup.js` and the same in every front end.

**The call relay is this server unless you say otherwise.** A call that cannot connect directly
is relayed through a TURN server, and the one this deployment can always reach is itself: its
public address in a public deployment, its tailnet name in a private one. So the question is
whether to put the relay somewhere else, and only then is a hostname asked for — `CROSSBAR_TURN_HOST`
is filled in with this server's own address when it is not. Its shared secret is generated either
way. Leaving the hostname blank after saying the relay is elsewhere is the one way to ask for no
relay at all: calls that can connect directly still work, and the summary says that some networks
will fail.

**The relay a phone is rung through is named in the run, not inherited in silence.** A locked
phone is woken by a VoIP push through the Crossbar push relay (§2.7.1), and the wizard offers a
shared development relay — `https://crossbar-push-dev.ibnfaisalc.workers.dev` — as the value Enter
takes. Whichever relay is in force is named in the summary, and when the default is what was kept
the summary also prints the three names that would point the deployment at another one:
`CROSSBAR_PUSH_RELAY_URL`, `CROSSBAR_PUSH_RELAY_TOKEN` and `CROSSBAR_PUSH_RELAY_INSTALLATION_ID`
(§2.7.1). The URL is the wizard's business; the token is a server secret the relay's operator hands
over once, and it stays a hand edit in `.env` — a URL with no token rings nothing, and the summary
says so.

**APNs and Web Push are no longer asked for.** A deployment no longer needs an Apple key to be set
up: the missed-call notification that still uses APNs is configured by hand when somebody wants it
(§2.7), and the wizard neither asks for the key nor writes any of its four names. Web Push is not
asked for either, and no summary row reports it. Both capabilities are unchanged in the server.

A value the deployment already holds is offered as the default, so a second run over a configured
deployment changes only what it was told to; secrets are kept unless `--new-secrets` is passed.
Nothing is written until the whole `.env` it composes is complete and the directory is valid, so a
refusal costs nothing. The private hostname's default is the name this machine answers at on the
tailnet (`tailscale status --json`'s `Self.DNSName`), so a machine that is on a tailnet is not asked
to type it again; a machine with no Tailscale is asked the same question, worded so the answer is
knowable without either, and the run says the private address is your people's phones' way in.

**The wizard's mode question decides whether there is a private door at all, and the wizard is
where the join happens — immediately after that question, before the private address it answers is
asked for.** The private address is the name Tailscale gives this machine, so the wizard joins the
machine itself: `tailscale up --hostname <the deployment's name>`, run as the deployment's own
account (which the installer makes the daemon's operator before the wizard starts, §2.8.1) and in
the terminal, where its approval link is. It then reads `tailscale status --json`'s `Self.DNSName`
back and puts that name in the private `HOSTNAME` field — with `https://` in front of it in
`ORIGIN` — as a value to confirm rather than a question to answer from expectation. With
`--tailscale-authkey` the key reaches that login through `TS_AUTHKEY` and no approval is needed;
with no terminal to show a link in and no key, the join is not attempted and the address is asked
for with brief instructions beside it.

The installer's front door afterwards is the **safety net** for the run that could not join there:
it makes the same login attempt once more and reads the name back as root, and when that name and
the private block the wizard wrote disagree it says what `.env` holds and what the machine is
called now, then runs the wizard once more with the discovered name
(`--no-ask --private-hostname <name> --private-origin https://<name>`). The wizard keeps the mode,
every other address, the people and every secret from the files it wrote, so this is one call and
not a second `.env` writer; an invitation's origin is built from that address, which is why a
disagreement is corrected rather than reported. Nothing is said when the two agree — which is the
ordinary case now that the wizard derives the address itself — or when Tailscale cannot answer,
because a machine that is not logged in has no name to correct to: the login is then what is left,
and the front door says so and prints the one command (§2.8.1). The login never fails the install:
a declined or timed-out one leaves everything else installed, and the report says which it was.

```bash
sudo scripts/install.sh --answers /root/answers.json   # every answer from one JSON file
sudo scripts/install.sh --browser                      # the wizard's browser front end instead of the terminal
sudo scripts/install.sh --tailscale-authkey tskey-auth-…   # join the tailnet with no browser approval, and set the private address from its name (private, §2.8.1)
```

`--answers` is passed straight to the wizard, whose `--answers <file>` takes the same keys it does
(`node src/admin.js setup --help`). It has to be readable by the deployment's account, because
that is who the wizard runs as; a file only root can read is refused before anything runs. Every
question is also answerable by flag, and the installer passes none of those through — put them in
the file.

**Two shapes of run do not join from inside the wizard**, and the front door is what covers them
either way: `--browser`, whose page is not a terminal, and an unattended run (`--answers` with no
terminal on stdin), which has nobody to approve a machine. Both get the address asked for as they
always did; the front door then makes the login attempt itself — in the installer's own terminal,
where there is one — and corrects `.env` with the name it reads back (§2.8.1). Passing
`--tailscale-authkey` removes the difference: a key needs no approval, so the wizard joins in those
runs too and the address is derived like any other.

**With no `--answers`, no `--browser` and no terminal on stdin, the installer refuses.** It names
what to pass and writes nothing: a wizard that cannot answer its own questions must stop rather
than write a `.env` it cannot complete, and the same refusal is what `--no-ask` is for at the
wizard level.

The console password and the first invitation are asked only where there is a terminal to ask, and
run in that same terminal: with `--answers`, `--browser` or `--no-ask` there is nobody to type a
password or read a one-time token, so neither runs and the summary leaves the two commands as the
next steps. `--password` and `--invite` answer them without asking, but still run only with a
terminal.

Then the front door, for exactly the modes the wizard set up:

- **public** — the installer installs Caddy (`apt install caddy`, §2.8), writes the
  `EnvironmentFile=` drop-in that gives it this `.env`, installs `deploy/Caddyfile` as
  `/etc/caddy/Caddyfile`, and runs `caddy validate` for the public block's hostname and bind
  address. It does **not** start Caddy: public mode's shaper unit does, on every start while
  public mode is in force (§2.5). A step that fails stops the install with the reason — a public
  deployment with no door is the one thing worse than one that refused.
- **private** — Tailscale has already been prepared *before* the wizard asked anything, because the
  wizard's own join needs it: installed if it is not already (`tailscale.com/install.sh`, which adds
  its own `apt` repository — the vendor script, so a host on any supported distribution works),
  `tailscaled` enabled and started, and the deployment's own account named the daemon's **operator**
  with `tailscale set --operator=<account>` — on Linux the daemon is root's and answers nobody else
  until an operator is named, which is what lets the wizard, running as that account, join at all.
  No login happens there. What the front door adds is the **safety net** (§2.8.1): it makes the same
  login attempt once more — `tailscale up`, naming the deployment's account the operator and naming
  the **node itself** after the deployment (`--hostname`, the basename of `--prefix` unless
  `--tailscale-hostname` says otherwise), so the private address is the one the person chose rather
  than the one the host's provider assigned — and then reads the machine's own tailnet name back (as
  root) and compares it with the private block the wizard wrote; a disagreement re-runs the wizard
  with the name the machine answers at, and a machine with no name yet (the login not done) ends its
  report saying so. With `--tailscale-authkey` the key goes to `tailscale up` through `TS_AUTHKEY`
  (never argv, so it is in no transcript and no process list); without one the command runs in the
  terminal, so its approval link is where the person is looking, and where there is **no terminal**
  to show it in the login is not attempted at all and the installer prints the exact command
  instead. The login never fails the install — a declined or timed-out one leaves everything else
  installed, and the report says which it was.

`--no-setup` turns the phase off and installs exactly what this script did before there was a
wizard: `.env` is a template you edit by hand (§2.3), the directory file has to exist already
(§2.4), and nothing touches Caddy or Tailscale.

### 2.3 `.env`

**The setup wizard writes this file.** `scripts/install.sh` runs it (§2.2.1), and it fills a block
for each mode it was told about, generates `CROSSBAR_SESSION_SECRET` if the file holds none, and
leaves the rest of the template as it is; `node src/admin.js setup` in the deployment runs the same
wizard by hand, which is the way to change one mode on a box that is already up. The commands
below are the by-hand path — what `--no-setup` leaves you to do, and the reference for what each
line means.

```bash
cp .env.example .env
chmod 600 .env
openssl rand -hex 32          # the value for CROSSBAR_SESSION_SECRET
$EDITOR .env
```

Fill in, at minimum:

- `HOST=127.0.0.1` and `PORT=3003` (the port Caddy and the private unit also read; the two
  defaults must agree, and 3003 is the default in both `config.js` and the Caddyfile).
- `DATA_DIR=/home/admin/crossbar/data` and
  `DIRECTORY_CONFIG_PATH=/home/admin/crossbar/data/directory.json` — the two paths a backup
  and a restore use.
- `CROSSBAR_SESSION_SECRET` (the `openssl` line above). Required in public mode, and required
  for `enroll` to work at all: an invitation without it is refused with
  `Set CROSSBAR_SESSION_SECRET first; invitations are useless without it.` Replacing it signs
  every device out.
- **One block per mode this deployment can be reached in** — `NETWORK_MODE_PRIVATE_HOSTNAME` /
  `_ORIGIN` and `NETWORK_MODE_PUBLIC_HOSTNAME` / `_ORIGIN` / `_BIND_ADDRESS`. A mode whose
  block is empty is refused at switch time, leaving the file as it was, and the units that shape
  the box no longer act for it either (§3.3): closing the other door on the strength of a mode
  that cannot start is not something an operator can undo from outside the box.
- Optionally, **the switch window** — `CROSSBAR_SWITCH_GRACE_SECONDS`, in seconds, default 900
  (fifteen minutes). It is read by the mode units, not by the server, and it is not in
  `.env.example`; add the line only to change the window. See §3.4.
- `CROSSBAR_ADMIN_PASSWORD_HASH` via `node src/admin.js password`, not by hand.

**The push relay's URL is the wizard's, and its credential is not.** The wizard offers
`https://crossbar-push-dev.ibnfaisalc.workers.dev` and writes `CROSSBAR_PUSH_RELAY_URL`; the token
and the installation id come from the relay operator, who hands them over once (§2.7.1), so they
are pasted into `.env` by hand. Whichever relay the URL names is printed in the wizard's summary,
and a URL with no token rings nothing. A deployment that never sets the credential runs
exactly as it did before the relay existed: everything works except ringing a phone whose screen is
off, and `status` says so on its `Push relay` line.

On the installer's path `DATA_DIR`, `DIRECTORY_CONFIG_PATH` and `WEB_ROOT` are already rendered
for this host: `.env.example` carries production's literals (`/home/admin/crossbar/…`), the
installer rewrites those three lines for `--prefix` before the wizard runs, and a value you have
edited is left alone. By hand, at a prefix other than `/home/admin/crossbar`, they are yours to
set — and the wizard reads `DIRECTORY_CONFIG_PATH` out of the file to decide where the directory
file goes, so getting them wrong writes it outside the deployment.

Do **not** fill in the generated section (between the `>>> the configuration in force >>>`
markers): that is written by the switch. Do not leave a copy of one of its names
(`PUBLIC_ORIGIN`, `CROSSBAR_PUBLIC_HOSTNAME`, `CROSSBAR_NETWORK_MODE`,
`CROSSBAR_BIND_ADDRESS`, `TRUST_TAILSCALE_HEADERS`, `CROSSBAR_REQUIRE_DEVICE_AUTH`) anywhere
else in the file — a switch refuses when you do (§3.2).

**And no name twice, anywhere in the file.** The server takes the **first** match for a name, so a
line appended below an existing one looks set and is not: on the live box an appended
`NETWORK_MODE_PUBLIC_BIND_ADDRESS=` was silently dead because the first public block won. A
duplicate is not refused, and not warned about — it is simply ignored.

`.env` is read by systemd (`EnvironmentFile=` in every unit), by the server, and — through a
drop-in — by Caddy. There is one writer (`writeEnvFile` in `src/config.js`): it keeps a copy of
the file it replaces at `<DATA_DIR>/env.previous` (mode 0600) and then writes `.env` **in place**,
which is why `crossbar.service`'s `ReadWritePaths` names the data directory and `.env` and
nothing more. Why in place rather than a staged rename, and what that costs, is in §3.2.

### 2.4 The directory file — required, not optional

**The setup wizard writes this file too.** `scripts/install.sh` runs it (§2.2.1) and it writes the
people it was given — the `people` key of an `--answers` file or the terminal's
`display name, login, admin` lines, whose id is derived from the display name (§2.2.1) — through
the same validator the server uses, at the path
`.env`'s `DIRECTORY_CONFIG_PATH` names. `node src/admin.js setup` in the deployment runs the same
wizard by hand. The block below is the by-hand path, what `--no-setup` leaves you to do.

```bash
cp data/directory.example.json data/directory.json
chmod 600 data/directory.json
$EDITOR data/directory.json         # at least one person, at least one of them "admin": true
```

The server will not start without it. The three refusals, in the order you will meet them:

- `No directory file at /home/admin/crossbar/data/directory.json.` — the path in
  `DIRECTORY_CONFIG_PATH` does not exist.
- `A directory needs at least one person.` — an empty `users` array.
- `A directory needs an administrator who is not suspended.` — nobody has `admin: true`.

The file is the source of truth for people, contacts and groups and is re-applied to the
database on every start; see §7 for what it does and does not require of a person.

`scripts/install.sh --no-setup` refuses to continue while the file is missing, and says which one
to write — the first of the three refusals above, caught before a service is installed rather than
after it fails to start. It reads the path out of `DIRECTORY_CONFIG_PATH` in `.env` when that is
set, so a deployment that keeps the file somewhere else is checked in the right place. Without
`--no-setup` the wizard writes the file instead, and the install continues.

### 2.5 Units

```bash
sudo install -m 644 deploy/crossbar.service \
                    deploy/crossbar-public.service \
                    deploy/crossbar-private.service \
                    /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now crossbar
```

Add the backup pair, and the relay if this deployment relays media:

```bash
sudo install -m 644 deploy/crossbar-backup.service deploy/crossbar-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now crossbar-backup.timer     # the .timer, not the .service

sudo apt install coturn gettext-base
sudo systemctl disable --now coturn                   # the package's own unit; this one replaces it
sudo install -m 644 deploy/crossbar-turn.service /etc/systemd/system/
sudo install -D -m 644 deploy/coturn.conf /etc/crossbar/coturn.conf
sudo systemctl daemon-reload
sudo systemctl enable --now crossbar-turn
journalctl -u crossbar-turn -f
```

`daemon-reload` is the step that is easiest to forget, and without it `crossbar.service`'s
`Wants=crossbar-public.service crossbar-private.service` is not live and neither shaping unit
runs at all — the box looks configured and has no front door.

**The paths in `deploy/` are production's literals.** They are not templates: `User=admin`,
`Group=admin`, `WorkingDirectory=/home/admin/crossbar`,
`EnvironmentFile=/home/admin/crossbar/.env`, `ExecStart=/usr/bin/node
/home/admin/crossbar/src/server.js`, `ExecStart=/usr/bin/node
/home/admin/crossbar/src/backup.js`, and `ReadWritePaths=/home/admin/crossbar/data
[/home/admin/crossbar/.env]` in the server and backup units; the same `EnvironmentFile` plus
`/home/admin/crossbar/.env` in the two mode units' `ExecCondition`s and in their
grace-window `systemd-run` lines; and `/etc/crossbar/coturn.conf` in the relay unit.

**A second household at a different user or path does not edit them.** `scripts/install.sh`
substitutes those literals at install time — the prefix from `--prefix`/`CROSSBAR_HOME`, the
account from `--user`/`CROSSBAR_USER`, and `/usr/bin/node` for the node binary it finds and checks
is 22.5.0 or newer — and installs the result into `/etc/systemd/system`. So the file systemd reads
is the file a person can read back from `/etc`, the copies here stay a working example of a default
deployment rather than a form valid nowhere, and an upgrade re-renders them from the tree it
installed (§5.3). Installing the files by hand for a non-default user or path means rewriting those
same lines yourself; the installer's `--dry-run` prints the diff it would make, which is the
quickest way to see them all.

**The prefix must not be under `/tmp`.** `crossbar.service` is `PrivateTmp=true`, so the service
gets its own `/tmp` and `ReadWritePaths=/tmp/…/.env` names a path that does not exist inside the
unit's namespace. Measured on the rehearsal host, 2026-09-26: installing at `/tmp/xb-scratch`
completed through the units and the restart, and then the service refused to start with
`Failed to set up mount namespacing: /run/systemd/unit-root/tmp/xb-scratch/.env: No such file or
directory` (status 226/NAMESPACE), so the installer's own `/api/health` check was what caught it —
the same check that makes "installed" mean "answering". Use a real directory (`/home/<account>/…`).

### 2.6 First start, and the first checks

```bash
cd /home/admin/crossbar
node src/admin.js mode          # the file loads cleanly, and which mode is in force
node src/admin.js status        # the running configuration and the counts
node src/admin.js doctor        # the reachability checks, if the server is up
sudo systemctl status crossbar
```

Expected shapes for all three are in §6; `doctor` is the one that answers "can a phone
actually reach this", so run it before handing anybody an invitation.

`scripts/install.sh` ends by printing exactly these commands, as the deployment's own account
(`sudo -u admin node src/admin.js …`), with the server already started and `/api/health` already
answering — so if the installer has just finished, start from `doctor`.

### 2.7 The first phone

```bash
node src/admin.js password                 # the console's password, prompted twice
node src/admin.js enroll --user abdullah   # a one-time invitation, printed once
```

A wizard run at a terminal asks both of these at the end — "set the console password now?" and
"invite somebody now?", each defaulting to yes — and runs the command in that same terminal, so a
finished install usually leaves neither to type by hand. The commands above are what it runs, and
what to run when either was skipped, or when there was no terminal (an `--answers`/`--browser` run).

The invitation prints the JSON and the token; the token exists nowhere else, so the output is
the one chance to hand it over. The console is at `/admin` on the server's own origin, and
its password is what makes it reachable from a browser that has enrolled no device key.

Two transports can wake something that is not on screen, and they do different things. A **ring**
for a call that is happening is a VoIP push, which this deployment does not send itself: it posts
it through the push relay (§2.7.1), and that is what a locked phone needs. A **missed call** is an
ordinary notification and still goes to Apple from here, which is what `CROSSBAR_APNS_KEY_ID`,
`_TEAM_ID`, `_KEY_PATH` and `_TOPIC` in `.env` are for: without that key the console and `status`
say `not configured — a missed call tells nobody`, and a missed call is silent while everything
else keeps working. Web Push is the browser's equivalent and is optional: it needs a VAPID key
pair, which `npx web-push generate-vapid-keys` prints (the
public key, then the private one) plus a contact subject the push services can use, pasted into
`.env` as `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT`. **The wizard no longer asks
for either of these transports** — an Apple key and a VAPID pair are set by hand when somebody
wants them, and no question or summary row mentions them. An APNs key is the Apple **team**'s, not a server's:
deployments serving the same app share one key id, team id and topic, and each names the `.p8`
file on its own server — copy it there, and let the account the deployment runs as read it.

Apple's own description of that key is what to plan against: **one signing key authenticates
tokens for multiple apps, it does not expire, and it can be revoked**. The `.p8` is a credential
in its own right, not a copy of one — with the key id, team id and topic beside it, whoever holds
the file can send push notifications **as this app**, a forged incoming call included. It cannot
read anything and cannot sign an app: it authenticates the team to Apple's push service and
nothing else. So it is worth the care `CROSSBAR_SESSION_SECRET` gets, and that is why the posture
is the file readable by the deployment's own account and nobody else (mode 0600, owned by the
deployment user, as `.env` and the directory file are): a server has to read it unattended at
every push, so encrypting it at rest would only move the secret to wherever the decryption key
lives.

If it leaks — into a backup, a git history, or a host whose access is no longer trusted — rotation
is the fix, and it happens in Apple's developer account rather than here: **Keys** under
Certificates, Identifiers & Profiles, where the key was created, and which only the Account Holder
or an Admin can reach. Revoke the key, create the replacement with APNs enabled, put the new `.p8`
where `CROSSBAR_APNS_KEY_PATH` names, set `CROSSBAR_APNS_KEY_ID` to the new key's id (Apple's
filename carries it, `AuthKey_<KEYID>.p8`), and `sudo systemctl restart crossbar`. Apple's own
note on a suspected compromise runs those first two the other way — the replacement created first,
the old key revoked after the transition — which avoids a window with no push at all; revoking
first spends that window to stop a forged call reaching a phone sooner. Either way the old key is
dead, and the new one is what the deployment signs with.

### 2.7.1 The push relay, which rings a phone

A phone whose screen is off is woken by exactly one thing: a VoIP push, which only Apple can
deliver and only for the app's own bundle id. This deployment does not hold that ability. The
**Crossbar Push Relay** does — one installation per household, one Apple key for the shared app, and
a credential the relay operator hands over. The relay knows an installation, a device id and a
PushKit token: it holds no users, no calls, no contacts and no media, and it is a doorbell rather
than a call setup (relay `docs/BACKEND_INTEGRATION.md`).

Three settings go in `.env`, in the names the operator's `relay-admin.mjs create` prints:

| Setting | What it is |
| --- | --- |
| `CROSSBAR_PUSH_RELAY_URL` | the relay's origin, e.g. `https://crossbar-push-dev.<account>.workers.dev`; plain `http:` is refused at start-up unless the host is loopback, because the installation credential travels on every request |
| `CROSSBAR_PUSH_RELAY_TOKEN` | the credential, `cbr_…` — a **server secret** |
| `CROSSBAR_PUSH_RELAY_INSTALLATION_ID` | the relay's `ins_…` for this household; nothing sends it, it is what names an installation in a log line |

`CROSSBAR_PUSH_RELAY_TIMEOUT_MS` (default 5000) bounds every request to it. The credential is shown
once and the relay stores only its digest, so a lost one is rotated rather than recovered; it
belongs in `.env` (mode 0600, as that file's other secrets do) and never in a repository, a command
line or a chat message. It never reaches a phone, never appears in a push payload, and neither this
server nor the relay logs it.

How the pieces move:

1. iOS gives the app a PushKit token and the app presents it to this server, as it always has:
   `POST /api/devices/push-token` with `kind: "voip"`. That endpoint now also registers the token
   with the relay, under the same opaque id — this server's `dev_…` device id *is* the relay's
   `device_id`, so there is no mapping table to keep in step.
2. The answer carries a `relay` object beside `saved`: `{"configured": true, "ok": true,
   "outcome": "saved", "status": 200, "error": null, "retryAfterSeconds": null}`. `saved` is
   about this server's row; `relay` is about whether a call can reach the phone, and it is what
   the app acts on — it clears its held token only for `outcome: "saved"`. `retryable` is a
   request that can still succeed: one that never arrived (`status: 0`), a `429`, any `5xx`, a
   `409 request_in_progress`, or a deployment with no relay configured yet — and the app keeps
   the token and tries again. `permanent` is `409 token_conflict`: the PushKit token is
   registered to *another* server, and only that server's removal, or the relay operator, frees
   it. Read the permanent one as "this phone could not be enabled yet", not as a bug to retry.
   `saved: true` never stands in for the relay's answer, and the route is rate-limited like its
   sibling `/api/push/subscriptions`.
3. An app on its way out of a deployment — unpaired or signed out — releases its own
   registration with `DELETE /api/devices/{device_id}`, carrying its device session. Any id but
   the calling device is refused, so an enrolled phone cannot unring somebody else's; the device
   is revoked here (its key stops working and the record stays) and the relay's answer comes back
   in the same `relay` object. A `404` from the relay counts as done, because it has no such
   registration. Without this call a re-enrolled phone keeps its token claimed at the relay.
4. On an incoming call the server posts one `POST /v1/push/voip` per invited phone, each with a
   `request_id` derived from the call and the device. That derivation is what makes a retry a
   retry: the same ring repeated after a timeout carries the same id, so the relay replays its
   first answer rather than waking the phone twice.
5. A rotated PushKit token is an update at the same device id — an upsert, not a second device. A
   `410 device_unregistered` means Apple has told the relay the token is dead: this server clears
   it, exactly as it always cleared a dead APNs token, and the phone files a new one the next time
   the app launches. Revoking or removing a device — in the console, with
   `node src/admin.js revoke-device|remove-device`, or by removing a person from the directory —
   also removes it at the relay, which is what frees the token for whichever server the phone
   moves to. A relay that refuses is not an error for whoever asked: the removal is written down
   as owed and retried by the running server until the relay answers `2xx` or `404`, so a lost
   reply cannot leave a phone that nobody can ring.
6. The **missed-call notification still goes to Apple from this deployment**, because the relay is
   a VoIP-only transport — so `CROSSBAR_APNS_*` stays configured for that. They fail separately: a
   wrong APNs key costs the missed-call line and nothing else, and a relay that cannot be reached
   costs the ring and nothing else. Neither changes a call's state; a ring is fire-and-forget with
   a logged failure.
7. Web Push and the realtime `incoming-call` event are unchanged. A native app may receive more
   than one of them, and it deduplicates on the call id — which is why the push and the event carry
   the same one, and why a push can never name a call the app cannot then go and read.

**Before a push can ring, the app must read the namespaced payload.** The relay sends the call
inside a `crossbar` object — `crossbar.call_id`, `crossbar.caller_id`, `crossbar.caller_name`,
`crossbar.has_video`. A build that still reads the flat top-level `callId` wakes, finds nothing it
can name, and drops the push. iOS requires an app woken by a VoIP push to report a call to CallKit
promptly, and repeated failures cost the app its PushKit privilege — on every device, because every
installation shares one app identity. Change the app first, then exercise the live path.

**What a local run cannot show.** A `200` from the relay means APNs accepted the notification, not
that the phone rang, and the push is sent with `apns-expiration: 0`, so nothing is stored for later.
The live path needs a deployed relay with an Apple key and a real device; the relay's own
documentation is explicit that a deployed Worker reaching APNs is not verified, and a local relay
cannot reach Apple at all (its test runtime has no HTTP/2). Everything up to APNs is what the test
suite covers.

**When a phone does not ring, in this order:** `node src/admin.js status` — is a ring transport
configured at all; the journal — `push_relay_not_configured` (a phone holds a VoIP token and there
is nowhere to send it), `push_relay_refused` (with the relay's status and error code: a
`device_unregistered` clears that phone's token, a `token_conflict` on a registration needs the
other server), `push_relay_unreachable` (a timeout or a dropped connection — the ring is not
retried, because a call that arrives late is worse than one that does not arrive),
`push_relay_deletion_pending` (a device removal the relay has not confirmed: it is owed and
retried until the relay answers `2xx` or `404`, and until then that phone's token stays claimed
by this installation); and
`curl -sS "$CROSSBAR_PUSH_RELAY_URL/v1/health"`, which needs no credential and says which Apple
environment the relay is deployed against. The relay's own logs answer the other half, with a
`push` line carrying `apns_status` and `apns_reason` per device.

### 2.8 Public mode: Caddy, DNS, ports

**The installer does the mechanical half of this for a public deployment** (§2.2.1): it installs
Caddy, writes the `EnvironmentFile=` drop-in below, installs `deploy/Caddyfile` as
`/etc/caddy/Caddyfile`, and runs `caddy validate` for the public block's hostname and bind address.
It does not start Caddy itself — public mode's shaper unit does, on the install's own
`systemctl restart crossbar` and on every later start while public mode is in force (§2.5) — so a
deployment installed as public has Caddy up when the install finishes, and one installed as private
(a `both` deployment, say) has it installed and validated but stopped until the switch to public.
What is left is the part software cannot do: the DNS record, the port forwards and the firewall
(§8.1, §8.2). A public install that did not ask for the wizard (`--no-setup`), or one whose Caddy
came from somewhere else, is the by-hand path below.

Caddy comes from the project's own package repository (`apt install caddy`). It needs
`CROSSBAR_PUBLIC_HOSTNAME` and `CROSSBAR_BIND_ADDRESS` in its own environment, and the right
way to give it them is the same file the server reads rather than a second copy of the value:

```bash
sudo systemctl edit caddy
```

```
[Service]
EnvironmentFile=/home/admin/crossbar/.env
```

(`systemctl edit` writes `/etc/systemd/system/caddy.service.d/override.conf`; the installer writes
the same directive to `…/caddy.service.d/crossbar-env.conf` instead, so an upgrade of Caddy — which
replaces its own unit — does not take the drop-in with it. `systemctl cat caddy` reads the unit and
every drop-in together, which is where to look for what is in force.)

Then `sudo systemctl restart caddy`. Nothing else from `.env` is used by Caddy, and `PORT`
only matters if the server does not listen on 3003.

`NETWORK_MODE_PUBLIC_BIND_ADDRESS` in the public block is the other value Caddy reads — the
switch copies it to `CROSSBAR_BIND_ADDRESS`, which is the name the Caddyfile expands. It is
the address Caddy listens on: set it to the address the router forwards to, never the
wildcard. The wizard asks for it with this host's own IPv4 addresses in the question, so it is
a choice among what the box can be bound at rather than a value to go and look up; which of
them the router forwards to is not knowable from inside, which is why none of them is written
in for you. A host that already serves the same ports over a tailnet holds `:443` on its own
address, and a wildcard bind beside a specific one is either refused outright or resolved by
the kernel's discretion, which is not a thing to leave a public listener to. It has to be
stable, so reserve it on the router. Changing it while already in public mode needs
`sudo systemctl restart caddy`: systemd reads `EnvironmentFile=` at start, not on reload.

DNS (§8.1) and the port forwards and firewall (§8.2) are host facts the software cannot see.
Install the `Caddyfile` at `/etc/caddy/Caddyfile` and check it with `caddy validate
--config /etc/caddy/Caddyfile` before restarting Caddy.

### 2.8.1 Private mode: Tailscale

**The installer does the mechanical half of this before the wizard asks anything** (§2.2.1), because
the wizard's own join needs it. If `tailscale` is not on the host it installs it with the vendor's
own script (`curl -fsSL https://tailscale.com/install.sh | sh`, which adds Tailscale's `apt`
repository), then `systemctl enable --now tailscaled` so the daemon survives a reboot, and then
`tailscale set --operator=<account>` — naming the deployment's own account the daemon's **operator**,
which is the line that makes the next step possible: on Linux the daemon is root's and answers
nobody else until an operator is named, so without it the account that runs the wizard cannot run
`tailscale up` or read the machine's name. Nothing is logged in at this point. `tailscale serve` is
run by the private shaper unit on every start (§2.5), so the route itself needs nothing installed by
hand.

Because it happens before the mode question, an install that turns out to be public-only keeps
Tailscale installed and unlogged — a daemon in `NeedsLogin` serves nothing and holds nothing — and
none of it can fail the install: a host that cannot install it says so, the wizard falls back to
asking for the address, and the front door refuses later when a private deployment has no Tailscale
at all.

**The login is run by the wizard**, between the mode question and the private address that comes
from it. That is the point of preparing Tailscale first: the wizard runs as the deployment's own
account, which the step above has just made the daemon's operator, so `tailscale up --hostname <the
deployment's name>` is that account's own command — and `tailscale up` prints an approval link and
waits for the machine to be approved, which is the whole of what a person has to do. It runs **in
the foreground, on this terminal**, so the link is where the person is looking: they answered the
mode question a moment before. That is the difference between being asked for an address the machine
can learn and being handed a command to run later.

An auth key removes the approval step: with `--tailscale-authkey <key>` the key reaches the login
through `TS_AUTHKEY` — so it is in neither the process list nor the transcript, and `--dry-run`
prints `TS_AUTHKEY=<hidden>` — and a keyed join needs no terminal at all. With **no terminal to show
a link in** and no key, the join is not attempted: the address is asked for, and the instructions
below are printed next to the question.

**Then the name is read back and offered, not asked for.** `tailscale status --json`'s
`Self.DNSName` (with the trailing dot dropped) is the address `<name>.<tailnet>.ts.net` the login
just gave the machine, and the wizard puts it in the private `HOSTNAME` field — and `https://` in
front of it in `ORIGIN` — which Enter keeps. What is read is a value to confirm, with the box above
it saying what this machine is called now. The field holds that name whatever `.env` held before,
because the machine's own name is the one an invitation has to carry. When the join did not finish
there is no name to offer, so the field is empty as it always was, the question is the one that
reads, and the instructions below are beside it.

**That login names the node**, and the name *is* the address. `tailscale up --hostname <name>` makes
the machine answer at `<name>.<tailnet>.ts.net`, which is what `Self.DNSName` reports, what the
wizard reads back and writes into `NETWORK_MODE_PRIVATE_HOSTNAME`, and therefore what
`NETWORK_MODE_PRIVATE_ORIGIN` and every invitation built from it hold. The name is **the
deployment's own name** — the basename of `--prefix`, so `crossbar-dev` for
`/home/admin/crossbar-dev` and `crossbar` for the default `/home/admin/crossbar` — which the
installer derives and hands to the wizard, because that is the name the person chose and the one
their phones should dial; `--tailscale-hostname <name>` replaces it. Naming nothing is what leaves
the provider's name in place: an install on a VPS that named nothing would otherwise join as
`srv2011992.tailea67b0.ts.net` — assigned by the provider, chosen by nobody — and that is the
address an invitation would carry.

A prefix whose own name is not a hostname is reduced to one, because a directory name and a hostname
are not the same language: `/home/admin/My_Box.v2` joins as `my-box-v2`. The reduction is on the
line of `--dry-run` that the wizard is given the name on, where it can be read before anything runs.
A `--tailscale-hostname` that is not a hostname, by contrast, is **refused** rather than reduced:
that one was spelled by a person, and answering with a different name is how an address nobody asked
for ends up in `.env`.

When the join could not be finished — no terminal, or the approval declined or timed out — the
install says which, and leaves **brief instructions** rather than a runbook reference: the exact
command, what it will do, and that re-running the installer is what finishes the job. It is the same
command the installer would have run, `--hostname` included, so a person who runs it joins under the
deployment's own name:

```bash
sudo tailscale up --operator=<account> --hostname crossbar-dev   # prints the approval URL; approve the machine, then re-run the installer
```

**The front door afterwards is the safety net for exactly that run.** Once `tailscale status --json`
answers, it reads `Self.DNSName` (trailing dot dropped) and compares it with
`NETWORK_MODE_PRIVATE_HOSTNAME` in `.env`. Because the wizard derives that address from the same
field before it writes, this normally finds the two agreeing and says nothing; what it is there for
is the run whose join did not finish, where the address came from what the person expected or was
left blank. That address is what `NETWORK_MODE_PRIVATE_ORIGIN` is built from and what an invitation
carries, so a disagreement is an address nobody can dial, not a cosmetic slip. When the two differ
the installer says what `.env` holds and what the machine is called now, and runs the wizard once
more with the discovered name:

```bash
node src/admin.js setup --no-ask --private-hostname <name> --private-origin https://<name>
```

`--no-ask` is what makes that a correction: the mode, the other addresses, the people and every
secret come from the `.env` and the directory file the first run wrote, and the console password and
first invitation are left alone rather than re-run. Nothing is said when the two agree. When
Tailscale cannot answer at all — no login yet — there is no name to correct to, and the install's
final report says the machine is not logged in and prints the command left, with what it does, rather
than leaving an unchecked address in `.env`.

An auth key comes from the Tailscale admin console's *Settings → Keys* (`tskey-auth-…`); make it
pre-authorized (so it needs no browser approval) and non-ephemeral for a machine that must stay in
the tailnet. It is a credential — keep it out of shell history and out of the answers file if that
file is shared.

A machine that is already logged in — from an earlier run, or the host's own Tailscale — is not
logged in again: the wizard reads the name, offers it as the address, and writes it; the front door
reads it once more and has nothing to correct.

The private hostname question has two readings, and which one is shown is whether this machine has a
name. **With one** the field holds it, and the question says Tailscale gives this machine one and
that it is on the tailnet already, so Enter keeps the name it answers at. **Without one** — the join
did not finish, or was not attempted for want of a terminal and a key — it is the question that says
the installer sets the address from the machine's own tailnet name once the machine is approved on
the link Tailscale shows. Neither promises a name that does not exist yet.

### 2.9 Installing the relay (optional)

`coturn.conf` is a template and coturn cannot read it: coturn's configuration format has no
environment substitution, so the file holds `${CROSSBAR_*}` references and
`crossbar-turn.service` renders it with `envsubst` into `/run/coturn/turnserver.conf`, taking
the values from the same `.env` the server reads. The shared secret is therefore never
committed and the rendered copy lives on a tmpfs.

The install commands are with the other units (§2.5), and `scripts/install.sh` installs the relay
unit and `/etc/crossbar/coturn.conf` by itself when `turnserver` is on `PATH` (it says which it
did; `--with-relay` forces it). **The wizard sets the two settings for you**: it defaults
`CROSSBAR_TURN_HOST` to this deployment's own address — its public name, or its tailnet name in a
private deployment — and generates `CROSSBAR_TURN_SHARED_SECRET`, so a run that never touched the
relay question still has a working one (§2.2.1). By hand the pair is
`CROSSBAR_TURN_HOST=<CROSSBAR_PUBLIC_HOSTNAME>` and a `CROSSBAR_TURN_SHARED_SECRET`
(`openssl rand -hex 32`) in `.env`; either way, restart the relay and the server so the ICE list the
server hands out names the relay that is actually running. The relay refuses to start if the
rendered secret is empty, because a coturn with no secret accepts no one — which looks like a
media failure rather than a configuration one. `CROSSBAR_TURN_EXTERNAL_IP` is required on a
host behind NAT; §8.4 explains why it goes stale silently.

### 2.10 Rehearsing the install

An install is finished when: `mode` reports the file loads cleanly, `status` shows the
expected mode and origin, `doctor` is all `OK`, the console answers at `/admin`, and a first
phone has enrolled and rung another one. Until the relay has been exercised by a real call
that could not go direct, "the relay works" is untested — the doctor's TURN line says
`reachability only, not an allocation` for exactly that reason.

`scripts/install.sh` checks the second of those for you (`/api/health` answers, and with which
version) and prints the rest as its next steps. **The first real install happens on the rehearsal
host, by the integration owner**, and these are the parts of it nothing on a workstation could
have run:

1. `sudo scripts/install.sh --dry-run` first, and read it: the unit diff it prints is the whole
   substitution, and nothing below should be a surprise. In the onboarding phase it also prints
   the wizard's command and the front door it would install, and the wizard writes nothing.
2. Then the real run. It should show the wizard's summary and its check block, and end with
   `health: {"status":"ok",…}` and the next steps. If it refuses, it refuses before installing a
   unit — with `--answers` or a terminal the directory file is written, so a refusal there is the
   wizard naming an answer it is missing; with `--no-setup` the messages name the file to write,
   and either way the account or group that is missing is named.
3. Caddy, for a public deployment: `caddy validate --config /etc/caddy/Caddyfile` exits 0 and
   `systemctl cat caddy` shows the `crossbar-env.conf` drop-in with `EnvironmentFile=` pointing at
   this `.env`. With the install finished, `systemctl status caddy` is active when public mode is
   in force — the shaper unit started it on the restart — and not running when private mode is,
   which is the door the tailnet provides instead.
   Tailscale, for a private deployment: `systemctl status tailscaled` is active, `tailscale
   status` names the machine, and that name matches `NETWORK_MODE_PRIVATE_HOSTNAME`. The wizard
   joins the machine itself — right after the mode question and before it asks for the private
   address, which it then offers as the name the login produced — and the installer's front door
   afterwards makes the same attempt once more and reads the name back, so a disagreement with
   `.env` is corrected on the spot by a second, `--no-ask` wizard run (§2.8.1). Where it could not —
   no terminal, or the approval was declined — the run ends by printing the exact command and what
   it does; run it, approve the machine, then re-run the installer and check `.env`. The rehearsal
   is what proves the account can run `tailscale up` and read the name at all (`tailscale status`
   as the deployment account, not as root): the operator line in the installer's Tailscale step is
   what allows it, and a host where it is refused is a host where the wizard will ask for the
   address instead.
4. `systemctl status crossbar crossbar-backup.timer` — the service **active (running)**, the timer
   **active (waiting)** with a next elapse. A timer that is not waiting is a backup that never runs.
5. `systemctl list-timers crossbar-backup.timer`, then `sudo systemctl start crossbar-backup.service`
   once and check `ls -lt data/backups/` — the wiring, which no test covers.
6. `sudo systemd-analyze verify /etc/systemd/system/crossbar.service` (and the other four) against
   the **rendered** files, which is also the check §2.5's literals were written against.
7. A second `sudo scripts/install.sh` — it must change nothing, keep the session secret, and end
   healthy, which is the idempotency claim; and
8. `sudo scripts/uninstall.sh` without `--purge-data`, then `data/` and `.env` are still there and
   a re-install picks them up. `--purge-data` is the destructive half and is worth doing last, on
   the deployment nobody needs.

---

## 3. Runbook: switching modes

### 3.1 What a switch is

A deployment holds both configurations, one block per mode, and moves between them with one
command plus the restart it asks for:

```bash
cd /home/admin/crossbar
node src/admin.js mode public          # rewrite the generated section of .env
sudo systemctl restart crossbar        # apply it: process *and* the box's shape
```

The restart *is* the switch. The `mode` command only edits `.env`; it deliberately says
"from the next start". Two things write that file — this CLI and the console at `/admin`,
which performs the same switch and then exits so systemd starts the server again
(`Restart=always`). Whether that console path also re-runs the two shaping units is not
established here; §3.4 says how to check, and the CLI below is the path this runbook is
written for.

### 3.2 The one command, and what it says

Run it from the checkout: the CLI reads `.env` from the working directory (`./.env`), not from
the directory of the script, so `cd /home/admin/crossbar` first — the same directory systemd's
`WorkingDirectory=` names.

`node src/admin.js mode` with no argument lists both blocks, marks the one in force, and
answers whether the file loads as a process would read it:

```
$ node src/admin.js mode
   MODE       CONFIGURED  HOSTNAME                              ORIGIN
-> private    no          -                                     (unset: invitations would carry the default origin)
              missing NETWORK_MODE_PRIVATE_ORIGIN
   public     no          -                                     (unset: invitations would carry the default origin)
              missing NETWORK_MODE_PUBLIC_HOSTNAME, NETWORK_MODE_PUBLIC_ORIGIN

private is in force, and loads cleanly.
Its block is incomplete, so no front door is opened for it: the units shape a mode only when it is configured, and a switch to one is refused.
```

(That is the development checkout, whose blocks are empty. A deployment's two lines carry its
tailnet name and its public hostname, and `CONFIGURED` says for each block whether it can start
as written: the same question the mode units ask before they move a door, so a `no` beside the
mode in force is a front door that will not be opened.) Exit code is 1 when the file does
**not** load, so this is also the command to run before a restart when something is wrong.

`node src/admin.js mode public` rewrites the generated section and verifies it by starting a
child process that reads nothing but that file:

```
$ node src/admin.js mode public
In public from the next start:
  systemctl restart crossbar
  (the reverse proxy too, when the two modes bind different addresses)
```

Then restart. In the same mode it answers `Already in public; nothing to change.`

What it refuses, and why:

- **An empty mode block.** It is refused before anything is written — the mode is worked out
  before the file is touched, so not even an `env.previous` appears — and it names what is
  missing:
  `Cannot switch to public: NETWORK_MODE_PUBLIC_HOSTNAME, NETWORK_MODE_PUBLIC_ORIGIN are not
  set in its block.`, followed by
  `Fill in its block in .env — NETWORK_MODE_PUBLIC_HOSTNAME and NETWORK_MODE_PUBLIC_ORIGIN —
  and try again.` That is the same question the mode units ask before they move a door
  (`modeConfigured`), so a switch cannot land a mode whose front door would never open. An
  origin that is set but does not name the hostname is a different fault, with both names
  present, and the write-and-verify below puts that one back byte for byte.
- **A generated name outside the markers.** This is the one that surprises people, and it is
  deliberate:

  ```
  $ node src/admin.js mode public
  PUBLIC_ORIGIN is set outside the generated section, on line 6. Remove that line: the mode
  writes this name itself, and a line left outside would override what the mode decides.
  ```

  (Exit 1, file untouched.) Remove the line and switch again. The names it refuses are
  `PUBLIC_ORIGIN`, `CROSSBAR_PUBLIC_HOSTNAME`, `CROSSBAR_NETWORK_MODE`,
  `CROSSBAR_BIND_ADDRESS`, `TRUST_TAILSCALE_HEADERS`, `CROSSBAR_REQUIRE_DEVICE_AUTH`. A
  top-level `PUBLIC_ORIGIN=` is a legitimate override for a run that is not a deployment — a
  laptop with a dev server — and the mode's own block is where a deployment writes it; the
  refusal exists because a line outside the markers would silently win over the mode and one
  earlier version of this command deleted it instead.

  **The development checkout in this repository refuses for exactly this reason**: its `.env`
  is hand-written, has no marker lines yet, and carries `PUBLIC_ORIGIN=http://127.0.0.1:3010`
  at the top level, so `node src/admin.js mode public` there exits 1 with the message above.
  That is the rule working, not a regression; remove the line to use the CLI. A file with no
  markers at all is not refused — the section is appended at the end, leaving your own
  settings where you put them.
- **Nothing is written by a refusal.** No change to `.env`, and not even an `env.previous`
  appears: the mode is worked out before any file is touched.
- **Damaged markers.** One `MODE_BEGIN`/`MODE_END` line without the other, or the pair the
  wrong way round: `The generated section is damaged: this file has one of its two marker
  lines without the other, or has them the wrong way round. Fix that, then switch.`

The write is **not** atomic, deliberately, and both halves of that were measured. Content goes to
`.env` itself, keeping `<DATA_DIR>/env.previous` (mode 0600) — the file it replaced, copied before
the first byte is written, so a copy that fails leaves `.env` exactly as it was. What is given up
is stated plainly: a crash between the truncate and the last byte leaves a partial `.env`, where a
staged rename would have left one of the two whole files. It is given up because the rename cannot
run where the service runs, and because a rename hands `.env` the *staging* file's identity — two
separate failures, and the design has to survive both:

- **Sandboxed.** Measured on the production box, 2026-09-26, with a probe run under the unit's own
  hardening (`User=admin`, `ProtectSystem=strict`, `ReadWritePaths=<data> <.env>`): the staged
  rename failed **`EXDEV`** and the in-place write succeeded, leaving the file at mode 600 under its
  own owner with `env.previous` holding the old content. The cause is the grant itself — each path
  `ReadWritePaths` names becomes its own mount, so a rename from the data directory onto `.env`
  crosses a filesystem. This is the console's path, and it is why fixing the ownership below would
  not on its own have made the console able to move the box.
- **Unsandboxed.** Measured on Debian, 2026-09-26: `sudo node src/admin.js mode private` left `.env`
  owned by `root`, mode 600, correct in every way an operator could see, and the service
  (`User=admin`) then failed to start with `EACCES … path: '/home/admin/crossbar/.env'` — a symptom
  in a different process, at the next start, naming a file that looks fine.

`env.previous` is one generation, not a history, and it is the first thing to reach for if a switch
was interrupted or a setting was saved by mistake (§5.4).

### 3.3 What the restart applies

`sudo systemctl restart crossbar` restarts the server and, because the server unit wants them,
re-runs `crossbar-public.service` and `crossbar-private.service`. Each is a oneshot whose
`ExecCondition` asks the mode predicate through the CLI:

```
ExecCondition=/usr/bin/node /home/admin/crossbar/src/admin.js mode --configured public /home/admin/crossbar/.env
```

Exactly one passes, so exactly one acts, and which one is answered by the same file the
server reads — one answer to "which mode is this deployment in". The check asks **two** things
of that file: that it says this mode, and that this mode is configured — every name its own
block has to carry is set (`modeConfigured` in `src/config.js`; the same answer the listing and
`doctor` give). It was a whole-line `grep -qx CROSSBAR_NETWORK_MODE=public`, and that asked only
the first half: a file saying `public` with an empty public block passed it, so the unit started
Caddy — which cannot render the Caddyfile without a bind address — and scheduled
`tailscale serve off` while the server crash-looped on exactly the names the block was missing.
A switch to an unconfigured mode is refused, and a shaper no longer acts for one, because the
close is the half of a switch that lands on a timer and cannot be undone from outside the box.
The check is a command rather than `ConditionEnvironment=`, which looks like the obvious tool
and is silently wrong here: that condition is evaluated against the *manager's* environment, so
`EnvironmentFile=` never reaches it and it fails in **both** modes. Both units being skipped
quietly is worse than having none, because the box looks switched and is not.

The units move Caddy with a command rather than a dependency, and that is deliberate. A
`Conflicts=` or a `Wants=` is resolved while the start is still being planned, *before* any
condition is read, so a `Conflicts=caddy.service` on the private unit stopped Caddy even on a
start whose own condition then declined to make it a public one — a public outage decided by a
check nobody read. A command in `ExecStart` runs only once the check has passed, which is the
property the switch rests on. Both traps were measured with stand-in units rather than reasoned
about.

Each unit does three things, in order, and both run `Before=crossbar.service` — so the new door
is open before the server itself starts:

- **Public mode** opens the new door first — `systemctl start caddy` — and then schedules the
  tailnet door's close for the end of the window:

  ```
  ExecStart=-/bin/sh -c '/usr/bin/systemd-run --collect --unit=crossbar-grace-public \
    --on-active="${CROSSBAR_SWITCH_GRACE_SECONDS:-900}" \
    /bin/sh -c "/usr/bin/grep -qx CROSSBAR_NETWORK_MODE=public /home/admin/crossbar/.env \
      && exec /usr/bin/tailscale serve --https=443 off"'
  ```

  The tailnet stops *serving*; the node stays joined, because `tailscale down` would take the
  address with it and coming back means a re-approval.
- **Private mode** opens the tailnet door first — `tailscale serve --bg ${PORT:-3003}` — and then
  schedules `systemctl stop caddy` the same way, as `crossbar-grace-private`.
- **Both** then run `systemctl try-restart crossbar-turn.service`, best-effort. coturn's realm
  and `external-ip` are rendered from `.env` only when it starts, so a relay left running across
  a switch advertises the realm the box just left — which presents as calls that fail to relay
  rather than as a configuration error, the expensive way to find out. `try-restart` acts only on
  a unit that is already running, so a deployment with no relay is left alone.

Two details of those command lines are load-bearing, and both look like mistakes worth "fixing":

- **systemd does not expand `${NAME:-default}` in `Exec*=`** — only `${NAME}`, and the `:-`
  operator only inside an `EnvironmentFile` being read. Written bare, the expression would reach
  `systemd-run` as literal text, be refused, and the `-` prefix would swallow it into a switch
  that never closes the old door. Hence the outer `/bin/sh -c`, whose shell does have the
  operator — and hence the 900 appearing twice: the `Environment=` floor covers a file that says
  nothing, and the shell's `:-900` covers a file that says nothing *by setting the value empty*
  (`CROSSBAR_SWITCH_GRACE_SECONDS=`), which would otherwise expand to `--on-active=`.
- **`--on-active=` takes a bare number as seconds.** Do not append `s`: `15min` would arrive as
  `15mins` and be refused.

Both mode units are `oneshot` **without** `RemainAfterExit=yes`, deliberately: a oneshot
without it goes inactive after running, which is what makes the next restart run it again.
Adding `RemainAfterExit=yes` would silently stop every future switch from reshaping the box.

Nothing is remembered between switches: the shape is derived from the file on every start, so
a hand-started Caddy in private mode is stopped by the next start rather than left on.

### 3.4 The grace window

A switch opens the new door first and closes the old one **after** the window rather than at
once. Closing first is destructive for every phone: the app learns that the server moved by
reading `/api/health`, and the old door is the only address it can ask that on — so a door
closed before the app has read the answer is a device that has to be re-enrolled with a
hand-issued code. With the overlap, the app asks the address it already knows, finds an `origin`
that differs from the one it stored, adopts the address and the mode, and keeps its device key
(§3.5 and, on the app side, `Core/CallSession.swift`'s `followMovedServer`).

- **New way in first**: Caddy in public mode, `tailscale serve` in private mode.
- **The close is a transient unit** — `crossbar-grace-public` / `crossbar-grace-private`, created
  by `systemd-run --on-active=…` — so there is no extra unit file to keep in step, and `--collect`
  unloads it once it has fired so nothing is left behind either.
- **The window is one setting**: `CROSSBAR_SWITCH_GRACE_SECONDS` in `.env`, in seconds, **900
  (fifteen minutes) by default**. Each mode unit carries `Environment=CROSSBAR_SWITCH_GRACE_SECONDS=900`
  as a floor and `.env` wins over it. The variable is not in `.env.example`; add the line to
  change the window.
- **The close is guarded.** It re-reads `CROSSBAR_NETWORK_MODE` from `.env` with the same
  whole-line grep when it fires, not when it was scheduled, so a switch back inside the window
  keeps the door it just opened. The deferred unit **exits 1 when its guard declines** — that is
  the guard working, and it appears as one failed `crossbar-grace-public.service` line in the
  journal, not as a fault. A switch back inside the window needs no second timer: `systemd-run`
  refuses a name that already exists, the shaper tolerates that (`-`), and the pending timer is
  the one that does the right thing.
- `tailscale serve --https=443 off` failing with `handler does not exist` is the state the
  command asks for — nothing was serving — and is tolerated, as it was when it ran directly.
- **After every boot** the shapers re-run (the server unit wants them), so the outgoing door can
  stay as it was for up to the window rather than being closed during boot. A pending transient
  timer does not survive a reboot; a fresh one is scheduled, so the old door still closes.

**This is in the units now, and it has not been measured anywhere.** The units' own comments say
the posture claims below are measured on the rehearsal host before a deploy;
`scripts/rehearse-switch.sh` is that measurement — shorten the window with `GRACE=2` (its
default), and it checks that the old door is still open during the window, that something is
scheduled to close it, that it closes on its own, and that all of it survives being done in both
directions. What it does **not** check is `origin` on `/api/health`, and the private-direction
claim needs a request from outside the host, which a loopback rehearsal cannot make.

During the window both front doors answer. That is safe in both directions because the trust
posture follows the **mode**, not the door: in public mode the identity header is not believed at
all, so the tailnet door only admits devices holding keys; in private mode Caddy strips the
identity headers from outside, and a request with neither header nor device is refused. **Both
claims are the ones still to be measured** — they are the reason the overlap is safe, and the
units' comments say so themselves.

If a switch was made from the console rather than the CLI, check the box's shape afterwards:

```bash
systemctl is-active caddy
tailscale serve status
systemctl list-timers --all | grep crossbar-grace     # a close still pending?
```

`caddy` active and tailnet serving off is public mode; `caddy` inactive and `tailscale serve`
publishing the loopback port is private — but inside the window both doors answer on purpose, so
the third command is what tells you whether the switch has finished. If nothing is pending and
the shape is wrong, the shaping units did not run: `sudo systemctl restart crossbar` applies
them — unless the mode in force is not configured, in which case no restart will shape it
(`node src/admin.js mode` says so beside the mode), and its block has to be filled in first.

### 3.5 How to tell what mode is in force

Three different questions, three answers — they disagree only in the window between `mode`
and the restart:

```bash
node src/admin.js mode        # what the FILE says, whether it loads, and which block can start
node src/admin.js status      # what the RUNNING process is using
curl -fsS http://127.0.0.1:3003/api/health
```

`/api/health` is unauthenticated on purpose so a monitor, a browser or a `curl` can answer
"is this server up" before anything else works. In this tree it answers:

```json
{"status":"ok","mode":"private","version":"0.1.0"}
```

`version` is the running process's own version — the CLI can be a shell's checkout or a stale
one, so the process is the only thing that knows what it is. `origin` — the address the server
believes it is reached at — is specified and lands with the mode work; an app must tolerate a
missing or unrecognised field either way, because a device may be older than the server or
newer.

From outside, the same question over the real door:

```bash
curl -fsS https://<NETWORK_MODE_PUBLIC_HOSTNAME>/api/health
```

And the box's shape, which is not the same as either: `systemctl is-active caddy` and
`tailscale serve status` (§3.4). Inside the grace window **both doors answer on purpose**, so
those two alone cannot tell you a switch has finished. Look for the close that is still pending:

```bash
systemctl list-timers --all | grep crossbar-grace
systemctl status crossbar-grace-public.timer      # or crossbar-grace-private.timer
journalctl -u 'crossbar-grace-*' -n 20            # closes that have fired, and their exit status
```

### 3.6 What is unsafe mid-switch

- **Treating the file as the running mode.** Between `node src/admin.js mode public` and the
  restart, the file says public and the process is still private. `mode` reads the file;
  `status` and `/api/health` read the process. They must disagree in that window — that is the
  command working as designed, not a fault.
- **A mode whose block is not filled in.** A switch to it is refused, and the units no longer
  act for it either: they check that the mode is configured as well as written before they move
  a front door, so the box is left as it is rather than with its old door closed on the strength
  of a mode that cannot start. `node src/admin.js mode` says which names are missing, and
  `doctor` reports the same for each mode.
- **A second switch inside the grace window.** This is *handled* rather than forbidden: the
  deferred close re-reads the mode when it fires, so switching back inside the window leaves the
  door the second switch opened alone, and the journal shows one failed `crossbar-grace-*.service`
  line where the guard declined. What is worth knowing is that the first switch's timer is still
  pending until it fires, `systemd-run` will refuse to create a second one under the same name
  (`-`, on purpose), and a switch back therefore closes nothing extra — the pending timer is
  already the right one.
- **Expecting the box to look switched immediately.** After a switch the outgoing door stays open
  for up to `CROSSBAR_SWITCH_GRACE_SECONDS`, and after every boot too, because the shapers run on
  every start. In public mode that means the tailnet is still serving, and in private mode that
  Caddy is still up, until the timer fires. That is the overlap, not a stuck unit — and it is the
  window in which an already-enrolled phone finds the new address.
- **Administering a public deployment.** The CLI carries an *operator path* for exactly this: it
  sends `X-Crossbar-Operator`, an HMAC of a fixed string keyed by `CROSSBAR_SESSION_SECRET`, which
  the server believes only from loopback and only when the value matches in constant time. So
  `node src/admin.js ring --from <login> --to <person>` works in both modes, and the token is
  derived rather than stored, which rotates it with the session secret. What it cannot fix is a
  *browser*: the public ingress strips the header (`Caddyfile`, with the identity headers), and a
  browser cannot compute the token anyway, so the console still needs a device key — administer
  through the CLI, or over the tailnet.
- **Hand-editing the generated section, or restarting mid-edit.** The next switch overwrites
  it; a generated name left outside it makes the next switch refuse; and a hand edit skips the
  verification the CLI does. Edit the mode's own block (`NETWORK_MODE_*`) instead.
- **Assuming the old door is the old posture.** See §3.4: posture follows the mode.
- **Switching while anything is live.** The restart stops and starts `crossbar.service`, so
  every open signalling socket ends; a call in progress drops. Do it when nobody is calling.
- **`tailscale down`, `tailscale serve reset`, or adding `RemainAfterExit=yes`.** The first
  costs a re-approval, the second clears routes that are not this deployment's to clear, and
  the third silently stops mode switches from reshaping the box.
- **Killing the process instead of restarting the unit.** `Restart=always` brings the server
  back; only a restart of the unit runs the shaping units, which is the half of a switch that
  moves Caddy and the tailnet.

### 3.7 Undoing a switch

```bash
node src/admin.js mode private && sudo systemctl restart crossbar
```

If the file itself is broken and `mode` reports it does not load, the copy taken before the
last write is `<DATA_DIR>/env.previous` (mode 0600):

```bash
sudo install -o admin -g admin -m 600 /home/admin/crossbar/data/env.previous /home/admin/crossbar/.env
node src/admin.js mode          # confirm it loads and says which mode is in force
sudo systemctl restart crossbar
```

---

## 4. Runbook: backup and restore

### 4.1 What is backed up, and where

Exactly two things in this deployment cannot be reconstructed:

- **the database** — `$DATA_DIR/crossbar.sqlite` — the only record of who called whom, and the
  only place device keys, push tokens and invitations live;
- **the directory file** — `$DIRECTORY_CONFIG_PATH`, `data/directory.json` — the only thing a
  person typed.

Everything else (the units, the Caddyfile, `.env`) is in the repository or written by
`node src/admin.js`. Backups live under `$DATA_DIR/backups/`, which is
`/home/admin/crossbar/data/backups/` in the shipped configuration, mode 0700.

There are two kinds of entry:

| Entry | Written by | Kept |
| --- | --- | --- |
| `<UTC stamp>/` — a directory holding `crossbar.sqlite` and `directory.json`, both 0600 | `src/backup.js`, from the timer or by hand | newest 14 |
| `crossbar-before-v<N>-<UTC stamp>.sqlite` — one file, 0600 | the `Store` constructor, before it applies migrations | newest 5 |

The stamp is fixed-width and sorts chronologically: `2026-09-26T09-41-02-123Z` (`:` and `.`
replaced by `-`, so it survives every filesystem a copy might be carried to). Each routine
prunes only names it wrote, so a copy you put there yourself is never deleted by the timer.
The pre-migration snapshot is *not* a substitute for the daily backup: it is taken only when a
migration is about to run.

The database copy is made with SQLite's own `VACUUM INTO`, never with `cp`. This database runs
in WAL mode, where the newest transactions live in `crossbar.sqlite-wal` until a checkpoint, so
a plain file copy can silently capture a database several transactions old — and a backup
nobody can tell is stale is worse than one that is missing. `VACUUM INTO` reads through the WAL
and writes one consistent file, while the server is running.

### 4.2 The automatic backup

`deploy/crossbar-backup.timer` runs `deploy/crossbar-backup.service` `OnCalendar=daily`, with
`Persistent=true`, so a box that was off at the scheduled moment runs the missed backup when it
comes back. The unit has no `[Install]` section on purpose — only the timer should start it;
enabling the service would run a backup once at boot.

Note what is *not* here: nothing carries the copies off the box. `backup.js` keeps the newest
14, which is a fortnight of daily backups, and where they go next is a decision for whoever
runs the deployment — not an `scp` in a timer, which would hold a key nobody is reminded about.
§4.7 is the honest version of that.

```bash
systemctl list-timers crossbar-backup.timer          # when it last ran, when it runs next
journalctl -u crossbar-backup -n 20                  # the last runs
```

### 4.3 Taking one now, and reading the result

```bash
cd /home/admin/crossbar
node src/backup.js; echo "exit=$?"
```

Real output from a run on this checkout:

```
{"ts":"2026-09-26T12:25:05.752Z","level":"info","event":"backup.complete","path":"/Users/azzaam/Desktop/MASTER/PERSONAL/crossbar/server/data/backups/2026-09-26T12-25-05-748Z","databaseBytes":192512,"directoryBytes":993,"pruned":[]}
exit=0
```

One JSON line on stdout, in the logger's shape, because that is what the journal is read with;
`pruned` lists the entries it removed, and is empty most days. A failure prints
`{"level":"error","event":"backup.failed","error":"<why>"}` and exits non-zero, so the unit is
marked failed. A run that fails leaves nothing behind — the partial directory is removed,
because a directory holding the database copy but not the directory file would look like a
backup on the worst day of the year.

```bash
ls -l data/backups/2026-09-26T12-25-05-748Z/
-rw------- 1 admin admin 192512 ... crossbar.sqlite
-rw------- 1 admin admin    993 ... directory.json
```

Run it by hand before anything risky: an upgrade (§5), a mode switch, a directory edit you are
unsure about. It is safe while the server is running.

### 4.4 Restoring the database

Stop the service first. The files are owned by the service account and mode 0600, and the
backup directory is 0700, so restore as that account — `sudo cp` leaves a root-owned file the
service cannot write, and the next start fails on a permission error that names nothing useful.

```bash
STAMP=2026-09-26T12-25-05-748Z       # the backup directory to go back to
sudo systemctl stop crossbar
sudo install -o admin -g admin -m 600 \
  /home/admin/crossbar/data/backups/$STAMP/crossbar.sqlite \
  /home/admin/crossbar/data/crossbar.sqlite
sudo rm -f /home/admin/crossbar/data/crossbar.sqlite-wal \
           /home/admin/crossbar/data/crossbar.sqlite-shm
sudo systemctl start crossbar
node src/admin.js status             # the counts are the ones the backup held
```

Three things matter and each has bitten somebody:

- **Stop the server.** Dropping a file under a process holding the old one open is not a
  restore, it is two databases in one file.
- **Delete `crossbar.sqlite-wal` and `-shm`.** The backup is a standalone consistent file; a
  stale write-ahead log from the database you just replaced is at best ignored and at worst
  applied to a file it does not belong to.
- **Ownership and mode.** `admin:admin`, `600`. The service runs with `UMask=0077` and a
  `ReadWritePaths` that names the data directory, so a file it cannot write is a server that
  starts and then fails on the first request.

**Restoring a pre-migration snapshot is the same procedure** with the file at the top level
instead of in a stamp directory, and it is the rollback for a bad migration (§5.4):

```bash
sudo systemctl stop crossbar
sudo install -o admin -g admin -m 600 \
  /home/admin/crossbar/data/backups/crossbar-before-v6-2026-09-26T09-41-02-123Z.sqlite \
  /home/admin/crossbar/data/crossbar.sqlite
sudo rm -f /home/admin/crossbar/data/crossbar.sqlite-wal /home/admin/crossbar/data/crossbar.sqlite-shm
sudo systemctl start crossbar
```

### 4.5 Restoring the directory file

People, contacts and groups come from the file and are re-applied to the database on every
start (`Store.syncDirectory`), so restoring it is restoring the file and restarting:

```bash
sudo install -o admin -g admin -m 600 \
  /home/admin/crossbar/data/backups/$STAMP/directory.json \
  /home/admin/crossbar/data/directory.json
sudo systemctl restart crossbar      # syncDirectory re-applies it
```

If the loss is a bad edit rather than a disk failure, look first at the neighbour the writer
leaves behind: every write of the directory file stages `directory.json.writing` and keeps the
version before it at **`directory.json.previous`**. That is one edit back, and it is usually
the one you want.

Restoring the directory file does not touch device keys: a person's devices, their tokens and
their history live in the database. Restoring only the database does not lose people either —
the file wins at the next start — but restore both from the same stamp if you can, so the two
agree at the moment they are put back.

### 4.6 What is lost if you do not

- **No database backup**: every device key, every push token (VoIP and alert), every
  invitation state and every call record. Each phone must be re-enrolled with a hand-issued
  code, and until each one files a fresh VoIP token it cannot be rung while asleep. This is
  the failure that cannot be repaired from anywhere else.
- **No directory-file backup**: the people, contacts and groups — the only thing in the
  deployment a person typed. The server will not start without a directory file at all
  (`No directory file at <path>.`), and one with no people, or no active administrator, is
  refused with the messages in §2.4. Rebuilding it means typing the household back in, and
  in private mode the console refuses every directory edit while any person in the file lacks
  a login (§7), so the file has to be repaired by hand before the console can help.

### 4.7 Carrying copies off the box

Not implemented, and deliberately not hidden: nothing in this repository copies backups off
the host, so a lost host or a lost disk loses the backups with it. The honest minimum is to
copy `$DATA_DIR/backups/` somewhere else on a schedule you control (whatever `rsync`, `restic`
or the VPS provider's snapshot offers), and — because the copies hold every login in the house
and every device key — to keep them somewhere at least as private as the box.

---

## 5. Runbook: upgrading and rolling back

### 5.1 The commands that do this

Four scripts, each with `--dry-run`, which prints every command it would run — including the unit
rendering of §2.5 — and executes none:

| Command | What it is |
| --- | --- |
| `scripts/release.sh [--out DIR]` | builds `crossbar-server-<version>.tar.gz` and the `.sha256` beside it, from a clean tree |
| `scripts/install.sh [--prefix DIR] [--user NAME] [--source DIR] [--with-relay] [--answers FILE] [--browser] [--tailscale-authkey KEY] [--tailscale-hostname NAME] [--no-setup]` | §2.2–§2.6 as one command (§2.2), with the setup wizard — including the tailnet join it makes itself (§2.2.1) — and the private front door's Tailscale preparation and safety-net login (§2.8.1) |
| `scripts/upgrade.sh --from <tarball>` | stop, snapshot, unpack, install, start, verify, roll back (§5.3) |
| `scripts/uninstall.sh [--prefix DIR] [--user NAME] [--purge-data]` | stop and remove the units; `--purge-data` for the data directory and `.env` (§5.6) |

They are also `npm run release`, `npm run deploy`, `npm run upgrade` and `npm run uninstall`;
extra arguments go after `--`, as in `npm run deploy -- --dry-run`. The three that act on a
deployment take their defaults from `CROSSBAR_HOME` (`/home/admin/crossbar`) and `CROSSBAR_USER`
(`admin`); `release.sh` builds where you tell it to and knows nothing about a host.

What they deliberately do not do: nothing here knows how a tarball reaches a host — no remote, no
`git push`, no SSH — so the transport (a bundle, `rsync`, `scp`, a USB stick) is still the
operator's; the installer prepares Tailscale before the wizard and the wizard joins the tailnet
itself, and Caddy is installed and its Caddyfile validated (§2.2.1, §2.8.1), but DNS, the port
forwards and the firewall, the tailnet approval itself when there is no key, and the relay's own
configuration are still the operator's (§2.8, §2.9, §8);
nothing carries backups off the box (§4.7); and nothing commits anything. `release.sh`
refuses a tree with uncommitted changes, because an artefact that cannot be reproduced from a
commit cannot be returned to; `--allow-dirty` builds one anyway, which is for a rehearsal.

The scripts were written and their `--dry-run` read on macOS, which has no systemd: **the first
real install, upgrade and uninstall happen on the rehearsal host, by the integration owner**, and
§2.10 lists what to check there.

### 5.2 Where the version is reported

```bash
node src/admin.js status | head -1        # Version 0.1.0  (from package.json)
curl -fsS https://<public host>/api/health
```

`/api/health` answers with `"version": "0.1.0"`, the running process's own — which is the
question the CLI cannot answer, because the CLI may be a different checkout from the one the
service runs. That is the check after an upgrade: same command, different version.

The same `package.json` names the tarball (`crossbar-server-0.1.0.tar.gz`, §5.1), so there are
three places this one string appears: the artefact's name, the version `npm` sees, and what the
running process answers. `scripts/upgrade.sh` reads it from the tarball's own `package.json` and
refuses to call the upgrade healthy unless `/api/health` reports exactly that — which is how a
restart that never took the new tree shows up as a failure rather than as a quiet no-op.

### 5.3 Upgrading

Two commands, on two machines. On the machine with the repository, from a clean tree:

```bash
scripts/release.sh --out /tmp/release        # crossbar-server-0.1.0.tar.gz + .sha256
```

and on the deployment host, as root:

```bash
sudo scripts/upgrade.sh --from /tmp/release/crossbar-server-0.1.0.tar.gz --dry-run   # read it first
sudo scripts/upgrade.sh --from /tmp/release/crossbar-server-0.1.0.tar.gz
```

What the upgrade does, in order, and why each step is where it is: it stops `crossbar` (a snapshot
of a database somebody is writing is not a snapshot of anything); takes one with `src/backup.js`
from the tree still in place, and **starts the old service again and stops** if that fails, because
an upgrade with no way back is not one to run; unpacks the tarball beside the running tree and runs
`npm ci --omit=dev` there, so a bad dependency or a truncated artefact is found while the
deployment is still the one that works; swaps the two trees while carrying `data/` and `.env`
across — they are this host's, and the tarball carries neither; reinstalls the units from the new
tree, rendered for this host's paths; starts, and asks `/api/health` for its version. A version
other than the one in the tarball, or no answer within 30 seconds, is a **rollback**: the previous
tree comes back, the database is restored from the snapshot, the previous units are reinstalled,
and the service is started again — §5.5 is the same order by hand.

After a healthy upgrade the tree that was replaced is kept at `/home/admin/crossbar.previous`, with
no `data/` or `.env` in it (one copy of those is the deployment; a second would be a second thing
to lose). It is what a later manual rollback moves back, and it is one generation deep, like
`env.previous`.

The same thing by hand, which is also what to fall back on when the transport is the problem or a
step has to be watched:

```bash
cd /home/admin/crossbar
node src/admin.js status                  # note the version, and that the box is healthy
node src/backup.js                        # a copy you can go back to (§4.3)
git status --porcelain                    # must be empty: local edits are how an upgrade goes wrong
git log --oneline -3

# bring the new code in — see the note below
git pull                                  # or: git bundle / rsync, whatever this box uses

npm ci --omit=dev
node src/admin.js mode                    # the .env still loads cleanly
node src/admin.js doctor                  # if the server is up
sudo systemctl restart crossbar
node src/admin.js status                  # the version changed
journalctl -u crossbar -n 50 --no-pager
```

There is no remote configured in the checkout this was written in, and the software cannot
see how the code arrives: whatever transport the box uses (a remote you set up, a bundle as
the earlier migration used, `rsync`, or the tarball of §5.1) is the operator's. The only network
the upgrade itself needs is `npm ci` reaching the registry (or a populated npm cache); there is no
build step and `node:sqlite` is Node's own.

**If `deploy/*.service` changed, the code update does not install it** — `scripts/upgrade.sh` does;
a by-hand upgrade has to. Units live in `/etc/systemd/system`, so re-install and reload:

```bash
sudo install -m 644 deploy/crossbar.service deploy/crossbar-public.service \
                    deploy/crossbar-private.service deploy/crossbar-backup.service \
                    deploy/crossbar-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl restart crossbar
```

Keep the previous copies of any unit you replace, so a rollback of the units is a copy back
rather than a rewrite. For a non-default user or path, `scripts/install.sh --dry-run` prints the
rendered result of these lines — the substitution §2.5 describes — which is easier than rewriting
them by hand.

### 5.4 The pre-migration snapshot

`MIGRATIONS` in `src/db.js` run automatically in the `Store` constructor, forward-only, keyed
on `PRAGMA user_version`. Under `Restart=always`, a migration that fails on a real database
takes the service down and systemd starts it again into the same failure — so, before applying
anything, the constructor snapshots the database whenever the file is behind the highest known
migration version **and already has tables**:

```
/home/admin/crossbar/data/backups/crossbar-before-v6-2026-09-26T09-41-02-123Z.sqlite
```

`v6` is the highest migration version in the build being started (today: 6). Newest 5 kept. A
fresh install gets none, because a database with no tables is one this constructor is about to
create and a copy of it protects nothing. If the snapshot cannot be written, the start is
refused:

```
Refusing to migrate to v6 without a snapshot: <why>
```

That refusal is a deployment that is down but intact, which is the point: migrating without a
copy is one that may be neither. So after a failed upgrade, the first place to look is
`ls -lt $DATA_DIR/backups/` — a new `crossbar-before-v*` file means the new build migrated the
database, and §4.4's second procedure with that file is the way back.

### 5.5 Rolling back

`scripts/upgrade.sh` performs the order below by itself, the moment the new build does not answer
`/api/health` with its own version — the previous tree, the snapshot, and the units that go with
them, then a start and a health check of their own. This section is what it is doing, and what to
use when the failure shows up later: a migration that only misbehaves under real traffic, a relay
that stops relaying, a phone that stops ringing. The previous tree is kept at
`/home/admin/crossbar.previous` (§5.3), and `/home/admin/crossbar.failed-<stamp>` holds the tree
that failed, for the journal and the diff.

Roll back in this order, and stop as soon as the server is healthy again:

1. **The code.** `git log --oneline` for the commit you came from (or the bundle you arrived
   from), `git checkout <that commit>`, `npm ci --omit=dev`, `sudo systemctl restart
   crossbar`, then `node src/admin.js status`.

   A version that fails to start before touching the database — a syntax error, a bad
   dependency, a unit that will not parse — has changed nothing and the old code starts on the
   same database. Note that a CLI run of the new code is enough to migrate the file, so "did
   the new code ever run" is the question that decides whether the snapshot matters.
2. **The units**, if they changed: copy the previous unit files back, `daemon-reload`,
   `restart`.
3. **The database**, if it was migrated:

   ```bash
   sudo systemctl stop crossbar
   sudo install -o admin -g admin -m 600 \
     /home/admin/crossbar/data/backups/crossbar-before-v6-<stamp>.sqlite \
     /home/admin/crossbar/data/crossbar.sqlite
   sudo rm -f /home/admin/crossbar/data/crossbar.sqlite-wal /home/admin/crossbar/data/crossbar.sqlite-shm
   sudo systemctl start crossbar
   node src/admin.js status
   ```

   Migrations are forward-only: there is no down-migration and an older build is not promised
   to read a file a newer one migrated. This step loses everything recorded since the snapshot
   — calls, device enrolments, push tokens filed in between — and that cost is exactly why the
   snapshot is taken before the migration rather than after.

Test the rollback you intend to rely on *before* you need it: a rollback that has never been
run is a plan, not a procedure.

### 5.6 Removing a deployment

```bash
sudo scripts/uninstall.sh --dry-run          # the units it would remove, and nothing else
sudo scripts/uninstall.sh
```

It stops and disables the units, removes them from `/etc/systemd/system`, removes the relay's
rendered template at `/etc/crossbar/coturn.conf` and an emptied `/etc/crossbar`, and runs
`daemon-reload`. **It leaves the checkout, `.env` and `data/` where they are** — the database,
the directory file and the backups, the two things in this deployment that cannot be
reconstructed — and says so at the end, so removing the units is a thing you can undo by
installing them again. `--purge-data` also deletes `data/` and `.env`, names both before it does,
and refuses unless the prefix looks like a Crossbar checkout first.

**Before either of those, take the two things in §4.1 off the machine**, because that is the only
place they exist. The account is left in place too; `userdel -r` deletes its home directory, which
is where the checkout is, so it is the last step and not the first.

By hand it is the same sequence: `sudo systemctl disable --now crossbar crossbar-backup.timer
crossbar-turn` (the two shaping units have no `[Install]` and are reached through `crossbar`),
remove the unit files, `daemon-reload`, and then the checkout and `data/` are ordinary files you
delete yourself.

---

## 6. Checking a deployment

Three commands answer the questions that otherwise only surface at the far end of a call that
did not ring.

`node src/admin.js status` reports the version, the mode, the origin, the listener and the
counts. Real output from the development checkout:

```
$ node src/admin.js status
Version           0.1.0
Mode              private
Origin            http://127.0.0.1:3010
Listener          127.0.0.1:3010
Device auth       not configured
TURN              not configured
APNs              not configured — a missed call tells nobody
Push relay        not configured — a phone whose screen is off cannot be rung
People            3
Devices           5
Open invitations  0
```

On a deployment, `Origin` is the mode's origin, `Device auth` reads `required` in public mode,
and `TURN`/`APNs`/`Push relay` carry their configured values or say they are not configured.

The **Push relay** line is the one that decides whether a locked phone rings: a suspended iOS app
is woken by nothing except a VoIP push, and this deployment posts that push through the relay
(§2.7.1) rather than to Apple itself. The **APNs** line is the other transport — a browser can be
woken by Web Push, and the missed-call notification is an ordinary alert that still goes to Apple
from here — so a deployment with the relay configured and no APNs key rings normally and says
nothing about the calls that were missed while the phone was asleep.

`node src/admin.js doctor` runs the reachability checks and prints one line each; the exit
code is 0 only when every line is `OK`. Real output from the same checkout, with no server
running and no session secret set:

```
$ node src/admin.js doctor
OK    Network mode          private (tailnet)
FAIL  Device authentication not configured (CROSSBAR_SESSION_SECRET is empty)
OK    Database              3 people, 5 devices
FAIL  HTTPS                 fetch failed
OK    STUN                  public address 119.154.255.67:56559
OK    TURN                  not configured (direct media only)
```

A private deployment skips the public checks rather than failing them, so in private mode the
list is Network mode, Device authentication, Database, HTTPS, STUN, TURN; in public mode it
adds DNS, TLS certificate and WebSocket between Database and STUN. Each check is its own line
rather than folded into one verdict, because "public mode is broken" is not something an
operator can act on. The TURN line reports reachability, not an allocation.

`node src/admin.js devices` lists devices with a **RING** column: `yes` where the phone can be
rung while it is asleep, `NO` where it cannot — no VoIP token on file, either because the phone has
never filed one or because the relay has since reported the one it filed dead (a `410`, which
clears it here). `NO` reads from the caller's end as a broken deployment and is visible nowhere else
in that output. The column answers a different question from `KEY`, which is only whether the device
holds a key.

`node src/admin.js ring --from <id> --to <id>` places a test call **through** the live server,
over the loopback the server already treats as its proxy, so it reaches both the sockets and the
push relay — a call placed any other way would ring nothing, because the running process is the one
holding the connections and the relay credential. `--from` has to be a person with a login,
because a login is how a request is believed here. That is why a directory keeps one test
person who has one: `ringtest` ("Ring Test"), with the placeholder login `ringtest@example.com`
and contacts with `abdullah`, exists so a call can be placed from the machine. The directory
file as it was before that change is kept beside it, at `data/directory.json.before-ringtest`.

---

## 7. The directory, and logins

A person is found by their tailnet login wherever a proxy names the caller, so a person without
one has no identity: they cannot be reached by it, and the console lists them without one. That
is a state to fix rather than a reason to refuse to run — a deployment must never be switched
into a mode it cannot start in — so the server starts with a directory whose people have no
login, and the file is read and shown as it is. The rule is about what may be *written*: in
private mode the console asks for a login when a person is added or changed, which is the same
switch that decides whether a proxy header is believed, because that header *is* the login
(`requireLogins = config.trustTailscaleHeaders`).

**What was an open item on 2026-09-24 is fixed.** The console used to refuse **every** directory
edit while any person in the file lacked a login —

```
DIRECTORY_INVALID: faisal has no login, and a person is found by theirs here.
```

— which meant the console could not be the place where the missing logins were added: the one
edit that would fix the directory was blocked by the same rule. A directory write no longer
enforces it (`directoryFile.write(..., { requireLogins: false })`), because a directory the
server can run is not one it should refuse; the missing logins are reported instead, as
sentences on the people response (`GET /api/admin/people` → `warnings`, each reading
`<id> has no login, so nothing finds them by their tailnet identity. They can still use this
server from a device that has enrolled.`) and shown by the console on the directory card.

Two people in that deployment have neither a login nor a device, so in private mode they can
neither call nor be called; naming somebody in the file is not the same as reaching them, and
the console shows those two facts separately.

A person taken out of the file keeps their row, because calls, participants and devices all
point at it, so `node src/admin.js users` can list somebody who is no longer in the directory
and has not been used since. What the application shows is the persons the file names.

The header is not the difficulty. Serve **does** deliver `Tailscale-User-Login` in this
tailnet — `/api/session` over the tailnet answers `identity: {source: "tailscale"}`, resolving
to `abdullah` — and the server believes it only in private mode, because `TRUST_TAILSCALE_HEADERS`
is off in public mode, where the same header is one a stranger can type. That the header is
*present* and that the server *believes* it are two different facts, and treating them as one
cost this project two wrong conclusions on 2026-09-24.

---

## 8. Host facts the software cannot see

Nothing in this repository can check the following, and none of it is a software defect when
it is wrong. They are listed together because every one of them presents as "Crossbar is
broken".

### 8.1 DNS

One record matters: the public block's `NETWORK_MODE_PUBLIC_HOSTNAME` must resolve to the home
connection.

- `A` — the connection's IPv4 address.
- `AAAA` — its IPv6 address, if the ISP provides one. Worth having: native IPv6 has no NAT, so
  an `AAAA` record can be the only way in when the IPv4 side is behind carrier-grade NAT. With
  IPv6 there is nothing to forward, but the firewall — router and host — still has to allow the
  ports below.

The address has to be kept current by hand; there is no DDNS integration in this repository.
Caddy survives an address change (its certificate renews over the new one); coturn does not,
for the reason in §8.4.

### 8.2 Ports

| Port | Proto | Forward to | Why |
| --- | --- | --- | --- |
| 80 | TCP | host:80 | HTTP, redirected to HTTPS (and the ACME HTTP-01 challenge, if used) |
| 443 | TCP | host:443 | HTTPS and WSS: the API and the signalling socket |
| 3478 | UDP | host:3478 | STUN and TURN over UDP: the common path, and the one that matters |
| 3478 | TCP | host:3478 | optional: TURN over TCP, for networks that drop UDP |
| 49160-49200 | UDP | host: same range | the relay itself: the media, when no direct path exists |

The relay range is `CROSSBAR_TURN_MIN_PORT`-`CROSSBAR_TURN_MAX_PORT`. Forward it 1:1 —
relayed port 49162 must arrive as 49162 — and widen it in both `../.env` and the router if a
house of simultaneous relayed calls ever exhausts it. Nothing forwards the backend port 3003
(`PORT`): it is loopback-only by design.

On the host with `ufw`:

```
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 3478/udp
sudo ufw allow 3478/tcp
sudo ufw allow 49160:49200/udp
```

`ufw` applies rules to IPv4 and IPv6 unless told otherwise; check with `ufw status verbose` if
both families are in use.

Whether the router forwards these at all is the host's fact, not the server's — and a forward
that exists on the wrong address, or a WAN address that moves, look from inside exactly like a
working deployment. The conclusive test is from outside: forward 443 and open
`https://<public hostname>/api/health` from a phone on cellular data with Wi-Fi off.

### 8.3 CGNAT

If the ISP puts the connection behind carrier-grade NAT, no amount of port forwarding on the
home router will let anything in, and public mode is simply not feasible on IPv4. **This
cannot be detected with certainty from inside the network**, so treat any single check as
evidence rather than proof:

- A router WAN address inside `100.64.0.0/10` is certainly CGNAT.
- A WAN address that matches what an external "what is my address" service reports makes CGNAT
  unlikely, but does not rule it out: some carriers hand out addresses that look public and are
  still not reachable inbound. `node src/admin.js doctor`'s STUN line is that external check —
  it reports what the internet thinks the address is.
- The only conclusive test is from outside, as in §8.2.

The options if that happens: ask the ISP for a public or static address; use an `AAAA` record if
the ISP provides IPv6 (which bypasses IPv4 NAT entirely, but only for clients that have IPv6);
put a VPS or a tunnel in front; or stay in private mode, where Tailscale needs no inbound path
at all because both ends dial out.

### 8.4 Residential addresses

A home address is not a fixed one, and both halves of this deployment name it.

- **DNS** must keep pointing at the home server. Repoint the record when the ISP moves the
  address; there is no DDNS integration yet, and until it is repointed clients cannot reach the
  server at all — not even to be told why.
- **coturn** needs `external-ip` set (in `coturn.conf`, commented out by default) whenever the
  host is behind NAT, which a home router means it is: without it the relay can advertise an
  address on the home LAN that nothing outside can use. It is a literal address, so a change
  invalidates it — the relay then advertises an address that no longer exists, and relayed
  media dies while everything else keeps working. `CROSSBAR_TURN_EXTERNAL_IP` carries it into
  the rendered config.

---

## 9. Files

| File | Where it goes | What it is |
| --- | --- | --- |
| `Caddyfile` | `/etc/caddy/Caddyfile` | the only public listener |
| `crossbar.service` | `/etc/systemd/system/` | the Crossbar server (the same one in both modes) |
| `crossbar-public.service` | `/etc/systemd/system/` | what public mode means for Caddy and the tailnet |
| `crossbar-private.service` | `/etc/systemd/system/` | what private mode means for them |
| `crossbar-turn.service` | `/etc/systemd/system/` | runs coturn, hardened |
| `crossbar-backup.service` | `/etc/systemd/system/` | one backup, run by the timer |
| `crossbar-backup.timer` | `/etc/systemd/system/` | daily, and a missed run when the box comes back |
| `coturn.conf` | `/etc/crossbar/coturn.conf` | a template; the relay unit renders it |

The templates are read from `/etc`, not from the checkout: `crossbar-turn.service` runs as
`turnserver`, and a home directory is mode 0700, so it cannot open anything under
`/home/admin` at all. Install these files — `scripts/install.sh` does, rendered for this host's
paths (§2.5) — then hand Caddy and coturn the same environment file the server reads (§2.8,
§2.9).

The other half of the deployment surface is `scripts/`, which stays in the checkout rather than
going to `/etc`:

| File | What it is |
| --- | --- |
| `install.sh` | §2.2–§2.6 as one command, with Tailscale prepared before the wizard and the front door after it (§2.2, §2.2.1, §2.8.1) |
| `release.sh` | the versioned tarball and its checksum (§5.1) |
| `upgrade.sh` | stop, snapshot, unpack, install, verify, roll back (§5.3, §5.5) |
| `uninstall.sh` | stop and remove the units; `--purge-data` for the data (§5.6) |
| `rehearse-switch.sh` | the mode-switch rehearsal, which must not be run on a live deployment (§3.4) |
| `lib/deploy.sh` | what the four share: the unit rendering, the health check, the transcript, and the onboarding phase (§2.2.1) |

The unit files, this document and those scripts are the deployment surface. The rest of the
software — the config surface, the API, the directory — is described from the code in the server
repository's `src/`, and the console at `/admin` is the same operations as `node src/admin.js` for
whoever would rather use a browser.
