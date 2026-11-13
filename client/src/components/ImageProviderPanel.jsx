import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

// Which service makes the print designs. Nothing changes until a provider is picked and saved; a provider without a key fails, it never falls back.
export default function ImageProviderPanel({ settings, onSaved }) {
  const img = settings && settings.image;
  const [provider, setProvider] = useState('nous'); const [model, setModel] = useState(''); const [res, setRes] = useState('');
  const [maxCents, setMaxCents] = useState(''); const [msg, setMsg] = useState(''); const [err, setErr] = useState('');
  useEffect(() => { if (img) { setProvider(img.provider); setModel(img.model || ''); setRes(img.resolution || ''); setMaxCents(img.maxCents ? String(img.maxCents) : ''); } }, [img]);
  if (!img) return null;
  const p = img.providers.find((x) => x.id === provider) || img.providers[0];
  async function save() {
    setErr(''); setMsg('');
    try {
      const b = { imageProvider: provider, imageModel: model, imageResolution: p.resolutions.length ? res : undefined };
      if (provider === 'openrouter') b.imageMaxCents = maxCents;
      await api.saveSettings(b); setMsg('Saved.'); if (onSaved) onSaved();
    } catch (e) { setErr(e.message); }
  }
  return (
    <div className="cred">
      <div className="muted small">Pick where print designs are generated. The matching key goes in Credentials below. A provider with no key stops with an error; it never switches to another paid provider.</div>
      {err && <div className="banner error">{err}</div>}
      <label>Provider
        <select value={provider} onChange={(e) => { const next = img.providers.find((x) => x.id === e.target.value) || img.providers[0]; setProvider(next.id); setModel(next.id === img.provider ? (img.model || '') : (next.freeTextModel ? '' : (next.models[0] || ''))); setRes(''); }}>
          {img.providers.map((x) => <option key={x.id} value={x.id}>{x.label}{x.keyPresent ? '' : ' (no key yet)'}</option>)}
        </select>
      </label>
      <label>Model
        {p.freeTextModel
          ? <input value={model} placeholder={provider === 'openrouter' ? 'an image model id from openrouter.ai' : 'default'} onChange={(e) => setModel(e.target.value)} />
          : <select value={model} onChange={(e) => setModel(e.target.value)}>{p.models.map((m) => <option key={m} value={m}>{m}</option>)}</select>}
      </label>
      {p.resolutions.length > 0 && (
        <label>Resolution
          <select value={res} onChange={(e) => setRes(e.target.value)}><option value="">default</option>{p.resolutions.map((r) => <option key={r} value={r}>{r}</option>)}</select>
        </label>
      )}
      {provider === 'nous' && <div className="muted small">Uses the Nous Portal subscription. The chat inference key is refused by the image gateway. Under Credentials, use Sign in to Nous Portal. Dry run still makes a real image and only fakes the print provider and the shops. A solid colour block means no Nous sign-in was stored, so the free placeholder ran. A saved PNG, including one you upload, is what the print provider uses later. Regenerate is the only new image spend.</div>}
      {provider === 'openrouter' && <label>Per-image spend ceiling in cents (used for the daily-cap check; default 25)<input type="number" min="1" value={maxCents} onChange={(e) => setMaxCents(e.target.value)} /></label>}
      <div className="row"><button onClick={save}>Save image provider</button>{msg && <span className="small pos">{msg}</span>}</div>
    </div>
  );
}
