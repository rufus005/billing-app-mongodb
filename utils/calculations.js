export const round = (n) =>
  Math.round((n + Number.EPSILON) * 100) / 100;

export const money = (n) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
  }).format(n);

export const numeric = (v) =>
  Math.min(1e9, Math.max(0, Number(v) || 0));

export function calculate(i) {
  const qty = round(i.items.reduce((s, r) => s + r.qty, 0));
  const sale = round(
    i.items.reduce((s, r) => s + round(r.qty * (r.finalPrice ?? r.price)), 0),
  );
  const net = round(Math.max(0, sale - i.discount - i.returns));
  const taxable =
    sale === 0
      ? 0
      : round(
          i.items.reduce(
            (sum, r) =>
              sum +
              (round(r.qty * (r.finalPrice ?? r.price)) * (net / sale)) /
                (1 + (r.gstPercent ?? i.gst) / 100),
            0,
          ),
        );
  const tax = round(net - taxable);
  const cgst = round(tax / 2);

  return {
    qty,
    sale,
    net,
    taxable,
    tax,
    cgst,
    sgst: round(tax - cgst),
    grand: net,
  };
}
