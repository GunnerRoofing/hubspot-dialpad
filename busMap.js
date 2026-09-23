'use strict';

/**
 * Map a gunner-dialpad EventBridge detail (ingest/EVENTS.md v1) onto the
 * Dialpad webhook body hubspot-dialpad already logs. Returns null to skip.
 */

function mapBusEvent(event) {
  if (!event || event.source !== 'gunner.comms-admin') return null;
  const detail = event.detail;
  if (!detail || detail.inserted !== true || detail.v !== 1) return null;
  const kind = event['detail-type'];
  if (kind === 'dialpad.sms') return mapSms(detail);
  if (kind === 'dialpad.call') return mapCall(detail);
  return null;
}

function mapSms(d) {
  const inbound = d.direction === 'inbound';
  const external = d.external_number || null;
  const internal = d.internal_number || null;
  const sent = d.sent_at ? Date.parse(d.sent_at) : Date.now();
  return {
    text: d.body || '',
    id: d.dialpad_msg_id,
    direction: d.direction,
    from_number: inbound ? external : internal,
    to_number: inbound ? internal : external,
    created_date: Number.isFinite(sent) ? sent : Date.now(),
  };
}

function mapCall(d) {
  if (d.final !== true && d.state !== 'hangup') return null;
  const started = d.received_at ? Date.parse(d.received_at) : Date.now();
  return {
    call_id: d.dialpad_call_id,
    state: 'hangup',
    direction: d.direction,
    external_number: d.external_number || null,
    internal_number: d.internal_number || null,
    entry_point_call_id: d.entry_point_call_id || null,
    target: {
      type: d.target_type || null,
      email: d.target_email || null,
    },
    date_started: Number.isFinite(started) ? started : Date.now(),
  };
}

module.exports = { mapBusEvent };
