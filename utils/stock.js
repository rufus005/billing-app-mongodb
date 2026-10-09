import { round } from "./calculations.js";

const inventoryKey = (p, v) => JSON.stringify([p, v || ""]);

function quantities(sale) {
  const out = new Map();
  if (sale?.status === "Completed") {
    for (const r of sale.items) {
      if (r.productId) {
        const key = inventoryKey(r.productId, r.variantId);
        out.set(key, round((out.get(key) || 0) + r.qty));
      }
    }
  }
  return out;
}

export function updateCompletedSale(products, previous, next, settings) {
  const before = quantities(previous);
  const after = quantities(next);
  const result = structuredClone(products);

  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const delta = round((before.get(key) || 0) - (after.get(key) || 0));
    if (delta === 0) continue;

    const [pid, vid] = JSON.parse(key);
    const p = result.find((p) => p.id === pid);
    const item = vid ? p?.variants?.find((v) => v.id === vid) : p;

    if (!p || !item) {
      throw Error(
        "A referenced product or color no longer exists. Restore it before changing this sale.",
      );
    }

    if (!vid && p.variants?.length && delta < 0) {
      throw Error(`Select a color for ${p.name}.`);
    }

    const updated = round(item.stock + delta);

    if (delta < 0 && settings.preventOutOfStock && item.stock <= 0) {
      throw Error(
        `${p.name}${vid ? " - " + item.color : ""} is out of stock.`,
      );
    }

    if (updated < 0 && !settings.allowNegativeStock) {
      throw Error(
        `Insufficient stock for ${p.name}. Available: ${item.stock}; additional quantity: ${-delta}.`,
      );
    }

    item.stock = updated;
  }

  return result;
}

export const completeSale = (products, sale, settings, previous) =>
  updateCompletedSale(products, previous, { ...sale, status: "Completed" }, settings);

export const restoreSaleStock = (products, sale, settings) =>
  updateCompletedSale(products, sale, undefined, settings);

export const cancelSale = (products, sale, settings) =>
  updateCompletedSale(products, sale, { ...sale, status: "Cancelled" }, settings);
