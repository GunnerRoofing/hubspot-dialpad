'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  ownerCanCreateOutboundContact,
  smsRouting,
  contactCreationPolicy,
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

test('inbound contact creation assigns the mapped destination owner', () => {
  const owner = { id: 'john-owner', teams: [] };
  assert.deepEqual(contactCreationPolicy('inbound', owner, {}), {
    allowCreate: true,
    ownerId: 'john-owner',
  });
});

test('inbound SMS routes the customer contact to the mapped destination salesperson', () => {
  const route = smsRouting({
    direction: 'inbound',
    from_number: '+16462866995',
    to_number: ['+12037144877'],
    target: { email: 'payload-target@gunnerroofing.com' },
  }, (number) => number === '+12037144877' ? 'john.miller@gunnerroofing.com' : null);

  assert.deepEqual(route, {
    externalPhone: '+16462866995',
    ownerEmails: ['john.miller@gunnerroofing.com', 'payload-target@gunnerroofing.com'],
  });
});

test('outbound SMS keeps the recipient as the contact and sender as owner candidate', () => {
  const route = smsRouting({
    direction: 'outbound',
    from_number: '+12037144877',
    to_number: '+16462866995',
  }, () => 'john.miller@gunnerroofing.com');

  assert.deepEqual(route, {
    externalPhone: '+16462866995',
    ownerEmails: ['john.miller@gunnerroofing.com'],
  });
});

test('mapped sender email becomes a readable activity name', () => {
  assert.equal(displayNameFromEmail('zachary.webb@gunnerroofing.com'), 'Zachary Webb');
  assert.equal(displayNameFromEmail('leslie@gunnerroofing.com'), 'Leslie');
  assert.equal(displayNameFromEmail(''), null);
});
