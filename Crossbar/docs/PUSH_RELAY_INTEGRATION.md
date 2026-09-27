# Push Relay integration — the contract

The shared contract for routing an incoming-call wake through the central Crossbar Push Relay
instead of pushing APNs from the deployment. Written from the three read-only investigations of
2026-09-27 (relay contract, native push, backend call flow); every fact below was read from
source, and where something is a decision or still unmeasured it says so.

**Sources.** Relay `pushrelay` @ `main` `fa376a7`, with `wrangler.jsonc` modified in the working
tree — the deployed Worker's configuration differs from the commit, so "the relay at `fa376a7`"
is not yet a complete statement. App `Crossbar` @ `tailscale-kit` `d4f9cf0`. Backend `server` @
`main` `1e35082`, deployed as a release tarball at `/home/admin/crossbar` on the VPS
(`srv1997478`, `crossbar-vps.tailea67b0.ts.net`).

**The backend host is the VPS, not `qatar-vpn`.** `qatar-vpn` is the older tailnet Pi that ran
MiroTalk and the first dev service on :8445; it is unreachable from the development Mac. The live
backend's own health response names `crossbar-vps.tailea67b0.ts.net`.

---

## 1. What the relay is, and is not

The relay knows an **installation** (a self-hosted backend), a **device id**, and a **PushKit
token**. It does not know users, contacts, calls, rooms, signalling, media or Tailscale, and it
must not learn them. It delivers a wake; the backend remains authoritative for everything else.

Three customer routes, and only three:

| route | purpose |
|---|---|
| `PUT /v1/devices/{device_id}` | register or update a device's PushKit token |
| `DELETE /v1/devices/{device_id}` | remove it |
| `POST /v1/push/voip` | send one VoIP wake |
| `GET /v1/health` | unauthenticated liveness |

Sources: `src/app.ts` (URL space and route order), `src/http.ts` (status map), and the docs, which
match the source except one cosmetic example.

**Auth** is a per-installation opaque Bearer credential: `cbr_` + 43 base64url characters, parsed
by `src/auth/installation-auth.ts`. It is a **server secret** — it never reaches the app, never
appears in a payload, a log line, a git commit or a client response.

## 2. Device identity is the one the backend already has

The relay's pattern and Crossbar's are byte-identical:

```
relay    pushrelay/src/config.ts    export const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
backend  server/src/db.js           const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
backend  server/src/auth.js         function newDeviceId() { return `dev_${randomId(12)}`; }
```

Live values (`dev_RhB3R7UuH9TqbmBJ`, `dev_jo66Y10591oq3rhw`) are 20 characters and match. **The
backend's device id *is* the relay's `device_id`.** No mapping table, no new identifier, nothing
to keep in step. A PushKit token is never an identity and is never used as one.

## 3. The payload the iPhone receives

`src/apns/payload.ts` produces, and `src/validation/index.ts` enforces:

```json
{
  "aps": { "content-available": 1 },
  "crossbar": {
    "v": 1,
    "type": "incoming_call",
    "installation_id": "…",
    "call_id": "…",
    "caller_id": "…",
    "caller_name": "…",
    "has_video": true
  }
}
```

**The shipped app cannot read this.** It parses a flat top-level `callId`
(`AppDelegate.swift:352`) and therefore refuses the push at `:295`, deliberately — its own comment
explains that inventing an identity would put an unanswerable call on the lock screen, and that
iOS then ends the process and may throttle its VoIP pushes. The payload is the service's, so the
service is what changes: the decoder learns the namespaced shape, and keeps the flat one for the
alert path below.

The decoder must locate `crossbar`, validate `v`, validate `type`, require the fields it uses, and
reject anything else — logging safely, never reporting a call it cannot name.

## 4. Two push paths, and only one of them moves

The backend sends **two kinds** of push today, in `src/lifecycle.js`:

- `pushIncoming` — Web Push plus **APNs VoIP** (`.voip` topic) — this is the call wake.
- `pushMissed` — **APNs alert** (bundle-id topic, collapse id) — the missed-call notification.

The relay's configured topic is `com.abdullahchaudhry.Crossbar.voip`. It is a **VoIP-only
transport**, so **only the wake moves to the relay**. The missed-call alert stays on the backend's
direct APNs path, and the backend therefore keeps its APNs key.

> **Decision for the owner, not taken here.** That leaves an APNs key on every deployment, which
> is the opposite of what a central relay is for. The alternatives are to give the relay an alert
> topic — which §49 of the brief forbids without evidence — or to accept the key for alerts. This
> contract proceeds with the key retained; changing that is a separate decision.

## 5. Token lifecycle

```
PushKit (PKPushRegistry, .voIP)
   ↓ didUpdate credentials
app: DeviceAuth.shared.deviceId  (server-issued, stable)
   ↓ POST /api/devices/push-token     (device-authenticated, already exists: src/api.js:1130)
backend: verifies the caller owns that device
   ↓ PUT /v1/devices/{device_id}      (installation Bearer)
relay: upsert, UNIQUE(token) first-writer-wins
```

- **Update, not create.** A rotated PushKit token is an upsert at the same `device_id`. A new
  relay device per token rotation is a defect.
- **Removal** on unpair/logout is `DELETE /v1/devices/{device_id}`.
- `pushRegistry(_:didInvalidatePushTokenFor:)` already exists (`AppDelegate.swift:99`) and is the
  signal to clear, not to forget the device.
- **Token retention**: the backend already stores the token (`voipTokensFor`). Keeping it is
  defensible — a rotated token is the only way to reach that device until it reports a new one —
  but it must never appear in a log line. `src/log.js`'s redaction-by-construction is the pattern.

## 6. Call identity, and CallKit

`src/lifecycle.js:179` and `:200`: `const callId = crypto.randomUUID()`. So:

- **Incoming**: the backend call id **is** the CallKit UUID. The push's `call_id` and the realtime
  `incoming-call` event carry the same value, which is what makes deduplication exact.
- **Outgoing**: CallKit is started first with a locally generated UUID that is *not* the backend
  call id (the client's `CXStartCallAction` precedes `POST /api/calls`). That is pre-existing and
  out of scope here — no push is involved in an outgoing call — but it is recorded because §24
  asks, and because a future caller-id reconciliation would find it.
- **Deduplication** is by that call id, at the session: the app already funnels both paths into
  `CallSession.ring` / `reportPushedCall`, so the check belongs there and nowhere else.

## 7. Timing: CallKit does not wait for anything

The critical ordering, and the app already does it — `AppDelegate.swift:314`: *"The report, and
then the half of answering that is not CallKit's — a load…"*

```
PushKit delegate
   ↓ parse + validate the payload           (nothing else may happen first)
   ↓ report to CallKit                       (the payload carries enough for the lock screen)
   ↓ completion()
   ↓ start/recover the embedded Tailscale node
   ↓ reach the backend, fetch authoritative call state
   ↓ signalling, media
```

Nothing may be awaited before the CallKit report: not Tailscale, not the backend, not the
directory, not WebRTC. The push carries `call_id`, `caller_id`, `caller_name` and `has_video`
precisely so the lock screen can be drawn before the network exists.

## 8. Real-time and push, together

The backend's presence model is `isOnline = open SSE streams` (`src/events.js`). A native app
holds an SSE stream *and* PushKit, and an open stream is not proof that the app can ring — the
brief says so, and the stream can be held by a suspended process.

**Decision: send both, for native devices, and deduplicate on the call id.** VoIP pushes are not
subject to the alert-push budget that would make "always" expensive, the wake is the whole point
of this integration, and the app already converges both paths on one state machine. The savings
from suppressing a push when a stream is open are smaller than the cost of one missed call.

## 9. Idempotency: one `request_id` per device

The relay keys idempotency on `(installation_id, request_id)` — **not** per device, and it
returns `409 idempotency_conflict` for a repeated key. A fan-out to two iPhones with one
`request_id` therefore fails the second.

- one `request_id` **per target device**, per call;
- **stable across retries** of that same device's push — an HTTP retry reuses it, and only a new
  call (or a new device) gets a new one;
- generated by the backend, never by the app.

`crypto.randomUUID()` persisted with the push attempt, or derived deterministically from
`(call_id, device_id, event)` — the backend's choice, but it must be written down in the code.

## 10. Failure semantics

- The relay normalises APNs into five outcomes (`src/apns/errors.ts`); a permanent device failure
  marks the device unregistered (`markUnregistered`) and the backend must clear that device's
  token rather than retry it — the same shape as the existing `deadTokens` loop in
  `pushIncoming`, which already clears VoIP tokens and deletes stale Web Push endpoints.
- A push failure **never** changes call state. `pushIncoming` is already fire-and-forget with a
  logged failure (`lifecycle.js:213`); that stays true.
- Outbound relay calls need finite timeouts, and backend retries must reuse the same
  `request_id`, so retries cannot multiply into duplicates.

## 11. Environments

| | relay | APNs | app build |
|---|---|---|---|
| development | `crossbar-push-dev.ibnfaisalc.workers.dev` | `api.sandbox.push.apple.com` | a development-signed build; `APS_ENVIRONMENT = development` |
| production | not yet created | `api.push.apple.com` | TestFlight/App Store |

`APS_ENVIRONMENT` is already per-configuration in the Xcode project, so a debug build gets
sandbox without any code change. A client never chooses an environment; the deployment does.

## 12. What is verified, and what is not

**Verified from source**: the relay's routes, auth scheme, device-id pattern, idempotency scope,
payload, and APNs environment/topic handling; the app's PushKit registration, flat parser, CallKit
report ordering, entitlements, bundle id and device id; the backend's routes, push dispatch,
device id generator, call id type and existing `push-token` endpoint.

**Not yet measured**: the live latency chain the brief's §23 lists (T0–T7); CallKit on a device
that has been terminated; whether the embedded Tailscale node recovers inside iOS's wake budget;
and whether deployed Cloudflare → APNs sandbox actually delivers — the relay's own outstanding
gate, which no local test can settle.

**Not yet built**: the namespaced decoder, the backend's `PushRelayClient` and its relay
dispatch, the per-device `request_id`, and the relay installation provisioning (CLI-only,
`scripts/relay-admin.mjs` — there is deliberately no admin HTTP API).
