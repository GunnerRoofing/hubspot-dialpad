'use strict';

/**
 * Shared HubSpot contact identity for Dialpad webhooks.
 * Match by dialpad_id, then searchable phone, then create once under a Dynamo lock.
 * Copy Dialpad first/last name onto create. Never insert a nameless clone when Dialpad
 * already knows the person.
 */

const { DynamoDBClient, PutItemCommand } = require('@aws-sdk/client-dynamodb');

function normalizePhone(p) {
  if (!p) return null;
  const digits = String(p).replace(/\D/g, '');
  if (!digits) return null;
  return digits.length === 10 ? `+1${digits}` : `+${digits}`;
}

function searchablePhoneValues(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  const vals = new Set([digits, `+${digits}`]);
  if (digits.length === 11 && digits.startsWith('1')) vals.add(digits.slice(1));
  if (digits.length === 10) {
    vals.add(`1${digits}`);
    vals.add(`+1${digits}`);
  }
  return [...vals].filter(Boolean);
}

function lockPk(phoneE164) {
  return `DP#PHONE_LOCK#${String(phoneE164 || '').replace(/\D/g, '')}`;
}

function nameFromDialpadContact(contact) {
  if (!contact || typeof contact !== 'object') return { first: null, last: null };
  const first = (contact.first_name || contact.firstname || '').trim() || null;
  const last = (contact.last_name || contact.lastname || '').trim() || null;
  if (first || last) return { first, last };
  const name = String(contact.name || '').trim();
  if (!name) return { first: null, last: null };
  const parts = name.split(/\s+/);
  return { first: parts[0] || null, last: parts.slice(1).join(' ') || null };
}

function hasName(c) {
  const p = c?.properties || {};
  return Boolean((p.firstname || '').trim() || (p.lastname || '').trim());
}

function pickBestContact(results, dialpadContactId) {
  const list = results || [];
  if (!list.length) return null;
  const dp = dialpadContactId != null ? String(dialpadContactId) : '';
  if (dp) {
    const byId = list.find((c) => String(c.properties?.dialpad_id || '') === dp);
    if (byId) return byId;
  }
  return list.find(hasName) || list[0];
}

function digitsOk(phoneE164) {
  const digits = String(phoneE164 || '').replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15;
}

async function tryAcquireCreateLock(ddb, table, phoneE164, ttlSec) {
  if (!table) {
    console.warn('CONTACT_CREATE_LOCK_TABLE unset — create lock disabled');
    return true;
  }
  if (!digitsOk(phoneE164)) return false;
  const now = Math.floor(Date.now() / 1000);
  try {
    await ddb.send(new PutItemCommand({
      TableName: table,
      Item: {
        pk: { S: lockPk(phoneE164) },
        phone: { S: phoneE164 },
        ttl: { N: String(now + Math.max(ttlSec || 600, 60)) },
        locked_at: { N: String(now) },
      },
      ConditionExpression: 'attribute_not_exists(pk)',
    }));
    console.log('create lock acquired for', phoneE164);
    return true;
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') {
      console.log('create lock held by peer for', phoneE164, '— will re-search');
      return false;
    }
    console.error('create lock Dynamo error for', phoneE164, err.message);
    return false;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function findExistingContact(client, rawPhone, dialpadContactId) {
  const phone = normalizePhone(rawPhone);
  if (!phone && !(dialpadContactId && /^\d+$/.test(String(dialpadContactId)))) return null;
  const results = await lookupByPhoneAndDialpad(client, phone, dialpadContactId);
  const found = pickBestContact(results, dialpadContactId);
  if (!found) {
    console.log('LOOKUP:', phone || `dpid:${dialpadContactId}`, '-> not found');
    return null;
  }
  if (results.length > 1) console.log('LOOKUP: multiple matches for', phone, '— using', found.id);
  else console.log('LOOKUP:', phone || `dpid:${dialpadContactId}`, '-> found', found.id);
  return found;
}

async function lookupByPhoneAndDialpad(client, phoneE164, dialpadContactId) {
  const properties = ['firstname', 'lastname', 'phone', 'mobilephone', 'dialpad_id'];
  const values = phoneE164 ? searchablePhoneValues(phoneE164) : [];
  const filterGroups = [];
  if (values.length) {
    filterGroups.push({
      filters: [{ propertyName: 'hs_searchable_calculated_phone_number', operator: 'IN', values }],
    });
    filterGroups.push({
      filters: [{ propertyName: 'hs_searchable_calculated_mobile_number', operator: 'IN', values }],
    });
  }
  if (dialpadContactId && /^\d+$/.test(String(dialpadContactId))) {
    filterGroups.push({
      filters: [{ propertyName: 'dialpad_id', operator: 'EQ', value: String(dialpadContactId) }],
    });
  }
  if (!filterGroups.length) return [];
  const resp = await client.crm.contacts.searchApi.doSearch({
    filterGroups,
    properties,
    limit: 10,
  });
  return resp.results || [];
}

async function enrichIfBlank(client, contact, { first, last, dialpadId }) {
  if (!contact?.id) return contact;
  const p = contact.properties || {};
  const patch = {};
  if (!String(p.firstname || '').trim() && first) patch.firstname = first;
  if (!String(p.lastname || '').trim() && last) patch.lastname = last;
  if (!String(p.dialpad_id || '').trim() && dialpadId && /^\d+$/.test(String(dialpadId))) {
    patch.dialpad_id = String(dialpadId);
  }
  if (!Object.keys(patch).length) return contact;
  try {
    const updated = await client.crm.contacts.basicApi.update(contact.id, { properties: patch });
    console.log('CONTACT enrich', contact.id, Object.keys(patch).join(','));
    return updated || contact;
  } catch (err) {
    console.warn('CONTACT enrich failed', contact.id, err.message);
    return contact;
  }
}

async function createContact(client, { phone, ownerId, first, last, dialpadId }) {
  const properties = { phone };
  if (ownerId) properties.hubspot_owner_id = ownerId;
  if (first) properties.firstname = first;
  if (last) properties.lastname = last;
  if (dialpadId && /^\d+$/.test(String(dialpadId))) properties.dialpad_id = String(dialpadId);
  const created = await client.crm.contacts.basicApi.create({ properties });
  console.log(
    'CONTACT created', created.id,
    first || last ? `name=${[first, last].filter(Boolean).join(' ')}` : 'nameless',
    ownerId ? `owner=${ownerId}` : 'unowned',
  );
  return created;
}

/**
 * Find or create one HubSpot contact for a Dialpad phone.
 * @returns the HubSpot contact object or null
 */
async function resolveOrCreateContact(opts) {
  const {
    client,
    ddb,
    table,
    rawPhone,
    dialpadContactId = null,
    dialpadContact = null,
    ownerId = null,
    ttlSec = 600,
    retryDelayMs = 350,
  } = opts;
  const phone = normalizePhone(rawPhone);
  if (!phone || !digitsOk(phone)) {
    console.warn('CONTACT refuse create — implausible number', rawPhone);
    return null;
  }
  const names = nameFromDialpadContact(dialpadContact);
  const lookup = async () => pickBestContact(
    await lookupByPhoneAndDialpad(client, phone, dialpadContactId),
    dialpadContactId,
  );

  let found = await lookup();
  if (found) {
    console.log('LOOKUP:', phone, '-> found', found.id);
    return enrichIfBlank(client, found, {
      first: names.first, last: names.last, dialpadId: dialpadContactId,
    });
  }
  console.log('LOOKUP:', phone, '-> not found');

  const acquired = await tryAcquireCreateLock(ddb, table, phone, ttlSec);
  if (!acquired) {
    for (let i = 0; i < 4; i += 1) {
      await sleep(retryDelayMs * (i + 1));
      found = await lookup();
      if (found) {
        console.log('LOOKUP after lock miss:', phone, '-> found', found.id);
        return enrichIfBlank(client, found, {
          first: names.first, last: names.last, dialpadId: dialpadContactId,
        });
      }
    }
    console.warn('create lock missed and contact still missing for', phone, '— not creating');
    return null;
  }

  found = await lookup();
  if (found) {
    return enrichIfBlank(client, found, {
      first: names.first, last: names.last, dialpadId: dialpadContactId,
    });
  }

  try {
    return await createContact(client, {
      phone,
      ownerId,
      first: names.first,
      last: names.last,
      dialpadId: dialpadContactId,
    });
  } catch (err) {
    console.warn('CONTACT create failed:', err.message);
    return lookup();
  }
}

function makeDdbClient() {
  return new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-2' });
}

module.exports = {
  normalizePhone,
  searchablePhoneValues,
  lockPk,
  nameFromDialpadContact,
  pickBestContact,
  tryAcquireCreateLock,
  findExistingContact,
  resolveOrCreateContact,
  makeDdbClient,
};
