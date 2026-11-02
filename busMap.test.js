'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mapBusEvent } = require('./busMap');

test('sms insert maps customer phone by direction', () => {
  const body = mapBusEvent({
    source: 'gunner.comms-admin',
    'detail-type': 'dialpad.sms',
    detail: {
      v: 1, inserted: true, direction: 'inbound',
      external_number: '+15551111', internal_number: '+15552222',
      body: 'hi', dialpad_msg_id: '9', sent_at: '2026-09-23T12:00:00Z',
      target_name: 'John Miller', target_email: 'john.miller@gunnerroofing.com',
    },
  });
  assert.equal(body.from_number, '+15551111');
  assert.equal(body.to_number, '+15552222');
  assert.equal(body.text, 'hi');
  assert.equal(body.id, '9');
  assert.deepEqual(body.target, { name: 'John Miller', email: 'john.miller@gunnerroofing.com' });
});

test('skip when not inserted or wrong source', () => {
  assert.equal(mapBusEvent({
    source: 'gunner.comms-admin',
    'detail-type': 'dialpad.sms',
    detail: { v: 1, inserted: false, direction: 'inbound', body: 'x' },
  }), null);
  assert.equal(mapBusEvent({ source: 'other', detail: { v: 1, inserted: true } }), null);
});

test('call final maps hangup body and skips open calls', () => {
  const body = mapBusEvent({
    source: 'gunner.comms-admin',
    'detail-type': 'dialpad.call',
    detail: {
      v: 1, inserted: true, final: true, state: 'hangup', direction: 'inbound',
      dialpad_call_id: 'c1', external_number: '+1555',
      target_email: 'a@gunnerroofing.com', target_type: 'user',
      entry_point_call_id: 'ep1',
    },
  });
  assert.equal(body.call_id, 'c1');
  assert.equal(body.state, 'hangup');
  assert.equal(body.target.email, 'a@gunnerroofing.com');
  assert.equal(body.entry_point_call_id, 'ep1');
  const missed = mapBusEvent({
    source: 'gunner.comms-admin',
    'detail-type': 'dialpad.call',
    detail: { v: 1, inserted: true, final: true, state: 'missed', dialpad_call_id: 'c3' },
  });
  assert.equal(missed.state, 'missed');
  assert.equal(mapBusEvent({
    source: 'gunner.comms-admin',
    'detail-type': 'dialpad.call',
    detail: { v: 1, inserted: true, final: false, state: 'ringing', dialpad_call_id: 'c2' },
  }), null);
});
