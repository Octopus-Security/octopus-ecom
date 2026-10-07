import React, { useCallback, useEffect, useState } from 'react';
import { api, dollars } from '../api.js';

const STATUS = { pending: 'Pending', snoozed: 'Snoozed', approved: 'Approved', rejected: 'Rejected' };
const SEASON_LABEL = { open: 'open', tight: 'tight: list now', too_late: 'TOO LATE this year' };
const csv = (v) => (Array.isArray(v) ? v.join(', ') : v || '');

// One editable value: saves on blur (or Enter for a single line) when it changed. The server re-derives everything else.
function Field({ label, value, onSave, multiline = false, rows = 2, type = 'text', disabled = false, hint }) {
  const [draft, setDraft] = useState(value ?? '');
  useEffect(() => { setDraft(value ?? ''); }, [value]);
  const commit = () => { if (!disabled && String(draft) !== String(value ?? '')) onSave(draft); };
  const common = { value: draft, disabled, onChange: (e) => setDraft(e.target.value), onBlur: commit, 'aria-label': label };
  return (
    <label className="pfield">
      <span className="small muted">{label}{hint ? <span> ({hint})</span> : null}</span>
      {multiline ? <textarea rows={rows} {...common} /> : <input type={type} step={type === 'number' ? '0.01' : undefined} {...common} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />}
    </label>
  );
}

function Issues({ title, lint }) {
  if (!lint) return null;
  return (
    <div className="small">
      <strong>{title}</strong> {lint.ok ? <span className="pos">no errors</span> : <span className="neg">{lint.errors.length} error(s)</span>}
      {lint.errors.map((e, i) => <div key={`e${i}`} className="neg">{e.code}: {e.detail}</div>)}
      {lint.warnings.map((e, i) => <div key={`w${i}`} className="muted">{e.code}: {e.detail}</div>)}
    </div>
  );
}

function Card({ p, onChanged, onOpenProduct, askConfirm, setNote }) {
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const [rejecting, setRejecting] = useState(false); const [reason, setReason] = useState('');
  const [until, setUntil] = useState('');
  const open = p.status === 'pending' || p.status === 'snoozed';
  const w = p.seasonWindow;

  async function act(fn) { setBusy(true); setErr(''); try { await fn(); await onChanged(); } catch (e) { setErr(e.message); } setBusy(false); }
  const save = (field) => (val) => act(() => api.editProposal(p.id, { [field]: val }));

  async function approve() {
    setBusy(true); setErr('');
    try {
      const r = await api.approveProposal(p.id);
      if (r.needsConfirm) {
        askConfirm({ title: 'Approve this proposal?', summary: r.summary,
          run: async () => { const done = await api.approveProposal(p.id, { token: r.token }); setNote(done); await onChanged(); } });
      } else { setNote(r); await onChanged(); }
    } catch (e) { setErr(e.message); }
    setBusy(false);
  }

  return (
    <article className={`card pcard risk-${p.riskLevel}`} onClick={(e) => e.stopPropagation()} style={{ cursor: 'default' }}>
      <div className="row between" style={{ flexWrap: 'wrap' }}>
        <h4>#{p.id} {p.etsyTitle || p.concept}</h4>
        <div>
          <span className="flag">{STATUS[p.status]}{p.status === 'snoozed' && p.snoozeUntil ? ` until ${p.snoozeUntil}` : ''}</span>
          <span className="flag">{p.source === 'llm' ? `model: ${p.model || 'llm'}` : 'template (no model)'}</span>
          <span className={`flag ${p.riskLevel === 'blocked' ? 'flag-bad' : ''}`}>risk: {p.riskLevel}</span>
        </div>
      </div>

      {w ? <div className={`small ${w.tooLate ? 'neg' : w.status === 'tight' ? 'warn' : 'muted'}`}><strong>{w.name}</strong> {w.date}: {SEASON_LABEL[w.status]}. List by {w.listBy}; last realistic order date {w.lastOrder} ({w.daysToLastOrder} days).{w.tooLate && w.next ? ` Next chance: list by ${w.next.listBy} for ${w.next.date}.` : ''} <em>Lead times are assumed, unverified.</em></div>
        : <div className="small muted">Evergreen: no deadline.</div>}

      <div className="small muted">Why: {p.rationale}</div>
      <div className="small muted">Signals: {p.signals.length ? p.signals.map((s) => `${s.term} [${s.source}]`).join(', ') : 'none (evergreen or template)'}</div>

      <div className="pgrid">
        <Field label="Concept" value={p.concept} multiline onSave={save('concept')} disabled={!open || busy} />
        <Field label="Design brief" value={p.brief} multiline rows={3} onSave={save('brief')} disabled={!open || busy} />
        <Field label="Image prompt (paste into your image tool)" value={p.imagePrompt} multiline rows={4} onSave={save('imagePrompt')} disabled={!open || busy} hint={p.promptEdited ? 'edited by you' : 'derived from the brief'} />
        {p.promptEdited && open && <button className="ghost" disabled={busy} onClick={() => act(() => api.editProposal(p.id, { promptEdited: false }))}>Re-derive image prompt</button>}
        <label className="pfield"><span className="small muted">Product type</span>
          <select value={p.productType} disabled={!open || busy} onChange={(e) => act(() => api.editProposal(p.id, { productType: e.target.value }))}>
            {(p.productTypes || []).map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select></label>
        <Field label="Blueprint id" value={p.blueprint || ''} onSave={save('blueprint')} disabled={!open || busy} />
        <Field label="Print provider id" value={p.printProviderId || ''} onSave={save('printProviderId')} disabled={!open || busy} />
        <div className="small muted">{p.blueprintNote}</div>
        <Field label="Etsy title" value={p.etsyTitle} onSave={save('etsyTitle')} disabled={!open || busy} hint={`${p.etsyTitle.length}/140`} />
        <Field label="Etsy tags (comma separated)" value={csv(p.etsyTags)} multiline onSave={save('etsyTags')} disabled={!open || busy} hint={`${p.etsyTags.length}/13`} />
        <Field label="Etsy description" value={p.etsyDescription} multiline rows={3} onSave={save('etsyDescription')} disabled={!open || busy} />
        <Field label="Redbubble title" value={p.rbTitle} onSave={save('rbTitle')} disabled={!open || busy} hint={`${p.rbTitle.length}/60 assumed`} />
        <Field label="Redbubble tags" value={csv(p.rbTags)} multiline onSave={save('rbTags')} disabled={!open || busy} hint={`${p.rbTags.length}/15`} />
        <Field label="Redbubble description" value={p.rbDescription} multiline onSave={save('rbDescription')} disabled={!open || busy} />
        {p.rbEdited && open && <button className="ghost" disabled={busy} onClick={() => act(() => api.editProposal(p.id, { rbEdited: false }))}>Re-derive Redbubble copy from Etsy</button>}
        <Field label="Keywords" value={csv(p.keywords)} onSave={save('keywords')} disabled={!open || busy} />
        <Field label="Theme" value={p.theme} onSave={save('theme')} disabled={!open || busy} />
        <label className="pfield"><span className="small muted">Season</span>
          <select value={p.season || ''} disabled={!open || busy} onChange={(e) => act(() => api.editProposal(p.id, { season: e.target.value || null }))}>
            <option value="">evergreen (none)</option>
            {(p.seasons || []).map((s) => <option key={s.holiday} value={s.holiday}>{s.name} {s.date}</option>)}
          </select></label>
        <Field label="Price (USD)" type="number" value={p.priceCents === null ? '' : (p.priceCents / 100).toFixed(2)} onSave={save('price')} disabled={!open || busy} hint="estimate" />
      </div>

      <div className="small"><strong>ESTIMATE</strong> margin {dollars(p.marginCents)}{p.marginPct !== null && p.marginPct !== undefined ? ` (${p.marginPct}%)` : ''} on base cost {dollars(p.baseCostCents)} ({String(p.baseCostSource).replace(/_/g, ' ')}). {p.estimateNote}</div>
      <Issues title="Etsy lint" lint={p.lint && p.lint.etsy} />
      <Issues title="Redbubble lint" lint={p.lint && p.lint.redbubble} />
      <details className="small"><summary>Originality / IP risk: {p.riskLevel}{p.risk.reasons.length ? ` (${p.risk.reasons.length})` : ''}</summary>
        {p.risk.reasons.map((r, i) => <div key={i} className={p.riskLevel === 'blocked' ? 'neg' : 'warn'}>{r}</div>)}
        <div className="muted">Blocklist reads text only: it cannot see a logo or a likeness. "Clear" means nothing obvious, never cleared. Model self-check: {p.modelCheck ? (p.modelCheck.ran ? (p.modelCheck.passes ? 'passed' : `FAILED ${p.modelCheck.concerns}`) : p.modelCheck.concerns) : 'not run'}.</div>
        <div className="muted">Ready-to-paste originality check for any model:</div>
        <textarea readOnly rows={6} value={p.risk.selfCheckPrompt} aria-label="Originality self-check prompt" />
      </details>

      {p.status === 'rejected' && <div className="small muted">Rejected{p.rejectReason ? `: ${p.rejectReason}` : ' (no reason)'}</div>}
      {p.status === 'approved' && p.productId && <div><button className="ghost" onClick={() => onOpenProduct(p.productId)}>Open product #{p.productId}</button></div>}
      {err && <div className="banner error" role="alert">{err}</div>}

      {open && (
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button disabled={busy || p.riskLevel === 'blocked'} onClick={approve} title={p.riskLevel === 'blocked' ? 'Blocked: edit the flagged text first' : 'Create an IDEA-stage product from this (edits above are already saved)'}>Approve</button>
          <button className="ghost" disabled={busy} onClick={() => act(() => api.regenerateProposal(p.id))}>Regenerate</button>
          {!rejecting && <button className="ghost danger" disabled={busy} onClick={() => setRejecting(true)}>Reject...</button>}
          {rejecting && (
            <span className="row">
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why not? (optional; the next batch is told)" maxLength={500} aria-label="Reject reason" />
              <button className="danger" disabled={busy} onClick={() => act(async () => { await api.rejectProposal(p.id, reason); setRejecting(false); })}>Reject</button>
              <button className="ghost" onClick={() => setRejecting(false)}>Cancel</button>
            </span>)}
          <span className="row">
            <input type="date" value={until} onChange={(e) => setUntil(e.target.value)} aria-label="Snooze until" />
            <button className="ghost" disabled={busy || !until} onClick={() => act(() => api.snoozeProposal(p.id, until))}>Snooze</button>
            {p.status === 'snoozed' && <button className="ghost" disabled={busy} onClick={() => act(() => api.unsnoozeProposal(p.id))}>Wake now</button>}
          </span>
        </div>)}
    </article>
  );
}

// The Proposals tab: generate original product ideas from seeds and signals, review them, approve into the IDEA stage.
export default function ProposalsView({ onOpenProduct, onChanged, askConfirm }) {
  const [data, setData] = useState(null); const [cfg, setCfg] = useState(null); const [digest, setDigest] = useState(null);
  const [tab, setTab] = useState('pending'); const [err, setErr] = useState(''); const [note, setNote] = useState(null); const [runInfo, setRunInfo] = useState(null);
  const [gen, setGen] = useState({ count: '5', types: [], themes: '', occasions: '', audiences: '', live: false }); const [busy, setBusy] = useState(false);
  const [set, setSet] = useState(null);

  const load = useCallback(async () => {
    try {
      const [l, c, d] = await Promise.all([api.proposals(), api.proposalsConfig(), api.proposalsDigest()]);
      setData(l); setCfg(c); setDigest(d); setSet((cur) => cur || c.settings); setErr('');
    } catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const changed = useCallback(async () => { await load(); if (onChanged) onChanged(); }, [load, onChanged]);

  async function generate(e) {
    e.preventDefault(); setBusy(true); setErr(''); setRunInfo(null);
    try {
      const r = await api.generateProposals({ count: Number(gen.count), productTypes: gen.types, seeds: { themes: gen.themes, occasions: gen.occasions, audiences: gen.audiences }, liveSignals: gen.live });
      setRunInfo(r.run); setTab('pending'); await changed();
    } catch (e2) { setErr(e2.message); }
    setBusy(false);
  }
  async function runDigest() { setBusy(true); setErr(''); try { const r = await api.runProposalsDigest({}); setRunInfo(r.run); setTab('pending'); await changed(); } catch (e) { setErr(e.message); } setBusy(false); }
  async function saveSettings(patch) { try { const r = await api.saveProposalsSettings(patch); setSet(r.settings); await load(); } catch (e) { setErr(e.message); } }

  if (!data || !cfg) return <main className="board">{err ? <div className="banner error">{err}</div> : 'loading...'}</main>;
  const shown = data.proposals.filter((p) => p.status === tab).map((p) => ({ ...p, productTypes: cfg.productTypes, seasons: cfg.seasons }));
  const toggleType = (id) => setGen({ ...gen, types: gen.types.includes(id) ? gen.types.filter((t) => t !== id) : [...gen.types, id] });
  const s = set || cfg.settings;

  return (
    <main className="board" style={{ display: 'block' }}>
      <h3>Proposals</h3>
      <div className="muted small">Original product ideas made from your seeds, your watchlist and any trend signals, with the season window for each. Nothing is published from here: Approve only creates a pre-filled card in the IDEA stage. Price and margin are estimates. {cfg.llm && cfg.llm.stub ? 'No model is connected, so these are deterministic templates.' : `Model path: ${cfg.llm && cfg.llm.provider}.`} Today (ET): {cfg.today}.</div>
      {err && <div className="banner error" role="alert">{err}</div>}
      {note && note.product && <div className="banner warn-banner" role="status">Created product #{note.product.id} in the IDEA stage.{note.podError ? ` Print provider not set: ${note.podError}.` : ''}{note.copyError ? ` Copy not saved: ${note.copyError}.` : ''} <button className="ghost" onClick={() => onOpenProduct(note.product.id)}>Open</button> <button className="ghost" onClick={() => setNote(null)}>Dismiss</button></div>}

      <details open>
        <summary><strong>Generate proposals</strong></summary>
        <form onSubmit={generate} className="pgen">
          <label>How many (max {cfg.maxCount})<input type="number" min="1" max={cfg.maxCount} value={gen.count} onChange={(e) => setGen({ ...gen, count: e.target.value })} required /></label>
          <fieldset><legend className="small">Product types (none ticked = any)</legend>
            {cfg.productTypes.map((t) => <label key={t.id} className="check"><input type="checkbox" checked={gen.types.includes(t.id)} onChange={() => toggleType(t.id)} />{t.label}</label>)}</fieldset>
          <label>Theme seeds (comma separated; subjects, not brands)<input value={gen.themes} onChange={(e) => setGen({ ...gen, themes: e.target.value })} placeholder="fishing, houseplants, trail running" /></label>
          <label>Occasion seeds (holidays use their season window)<input value={gen.occasions} onChange={(e) => setGen({ ...gen, occasions: e.target.value })} placeholder="father's day, halloween" /></label>
          <label>Audience seeds<input value={gen.audiences} onChange={(e) => setGen({ ...gen, audiences: e.target.value })} placeholder="dad, teachers, new nurses" /></label>
          <label className="check"><input type="checkbox" checked={gen.live} onChange={(e) => setGen({ ...gen, live: e.target.checked })} />Ask the trend sources now (otherwise only their latest stored results are used)</label>
          <button type="submit" disabled={busy}>{busy ? 'Generating...' : 'Generate proposals'}</button>
        </form>
        {runInfo && <div className="small muted">Run #{runInfo.id}: {runInfo.produced} of {runInfo.requested} ({runInfo.source}{runInfo.model ? `, ${runInfo.model}` : ''}); dropped {runInfo.droppedBlocklist} blocked, {runInfo.droppedDuplicate} duplicate, {runInfo.droppedOther} unusable; cost {dollars(runInfo.costCents)}. {runInfo.notes.join(' ')}</div>}
      </details>

      <details>
        <summary><strong>Weekly digest</strong> {s.weeklyEnabled ? '(ON)' : '(OFF)'}</summary>
        <div className="small muted">{digest && digest.text} Generates a fresh batch from the seeds below on its own once a week while ON. It spends model tokens under the daily cap (or on your account through cortex). OFF by default.</div>
        <div className="pgen">
          <label className="check"><input type="checkbox" checked={!!s.weeklyEnabled} onChange={(e) => saveSettings({ weeklyEnabled: e.target.checked })} />Generate a batch every week</label>
          <label>Batch size<input type="number" min="1" max={cfg.maxCount} defaultValue={s.weeklyCount} onBlur={(e) => Number(e.target.value) !== s.weeklyCount && saveSettings({ weeklyCount: Number(e.target.value) })} /></label>
          <label>Weekly theme seeds<input defaultValue={csv(s.weeklySeeds && s.weeklySeeds.themes)} onBlur={(e) => saveSettings({ weeklySeeds: { ...s.weeklySeeds, themes: e.target.value } })} /></label>
          <label>Weekly audience seeds<input defaultValue={csv(s.weeklySeeds && s.weeklySeeds.audiences)} onBlur={(e) => saveSettings({ weeklySeeds: { ...s.weeklySeeds, audiences: e.target.value } })} /></label>
          <fieldset><legend className="small">Lead times in days ({cfg.leadTimeStatus})</legend>
            {['productionDays', 'shippingDays', 'bufferDays', 'rampDays'].map((k) => (
              <label key={k} className="check">{k.replace('Days', '')}<input type="number" min="0" style={{ width: '4rem' }} defaultValue={s.leadTime[k]} onBlur={(e) => Number(e.target.value) !== s.leadTime[k] && saveSettings({ leadTime: { ...s.leadTime, [k]: Number(e.target.value) } })} /></label>))}
          </fieldset>
          <button className="ghost" disabled={busy} onClick={runDigest}>Run the digest now</button>
        </div>
      </details>

      <nav className="views" aria-label="Proposal status">
        {Object.keys(STATUS).map((k) => <button key={k} className={`ghost ${tab === k ? 'active' : ''}`} aria-pressed={tab === k} onClick={() => setTab(k)}>{STATUS[k]} ({data.counts[k] || 0})</button>)}
      </nav>
      {shown.length === 0 && <div className="muted">Nothing {tab} here{tab === 'pending' ? '. Use "Generate proposals".' : '.'}</div>}
      <div className="pcards">{shown.map((p) => <Card key={p.id} p={p} onChanged={changed} onOpenProduct={onOpenProduct} askConfirm={askConfirm} setNote={setNote} />)}</div>
    </main>
  );
}
