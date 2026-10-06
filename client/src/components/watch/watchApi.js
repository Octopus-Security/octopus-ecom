// Small fetch wrapper for the watch + playbook routes. Same-origin; the session cookie (or dev mode) authenticates.
async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) throw Object.assign(new Error((data && data.error) || `HTTP ${res.status}`), { status: res.status, data });
  return data;
}

export function makeWatchApi(base = '/api') {
  return {
    alerts: (all) => call('GET', `${base}/watch/alerts${all ? '?all=1' : ''}`),
    alertCount: () => call('GET', `${base}/watch/alerts/count`),
    ack: (id) => call('POST', `${base}/watch/alerts/${id}/ack`),
    ackAll: () => call('POST', `${base}/watch/alerts/ack-all`),
    runs: () => call('GET', `${base}/watch/runs`),
    runNow: (watcher) => call('POST', `${base}/watch/run`, watcher ? { watcher } : {}),
    watchlist: () => call('GET', `${base}/watch/watchlist`),
    addWatch: (b) => call('POST', `${base}/watch/watchlist`, b),
    updateWatch: (id, b) => call('PATCH', `${base}/watch/watchlist/${id}`, b),
    deleteWatch: (id) => call('DELETE', `${base}/watch/watchlist/${id}`),
    playbooks: () => call('GET', `${base}/playbooks`),
    playbook: (id, productId) => call('GET', `${base}/playbooks/${encodeURIComponent(id)}${productId ? `?productId=${productId}` : ''}`),
    tick: (id, stepId, checked, productId) => call('POST', `${base}/playbooks/${encodeURIComponent(id)}/steps/${encodeURIComponent(stepId)}/tick`, { checked, productId: productId || 0 }),
    resetPlaybook: (id, productId) => call('POST', `${base}/playbooks/${encodeURIComponent(id)}/reset`, { productId: productId || 0 }),
  };
}
