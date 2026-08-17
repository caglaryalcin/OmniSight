(function () {
  const cookieName = 'omnisight_demo_day';
  const markerKey = 'omnisight_demo_reset_day';
  let memoryDay = '';

  function resettableKey(key) {
    return (key.startsWith('os_') && key !== 'os_token')
      || key.startsWith('omnisight_topology_');
  }

  function clearResettable(storage) {
    try {
      for (let index = storage.length - 1; index >= 0; index -= 1) {
        const key = storage.key(index);
        if (key && resettableKey(key)) storage.removeItem(key);
      }
    } catch {}
  }

  function applyDemoDailyReset(day) {
    const normalizedDay = String(day || '').trim();
    if (!normalizedDay) return false;
    let previousDay = memoryDay;
    try { previousDay = localStorage.getItem(markerKey) || previousDay; } catch {}
    if (previousDay === normalizedDay) return false;

    clearResettable(localStorage);
    clearResettable(sessionStorage);
    memoryDay = normalizedDay;
    try { localStorage.setItem(markerKey, normalizedDay); } catch {}
    return true;
  }

  window.omnisightApplyDemoDailyReset = applyDemoDailyReset;
  try {
    const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${cookieName}=([^;]+)`));
    if (match) applyDemoDailyReset(decodeURIComponent(match[1]));
  } catch {}
})();
