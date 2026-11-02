'use strict';

const CALL_FINAL_STATES = new Set(['hangup', 'missed', 'voicemail_uploaded']);

// Email of the employee who owns a call record: the Dialpad user on a user-routed leg.
// Office, department, callcenter and dynamic-caller legs name no employee.
function callOwnerEmail(body) {
  if (body.target?.type !== 'user') return null;
  const email = String(body.target.email || '').trim().toLowerCase();
  return email || null;
}

// A routed call (entry_point_call_id set) rings several operators at once. Legs that were not
// answered end as `missed` and must not create or claim the call record.
function isUnansweredOperatorLeg(body) {
  return Boolean(body.entry_point_call_id)
    && body.state === 'missed'
    && body.target?.type === 'user';
}

// Owner to set on an already-logged call when another leg of it arrives, or null to leave it.
// An unowned record (logged from the entry-point leg) is claimed by the employee who answered;
// an owned record is never reassigned.
function callClaimOwnerId(existingOwnerId, ownerId) {
  if (existingOwnerId || !ownerId) return null;
  return String(ownerId);
}

module.exports = {
  CALL_FINAL_STATES,
  callOwnerEmail,
  isUnansweredOperatorLeg,
  callClaimOwnerId,
};
