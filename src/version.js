function semverParts(value) {
  const match = String(value || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?$/i);
  if (!match) return null;
  return match.slice(1, 4).map(Number);
}

function semverCompare(a, b) {
  const partsA = semverParts(a);
  const partsB = semverParts(b);
  if (!partsA || !partsB) return 0;
  for (let index = 0; index < 3; index++) {
    if (partsA[index] !== partsB[index]) return partsA[index] - partsB[index];
  }
  return 0;
}

function highestStableVersion(items, versionOf) {
  return (Array.isArray(items) ? items : []).reduce((highest, item) => {
    const version = versionOf(item);
    if (!semverParts(version)) return highest;
    if (!highest || semverCompare(version, versionOf(highest)) > 0) return item;
    return highest;
  }, null);
}

module.exports = { semverParts, semverCompare, highestStableVersion };
