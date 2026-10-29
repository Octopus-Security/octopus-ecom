import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

// The print-readiness rule: how much of the print area a design must cover, and whether a narrower design may be letter-boxed.
export default function PrintRulePanel({ settings, onSaved }) {
  const [cov, setCov] = useState('1'); const [fit, setFit] = useState('contain'); const [msg, setMsg] = useState(''); const [err, setErr] = useState('');
  useEffect(() => { if (settings && settings.print) { setCov(String(settings.print.minCoverage)); setFit(settings.print.fit); } }, [settings]);
  async function save() {
    setErr(''); setMsg('');
    try { await api.saveSettings({ printMinCoverage: Number(cov), printFit: fit }); setMsg('Saved.'); if (onSaved) onSaved(); } catch (e) { setErr(e.message); }
  }
  return (
    <div className="cred">
      <div className="muted small">A design below the minimum cannot reach mockup_ready. Default: <b>fit</b> (contain) at 100%: the design prints whole, as large as its limiting side allows. A design that passes but does not fill the print area, or was upscaled, is flagged <b>print_review</b>, so it waits for you to look at the mockup and approve it; nothing flagged is auto-approved.</div>
      {err && <div className="banner error">{err}</div>}
      <label>Minimum coverage (0.1 to 1; 1 = full size)<input type="number" min="0.1" max="1" step="0.05" value={cov} onChange={(e) => setCov(e.target.value)} /></label>
      <label>Fit
        <select value={fit} onChange={(e) => setFit(e.target.value)}>
          <option value="contain">fit (contain): the limiting side must reach it; a narrower design prints with blank margins and is flagged for review</option>
          <option value="cover">fill (cover): both width and height must reach the minimum; anything smaller is refused</option>
        </select>
      </label>
      <div className="row"><button onClick={save}>Save rule</button>{msg && <span className="small pos">{msg}</span>}</div>
    </div>
  );
}
