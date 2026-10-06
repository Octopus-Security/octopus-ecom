import React, { useCallback, useEffect, useState } from 'react';
import './watch.css';

// Watchlist editor + watcher run history. Your own keywords and notes only: nothing here fetches market data.
export default function WatchPanel({ api }) {
  const [entries, setEntries] = useState([]);
  const [runs, setRuns] = useState({ runs: [], trendSource: '' });
  const [form, setForm] = useState({ term: '', kind: 'keyword', notes: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { const [w, r] = await Promise.all([api.watchlist(), api.runs()]); setEntries(w.entries); setRuns(r); setError(''); } catch (e) { setError(e.message); }
  }, [api]);
  useEffect(() => { load(); }, [load]);
  const act = async (fn) => { setBusy(true); try { await fn(); await load(); } catch (e) { setError(e.message); } finally { setBusy(false); } };

  return (
    <section className="watch-panel">
      <h2>Watchlist</h2>
      <p className="muted small">Niches and keywords you want to keep an eye on. Source: {runs.trendSource || 'manual'}. Competitor listings, images and shop data are never fetched or stored.</p>
      {error && <div className="banner error" role="alert">{error}</div>}
      <form className="form" onSubmit={e => { e.preventDefault(); act(async () => { await api.addWatch(form); setForm({ term: '', kind: form.kind, notes: '' }); }); }}>
        <input placeholder="keyword or theme" value={form.term} onChange={e => setForm({ ...form, term: e.target.value })} aria-label="term" />
        <select value={form.kind} onChange={e => setForm({ ...form, kind: e.target.value })} aria-label="kind"><option value="keyword">keyword</option><option value="theme">theme</option></select>
        <input placeholder="notes (optional)" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} aria-label="notes" />
        <button disabled={busy || !form.term.trim()}>Add</button>
      </form>
      {entries.length === 0 ? <div className="empty">Nothing on the watchlist yet.</div> : (
        <table>
          <thead><tr><th>Term</th><th>Kind</th><th>Notes</th><th></th></tr></thead>
          <tbody>
            {entries.map(e => (
              <tr key={e.id} style={{ opacity: e.active ? 1 : 0.55 }}>
                <td>{e.term}</td><td>{e.kind}</td>
                <td><input defaultValue={e.notes} aria-label={`notes for ${e.term}`} onBlur={ev => ev.target.value !== e.notes && act(() => api.updateWatch(e.id, { notes: ev.target.value }))} /></td>
                <td className="row">
                  <button className="ghost" onClick={() => act(() => api.updateWatch(e.id, { active: !e.active }))}>{e.active ? 'Pause' : 'Resume'}</button>
                  <button className="ghost" onClick={() => act(() => api.deleteWatch(e.id))}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="row between"><h2>Watcher runs</h2><button className="ghost" disabled={busy || runs.running} onClick={() => act(() => api.runNow())}>Run now</button></div>
      {runs.runs.length === 0 ? <div className="empty">No runs yet.</div> : (
        <table>
          <thead><tr><th>When</th><th>Watcher</th><th>Result</th></tr></thead>
          <tbody>
            {runs.runs.slice(0, 20).map(r => (
              <tr key={r.id}>
                <td>{new Date(r.startedAt).toLocaleString()}<div className="muted small">{r.trigger}</div></td>
                <td>{r.watcher}</td>
                <td className={r.status === 'error' ? 'neg' : ''}>{r.status === 'error' ? `error: ${r.error}` : r.summary || r.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
