import React, { useEffect, useMemo, useState } from 'react';
import { api, dollars } from '../api.js';

const STEPS = ['Creating product', 'Generating design', 'Creating the print-provider product and mockups', 'Drafting the listing'];
const toCents = (v) => Math.round(Number(v) * 100);

// New product: brief + blueprint/provider/variants + price -> design -> POD product + mockups -> draft listing.
// Every step is its own call and the flow resumes from the product's stage, so a failure keeps the card.
export default function Composer({ onClose, onChanged, onOpen }) {
  const [f, setF] = useState({ niche: '', brief: '', keywords: '', listPrice: '', shipping: '0' });
  const [bps, setBps] = useState([]); const [bpFilter, setBpFilter] = useState('');
  const [bp, setBp] = useState(''); const [providers, setProviders] = useState([]); const [pp, setPp] = useState('');
  const [variants, setVariants] = useState([]); const [chosen, setChosen] = useState([]); const [vNote, setVNote] = useState('');
  const [preview, setPreview] = useState(null);
  const [step, setStep] = useState(-1); const [err, setErr] = useState(''); const [newId, setNewId] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  useEffect(() => { api.blueprints().then((r) => setBps(r.blueprints)).catch((e) => setErr(e.message)); }, []);
  useEffect(() => { setProviders([]); setPp(''); setVariants([]); setChosen([]); if (bp) api.providers(bp).then((r) => setProviders(r.providers)).catch((e) => setErr(e.message)); }, [bp]);
  useEffect(() => { setVariants([]); setChosen([]); if (bp && pp) api.variants(bp, pp).then((r) => { setVariants(r.variants); setVNote(r.note || ''); setChosen(r.variants.slice(0, 1).map((v) => v.id)); }).catch((e) => setErr(e.message)); }, [bp, pp]);

  // Base cost is only known when the catalog supplies it (the stub does; Printify's catalog does not).
  const known = variants.filter((v) => chosen.includes(v.id) && Number.isInteger(v.costCents)).map((v) => v.costCents);
  const baseCost = known.length ? Math.max(...known) : null;
  const priceCents = f.listPrice === '' ? null : toCents(f.listPrice);
  useEffect(() => {
    if (priceCents === null || !(priceCents >= 0)) { setPreview(null); return undefined; }
    const t = setTimeout(() => { api.marginPreview(priceCents, baseCost ?? 0, toCents(f.shipping || 0)).then(setPreview).catch(() => setPreview(null)); }, 200);
    return () => clearTimeout(t);
  }, [priceCents, baseCost, f.shipping]);

  const shownBps = useMemo(() => bps.filter((b) => !bpFilter || `${b.title} ${b.brand || ''}`.toLowerCase().includes(bpFilter.toLowerCase())).slice(0, 200), [bps, bpFilter]);
  const area = variants.find((v) => chosen.includes(v.id))?.placeholders?.[0];

  async function go(e) {
    e.preventDefault(); setErr('');
    let id = newId; let s = 0;
    try {
      if (id === null) {
        setStep(0);
        const body = { brief: f.brief, niche: f.niche, keywords: f.keywords.split(',').map((x) => x.trim()).filter(Boolean), blueprint: bp, printProviderId: pp, variantIds: chosen };
        if (f.listPrice !== '') body.listPrice = f.listPrice;
        const r = await api.createProduct(body); id = r.product.id; setNewId(id); onChanged();
        if (r.podError) throw new Error(`blueprint not saved: ${r.podError}`);
      }
      for (;;) {
        const stage = (await api.product(id)).product.stage;
        if (stage === 'idea' || stage === 'failed') { s = 1; setStep(1); await api.generateDesign(id); }
        else if (stage === 'design_generated') { s = 2; setStep(2); await api.createPod(id); }
        else if (stage === 'mockup_ready') { s = 3; setStep(3); await api.draftListing(id); }
        else break;
        onChanged();
      }
      onOpen(id);
    } catch (e2) { setErr(`${STEPS[s]}: ${e2.message}`); setStep(-1); onChanged(); }
  }
  const busy = step >= 0; const locked = busy || newId !== null;
  const ready = f.brief.trim() && bp && pp && chosen.length && f.listPrice !== '';

  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-label="New product">
      <form className="modal wide" onSubmit={go}>
        <h3>New product</h3>
        <label>Niche / theme<input value={f.niche} onChange={set('niche')} maxLength={200} placeholder="cozy woodland animals" disabled={locked} /></label>
        <label>Design brief
          <textarea value={f.brief} onChange={set('brief')} maxLength={2000} rows={3} required disabled={locked} placeholder="A fox in a knitted scarf, flat vector style, warm autumn palette" />
        </label>
        <label>Keywords (comma separated; themes, not copied from other sellers)<input value={f.keywords} onChange={set('keywords')} disabled={locked} placeholder="fox, autumn, cozy" /></label>
        <label>Blueprint <input className="inline" value={bpFilter} onChange={(e) => setBpFilter(e.target.value)} placeholder="filter" disabled={locked} aria-label="Filter blueprints" />
          <select value={bp} onChange={(e) => setBp(e.target.value)} disabled={locked}><option value="">choose...</option>{shownBps.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}</select>
        </label>
        <label>Print provider
          <select value={pp} onChange={(e) => setPp(e.target.value)} disabled={locked || !providers.length}><option value="">choose...</option>{providers.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select>
        </label>
        {variants.length > 0 && (
          <fieldset disabled={locked}><legend className="small">Variants ({chosen.length} chosen)</legend>
            <div className="variants">{variants.slice(0, 120).map((v) => (
              <label key={v.id} className="check"><input type="checkbox" checked={chosen.includes(v.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, v.id] : chosen.filter((x) => x !== v.id))} />
                {v.title}{Number.isInteger(v.costCents) ? ` - ${dollars(v.costCents)}${v.estimated ? ' (est.)' : ''}` : ''}</label>))}</div>
            {area && <div className="muted small">Print area {area.position}: {area.width}x{area.height}px (designs are generated for this size)</div>}
            {vNote && <div className="muted small">{vNote}</div>}
          </fieldset>)}
        <div className="row">
          <label className="grow">List price (USD)<input type="number" min="0" step="0.01" value={f.listPrice} onChange={set('listPrice')} disabled={locked} /></label>
          <label className="grow">Shipping charged (USD)<input type="number" min="0" step="0.01" value={f.shipping} onChange={set('shipping')} disabled={locked} /></label>
        </div>
        {preview && (
          <div className={`margin ${preview.marginCents <= 0 ? 'neg' : preview.marginCents < preview.floorCents ? 'warn' : 'pos'}`} aria-live="polite">
            Projected margin {baseCost === null ? 'before base cost' : ''} <b>{dollars(preview.marginCents)}{preview.marginPct !== null ? ` (${preview.marginPct}%)` : ''}</b> (floor {dollars(preview.floorCents)}) &middot; listing {dollars(preview.listingFeeCents)}, transaction {dollars(preview.transactionFeeCents)}, processing {dollars(preview.processingFeeCents)}{preview.currencyConversionFeeCents > 0 ? `, currency ${dollars(preview.currencyConversionFeeCents)}` : ''}{preview.offsiteAdsFeeCents > 0 ? `, offsite ads ${dollars(preview.offsiteAdsFeeCents)}` : ''}
            {baseCost === null ? <div className="small muted">Printify exposes the base cost only after the product exists; the real margin shows on the card once it is created.</div> : <> &middot; base cost {dollars(baseCost)}</>}
            {preview.flags.map((x) => <span className="flag" key={x.code}>{x.code}</span>)}
          </div>)}
        {busy && <div className="muted" role="status">{STEPS[step]}... (image generation can take a minute)</div>}
        {err && <div className="banner error" role="alert">{err}{newId !== null ? ' The product is on the board; "Retry" resumes from here.' : ''}</div>}
        <div className="row">
          <button type="button" className="ghost" onClick={onClose} disabled={busy}>Close</button>
          <button type="submit" disabled={busy || !ready}>{newId !== null ? 'Retry' : 'Generate'}</button>
        </div>
      </form>
    </div>
  );
}
