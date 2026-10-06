import React from 'react';
import { dollars } from '../api.js';

export default function TopBar({ summary, onToggleDryRun, onSettings, onNew }) {
  if (!summary) return <header className="topbar"><strong>Shop</strong><span className="muted">loading...</span></header>;
  const { spend, revenue, netCents, dryRun } = summary;
  return (
    <header className="topbar">
      <strong className="brand">Shop</strong>
      <button className={`dry ${dryRun ? 'on' : 'off'}`} onClick={onToggleDryRun} aria-pressed={dryRun}
        title={dryRun ? 'DRY_RUN is ON: nothing reaches a real marketplace' : 'LIVE: writes are real'}>
        {dryRun ? 'DRY RUN: ON' : 'LIVE WRITES'}
      </button>
      <div className="stat"><span className="label">Spend</span><span>{dollars(spend.totalCents)}</span></div>
      <div className="stat"><span className="label">Revenue</span><span>{dollars(revenue.grossCents)}</span></div>
      <div className={`stat ${netCents < 0 ? 'neg' : 'pos'}`}><span className="label">NET</span><span>{dollars(netCents)}</span></div>
      <div className="stat cap">
        <span className="label">Daily cap {dollars(spend.todayCents)} / {dollars(spend.dailyCapCents)}</span>
        <div className={`meter ${spend.capReached ? 'full' : ''}`} role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={spend.capPct}>
          <div style={{ width: `${spend.capPct}%` }} />
        </div>
      </div>
      <button onClick={onNew}>New product</button>
      <button className="ghost" onClick={onSettings}>Settings</button>
    </header>
  );
}
