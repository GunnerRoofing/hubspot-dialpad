'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  ownerCanCreateOutboundContact,
  displayNameFromEmail,
} = require('./smsPolicy');

test('Sales team owners may create contacts from first outbound texts', () => {
  const owner = { id: 'sales-owner', teams: [{ id: '7', name: 'Sales Team' }] };
  assert.equal(ownerCanCreateOutboundContact(owner, {}), true);
});

test('PM owners and missing owners cannot create outbound contacts', () => {
  const pm = { id: 'pm-owner', teams: [{ id: '8', name: 'Project Management' }] };
  assert.equal(ownerCanCreateOutboundContact(pm, {}), false);
  assert.equal(ownerCanCreateOutboundContact(null, {}), false);
});

test('configured team IDs take precedence over team names', () => {
  const owner = { id: 'owner', teams: [{ id: '8', name: 'Sales Team' }] };
  const env = {
    SMS_LEAD_CREATING_TEAM_IDS: '7',
    SMS_LEAD_CREATING_TEAM_NAMES: 'Sales Team',
  };
  assert.equal(ownerCanCreateOutboundContact(owner, env), false);
});

test('mapped sender email becomes a readable activity name', () => {
  assert.equal(displayNameFromEmail('zachary.webb@gunnerroofing.com'), 'Zachary Webb');
  assert.equal(displayNameFromEmail('leslie@gunnerroofing.com'), 'Leslie');
  assert.equal(displayNameFromEmail(''), null);
});
