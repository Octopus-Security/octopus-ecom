import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api.js';
import TopBar from './components/TopBar.jsx';
import Board from './components/Board.jsx';
import SettingsDrawer from './components/SettingsDrawer.jsx';
import Composer from './components/Composer.jsx';
import ProductDrawer from './components/ProductDrawer.jsx';
import ConfirmModal from './components/ConfirmModal.jsx';
import { makeWatchApi } from './components/watch/watchApi.js';
import WatchPanel from './components/watch/WatchPanel.jsx';
import TrendsView from './components/trends/TrendsView.jsx';
import { makeTrendsApi } from './components/trends/trendsApi.js';
import SalesView from './components/SalesView.jsx';
import BatchDialog from './components/BatchDialog.jsx';
import BatchesView from './components/BatchesView.jsx';
import PlaybooksView from './components/playbooks/PlaybooksView.jsx';
import PlanChat from './components/PlanChat.jsx';
import ProposalsView from './components/ProposalsView.jsx';

export default function App() {
  const [summary, setSummary] = useState(null);
  const [board, setBoard] = useState(null);
  const [error, setError] = useState('');
  const [drawer, setDrawer] = useState(false);
  const [composer, setComposer] = useState(false);
  const [batchDialog, setBatchDialog] = useState(false);
  const [batchFocus, setBatchFocus] = useState(null);
  const [openId, setOpenId] = useState(null);
  const watchApi = useMemo(() => makeWatchApi(), []);
  const trendsApi = useMemo(() => makeTrendsApi(), []);
  const [view, setView] = useState('board'); // 'board' | 'batches' | 'proposals' | 'sales' | 'watch' | 'trends' | 'playbooks' | 'plan'
  const [flash, setFlash] = useState(''); // outcome of an Etsy connect round-trip (?etsy=...)
  const [pb, setPb] = useState({ id: null, productId: 0 });
  const [confirm, setConfirm] = useState(null); // {summary, phrase?, run(token, typed)}

  const refresh = useCallback(async () => {
    try {
      const [s, b] = await Promise.all([api.summary(), api.products()]);
      setSummary(s); setBoard(b); setError('');
    } catch (e) { setError(e.message); }
  }, []);

  useEffect(() => {
    // Etsy redirects back to /?etsy=connected|no_shop|error&msg=...: show it once, open Stores, clean the URL.
    const q = new URLSearchParams(window.location.search); const e = q.get('etsy');
    if (!e) return;
    setFlash(e === 'connected' ? 'Etsy connected.' : e === 'no_shop' ? 'Etsy connected, but this account has no shop. Open an Etsy shop first (Shop Manager → open shop), then reconnect.' : `Etsy connection failed: ${q.get('msg') || 'unknown error'}`);
    setDrawer(true);
    window.history.replaceState({}, '', window.location.pathname);
  }, []);

  useEffect(() => { refresh(); const t = setInterval(refresh, 15000); return () => clearInterval(t); }, [refresh]);

  // DRY_RUN: ON is immediate; OFF goes through the server's two-step confirm.
  async function toggleDryRun() {
    try {
      if (!summary.dryRun) { await api.setDryRun({ dryRun: true }); return refresh(); }
      const gate = await api.setDryRun({ dryRun: false });
      if (!gate.needsConfirm) return refresh();
      setConfirm({
        title: 'Arm live writes?', summary: gate.summary, phrase: 'ARM LIVE WRITES', danger: true,
        run: async (typed) => { await api.setDryRun({ dryRun: false, token: gate.token, confirm: typed }); await refresh(); },
      });
    } catch (e) { setError(e.message); }
  }

  return (
    <div className="app">
      <TopBar summary={summary} onToggleDryRun={toggleDryRun} onSettings={() => setDrawer(true)} onNew={() => setComposer(true)} onBatch={() => setBatchDialog(true)}
        view={view} onView={setView} watchApi={watchApi}
        onOpenPlaybook={(id, productId) => { setPb({ id, productId: productId || 0 }); setView('playbooks'); }} />
      {error && <div className="banner error" role="alert">{error}</div>}
      {flash && <div className="banner warn-banner" role="status">{flash} <button className="ghost" onClick={() => setFlash('')}>Dismiss</button></div>}
      {view === 'board' && <Board board={board} onOpen={setOpenId} />}
      {view === 'batches' && <BatchesView focusId={batchFocus} onOpenProduct={setOpenId} onChanged={refresh} />}
      {view === 'proposals' && <ProposalsView onOpenProduct={setOpenId} onChanged={refresh} askConfirm={setConfirm} />}
      {view === 'sales' && <SalesView onChanged={refresh} onOpenPlaybook={(id) => { setPb({ id, productId: 0 }); setView('playbooks'); }} />}
      {view === 'watch' && <WatchPanel api={watchApi} />}
      {view === 'trends' && <TrendsView api={trendsApi} />}
      {view === 'playbooks' && <PlaybooksView api={watchApi} initialId={pb.id} initialProductId={pb.productId}
        products={board ? Object.values(board.columns).flat().map(p => ({ id: p.id, title: p.title })) : []} />}
      {view === 'plan' && <PlanChat />}
      {drawer && <SettingsDrawer onClose={() => { setDrawer(false); refresh(); }} askConfirm={setConfirm} />}
      {composer && <Composer onClose={() => { setComposer(false); refresh(); }} onChanged={refresh} onOpen={(id) => { setComposer(false); setOpenId(id); }} />}
      {batchDialog && <BatchDialog onClose={() => setBatchDialog(false)} onStarted={(id) => { setBatchDialog(false); setBatchFocus(id); setView('batches'); refresh(); }} />}
      {openId !== null && <ProductDrawer id={openId} onClose={() => { setOpenId(null); refresh(); }} onChanged={refresh} askConfirm={setConfirm}
        onOpenPlaybook={(id, productId) => { setPb({ id, productId: productId || 0 }); setView('playbooks'); }} />}
      {confirm && <ConfirmModal {...confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}
