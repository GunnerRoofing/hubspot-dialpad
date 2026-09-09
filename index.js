const hubspot = require('@hubspot/api-client');
const {
  normalizePhone,
  findExistingContact,
  resolveOrCreateContact,
  makeDdbClient,
} = require('./contactIdentity');

const ddb = makeDdbClient();

exports.handler = async (event) => {
  let body = {};
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    console.log('PARSE FAIL | isB64:', event.isBase64Encoded, '| raw80:', String(event.body).slice(0, 80));
    return respond(200, { status: 'skipped', reason: 'unparseable body' });
  }

  const client = new hubspot.Client({
    accessToken: process.env.HUBSPOT_ACCESS_TOKEN,
    // Auto-retry on 429 (HubSpot Search has a shared ~4 req/sec SECONDLY cap that bursts blow past).
    numberOfApiCallRetries: 6,
  });

  // Call events carry call_id/external_number. This webhook only receives call-hangups
  // and SMS, so anything that isn't a call is treated as an SMS (catches MMS/group/office
  // variants that the old strict text+from_number check silently dropped).
  const isCall = body.call_id !== undefined || body.external_number !== undefined;
  console.log('EVT |', isCall ? 'CALL' : 'SMS',
              '| state:', body.state, '| dir:', body.direction,
              '| msgStatus:', body.message_status, '| hasText:', body.text !== undefined);

  try {
    if (isCall) {
      if (body.state !== 'hangup' && body.event !== 'hangup') {
        return respond(200, { status: 'skipped', reason: 'call not completed' });
      }
      await handleCallEvent(client, body);
    } else {
      await handleSmsEvent(client, body);
    }

    return respond(200, { status: 'ok' });
  } catch (err) {
    console.error('Webhook error:', err.message, err.body || '');
    return respond(200, { status: 'error', message: err.message });
  }
};

async function lookupContact(client, dialpadContactId, rawPhone) {
  return findExistingContact(client, rawPhone, dialpadContactId);
}

// Owner-id by email, cached for the container's life so a single blast (one sender, many messages)
// costs at most one owner lookup instead of one per message (protects the shared ~4/sec Search cap).
const _ownerIdByEmail = new Map();
async function ownerIdForEmail(client, email) {
  if (!email) return null;
  const key = email.toLowerCase();
  if (_ownerIdByEmail.has(key)) return _ownerIdByEmail.get(key);
  const id = await lookupOwnerId(client, email);
  _ownerIdByEmail.set(key, id);
  return id;
}

async function lookupOwnerId(client, email) {
  if (!email) return null;
  try {
    // getPage is POSITIONAL (email, after, limit, archived) — passing an object made the email
    // filter "[object Object]" → 0 results → every owner lookup returned null (the real reason
    // outbound SMS contacts were unowned). Filter by email positionally.
    const resp = await client.crm.owners.ownersApi.getPage(email, undefined, 1);
    return resp.results?.[0]?.id ?? null;
  } catch (err) {
    console.warn('SMS: owner lookup failed for', email, err.message);
    return null;
  }
}

// Map an outbound SMS's sending line (from_number) → agent email via a STATIC directory in the
// SMS_SENDER_OWNER_MAP env var (JSON { "+1NXXNXXXXXX": "agent@gunnerroofing.com", ... }, built from
// Dialpad /users). Resolved with ZERO API calls: a bulk "blaster" fans out to many concurrent Lambda
// containers, and calling Dialpad /users from each one caused a thundering-herd 400 storm → every
// blast contact fell back to unowned → round-robin onto reps. The static map removes that dependency
// (deterministic, no herd, no rate limit). Returns null for an unmapped line (e.g. an office/campaign
// number not in the directory) → caller leaves the contact unowned (unchanged) and logs the line so
// it can be added. Regenerate the env map when agents/numbers change.
// Built from Dialpad /api/v2/users 2026-06-24. Internal sending lines (agent DIDs) → owner email.
// REGENERATE when agents/numbers change. Override at runtime by setting SMS_SENDER_OWNER_MAP (JSON)
// — the env takes precedence so this can be updated without a code deploy.
const SENDER_OWNER_MAP = {
  "+12037631819": "bryce.falk@gunnerroofing.com",
  "+12037144867": "campbell.schulz@gunnerroofing.com",
  "+19732215872": "chris.manfredo@gunnerroofing.com",
  "+19735549912": "doug.kilzer@gunnerroofing.com",
  "+19735673765": "eddie@gunnerroofing.com",
  "+19732215942": "eric.recchia@gunnerroofing.com",
  "+19145597530": "frank.gianchetta@gunnerroofing.com",
  "+12037144873": "glen.tacinelli@gunnerroofing.com",
  "+19735673690": "admin@gunnerroofing.com",
  "+12033473345": "jeff.witkowski@gunnerroofing.com",
  "+12037144866": "jennie.spangenberg@gunnerroofing.com",
  "+19733217191": "jesse.applegate@gunnerroofing.com",
  "+12037144874": "joe@gunnerroofing.com",
  "+19145371341": "john.miller@gunnerroofing.com",
  "+14402521959": "john.miller@gunnerroofing.com",
  "+12037144877": "john.miller@gunnerroofing.com",
  "+12037144868": "joseph.muratori@gunnerroofing.com",
  "+12037144870": "kauanny.zanetti@gunnerroofing.com",
  "+19734578938": "kevin.lewis@gunnerroofing.com",
  "+18602001795": "kevin.lovely@gunnerroofing.com",
  "+19145597991": "leslie@gunnerroofing.com",
  "+14409414938": "leslie@gunnerroofing.com",
  "+15703545132": "leslie@gunnerroofing.com",
  "+19736207538": "leslie@gunnerroofing.com",
  "+12035877738": "michael.ushka@gunnerroofing.com",
  "+12033093665": "nicole.almeida@gunnerroofing.com",
  "+12034470569": "pamela.foley@gunnerroofing.com",
  "+14402070506": "pamela.foley@gunnerroofing.com",
  "+12015911000": "pamela.foley@gunnerroofing.com",
  "+19144277730": "pamela.foley@gunnerroofing.com",
  "+15702341087": "pamela.foley@gunnerroofing.com",
  "+12037144862": "sarah.gengo@gunnerroofing.com",
  "+19735247478": "thomas.gatto@gunnerroofing.com",
  "+18607923047": "zachary.webb@gunnerroofing.com",
  "+19148268893": "solar@gunnerroofing.com",
};
let _senderMap = null;
function senderMap() {
  if (_senderMap) return _senderMap;
  if (process.env.SMS_SENDER_OWNER_MAP) {
    try {
      _senderMap = JSON.parse(process.env.SMS_SENDER_OWNER_MAP);
      return _senderMap;
    } catch (err) {
      console.warn('SMS: SMS_SENDER_OWNER_MAP env is not valid JSON, using built-in map —', err.message);
    }
  }
  _senderMap = SENDER_OWNER_MAP;
  return _senderMap;
}
function dialpadEmailForNumber(rawNumber) {
  const phone = normalizePhone(rawNumber);
  if (!phone) return null;
  return senderMap()[phone] || null;
}

async function getContactDeals(client, contactId) {
  // Get deal IDs directly associated to this contact
  const assocResp = await fetch(
    `https://api.hubapi.com/crm/v4/objects/contacts/${contactId}/associations/deals`,
    { headers: { 'Authorization': `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`, 'Accept-Encoding': 'identity' } }
  );
  const assocData = await assocResp.json();
  const dealIds = (assocData.results || []).map(r => r.toObjectId);

  if (!dealIds.length) {
    console.log('MOST RECENT DEAL: none');
    return [];
  }

  if (dealIds.length === 1) {
    console.log('MOST RECENT DEAL:', dealIds[0]);
    return dealIds;
  }

  // Multiple deals — fetch createdate and pick the newest
  const dealsResp = await client.crm.deals.batchApi.read({
    inputs: dealIds.map(id => ({ id: String(id) })),
    properties: ['dealname', 'createdate'],
  });

  const sorted = (dealsResp.results || [])
    .sort((a, b) => new Date(b.properties.createdate) - new Date(a.properties.createdate));

  const top = sorted[0];
  console.log('MOST RECENT DEAL:', top.id, `(${top.properties.dealname})`);
  return [top.id];
}

// YYYYMMDD in America/New_York (so "same day" matches the team's local day, like native).
function easternDayKey(ms) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms)).replace(/-/g, '');
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// One message line, native-style: <strong>Name</strong> <em>[ts ET]</em>: text
// (No hidden marker — HubSpot strips HTML comments. Dedup matches the whole line, which
// embeds the per-message timestamp + text, so a re-sent message yields an identical line.)
function buildSmsLine(body, text, tsMs) {
  const name = body.direction === 'inbound'
    ? (body.contact?.name || body.from_number || 'Customer')
    : (body.target?.name || 'Agent');
  const ts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(tsMs));
  return `<strong>${escapeHtml(name)}</strong> <em>[${ts} ET]</em>: ${escapeHtml(text)}`;
}

async function handleSmsEvent(client, body) {
  // This webhook delivers TWO events per message: the message itself (carries
  // text/text_content/mms_url) AND a delivery-status callback (message_status only, no body).
  // Only log real messages — status callbacks have no body.
  const hasBody = body.text !== undefined || body.text_content !== undefined || body.mms_url !== undefined;
  if (!hasBody) {
    console.log('SMS: delivery/status callback — skip |', body.message_status || body.message_delivery_result || '');
    return;
  }
  if (body.is_internal) {
    console.log('SMS: internal message — skip');
    return;
  }

  const messageBody = body.text || body.text_content || body.mms_url || '';
  const msgId = body.id !== undefined && body.id !== null ? String(body.id) : null;
  const toNumber = Array.isArray(body.to_number) ? body.to_number[0] : body.to_number;
  const externalPhone = body.direction === 'inbound' ? body.from_number : toNumber;
  if (!externalPhone) {
    console.log('SMS: no customer phone resolvable — skip. dir:', body.direction);
    return;
  }

  // For OUTBOUND creates, own the new contact by the sending agent so HubSpot
  // round-robin does not dump blanks onto random reps. Inbound unknown stays unowned.
  let ownerId = null;
  if (body.direction === 'outbound') {
    let ownerVia = 'none';
    let senderEmail = null;
    if (body.target?.email) {
      ownerId = await ownerIdForEmail(client, body.target.email);
      if (ownerId) ownerVia = 'target.email';
    }
    if (!ownerId) {
      senderEmail = dialpadEmailForNumber(body.from_number);
      if (senderEmail) {
        ownerId = await ownerIdForEmail(client, senderEmail);
        if (ownerId) ownerVia = 'from_number';
      }
    }
    if (ownerId) {
      console.log('SMS: outbound new-contact owner', `${ownerId} (via ${ownerVia})`);
    } else if (senderEmail) {
      console.log('SMS: outbound new-contact UNOWNED — owner not found for sender', senderEmail);
    } else {
      console.log('SMS: outbound new-contact UNOWNED — unmapped sender line', normalizePhone(body.from_number) || '(none)');
    }
  }

  const contact = await resolveOrCreateContact({
    client,
    ddb,
    table: process.env.CONTACT_CREATE_LOCK_TABLE || '',
    rawPhone: externalPhone,
    dialpadContactId: body.contact?.id,
    dialpadContact: body.contact,
    ownerId,
    ttlSec: Number(process.env.CREATE_LOCK_TTL_SEC || 600),
  });
  if (!contact) {
    console.log('SMS: could not resolve or create contact for', externalPhone, '— skip');
    return;
  }

  // Daily-thread rollup (mimics native): one SMS comm per contact per Eastern day, appended.
  // Keyed deterministically by hs_engagement_source_id so we can find today's thread.
  const tsMs = Number(body.created_date) || Date.now();
  const threadKey = `dpthread-${contact.id}-${easternDayKey(tsMs)}`;
  const line = buildSmsLine(body, messageBody, tsMs);

  const existing = await client.crm.objects.searchApi.doSearch('communications', {
    filterGroups: [{ filters: [{ propertyName: 'hs_engagement_source_id', operator: 'EQ', value: threadKey }] }],
    properties: ['hs_communication_body', 'hs_engagement_source_id'],
    limit: 1,
  });
  const thread = existing.results?.[0];

  if (thread) {
    const curBody = thread.properties.hs_communication_body || '';
    // Dedup within the thread (Dialpad may resend the body event): the line embeds the
    // per-message timestamp + text, so an identical line means the same message re-sent.
    if (curBody.includes(line)) {
      console.log('SMS: message already in thread', msgId, '— skip');
      return;
    }
    await client.crm.objects.basicApi.update('communications', thread.id, {
      properties: { hs_communication_body: curBody + '<br>' + line, hs_timestamp: String(tsMs) },
    });
    console.log('SMS: appended to thread', thread.id, '| contact', contact.id, '| msg', msgId);
    return;
  }

  // First message of the day for this contact → create the thread + associate once.
  // (Rare race: two messages within HubSpot's search-index lag can split into two threads.)
  const comm = await client.crm.objects.basicApi.create('communications', {
    properties: {
      hs_communication_channel_type: 'SMS',
      hs_communication_logged_from: 'CRM',
      hs_communication_body: line,
      hs_timestamp: String(tsMs),
      hs_engagement_source_id: threadKey,
    },
  });
  console.log('SMS: created thread', comm.id, '| contact', contact.id, '| key', threadKey);

  await client.crm.associations.v4.basicApi.create(
    'communications', comm.id, 'contacts', contact.id,
    [{ associationTypeId: 81, associationCategory: 'HUBSPOT_DEFINED' }]
  );
  console.log('SMS: associated thread', comm.id, '-> contact', contact.id);

  const dealIds = await getContactDeals(client, contact.id);
  if (!dealIds.length) {
    console.log('SMS: no deal for contact', contact.id, '— thread on contact only');
    return;
  }
  for (const dealId of dealIds) {
    try {
      await client.crm.associations.v4.basicApi.create(
        'communications', comm.id, 'deals', dealId,
        [{ associationTypeId: 85, associationCategory: 'HUBSPOT_DEFINED' }]
      );
      console.log('SMS: associated thread', comm.id, '-> deal', dealId);
    } catch (err) {
      console.warn('SMS: skip deal', dealId, err.message);
    }
  }
}

async function handleCallEvent(client, body) {
  // Skip entry point calls (coaching_team/callcenter target) — no agent info, creates "Unknown User" logs.
  // TODO: decide whether to log unanswered callcenter calls (entry point fires hangup with no operator leg)
  const targetType = body.target?.type;
  if (targetType === 'coaching_team' || targetType === 'callcenter') {
    console.log('SKIP entry point call — target type:', targetType);
    return;
  }

  // Use entry_point_call_id for callcenter operator legs (shared across all simultaneous ring legs).
  // Fall back to call_id for direct calls (no entry_point_call_id present).
  // Note: master_call_id is always null in Dialpad payloads — do not use it.
  const dialpadCallId = String(body.entry_point_call_id || body.call_id || body.id);
  const existing = await client.crm.objects.searchApi.doSearch('calls', {
    filterGroups: [{ filters: [{ propertyName: 'hs_call_external_id', operator: 'EQ', value: dialpadCallId }] }],
    properties: ['hs_call_external_id'],
    limit: 1,
  });
  if (existing.results?.length) {
    console.log('SKIP duplicate call', dialpadCallId);
    return;
  }

  const externalPhone = body.external_number;
  const contact = await lookupContact(client, body.contact?.id, externalPhone);

  console.log('CALL PAYLOAD:', JSON.stringify(body));
  const talkTimeMs = body.talk_time || 0;
  console.log('RAW TALK TIME (ms):', talkTimeMs);
  const durationSec = Math.round(talkTimeMs / 1000);
  const mins = Math.floor(durationSec / 60);
  const secs = durationSec % 60;

  let callBody = `Direction: ${body.direction || 'unknown'}\nDuration: ${mins}m ${secs}s`;
  if (body.recording_url) callBody += `\nRecording: ${body.recording_url}`;
  if (body.voicemail_url) callBody += `\nVoicemail: ${body.voicemail_url}`;

  const call = await client.crm.objects.basicApi.create('calls', {
    properties: {
      hs_call_body: callBody,
      hs_call_duration: String(talkTimeMs),
      hs_call_direction: body.direction === 'inbound' ? 'INBOUND' : 'OUTBOUND',
      hs_call_status: 'COMPLETED',
      hs_call_recording_url: body.recording_url || '',
      hs_call_from_number: body.internal_number || '',
      hs_call_to_number: body.external_number || '',
      hs_timestamp: body.date_started ? String(body.date_started) : String(Date.now()),
      hs_call_external_id: dialpadCallId,
    },
  });

  console.log('CALL CREATED:', call.id);

  if (!call.id || !contact) {
    console.log('STOPPING — callId:', call.id, 'contact:', contact?.id || 'null');
    return;
  }

  await client.crm.associations.v4.basicApi.create(
    'calls', call.id, 'contacts', contact.id,
    [{ associationTypeId: 194, associationCategory: 'HUBSPOT_DEFINED' }]
  );

  const dealIds = await getContactDeals(client, contact.id);
  await Promise.all(
    dealIds.map(dealId =>
      client.crm.associations.v4.basicApi.create(
        'calls', call.id, 'deals', dealId,
        [{ associationTypeId: 206, associationCategory: 'HUBSPOT_DEFINED' }]
      )
    )
  );
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
