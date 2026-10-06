import React, { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import TopBar from './components/TopBar.jsx';
import Board from './components/Board.jsx';
import SettingsDrawer from './components/SettingsDrawer.jsx';
import Composer from './components/Composer.jsx';
import ProductDrawer from './components/ProductDrawer.jsx';
import ConfirmModal from './components/ConfirmModal.jsx';

export default function App() {
  const [summary, setSummary] = useState(null);
  const [board, setBoard] = useState(null);
  const [error, setError] = useState('');
  const [drawer, setDrawer] = useState(false);
  const [composer, setComposer] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [confirm, setConfirm] = useState(null); // {summary, phrase?, run(token, typed)}

  const refresh = useCallback(async () => {
    try {
      const [s, b] = await Promise.all([api.summary(), api.products()]);
      setSummary(s); setBoard(b); setError('');
    } catch (e) { setError(e.message); }
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
      <TopBar summary={summary} onToggleDryRun={toggleDryRun} onSettings={() => setDrawer(true)} onNew={() => setComposer(true)} />
      {error && <div className="banner error" role="alert">{error}</div>}
      <Board board={board} onOpen={setOpenId} />
      {drawer && <SettingsDrawer onClose={() => { setDrawer(false); refresh(); }} askConfirm={setConfirm} />}
      {composer && <Composer onClose={() => { setComposer(false); refresh(); }} onChanged={refresh} onOpen={(id) => { setComposer(false); setOpenId(id); }} />}
      {openId !== null && <ProductDrawer id={openId} onClose={() => { setOpenId(null); refresh(); }} onChanged={refresh} />}
      {confirm && <ConfirmModal {...confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}
