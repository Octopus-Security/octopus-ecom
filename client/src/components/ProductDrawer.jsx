import React, { useCallback, useEffect, useState } from 'react';
import { api, dollars } from '../api.js';
import FeeBreakdown from './FeeBreakdown.jsx';

// Etsy limits, shown live. Corroborated 2026-10-05, official page not read: see server/domain/etsy-rules.js.
const LIM = { title: 140, tags: 13, tag: 20 };
const Counter = ({ n, max, label }) => <span className={`counter ${n > max ? 'neg' : n === max ? 'warn' : 'muted'}`}>{n}/{max} {label}</span>;
const parseTags = (s) => s.split(',').map((t) => t.trim()).filter(Boolean);

export default function ProductDrawer({ id, onClose, onChanged, askConfirm }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [brief, setBrief] = useState('');
  const [copy, setCopy] = useState({ title: '', tags: '', description: '' });
  const [note, setNote] = useState('');
  const [price, setPrice] = useState('');
  const [blockers, setBlockers] = useState([]);
  const [edit, setEdit] = useState({ title: '', tags: '', price: '' });
  const [manual, setManual] = useState(null);

  const load = useCallback(async () => {
    try {
      const x = await api.product(id); setD(x); setBrief(x.product.brief); setPrice(x.product.list_price_cents === null ? '' : (x.product.list_price_cents / 100).toFixed(2));
      setEdit({ title: x.copy ? x.copy.title || '' : '', tags: x.copy ? (x.copy.tags || []).join(', ') : '', price: x.product.list_price_cents === null ? '' : (x.product.list_price_cents / 100).toFixed(2) });
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

  async function approve() {
    setErr('');
    try {
      const gate = await api.approve(id);
      if (!gate.needsConfirm) { await load(); onChanged(); return; }
      askConfirm({ title: 'Approve for publishing?', summary: gate.summary, danger: (d.product.flags || []).length > 0,
        run: async () => { await api.approve(id, gate.token); await load(); onChanged(); } });
    } catch (e) { setErr(e.message); }
  }
  async function publish() {
    setErr(''); setBlockers([]);
    try {
      const gate = await api.publish(id);
      askConfirm({ title: gate.summary && /SIMULATED/.test(gate.summary) ? 'Simulate publishing?' : 'Publish to Etsy?', summary: gate.summary, danger: !/SIMULATED/.test(gate.summary),
        run: async () => { const r = await api.publish(id, gate.token); setNote(r.faked ? 'Simulated (DRY_RUN): nothing was published and the stage did not change.' : 'Published through Printify.'); await load(); onChanged(); } });
    } catch (e) { setErr(e.message); setBlockers((e.data && e.data.blockers) || []); }
  }
  async function saveEdit() {
    setErr(''); setNote('');
    const body = {}; const l = d.copy || {};
    if (edit.title && edit.title !== (l.title || '')) body.title = edit.title;
    if (parseTags(edit.tags).join(',') !== (l.tags || []).join(',')) body.tags = parseTags(edit.tags);
    if (edit.price !== '' && Math.round(Number(edit.price) * 100) !== d.product.list_price_cents) body.price = edit.price;
    if (!Object.keys(body).length) { setNote('Nothing changed.'); return; }
    try {
      const gate = await api.editListing(id, body);
      const done = (r) => { setNote(r.faked ? 'Simulated (DRY_RUN): nothing was sent.' : 'Etsy listing updated.'); return load().then(onChanged); };
      if (gate.needsConfirm) askConfirm({ title: 'Change the live price?', summary: gate.summary, danger: true, run: async () => done(await api.editListing(id, { ...body, token: gate.token })) });
      else await done(gate);
    } catch (e) { setErr(e.message); }
  }
  const ask = (title, summary, fn) => askConfirm({ title, summary, danger: true, run: async () => { await fn(); await load(); onChanged(); } });

  if (!d) return <aside className="drawer wide">{err ? <div className="banner error">{err}</div> : 'loading...'}<button className="ghost" onClick={onClose}>Close</button></aside>;
  const p = d.product; const latest = d.designs[0];
  const tags = parseTags(copy.tags);
  const eco = d.economics; const st = p.stage;
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

      {d.printReadiness && (
        <section>
          <h4>Print readiness <span className={d.printReadiness.ok ? 'pos small' : 'neg small'}>{d.printReadiness.ok ? 'ready' : 'NOT ready'}</span></h4>
          <div className="small muted">Rule: {d.printReadiness.fit} fit, at least {Math.round(d.printReadiness.minCoverage * 100)}% of the print area. Measured from the file's PNG header.</div>
          {d.printReadiness.positions.map((r) => (
            <div className={`small ${r.ok ? '' : 'neg'}`} key={r.position}>{r.position}{r.placed ? '' : ' (no design placed here)'}: design {r.design.width}x{r.design.height}px, needs {r.required.width}x{r.required.height}px, coverage {Math.round(r.coverage * 100)}%{r.dpi ? `, ${r.dpi} dpi` : ''}</div>))}
          {d.printReadiness.reason && <div className="small neg">{d.printReadiness.reason}</div>}
          {d.printReadiness.notes.map((n, i) => <div className="small muted" key={i}>{n}</div>)}
        </section>)}

      {d.mockups.length > 0 && (
        <section>
          <h4>Mockups</h4>
          <div className="gallery">{d.mockups.map((m) => <img key={m.id} src={m.url} alt={`Mockup ${m.placement || ''}`} loading="lazy" />)}</div>
          {p.pod_external_id && p.pod_external_id.startsWith('stub-') && <div className="muted small">Placeholder mockups: DRY_RUN faked the print-provider product.</div>}
        </section>
      )}

      <section>
        <h4>Print provider and economics</h4>
        <div className="small muted">Blueprint {p.blueprint || '-'} / provider {p.print_provider_id || '-'} / {p.pod_variant_ids.length} variant(s){p.print_spec ? ` / print area ${p.print_spec.positions.map((a) => `${a.position} ${a.width}x${a.height}px`).join(', ')}` : ''}</div>
        {eco ? (<>
          <FeeBreakdown m={eco} floorCents={eco.floorCents} costLabel={`POD base cost (${eco.costSource === 'estimate' ? 'estimate' : eco.costSource})`} />
          {eco.stored && eco.stored.scheduleVersion !== eco.scheduleVersion && <div className="muted small">The margin saved on this product ({dollars(eco.stored.marginCents)}) was projected under fee schedule v{eco.stored.scheduleVersion}; the table above uses v{eco.scheduleVersion}. It is refreshed on the next price or cost change.</div>}
        </>) : <div className="muted small">No base cost yet: create the print-provider product.</div>}
        <div className="muted small">The base cost is charged per unit when one sells, so it is not part of "cost" above.</div>
        {['idea', 'design_generated', 'mockup_ready', 'listing_drafted', 'PENDING_APPROVAL'].includes(st) && (
          <div className="row"><label className="grow">List price (USD)<input type="number" min="0" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} /></label>
            <button disabled={!!busy || price === ''} onClick={() => run('price', () => api.setPrice(id, { listPrice: price }))}>Set price</button></div>)}
        <div className="row">
          {(st === 'design_generated' || st === 'failed') && latest && p.blueprint && <button disabled={!!busy} onClick={() => run('pod', () => api.createPod(id))}>{busy === 'pod' ? 'Creating...' : 'Create POD product + mockups'}</button>}
          {st === 'mockup_ready' && <button disabled={!!busy} onClick={() => run('draft', () => api.draftListing(id))}>{busy === 'draft' ? 'Drafting...' : 'Draft listing + margin'}</button>}
          {['mockup_ready', 'listing_drafted', 'PENDING_APPROVAL'].includes(st) && p.pod_external_id && !p.pod_external_id.startsWith('stub-') && <button className="ghost" disabled={!!busy} onClick={() => run('mock', () => api.refreshMockups(id))}>Refresh mockups</button>}
          {st === 'listing_drafted' && <button disabled={!!busy} onClick={() => run('submit', () => api.submit(id))}>Submit for approval</button>}
          {st === 'PENDING_APPROVAL' && <button className={p.flags.length ? 'danger' : ''} disabled={!!busy} onClick={approve}>Approve...</button>}
          {['mockup_ready', 'listing_drafted', 'PENDING_APPROVAL', 'approved', 'design_generated'].includes(st) && <button className="ghost" disabled={!!busy} onClick={() => ask('Reject this product?', `Reject product #${p.id}. It leaves the pipeline; it can only be archived afterwards.`, () => api.reject(id))}>Reject...</button>}
          {!['archived', 'published', 'live'].includes(st) && <button className="ghost" disabled={!!busy} onClick={() => ask('Archive this product?', `Archive product #${p.id}. Archived products cannot be moved again.`, () => api.archive(id))}>Archive...</button>}
        </div>
      </section>

      <section>
        <h4>Brief</h4>
        <textarea rows={4} value={brief} maxLength={2000} onChange={(e) => setBrief(e.target.value)} disabled={!canRegen} />
        <div className="row">
          <button disabled={!canRegen || !brief.trim() || !!busy} onClick={() => run('design', () => api.generateDesign(id, brief))}>
            {busy === 'design' ? 'Generating...' : p.stage === 'idea' || p.stage === 'failed' ? 'Generate design' : 'Regenerate design'}
          </button>
          <span className="muted small">{d.designs.length} design{d.designs.length === 1 ? '' : 's'} kept</span>
        </div>
        <h4>Bring your own design</h4>
        <div className="muted small">No image credits? Copy the prompt, make the image in another tool, then upload the PNG. It goes through the same print-readiness check; cost is $0 and it is recorded as a manual design.</div>
        <div className="row">
          <button className="ghost" disabled={!!busy} onClick={async () => { try { const r = await api.designPrompt(id); setManual(r); setNote(''); } catch (e) { setErr(e.message); } }}>Show prompt</button>
          <label className="ghost">Upload design (PNG)
            <input type="file" accept="image/png" disabled={!canRegen || !!busy} style={{ display: 'none' }}
              onChange={(e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) run('upload', () => api.uploadDesign(id, f)); }} />
          </label>
        </div>
        {manual && (<>
          <textarea readOnly rows={7} value={manual.text} onFocus={(e) => e.target.select()} />
          <div className="row"><button onClick={() => { try { navigator.clipboard.writeText(manual.text); setNote('Prompt copied.'); } catch { setNote('Select the text and copy it.'); } }}>Copy prompt</button>
            <span className="muted small">Target {manual.width}x{manual.height}px, aspect {manual.aspect}</span></div>
        </>)}
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

      {st === 'approved' && (
        <section>
          <h4>Publish</h4>
          <div className="muted small">{d.publish && d.publish.dryRun ? 'DRY_RUN is on: publishing is only simulated.' : 'Sends the product through Printify to the real Etsy shop. A confirmation shows the shop, price and listing fee first.'}</div>
          {d.publish && d.publish.blockers.length > 0 && <ul className="small warn">{d.publish.blockers.map((b) => <li key={b.code}>{b.message}</li>)}</ul>}
          {blockers.length > 0 && <ul className="small neg">{blockers.map((b) => <li key={b.code}>{b.message}</li>)}</ul>}
          <div className="row"><button className="danger" disabled={!!busy} onClick={publish}>Publish...</button></div>
        </section>)}

      {(st === 'published' || st === 'live') && (
        <section>
          <h4>Etsy listing</h4>
          {d.published && d.published.url ? <div><a href={d.published.url} target="_blank" rel="noreferrer">{d.published.url}</a> <span className="muted small">({d.published.status}{d.published.views !== null && d.published.views !== undefined ? `, ${d.published.views} views` : ''})</span></div>
            : <div className="muted small">{st === 'published' ? 'Printify is still publishing; Etsy has not shown the listing yet.' : 'No listing link yet.'}</div>}
          <div className="row"><button className="ghost" disabled={!!busy} onClick={() => run('status', () => api.refreshStatus(id))}>{busy === 'status' ? 'Checking...' : 'Refresh status'}</button></div>
          {d.published && d.published.externalId && (
            <>
              <h4>Edit the live listing</h4>
              <label>Title <Counter n={[...edit.title].length} max={LIM.title} label="chars" /><input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></label>
              <label>Tags <Counter n={parseTags(edit.tags).length} max={LIM.tags} label="tags" /><input value={edit.tags} onChange={(e) => setEdit({ ...edit, tags: e.target.value })} /></label>
              <label>Price (USD)<input type="number" min="0" step="0.01" value={edit.price} onChange={(e) => setEdit({ ...edit, price: e.target.value })} /></label>
              <div className="row"><button disabled={!!busy} onClick={saveEdit}>Save to Etsy</button><span className="muted small">A price change asks for confirmation. Etsy rules are enforced on the server.</span></div>
              {note && <div className="small pos">{note}</div>}
            </>)}
        </section>)}

      <section>
        <h4>Costs</h4>
        {d.costs.length === 0 ? <div className="muted small">nothing spent (stub adapters cost $0)</div> : <ul className="small">{d.costs.map((c) => <li key={c.id}>{c.kind} {dollars(c.amountCents)} <span className="muted">{c.note}</span></li>)}</ul>}
        <h4>History</h4>
        <ul className="small">{d.events.map((e) => <li key={e.id}><span className="muted">{e.ts.slice(0, 16).replace('T', ' ')}</span> {e.stageTo ? `${e.stageFrom || '-'} -> ${e.stageTo}` : ''} {e.note}</li>)}</ul>
      </section>
    </aside>
  );
}
