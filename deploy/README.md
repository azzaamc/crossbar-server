# Deploying Crossbar in public mode

Public mode is for a household that is not on a tailnet and reaches Crossbar over the open
internet. The shape is one Raspberry Pi behind a home router:

```
client ── HTTPS/WSS :443 ──▶ Caddy ──▶ 127.0.0.1:3003   (the Crossbar server)
client ── STUN/TURN ──────▶ coturn :3478 + relay range  (media, only when it must be relayed)
```

Caddy terminates TLS and the Crossbar server keeps its loopback-only listener; the backend
is never exposed. That is what lets the server treat "the connection came from loopback" as
"it came from the proxy", which is the assumption both modes rest on. Private mode is
unaffected by anything in this directory, and both modes run the same server.

In public mode the application's identity is a per-device key rather than the network. The
settings that matter are `CROSSBAR_NETWORK_MODE=public`, `CROSSBAR_PUBLIC_HOSTNAME` (which
`PUBLIC_ORIGIN` must also name) and `CROSSBAR_SESSION_SECRET`; see `../.env.example`.

## Files

| File | Where it goes | What it is |
| --- | --- | --- |
| `Caddyfile` | `/etc/caddy/Caddyfile` | the only public listener |
| `crossbar.service` | `/etc/systemd/system/` | the Crossbar server, unchanged |
| `crossbar-turn.service` | `/etc/systemd/system/` | runs coturn, hardened |
| `coturn.conf` | stays here | a template; the unit above renders it |

Caddy comes from the project's own package repository (`apt install caddy`). It needs
`CROSSBAR_PUBLIC_HOSTNAME` in its own environment — the Caddyfile's placeholder is read from
there — and give it the same file the server reads rather than a second copy of the value:

```
sudo systemctl edit caddy
```

```
[Service]
EnvironmentFile=/home/admin/crossbar/.env
```

Then `sudo systemctl restart caddy`. Nothing else from `.env` is used by Caddy, and `PORT`
only matters if the server does not listen on 3003.

## DNS

One record matters: `CROSSBAR_PUBLIC_HOSTNAME` must resolve to the home connection.

- `A` — the connection's IPv4 address.
- `AAAA` — its IPv6 address, if the ISP provides one. Worth having: native IPv6 has no NAT,
  so an `AAAA` record can be the only way in when the IPv4 side is behind carrier-grade NAT.
  With IPv6 there is nothing to forward, but the firewall — router and host — still has to
  allow the ports below.

The address has to be kept current by hand; there is no DDNS integration in this repository.
Caddy survives an address change (its certificate renews over the new one); coturn does not,
for the reason in "Residential addresses" below.

## Ports

| Port | Proto | Forward to | Why |
| --- | --- | --- | --- |
| 80 | TCP | Pi:80 | HTTP, redirected to HTTPS (and the ACME HTTP-01 challenge, if used) |
| 443 | TCP | Pi:443 | HTTPS and WSS: the API and the signalling socket |
| 3478 | UDP | Pi:3478 | STUN and TURN over UDP: the common path, and the one that matters |
| 3478 | TCP | Pi:3478 | optional: TURN over TCP, for networks that drop UDP |
| 49160-49200 | UDP | Pi: same range | the relay itself: the media, when no direct path exists |

The relay range is `CROSSBAR_TURN_MIN_PORT`-`CROSSBAR_TURN_MAX_PORT`. Forward it 1:1 —
relayed port 49162 must arrive as 49162 — and widen it in both `../.env` and the router if a
house of simultaneous relayed calls ever exhausts it. Nothing forwards the backend port
3003 (`PORT`): it is loopback-only by design.

On the Pi with `ufw`:

```
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 3478/udp
sudo ufw allow 3478/tcp
sudo ufw allow 49160:49200/udp
```

`ufw` applies rules to IPv4 and IPv6 unless told otherwise; check with `ufw status verbose`
if both families are in use.

## Running coturn

`coturn.conf` is a template and coturn cannot read it. coturn's configuration format has no
environment substitution, so the file holds `${CROSSBAR_*}` references and the unit renders
it with `envsubst` into `/run/coturn/turnserver.conf`, taking the values from the same
`../.env` the server reads. The shared secret is therefore never committed and the rendered
copy lives on a tmpfs.

```
sudo apt install coturn gettext-base
sudo systemctl disable --now coturn              # the package's own unit; this one replaces it
sudo cp deploy/crossbar-turn.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now crossbar-turn
journalctl -u crossbar-turn -f
```

Then set `CROSSBAR_TURN_HOST=<CROSSBAR_PUBLIC_HOSTNAME>` and a `CROSSBAR_TURN_SHARED_SECRET`
(`openssl rand -hex 32`) in `../.env`, and restart the relay and the server so the ICE list
the server hands out names the relay that is actually running. The relay refuses to start if
the rendered secret is empty, because a coturn with no secret accepts no one — which looks
like a media failure rather than a configuration one.

## Residential addresses

A home address is not a fixed one, and both halves of this deployment name it.

- **DNS** must keep pointing at the home server. Repoint the record when the ISP moves the
  address; there is no DDNS integration yet, and until it is repointed clients cannot reach
  the server at all — not even to be told why.
- **coturn** needs `external-ip` set (in `coturn.conf`, commented out by default) whenever
  the host is behind NAT, which a home router means it is: without it the relay can advertise
  an address on the home LAN that nothing outside can use. It is a literal address, so a
  change invalidates it — the relay then advertises an address that no longer exists, and
  relayed media dies while everything else keeps working.

## CGNAT

If the ISP puts the connection behind carrier-grade NAT, no amount of port forwarding on the
home router will let anything in, and public mode is simply not feasible on IPv4. **This
cannot be detected with certainty from inside the network**, so treat any single check as
evidence rather than proof:

- A router WAN address inside `100.64.0.0/10` is certainly CGNAT.
- A WAN address that matches what an external "what is my address" service reports makes
  CGNAT unlikely, but does not rule it out: some carriers hand out addresses that look
  public and are still not reachable inbound.
- The only conclusive test is from outside: forward 443, then open the public URL from a
  phone on cellular data with Wi-Fi off. If it times out there while working on the home
  Wi-Fi, something above the router is blocking inbound traffic.

The options if that happens: ask the ISP for a public or static address; use an `AAAA` record
if the ISP provides IPv6 (which bypasses IPv4 NAT entirely, but only for clients that have
IPv6); put a VPS or a tunnel in front; or stay in private mode, where Tailscale needs no
inbound path at all because both ends dial out.
