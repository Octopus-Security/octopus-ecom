import React, { useEffect, useState } from 'react';
import { api, dollars } from '../api.js';
import FeeBreakdown from './FeeBreakdown.jsx';

// Fields are stored as cents / basis points; the panel edits dollars / percent and converts at the edge.
const toView = (f, v) => (f.unit === 'cents' ? (v / 100).toFixed(2) : f.unit === 'bps' ? (v / 100).toFixed(2) : v);
const fromView = (f, s) => (f.unit === 'bool' ? s : Math.round(Number(s) * 100));
const ORDER = ['setupFeeCents', 'listingFeeCents', 'transactionBps', 'processingBps', 'processingFixedCents', 'currencyConversionBps', 'currencyConversionApplies', 'offsiteAdsBps', 'offsiteAdsCapCents', 'offsiteAdsShareBps', 'salesTaxBps'];

// Etsy fee schedule editor. Edits apply to future projections; each projection records the schedule version it used.
export function FeeSchedulePanel() {
  const [d, setD] = useState(null); const [draft, setDraft] = useState({}); const [msg, setMsg] = useState(''); const [err, setErr] = useState('');
  const load = () => api.fees().then((r) => { setD(r); setDraft(Object.fromEntries(ORDER.map((k) => [k, r.fields[k].unit === 'bool' ? r.schedule[k] : toView(r.fields[k], r.schedule[k])]))); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  if (!d) return err ? <div className="banner error">{err}</div> : null;
  async function save() {
    setErr(''); setMsg('');
    try {
      const schedule = Object.fromEntries(ORDER.map((k) => [k, fromView(d.fields[k], draft[k])]));
      const r = await api.saveFees(schedule); setD(r); setMsg(`Saved as version ${r.schedule.version}. Applies to future projections.`); load();
    } catch (e) { setErr(e.message); }
  }
  async function reset() {
    setErr(''); setMsg('');
    try { const r = await api.resetFees(); setMsg(`Reset to Etsy defaults (version ${r.schedule.version}).`); load(); } catch (e) { setErr(e.message); }
  }
  return (
    <div className="cred">
      <div className="muted small">Defaults verified {d.verifiedOn} from {d.verifiedSource}. Items marked "assumed" were not on that page. Currently version {d.schedule.version}{d.schedule.updatedAt ? `, saved ${d.schedule.updatedAt.slice(0, 10)}` : ' (defaults)'}.</div>
      {err && <div className="banner error">{err}</div>}
      {ORDER.map((k) => {
        const f = d.fields[k];
        return (
          <label key={k} title={f.note}>{f.label} {f.unit === 'cents' ? '(USD)' : f.unit === 'bps' ? '(%)' : ''} <span className={f.status === 'verified' ? 'pos small' : 'warn small'}>{f.status === 'verified' ? 'verified' : 'assumed'}</span>
            {f.unit === 'bool'
              ? <input type="checkbox" checked={!!draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.checked })} />
              : <input type="number" min={f.min / 100} max={f.max / 100} step="0.01" value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />}
            <span className="muted small">{f.note}</span>
          </label>);
      })}
      <div className="row"><button onClick={save}>Save fees</button><button className="ghost" onClick={reset}>Reset to Etsy defaults</button>{msg && <span className="small pos">{msg}</span>}</div>
    </div>
  );
}

// Price calculator: costs + target margin in, minimum list price and itemised fees out.
export function PriceCalculator() {
  const [f, setF] = useState({ base: '', podShip: '0', ship: '0', target: '5.00', mode: 'cents', price: '' });
  const [r, setR] = useState(null); const [err, setErr] = useState('');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const cents = (v) => Math.round(Number(v || 0) * 100);
  async function run() {
    setErr(''); setR(null);
    try {
      const b = { podBaseCostCents: cents(f.base), podShippingCostCents: cents(f.podShip), shippingCents: cents(f.ship) };
      if (f.mode === 'cents') b.marginCents = cents(f.target); else b.marginPct = Number(f.target);
      if (f.price !== '') b.listPriceCents = cents(f.price);
      setR(await api.priceCalc(b));
    } catch (e) { setErr(e.message); }
  }
  return (
    <div className="cred">
      <div className="muted small">Minimum list price that meets a target margin under the current fee schedule, checked after rounding.</div>
      {err && <div className="banner error">{err}</div>}
      <div className="row">
        <label className="grow">POD base cost (USD)<input type="number" min="0" step="0.01" value={f.base} onChange={set('base')} /></label>
        <label className="grow">POD shipping cost (USD)<input type="number" min="0" step="0.01" value={f.podShip} onChange={set('podShip')} /></label>
        <label className="grow">Shipping charged (USD)<input type="number" min="0" step="0.01" value={f.ship} onChange={set('ship')} /></label>
      </div>
      <div className="row">
        <label className="grow">Target margin<input type="number" min="0" step="0.01" value={f.target} onChange={set('target')} /></label>
        <label>Unit<select value={f.mode} onChange={set('mode')}><option value="cents">USD per sale</option><option value="pct">% of list price</option></select></label>
        <label className="grow">Or check a price (USD)<input type="number" min="0" step="0.01" value={f.price} onChange={set('price')} /></label>
        <button disabled={f.base === ''} onClick={run}>Calculate</button>
      </div>
      {r && (<>
        <div><b>Suggested list price {dollars(r.suggested.listPriceCents)}</b>{r.suggested.breakEvenUnits !== null && <span className="muted small"> &middot; {r.suggested.breakEvenUnits} sale(s) to recover the {dollars(r.setupFeeCents)} set-up fee</span>}</div>
        <FeeBreakdown m={r.suggested.projection} />
        {r.atPrice && (<><div><b>At {dollars(r.atPrice.listPriceCents)}</b>{r.breakEvenAtPrice !== null && <span className="muted small"> &middot; {r.breakEvenAtPrice} sale(s) to recover the set-up fee</span>}</div><FeeBreakdown m={r.atPrice} /></>)}
      </>)}
    </div>
  );
}
