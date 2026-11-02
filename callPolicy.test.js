'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  CALL_FINAL_STATES,
  callOwnerEmail,
  isUnansweredOperatorLeg,
  callClaimOwnerId,
} = require('./callPolicy');

test('the Dialpad user on a user-routed leg owns the call', () => {
  assert.equal(
    callOwnerEmail({ target: { type: 'user', email: ' John.Miller@gunnerroofing.com ' } }),
    'john.miller@gunnerroofing.com',
  );
  assert.equal(callOwnerEmail({ target: { type: 'office', email: 'main@gunnerroofing.com' } }), null);
  assert.equal(callOwnerEmail({ target: { type: 'call_center', email: null } }), null);
  assert.equal(callOwnerEmail({ target: { type: 'user', email: null } }), null);
  assert.equal(callOwnerEmail({}), null);
});

test('only routed operator legs that missed are skipped', () => {
  const leg = { entry_point_call_id: 'ep1', target: { type: 'user' } };
  assert.equal(isUnansweredOperatorLeg({ ...leg, state: 'missed' }), true);
  assert.equal(isUnansweredOperatorLeg({ ...leg, state: 'hangup' }), false);
  // A missed call straight to a rep's line is still that rep's call.
  assert.equal(isUnansweredOperatorLeg({ state: 'missed', target: { type: 'user' } }), false);
  assert.equal(isUnansweredOperatorLeg({ ...leg, state: 'missed', target: { type: 'call_center' } }), false);
});

test('the answering employee claims an unowned call but never takes an owned one', () => {
  assert.equal(callClaimOwnerId(null, 80661847), '80661847');
  assert.equal(callClaimOwnerId('', '80661847'), '80661847');
  assert.equal(callClaimOwnerId('77006918', '80661847'), null);
  assert.equal(callClaimOwnerId(null, null), null);
});

test('missed and voicemail calls are final and get logged', () => {
  for (const state of ['hangup', 'missed', 'voicemail_uploaded']) assert.equal(CALL_FINAL_STATES.has(state), true);
  assert.equal(CALL_FINAL_STATES.has('ringing'), false);
});
