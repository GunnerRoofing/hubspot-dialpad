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

## Callcenter Call Dedup

Entry point legs (`target.type = coaching_team/callcenter`) are skipped — they have no agent info and were creating "Unknown User" records. Operator legs (`target.type = user`) are logged using `entry_point_call_id` as the dedup key, which is shared across all simultaneous ring legs of the same call.

**Pending (VP decision):** Unanswered callcenter calls are currently not logged.
