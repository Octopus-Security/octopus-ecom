// Small fetch wrapper. Same-origin; the session cookie (or dev mode) authenticates.
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

export const api = {
  products: () => call('GET', '/api/products'),
  summary: () => call('GET', '/api/summary'),
  createProduct: (b) => call('POST', '/api/products', b),
  generateDesign: (id, brief) => call('POST', `/api/products/${id}/generate-design`, brief === undefined ? {} : { brief }),
  draftCopy: (id) => call('POST', `/api/products/${id}/draft-copy`, {}),
  saveCopy: (id, b) => call('PATCH', `/api/products/${id}/copy`, b),
  product: (id) => call('GET', `/api/products/${id}`),
  settings: () => call('GET', '/api/settings'),
  saveSettings: (b) => call('POST', '/api/settings', b),
  setCredential: (name, value) => call('POST', '/api/settings/credentials', { name, value }),
  deleteCredential: (name, token) => call('DELETE', `/api/settings/credentials/${encodeURIComponent(name)}`, token ? { token } : {}),
  setDryRun: (b) => call('POST', '/api/settings/dry-run', b),
};

export const dollars = (cents) => (cents === null || cents === undefined ? '-' : `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`);
