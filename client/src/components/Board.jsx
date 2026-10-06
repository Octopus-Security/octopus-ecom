import React from 'react';
import { dollars } from '../api.js';

const LABEL = { PENDING_APPROVAL: 'PENDING APPROVAL' };
const label = (s) => LABEL[s] || s.replace(/_/g, ' ');

function Card({ p }) {
  return (
    <article className="card">
      {p.thumbnail && <img src={p.thumbnail} alt="" loading="lazy" />}
      <h4>{p.title}</h4>
      <div className="muted small">{p.store || 'no store'}{p.modelUsed ? ` - ${p.modelUsed}` : ''}</div>
      <div className="small">Margin {dollars(p.projectedMarginCents)}</div>
      {p.flags.map((f) => <span className="flag" key={f.code} title={f.detail}>{f.code}</span>)}
      {p.failedReason && <div className="small neg">{p.failedReason}</div>}
    </article>
  );
}

export default function Board({ board }) {
  if (!board) return <main className="board" />;
  return (
    <main className="board">
      {board.stages.map((s) => (
        <section className={`col stage-${s}`} key={s} aria-label={label(s)}>
          <h3>{label(s)} <span className="count">{board.columns[s].length}</span></h3>
          {board.columns[s].length === 0 ? <div className="empty">empty</div> : board.columns[s].map((p) => <Card key={p.id} p={p} />)}
        </section>
      ))}
    </main>
  );
}
