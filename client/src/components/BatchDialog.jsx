import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

// Run batch: a niche and a count in, N products out at PENDING_APPROVAL. It never publishes; a human approves each one.
export default function BatchDialog({ onClose, onStarted }) {
  const [f, setF] = useState({ niche: '', count: '5', keywords: '', listPrice: '', shipping: '0' });
  const [bps, setBps] = useState([]); const [bp, setBp] = useState(''); const [providers, setProviders] = useState([]); const [pp, setPp] = useState('');
  const [variants, setVariants] = useState([]); const [chosen, setChosen] = useState([]); const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  useEffect(() => { api.blueprints().then((r) => setBps(r.blueprints)).catch((e) => setErr(e.message)); }, []);
  useEffect(() => { setProviders([]); setPp(''); setVariants([]); setChosen([]); if (bp) api.providers(bp).then((r) => setProviders(r.providers)).catch((e) => setErr(e.message)); }, [bp]);
  useEffect(() => { setVariants([]); setChosen([]); if (bp && pp) api.variants(bp, pp).then((r) => { setVariants(r.variants); setChosen(r.variants.slice(0, 1).map((v) => v.id)); }).catch((e) => setErr(e.message)); }, [bp, pp]);
  const shown = bps.filter((b) => !filter || `${b.title} ${b.brand || ''}`.toLowerCase().includes(filter.toLowerCase())).slice(0, 200);
  const ready = f.niche.trim() && Number(f.count) >= 1 && bp && pp && chosen.length && f.listPrice !== '';

  async function go(e) {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const r = await api.runBatch({ niche: f.niche, count: Number(f.count), keywords: f.keywords.split(',').map((x) => x.trim()).filter(Boolean), blueprint: bp, printProviderId: pp, variantIds: chosen, listPrice: f.listPrice, shipping: f.shipping });
      onStarted(r.batch.id);
    } catch (e2) { setErr(e2.message); setBusy(false); }
  }
  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-label="Run batch">
      <form className="modal wide" onSubmit={go}>
        <h3>Run batch</h3>
        <div className="muted small">Proposes N distinct original design concepts from your niche, then takes each through design, print-readiness, print-provider product, copy and margin, and stops at PENDING_APPROVAL. Nothing is published. Generation spend counts against the daily cap; if it is reached the batch pauses.</div>
        <label>Niche / theme<input value={f.niche} onChange={set('niche')} maxLength={200} required placeholder="cozy woodland animals" /></label>
        <label>Keywords (comma separated; themes, not brands)<input value={f.keywords} onChange={set('keywords')} placeholder="fox, owl, hedgehog" /></label>
        <label>How many products (max 25)<input type="number" min="1" max="25" value={f.count} onChange={set('count')} required /></label>
        <label>Blueprint <input className="inline" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="filter" aria-label="Filter blueprints" />
          <select value={bp} onChange={(e) => setBp(e.target.value)}><option value="">choose...</option>{shown.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}</select></label>
        <label>Print provider<select value={pp} onChange={(e) => setPp(e.target.value)} disabled={!providers.length}><option value="">choose...</option>{providers.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select></label>
        {variants.length > 0 && <fieldset><legend className="small">Variants ({chosen.length} chosen)</legend><div className="variants">{variants.slice(0, 120).map((v) => (
          <label key={v.id} className="check"><input type="checkbox" checked={chosen.includes(v.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, v.id] : chosen.filter((x) => x !== v.id))} />{v.title}</label>))}</div></fieldset>}
        <div className="row">
          <label className="grow">List price (USD)<input type="number" min="0" step="0.01" value={f.listPrice} onChange={set('listPrice')} required /></label>
          <label className="grow">Shipping charged (USD)<input type="number" min="0" step="0.01" value={f.shipping} onChange={set('shipping')} /></label>
        </div>
        {err && <div className="banner error" role="alert">{err}</div>}
        <div className="row"><button type="button" className="ghost" onClick={onClose} disabled={busy}>Close</button><button type="submit" disabled={busy || !ready}>{busy ? 'Starting...' : 'Run batch'}</button></div>
      </form>
    </div>
  );
}
