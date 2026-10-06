import React, { useCallback, useEffect, useState } from 'react';
import './playbooks.css';

// Playbook checklists. Scope is global (productId 0) or one product; tick state persists server-side.
// Props: api (makeWatchApi()), initialId/initialProductId (e.g. from an alert), products (optional [{id,title}] for the scope picker).
export default function PlaybooksView({ api, initialId, initialProductId = 0, products = [] }) {
  const [list, setList] = useState([]);
  const [id, setId] = useState(initialId || null);
  const [productId, setProductId] = useState(initialProductId || 0);
  const [pb, setPb] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => { api.playbooks().then(r => { setList(r.playbooks); setId(cur => cur || (r.playbooks[0] && r.playbooks[0].id)); }).catch(e => setError(e.message)); }, [api]);
  useEffect(() => { if (initialId) setId(initialId); setProductId(initialProductId || 0); }, [initialId, initialProductId]);
  const load = useCallback(async () => { if (!id) return; try { setPb(await api.playbook(id, productId)); setError(''); } catch (e) { setError(e.message); } }, [api, id, productId]);
  useEffect(() => { load(); }, [load]);

  const tick = async (stepId, checked) => { try { await api.tick(id, stepId, checked, productId); await load(); } catch (e) { setError(e.message); } };

  return (
    <div className="playbooks">
      <nav aria-label="Playbooks">
        {list.map(p => <button key={p.id} className={p.id === id ? 'active' : ''} onClick={() => setId(p.id)}>{p.title}</button>)}
      </nav>
      <div className="detail">
        {error && <div className="banner error" role="alert">{error}</div>}
        {!pb ? <div className="empty">Loading...</div> : (
          <>
            <h2>{pb.title}</h2>
            <p><strong>When to use:</strong> {pb.whenToUse}</p>
            <div className="row">
              <label className="small muted" htmlFor="pb-scope">Checklist for</label>
              <select id="pb-scope" value={productId} onChange={e => setProductId(Number(e.target.value))}>
                <option value={0}>Global (no product)</option>
                {products.map(p => <option key={p.id} value={p.id}>{p.title || `Product ${p.id}`}</option>)}
                {productId !== 0 && !products.some(p => p.id === productId) && <option value={productId}>Product {productId}</option>}
              </select>
              <span className="muted small">{pb.done}/{pb.total} done</span>
              <button className="ghost" onClick={async () => { await api.resetPlaybook(id, productId); load(); }}>Reset</button>
            </div>
            <ol>
              {pb.steps.map(s => (
                <li key={s.id}>
                  <input type="checkbox" checked={s.checked} onChange={e => tick(s.id, e.target.checked)} aria-label={s.title} />
                  <div>
                    <div>{s.title}</div>
                    {s.detail && <div className="muted small">{s.detail}</div>}
                    {s.checkResult && <span className={`check ${s.checkResult.status}`} title={s.checkResult.detail}>{s.checkResult.status}: {s.checkResult.detail}</span>}
                  </div>
                </li>
              ))}
            </ol>
            <h3>Background</h3>
            <div className="background">{pb.background}</div>
          </>
        )}
      </div>
    </div>
  );
}
