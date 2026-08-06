const { SENSITIVE_KEYS, decrypt, isEncrypted } = require('./crypto');

const MASKED_SECRET_VALUES = new Set(['__encrypted__', '__set__']);
const ENDPOINT_FIELDS = ['host', 'url', 'socketPath', 'sshHost', 'database'];

function normalizedIdentityValue(value) {
  return String(value).trim().replace(/\/+$/, '').toLowerCase();
}

function configItemIdentityKeys(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return [];

  const keys = [];
  for (const field of ENDPOINT_FIELDS) {
    const value = item[field];
    if (value != null && value !== '') {
      keys.push(`${field}:${normalizedIdentityValue(value)}`);
    }
  }
  if (item.name != null && item.name !== '') {
    keys.push(`name:${normalizedIdentityValue(item.name)}`);
  }
  return keys;
}

function existingItemFor(incomingItem, existingArr, index, existingByIdentity) {
  for (const key of configItemIdentityKeys(incomingItem)) {
    const matches = existingByIdentity.get(key);
    if (matches?.length === 1) return matches[0];
  }

  // A single legacy item may gain a display name or have its endpoint edited.
  // In that unambiguous case it is still the same item, so keep its secrets.
  if (existingArr.length === 1) return existingArr[0];

  // Items without an identity (for example a partially completed new row) can
  // only be matched safely by their position.
  if (configItemIdentityKeys(incomingItem).length === 0) return existingArr[index];
  return undefined;
}

function preservedSecret(value) {
  if (value == null || value === '') return undefined;
  if (!isEncrypted(value)) return MASKED_SECRET_VALUES.has(value) ? undefined : value;
  try {
    return MASKED_SECRET_VALUES.has(decrypt(value)) ? undefined : value;
  } catch {
    // Keep ciphertext that cannot be inspected here; dropping it would lose a
    // potentially valid secret after a key/config recovery operation.
    return value;
  }
}

function mergePreservingSecrets(incoming, existing) {
  if (!incoming || typeof incoming !== 'object') return incoming;
  if (Array.isArray(incoming)) {
    const existingArr = Array.isArray(existing) ? existing : [];
    const existingByIdentity = new Map();
    existingArr.forEach(item => {
      configItemIdentityKeys(item).forEach(key => {
        const matches = existingByIdentity.get(key) || [];
        matches.push(item);
        existingByIdentity.set(key, matches);
      });
    });

    return incoming.map((item, index) => mergePreservingSecrets(
      item,
      existingItemFor(item, existingArr, index, existingByIdentity),
    ));
  }

  const out = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (SENSITIVE_KEYS.has(key) && MASKED_SECRET_VALUES.has(value)) {
      const previous = preservedSecret(existing?.[key]);
      if (previous !== undefined) out[key] = previous;
    } else if (key === 'instances' && Array.isArray(value) && existing && !Array.isArray(existing.instances) && existing.url) {
      out[key] = mergePreservingSecrets(value, [existing]);
    } else if (typeof value === 'object' && value !== null) {
      out[key] = mergePreservingSecrets(value, existing?.[key]);
    } else {
      out[key] = value;
    }
  }
  return out;
}

module.exports = { mergePreservingSecrets };
