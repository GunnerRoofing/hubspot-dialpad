'use strict';

// TEMPORARY one-off (2026-11-02): set owners on Dialpad calls and SMS threads this Lambda logged
// unowned during the previous 30 days. Reachable only by direct IAM invoke (event.source), never
// through API Gateway. Fills unowned records only; removed after the run.

const BATCH = 100;

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

async function planType(client, ownerForEmail, objectType, items, matches, counts) {
  const updates = [];
  for (const batch of chunks(items, BATCH)) {
    const resp = await client.crm.objects.batchApi.read(objectType, {
      inputs: batch.map((item) => ({ id: String(item.id) })),
      properties: ['hubspot_owner_id', 'hs_call_external_id', 'hs_engagement_source_id'],
    });
    const byId = new Map((resp.results || []).map((record) => [record.id, record]));
    for (const item of batch) {
      const record = byId.get(String(item.id));
      if (!record) { counts.missing += 1; continue; }
      if (record.properties.hubspot_owner_id) { counts.alreadyOwned += 1; continue; }
      if (!matches(record, item)) { counts.mismatch += 1; continue; }
      const owner = await ownerForEmail(client, item.email);
      if (!owner?.id) { counts.noHubspotOwner += 1; continue; }
      updates.push({ id: record.id, properties: { hubspot_owner_id: String(owner.id) } });
    }
  }
  counts.toUpdate = updates.length;
  return updates;
}

async function runOwnerBackfill(client, ownerForEmail, event) {
  const result = {};
  const specs = [
    ['calls', event.calls || [], (record, item) => record.properties.hs_call_external_id === item.key],
    ['communications', event.threads || [], (record) => String(record.properties.hs_engagement_source_id || '').startsWith('dpthread-')],
  ];
  for (const [objectType, items, matches] of specs) {
    const counts = { requested: items.length, missing: 0, alreadyOwned: 0, mismatch: 0, noHubspotOwner: 0, toUpdate: 0, updated: 0 };
    const updates = await planType(client, ownerForEmail, objectType, items, matches, counts);
    if (event.dryRun !== false) { result[objectType] = counts; continue; }
    for (const batch of chunks(updates, BATCH)) {
      const resp = await client.crm.objects.batchApi.update(objectType, { inputs: batch });
      counts.updated += (resp.results || []).length;
    }
    result[objectType] = counts;
  }
  console.log('OWNER BACKFILL', event.dryRun !== false ? 'dry-run' : 'apply', JSON.stringify(result));
  return result;
}

module.exports = { runOwnerBackfill };
