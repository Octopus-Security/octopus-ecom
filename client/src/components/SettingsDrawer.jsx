import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

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
      <div className="row between"><h3>Credentials</h3><button className="ghost" onClick={onClose}>Close</button></div>
      <p className="muted small">Stored sealed (AES-256-GCM). Values are never shown again; only a fingerprint and the last 4 characters.</p>
      {err && <div className="banner error">{err}</div>}
      {s && s.credentials.map((c) => (
        <div className="cred" key={c.name}>
          <div className="row between">
            <strong>{c.name}</strong>
            <span className={c.present ? 'pos' : 'muted'}>{c.present ? `set (${c.source}) ...${c.tail}` : 'not set'}</span>
          </div>
          <div className="muted small">fallback env var: {c.envVar}{c.fp ? ` - fp ${c.fp}` : ''}</div>
          <div className="row">
            <input type="password" autoComplete="off" placeholder="paste value" value={drafts[c.name] || ''} onChange={(e) => setDrafts({ ...drafts, [c.name]: e.target.value })} aria-label={`${c.name} value`} />
            <button disabled={!drafts[c.name]} onClick={() => save(c.name)}>Save</button>
            {c.source === 'keystore' && <button className="danger" onClick={() => remove(c.name)}>Delete</button>}
          </div>
        </div>
      ))}
    </aside>
  );
}
