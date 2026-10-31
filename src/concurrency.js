async function mapLimit(items, limit, mapper) {
  const list = Array.isArray(items) ? items : [];
  const workerCount = Math.max(1, Math.floor(Math.min(Number(limit) || 1, list.length || 1)));
  const results = new Array(list.length);
  let nextIndex = 0;
  // Workers claim indices before awaiting, so each item runs once and results
  // retain input order even when requests complete in a different order.
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < list.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await mapper(list[currentIndex], currentIndex);
    }
  }));
  return results;
}

async function allSettledLimit(items, limit, mapper) {
  return mapLimit(items, limit, async (item, index) => {
    try {
      return { status: 'fulfilled', value: await mapper(item, index) };
    } catch (reason) {
      return { status: 'rejected', reason };
    }
  });
}

module.exports = { mapLimit, allSettledLimit };
