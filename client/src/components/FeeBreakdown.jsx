import React from 'react';
import { dollars } from '../api.js';

// Itemised projection: price, POD cost, each Etsy fee line, net margin and margin % of price. `m` is a projectMargin result.
export default function FeeBreakdown({ m, floorCents, costLabel = 'POD base cost' }) {
  const cls = m.marginCents <= 0 ? 'neg' : floorCents !== undefined && m.marginCents < floorCents ? 'warn' : 'pos';
  return (
    <table className="econ"><tbody>
      <tr><td>List price</td><td>{dollars(m.listPriceCents)}</td></tr>
      {m.podShippingCostCents !== null && <tr><td>Shipping charged</td><td>{dollars(m.shippingCents)}</td></tr>}
      <tr><td>{costLabel}</td><td>-{dollars(m.podBaseCostCents)}</td></tr>
      {m.podShippingCostCents !== null && <tr><td>POD shipping cost</td><td>-{dollars(m.podShippingCostCents)}</td></tr>}
      {m.feeLines.map((l) => <tr key={l.key} title={l.basis}><td>{l.label}</td><td>-{dollars(l.cents)}</td></tr>)}
      <tr><td><b>Net margin</b>{floorCents !== undefined ? ` (floor ${dollars(floorCents)})` : ''}</td><td className={cls}><b>{dollars(m.marginCents)}{m.marginPct !== null ? ` (${m.marginPct}%)` : ''}</b></td></tr>
      <tr><td className="muted small" colSpan="2">Fee schedule v{m.scheduleVersion}; processing fee includes an estimated {(m.scheduleUsed.salesTaxBps / 100).toFixed(2)}% sales tax ({dollars(m.taxEstimateCents)}).</td></tr>
    </tbody></table>
  );
}
