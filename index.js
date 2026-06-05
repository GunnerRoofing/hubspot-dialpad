const hubspot = require('@hubspot/api-client');

exports.handler = async (event) => {
  const body = JSON.parse(event.body || '{}');

  const client = new hubspot.Client({
    accessToken: process.env.HUBSPOT_ACCESS_TOKEN,
  });

  try {
    const isCall = body.call_id !== undefined || body.external_number !== undefined;
    const isSms = body.text !== undefined && body.text !== null && body.from_number !== undefined;

    if (isCall) {
      if (body.state !== 'hangup' && body.event !== 'hangup') {
        return respond(200, { status: 'skipped', reason: 'call not completed' });
      }
      await handleCallEvent(client, body);
    } else if (isSms) {
      await handleSmsEvent(client, body);
    } else {
      return respond(200, { status: 'skipped', reason: 'unknown event type' });
    }

    return respond(200, { status: 'ok' });
  } catch (err) {
    console.error('Webhook error:', err.message, err.body || '');
    return respond(200, { status: 'error', message: err.message });
  }
};

async function lookupContact(client, dialpadContactId, fallbackPhone) {
  if (dialpadContactId) {
    const resp = await client.crm.contacts.searchApi.doSearch({
      filterGroups: [{ filters: [{ propertyName: 'dialpad_id', operator: 'EQ', value: String(dialpadContactId) }] }],
      properties: ['firstname', 'lastname', 'phone'],
      limit: 1,
    });
    const found = resp.results?.[0];
    console.log('DIALPAD_ID LOOKUP:', dialpadContactId, '->', found ? `found ${found.id}` : 'not found');
    if (found) return found;
  }

  if (fallbackPhone) {
    const resp = await client.crm.contacts.searchApi.doSearch({
      filterGroups: [
        { filters: [{ propertyName: 'phone', operator: 'EQ', value: fallbackPhone }] },
        { filters: [{ propertyName: 'mobilephone', operator: 'EQ', value: fallbackPhone }] },
      ],
      properties: ['firstname', 'lastname', 'phone'],
      limit: 1,
    });
    const found = resp.results?.[0];
    console.log('PHONE LOOKUP:', fallbackPhone, '->', found ? `found ${found.id}` : 'not found');
    return found || null;
  }

  return null;
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

async function handleSmsEvent(client, body) {
  // Native Dialpad "Log SMS as activities" already creates the SMS communication and
  // links it to the contact (as one daily-rollup record). We DO NOT create anything —
  // we only add the contact's-deal association that native omits.
  const toNumber = Array.isArray(body.to_number) ? body.to_number[0] : body.to_number;
  const externalPhone = body.direction === 'inbound' ? body.from_number : toNumber;
  const contact = await lookupContact(client, body.contact?.id, externalPhone);
  if (!contact) {
    console.log('SMS: no contact for', body.contact?.id || 'n/a', externalPhone || 'n/a');
    return;
  }

  const dealIds = await getContactDeals(client, contact.id);
  if (!dealIds.length) {
    console.log('SMS: no deal for contact', contact.id);
    return;
  }

  // Native and this webhook fire on the same SMS, so the communication may not exist
  // the instant we look — retry briefly (within the Lambda timeout).
  let commId = null;
  for (let i = 0; i < 4; i++) {
    commId = await latestSmsComm(client, contact.id);
    if (commId) break;
    console.log(`SMS: native comm not found yet (attempt ${i + 1}) — waiting`);
    await sleep(2500);
  }
  if (!commId) {
    console.log('SMS: no native SMS comm found for contact', contact.id);
    return;
  }

  for (const dealId of dealIds) {
    try {
      await client.crm.associations.v4.basicApi.create(
        'communications', commId, 'deals', dealId,
        [{ associationTypeId: 85, associationCategory: 'HUBSPOT_DEFINED' }]
      );
      console.log('SMS: associated comm', commId, '-> deal', dealId);
    } catch (err) {
      console.warn('SMS: skip deal', dealId, err.message);
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Most-recent SMS communication on the contact (the active daily-rollup record native logs).
async function latestSmsComm(client, contactId) {
  const assocResp = await fetch(
    `https://api.hubapi.com/crm/v4/objects/contacts/${contactId}/associations/communications`,
    { headers: { 'Authorization': `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`, 'Accept-Encoding': 'identity' } }
  );
  const assocData = await assocResp.json();
  const ids = (assocData.results || []).map((r) => String(r.toObjectId));
  if (!ids.length) return null;

  const batch = await client.crm.objects.batchApi.read('communications', {
    inputs: ids.map((id) => ({ id })),
    properties: ['hs_communication_channel_type', 'hs_lastmodifieddate'],
  });
  const sms = (batch.results || [])
    .filter((c) => c.properties.hs_communication_channel_type === 'SMS')
    .sort((a, b) => new Date(b.properties.hs_lastmodifieddate) - new Date(a.properties.hs_lastmodifieddate));
  return sms[0]?.id || null;
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
