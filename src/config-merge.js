const { SENSITIVE_KEYS, decrypt, isEncrypted } = require('./crypto');

const MASKED_SECRET_VALUES = new Set(['__encrypted__', '__set__']);
const ENDPOINT_FIELDS = ['configId', 'host', 'url', 'socketPath', 'sshHost', 'database', 'repo', 'projectId', 'projectPath'];
const TOKEN_SECRET_ALIASES = ['token', 'apiToken', 'accessToken', 'bearerToken', 'apiKey'];

function normalizedIdentityValue(value) {
  return String(value).trim().replace(/\/+$/, '').toLowerCase();
}

function ciResourceIdentityKeys(item) {
  const provider = String(item?.provider || item?.type || '').trim().toLowerCase();
  if (!['github', 'gitlab'].includes(provider)) return [];
  const current = provider === 'gitlab'
    ? (item.projectId || item.project || item.projectPath || item.path || '')
    : (item.repo || item.repository || '');
  return [current, item.originalResource]
    .filter(value => value != null && String(value).trim() !== '')
    .map(value => `ciResource:${provider}:${normalizedIdentityValue(value)}`);
}

function configItemIdentityKeys(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return [];

  const keys = [];
  const provider = String(item.provider || item.type || '').trim().toLowerCase();
  for (const field of ENDPOINT_FIELDS) {
    const value = item[field];
    if (value != null && value !== '') {
      const identityField = field === 'configId' && ['github', 'gitlab'].includes(provider)
        ? `${field}:${provider}`
        : field;
      keys.push(`${identityField}:${normalizedIdentityValue(value)}`);
    }
  }
  keys.push(...ciResourceIdentityKeys(item));
  if (item.name != null && item.name !== '') {
    keys.push(`name:${normalizedIdentityValue(item.name)}`);
  }
  return keys;
}

function existingItemFor(incomingItem, existingArr, index, existingByIdentity) {
  const identityKeys = configItemIdentityKeys(incomingItem);
  const incomingHasConfigId = incomingItem?.configId != null && String(incomingItem.configId).trim() !== '';
  const provider = String(incomingItem?.provider || incomingItem?.type || '').trim().toLowerCase();
  const incomingIsCiRow = ['github', 'gitlab'].includes(provider);

  if (incomingHasConfigId && incomingIsCiRow) {
    const configIdKey = `configId:${provider}:${normalizedIdentityValue(incomingItem.configId)}`;
    const configIdMatches = existingByIdentity.get(configIdKey);
    if (configIdMatches?.length === 1) return configIdMatches[0];
    if (configIdMatches?.length > 1) return undefined;

    // A newly generated UI id is not proof that a sole legacy row is the same
    // card. Only the transient, explicit originalResource hint may migrate a
    // legacy CI token to that new id. This prevents a brand-new card (notably
    // "All repositories") from silently borrowing another card's credential.
    const originalResource = String(incomingItem.originalResource || '').trim();
    if (!originalResource) return undefined;
    const resourceKey = `ciResource:${provider}:${normalizedIdentityValue(originalResource)}`;
    const legacyMatches = (existingByIdentity.get(resourceKey) || [])
      .filter(item => item?.configId == null || item.configId === '');
    return legacyMatches.length === 1 ? legacyMatches[0] : undefined;
  }

  for (const key of identityKeys) {
    let matches = existingByIdentity.get(key);
    if (incomingHasConfigId && !key.startsWith('configId:')) {
      // A generated configId may migrate one legacy row, but it must never use
      // a secondary identity to inherit a secret from another modern row.
      matches = matches?.filter(item => item?.configId == null || item.configId === '');
    }
    if (matches?.length === 1) return matches[0];
    if (key.startsWith('configId:') && matches?.length > 1) return undefined;
  }

  // A single legacy item may gain a display name or have its endpoint edited.
  // In that unambiguous case it is still the same item, so keep its secrets.
  const fallbackItems = incomingHasConfigId
    ? existingArr.filter(item => item?.configId == null || item.configId === '')
    : existingArr;
  if (fallbackItems.length === 1) return fallbackItems[0];

  // Items without an identity (for example a partially completed new row) can
  // only be matched safely by their position.
  if (identityKeys.length === 0) return existingArr[index];
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

function preservedSecretForKey(existing, key) {
  const direct = preservedSecret(existing?.[key]);
  if (direct !== undefined) return direct;
  if (!TOKEN_SECRET_ALIASES.includes(key)) return undefined;
  for (const alias of TOKEN_SECRET_ALIASES) {
    if (alias === key) continue;
    const candidate = preservedSecret(existing?.[alias]);
    if (candidate !== undefined) return candidate;
  }
  return undefined;
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
    if (key === 'originalResource' && ['github', 'gitlab'].includes(String(incoming.provider || incoming.type || '').trim().toLowerCase())) {
      continue;
    } else if (SENSITIVE_KEYS.has(key) && MASKED_SECRET_VALUES.has(value)) {
      const previous = preservedSecretForKey(existing, key);
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
