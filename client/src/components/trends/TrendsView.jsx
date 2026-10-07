import React, { useCallback, useEffect, useState } from 'react';
import './trends.css';

const TYPE_LABEL = { tee: 'T-shirt', mug: 'Mug', sticker: 'Sticker', wall_art: 'Wall art' };
const STATUS_LABEL = { ok: 'ok', disabled: 'disabled', no_data: 'no data', error: 'error' };
const money = (c) => (c === null || c === undefined ? 'n/a' : `$${(c / 100).toFixed(2)}`);
const when = (iso) => (iso ? new Date(iso).toLocaleString() : 'never');

function Bars({ parts, detail }) {
  return (
    <div className="bars" aria-label="D R S C P">
      {['D', 'R', 'S', 'C', 'P'].map(k => {
        const neutral = detail && detail[k] && detail[k].neutral;
        return (
          <div key={k} className={`bar ${neutral ? '' : 'real'}`} style={{ height: `${Math.round((parts[k] || 0) * 100)}%` }}
            title={`${k} ${parts[k]}${neutral ? ' (neutral default: no data)' : ''}`}><span>{k}</span></div>
        );
      })}
    </div>
  );
}

function why(i) {
  const d = i.detail || {}; const bits = [];
  if (d.D && !d.D.neutral) bits.push(`${Math.round(d.D.value)} ${d.D.unit} (${d.D.source})`);
  if (d.R && d.R.rise !== null && d.R.rise !== undefined) bits.push(`${d.R.rise >= 0 ? '+' : ''}${d.R.rise.toFixed(1)} doublings/wk`);
  if (d.R && d.R.manual) bits.push(`manual: ${d.R.manual}`);
  if (d.S && d.S.event) bits.push(`${d.S.event} in ${d.S.weeksToPeak} wk, last order ${d.S.lastOrderBy}`);
  if (d.C && !d.C.neutral) bits.push(`${Math.round(d.C.listings).toLocaleString()} listings (${d.C.source})`);
  if (d.C && d.C.badge) bits.push(d.C.badge);
  if (d.P && !d.P.neutral) bits.push(`median ${money(d.P.medianCents)} vs floor ${money(d.P.floorCents)}`);
  return bits.join(' | ');
}

export default function TrendsView({ api }) {
  const [report, setReport] = useState(null);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [proposals, setProposals] = useState(false);
  const [info, setInfo] = useState('');

  const load = useCallback(async () => {
    try { const [r, s] = await Promise.all([api.report(), api.status()]); setReport(r); setStatus(s); setError(''); } catch (e) { setError(e.message); }
  }, [api]);
  useEffect(() => { load(); api.proposalsAvailable().then(setProposals); }, [load, api]);
  const act = async (fn) => { setBusy(true); setInfo(''); try { await fn(); await load(); } catch (e) { setError(e.message); } finally { setBusy(false); } };

  if (!report) return <section className="trends">{error ? <div className="banner error" role="alert">{error}</div> : <div className="empty">Loading...</div>}</section>;

  return (
    <section className="trends">
      <div className="row between">
        <h2>Weekly trend report{report.week ? ` (${report.week})` : ''}</h2>
        <div className="row">
          <button className="ghost" disabled={busy} onClick={() => act(() => api.rebuild(false))}>Recompute</button>
          <button disabled={busy} onClick={() => act(() => api.rebuild(true))}>Refresh data and rebuild</button>
          {proposals && <button className="ghost" disabled={busy || !report.top.length} onClick={() => act(async () => { const r = await api.generateProposals(report); setInfo(`Proposals created${r && r.proposals ? `: ${r.proposals.length}` : ''}. Open the Proposals tab to review them.`); })}>Generate proposals from this</button>}
        </div>
      </div>
      {error && <div className="banner error" role="alert">{error}</div>}
      {info && <div className="muted small">{info}</div>}
      <div className="note"><strong>Read this first.</strong> {report.caveat}</div>
      {report.empty && <div className="empty">{report.empty}</div>}

      <table aria-label="Source status">
        <thead><tr><th>Source</th><th>Status</th><th>Last run</th><th>Detail</th></tr></thead>
        <tbody>
          {report.sources.map(s => (
            <tr key={s.name}>
              <td>{s.label}<div className="tag">{s.label2}</div></td>
              <td><span className={`pill ${s.status}`}>{STATUS_LABEL[s.status] || s.status}</span></td>
              <td>{when(s.lastRunAt)}</td>
              <td className="muted small">{s.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Top opportunities</h2>
      {report.top.length === 0 ? <div className="empty">Nothing scored yet.</div> : (
        <table>
          <thead><tr><th>Theme / product</th><th>Score</th><th>D R S C P</th><th>Why</th></tr></thead>
          <tbody>
            {report.top.map(i => (
              <tr key={`${i.theme}|${i.productType}`}>
                <td>{i.theme}<div className="tag">{TYPE_LABEL[i.productType] || i.productType}</div></td>
                <td><span className="score">{Math.round(i.score)}</span><div className="tag"><span className={`dot ${i.confidenceLevel}`} title={`confidence ${i.confidence}`} />{i.confidenceLevel} confidence</div></td>
                <td style={{ paddingBottom: 20 }}><Bars parts={i.parts} detail={i.detail} /></td>
                <td className="muted small">{why(i)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Biggest risers</h2>
      {report.risers.length === 0 ? <div className="empty">No rising themes with enough data (low-volume topics are hidden).</div> : (
        <table><tbody>{report.risers.map(x => <tr key={x.theme}><td>{x.theme}</td><td>+{x.rise.toFixed(2)} doublings/week</td><td className="muted small">{x.views ? `${Math.round(x.views)} views/day` : ''}{x.seasonRatio && x.seasonRatio > 1.3 ? ' | seasonal ramp?' : ''}</td></tr>)}</tbody></table>
      )}

      <h2>Seasonal windows</h2>
      {report.seasonal.open.length === 0 && report.seasonal.late.length === 0 ? <div className="empty">No listing window is open right now.</div> : (
        <table>
          <thead><tr><th>Event</th><th>Product</th><th>List between</th><th>Last order by</th><th>Our designs</th></tr></thead>
          <tbody>
            {[...report.seasonal.open, ...report.seasonal.late].map(w => (
              <tr key={`${w.eventId}|${w.productType}`}>
                <td>{w.event}<div className="tag">peak {w.peak}</div></td>
                <td>{TYPE_LABEL[w.productType]}</td>
                <td>{w.listFrom} to {w.listUntil}{w.state === 'closing_soon' && <span className="pill error" style={{ marginLeft: 6 }}>closing soon ({w.daysToClose} d)</span>}{w.state === 'late' && <span className="pill disabled" style={{ marginLeft: 6 }}>window closed</span>}</td>
                <td><strong>{w.lastOrderBy}</strong><div className="tag">estimate</div></td>
                <td>{w.ourDesigns}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Gaps: high score, nothing in our catalogue</h2>
      {report.gaps.length === 0 ? <div className="empty">None (threshold {report.gapThreshold}).</div> : (
        <table><tbody>{report.gaps.map(g => <tr key={`${g.theme}|${g.productType}`}><td>{g.theme}</td><td>{TYPE_LABEL[g.productType]}</td><td>{Math.round(g.score)}</td><td className="tag">{g.confidenceLevel} confidence</td></tr>)}</tbody></table>
      )}

      <h2>Our launches against the score they had</h2>
      {report.launches.length === 0 ? <div className="empty">{report.launchesNote}</div> : (
        <table>
          <thead><tr><th>Product</th><th>Theme</th><th>Score at launch</th><th>Days live</th><th>Views</th><th>Sales</th><th>Net</th></tr></thead>
          <tbody>{report.launches.map(l => <tr key={l.productId}><td>{l.title || `Product ${l.productId}`}</td><td>{l.theme}</td><td>{Math.round(l.scoreAtLaunch)}</td><td>{l.daysLive}</td><td>{l.views}</td><td>{l.sales}</td><td>{money(l.netCents)}</td></tr>)}</tbody>
        </table>
      )}

      {report.blocklisted.length > 0 && (<>
        <h2>Removed by the blocklist</h2>
        <div className="muted small">{report.blocklisted.map(b => `${b.theme} (${b.terms.join(', ')})`).filter((v, i, a) => a.indexOf(v) === i).join('; ')} score 0 and are never proposed.</div>
      </>)}

      <Inputs api={api} status={status} onChanged={load} act={act} busy={busy} />
    </section>
  );
}

function Inputs({ api, status, onChanged, act, busy }) {
  const s = status && status.settings;
  const [contact, setContact] = useState('');
  const [articles, setArticles] = useState([]);
  const [csv, setCsv] = useState(''); const [tool, setTool] = useState('other'); const [preview, setPreview] = useState(null);
  const [entries, setEntries] = useState([]);
  const [form, setForm] = useState({ source: 'pinterest-trends', term: '', direction: 'rising', note: '' });
  const [msg, setMsg] = useState('');
  const refresh = useCallback(async () => { try { const [a, m] = await Promise.all([api.articles(), api.manual()]); setArticles(a.articles); setEntries(m.entries); } catch (e) { setMsg(e.message); } }, [api]);
  useEffect(() => { refresh(); }, [refresh]);
  if (!s) return null;

  const enableEtsy = () => act(async () => {
    const gate = await api.etsyEnable();
    if (gate.needsConfirm) {
      if (!window.confirm(`${gate.summary}\n\nTurn on the Etsy market source?`)) return;
      await api.etsyEnable(gate.token);
    }
  });

  return (
    <details>
      <summary>Sources and inputs</summary>
      <div style={{ display: 'grid', gap: 14, paddingTop: 10 }}>
        {msg && <div className="banner error" role="alert">{msg}</div>}
        <div className="form">
          <strong>Etsy market (aggregates only):</strong>
          <span className="muted small">{s.etsyMarketEnabled ? 'on' : 'off (default)'}{s.etsyMarketBlocked ? `, refused by Etsy ${s.etsyMarketBlocked}` : ''}</span>
          {s.etsyMarketEnabled ? <button className="ghost" disabled={busy} onClick={() => act(() => api.etsyDisable())}>Turn off</button> : <button className="ghost" disabled={busy} onClick={enableEtsy}>Turn on...</button>}
        </div>
        <div className="form">
          <strong>Weekly run (Mondays 07:00 ET):</strong>
          <span className="muted small">{s.weeklyEnabled ? 'on' : 'off (default)'}</span>
          <button className="ghost" disabled={busy} onClick={() => act(() => api.settings({ weeklyEnabled: !s.weeklyEnabled }))}>{s.weeklyEnabled ? 'Turn off' : 'Turn on'}</button>
        </div>
        <div className="form">
          <strong>Wikipedia contact:</strong>
          <span className="muted small">{s.contactSet ? 'set' : 'not set, so the source is disabled'}</span>
          <input placeholder="address or URL for the User-Agent" value={contact} onChange={e => setContact(e.target.value)} aria-label="contact" />
          <button className="ghost" disabled={busy || !contact.trim()} onClick={() => act(async () => { await api.settings({ contact }); setContact(''); })}>Save</button>
        </div>

        <div>
          <strong>Theme to Wikipedia article</strong>
          <table><tbody>
            {articles.length === 0 && <tr><td className="muted small">Add themes on the Watch tab first.</td></tr>}
            {articles.map(a => (
              <tr key={a.theme}>
                <td>{a.theme}</td>
                <td><input defaultValue={a.article} aria-label={`article for ${a.theme}`} onBlur={e => e.target.value.trim() && e.target.value !== a.article && act(async () => { await api.setArticle(a.theme, e.target.value); await refresh(); })} /></td>
                <td>{a.guess ? <span className="pill disabled" title="Built from the theme text; set it yourself to confirm">guess</span> : <span className="pill ok">set by you</span>}</td>
              </tr>
            ))}
          </tbody></table>
        </div>

        <div>
          <strong>CSV import</strong> <span className="muted small">(a keyword export you download yourself from eRank, Alura, EverBee or Terapeak; headers are assumed, check the mapping)</span>
          <div className="form">
            <select value={tool} onChange={e => { setTool(e.target.value); setPreview(null); }} aria-label="tool">{(s.csvTools || []).map(t => <option key={t}>{t}</option>)}</select>
            <input type="file" accept=".csv,text/csv,text/plain" aria-label="csv file" onChange={async e => { const f = e.target.files[0]; if (f) { setCsv(await f.text()); setPreview(null); } }} />
          </div>
          <textarea rows={4} style={{ width: '100%' }} placeholder="or paste CSV text" value={csv} onChange={e => { setCsv(e.target.value); setPreview(null); }} aria-label="csv text" />
          <div className="form">
            <button className="ghost" disabled={busy || !csv.trim()} onClick={() => act(async () => { setPreview(await api.csvPreview(csv, tool)); })}>Preview</button>
            <button disabled={busy || !preview || !preview.previewHash} onClick={() => act(async () => { const r = await api.csvImport(csv, tool, preview.previewHash); setMsg(`Saved ${r.numbersSaved} numbers for ${r.keywords} keywords.`); setPreview(null); })}>Import</button>
          </div>
          {preview && (
            <div className="small">
              {preview.fatal ? <div className="banner error">{preview.fatal}</div> : <div>{preview.rows} keyword(s), {preview.matchedToWatchlistThemes} match your themes, {preview.skippedCount} skipped.</div>}
              <div className="muted">Read as: {Object.entries(preview.headerMap).map(([k, v]) => `${k} = "${v}"`).join(', ') || 'nothing'}. Ignored columns: {preview.ignoredHeaders.join(', ') || 'none'}.</div>
              <div className="muted">{preview.note}</div>
            </div>
          )}
        </div>

        <div>
          <strong>Manual entries</strong> <span className="muted small">(things you checked by hand; dated and labelled manual)</span>
          <form className="form" onSubmit={e => { e.preventDefault(); act(async () => { await api.addManual(form); setForm({ ...form, term: '', note: '' }); await refresh(); }); }}>
            <select value={form.source} onChange={e => setForm({ ...form, source: e.target.value })} aria-label="source">{['pinterest-trends', 'google-trends', 'redbubble', 'amazon-merch', 'etsy-trends', 'other'].map(t => <option key={t}>{t}</option>)}</select>
            <input placeholder="theme or keyword" value={form.term} onChange={e => setForm({ ...form, term: e.target.value })} aria-label="term" />
            <select value={form.direction} onChange={e => setForm({ ...form, direction: e.target.value })} aria-label="direction"><option>rising</option><option>flat</option><option>falling</option></select>
            <input placeholder="note (your words)" value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} aria-label="note" />
            <button disabled={busy || !form.term.trim()}>Add</button>
          </form>
          <table><tbody>
            {entries.slice(0, 15).map(m => (
              <tr key={m.id}><td>{m.observedOn}</td><td>{m.source} <span className="tag">manual</span></td><td>{m.term}</td><td>{m.direction}</td><td className="muted small">{m.note}</td>
                <td><button className="ghost" onClick={() => act(async () => { await api.deleteManual(m.id); await refresh(); })}>Remove</button></td></tr>
            ))}
          </tbody></table>
        </div>
        <div className="muted small">Score weights are untested starting guesses ({Object.entries(s.weights).map(([k, v]) => `${k} ${v}`).join(', ')}). They will be re-fitted after 8-12 weeks of our own results.</div>
      </div>
    </details>
  );
}
