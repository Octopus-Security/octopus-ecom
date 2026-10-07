import React from 'react';
import { dollars } from '../api.js';

const LABEL = { PENDING_APPROVAL: 'PENDING APPROVAL' };
const label = (s) => LABEL[s] || s.replace(/_/g, ' ');

const marginClass = (p) => (p.projectedMarginCents === null || p.projectedMarginCents === undefined ? 'muted' : p.projectedMarginCents <= 0 ? 'neg' : p.projectedMarginCents < p.marginFloorCents ? 'warn' : 'pos');

function Card({ p, onOpen }) {
  return (
    <article className="card" tabIndex={0} role="button" onClick={() => onOpen(p.id)} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(p.id); }}>
      {p.thumbnail && <img src={p.thumbnail} alt={p.thumbnailKind === 'mockup' ? 'Mockup' : 'Design'} loading="lazy" />}
      <h4>{p.title}</h4>
      <div className="muted small">{p.store || 'no store'}{p.modelUsed ? ` - ${p.modelUsed}` : ''} - cost {dollars(p.costCents)}</div>
      {p.designSize && <div className="muted small">{p.designSize}px</div>}
      <div className={`small ${marginClass(p)}`}>Margin {dollars(p.projectedMarginCents)}{p.podCostSource === 'estimate' ? ' (est.)' : ''}</div>
      {p.channels && <div className="small chans" aria-label="Sales channels">
        {[['etsy', 'Etsy'], ['redbubble', 'Redbubble']].map(([k, l]) => <span key={k} className={`chip ${p.channels[k] === 'live' ? 'pos' : p.channels[k] === 'uploaded' ? 'warn' : p.channels[k] === 'removed' ? 'neg' : 'muted'}`} title={`${l}: ${p.channels[k].replace('_', ' ')}`}>{l} {p.channels[k].replace('_', ' ')}</span>)}
      </div>}
      {p.flags.map((f) => <span className="flag" key={f.code} title={f.detail}>{f.code}</span>)}
      {p.failedReason && <div className="small neg">{p.failedReason}</div>}
    </article>
  );
}

export default function Board({ board, onOpen }) {
  if (!board) return <main className="board" />;
  return (
    <main className="board">
      {board.stages.map((s) => (
        <section className={`col stage-${s}`} key={s} aria-label={label(s)}>
          <h3>{label(s)} <span className="count">{board.columns[s].length}</span></h3>
          {board.columns[s].length === 0 ? <div className="empty">empty</div> : board.columns[s].map((p) => <Card key={p.id} p={p} onOpen={onOpen} />)}
        </section>
      ))}
    </main>
  );
}
