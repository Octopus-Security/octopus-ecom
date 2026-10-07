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

async function upload(url, file) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file, credentials: 'same-origin' });
  let data = null; try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) throw Object.assign(new Error((data && data.error) || `HTTP ${res.status}`), { status: res.status, data });
  return data;
}

export const api = {
  designPrompt: (id) => call('GET', `/api/products/${id}/design-prompt`),
  uploadDesign: (id, file) => upload(`/api/products/${id}/upload-design`, file),
  products: () => call('GET', '/api/products'),
  summary: () => call('GET', '/api/summary'),
  createProduct: (b) => call('POST', '/api/products', b),
  generateDesign: (id, brief) => call('POST', `/api/products/${id}/generate-design`, brief === undefined ? {} : { brief }),
  draftCopy: (id) => call('POST', `/api/products/${id}/draft-copy`, {}),
  saveCopy: (id, b) => call('PATCH', `/api/products/${id}/copy`, b),
  product: (id) => call('GET', `/api/products/${id}`),
  blueprints: () => call('GET', '/api/pod/blueprints'),
  providers: (bp) => call('GET', `/api/pod/blueprints/${encodeURIComponent(bp)}/providers`),
  variants: (bp, pp) => call('GET', `/api/pod/blueprints/${encodeURIComponent(bp)}/providers/${encodeURIComponent(pp)}/variants`),
  marginPreview: (listPrice, baseCost, shipping = 0) => call('GET', `/api/margin-preview?listPrice=${listPrice}&baseCost=${baseCost}&shipping=${shipping}`),
  selectPod: (id, b) => call('POST', `/api/products/${id}/pod`, b),
  createPod: (id) => call('POST', `/api/products/${id}/create-pod`, {}),
  refreshMockups: (id) => call('POST', `/api/products/${id}/refresh-mockups`, {}),
  draftListing: (id) => call('POST', `/api/products/${id}/draft-listing`, {}),
  setPrice: (id, b) => call('PATCH', `/api/products/${id}/price`, b),
  submit: (id) => call('POST', `/api/products/${id}/submit`, {}),
  approve: (id, token) => call('POST', `/api/products/${id}/approve`, token ? { token } : {}),
  reject: (id, note) => call('POST', `/api/products/${id}/reject`, { note }),
  archive: (id, note) => call('POST', `/api/products/${id}/archive`, { note }),
  fees: () => call('GET', '/api/fees'),
  saveFees: (schedule) => call('POST', '/api/fees', { schedule }),
  resetFees: () => call('POST', '/api/fees/reset', {}),
  priceCalc: (b) => call('POST', '/api/price-calc', b),
  settings: () => call('GET', '/api/settings'),
  saveSettings: (b) => call('POST', '/api/settings', b),
  setCredential: (name, value) => call('POST', '/api/settings/credentials', { name, value }),
  deleteCredential: (name, token) => call('DELETE', `/api/settings/credentials/${encodeURIComponent(name)}`, token ? { token } : {}),
  setDryRun: (b) => call('POST', '/api/settings/dry-run', b),
  // M3: Etsy
  etsyStatus: () => call('GET', '/api/etsy/status'),
  etsyConnect: () => call('GET', '/api/etsy/connect'),
  etsyRecheck: (sid) => call('POST', `/api/etsy/stores/${sid}/recheck`, {}),
  etsyDisconnect: (sid, token) => call('POST', `/api/etsy/stores/${sid}/disconnect`, token ? { token } : {}),
  etsyAutopublish: (sid, enabled, token) => call('POST', `/api/etsy/stores/${sid}/autopublish`, token ? { enabled, token } : { enabled }),
  publish: (id, token) => call('POST', `/api/products/${id}/publish`, token ? { token } : {}),
  refreshStatus: (id) => call('POST', `/api/products/${id}/refresh-status`, {}),
  editListing: (id, b) => call('PATCH', `/api/products/${id}/listing`, b),
  syncSales: () => call('POST', '/api/sales/sync', {}),
  sales: () => call('GET', '/api/sales'),
  // Channels (Etsy: api, Redbubble: manual)
  channels: () => call('GET', '/api/channels'),
  productChannels: (id) => call('GET', `/api/products/${id}/channels`),
  setChannelState: (id, channel, b) => call('POST', `/api/products/${id}/channels/${channel}/state`, b),
  redbubblePack: (id, markup) => call('GET', `/api/products/${id}/redbubble/pack${markup ? `?markup=${encodeURIComponent(markup)}` : ''}`),
  importRedbubbleSales: (csv, preview) => call('POST', '/api/sales/redbubble/import', { csv, preview }),
  addRedbubbleSale: (b) => call('POST', '/api/sales/redbubble/entry', b),
  // M4: blocklist, print rule, batches
  blocklist: () => call('GET', '/api/blocklist'),
  blocklistAdd: (term, kind) => call('POST', '/api/blocklist', { term, kind }),
  blocklistRemove: (term) => call('DELETE', `/api/blocklist?term=${encodeURIComponent(term)}`),
  blocklistImport: (text, kind) => call('POST', '/api/blocklist/import', { text, kind }),
  blocklistCheck: (text) => call('POST', '/api/blocklist/check', { text }),
  batches: () => call('GET', '/api/batch'),
  batch: (id) => call('GET', `/api/batch/${id}`),
  runBatch: (b) => call('POST', '/api/batch', b),
  cancelBatch: (id) => call('POST', `/api/batch/${id}/cancel`, {}),
  resumeBatch: (id) => call('POST', `/api/batch/${id}/resume`, {}),
};

export const dollars = (cents) => (cents === null || cents === undefined ? '-' : `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`);
