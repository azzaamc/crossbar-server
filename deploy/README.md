# Running a Crossbar deployment

Crossbar is one Node process and one SQLite file. What runs it is in this directory: the
systemd units, the Caddyfile that fronts it in public mode, the coturn template for a relay,
and this document — which is the runbook for the three things an operator does to a live
deployment (switch modes, back it up and restore it, upgrade and roll back), and the
step-by-step for installing a second household.

> **Verification status — 2026-09-26.**
>
> Written by reading the code and the unit files. **No agent has connected to production**,
> and the unit files could not be run where this was written: they were authored on macOS,
> which has no `systemd-analyze`, and production is not ours to touch. So the integration
> owner has **not yet** verified:
>
> - the unit files at all — `deploy/*.service` and `crossbar-backup.timer` are read, not run;
>   the real check (`sudo systemd-analyze verify`) and the first switch happen on the box:
> - the switch overlap and its grace window (§3.4). The units in this tree still close the
>   old door **first**; opening first and closing on a timer is the design the mode work
>   lands, and the trust-posture claims it rests on are to be measured on a scratch host;
> - whether a switch made from the **console** (§3.1) reshapes the box. The console exits the
>   process for systemd's `Restart=always` to start again rather than running
>   `systemctl restart`, and whether that re-runs the two shaping units is not established
>   here. §3.4 says what to check;
> - the backup timer firing, and the restore in §4.4 being rehearsed. `runBackup` is covered
>   by tests in this tree; the unit wiring and the restore were not;
> - `origin` in `GET /api/health` (§3.5). It is specified and lands with the mode work; the
>   response in this tree carries `status`, `mode` and `version` only;
> - the full server test suite on the merged tree.
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
  `/home/admin/crossbar`, which is what the unit files hard-code; a different user or path
  means editing the units (§2.5).
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

There is no build step and no installer. Two runtime dependencies (`ws`, `web-push`) plus
Node's own `node:sqlite`, and nothing to compile.

### 2.3 `.env`

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
  block is empty is refused at switch time, leaving the file as it was.
- `CROSSBAR_ADMIN_PASSWORD_HASH` via `node src/admin.js password`, not by hand.

Do **not** fill in the generated section (between the `>>> the configuration in force >>>`
markers): that is written by the switch. Do not leave a copy of one of its names
(`PUBLIC_ORIGIN`, `CROSSBAR_PUBLIC_HOSTNAME`, `CROSSBAR_NETWORK_MODE`,
`CROSSBAR_BIND_ADDRESS`, `TRUST_TAILSCALE_HEADERS`, `CROSSBAR_REQUIRE_DEVICE_AUTH`) anywhere
else in the file — a switch refuses when you do (§3.2).

`.env` is read by systemd (`EnvironmentFile=` in every unit), by the server, and — through a
drop-in — by Caddy. Writes go through the data directory (staging `.env.writing`, keeping
`env.previous`) rather than in place, which is why `crossbar.service`'s `ReadWritePaths` names
the data directory and `.env` and nothing more.

### 2.4 The directory file — required, not optional

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

**A second household at a different user or path has to edit the units first.** The paths are
literal, not templated: `User=admin`, `Group=admin`,
`WorkingDirectory=/home/admin/crossbar`, `EnvironmentFile=/home/admin/crossbar/.env`,
`ExecStart=/usr/bin/node /home/admin/crossbar/src/server.js`, `ExecStart=/usr/bin/node
/home/admin/crossbar/src/backup.js`, and `ReadWritePaths=/home/admin/crossbar/data
[/home/admin/crossbar/.env]` in the server and backup units; the same
`EnvironmentFile` plus `/home/admin/crossbar/.env` in the two mode units' `ExecCondition`
greps; and `/etc/crossbar/coturn.conf` in the relay unit. Nothing else about the software is
site-specific.

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

### 2.7 The first phone

```bash
node src/admin.js password                 # the console's password, prompted twice
node src/admin.js enroll --user abdullah   # a one-time invitation, printed once
```

The invitation prints the JSON and the token; the token exists nowhere else, so the output is
the one chance to hand it over. The console is at `/admin` on the server's own origin, and
its password is what makes it reachable from a browser that has enrolled no device key.

To ring a phone whose screen is off, APNs must be configured (`CROSSBAR_APNS_KEY_ID`,
`_TEAM_ID`, `_KEY_PATH`, `_TOPIC` in `.env`); without it the console and `status` say
`not configured — a phone with its screen off cannot be rung`, and a locked phone simply never
rings while everything else keeps working. Web Push is the browser's equivalent and is
optional.

### 2.8 Public mode: Caddy, DNS, ports

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

Then `sudo systemctl restart caddy`. Nothing else from `.env` is used by Caddy, and `PORT`
only matters if the server does not listen on 3003.

`NETWORK_MODE_PUBLIC_BIND_ADDRESS` in the public block is the other value Caddy reads — the
switch copies it to `CROSSBAR_BIND_ADDRESS`, which is the name the Caddyfile expands. It is
the address Caddy listens on: set it to the address the router forwards to, never the
wildcard. A host that already serves the same ports over a tailnet holds `:443` on its own
address, and a wildcard bind beside a specific one is either refused outright or resolved by
the kernel's discretion, which is not a thing to leave a public listener to. It has to be
stable, so reserve it on the router. Changing it while already in public mode needs
`sudo systemctl restart caddy`: systemd reads `EnvironmentFile=` at start, not on reload.

DNS (§8.1) and the port forwards and firewall (§8.2) are host facts the software cannot see.
Install the `Caddyfile` at `/etc/caddy/Caddyfile` and check it with `caddy validate
--config /etc/caddy/Caddyfile` before restarting Caddy.

### 2.9 Installing the relay (optional)

`coturn.conf` is a template and coturn cannot read it: coturn's configuration format has no
environment substitution, so the file holds `${CROSSBAR_*}` references and
`crossbar-turn.service` renders it with `envsubst` into `/run/coturn/turnserver.conf`, taking
the values from the same `.env` the server reads. The shared secret is therefore never
committed and the rendered copy lives on a tmpfs.

The install commands are with the other units (§2.5). Then set
`CROSSBAR_TURN_HOST=<CROSSBAR_PUBLIC_HOSTNAME>` and a `CROSSBAR_TURN_SHARED_SECRET`
(`openssl rand -hex 32`) in `.env`, and restart the relay and the server so the ICE list the
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

`node src/admin.js mode` with no argument lists both blocks, marks the one in force, and
answers whether the file loads as a process would read it:

```
$ node src/admin.js mode
   MODE       HOSTNAME                              ORIGIN
-> private    -                                     (unset: invitations would carry the default origin)
   public     -                                     (unset: invitations would carry the default origin)

private is in force, and loads cleanly.
```

(That is the development checkout, whose blocks are empty. A deployment's two lines carry its
tailnet name and its public hostname.) Exit code is 1 when the file does **not** load, so this
is also the command to run before a restart when something is wrong.

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

- **An empty mode block.** It writes the file, the verification fails, it puts the file back
  byte for byte, and it names what is missing:
  `Cannot switch to public: NETWORK_MODE_PUBLIC_HOSTNAME (or CROSSBAR_PUBLIC_HOSTNAME) is
  required in public mode: it is the host invitations send people to`, followed by
  `Fill in its block in .env — NETWORK_MODE_PUBLIC_HOSTNAME and NETWORK_MODE_PUBLIC_ORIGIN —
  and try again.` The origin not naming the hostname is refused the same way.
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
- **Damaged markers.** One `MODE_BEGIN`/`MODE_END` line without the other, or the pair the
  wrong way round: `The generated section is damaged: this file has one of its two marker
  lines without the other, or has them the wrong way round. Fix that, then switch.`

The write itself is atomic: content is staged at `<DATA_DIR>/.env.writing` and the file it
replaces is kept at `<DATA_DIR>/env.previous` before the staged file is renamed into place.
Both are mode 0600. So after any switch, `env.previous` holds `.env` exactly as it was
immediately before that write — the first thing to reach for if a switch was interrupted or a
setting was saved by mistake. It is one generation, not a history.

### 3.3 What the restart applies

`sudo systemctl restart crossbar` restarts the server and, because the server unit wants them,
re-runs `crossbar-public.service` and `crossbar-private.service`. Each is a oneshot whose
`ExecCondition` is a whole-line grep of `.env`:

```
ExecCondition=/usr/bin/grep -qx CROSSBAR_NETWORK_MODE=public /home/admin/crossbar/.env
```

Exactly one passes, so exactly one acts, and which one is answered by the same file the
server reads — one answer to "which mode is this deployment in". The check is a `grep` rather
than `ConditionEnvironment=`, which looks like the obvious tool and is silently wrong here:
that condition is evaluated against the *manager's* environment, so `EnvironmentFile=` never
reaches it and it fails in **both** modes. Both units being skipped quietly is worse than
having none, because the box looks switched and is not.

- **Public mode** runs `tailscale serve --https=443 off`, then `systemctl start caddy`, then
  `systemctl try-restart crossbar-turn.service`. The tailnet stops *serving*; the node stays
  joined, because `tailscale down` would take the address with it and coming back means a
  re-approval. The relay is restarted because coturn's realm and `external-ip` are rendered
  from `.env` when it starts: a switch that left it running would advertise the old realm,
  which presents as calls that fail to relay rather than as a configuration error.
  `try-restart` is used because a deployment without the relay installed must not fail.
- **Private mode** runs `systemctl stop caddy`, then `tailscale serve --bg ${PORT:-3003}`.
  `${PORT:-3003}` rather than `$PORT`, so a file without `PORT` does not expand to nothing.

Both mode units are `oneshot` **without** `RemainAfterExit=yes`, deliberately: a oneshot
without it goes inactive after running, which is what makes the next restart run it again.
Adding `RemainAfterExit=yes` would silently stop every future switch from reshaping the box.

Nothing is remembered between switches: the shape is derived from the file on every start, so
a hand-started Caddy in private mode is stopped by the next start rather than left on.

### 3.4 The grace window (specified; not in the units in this tree yet)

A switch used to close the old door before opening the new one, which is destructive for every
phone: the app only learns the server moved by reading `/api/health` after authenticating, and
the old ingress is gone by then, so recovery meant re-enrolment with a hand-issued code.

The design that replaces it: **open the new door first, keep the old one for a grace period,
then close it.**

- The new way in exists before the old one goes.
- The close is scheduled as a transient unit — `systemd-run --on-active=<grace>` — so it needs
  no new unit file and nothing is left behind.
- **Default grace: 15 minutes**, set by one environment value the units share so it is not
  folklore. The literal variable name is fixed by the mode work that lands this; it is not in
  the units in this tree, and neither is the overlap. Until it lands, the units still close
  first and a switch remains destructive to enrolled phones.
- During the window both front doors answer. That is safe in both directions because the trust
  posture follows the **mode**, not the door: in public mode the identity header is not
  believed at all, so the tailnet door only admits devices holding keys; in private mode Caddy
  strips the identity headers from outside, and a request with neither header nor device is
  refused. **Both claims are to be measured on the scratch host** — they are the reason the
  overlap is safe, and nothing in this tree proves them.

If a switch was made from the console rather than the CLI, check the box's shape afterwards:

```bash
systemctl is-active caddy
tailscale serve status
```

`caddy` active and tailnet serving off is public mode; `caddy` inactive and `tailscale serve`
publishing the loopback port is private. If the shaping units did not run, `sudo systemctl
restart crossbar` applies them.

### 3.5 How to tell what mode is in force

Three different questions, three answers — they disagree only in the window between `mode`
and the restart:

```bash
node src/admin.js mode        # what the FILE says, and whether it loads
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
`tailscale serve status` (§3.4).

### 3.6 What is unsafe mid-switch

- **Treating the file as the running mode.** Between `node src/admin.js mode public` and the
  restart, the file says public and the process is still private. `mode` reads the file;
  `status` and `/api/health` read the process. They must disagree in that window — that is the
  command working as designed, not a fault.
- **A second switch inside the grace window.** By construction, the first switch's scheduled
  close still fires. Switch private → public at T (public opens, private closes at T+15) and
  then public → private at T+5 (private opens, public closes at T+20), and at T+15 the first
  schedule closes the private door the second switch just opened. Wait the window out — or
  check `systemctl list-timers --all | grep run-` for the pending transient unit — before
  switching back.
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

### 5.1 What does not exist yet

**There is no installer, no `upgrade` command and no `uninstall` command.** A later phase adds
them; this section describes what an operator does today, by hand, and says which parts are
therefore error-prone. What does exist is a version to compare (§5.2) and an automatic
snapshot before a database migration (§5.4), which together make the honest procedure below
recoverable.

### 5.2 Where the version is reported

```bash
node src/admin.js status | head -1        # Version 0.1.0  (from package.json)
curl -fsS https://<public host>/api/health
```

`/api/health` answers with `"version": "0.1.0"`, the running process's own — which is the
question the CLI cannot answer, because the CLI may be a different checkout from the one the
service runs. That is the check after an upgrade: same command, different version.

### 5.3 Upgrading

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
the earlier migration used, `rsync`) is the operator's. Nothing in the server needs a network
connection to upgrade — the two dependencies are installed from npm, and `node:sqlite` is
Node's own.

**If `deploy/*.service` changed, the code update does not install it.** Units live in
`/etc/systemd/system`, so re-install and reload:

```bash
sudo install -m 644 deploy/crossbar.service deploy/crossbar-public.service \
                    deploy/crossbar-private.service deploy/crossbar-backup.service \
                    deploy/crossbar-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl restart crossbar
```

Keep the previous copies of any unit you replace, so a rollback of the units is a copy back
rather than a rewrite.

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

There is no uninstall command. Today it is the install in reverse — `sudo systemctl disable
--now crossbar crossbar-backup.timer crossbar-turn` (and the two shaping units are reached
through `crossbar`), remove the unit files from `/etc/systemd/system`, `daemon-reload`, and
then the checkout and `data/` are ordinary files you delete yourself. **Before deleting them,
take the two things in §4.1 off the machine**, because that is the only place they exist.

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
APNs              not configured — a phone with its screen off cannot be rung
People            3
Devices           5
Open invitations  0
```

On a deployment, `Origin` is the mode's origin, `Device auth` reads `required` in public mode,
and `TURN`/`APNs` carry their configured values or say they are not configured.

The **APNs** line matters because a browser can be woken by Web Push and a suspended iOS app
can be woken by nothing except a VoIP push: without the key, a locked phone simply never rings
while everything else keeps working.

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
rung while it is asleep, `NO` where it cannot — no VoIP token on file, either because the
phone has never filed one or because Apple has since said the one it filed was dead. `NO`
reads from the caller's end as a broken deployment and is visible nowhere else in that output.
The column answers a different question from `KEY`, which is only whether the device holds a
key.

`node src/admin.js ring --from <id> --to <id>` places a test call **through** the live server,
over the loopback the server already treats as its proxy, so it reaches both the sockets and
APNs — a call placed any other way would ring nothing, because the running process is the one
holding the connections and the push credentials. `--from` has to be a person with a login,
because a login is how a request is believed here. That is why a directory keeps one test
person who has one: `ringtest` ("Ring Test"), with the placeholder login `ringtest@example.com`
and contacts with `abdullah`, exists so a call can be placed from the machine. The directory
file as it was before that change is kept beside it, at `data/directory.json.before-ringtest`.

---

## 7. The directory, and logins

A person is found by their tailnet login wherever a proxy names the caller, so a person without
one has no identity: they cannot reach the service, and the console lists them without one.
That is a state to fix rather than a reason to refuse to run — a deployment must never be
switched into a mode it cannot start in — so the server starts with a directory whose people
have no login, and the file is read and shown as it is. Only `directory.validate()` applies the
rule, and it applies it to what may be *written*: adding or changing a person from the console
asks for a login where a login is identity. `read()` and the store do not enforce it, which is
what lets a directory be looked at, and so repaired.

**An open item, measured 2026-09-24.** In private mode the console refuses **every** directory
edit while any person in the file lacks a login, with

```
DIRECTORY_INVALID: faisal has no login, and a person is found by theirs here.
```

so the console cannot be the place where the missing logins are added, even though it is the
intended one — the one edit that would fix the directory is blocked by the same rule. The fix
offered, and not made, is to let it save with a warning instead. Until then the file is edited
by hand (§4.5 says where the previous version is kept). Two people in that deployment have
neither a login nor a device, so in private mode they can neither call nor be called; naming
somebody in the file is not the same as reaching them, and the console shows those two facts
separately.

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
`/home/admin` at all. Install these files, then hand Caddy and coturn the same environment file
the server reads (§2.8, §2.9).

The unit files and this document are the deployment surface. The rest of the software — the
config surface, the API, the directory — is described from the code in the server repository's
`src/`, and the console at `/admin` is the same operations as `node src/admin.js` for whoever
would rather use a browser.
