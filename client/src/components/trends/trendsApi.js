// Fetch wrapper for /api/trends. Same-origin; the session cookie (or dev mode) authenticates.
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

// Trends names product types tee / mug / sticker / wall_art; Proposals names them tshirt / hoodie / mug / poster / sticker / tote.
const TYPE_TO_PROPOSAL = { tee: 'tshirt', mug: 'mug', sticker: 'sticker', wall_art: 'poster' };

/**
 * The body POST /api/proposals/generate accepts, built from a report's top opportunities:
 * {count, productTypes[], seeds:{themes[]}}. Each theme becomes a seed and each product type a filter. Blocked items are skipped
 * (the server also refuses blocklisted seeds); count is the number of distinct theme x type pairs, capped at 20 (the server cap).
 */
export function proposalRequest(report) {
  const items = ((report && report.top) || []).filter(t => t && t.theme && !t.blocked);
  const themes = [...new Set(items.map(t => t.theme))];
  const productTypes = [...new Set(items.map(t => TYPE_TO_PROPOSAL[t.productType]).filter(Boolean))];
  const pairs = new Set(items.map(t => `${t.theme}|${t.productType}`));
  return { count: Math.max(1, Math.min(20, pairs.size)), productTypes, seeds: { themes } };
}

export function makeTrendsApi(base = '/api/trends') {
  return {
    report: () => call('GET', `${base}/report`),
    status: () => call('GET', `${base}/status`),
    rebuild: (collect) => call('POST', `${base}/report/rebuild`, { collect: Boolean(collect) }),
    settings: (patch) => call('POST', `${base}/settings`, patch),
    etsyEnable: (token) => call('POST', `${base}/etsy-market/enable`, token ? { token } : {}),
    etsyDisable: () => call('POST', `${base}/etsy-market/disable`, {}),
    articles: () => call('GET', `${base}/articles`),
    setArticle: (theme, article) => call('PUT', `${base}/articles`, { theme, article }),
    clearArticle: (theme) => call('DELETE', `${base}/articles?theme=${encodeURIComponent(theme)}`),
    csvPreview: (csv, tool) => call('POST', `${base}/csv/preview`, { csv, tool }),
    csvImport: (csv, tool, previewHash) => call('POST', `${base}/csv/import`, { csv, tool, previewHash }),
    manual: () => call('GET', `${base}/manual`),
    addManual: (b) => call('POST', `${base}/manual`, b),
    deleteManual: (id) => call('DELETE', `${base}/manual/${id}`),
    // The Proposals feature lives on another branch. Feature-detect at runtime: the button exists only if the route does.
    proposalsAvailable: async () => { try { const r = await fetch('/api/proposals', { credentials: 'same-origin' }); return r.ok; } catch { return false; } },
    generateProposals: (report) => call('POST', '/api/proposals/generate', proposalRequest(report)),
  };
}
