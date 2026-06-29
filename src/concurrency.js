async function mapLimit(items, limit, mapper) {
  const list = Array.isArray(items) ? items : [];
  const max = Math.max(1, Math.min(Number(limit) || 1, list.length || 1));
  const out = new Array(list.length);
  let index = 0;
  await Promise.all(Array.from({ length: max }, async () => {
    while (index < list.length) {
      const current = index++;
      out[current] = await mapper(list[current], current);
    }
  }));
  return out;
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
