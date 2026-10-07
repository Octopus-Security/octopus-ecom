import React, { useCallback, useEffect, useState } from 'react';
import { api, dollars } from '../api.js';

// Ingested sales: one line per Etsy transaction. Simulated (stub) lines are labelled and are never part of NET.
// Redbubble sales: the CSV from Redbubble's Sales History page, or a hand-entered line. Header names are ASSUMED (never confirmed),
// so a preview shows how the file was read before anything is saved.
function RedbubblePanel({ onDone, onOpenPlaybook }) {
  const [csv, setCsv] = useState('');
  const [prev, setPrev] = useState(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [e, setE] = useState({ productId: '', title: '', date: new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }), margin: '', orderId: '' });
  const run = async (preview) => {
    setErr(''); setMsg('');
    try {
      const r = await api.importRedbubbleSales(csv, preview);
      if (preview) setPrev(r); else { setPrev(null); setCsv(''); setMsg(`Imported ${r.imported} new line(s), ${r.duplicates} already known, ${r.unmatched} not matched to a product, ${r.skipped.length} skipped. Total ${dollars(r.totalCents)}.`); onDone(); }
    } catch (x) { setErr(x.message); setPrev(null); }
  };
  const add = async () => {
    setErr(''); setMsg('');
    try {
      const r = await api.addRedbubbleSale({ date: e.date, margin: e.margin, orderId: e.orderId || undefined, ...(e.productId ? { productId: Number(e.productId) } : { title: e.title }) });
      setMsg(`Recorded ${dollars(r.marginCents)} on ${r.date}${r.productId ? ` for product #${r.productId}` : ' (no product matched)'}.`); setE({ ...e, margin: '', orderId: '' }); onDone();
    } catch (x) { setErr(x.message); }
  };
  return (
    <div className="rb-panel">
      <div className="row between"><h4>Redbubble sales (manual channel)</h4>{onOpenPlaybook && <button className="ghost" onClick={() => onOpenPlaybook('redbubble-weekly')}>Playbook: weekly routine</button>}</div>
      <div className="small muted">Redbubble: Sales History page, request the CSV report, open it in a text editor and paste it here. Each line is your artist margin: no marketplace fee and no cost of goods are taken off, because Redbubble bears them. The column names are assumed, not confirmed, so Preview first.</div>
      {err && <div className="banner error" role="alert">{err}</div>}
      {msg && <div className="small pos">{msg}</div>}
      <textarea rows={5} value={csv} placeholder="Order Date,Order Number,Work Title,Product,Quantity,Artist Margin..." onChange={(x) => { setCsv(x.target.value); setPrev(null); }} />
      <div className="row"><button className="ghost" disabled={!csv.trim()} onClick={() => run(true)}>Preview</button><button disabled={!csv.trim() || !prev} onClick={() => run(false)}>Import</button></div>
      {prev && (
        <div className="small">
          <div>Read as: {Object.entries(prev.headerMap).map(([k, v]) => `${k} = "${v}"`).join(', ')} (assumed mapping).{prev.unmatchedHeaders.length > 0 && <> Not used: {prev.unmatchedHeaders.join(', ')}.</>}</div>
          <div>{prev.parsed} line(s) readable, {prev.wouldMatch} match a product, {prev.wouldBeUnmatched} would be kept without a product, {prev.skipped.length} skipped.</div>
          {prev.skipped.slice(0, 8).map((s, i) => <div className="warn" key={i}>line {s.line}: {s.reason}</div>)}
        </div>)}
      <h4>Or enter one by hand</h4>
      <div className="row">
        <label>Date<input value={e.date} onChange={(x) => setE({ ...e, date: x.target.value })} /></label>
        <label>Product #<input value={e.productId} placeholder="id" onChange={(x) => setE({ ...e, productId: x.target.value })} /></label>
        <label>or title<input value={e.title} onChange={(x) => setE({ ...e, title: x.target.value })} /></label>
        <label>Margin $<input value={e.margin} placeholder="1.20" onChange={(x) => setE({ ...e, margin: x.target.value })} /></label>
        <button disabled={!e.margin || !e.date} onClick={add}>Add sale</button>
      </div>
    </div>
  );
}

export default function SalesView({ onChanged, onOpenPlaybook }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.sales().then((x) => { setD(x); setErr(''); }).catch((e) => setErr(e.message)), []);
  useEffect(() => { load(); }, [load]);

  async function sync() {
    setBusy(true); setErr(''); setNote('');
    try {
      const r = await api.syncSales();
      setNote(`${r.source === 'stub' ? 'Simulated sync: ' : ''}${r.newSales} new, ${r.duplicates} already known, ${r.untracked} for listings this app does not track.`);
      await load(); if (onChanged) onChanged();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  if (!d) return <main className="board">{err ? <div className="banner error">{err}</div> : 'loading...'}</main>;
  const sum = d.summary;
  return (
    <main className="board">
      <div className="row between"><h3>Sales</h3><button disabled={busy} onClick={sync}>{busy ? 'Syncing...' : 'Sync from Etsy'}</button></div>
      {err && <div className="banner error" role="alert">{err}</div>}
      {note && <div className="small pos">{note}</div>}
      <div className="small muted">
        Real: {sum.revenue.orders} order line(s), gross {dollars(sum.revenue.grossCents)}, refunded {dollars(sum.revenue.refundedCents)}, after Etsy and processing fees and refunds {dollars(sum.revenue.afterFeesCents)}, per-sale COGS {dollars(sum.revenue.cogsCents)}, listing fees {dollars(sum.revenue.listingFeesCents)}. NET (all costs) {dollars(sum.netCents)}.
        {sum.simulated.orders > 0 && <> Simulated (stub, NOT in NET): {sum.simulated.orders} line(s), {dollars(sum.simulated.grossCents)}.</>}
      </div>
      <RedbubblePanel onDone={() => { load(); if (onChanged) onChanged(); }} onOpenPlaybook={onOpenPlaybook} />
      {sum.channels && Object.keys(sum.channels).length > 0 && <div className="small">By channel: {Object.entries(sum.channels).map(([c, v]) => `${c} ${v.orders} line(s), gross ${dollars(v.grossCents)}, net ${dollars(v.afterFeesCents)}`).join(' | ')}</div>}
      <div className="small muted">Fees: the processing fee comes from Etsy when its payment record is readable, the 6.5% transaction fee is always computed. The column says which. Refunds are subtracted from the matching sale (Etsy does not return its fees on a refund here, and the per-sale COGS stays).</div>
      {d.perStore.map((s, i) => <div className="small" key={i}>{s.storeName || (s.channel === 'etsy' ? 'no store' : s.channel)} ({s.source}): {s.lines} line(s), gross {dollars(s.grossCents)}, net {dollars(s.netCents)}{s.untrackedLines ? `, ${s.untrackedLines} for untracked listings (no COGS)` : ''}</div>)}
      {d.sales.length === 0 ? <div className="muted">No sales ingested yet.</div> : (
        <div className="scroll-x"><table className="econ"><thead><tr><th>When</th><th>Order</th><th>Channel</th><th>Product</th><th>Qty</th><th>Gross</th><th>Etsy fee</th><th>Processing</th><th>Refund</th><th>Net</th><th>COGS</th><th>Fees from</th></tr></thead>
          <tbody>{d.sales.map((s) => (
            <tr key={s.id} className={s.source === 'stub' ? 'muted' : ''}>
              <td>{s.ts.slice(0, 10)}</td><td>{s.orderId}{s.source === 'stub' ? ' (simulated)' : ''}</td><td>{s.channel}</td><td>{s.productTitle || (s.externalListingId ? `listing ${s.externalListingId} (not tracked)` : '-')}</td><td>{s.quantity}</td>
              <td>{dollars(s.grossCents)}</td><td>-{dollars(s.etsyFeesCents)}</td><td>-{dollars(s.processingFeeCents)}</td><td>{s.refundCents ? `-${dollars(s.refundCents)}` : '-'}</td><td>{dollars(s.netCents)}</td><td>{s.cogsCents === null ? (s.channel === 'etsy' ? 'unknown' : 'n/a') : `-${dollars(s.cogsCents)}`}</td><td>{s.feeSource}</td>
            </tr>))}</tbody></table></div>
      )}
    </main>
  );
}
