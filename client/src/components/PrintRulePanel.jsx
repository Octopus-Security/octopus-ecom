import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

// The print-readiness rule: how much of the print area a design must cover, and whether a narrower design may be letter-boxed.
export default function PrintRulePanel({ settings, onSaved }) {
  const [cov, setCov] = useState('1'); const [fit, setFit] = useState('cover'); const [msg, setMsg] = useState(''); const [err, setErr] = useState('');
  useEffect(() => { if (settings && settings.print) { setCov(String(settings.print.minCoverage)); setFit(settings.print.fit); } }, [settings]);
  async function save() {
    setErr(''); setMsg('');
    try { await api.saveSettings({ printMinCoverage: Number(cov), printFit: fit }); setMsg('Saved.'); if (onSaved) onSaved(); } catch (e) { setErr(e.message); }
  }
  return (
    <div className="cred">
      <div className="muted small">A design below the print area's pixel size cannot reach mockup_ready. Default: both dimensions must meet 100%. A design upscaled from a smaller native size passes on its stored pixels, but is labelled as upscaled.</div>
      {err && <div className="banner error">{err}</div>}
      <label>Minimum coverage (0.1 to 1; 1 = full size)<input type="number" min="0.1" max="1" step="0.05" value={cov} onChange={(e) => setCov(e.target.value)} /></label>
      <label>Fit
        <select value={fit} onChange={(e) => setFit(e.target.value)}>
          <option value="cover">cover: both width and height must reach the minimum</option>
          <option value="contain">contain: the limiting side must reach it; a narrower design is letter-boxed</option>
        </select>
      </label>
      <div className="row"><button onClick={save}>Save rule</button>{msg && <span className="small pos">{msg}</span>}</div>
    </div>
  );
}
