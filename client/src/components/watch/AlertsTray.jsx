import React, { useCallback, useEffect, useState } from 'react';
import './watch.css';

// Count badge + dropdown list. Mount it in the top bar: <AlertsTray api={watchApi} onOpenPlaybook={(id, productId) => ...} />
export default function AlertsTray({ api, onOpenPlaybook, pollMs = 30000 }) {
  const [data, setData] = useState({ alerts: [], open: 0, bySeverity: { info: 0, warn: 0, critical: 0 } });
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try { setData(await api.alerts(false)); setError(''); } catch (e) { setError(e.message); }
  }, [api]);
  useEffect(() => { load(); const t = setInterval(load, pollMs); return () => clearInterval(t); }, [load, pollMs]);

  const act = async (fn) => { try { await fn(); await load(); } catch (e) { setError(e.message); } };
  const crit = data.bySeverity.critical > 0;

  return (
    <div className="alerts-tray">
      <button className="ghost bell" onClick={() => setOpen(o => !o)} aria-expanded={open} aria-label={`Alerts, ${data.open} open`}>
        Alerts<span className={`badge ${crit ? 'crit' : data.open ? 'has' : ''}`}>{data.open}</span>
      </button>
      {open && (
        <div className="alerts-pop" role="dialog" aria-label="Alerts">
          <div className="row between">
            <strong>Alerts</strong>
            <span className="row">
              <button className="ghost" onClick={() => act(() => api.runNow())}>Run watchers now</button>
              <button className="ghost" disabled={!data.open} onClick={() => act(() => api.ackAll())}>Acknowledge all</button>
            </span>
          </div>
          {error && <div className="banner error" role="alert">{error}</div>}
          {data.alerts.length === 0 && <div className="empty">No open alerts.</div>}
          {data.alerts.map(a => (
            <div key={a.id} className={`alert-item ${a.severity}`}>
              <div>{a.message}</div>
              <div className="meta">{a.severity} - {a.kind}{a.productId ? ` - product ${a.productId}` : ''} - {new Date(a.created).toLocaleString()}</div>
              <div className="row">
                {a.playbookId && onOpenPlaybook && <button className="ghost" onClick={() => { setOpen(false); onOpenPlaybook(a.playbookId, a.productId); }}>Open playbook</button>}
                <button className="ghost" onClick={() => act(() => api.ack(a.id))}>Acknowledge</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
