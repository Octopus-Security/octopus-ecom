import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';

const when = (iso) => (iso ? iso.slice(0, 16).replace('T', ' ') : '-');

// Settings -> Stores: connect Etsy, see the connection, autopublish, disconnect. Never shows a token.
export default function StoresPanel({ askConfirm }) {
  const [s, setS] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const load = useCallback(() => api.etsyStatus().then((x) => { setS(x); setErr(''); }).catch((e) => setErr(e.message)), []);
  useEffect(() => { load(); }, [load]);

  async function connect() {
    setBusy('connect'); setErr('');
    try { const c = await api.etsyConnect(); window.location.href = c.url; }
    catch (e) { setErr(e.message); setBusy(''); }
  }
  async function recheck(id) {
    setBusy('recheck'); setErr('');
    try { await api.etsyRecheck(id); await load(); } catch (e) { setErr(e.message); } finally { setBusy(''); }
  }
  async function disconnect(id) {
    try {
      const gate = await api.etsyDisconnect(id);
      askConfirm({ title: 'Disconnect Etsy?', summary: gate.summary, danger: true, run: async () => { await api.etsyDisconnect(id, gate.token); await load(); } });
    } catch (e) { setErr(e.message); }
  }
  async function autopublish(store, on) {
    try {
      if (!on) { await api.etsyAutopublish(store.id, false); return load(); }
      const gate = await api.etsyAutopublish(store.id, true);
      askConfirm({ title: 'Enable autopublish?', summary: gate.summary, danger: true, run: async () => { await api.etsyAutopublish(store.id, true, gate.token); await load(); } });
    } catch (e) { setErr(e.message); }
  }

  if (!s) return <div className="muted small">{err || 'loading...'}</div>;
  return (
    <section aria-label="Stores">
      {err && <div className="banner error" role="alert">{err}</div>}
      {s.message && <div className="banner warn-banner">{s.message}</div>}
      {s.stub && <div className="muted small">Etsy is running on stubs: add the Etsy API keystring and shared secret below (and set ETSY_REDIRECT_URI) to connect a real shop.</div>}
      {s.stores.length === 0 && <div className="muted small">No Etsy store connected yet.</div>}
      {s.stores.map((st) => (
        <div className="cred" key={st.id}>
          <div className="row between"><strong>Etsy{st.shopName ? `: ${st.shopName}` : ''}</strong>
            <span className={st.connected ? 'pos' : 'warn'}>{st.connected ? 'connected' : st.needsShop ? 'no shop yet' : st.status}</span></div>
          {st.message && <div className="banner warn-banner" role="status">{st.message}</div>}
          <div className="muted small">
            shop id {st.shopId || '-'} - access token valid until {when(st.tokenExpiresAt)} (renews itself) - sign-in lapses if unused until {when(st.refreshExpiresAt)}
            {st.shopUrl && <> - <a href={st.shopUrl} target="_blank" rel="noreferrer">open shop</a></>}
          </div>
          <div className="muted small">last sales sync {when(st.lastSalesSyncAt)}</div>
          <label className="row"><input type="checkbox" checked={st.autopublish} onChange={(e) => autopublish(st, e.target.checked)} disabled={!st.connected} />
            Autopublish (needs live writes; flagged products never autopublish)</label>
          <div className="row">
            {st.status !== 'disconnected' && <button className="ghost" disabled={!!busy} onClick={() => recheck(st.id)}>{busy === 'recheck' ? 'Checking...' : 'Check shop'}</button>}
            {st.status !== 'disconnected' && <button className="danger" onClick={() => disconnect(st.id)}>Disconnect...</button>}
          </div>
        </div>
      ))}
      <div className="row"><button disabled={!!busy} onClick={connect}>{busy === 'connect' ? 'Opening Etsy...' : s.stores.some((x) => x.status !== 'disconnected') ? 'Reconnect Etsy' : 'Connect Etsy'}</button></div>
    </section>
  );
}
