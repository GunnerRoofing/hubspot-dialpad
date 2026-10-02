# hubspot-dialpad-webhook

Lambda that logs Dialpad calls and SMS messages as HubSpot engagement records, associated to the matching contact and their most recent deal.

**Status:** Live (production)
**Lambda:** `hubspot-dialpad-webhook` (us-east-2)

## What It Does

**Calls:** When a Dialpad call ends (`hangup`), creates a HubSpot call record with direction, duration, and recording link. Associates to the contact and their most recent deal.

**SMS:** When a Dialpad SMS is sent or received, creates a HubSpot communication record with the message body. Associates to the contact and their most recent deal.

## Stack

- Node.js 24, AWS Lambda (us-east-2)
- `@hubspot/api-client` v13
- Plain JSON webhooks from Dialpad (no JWT)

## Files

```
index.js          — Lambda handler (calls + SMS)
contactIdentity.js — HubSpot contact resolution and create lock
smsPolicy.js      — SMS owner routing, outbound role gate, and display names
deploy.sh         — zip, upload, and set the Lambda runtime to Node.js 24
package.json      — dependencies and test command
```

## Environment Variables

| Variable | Description |
|---|---|
| `HUBSPOT_ACCESS_TOKEN` | HubSpot production private app token |
| `SMS_LEAD_CREATING_TEAM_IDS` | Optional comma-separated HubSpot team IDs allowed to create contacts from unknown outbound numbers; takes precedence over names |
| `SMS_LEAD_CREATING_TEAM_NAMES` | Optional comma-separated exact HubSpot team names; defaults to `Sales,Sales Team` |
| `SMS_LEAD_CREATING_INBOUND_NUMBERS` | Optional comma-separated internal destination numbers allowed to create contacts from unknown inbound senders; defaults to Gunner's main line `+18662626005` |

## Deploy

```bash
./deploy.sh
```

`deploy.sh` uploads a fresh code archive, waits for the update, sets the Lambda
runtime to `nodejs24.x`, and waits for that in-place update. It does not change
environment variables. Live handler verification is still required after deployment.

## How Contact Lookup Works

1. Search HubSpot by normalized phone and Dialpad contact ID.
2. Fall back to the Dialpad contact's email.
3. Reuse and enrich the best existing contact.
4. For an unknown inbound number, create only when the internal destination is the configured main line or maps to a HubSpot owner on an allowed Sales team. Direct operations, PM, service, unmapped, and other shared lines are skipped. Existing contacts still receive their SMS history.
5. For an unknown outbound number, create only when the sender's HubSpot owner belongs to an allowed Sales team. PM, service, operations, unmapped, and ownerless senders are skipped. Existing contacts still receive their SMS history and are never reassigned.

Outbound activity labels use Dialpad's target name when present, then the mapped sender email as a readable employee name, then the sending number. A mapped employee no longer appears as `Agent`.

## Callcenter Call Dedup

Entry point legs (`target.type = coaching_team/callcenter`) are skipped — they have no agent info and were creating "Unknown User" records. Operator legs (`target.type = user`) are logged using `entry_point_call_id` as the dedup key, which is shared across all simultaneous ring legs of the same call.

**Pending (VP decision):** Unanswered callcenter calls are currently not logged.
