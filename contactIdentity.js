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

function looksLikePhone(s, againstE164) {
  const d = String(s || '').replace(/\D/g, '');
  if (d.length < 10) return false;
  if (againstE164) {
    const p = String(againstE164).replace(/\D/g, '');
    if (p && (d === p || d === p.slice(-10) || (p.endsWith(d) && d.length >= 10))) return true;
  }
  return d.length === 10 || (d.length === 11 && d.startsWith('1'));
}

function emailsFromDialpadContact(contact) {
  if (!contact || typeof contact !== 'object') return [];
  const out = [];
  const add = (e) => {
    const s = String(e || '').trim().toLowerCase();
    if (s.includes('@')) out.push(s);
  };
  add(contact.email);
  const list = contact.emails;
  if (Array.isArray(list)) {
    for (const item of list) {
      if (typeof item === 'string') add(item);
      else if (item && typeof item === 'object') add(item.email || item.address);
    }
  }
  return [...new Set(out)];
}

function nameFromDialpadContact(contact, againstPhone) {
  if (!contact || typeof contact !== 'object') return { first: null, last: null };
  let first = (contact.first_name || contact.firstname || '').trim() || null;
  let last = (contact.last_name || contact.lastname || '').trim() || null;
  if (!first && !last) {
    const name = String(contact.name || '').trim();
    if (name) {
      const parts = name.split(/\s+/);
      first = parts[0] || null;
      last = parts.slice(1).join(' ') || null;
    }
  }
  const combined = [first, last].filter(Boolean).join(' ');
  const packed = `${first || ''}${last || ''}`;
  if (looksLikePhone(combined, againstPhone) || looksLikePhone(packed, againstPhone)) {
    return { first: null, last: null };
  }
  return { first, last };
}

function hasName(c) {
  const p = c?.properties || {};
  const first = (p.firstname || '').trim();
  const last = (p.lastname || '').trim();
  if (!first && !last) return false;
  if (looksLikePhone(`${first} ${last}`) || looksLikePhone(`${first}${last}`)) return false;
  return true;
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
  const properties = ['firstname', 'lastname', 'phone', 'mobilephone', 'email', 'dialpad_id'];
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

async function lookupByEmail(client, emails) {
  const list = (emails || []).filter((e) => e && e.includes('@'));
  if (!list.length) return [];
  const properties = ['firstname', 'lastname', 'phone', 'mobilephone', 'email', 'dialpad_id'];
  const filterGroups = list.slice(0, 5).map((email) => ({
    filters: [{ propertyName: 'email', operator: 'EQ', value: email }],
  }));
  const resp = await client.crm.contacts.searchApi.doSearch({
    filterGroups,
    properties,
    limit: 10,
  });
  return resp.results || [];
}

function storedPhoneDigits(contact) {
  const p = contact?.properties || {};
  const raw = `${p.phone || ''} ${p.mobilephone || ''}`;
  return String(raw).replace(/\D/g, '');
}

async function enrichIfBlank(client, contact, { first, last, dialpadId, phone }) {
  if (!contact?.id) return contact;
  const p = contact.properties || {};
  const patch = {};
  const existingFirst = String(p.firstname || '').trim();
  const existingLast = String(p.lastname || '').trim();
  const existingPhoneShaped = looksLikePhone(`${existingFirst} ${existingLast}`)
    || looksLikePhone(`${existingFirst}${existingLast}`);
  if (first && (!existingFirst || existingPhoneShaped)) patch.firstname = first;
  if (last && (!existingLast || existingPhoneShaped)) patch.lastname = last;
  if (!String(p.dialpad_id || '').trim() && dialpadId && /^\d+$/.test(String(dialpadId))) {
    patch.dialpad_id = String(dialpadId);
  }
  const have = storedPhoneDigits(contact);
  const incoming = String(phone || '').replace(/\D/g, '');
  if (incoming && !have) patch.phone = phone;
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
    allowCreate = true,
    ttlSec = 600,
    retryDelayMs = 350,
  } = opts;
  const phone = normalizePhone(rawPhone);
  if (!phone || !digitsOk(phone)) {
    console.warn('CONTACT refuse create — implausible number', rawPhone);
    return null;
  }
  const names = nameFromDialpadContact(dialpadContact, phone);
  const emails = emailsFromDialpadContact(dialpadContact);
  const lookup = async () => {
    const byPhone = pickBestContact(
      await lookupByPhoneAndDialpad(client, phone, dialpadContactId),
      dialpadContactId,
    );
    if (byPhone) return byPhone;
    if (!emails.length) return null;
    const byEmail = pickBestContact(await lookupByEmail(client, emails), dialpadContactId);
    if (byEmail) console.log('LOOKUP:', phone, '-> email', emails[0], 'found', byEmail.id);
    return byEmail;
  };

  let found = await lookup();
  if (found) {
    console.log('LOOKUP:', phone, '-> found', found.id);
    return enrichIfBlank(client, found, {
      first: names.first, last: names.last, dialpadId: dialpadContactId, phone,
    });
  }
  console.log('LOOKUP:', phone, '-> not found');
  if (!allowCreate) {
    console.log('CONTACT create blocked by caller policy', phone);
    return null;
  }

  const acquired = await tryAcquireCreateLock(ddb, table, phone, ttlSec);
  if (!acquired) {
    for (let i = 0; i < 4; i += 1) {
      await sleep(retryDelayMs * (i + 1));
      found = await lookup();
      if (found) {
        console.log('LOOKUP after lock miss:', phone, '-> found', found.id);
        return enrichIfBlank(client, found, {
          first: names.first, last: names.last, dialpadId: dialpadContactId, phone,
        });
      }
    }
    console.warn('create lock missed and contact still missing for', phone, '— not creating');
    return null;
  }

  found = await lookup();
  if (found) {
    return enrichIfBlank(client, found, {
      first: names.first, last: names.last, dialpadId: dialpadContactId, phone,
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
  looksLikePhone,
  emailsFromDialpadContact,
  nameFromDialpadContact,
  pickBestContact,
  tryAcquireCreateLock,
  findExistingContact,
  resolveOrCreateContact,
  makeDdbClient,
};
