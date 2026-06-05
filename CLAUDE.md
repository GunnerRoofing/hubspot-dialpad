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

- **Calls:** Only processes `hangup` state — one log per completed call.
- **SMS:** Processes all SMS events. Dedup via `hs_engagement_source_id = body.id`.
- **Call dedup:** `hs_call_external_id = body.call_id || body.id`. One record per unique call_id.
- **Contact lookup:** First tries `dialpad_id` property on HubSpot contact, falls back to phone number match.
- **Deal association:** Fetches all deals for the contact, picks the most recently created one.
- **Talk time:** Uses `body.talk_time` (milliseconds), NOT `body.duration`. Duration was unreliable.
- **Webhook format:** Dialpad sends plain JSON (not JWT). No base64 decoding needed here.

## Callcenter Call Handling

Callcenter calls create two types of `hangup` events:
1. **Entry point leg** — `target.type` is `coaching_team` or `callcenter`. No agent info. **Skipped entirely.**
2. **Operator leg** — `target.type` is `user`. Has agent email. **Logged.** Dedup key is `entry_point_call_id` (shared across all simultaneous ring legs of the same call).

**Note:** `master_call_id` is always `null` in Dialpad payloads — do not use it.

**TODO (pending VP decision):** Unanswered callcenter calls (entry point fires `hangup`, no operator leg exists) are currently not logged. Decide whether to log these as 0-duration calls against the contact.

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
cd /Users/leonard.fuentes/Documents/hubspot-dialpad
./deploy.sh
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
- **`Unknown User` in HubSpot:** Happens when the agent's identity isn't resolved — the call is logged but attributed to no user. Not a bug in this Lambda, it's a HubSpot limitation when no agent association is set.

## Anti-Boilerplate

- Do NOT add docstrings to every function
- Do NOT create placeholder files for features not being built
- Do NOT add inline boilerplate comments

## Token Efficiency

- Answer first, explain after if needed
- No preamble, no closing summaries
- One example is enough
