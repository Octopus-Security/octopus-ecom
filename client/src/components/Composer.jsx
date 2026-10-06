import React, { useState } from 'react';
import { api } from '../api.js';

const STEPS = ['Creating product', 'Generating design', 'Drafting listing copy'];

// New product: brief -> generate design -> auto-draft copy. Each step is its own call, so a
// failure shows which step failed and the card (already on the board) keeps its state.
export default function Composer({ onClose, onChanged, onOpen }) {
  const [f, setF] = useState({ niche: '', brief: '', keywords: '', listPrice: '', blueprint: '' });
  const [step, setStep] = useState(-1);
  const [err, setErr] = useState('');
  const [newId, setNewId] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  async function go(e) {
    e.preventDefault(); setErr('');
    let id = newId;
    try {
      if (id === null) {
        setStep(0);
        const body = { brief: f.brief, niche: f.niche, keywords: f.keywords.split(',').map((s) => s.trim()).filter(Boolean) };
        if (f.listPrice !== '') body.listPrice = f.listPrice;
        if (f.blueprint.trim()) body.blueprint = f.blueprint.trim();
        id = (await api.createProduct(body)).product.id; setNewId(id); onChanged();
      }
      setStep(1); await api.generateDesign(id); onChanged();
      setStep(2); await api.draftCopy(id); onChanged();
      onOpen(id);
    } catch (e2) { setErr(`${STEPS[step < 0 ? 0 : step]}: ${e2.message}`); setStep(-1); onChanged(); }
  }
  const busy = step >= 0;

  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-label="New product">
      <form className="modal wide" onSubmit={go}>
        <h3>New product</h3>
        <label>Niche / theme<input value={f.niche} onChange={set('niche')} maxLength={200} placeholder="cozy woodland animals" disabled={busy} /></label>
        <label>Design brief
          <textarea value={f.brief} onChange={set('brief')} maxLength={2000} rows={4} required disabled={busy || newId !== null} placeholder="A fox in a knitted scarf, flat vector style, warm autumn palette" />
        </label>
        <label>Keywords (comma separated; themes, not copied from other sellers)<input value={f.keywords} onChange={set('keywords')} disabled={busy || newId !== null} placeholder="fox, autumn, cozy" /></label>
        <div className="row">
          <label className="grow">List price (USD)<input type="number" min="0" step="0.01" value={f.listPrice} onChange={set('listPrice')} disabled={busy || newId !== null} /></label>
          <label className="grow">Blueprint (placeholder until Printify)<input value={f.blueprint} onChange={set('blueprint')} disabled={busy || newId !== null} /></label>
        </div>
        {busy && <div className="muted" role="status">{STEPS[step]}... (image generation can take a minute)</div>}
        {err && <div className="banner error" role="alert">{err}{newId !== null ? ' The product is on the board; "Generate" retries from here.' : ''}</div>}
        <div className="row">
          <button type="button" className="ghost" onClick={onClose} disabled={busy}>Close</button>
          <button type="submit" disabled={busy || !f.brief.trim()}>{newId !== null ? 'Retry generate' : 'Generate'}</button>
        </div>
      </form>
    </div>
  );
}
