import React, { useCallback, useEffect, useState } from 'react';
import { api, dollars } from '../api.js';

// Etsy limits, shown live. Corroborated 2026-10-05, official page not read: see server/domain/etsy-rules.js.
const LIM = { title: 140, tags: 13, tag: 20 };
const Counter = ({ n, max, label }) => <span className={`counter ${n > max ? 'neg' : n === max ? 'warn' : 'muted'}`}>{n}/{max} {label}</span>;
const parseTags = (s) => s.split(',').map((t) => t.trim()).filter(Boolean);

export default function ProductDrawer({ id, onClose, onChanged }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [brief, setBrief] = useState('');
  const [copy, setCopy] = useState({ title: '', tags: '', description: '' });
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    try {
      const x = await api.product(id); setD(x); setBrief(x.product.brief);
      if (x.copy) setCopy({ title: x.copy.title || '', tags: (x.copy.tags || []).join(', '), description: x.copy.description || '' });
    } catch (e) { setErr(e.message); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  async function run(name, fn) {
    setBusy(name); setErr(''); setNote('');
    try { const out = await fn(); await load(); onChanged(); return out; }
    catch (e) { setErr(e.message); await load(); onChanged(); }
    finally { setBusy(''); }
  }

  if (!d) return <aside className="drawer wide">{err ? <div className="banner error">{err}</div> : 'loading...'}<button className="ghost" onClick={onClose}>Close</button></aside>;
  const p = d.product; const latest = d.designs[0];
  const tags = parseTags(copy.tags);
  const canEdit = ['design_generated', 'mockup_ready', 'listing_drafted', 'PENDING_APPROVAL'].includes(p.stage);
  const canRegen = ['idea', 'design_generated', 'mockup_ready', 'listing_drafted', 'PENDING_APPROVAL', 'failed'].includes(p.stage);

  return (
    <aside className="drawer wide" aria-label={`Product ${p.id}`}>
      <div className="row between"><h3>#{p.id} {p.title || 'Untitled'}</h3><button className="ghost" onClick={onClose}>Close</button></div>
      <div className="muted small">{p.stage.replace(/_/g, ' ')} - cost {dollars(d.costTotalCents)}{p.model_used ? ` - ${p.model_used}` : ''}</div>
      {p.stage === 'failed' && <div className="banner error">{p.failed_reason}</div>}
      {err && <div className="banner error" role="alert">{err}</div>}
      {p.flags.map((f) => <span className="flag" key={f.code} title={f.detail}>{f.code}: {f.detail}</span>)}

      {latest && (
        <section>
          <img className="preview" src={latest.url} alt="Latest generated design" />
          <div className="small">
            {latest.width}x{latest.height}px{latest.upscaleMethod ? ` - upscaled from ${latest.nativeWidth}x${latest.nativeHeight} (${latest.upscaleMethod})` : ''}
            {latest.upscaleMethod && <div className="warn">Upscaled images add pixels, not detail; check print quality before approving.</div>}
          </div>
        </section>
      )}

      <section>
        <h4>Brief</h4>
        <textarea rows={4} value={brief} maxLength={2000} onChange={(e) => setBrief(e.target.value)} disabled={!canRegen} />
        <div className="row">
          <button disabled={!canRegen || !brief.trim() || !!busy} onClick={() => run('design', () => api.generateDesign(id, brief))}>
            {busy === 'design' ? 'Generating...' : p.stage === 'idea' || p.stage === 'failed' ? 'Generate design' : 'Regenerate design'}
          </button>
          <span className="muted small">{d.designs.length} design{d.designs.length === 1 ? '' : 's'} kept</span>
        </div>
      </section>

      <section>
        <h4>Listing copy {d.copy ? <span className="muted small">({d.copy.model})</span> : null}</h4>
        {!d.copy && p.stage === 'design_generated' && <button disabled={!!busy} onClick={() => run('copy', () => api.draftCopy(id))}>{busy === 'copy' ? 'Drafting...' : 'Draft copy'}</button>}
        {(d.copy || canEdit) && d.copy && (
          <>
            <label>Title <Counter n={[...copy.title].length} max={LIM.title} label="chars" />
              <input value={copy.title} onChange={(e) => setCopy({ ...copy, title: e.target.value })} disabled={!canEdit} />
            </label>
            <label>Tags, comma separated <Counter n={tags.length} max={LIM.tags} label="tags" />
              <input value={copy.tags} onChange={(e) => setCopy({ ...copy, tags: e.target.value })} disabled={!canEdit} />
            </label>
            <div className="tags">{tags.map((t, i) => <span key={i} className={`tag ${[...t].length > LIM.tag ? 'bad' : ''}`}>{t} <small>{[...t].length}/{LIM.tag}</small></span>)}</div>
            <label>Description<textarea rows={7} value={copy.description} onChange={(e) => setCopy({ ...copy, description: e.target.value })} disabled={!canEdit} /></label>
            <div className="row">
              <button disabled={!canEdit || !!busy} onClick={() => run('save', async () => {
                const r = await api.saveCopy(id, { title: copy.title, tags, description: copy.description });
                setNote(r.repairs.length ? `Saved with ${r.repairs.length} repair(s) to meet Etsy's rules.` : 'Saved.');
              })}>{busy === 'save' ? 'Saving...' : 'Save copy'}</button>
              <button className="ghost" disabled={!canEdit || !!busy || p.stage !== 'design_generated'} onClick={() => run('copy', () => api.draftCopy(id))}>Re-draft with the model</button>
            </div>
            {note && <div className="small pos">{note}</div>}
            {d.copy.repairs.length > 0 && (
              <details><summary className="small">{d.copy.repairs.length} automatic repair(s) on the last save</summary>
                <ul className="small">{d.copy.repairs.map((r, i) => <li key={i}>{r.field}: {r.detail}</li>)}</ul></details>
            )}
          </>
        )}
      </section>

      <section>
        <h4>Costs</h4>
        {d.costs.length === 0 ? <div className="muted small">nothing spent (stub adapters cost $0)</div> : <ul className="small">{d.costs.map((c) => <li key={c.id}>{c.kind} {dollars(c.amountCents)} <span className="muted">{c.note}</span></li>)}</ul>}
        <h4>History</h4>
        <ul className="small">{d.events.map((e) => <li key={e.id}><span className="muted">{e.ts.slice(0, 16).replace('T', ' ')}</span> {e.stageTo ? `${e.stageFrom || '-'} -> ${e.stageTo}` : ''} {e.note}</li>)}</ul>
      </section>
    </aside>
  );
}
