import React from 'react';
import { dollars } from '../api.js';
import AlertsTray from './watch/AlertsTray.jsx';

export default function TopBar({ summary, onToggleDryRun, onSettings, onNew, onBatch, view, onView, watchApi, onOpenPlaybook }) {
  if (!summary) return <header className="topbar"><strong>Shop</strong><span className="muted">loading...</span></header>;
  const { spend, revenue, netCents, dryRun, simulated } = summary;
  return (
    <header className="topbar">
      <strong className="brand">Shop</strong>
      <button className={`dry ${dryRun ? 'on' : 'off'}`} onClick={onToggleDryRun} aria-pressed={dryRun}
        title={dryRun ? 'DRY_RUN is ON: nothing reaches a real marketplace' : 'LIVE: writes are real'}>
        {dryRun ? 'DRY RUN: ON' : 'LIVE WRITES'}
      </button>
      <div className="stat"><span className="label">Spend</span><span>{dollars(spend.totalCents)}</span></div>
      <div className="stat"><span className="label">Revenue</span><span>{dollars(revenue.grossCents)}</span></div>
      <div className={`stat ${netCents < 0 ? 'neg' : 'pos'}`} title={`From ${revenue.orders} real receipt line(s) minus every cost (images, copy, listing fees, per-sale COGS)${simulated && simulated.orders ? `. ${simulated.orders} simulated line(s) are NOT included.` : ''}`}><span className="label">NET{revenue.orders === 0 ? ' (no sales yet)' : ''}</span><span>{dollars(netCents)}</span></div>
      <div className="stat cap">
        <span className="label">Daily cap {dollars(spend.todayCents)} / {dollars(spend.dailyCapCents)}</span>
        <div className={`meter ${spend.capReached ? 'full' : ''}`} role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={spend.capPct}>
          <div style={{ width: `${spend.capPct}%` }} />
        </div>
      </div>
      <nav className="views" aria-label="View">
        {[['board', 'Board'], ['batches', 'Batches'], ['sales', 'Sales'], ['watch', 'Watch'], ['playbooks', 'Playbooks'], ['plan', 'Plan']].map(([v, l]) => (
          <button key={v} className={`ghost ${view === v ? 'active' : ''}`} aria-pressed={view === v} onClick={() => onView(v)}>{l}</button>
        ))}
      </nav>
      <button onClick={onNew}>New product</button>
      <button className="ghost" onClick={onBatch}>Run batch</button>
      {watchApi && <AlertsTray api={watchApi} onOpenPlaybook={onOpenPlaybook} />}
      <button className="ghost" onClick={onSettings}>Settings</button>
    </header>
  );
}
