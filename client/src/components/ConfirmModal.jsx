import React, { useState } from 'react';

// Shows the server-written summary of an irreversible action. If `phrase` is
// given, it must be typed exactly before the confirm button enables.
export default function ConfirmModal({ title, summary, phrase, danger, run, onClose }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const ok = !phrase || typed === phrase;

  async function go() {
    setBusy(true); setErr('');
    try { await run(typed); onClose(); } catch (e) { setErr(e.message); setBusy(false); }
  }

  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal">
        <h3>{title}</h3>
        <p>{summary}</p>
        {phrase && <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={phrase} aria-label="Confirmation phrase" />}
        {err && <div className="banner error">{err}</div>}
        <div className="row">
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button className={danger ? 'danger' : ''} disabled={!ok || busy} onClick={go}>Confirm</button>
        </div>
      </div>
    </div>
  );
}
