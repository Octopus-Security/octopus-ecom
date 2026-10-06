import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';

const PAGE = 60;

// Settings -> Blocklist: the trademark/IP terms every brief, title, tag and description is checked against.
// A hit FLAGS a product (blocks autopublish, listed at approval). It is a text match only: see ARCHITECTURE.md for its limits.
export default function BlocklistPanel() {
  const [d, setD] = useState(null); const [err, setErr] = useState(''); const [msg, setMsg] = useState('');
  const [q, setQ] = useState(''); const [kind, setKind] = useState(''); const [page, setPage] = useState(0);
  const [term, setTerm] = useState(''); const [addKind, setAddKind] = useState('custom');
  const [bulk, setBulk] = useState(''); const [probe, setProbe] = useState(''); const [probeOut, setProbeOut] = useState('');

  const load = useCallback(() => api.blocklist().then((x) => { setD(x); setErr(''); }).catch((e) => setErr(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const shown = useMemo(() => (d ? d.terms.filter((t) => (!kind || t.kind === kind) && (!q || t.term.includes(q.toLowerCase()))) : []), [d, q, kind]);
  useEffect(() => { setPage(0); }, [q, kind]);
  const rescanNote = (r) => (r && (r.flagged || r.cleared) ? ` Re-scan: ${r.flagged} product(s) newly flagged, ${r.cleared} cleared.` : '');

  async function add() {
    setErr(''); setMsg('');
    try { const r = await api.blocklistAdd(term, addKind); setMsg(`${r.added ? 'Added' : 'Already listed'}: ${r.term}.${rescanNote(r.rescan)}`); setTerm(''); await load(); } catch (e) { setErr(e.message); }
  }
  async function remove(t) {
    setErr(''); setMsg('');
    try { const r = await api.blocklistRemove(t); setMsg(`Removed: ${r.removed}.${rescanNote(r.rescan)}`); await load(); } catch (e) { setErr(e.message); }
  }
  async function importList() {
    setErr(''); setMsg('');
    try {
      const r = await api.blocklistImport(bulk, addKind);
      setMsg(`Imported: ${r.added} added, ${r.duplicates} already listed${r.invalid.length ? `, ${r.invalid.length} invalid (${r.invalid.slice(0, 3).map((x) => `"${x.line}": ${x.reason}`).join('; ')})` : ''}.${rescanNote(r.rescan)}`);
      setBulk(''); await load();
    } catch (e) { setErr(e.message); }
  }
  async function check() { try { const r = await api.blocklistCheck(probe); setProbeOut(r.hits.length ? `Would flag: ${r.summary}` : 'No match.'); } catch (e) { setErr(e.message); } }

  if (!d) return <div className="muted small">{err || 'loading...'}</div>;
  const pages = Math.max(1, Math.ceil(shown.length / PAGE));
  return (
    <div className="cred">
      <div className="muted small">{d.total} terms. A hit flags a product and blocks autopublish; it never rewrites your text. It matches words only (not logos or likenesses) and is not legal advice.</div>
      {err && <div className="banner error" role="alert">{err}</div>}
      {msg && <div className="small pos" role="status">{msg}</div>}
      <div className="row">
        <input placeholder="add a term, e.g. acme rocket" value={term} onChange={(e) => setTerm(e.target.value)} aria-label="New blocklist term" />
        <select value={addKind} onChange={(e) => setAddKind(e.target.value)} aria-label="Kind">{d.kinds.map((k) => <option key={k}>{k}</option>)}</select>
        <button disabled={!term.trim()} onClick={add}>Add</button>
      </div>
      <label>Import (one term per line; optional "term | kind"; # for comments)
        <textarea rows={3} value={bulk} onChange={(e) => setBulk(e.target.value)} placeholder={'acme rocket\nsome band | celebrity'} />
      </label>
      <div className="row"><button className="ghost" disabled={!bulk.trim()} onClick={importList}>Import list</button></div>
      <div className="row">
        <input placeholder="try a text to see what would match" value={probe} onChange={(e) => setProbe(e.target.value)} aria-label="Test text" />
        <button className="ghost" disabled={!probe.trim()} onClick={check}>Test</button>
      </div>
      {probeOut && <div className="small">{probeOut}</div>}
      <div className="row">
        <input placeholder="filter the list" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter terms" />
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Filter by kind"><option value="">all kinds</option>{d.kinds.map((k) => <option key={k}>{k}</option>)}</select>
      </div>
      <div className="small muted">{shown.length} shown, page {page + 1} of {pages}</div>
      <ul className="small" style={{ listStyle: 'none', paddingLeft: 0 }}>
        {shown.slice(page * PAGE, page * PAGE + PAGE).map((t) => (
          <li key={t.term} className="row between"><span>{t.term} <span className="muted">({t.kind})</span></span><button className="ghost" onClick={() => remove(t.term)} aria-label={`Remove ${t.term}`}>Remove</button></li>))}
      </ul>
      <div className="row"><button className="ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>Prev</button><button className="ghost" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Next</button></div>
    </div>
  );
}
