const hubspot = require('@hubspot/api-client');

exports.handler = async (event) => {
  const body = JSON.parse(event.body || '{}');

  const client = new hubspot.Client({
    accessToken: process.env.HUBSPOT_ACCESS_TOKEN,
  });

  try {
    const isCall = body.call_id !== undefined || body.external_number !== undefined;
    const isSms = body.text !== undefined || body.from_number !== undefined;

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
    console.error('Dialpad webhook error:', err.message);
    // Always 200 so Dialpad does not retry
    return respond(200, { status: 'error', message: err.message });
  }
};

async function lookupContact(client, dialpadContactId, fallbackPhone) {
  if (dialpadContactId) {
    const resp = await client.apiRequest({
      method: 'POST',
      path: '/crm/v3/objects/contacts/search',
      body: {
        filterGroups: [{
          filters: [{ propertyName: 'dialpad_id', operator: 'EQ', value: String(dialpadContactId) }],
        }],
        properties: ['firstname', 'lastname', 'phone'],
        limit: 1,
      },
    });
    const found = resp.body?.results?.[0];
    if (found) return found;
  }

  if (fallbackPhone) {
    const resp = await client.apiRequest({
      method: 'POST',
      path: '/crm/v3/objects/contacts/search',
      body: {
        filterGroups: [
          { filters: [{ propertyName: 'phone', operator: 'EQ', value: fallbackPhone }] },
          { filters: [{ propertyName: 'mobilephone', operator: 'EQ', value: fallbackPhone }] },
        ],
        properties: ['firstname', 'lastname', 'phone'],
        limit: 1,
      },
    });
    return resp.body?.results?.[0] || null;
  }

  return null;
}

async function getContactDeals(client, contactId) {
  const resp = await client.apiRequest({
    method: 'GET',
    path: `/crm/v3/objects/contacts/${contactId}/associations/deals`,
  });
  return (resp.body?.results || []).map(r => r.id);
}

async function handleSmsEvent(client, body) {
  const externalPhone = body.direction === 'inbound' ? body.from_number : body.to_number;
  const dialpadContactId = body.contact?.id;
  const contact = await lookupContact(client, dialpadContactId, externalPhone);

  const commResp = await client.apiRequest({
    method: 'POST',
    path: '/crm/v3/objects/communications',
    body: {
      properties: {
        hs_communication_channel: 'SMS',
        hs_communication_body: body.text || '',
        hs_timestamp: body.date_created ? String(body.date_created) : String(Date.now()),
      },
    },
  });

  const commId = commResp.body?.id;
  if (!commId || !contact) return;

  await client.apiRequest({
    method: 'PUT',
    path: `/crm/v3/objects/communications/${commId}/associations/contact/${contact.id}/communication_to_contact`,
  });

  const dealIds = await getContactDeals(client, contact.id);
  await Promise.all(
    dealIds.map(dealId =>
      client.apiRequest({
        method: 'PUT',
        path: `/crm/v3/objects/communications/${commId}/associations/deal/${dealId}/communication_to_deal`,
      })
    )
  );
}

async function handleCallEvent(client, body) {
  const externalPhone = body.external_number;
  const dialpadContactId = body.contact?.id;
  const contact = await lookupContact(client, dialpadContactId, externalPhone);

  const durationSec = body.duration || 0;
  const mins = Math.floor(durationSec / 60);
  const secs = durationSec % 60;

  let callBody = `Direction: ${body.direction || 'unknown'}\nDuration: ${mins}m ${secs}s`;
  if (body.recording_url) callBody += `\nRecording: ${body.recording_url}`;
  if (body.voicemail_url) callBody += `\nVoicemail: ${body.voicemail_url}`;

  const callResp = await client.apiRequest({
    method: 'POST',
    path: '/crm/v3/objects/calls',
    body: {
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
    },
  });

  const callId = callResp.body?.id;
  if (!callId || !contact) return;

  await client.apiRequest({
    method: 'PUT',
    path: `/crm/v3/objects/calls/${callId}/associations/contact/${contact.id}/call_to_contact`,
  });

  const dealIds = await getContactDeals(client, contact.id);
  await Promise.all(
    dealIds.map(dealId =>
      client.apiRequest({
        method: 'PUT',
        path: `/crm/v3/objects/calls/${callId}/associations/deal/${dealId}/call_to_deal`,
      })
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
