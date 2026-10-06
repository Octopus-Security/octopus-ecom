'use strict';
/**
 * watch/supplier.js — supplier / POD watcher.
 * For each non-terminal product with a blueprint + print provider: re-read variant base costs and
 * availability (READ methods only), recompute projected margin with domain/fees.js, and
 *   - cost changed      -> info/warn alert
 *   - margin <=0 / below floor -> margin_* flag on the product (blocks autopublish) + alert -> "margin-fell"
 *   - variant out of stock -> alert -> "out-of-stock"
 * Never writes to a marketplace or POD. The only DB writes are our own: products.flags,
 * pod_base_cost_cents, projected_margin_cents, alerts and snapshots. Observed cost = the
 * MAX variant cost (conservative: the margin we report is the worst case a buyer can choose).
 */
const { projectMargin, marginFlags } = require('../domain/fees');

const TERMINAL = ['rejected', 'failed', 'archived'];
const usd = c => `$${(c / 100).toFixed(2)}`;

function parseFlags(p) { try { return JSON.parse(p.flags || '[]'); } catch { return []; } }

async function runSupplierWatch({ db, readers, alerts, state, settings, log }) {
  const products = db.prepare(`SELECT * FROM products WHERE blueprint IS NOT NULL AND blueprint != ''
    AND print_provider_id IS NOT NULL AND print_provider_id != '' AND stage NOT IN (${TERMINAL.map(() => '?').join(',')})`).all(...TERMINAL);
  const floor = settings.getInt('margin_floor_cents', 200);
  const out = { checked: 0, costChanges: 0, flagged: 0, outOfStock: 0, errors: 0, sources: new Set() };

  for (const p of products) {
    try {
      const costs = await readers.getVariantCosts(p.blueprint, p.print_provider_id);
      out.sources.add(costs.source);
      const list = (costs.variants || []).map(v => v.costCents).filter(Number.isInteger);
      out.checked++;
      const title = p.title || `Product ${p.id}`;
      if (list.length) {
        const observed = Math.max(...list);
        const key = `supplier.cost.${p.id}`;
        const prev = state.get(key);
        const before = prev ? prev.costCents : null;
        if (before !== null && before !== observed) {
          out.costChanges++;
          alerts.raise({
            kind: 'cost_changed', productId: p.id, severity: observed > before ? 'warn' : 'info',
            message: `${title}: POD base cost went ${usd(before)} -> ${usd(observed)}.`,
            playbookId: observed > before ? 'margin-fell' : null, dedupeKey: `cost_changed.${p.id}.${before}.${observed}`,
          });
        }
        state.set(key, { costCents: observed, at: new Date().toISOString() });

        if (Number.isInteger(p.list_price_cents)) {
          const m = projectMargin({ listPriceCents: p.list_price_cents, shippingCents: p.shipping_cents || 0, podBaseCostCents: observed });
          const newFlags = marginFlags(m.marginCents, floor).map(f => ({ ...f, source: 'watch' }));
          const kept = parseFlags(p).filter(f => !String(f.code).startsWith('margin_'));
          db.prepare('UPDATE products SET pod_base_cost_cents = ?, projected_margin_cents = ?, flags = ? WHERE id = ?')
            .run(observed, m.marginCents, JSON.stringify([...kept, ...newFlags]), p.id);
          if (newFlags.length) {
            out.flagged++;
            alerts.raise({
              kind: 'margin_fell', productId: p.id, severity: m.marginCents <= 0 ? 'critical' : 'warn',
              message: `${title}: projected margin is ${usd(m.marginCents)} (${newFlags[0].code === 'margin_non_positive' ? 'not positive' : `floor ${usd(floor)}`}) at base cost ${usd(observed)}. Autopublish is blocked.`,
              playbookId: 'margin-fell', dedupeKey: `margin_fell.${p.id}`,
            });
          }
        }
      }

      const av = await readers.getAvailability(p.blueprint, p.print_provider_id);
      out.sources.add(av.source);
      const variants = av.variants || [];
      const gone = variants.filter(v => v.inStock === false);
      if (gone.length) {
        out.outOfStock++;
        alerts.raise({
          kind: 'out_of_stock', productId: p.id, severity: gone.length === variants.length ? 'critical' : 'warn',
          message: `${title}: ${gone.length}/${variants.length} variant(s) unavailable at the print provider (${gone.slice(0, 4).map(v => v.title || v.id).join(', ')}).`,
          playbookId: 'out-of-stock', dedupeKey: `out_of_stock.${p.id}.${gone.length === variants.length ? 'all' : 'some'}.${gone.map(v => v.id).sort().join(',')}`,
        });
      }
    } catch (e) {
      out.errors++;
      log.warn(`[watch] supplier read failed for product ${p.id}: ${e.message}`);
    }
  }
  const src = [...out.sources].join('+') || 'none';
  return `checked ${out.checked} product(s) [source: ${src}]; cost changes ${out.costChanges}, margin flags ${out.flagged}, out-of-stock ${out.outOfStock}, read errors ${out.errors}`;
}
module.exports = { runSupplierWatch };
