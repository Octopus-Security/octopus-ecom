import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import StoresPanel from './StoresPanel.jsx';
import BlocklistPanel from './BlocklistPanel.jsx';
import PrintRulePanel from './PrintRulePanel.jsx';
import ImageProviderPanel from './ImageProviderPanel.jsx';
import { FeeSchedulePanel, PriceCalculator } from './FeesPanel.jsx';

// The image gateway wants a Portal sign-in, not the chat inference key.
function NousSignIn({ onDone }) {
  const [step, setStep] = useState(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    if (!step) return undefined;
    let stop = false;
    let timer;
    const tick = async () => {
      if (stop) return;
      if (Date.now() > step.expiresAt) { setErr('That sign-in code expired. Start again.'); setStep(null); return; }
      try {
        const r = await api.nousLoginPoll();
        if (stop) return;
        if (r.ok) { setStep(null); setMsg('Signed in. Generate uses the Portal subscription now.'); if (done.current) done.current(); return; }
        const sec = Math.max(5, Number(r.interval) || Number(step.interval) || 5);
        timer = setTimeout(tick, sec * 1000);
      } catch (e) { if (!stop) { setErr(e.message); setStep(null); } }
    };
    timer = setTimeout(tick, Math.max(5000, (Number(step.interval) || 5) * 1000));
    return () => { stop = true; clearTimeout(timer); };
  }, [step]);

  async function start() {
    setErr(''); setMsg(''); setBusy(true);
    try {
      const s = await api.nousLogin();
      setStep({ ...s, expiresAt: Date.now() + (Number(s.expiresIn) || 600) * 1000 });
    } catch (e) { setErr(e.message); }
    setBusy(false);
  }

  return (
    <div className="nous-signin">
      <div className="muted small">The chat inference key is refused here. Sign in once. This shop keeps its own Portal login and does not use a Hermes refresh token.</div>
      <div className="row">
        <button type="button" disabled={busy || !!step} onClick={start}>{step ? 'Waiting for approval' : 'Sign in to Nous Portal'}</button>
        {step && <button type="button" className="ghost" onClick={() => setStep(null)}>Cancel</button>}
      </div>
      {step && (
        <div className="muted small">
          Code <strong>{step.userCode}</strong>
          {' '}<a href={step.verificationUrl} target="_blank" rel="noreferrer">Open Nous Portal to approve</a>
        </div>
      )}
      {msg && <div className="small pos">{msg}</div>}
      {err && <div className="banner error">{err}</div>}
    </div>
  );
}

// Credentials: presence only. A value is typed in, sent once, and never shown again.
export default function SettingsDrawer({ onClose, askConfirm }) {
  const [s, setS] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [err, setErr] = useState('');

  const load = () => api.settings().then(setS).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  async function save(name) {
    try { await api.setCredential(name, drafts[name]); setDrafts({ ...drafts, [name]: '' }); await load(); setErr(''); } catch (e) { setErr(e.message); }
  }
  async function remove(name) {
    try {
      const gate = await api.deleteCredential(name);
      if (!gate.needsConfirm) return load();
      askConfirm({ title: `Delete ${name}?`, summary: gate.summary, danger: true, run: async () => { await api.deleteCredential(name, gate.token); await load(); } });
    } catch (e) { setErr(e.message); }
  }

  return (
    <aside className="drawer" aria-label="Settings">
      <div className="row between"><h3>Stores</h3><button className="ghost" onClick={onClose}>Close</button></div>
      <StoresPanel askConfirm={askConfirm} />
      <h3>Print readiness</h3>
      <PrintRulePanel settings={s} onSaved={load} />
      <h3>Image generation</h3>
      <ImageProviderPanel settings={s} onSaved={load} />
      <h3>Etsy fees</h3>
      <FeeSchedulePanel />
      <h3>Price calculator</h3>
      <PriceCalculator />
      <h3>Blocklist</h3>
      <BlocklistPanel />
      <h3>Credentials</h3>
      <p className="muted small">Stored sealed (AES-256-GCM). Values are never shown again; only a fingerprint and the last 4 characters.</p>
      {err && <div className="banner error">{err}</div>}
      {s && s.credentials.map((c) => (
        <div className="cred" key={c.name}>
          <div className="row between">
            <strong>{c.name}</strong>
            <span className={c.present ? 'pos' : 'muted'}>{c.present ? `set (${c.source}) ...${c.tail}` : 'not set'}</span>
          </div>
          <div className="muted small">fallback env var: {c.envVar}{c.fp ? ` - fp ${c.fp}` : ''}</div>
          {c.name === 'nous' && <NousSignIn onDone={load} />}
          <div className="row">
            <input type="password" autoComplete="off" placeholder={c.name === 'nous' ? 'or paste a Portal access token' : 'paste value'} value={drafts[c.name] || ''} onChange={(e) => setDrafts({ ...drafts, [c.name]: e.target.value })} aria-label={`${c.name} value`} />
            <button disabled={!drafts[c.name]} onClick={() => save(c.name)}>Save</button>
            {c.source === 'keystore' && <button className="danger" onClick={() => remove(c.name)}>Delete</button>}
          </div>
        </div>
      ))}
    </aside>
  );
}
