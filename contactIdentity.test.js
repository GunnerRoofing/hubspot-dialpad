'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizePhone,
  searchablePhoneValues,
  lockPk,
  looksLikePhone,
  emailsFromDialpadContact,
  nameFromDialpadContact,
  pickBestContact,
  resolveOrCreateContact,
} = require('./contactIdentity');

test('normalizePhone E.164', () => {
  assert.equal(normalizePhone('9179692050'), '+19179692050');
  assert.equal(normalizePhone('+1 (917) 969-2050'), '+19179692050');
  assert.equal(normalizePhone(null), null);
});

test('searchablePhoneValues covers stored formats', () => {
  const v = searchablePhoneValues('+19179692050');
  assert.ok(v.includes('9179692050'));
  assert.ok(v.includes('19179692050'));
  assert.ok(v.includes('+19179692050'));
});

test('lockPk digits only', () => {
  assert.equal(lockPk('+19179692050'), 'DP#PHONE_LOCK#19179692050');
});

test('nameFromDialpadContact prefers first/last then splits name', () => {
  assert.deepEqual(
    nameFromDialpadContact({ first_name: 'Ada', last_name: 'Lovelace' }),
    { first: 'Ada', last: 'Lovelace' },
  );
  assert.deepEqual(
    nameFromDialpadContact({ name: 'Ada Lovelace' }),
    { first: 'Ada', last: 'Lovelace' },
  );
  assert.deepEqual(nameFromDialpadContact({ name: 'Ada' }), { first: 'Ada', last: null });
  assert.deepEqual(nameFromDialpadContact(null), { first: null, last: null });
});

test('nameFromDialpadContact ignores phone-shaped names', () => {
  assert.equal(looksLikePhone('(440) 541-4992'), true);
  assert.deepEqual(
    nameFromDialpadContact({ name: '(440) 541-4992' }, '+14405414992'),
    { first: null, last: null },
  );
  assert.deepEqual(
    nameFromDialpadContact({ first_name: '(862)', last_name: '273-7193' }, '+18622737193'),
    { first: null, last: null },
  );
  assert.deepEqual(
    nameFromDialpadContact({ name: 'Ada Lovelace' }, '+14405414992'),
    { first: 'Ada', last: 'Lovelace' },
  );
});

test('emailsFromDialpadContact reads string and object arrays', () => {
  assert.deepEqual(
    emailsFromDialpadContact({ email: 'Ada@X.com', emails: [{ address: 'ada@x.com' }, 'other@x.com'] }),
    ['ada@x.com', 'other@x.com'],
  );
});

test('pickBestContact prefers dialpad_id then a named row', () => {
  const blank = { id: '1', properties: { phone: '+15551111' } };
  const named = { id: '2', properties: { firstname: 'Ada', lastname: 'L' } };
  const stamped = { id: '3', properties: { dialpad_id: '99', firstname: 'X' } };
  assert.equal(pickBestContact([blank, named], null).id, '2');
  assert.equal(pickBestContact([blank, named, stamped], '99').id, '3');
  assert.equal(pickBestContact([blank], null).id, '1');
  assert.equal(pickBestContact([], null), null);
});

function mockClient({ searchResults = [], emailResults = [], created = { id: 'new' }, updates = [] }) {
  return {
    crm: {
      contacts: {
        searchApi: {
          doSearch: async (payload) => {
            const groups = payload.filterGroups || [];
            const isEmail = groups.some((g) => g.filters?.[0]?.propertyName === 'email');
            return { results: isEmail ? emailResults : searchResults };
          },
        },
        basicApi: {
          create: async ({ properties }) => {
            created.properties = properties;
            return created;
          },
          update: async (id, { properties }) => {
            updates.push({ id, properties });
            return { id, properties };
          },
        },
      },
    },
  };
}

test('resolveOrCreateContact copies Dialpad name on create', async () => {
  const created = { id: '247394225436' };
  const client = mockClient({ searchResults: [], created });
  const ddb = { send: async () => ({}) };
  const contact = await resolveOrCreateContact({
    client,
    ddb,
    table: 'dialpad-contact-create-locks',
    rawPhone: '+19179692050',
    dialpadContactId: '4755410371256320',
    dialpadContact: { id: '4755410371256320', name: 'Ada Lovelace' },
    ownerId: null,
  });
  assert.equal(contact.id, '247394225436');
  assert.equal(created.properties.firstname, 'Ada');
  assert.equal(created.properties.lastname, 'Lovelace');
  assert.equal(created.properties.dialpad_id, '4755410371256320');
  assert.equal(created.properties.phone, '+19179692050');
});

test('resolveOrCreateContact reuses named existing contact and stamps blank fields', async () => {
  const existing = {
    id: 'old',
    properties: { firstname: 'Ada', lastname: 'Lovelace', phone: '+19179692050' },
  };
  const updates = [];
  const client = mockClient({ searchResults: [existing], updates });
  client.crm.contacts.basicApi.update = async (id, { properties }) => {
    updates.push({ id, properties });
    return { id, properties: { ...existing.properties, ...properties } };
  };
  const contact = await resolveOrCreateContact({
    client,
    ddb: { send: async () => { throw new Error('lock should not run'); } },
    table: 'dialpad-contact-create-locks',
    rawPhone: '9179692050',
    dialpadContactId: '4755410371256320',
    dialpadContact: { name: 'Ada Lovelace' },
  });
  assert.equal(contact.id, 'old');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].properties.dialpad_id, '4755410371256320');
  assert.equal(updates[0].properties.firstname, undefined);
});

test('creation policy off still reuses an existing contact', async () => {
  const existing = {
    id: 'existing',
    properties: { firstname: 'Ada', lastname: 'Lovelace', phone: '+19179692050' },
  };
  const contact = await resolveOrCreateContact({
    client: mockClient({ searchResults: [existing] }),
    ddb: { send: async () => { throw new Error('lock should not run'); } },
    table: 'dialpad-contact-create-locks',
    rawPhone: '+19179692050',
    allowCreate: false,
  });
  assert.equal(contact.id, 'existing');
});

test('creation policy off never locks or creates an unknown contact', async () => {
  let created = 0;
  const client = mockClient({ searchResults: [] });
  client.crm.contacts.basicApi.create = async () => {
    created += 1;
    return { id: 'should-not' };
  };
  const contact = await resolveOrCreateContact({
    client,
    ddb: { send: async () => { throw new Error('lock should not run'); } },
    table: 'dialpad-contact-create-locks',
    rawPhone: '+19179692050',
    allowCreate: false,
  });
  assert.equal(contact, null);
  assert.equal(created, 0);
});

test('resolveOrCreateContact refuses short numbers', async () => {
  const contact = await resolveOrCreateContact({
    client: mockClient({}),
    ddb: { send: async () => ({}) },
    table: 't',
    rawPhone: '+187849',
  });
  assert.equal(contact, null);
});

test('lock held — never create', async () => {
  let created = 0;
  const client = mockClient({ searchResults: [] });
  client.crm.contacts.basicApi.create = async () => {
    created += 1;
    return { id: 'should-not' };
  };
  const err = new Error('held');
  err.name = 'ConditionalCheckFailedException';
  const contact = await resolveOrCreateContact({
    client,
    ddb: { send: async () => { throw err; } },
    table: 'dialpad-contact-create-locks',
    rawPhone: '+19179692050',
    ttlSec: 600,
    retryDelayMs: 0,
  });
  assert.equal(contact, null);
  assert.equal(created, 0);
});

test('phone-shaped Dialpad name is not copied onto create', async () => {
  const created = { id: 'n' };
  const client = mockClient({ searchResults: [], created });
  await resolveOrCreateContact({
    client,
    ddb: { send: async () => ({}) },
    table: 't',
    rawPhone: '+14405414992',
    dialpadContact: { name: '(440) 541-4992' },
  });
  assert.equal(created.properties.firstname, undefined);
  assert.equal(created.properties.lastname, undefined);
  assert.equal(created.properties.phone, '+14405414992');
});

test('email match stamps phone when HS row has none', async () => {
  const existing = {
    id: 'email-only',
    properties: { email: 'lizavargheseam@gmail.com', firstname: 'Liza', lastname: 'Varghese' },
  };
  const updates = [];
  const client = mockClient({ searchResults: [], emailResults: [existing] });
  client.crm.contacts.basicApi.update = async (id, { properties }) => {
    updates.push({ id, properties });
    return { id, properties: { ...existing.properties, ...properties } };
  };
  const contact = await resolveOrCreateContact({
    client,
    ddb: { send: async () => { throw new Error('lock should not run'); } },
    table: 't',
    rawPhone: '+15168602351',
    dialpadContact: { name: 'Liza Varghese', emails: ['lizavargheseam@gmail.com'] },
  });
  assert.equal(contact.id, 'email-only');
  assert.equal(updates[0].properties.phone, '+15168602351');
  assert.equal(updates[0].properties.firstname, undefined);
});

test('email match does not overwrite a different existing phone', async () => {
  const existing = {
    id: 'has-phone',
    properties: {
      email: 'a@x.com',
      phone: '+15550001111',
      firstname: 'Ada',
    },
  };
  const updates = [];
  const client = mockClient({ searchResults: [], emailResults: [existing] });
  client.crm.contacts.basicApi.update = async (id, { properties }) => {
    updates.push({ id, properties });
    return { id, properties };
  };
  const contact = await resolveOrCreateContact({
    client,
    ddb: { send: async () => { throw new Error('lock should not run'); } },
    table: 't',
    rawPhone: '+15168602351',
    dialpadContact: { emails: ['a@x.com'] },
  });
  assert.equal(contact.id, 'has-phone');
  assert.ok(!updates.some((u) => u.properties.phone));
});

test('lock Dynamo error — never create', async () => {
  let created = 0;
  const client = mockClient({ searchResults: [] });
  client.crm.contacts.basicApi.create = async () => {
    created += 1;
    return { id: 'should-not' };
  };
  const err = new Error('User is not authorized to perform dynamodb:PutItem');
  err.name = 'AccessDeniedException';
  const contact = await resolveOrCreateContact({
    client,
    ddb: { send: async () => { throw err; } },
    table: 'dialpad-contact-create-locks',
    rawPhone: '+19179692050',
    retryDelayMs: 0,
  });
  assert.equal(contact, null);
  assert.equal(created, 0);
});
