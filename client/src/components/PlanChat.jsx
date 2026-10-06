import React, { useCallback, useEffect, useRef, useState } from 'react';

const TIERS = [['cheap', 'Cheap'], ['standard', 'Standard'], ['deep', 'Deep']];

async function getJson(method, url, body) {
  const res = await fetch(url, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  let data = null; try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) throw Object.assign(new Error((data && data.error) || `HTTP ${res.status}`), { status: res.status, code: data && data.code });
  return data;
}

// Words for the failures a person can act on; anything else shows the server's own message.
function explain(e) {
  if (e.code === 'no_funding' || e.status === 402) return `Not funded: ${e.message} Add your own API key or ask for credits in cortex, then try again.`;
  if (e.code === 'unreachable') return `${e.message} Nothing was sent or spent.`;
  return e.message;
}

// Planning chat: niches, pricing, what to make next. Takes no actions; the model call is billed by cortex.
export default function PlanChat() {
  const [list, setList] = useState(null); const [meta, setMeta] = useState({});
  const [sel, setSel] = useState(null); const [messages, setMessages] = useState([]);
  const [tier, setTier] = useState('standard'); const [text, setText] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const endRef = useRef(null);

  const loadList = useCallback(() => getJson('GET', '/api/plan').then((r) => { setList(r.conversations); setMeta({ provider: r.provider, billed: r.billed }); }).catch((e) => setErr(explain(e))), []);
  useEffect(() => { loadList(); }, [loadList]);
  useEffect(() => { if (endRef.current && endRef.current.scrollIntoView) endRef.current.scrollIntoView({ block: 'end' }); }, [messages]);

  async function open(id) {
    setErr(''); setSel(id);
    if (!id) { setMessages([]); return; }
    try { const r = await getJson('GET', `/api/plan/${id}`); setMessages(r.messages); setTier(r.conversation.tier); } catch (e) { setErr(explain(e)); }
  }
  async function remove() {
    if (!sel) return;
    try { await getJson('DELETE', `/api/plan/${sel}`); setSel(null); setMessages([]); loadList(); } catch (e) { setErr(explain(e)); }
  }

  async function send() {
    const content = text.trim();
    if (!content || busy) return;
    setErr(''); setBusy(true);
    let id = sel;
    try {
      if (!id) { id = (await getJson('POST', '/api/plan', { tier })).conversation.id; setSel(id); }
      setMessages((m) => [...m, { role: 'user', content }, { role: 'assistant', content: '', pending: true }]);
      setText('');
      const res = await fetch(`/api/plan/${id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content, tier }), credentials: 'same-origin' });
      if (!res.ok) {
        let d = null; try { d = await res.json(); } catch { /* */ }
        throw Object.assign(new Error((d && d.error) || `HTTP ${res.status}`), { status: res.status, code: d && d.code });
      }
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ''; let failure = null;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          for (const line of block.split('\n')) {
            if (!line.startsWith('data:')) continue;
            let ev; try { ev = JSON.parse(line.slice(5)); } catch { continue; }
            if (ev.text) setMessages((m) => m.map((x, k) => (k === m.length - 1 ? { ...x, content: x.content + ev.text } : x)));
            if (ev.error) failure = Object.assign(new Error(ev.error), { code: ev.code });
          }
        }
      }
      if (failure) throw failure;
      setMessages((m) => m.map((x) => ({ ...x, pending: false })));
      loadList();
    } catch (e) {
      // Drop the empty placeholder; keep what was typed so it can be re-sent.
      setMessages((m) => m.filter((x) => !(x.pending && !x.content)).map((x) => ({ ...x, pending: false })));
      setText((t) => t || content); setErr(explain(e));
    } finally { setBusy(false); }
  }

  return (
    <main className="board" style={{ display: 'block' }}>
      <h3>Plan</h3>
      <div className="small muted">Think through niches, pricing and what to make next. The chat sees your fee settings, product counts, recent products and sales, and takes no actions.{meta.billed ? ` ${meta.billed}.` : ''}</div>
      {meta.provider === 'stub' && <div className="banner warn-banner" role="status">No model is connected: replies are placeholders. Set INTERNAL_SECRET to use cortex.</div>}
      {err && <div className="banner error" role="alert">{err}</div>}
      <div className="row" style={{ flexWrap: 'wrap', margin: '8px 0' }}>
        <button className={`ghost ${sel === null ? 'active' : ''}`} onClick={() => open(null)}>New chat</button>
        {(list || []).map((c) => <button key={c.id} className={`ghost ${sel === c.id ? 'active' : ''}`} onClick={() => open(c.id)}>{c.title || `Chat ${c.id}`}</button>)}
        {sel && <button className="danger" onClick={remove}>Delete chat</button>}
      </div>
      <section aria-live="polite" style={{ minHeight: 160, maxHeight: '55vh', overflowY: 'auto', margin: '8px 0' }}>
        {messages.length === 0 && <div className="muted">Ask something, e.g. "Which of my niches should I make more of, and at what price?"</div>}
        {messages.map((m, i) => (
          <div key={m.id || i} className="card" style={{ cursor: 'default', whiteSpace: 'pre-wrap', marginLeft: m.role === 'user' ? 40 : 0 }}>
            <div className="small muted">{m.role === 'user' ? 'You' : `Adviser${m.model ? ` (${m.model})` : ''}`}</div>
            {m.content || (m.pending ? 'thinking...' : '')}
          </div>
        ))}
        <div ref={endRef} />
      </section>
      <div className="row">
        <label className="small">Depth{' '}
          <select value={tier} onChange={(e) => setTier(e.target.value)} disabled={busy} aria-label="Model tier">
            {TIERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={4000} style={{ flex: 1 }} placeholder="Ask about niches, pricing, what to make next..." aria-label="Message"
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(); }} />
        <button onClick={send} disabled={busy || !text.trim()}>{busy ? 'Waiting...' : 'Send'}</button>
      </div>
    </main>
  );
}
