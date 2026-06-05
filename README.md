# hubspot-dialpad-webhook

Lambda that logs Dialpad calls and SMS messages as HubSpot engagement records, associated to the matching contact and their most recent deal.

**Status:** Live (production)
**Lambda:** `hubspot-dialpad-webhook` (us-east-2)

## What It Does

**Calls:** When a Dialpad call ends (`hangup`), creates a HubSpot call record with direction, duration, and recording link. Associates to the contact and their most recent deal.

**SMS:** When a Dialpad SMS is sent or received, creates a HubSpot communication record with the message body. Associates to the contact and their most recent deal.

## Stack

- Node.js, AWS Lambda (us-east-2)
- `@hubspot/api-client` v13
- Plain JSON webhooks from Dialpad (no JWT)

## Files

```
index.js       — Lambda handler (calls + SMS)
deploy.sh      — zip and upload to Lambda
package.json   — dependencies
```

## Environment Variables

| Variable | Description |
|---|---|
| `HUBSPOT_ACCESS_TOKEN` | HubSpot production private app token |

## Deploy

```bash
./deploy.sh
```

## How Contact Lookup Works

1. Try `dialpad_id` property on HubSpot contact (exact match)
2. Fall back to phone number match (`phone` or `mobilephone`)

If no contact is found, the engagement is still created but not associated.

## Known Issue — Duplicate Call Logs

Callcenter calls with simultaneous ring create one `hangup` event per agent ring leg, each with a unique `call_id`. Since dedup uses `call_id`, all legs get logged separately.

**Fix:** Use `master_call_id` as the dedup key — it's shared across all legs of the same logical call. Pending fix.
