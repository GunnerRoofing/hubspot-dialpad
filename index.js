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
  const toNumber = Array.isArray(body.to_number) ? body.to_number[0] : body.to_number;
  const externalPhone = body.direction === 'inbound' ? body.from_number : toNumber;
  const contact = await lookupContact(client, body.contact?.id, externalPhone);

  const comm = await client.crm.objects.basicApi.create('communications', {
    properties: {
      hs_communication_channel_type: 'SMS',
      hs_communication_logged_from: 'CRM',
      hs_communication_body: body.text || '',
      hs_timestamp: body.created_date ? String(body.created_date) : String(Date.now()),
    },
  });

  console.log('COMMUNICATION CREATED:', comm.id);

  if (!comm.id || !contact) {
    console.log('STOPPING — commId:', comm.id, 'contact:', contact?.id || 'null');
    return;
  }

  await client.crm.associations.v4.basicApi.create(
    'communications', comm.id, 'contacts', contact.id,
    [{ associationTypeId: 81, associationCategory: 'HUBSPOT_DEFINED' }]
  );
  console.log('ASSOCIATED to contact', contact.id);

  const dealIds = await getContactDeals(client, contact.id);
  console.log('DEALS FOUND:', dealIds.length);
  await Promise.all(
    dealIds.map(dealId =>
      client.crm.associations.v4.basicApi.create(
        'communications', comm.id, 'deals', dealId,
        [{ associationTypeId: 85, associationCategory: 'HUBSPOT_DEFINED' }]
      ).catch(err => console.warn('SKIP deal', dealId, err.message))
    )
  );
}

async function handleCallEvent(client, body) {
  const externalPhone = body.external_number;
  const contact = await lookupContact(client, body.contact?.id, externalPhone);

  const durationSec = body.duration || 0;
  const mins = Math.floor(durationSec / 60);
  const secs = durationSec % 60;

  let callBody = `Direction: ${body.direction || 'unknown'}\nDuration: ${mins}m ${secs}s`;
  if (body.recording_url) callBody += `\nRecording: ${body.recording_url}`;
  if (body.voicemail_url) callBody += `\nVoicemail: ${body.voicemail_url}`;

  const call = await client.crm.objects.basicApi.create('calls', {
    properties: {
      hs_call_body: callBody,
      hs_call_duration: String(durationSec * 1000),
      hs_call_direction: body.direction === 'inbound' ? 'INBOUND' : 'OUTBOUND',
      hs_call_status: 'COMPLETED',
      hs_call_recording_url: body.recording_url || '',
      hs_call_from_number: body.internal_number || '',
      hs_call_to_number: body.external_number || '',
      hs_timestamp: body.date_started ? String(body.date_started) : String(Date.now()),
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
