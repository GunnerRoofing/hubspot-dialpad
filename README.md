# hubspot-dialpad-webhook

Lambda that logs Dialpad calls and SMS messages as HubSpot engagement records, associated to the matching contact and their most recent deal.

**Status:** Live (production)
**Lambda:** `hubspot-dialpad-webhook` (us-east-2)

## What It Does

**Calls:** When a Dialpad call ends (`hangup`, `missed`, or `voicemail_uploaded`), creates a HubSpot call record with direction, duration, and recording link, owned by the Dialpad user on the call (`target.type = user`). Associates to the contact and their most recent deal. Office, department, callcenter, and dynamic-caller legs name no employee and stay unassigned.

**SMS:** When a Dialpad SMS is sent or received, appends it to a daily communication thread per contact **per employee** (Eastern day), owned by that employee: the sender for outbound, the destination line's employee for inbound. Each employee's texts count toward their own activity and stay visible under owner- or team-scoped permissions. Main-line and unmapped-line messages share one unassigned thread per contact per day.

An employee resolves to a HubSpot owner by email (Dialpad target email from the `gunner-dialpad` bus, then the line map). Employees without a HubSpot user (PMs today) cannot own records, so their activity stays unassigned.

## Stack

- Node.js 24, AWS Lambda (us-east-2)
- `@hubspot/api-client` v13
- Plain JSON webhooks from Dialpad (no JWT)

## Files

```
index.js          — Lambda handler (calls + SMS)
contactIdentity.js — HubSpot contact resolution and create lock
smsPolicy.js      — SMS owner routing, thread key, outbound role gate, and display names
callPolicy.js     — call owner, unanswered-operator-leg skip, and claim rule
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

All legs of a routed call share `entry_point_call_id` as the dedup key. Operator legs that end `missed` are skipped so they cannot claim the call. If the entry-point leg (`target.type = call_center`, no agent) logs the call first, it is unassigned until the answering operator's leg arrives and claims it. An owned call is never reassigned.

Unanswered callcenter calls are logged unassigned from the entry-point leg. (Dialpad now reports that leg as `call_center`; the old `callcenter` skip no longer matches it.)
