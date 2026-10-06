import React, { useCallback, useEffect, useState } from 'react';
import { api, dollars } from '../api.js';

const STATUS = { ideating: 'Proposing concepts', running: 'Running', paused_cap: 'Paused: daily spend cap', done: 'Done', cancelled: 'Cancelled', failed: 'Failed' };
const STEP = { queued: 'queued', create: 'creating product', design: 'generating design', print_readiness_and_pod: 'print check + POD product', copy_and_margin: 'copy + margin', qa: 'QA review', submit: 'submitting', pending_approval: 'at PENDING_APPROVAL', published: 'published (autopublish)', handled_elsewhere: 'handled by a human' };
const live = (b) => ['ideating', 'running'].includes(b.status);

// Batch progress: per-item stage, cost and model; cancel / resume. Polls while anything is moving.
export default function BatchesView({ focusId, onOpenProduct, onChanged }) {
  const [list, setList] = useState(null); const [sel, setSel] = useState(focusId || null); const [d, setD] = useState(null); const [err, setErr] = useState('');
  const loadList = useCallback(() => api.batches().then((r) => { setList(r.batches); setErr(''); }).catch((e) => setErr(e.message)), []);
  const loadOne = useCallback((id) => (id ? api.batch(id).then((r) => setD(r.batch)).catch((e) => setErr(e.message)) : Promise.resolve()), []);
  useEffect(() => { loadList(); }, [loadList]);
  useEffect(() => { if (!sel && list && list.length) setSel(list[0].id); }, [list, sel]);
  useEffect(() => { loadOne(sel); }, [sel, loadOne]);
  useEffect(() => {
    const active = (d && live(d)) || (list || []).some(live);
    if (!active) return undefined;
    const t = setInterval(() => { loadList(); loadOne(sel); if (onChanged) onChanged(); }, 3000);
    return () => clearInterval(t);
  }, [d, list, sel, loadList, loadOne, onChanged]);

  async function act(fn) { setErr(''); try { await fn(); await loadOne(sel); await loadList(); if (onChanged) onChanged(); } catch (e) { setErr(e.message); } }
  if (!list) return <main className="board">{err ? <div className="banner error">{err}</div> : 'loading...'}</main>;
  return (
    <main className="board" style={{ display: 'block' }}>
      <h3>Batches</h3>
      {err && <div className="banner error" role="alert">{err}</div>}
      {list.length === 0 && <div className="muted">No batches yet. Use "Run batch".</div>}
      <div className="row" style={{ flexWrap: 'wrap' }}>{list.map((b) => <button key={b.id} className={`ghost ${sel === b.id ? 'active' : ''}`} onClick={() => setSel(b.id)}>#{b.id} {b.niche.slice(0, 24)} - {STATUS[b.status] || b.status}</button>)}</div>
      {d && (
        <section>
          <h4>#{d.id} {d.niche} <span className="muted small">{STATUS[d.status] || d.status}</span></h4>
          <div className="small muted">
            {d.requestedCount} requested, {d.items.length} concept(s) ({d.ideation.source || 'pending'}{d.ideation.model ? `, ${d.ideation.model}` : ''}; dropped {d.ideation.droppedBlocklist} for blocklist, {d.ideation.droppedDuplicate} as duplicates) - spend {dollars(d.costCents)} - {d.counts.atPendingApproval || 0} at PENDING_APPROVAL
          </div>
          {d.statusDetail && <div className={`small ${d.status === 'paused_cap' || d.status === 'failed' ? 'warn' : 'muted'}`}>{d.statusDetail}</div>}
          <div className="row">
            {['ideating', 'running', 'paused_cap'].includes(d.status) && <button className="danger" onClick={() => act(() => api.cancelBatch(d.id))}>Cancel</button>}
            {d.status === 'paused_cap' && <button onClick={() => act(() => api.resumeBatch(d.id))}>Resume</button>}
          </div>
          <div className="scroll-x"><table className="econ"><thead><tr><th>#</th><th>Concept</th><th>Item</th><th>Stage</th><th>Flags</th><th>Cost</th><th>Models</th><th /></tr></thead>
            <tbody>{d.items.map((i) => (
              <tr key={i.id}>
                <td>{i.idx}</td><td style={{ maxWidth: '22rem' }}>{i.concept}</td>
                <td className={i.status === 'failed' ? 'neg' : i.status === 'done' ? 'pos' : ''}>{i.status}{i.step ? ` (${STEP[i.step] || i.step})` : ''}{i.error ? <div className="small neg">{i.error}</div> : null}</td>
                <td>{i.stage ? i.stage.replace(/_/g, ' ') : '-'}</td>
                <td>{i.flags.map((f) => <span className="flag" key={f.code} title={f.detail}>{f.code}</span>)}</td>
                <td>{dollars(i.costCents)}</td>
                <td className="small muted">{['concept', 'image', 'copy', 'qa'].filter((k) => i.models[k]).map((k) => `${k}: ${i.models[k]}`).join(', ')}</td>
                <td>{i.productId && <button className="ghost" onClick={() => onOpenProduct(i.productId)}>Open</button>}</td>
              </tr>))}</tbody></table></div>
        </section>)}
    </main>
  );
}
