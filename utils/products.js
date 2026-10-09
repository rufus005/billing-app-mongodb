import { randomUUID } from "node:crypto";
import { round } from "./calculations.js";

export const stockTotal = (p) =>
  p.variants?.length
    ? round(p.variants.reduce((n, v) => n + v.stock, 0))
    : p.stock;

export const productPrice = (p) =>
  p.variants?.length ? Math.min(...p.variants.map((v) => v.price)) : p.price;

export const stockStatus = (stock, threshold) =>
  stock <= 0 ? "Out of stock" : stock <= threshold ? "Low stock" : "In stock";

export const productSearch = (p) =>
  [
    p.name,
    p.code,
    p.barcode,
    p.hsn,
    p.category,
    ...(p.variants || []).flatMap((v) => [v.color, v.code, v.barcode]),
  ]
    .join(" ")
    .toLowerCase();

export function lookupCode(products, code) {
  const value = code.trim().toLowerCase();
  for (const product of products) {
    for (const variant of product.variants || []) {
      if ([variant.code, variant.barcode].some((c) => c && c.toLowerCase() === value))
        return { product, variant, qty: 1 };
    }
    if ([product.code, product.barcode].some((c) => c && c.toLowerCase() === value))
      return product.variants?.length ? { choose: product } : { product, qty: 1 };
  }
}

export function selectionToLine({ product: p, variant: v, qty }) {
  return {
    id: randomUUID(),
    productId: p.id,
    variantId: v?.id,
    color: v?.color,
    code: v?.code || p.code,
    barcode: v?.barcode || p.barcode,
    name: v ? `${p.name} - ${v.color}`.toUpperCase() : p.name,
    hsn: p.hsn,
    qty,
    price: v?.price ?? p.price,
    stock: v?.stock ?? p.stock,
  };
}

export function validateProducts(products) {
  const ids = new Set();
  const identifiers = new Map();

  for (const p of products) {
    if (ids.has(p.id)) throw Error("Duplicate product ID.");
    ids.add(p.id);

    if (!p.name.trim() || !p.code.trim())
      throw Error("Product name and item code are required.");

    const variants = p.variants || [];
    const variantIds = new Set();

    for (const v of variants) {
      if (variantIds.has(v.id)) throw Error("Duplicate variant ID.");
      variantIds.add(v.id);

      if (!v.color.trim() || !v.code.trim())
        throw Error("Each variant needs a color name and SKU.");
      if (!/^#[0-9a-f]{6}$/i.test(v.hex))
        throw Error("Choose a valid color.");
    }

    for (const item of [p, ...variants]) {
      if (
        !Number.isFinite(item.price) ||
        item.price < 0 ||
        !Number.isFinite(item.stock)
      )
        throw Error("Price and stock must be valid numbers.");

      const owner = `${p.id}:${item === p ? "base" : item.id}`;
      for (const value of [item.code, item.barcode].filter(Boolean)) {
        const code = value.trim().toLowerCase();
        if (identifiers.has(code) && identifiers.get(code) !== owner)
          throw Error(`SKU or barcode “${value}” is already in use.`);
        identifiers.set(code, owner);
      }
    }
  }
}
