'use strict';
/**
 * channels/redbubble.js — the Redbubble upload pack. MANUAL channel: this file prepares, a human uploads.
 *
 * Why manual (researched 2026-10-06, see docs/CHANNELS.md):
 *   - No public or partner API for uploading or listing works exists (corroborated: search results; the only API integration found
 *     is order fulfilment for print partners, via Redbubble's Foundry).
 *   - Redbubble's Community and Content Guidelines are reported (search-result summary; page not read, HTTP 403) to prohibit uploading
 *     with "any bot, scraper, or other automated means" without written permission. So there is NO browser automation, login, or scraping
 *     here, and none is to be added without the owner's decision AND Redbubble's written permission.
 *
 * The pack: the design PNG sized for Redbubble (real size reported), title / main tag / supporting tags / description adapted from the
 * Etsy copy and linted, a markup suggestion, which product types to enable, and a checklist specific to this design.
 */
const fs = require('node:fs');
const path = require('node:path');
const { fitToArea } = require('../upscale');
const { makeZip } = require('../zip');
const rules = require('../domain/redbubble-rules');

const CHANNEL = 'redbubble';
const START_URL = 'https://www.redbubble.com/portfolio/images/new'; // assumed path: confirm by clicking "Add new work" in your dashboard

const parse = (t, d) => { try { return JSON.parse(t); } catch { return d; } };
const mb = n => `${(n / 1048576).toFixed(1)} MB`;

function makeRedbubble({ db, dataDir, upscale = null, log = console, channelState, sales }) {
  const product = id => db.prepare('SELECT * FROM products WHERE id = ?').get(Number(id));
  const latestDesign = id => db.prepare('SELECT * FROM designs WHERE product_id = ? ORDER BY id DESC LIMIT 1').get(Number(id));
  const etsyCopy = id => {
    const l = db.prepare("SELECT title, tags, description FROM listings WHERE product_id = ? AND platform = 'etsy' ORDER BY (status='draft') DESC, id DESC LIMIT 1").get(Number(id));
    return l ? { title: l.title, tags: parse(l.tags, []), description: l.description } : null;
  };
  const err = (message, status, code) => Object.assign(new Error(message), { status, code, name: 'ChannelError' });

  function designFile(d) {
    const root = path.resolve(dataDir, 'images');
    const file = d && d.image_path ? path.resolve(root, d.image_path) : null;
    if (!file || !file.startsWith(root + path.sep) || !fs.existsSync(file)) throw err('The design file is missing from disk', 409, 'design_missing');
    return file;
  }

  /** The PNG for Redbubble: the stored design, upscaled to fit inside 7632x6480 when it is smaller (cached). Reports the REAL size read back from the file. */
  async function image(productId) {
    const d = latestDesign(productId);
    if (!d) throw err('This product has no design yet', 409, 'no_design');
    const src = designFile(d);
    const cacheDir = path.join(dataDir, 'channel-packs'); fs.mkdirSync(cacheDir, { recursive: true });
    const key = `rb-${d.id}-${upscale ? 'up' : 'raw'}.png`;
    const cached = path.join(cacheDir, key);
    const png = fs.readFileSync(src);
    let out;
    if (fs.existsSync(cached)) {
      const buf = fs.readFileSync(cached); const { readPngSize } = require('../png'); const sz = readPngSize(buf);
      out = { png: buf, width: sz.width, height: sz.height, nativeWidth: d.width, nativeHeight: d.height, upscaled: sz.width !== d.width || sz.height !== d.height, upscaleMethod: sz.width !== d.width || sz.height !== d.height ? 'cached (bilinear, pure JS; adds pixels, not detail)' : null };
    } else {
      out = await fitToArea({ png, width: rules.LIMITS.imageW, height: rules.LIMITS.imageH, upscale, log, tag: 'redbubble' });
      if (out.upscaled) fs.writeFileSync(cached, out.png);
    }
    const tooBig = out.width > rules.LIMITS.maxW || out.height > rules.LIMITS.maxH || out.png.length > rules.LIMITS.maxBytes;
    if (tooBig) throw err(`The image (${out.width}x${out.height}, ${mb(out.png.length)}) is over Redbubble's maximum of ${rules.LIMITS.maxW}x${rules.LIMITS.maxH}px / 300 MB`, 409, 'image_too_big');
    return { ...out, designId: d.id, source: d.source || 'generated', storedWidth: d.width, storedHeight: d.height, detailWidth: d.native_width || d.width, detailHeight: d.native_height || d.height, bytes: out.png.length };
  }

  function checklist({ p, copy, adv, markup, imgName, imgInfo, design, lint }) {
    const enable = adv.filter(a => a.status === 'enable').map(a => a.label);
    const caution = adv.filter(a => a.status === 'caution').map(a => a.label);
    const disable = adv.filter(a => a.status === 'disable').map(a => a.label);
    const ai = design.source === 'manual'
      ? 'This design was uploaded by you. If any AI tool made any part of it, tick the AI-generated checkbox. (The checkbox exists per search summaries; check the exact label in the form.)'
      : 'This design was made with an AI image model: tick the AI-generated checkbox on the upload form.';
    return [
      { id: 'open', text: `Sign in to Redbubble yourself (your own account; ecom never holds its password), then open Add new work (${START_URL}; path assumed, use the button in your dashboard if it differs).` },
      { id: 'file', text: `Upload ${imgName} (${imgInfo.width}x${imgInfo.height}px${imgInfo.upscaled ? `, upscaled from ${imgInfo.detailWidth}x${imgInfo.detailHeight}: adds pixels, not detail` : ''}). If Redbubble asks for a transparent PNG, this one is a PNG at its real size.` },
      { id: 'title', text: `Paste the title (${[...copy.title].length}/${rules.LIMITS.maxTitle} chars): ${copy.title}` },
      { id: 'tags', text: `Main tag: ${copy.mainTag || '(none)'}. Paste the supporting tags (${copy.supportingTags.length}), one at a time or comma separated, from tags.txt.` },
      { id: 'desc', text: `Paste the description (${[...copy.description].length} chars) from description.txt.` },
      { id: 'ai', text: ai },
      { id: 'rights', text: 'Tick the rights/originality confirmation only if it is true: the design is original and contains no brand, character, team or celebrity.' },
      { id: 'products', text: `Product types. Leave ON: ${enable.join('; ') || 'none (this image is too small for everything: stop and regenerate)'}.${caution.length ? ` Your call (image may look soft): ${caution.join('; ')}.` : ''}${disable.length ? ` Turn OFF: ${disable.join('; ')}.` : ''}` },
      { id: 'markup', text: `Set the markup to ${markup}%. Above 20% Redbubble takes 50% of the extra, so more rarely pays.` },
      { id: 'mature', text: 'Leave "mature content" off unless the design needs it.' },
      { id: 'save', text: 'Review the preview on a dark and a light product, then Save/Publish. If Redbubble offers to hold the work for review, wait.' },
      { id: 'url', text: 'Open the published work, copy its address from the browser, paste it into the Redbubble section of this product in ecom, and mark it LIVE (mark it UPLOADED first if you saved but it is not visible yet).' },
      { id: 'next', text: 'For the next design: use "Copy settings from existing work" then replace the image; it carries tags, markup and product toggles over (check the title and tags still fit the new design).' },
      ...(lint.errors.length ? [{ id: 'fix', text: `Before you upload: fix ${lint.errors.length} problem(s) listed under Lint.` }] : []),
    ];
  }

  /** The pack as data (JSON for the UI). Does not build the large PNG; `image.planned` says what the zip will contain. */
  function pack(productId, { markupPct } = {}) {
    const p = product(productId); if (!p) throw err('Not found', 404, 'not_found');
    const d = latestDesign(p.id); if (!d) throw err('This product has no design yet', 409, 'no_design');
    const etsy = etsyCopy(p.id);
    const copy = rules.adaptCopy({ etsy, keywords: parse(p.keywords, []), brief: p.brief, productTitle: p.title || '' });
    const lint = rules.lintCopy(copy, { db });
    const markup = Number.isFinite(markupPct) ? Math.min(Math.max(Math.round(markupPct), 0), 100) : rules.LIMITS.markupPct;
    const adv = rules.advise({ width: d.width, height: d.height, nativeWidth: d.native_width, nativeHeight: d.native_height });
    const planned = rules.plannedSize({ width: d.width, height: d.height, upscaleAvailable: Boolean(upscale) });
    const imgName = `redbubble-${p.id}-${planned.width}x${planned.height}.png`;
    const imgInfo = { ...planned, detailWidth: d.native_width || d.width, detailHeight: d.native_height || d.height };
    const flags = parse(p.flags, []);
    const notes = [];
    if (flags.length) notes.push(`This product carries ${flags.length} flag(s) (${flags.map(f => f.code).join(', ')}). Resolve them before listing anywhere.`);
    if (planned.upscaled) notes.push(`The stored design is ${d.width}x${d.height}px; the pack image is upscaled to ${planned.width}x${planned.height}px. The upscale adds pixels, not detail.`);
    else if (d.width < rules.LIMITS.imageW && d.height < rules.LIMITS.imageH) notes.push(`The stored design is ${d.width}x${d.height}px, below Redbubble's recommended ${rules.LIMITS.imageW}x${rules.LIMITS.imageH}px, and no upscaler is configured: it is packed as is.`);
    if (!etsy) notes.push('No Etsy copy exists yet, so the copy was built from the title, brief and keywords.');
    const state = channelState.get(p.id, CHANNEL);
    const files = [
      { name: 'title.txt', text: copy.title },
      { name: 'tags.txt', text: `MAIN TAG:\n${copy.mainTag}\n\nSUPPORTING TAGS (comma separated):\n${copy.supportingTags.join(', ')}\n` },
      { name: 'description.txt', text: copy.description },
      { name: 'markup.txt', text: `${markup}%\n` },
      { name: 'product-types.txt', text: adv.map(a => `${a.status.toUpperCase().padEnd(8)} ${a.label}: ${a.reason}`).join('\n') + '\n' },
    ];
    const list = checklist({ p, copy, adv, markup, imgName, imgInfo, design: d, lint });
    files.push({ name: 'checklist.md', text: `# Redbubble upload: ${copy.title}\n\nProduct #${p.id}.\n\n${list.map((s, i) => `${i + 1}. [ ] ${s.text}`).join('\n')}\n\nPlaybook: docs/playbooks/redbubble-publish.md\n` });
    return {
      ok: true, channel: CHANNEL, capability: 'manual', productId: p.id, state, startUrl: START_URL,
      copy: { title: copy.title, mainTag: copy.mainTag, supportingTags: copy.supportingTags, tags: copy.tags, description: copy.description, repairs: copy.repairs },
      lint, markupPct: markup, markupNote: 'Redbubble default is 20%. From 2025-09-01 markup above 20% is charged a 50% excess markup fee on Standard and Premium accounts.',
      image: { name: imgName, stored: { width: d.width, height: d.height }, detail: { width: imgInfo.detailWidth, height: imgInfo.detailHeight }, planned: { width: planned.width, height: planned.height, upscaled: planned.upscaled }, recommended: { width: rules.LIMITS.imageW, height: rules.LIMITS.imageH }, url: `/api/products/${p.id}/redbubble/design.png`, source: d.source || 'generated' },
      productTypes: adv, checklist: list, notes, files, limits: rules.LIMITS, sources: rules.SOURCES,
      playbooks: ['redbubble-publish', 'redbubble-weekly', 'redbubble-game-plan'],
    };
  }

  /** The zip: design PNG + the text files + pack.json with the REAL size. */
  async function zip(productId, opts = {}) {
    const meta = pack(productId, opts);
    const img = await image(productId);
    const realName = `redbubble-${productId}-${img.width}x${img.height}.png`;
    const files = meta.files.map(f => (f.name === 'checklist.md' ? { ...f, text: f.text.split(meta.image.name).join(realName) } : f));
    const manifest = { productId: meta.productId, channel: CHANNEL, generatedAt: new Date().toISOString(), image: { file: realName, width: img.width, height: img.height, bytes: img.bytes, upscaled: img.upscaled, upscaleMethod: img.upscaleMethod, storedWidth: img.storedWidth, storedHeight: img.storedHeight, detailWidth: img.detailWidth, detailHeight: img.detailHeight }, lint: meta.lint, markupPct: meta.markupPct, limitsAndSources: { limits: meta.limits, sources: meta.sources } };
    const entries = [{ name: realName, data: img.png }, ...files.map(f => ({ name: f.name, data: f.text })), { name: 'pack.json', data: JSON.stringify(manifest, null, 2) }];
    return { buffer: makeZip(entries), filename: `redbubble-pack-${productId}.zip`, manifest };
  }

  return { pack, zip, image };
}

module.exports = { makeRedbubble, CHANNEL, START_URL };
