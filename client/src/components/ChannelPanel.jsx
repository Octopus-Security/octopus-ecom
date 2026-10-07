import React, { useCallback, useEffect, useState } from 'react';
import { api, dollars } from '../api.js';

const STATE_LABEL = { not_listed: 'not listed', uploaded: 'uploaded', live: 'live', removed: 'removed' };
const cls = (s) => (s === 'live' ? 'pos' : s === 'uploaded' ? 'warn' : s === 'removed' ? 'neg' : 'muted');

export function CopyButton({ text, label = 'Copy' }) {
  const [done, setDone] = useState(false);
  return (
    <button className="ghost small" type="button" onClick={async () => {
      try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); } catch { window.prompt('Copy this text', text); }
    }}>{done ? 'Copied' : label}</button>
  );
}

function Field({ label, value, rows }) {
  return (
    <div className="chan-field">
      <div className="row between"><strong className="small">{label}</strong><CopyButton text={value} /></div>
      {rows ? <textarea readOnly rows={rows} value={value} onFocus={(e) => e.target.select()} /> : <input readOnly value={value} onFocus={(e) => e.target.select()} />}
    </div>
  );
}

// Redbubble is a MANUAL channel: ecom prepares the pack, the owner uploads by hand. Nothing here talks to Redbubble.
export default function ChannelPanel({ id, onChanged, onOpenPlaybook }) {
  const [ch, setCh] = useState(null);
  const [pack, setPack] = useState(null);
  const [url, setUrl] = useState('');
  const [markup, setMarkup] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => { try { setCh(await api.productChannels(id)); } catch (e) { setErr(e.message); } }, [id]);
  useEffect(() => { load(); }, [load]);

  async function openPack() {
    setBusy('pack'); setErr('');
    try { setPack(await api.redbubblePack(id, markup)); } catch (e) { setErr(e.message); setPack(null); } finally { setBusy(''); }
  }
  async function setState(state, extra = {}) {
    setBusy(state); setErr('');
    try { await api.setChannelState(id, 'redbubble', { state, ...extra }); await load(); if (pack) setPack(await api.redbubblePack(id, markup)); if (onChanged) onChanged(); }
    catch (e) { setErr(e.message); } finally { setBusy(''); }
  }

  if (!ch) return <section><h4>Channels</h4>{err ? <div className="banner error">{err}</div> : <div className="muted small">loading...</div>}</section>;
  const rb = ch.states.redbubble; const et = ch.states.etsy; const sales = ch.sales || {};
  const money = (c) => (c ? `${dollars(c.netAfterFeesCents)} from ${c.lines} line(s)` : 'no sales yet');
  return (
    <section>
      <h4>Channels</h4>
      <div className="small">Etsy <span className="muted">(automatic: published through Printify when you approve)</span>: <span className={cls(et.state)}>{STATE_LABEL[et.state]}</span> - {money(sales.etsy)}</div>
      <div className="small">Redbubble <span className="muted">(manual: ecom prepares, you upload)</span>: <span className={cls(rb.state)}>{STATE_LABEL[rb.state]}</span> - {money(sales.redbubble)}
        {rb.url && <> - <a href={rb.url} target="_blank" rel="noreferrer">work page</a></>}</div>
      {err && <div className="banner error" role="alert">{err}</div>}
      <div className="row">
        <button className="ghost" disabled={!!busy} onClick={openPack}>{busy === 'pack' ? 'Preparing...' : pack ? 'Refresh Redbubble pack' : 'Redbubble pack...'}</button>
        <a className="ghost button" href={`/api/products/${id}/redbubble/pack.zip`} download>Download pack (zip)</a>
        {onOpenPlaybook && <>
          <button className="ghost" onClick={() => onOpenPlaybook('redbubble-publish', id)}>Playbook: publish</button>
          <button className="ghost" onClick={() => onOpenPlaybook('redbubble-revive', 0)}>Playbook: revive account</button>
        </>}
      </div>
      <div className="muted small">The zip carries the design PNG at Redbubble's size, title, tags, description, markup, product types and a checklist. There is no Redbubble upload API, and its rules reportedly forbid bots, so a person uploads: see docs/CHANNELS.md.</div>

      {pack && (
        <div className="chan-pack">
          <h4>Folder view</h4>
          <div className="small">
            Image: stored {pack.image.stored.width}x{pack.image.stored.height}px; pack file {pack.image.planned.width}x{pack.image.planned.height}px{pack.image.planned.upscaled ? ' (upscaled: adds pixels, not detail)' : ' (no upscale)'}; Redbubble recommends {pack.image.recommended.width}x{pack.image.recommended.height}px for large products. <a href={pack.image.url} download>Download just the PNG</a>
          </div>
          {pack.notes.map((n, i) => <div className="small warn" key={i}>{n}</div>)}
          <Field label={`Title (${[...pack.copy.title].length}/${pack.limits.maxTitle})`} value={pack.copy.title} />
          <Field label="Main tag" value={pack.copy.mainTag} />
          <Field label={`Supporting tags (${pack.copy.supportingTags.length}, max ${pack.limits.maxTags - 1})`} value={pack.copy.supportingTags.join(', ')} rows={3} />
          <Field label={`Description (${[...pack.copy.description].length}, kept under ${pack.limits.descSafe})`} value={pack.copy.description} rows={4} />
          <div className="row">
            <label className="grow">Markup %<input type="number" min="0" max="100" value={markup === '' ? pack.markupPct : markup} onChange={(e) => setMarkup(e.target.value)} onBlur={openPack} /></label>
            <CopyButton text={`${pack.markupPct}%`} label="Copy markup" />
          </div>
          <div className="muted small">{pack.markupNote}</div>

          <h4>Lint {pack.lint.ok ? <span className="pos small">clean</span> : <span className="neg small">{pack.lint.errors.length} problem(s)</span>}</h4>
          {pack.lint.errors.map((e, i) => <div className="small neg" key={i}>{e.field}: {e.detail}</div>)}
          {pack.lint.warnings.map((e, i) => <div className="small warn" key={i}>{e.field}: {e.detail}</div>)}
          {pack.copy.repairs.length > 0 && <details><summary className="small">{pack.copy.repairs.length} adaptation note(s)</summary><ul className="small">{pack.copy.repairs.map((r, i) => <li key={i}>{r.field}: {r.detail}</li>)}</ul></details>}
          <div className="muted small">Limits: tags {pack.sources.tags}. Title {pack.sources.title}. Description {pack.sources.description}.</div>

          <h4>Product types</h4>
          <ul className="small">{pack.productTypes.map((t) => <li key={t.id} className={t.status === 'enable' ? 'pos' : t.status === 'disable' ? 'neg' : 'warn'}><strong>{t.status.toUpperCase()}</strong> {t.label}: {t.reason}</li>)}</ul>
          <div className="muted small">Sizes per product: {pack.sources.productTypes}.</div>

          <h4>Checklist for this design</h4>
          <ol className="small">{pack.checklist.map((s) => <li key={s.id}>{s.text}</li>)}</ol>
        </div>
      )}

      <h4>Redbubble state</h4>
      <div className="row">
        {rb.state === 'not_listed' && <button disabled={!!busy} onClick={() => setState('uploaded')}>Mark uploaded</button>}
        {rb.state === 'removed' && <button disabled={!!busy} onClick={() => setState('uploaded')}>Mark re-uploaded</button>}
        {rb.state === 'uploaded' && <button className="ghost" disabled={!!busy} onClick={() => setState('not_listed')}>Undo (not listed)</button>}
        {rb.state === 'live' && <button className="ghost" disabled={!!busy} onClick={() => setState('removed')}>Mark removed</button>}
      </div>
      {rb.state === 'uploaded' && (
        <div className="row">
          <label className="grow">Work URL (copy it from the live work's address bar)<input value={url} placeholder="https://www.redbubble.com/i/..." onChange={(e) => setUrl(e.target.value)} /></label>
          <button disabled={!!busy || !url.trim()} onClick={() => setState('live', { url, title: pack ? pack.copy.title : undefined })}>Mark live</button>
        </div>)}
    </section>
  );
}
