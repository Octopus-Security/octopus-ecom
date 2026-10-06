import React, { useCallback, useEffect, useState } from 'react';
import { api, dollars } from '../api.js';

// Ingested sales: one line per Etsy transaction. Simulated (stub) lines are labelled and are never part of NET.
export default function SalesView({ onChanged }) {
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
        Real: {sum.revenue.orders} order line(s), gross {dollars(sum.revenue.grossCents)}, after Etsy and processing fees {dollars(sum.revenue.afterFeesCents)}, per-sale COGS {dollars(sum.revenue.cogsCents)}, listing fees {dollars(sum.revenue.listingFeesCents)}. NET (all costs) {dollars(sum.netCents)}.
        {sum.simulated.orders > 0 && <> Simulated (stub, NOT in NET): {sum.simulated.orders} line(s), {dollars(sum.simulated.grossCents)}.</>}
      </div>
      <div className="small muted">Fees: the processing fee comes from Etsy when its payment record is readable, the 6.5% transaction fee is always computed. The column says which. Refunds are not subtracted yet.</div>
      {d.perStore.map((s, i) => <div className="small" key={i}>{s.storeName || 'no store'} ({s.source}): {s.lines} line(s), gross {dollars(s.grossCents)}, net {dollars(s.netCents)}{s.untrackedLines ? `, ${s.untrackedLines} for untracked listings (no COGS)` : ''}</div>)}
      {d.sales.length === 0 ? <div className="muted">No sales ingested yet.</div> : (
        <div className="scroll-x"><table className="econ"><thead><tr><th>When</th><th>Order</th><th>Product</th><th>Qty</th><th>Gross</th><th>Etsy fee</th><th>Processing</th><th>Net</th><th>COGS</th><th>Fees from</th></tr></thead>
          <tbody>{d.sales.map((s) => (
            <tr key={s.id} className={s.source === 'stub' ? 'muted' : ''}>
              <td>{s.ts.slice(0, 10)}</td><td>{s.orderId}{s.source === 'stub' ? ' (simulated)' : ''}</td><td>{s.productTitle || (s.externalListingId ? `listing ${s.externalListingId} (not tracked)` : '-')}</td><td>{s.quantity}</td>
              <td>{dollars(s.grossCents)}</td><td>-{dollars(s.etsyFeesCents)}</td><td>-{dollars(s.processingFeeCents)}</td><td>{dollars(s.netCents)}</td><td>{s.cogsCents === null ? 'unknown' : `-${dollars(s.cogsCents)}`}</td><td>{s.feeSource}</td>
            </tr>))}</tbody></table></div>
      )}
    </main>
  );
}
