'use strict';

const DEFAULT_LEAD_CREATING_TEAM_NAMES = 'Sales,Sales Team';

function parseList(value) {
  return new Set(
    String(value || '')
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

function ownerCanCreateOutboundContact(owner, env = process.env) {
  if (!owner?.id || !Array.isArray(owner.teams)) return false;

  const allowedIds = parseList(env.SMS_LEAD_CREATING_TEAM_IDS);
  if (allowedIds.size) {
    return owner.teams.some((team) => allowedIds.has(String(team?.id || '').toLowerCase()));
  }

  const allowedNames = parseList(
    env.SMS_LEAD_CREATING_TEAM_NAMES || DEFAULT_LEAD_CREATING_TEAM_NAMES,
  );
  return owner.teams.some((team) => allowedNames.has(String(team?.name || '').trim().toLowerCase()));
}

function displayNameFromEmail(email) {
  const local = String(email || '').trim().split('@')[0];
  if (!local) return null;
  const words = local.split(/[._-]+/).filter(Boolean);
  if (!words.length) return null;
  return words.map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase()).join(' ');
}

module.exports = {
  ownerCanCreateOutboundContact,
  displayNameFromEmail,
};
