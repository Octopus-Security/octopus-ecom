import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

const VIEW_MAX = 1024;
const FONT_STACK = {
  sans: 'system-ui, sans-serif',
  heavy: 'Impact, "Arial Black", sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, monospace',
};

function traceStamp(ctx, kind, r) {
  ctx.beginPath();
  if (kind === 'heart') {
    ctx.moveTo(0, r * 0.35);
    ctx.bezierCurveTo(-r, -r * 0.25, -r * 0.15, -r, 0, -r * 0.35);
    ctx.bezierCurveTo(r * 0.15, -r, r, -r * 0.25, 0, r * 0.35);
  } else if (kind === 'spark') {
    for (let i = 0; i < 8; i++) {
      const rad = i % 2 === 0 ? r : r * 0.28;
      const a = -Math.PI / 2 + i * Math.PI / 4;
      const x = Math.cos(a) * rad; const y = Math.sin(a) * rad;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
  } else if (kind === 'banner') {
    const w = r * 1.4; const h = r * 0.45; const cr = Math.min(12, h / 2);
    ctx.moveTo(-w + cr, -h);
    ctx.lineTo(w - cr, -h); ctx.quadraticCurveTo(w, -h, w, -h + cr);
    ctx.lineTo(w, h - cr); ctx.quadraticCurveTo(w, h, w - cr, h);
    ctx.lineTo(-w + cr, h); ctx.quadraticCurveTo(-w, h, -w, h - cr);
    ctx.lineTo(-w, -h + cr); ctx.quadraticCurveTo(-w, -h, -w + cr, -h);
  } else {
    for (let i = 0; i < 10; i++) {
      const rad = i % 2 === 0 ? r : r * 0.42;
      const a = -Math.PI / 2 + i * Math.PI / 5;
      const x = Math.cos(a) * rad; const y = Math.sin(a) * rad;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
  }
  ctx.closePath();
}

function drawItem(ctx, item, sx) {
  const x = item.x * sx; const y = item.y * sx; const size = item.size * sx;
  ctx.save();
  if (item.type === 'text') {
    ctx.font = `${Math.max(8, size)}px ${FONT_STACK[item.font] || FONT_STACK.sans}`;
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.lineWidth = Math.max(2 * sx, size / 8);
    ctx.strokeStyle = '#111';
    ctx.fillStyle = item.color || '#ffffff';
    ctx.strokeText(item.text, x, y);
    ctx.fillText(item.text, x, y);
  } else {
    ctx.translate(x, y);
    ctx.fillStyle = item.color || '#f2c14e';
    ctx.strokeStyle = '#111';
    ctx.lineWidth = Math.max(1, size / 14);
    ctx.lineJoin = 'round';
    traceStamp(ctx, item.kind, size);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function hitItem(item, x, y) {
  if (item.type === 'text') {
    const w = Math.max(item.size, item.text.length * item.size * 0.55);
    return x >= item.x && x <= item.x + w && y >= item.y - item.size * 0.6 && y <= item.y + item.size * 0.6;
  }
  const dx = x - item.x; const dy = y - item.y;
  return dx * dx + dy * dy <= item.size * item.size;
}

export default function Studio({ design, productId, disabled, busy, onUpload, onRedraw, onSticker }) {
  const canvasRef = useRef(null);
  const maskRef = useRef(null);
  const tintRef = useRef(null);
  const imgRef = useRef(null);
  const itemsRef = useRef([]);
  const viewRef = useRef({ viewW: 1, viewH: 1 });
  const toolRef = useRef('move');
  const textRef = useRef('');
  const colorRef = useRef('#ffffff');
  const sizeRef = useRef(64);
  const kindRef = useRef('star');
  const brushRef = useRef(28);
  const fontRef = useRef('heavy');
  const drawing = useRef(null);
  const drag = useRef(null);
  const historyRef = useRef([]);

  const [img, setImg] = useState(null);
  const [view, setView] = useState({ viewW: 1, viewH: 1 });
  const [items, setItems] = useState([]);
  const [tool, setTool] = useState('move');
  const [text, setText] = useState('');
  const [color, setColor] = useState('#ffffff');
  const [size, setSize] = useState(64);
  const [kind, setKind] = useState('star');
  const [brush, setBrush] = useState(28);
  const [font, setFont] = useState('heavy');
  const [historyN, setHistoryN] = useState(0);
  const [prompt, setPrompt] = useState('');
  const [localErr, setLocalErr] = useState('');
  const [stickers, setStickers] = useState(null);
  const [stickerId, setStickerId] = useState('');

  itemsRef.current = items;
  toolRef.current = tool;
  textRef.current = text;
  colorRef.current = color;
  sizeRef.current = size;
  kindRef.current = kind;
  brushRef.current = brush;
  fontRef.current = font;

  useEffect(() => {
    let cancel = false;
    const im = new Image();
    im.onload = () => { if (!cancel) setImg(im); };
    im.onerror = () => { if (!cancel) setLocalErr('The design image did not load.'); };
    im.src = design.url;
    return () => { cancel = true; };
  }, [design.url]);

  useEffect(() => {
    if (!img) return;
    const long = Math.max(img.naturalWidth, img.naturalHeight);
    const scale = long > VIEW_MAX ? VIEW_MAX / long : 1;
    const viewW = Math.max(1, Math.round(img.naturalWidth * scale));
    const viewH = Math.max(1, Math.round(img.naturalHeight * scale));
    const mask = document.createElement('canvas');
    mask.width = viewW; mask.height = viewH;
    maskRef.current = mask;
    const tint = document.createElement('canvas');
    tint.width = viewW; tint.height = viewH;
    tintRef.current = tint;
    imgRef.current = img;
    viewRef.current = { viewW, viewH };
    setView({ viewW, viewH });
    historyRef.current = [];
    setHistoryN(0);
    setItems([]);
    setSize(Math.max(18, Math.round(img.naturalWidth / 14)));
    setLocalErr('');
  }, [img]);

  useEffect(() => {
    let cancel = false;
    api.blueprints().then((r) => {
      if (cancel) return;
      const list = (r.blueprints || []).filter((b) => /\bstickers?\b/i.test(b.title || ''));
      setStickers(list);
      if (list[0]) setStickerId(String(list[0].id));
    }).catch(() => { if (!cancel) setStickers([]); });
    return () => { cancel = true; };
  }, []);

  function paint() {
    const canvas = canvasRef.current;
    const image = imgRef.current;
    const frame = viewRef.current;
    if (!canvas || !image || !frame) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, frame.viewW, frame.viewH);
    ctx.drawImage(image, 0, 0, frame.viewW, frame.viewH);
    const sx = frame.viewW / image.naturalWidth;
    for (const item of itemsRef.current) drawItem(ctx, item, sx);
    const mask = maskRef.current;
    const tint = tintRef.current;
    if (!mask || !tint) return;
    const tctx = tint.getContext('2d');
    tctx.globalCompositeOperation = 'source-over';
    tctx.clearRect(0, 0, frame.viewW, frame.viewH);
    tctx.drawImage(mask, 0, 0);
    tctx.globalCompositeOperation = 'source-in';
    tctx.fillStyle = 'rgba(220, 40, 40, 0.45)';
    tctx.fillRect(0, 0, frame.viewW, frame.viewH);
    ctx.drawImage(tint, 0, 0);
  }

  useEffect(() => { paint(); });

  function eventNatural(e) {
    const canvas = canvasRef.current;
    const image = imgRef.current;
    const rect = canvas.getBoundingClientRect();
    const vx = (e.clientX - rect.left) * canvas.width / rect.width;
    const vy = (e.clientY - rect.top) * canvas.height / rect.height;
    return { x: vx * image.naturalWidth / canvas.width, y: vy * image.naturalHeight / canvas.height, vx, vy };
  }

  function stroke(x0, y0, x1, y1) {
    const mask = maskRef.current;
    if (!mask) return;
    const ctx = mask.getContext('2d');
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Number(brushRef.current);
    ctx.strokeStyle = '#fff';
    ctx.globalCompositeOperation = toolRef.current === 'eraser' ? 'destination-out' : 'source-over';
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    paint();
  }

  function remember() {
    historyRef.current.push(itemsRef.current.map((item) => ({ ...item })));
    if (historyRef.current.length > 30) historyRef.current.shift();
    setHistoryN(historyRef.current.length);
  }

  function undo() {
    const prev = historyRef.current.pop();
    setHistoryN(historyRef.current.length);
    if (prev) setItems(prev);
  }

  function onPointerDown(e) {
    if (disabled || !imgRef.current) return;
    e.preventDefault();
    canvasRef.current.setPointerCapture(e.pointerId);
    const nat = eventNatural(e);
    const current = toolRef.current;
    if (current === 'brush' || current === 'eraser') {
      drawing.current = { x: nat.vx, y: nat.vy };
      stroke(nat.vx, nat.vy, nat.vx, nat.vy);
      return;
    }
    if (current === 'move') {
      const list = itemsRef.current;
      for (let i = list.length - 1; i >= 0; i--) {
        if (hitItem(list[i], nat.x, nat.y)) { drag.current = { i, dx: nat.x - list[i].x, dy: nat.y - list[i].y, saved: false }; return; }
      }
      return;
    }
    if (current === 'text') {
      const words = textRef.current.trim();
      if (!words) { setLocalErr('Type the words first.'); return; }
      setLocalErr('');
      remember();
      setItems((list) => [...list, { type: 'text', text: words, color: colorRef.current, size: Number(sizeRef.current), font: fontRef.current, x: nat.x, y: nat.y }]);
      return;
    }
    setLocalErr('');
    remember();
    setItems((list) => [...list, { type: 'stamp', kind: kindRef.current, color: colorRef.current, size: Number(sizeRef.current), x: nat.x, y: nat.y }]);
  }

  function onPointerMove(e) {
    if (disabled) return;
    if (!drawing.current && !drag.current) return;
    const nat = eventNatural(e);
    if (drawing.current) {
      stroke(drawing.current.x, drawing.current.y, nat.vx, nat.vy);
      drawing.current = { x: nat.vx, y: nat.vy };
      return;
    }
    const { i, dx, dy } = drag.current;
    if (!drag.current.saved) { drag.current.saved = true; remember(); }
    setItems((list) => list.map((item, idx) => (idx === i ? { ...item, x: nat.x - dx, y: nat.y - dy } : item)));
  }

  function onPointerUp() { drawing.current = null; drag.current = null; }

  function clearMarks() {
    const mask = maskRef.current;
    const frame = viewRef.current;
    if (mask) mask.getContext('2d').clearRect(0, 0, frame.viewW, frame.viewH);
    setLocalErr('');
    paint();
  }

  async function flatten() {
    const image = imgRef.current;
    if (!image) return null;
    const off = document.createElement('canvas');
    off.width = image.naturalWidth;
    off.height = image.naturalHeight;
    const ctx = off.getContext('2d');
    ctx.drawImage(image, 0, 0);
    for (const item of itemsRef.current) drawItem(ctx, item, 1);
    return new Promise((resolve) => off.toBlob((blob) => resolve(blob), 'image/png'));
  }

  async function savePrint() {
    setLocalErr('');
    const blob = await flatten();
    if (!blob) { setLocalErr('Could not build the PNG.'); return; }
    await onUpload(new File([blob], `design-${productId}.png`, { type: 'image/png' }));
  }

  async function downloadView() {
    setLocalErr('');
    const blob = await flatten();
    if (!blob) { setLocalErr('Could not build the PNG.'); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `design-${productId}.png`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function exportMask() {
    const image = imgRef.current;
    const mask = maskRef.current;
    if (!image || !mask) return null;
    const src = mask.getContext('2d').getImageData(0, 0, mask.width, mask.height).data;
    let marked = 0;
    for (let i = 0; i < src.length; i += 4) if (src[i] > 127 && src[i + 3] > 127) marked++;
    const total = mask.width * mask.height;
    if (marked === 0) { setLocalErr('Paint the area to redraw first.'); return null; }
    if (marked / total > 0.7) { setLocalErr('That mark covers most of the image. Use Regenerate for the whole design.'); return null; }
    const off = document.createElement('canvas');
    off.width = image.naturalWidth;
    off.height = image.naturalHeight;
    const ctx = off.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, off.width, off.height);
    ctx.drawImage(mask, 0, 0, off.width, off.height);
    return new Promise((resolve) => off.toBlob((blob) => resolve(blob), 'image/png'));
  }

  async function redraw() {
    const words = prompt.trim();
    if (words.length < 8 || words.length > 400) { setLocalErr('Describe the change in 8 to 400 characters.'); return; }
    if (itemsRef.current.length) { setLocalErr('Save the text and stickers first, or remove them. A redraw uses the saved file.'); return; }
    setLocalErr('');
    const blob = await exportMask();
    if (!blob) return;
    await onRedraw(new File([blob], 'mask.png', { type: 'image/png' }), words);
  }

  async function sticker() {
    if (!stickerId) { setLocalErr(stickers && stickers.length === 0 ? 'No sticker blueprint is in the catalog.' : 'Pick a sticker.'); return; }
    setLocalErr('');
    if (itemsRef.current.length) {
      const blob = await flatten();
      if (!blob) { setLocalErr('Could not build the PNG.'); return; }
      const saved = await onUpload(new File([blob], `design-${productId}.png`, { type: 'image/png' }));
      if (!saved) return;
    }
    await onSticker(stickerId);
  }

  const locked = disabled || !img;
  const tools = [['move', 'Move'], ['text', 'Text'], ['stamp', 'Sticker'], ['brush', 'Mark'], ['eraser', 'Eraser']];

  return (
    <section className="studio" aria-label="Studio">
      <h4>Studio</h4>
      <div className="muted small">Unmarked pixels stay as stored. Marked pixels are redrawn by Nous klein edit and cost a real image even while dry run is on. Text and stickers are not part of a redraw until you save them. A sticker product uses the latest saved file.</div>
      {design.upscaleMethod && <div className="warn small">Letters and stickers you add here stay sharp. The picture was enlarged from {design.nativeWidth}×{design.nativeHeight} and will not get sharper.</div>}
      <div className="studio-stage">
        <canvas ref={canvasRef} width={view.viewW} height={view.viewH} aria-label="Design canvas"
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} />
      </div>
      <div className="row" role="toolbar" aria-label="Studio tools">
        {tools.map(([id, label]) => (
          <button key={id} type="button" className="ghost" aria-pressed={tool === id} disabled={locked} onClick={() => { setTool(id); setLocalErr(''); }}>{label}</button>
        ))}
      </div>
      <div className="row">
        <label className="grow">Words<input value={text} maxLength={80} disabled={locked} onChange={(e) => setText(e.target.value)} /></label>
        <label>Colour<input type="color" value={color} disabled={locked} onChange={(e) => setColor(e.target.value)} /></label>
        <label>Size<input type="number" min="12" max="800" value={size} disabled={locked} onChange={(e) => setSize(Number(e.target.value) || 12)} /></label>
        <label>Font
          <select value={font} disabled={locked} onChange={(e) => setFont(e.target.value)}>
            <option value="heavy">Heavy</option>
            <option value="sans">Sans</option>
            <option value="serif">Serif</option>
            <option value="mono">Mono</option>
          </select>
        </label>
      </div>
      <div className="row">
        <label>Stamp
          <select value={kind} disabled={locked} onChange={(e) => setKind(e.target.value)}>
            <option value="star">Star</option>
            <option value="heart">Heart</option>
            <option value="spark">Spark</option>
            <option value="banner">Banner</option>
          </select>
        </label>
        <label className="grow">Brush<input type="range" min="8" max="96" value={brush} disabled={locked} onChange={(e) => setBrush(Number(e.target.value))} /></label>
        <button type="button" className="ghost" disabled={locked || historyN === 0} onClick={undo}>Undo</button>
        <button type="button" className="ghost" disabled={locked || items.length === 0} onClick={() => { remember(); setItems((list) => list.slice(0, -1)); }}>Remove last</button>
        <button type="button" className="ghost" disabled={locked} onClick={clearMarks}>Clear marks</button>
      </div>
      <div className="row">
        <button type="button" disabled={locked} onClick={savePrint}>{busy === 'upload' ? 'Saving...' : 'Save as print file'}</button>
        <button type="button" className="ghost" disabled={locked} onClick={downloadView}>Download this view</button>
      </div>
      <label>What to change in the marked area
        <textarea rows={2} maxLength={400} value={prompt} disabled={locked} onChange={(e) => setPrompt(e.target.value)} />
      </label>
      <div className="row">
        <button type="button" disabled={locked || prompt.trim().length < 8} onClick={redraw}>{busy === 'redraw' ? 'Redrawing...' : 'Redraw marked area'}</button>
        <span className="muted small">This spends an image. The rest of the picture is kept.</span>
      </div>
      <div className="row">
        {stickers === null ? <span className="muted small">Looking up stickers...</span>
          : stickers.length === 0 ? <span className="muted small">No sticker blueprint is in the catalog.</span>
            : (
              <label className="grow">Sticker
                <select value={stickerId} disabled={locked} onChange={(e) => setStickerId(e.target.value)}>
                  {stickers.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}
                </select>
              </label>
            )}
        <button type="button" disabled={locked || !stickerId} onClick={sticker}>{busy === 'sticker' ? 'Starting...' : 'Start sticker product'}</button>
      </div>
      {localErr && <div className="banner error" role="alert">{localErr}</div>}
    </section>
  );
}
