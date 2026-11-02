# CLAUDE.md — hubspot-dialpad-webhook

## Project Context

Node.js Lambda that logs Dialpad call and SMS events as HubSpot engagement records. Receives Dialpad webhooks, looks up the associated HubSpot contact by Dialpad contact ID or phone number, creates a call/communication record, and associates it to the contact and their most recent deal.

**Status:** Live (production HubSpot, production Dialpad)
**Lambda:** `hubspot-dialpad-webhook` (us-east-2)

## Stack

| Layer | Details |
|---|---|
| Runtime | Node.js |
| Hosting | AWS Lambda (us-east-2) |
| Trigger | Dialpad webhook (hangup state for calls, all states for SMS) |
| Dependencies | `@hubspot/api-client` |
| HubSpot | Engagements API — calls + communications objects |

## Architecture

```
Dialpad call hangs up / SMS received
      │  Webhook POST (JSON body — not JWT)
      ▼
Lambda
      │
      ├─▶ Dedup check (hs_call_external_id / hs_engagement_source_id)
      ├─▶ Lookup contact by dialpad_id → fallback to phone
      ├─▶ Create call or communication record in HubSpot
      ├─▶ Associate to contact
      └─▶ Associate to most recent deal (if exists)
```

## Key Behavior

- **Calls:** Processes final states (`hangup`, `missed`, `voicemail_uploaded`) — one log per call. Owner = the Dialpad user on a `target.type = user` leg (`callPolicy.js`).
- **SMS:** One daily thread per contact per employee, owned by that employee (`smsThreadKey`). Main-line/unmapped messages share an unassigned thread. Dedup within a thread by the rendered line.
- **Ownership:** every record is owned by the employee on the Dialpad line, so reps see and get credited for their own activity. Employees without a HubSpot user cannot own records.
- **Call dedup:** `hs_call_external_id = entry_point_call_id || call_id`. One record per call.
- **Contact lookup:** First tries `dialpad_id` property on HubSpot contact, falls back to phone number match.
- **Deal association:** Fetches all deals for the contact, picks the most recently created one.
- **Talk time:** Uses `body.talk_time` (milliseconds), NOT `body.duration`. Duration was unreliable.
- **Webhook format:** Dialpad sends plain JSON (not JWT). No base64 decoding needed here.

## Callcenter Call Handling

All legs of a routed call share `entry_point_call_id`, used as the dedup key.
1. **Entry point leg** — `target.type` is `call_center` (Dialpad's current name; the old `callcenter`/`coaching_team` skip no longer matches). No agent info. Logged unassigned if it arrives first.
2. **Operator leg** — `target.type` is `user`, has agent email. `missed` legs are skipped; the answering leg creates the call or claims an unassigned one. An owned call is never reassigned.

**Note:** `master_call_id` is always `null` in Dialpad payloads — do not use it.

## Infrastructure

| Resource | Value |
|---|---|
| Lambda | `hubspot-dialpad-webhook` (us-east-2) |
| Dialpad Webhook | `https://25xqc5a3ai.execute-api.us-east-2.amazonaws.com/` (ID: `6414969028812800`) |

## Environment Variables

| Variable | Purpose |
|---|---|
| `HUBSPOT_ACCESS_TOKEN` | HubSpot private app token (production) |

## Deploy

```bash
./deploy.sh   # run from the repo root
```

Zips `index.js`, `node_modules/`, `package.json` and uploads to Lambda directly.

## Core Principles

- Smaller, atomic commits over large changes
- No silent failures — errors logged, always return 200 to Dialpad
- If unsure about a field name or behavior, log the raw payload first
- Next person should be able to deploy without asking

## Plan Before Code

For any change beyond a single trivial edit:
1. Output a plan first, no code
2. List files you'll change and why
3. Identify risks/edge cases
4. Wait for approval

## Strict Rules

- Never commit secrets or API keys in code — env vars only
- Always return 200 to Dialpad — never let errors propagate as 4xx/5xx
- Never remove the dedup check — duplicate call logs are the main failure mode
- Never use `body.duration` for call duration — use `body.talk_time` (ms)

## Known Gotchas

- **`talk_time` not `duration`:** Dialpad's `duration` field was unreliable. `talk_time` is in milliseconds.
- **Simultaneous ring dedup:** Use `entry_point_call_id` — shared across all operator legs of the same callcenter call. `master_call_id` is always null, do not use it.
- **Dialpad payload is plain JSON:** Unlike the dialpad-hubspot-sync Lambda, this one receives raw JSON, not a base64-encoded JWT.
- **`Unknown User` in HubSpot:** a record whose owner could not be resolved (office/department/callcenter leg, or an employee with no HubSpot user).
