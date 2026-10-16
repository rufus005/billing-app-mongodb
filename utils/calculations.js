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
  // Optional pricing fields select the new calculation path. Legacy invoices
  // retain their original algorithm and stored totals until explicitly edited.
  if (i.pricingMode === 'exclusive' || i.additionalCharges || i.autoRoundOff || i.items.some(r => r.discountPercent)) {
    const qty = round(i.items.reduce((sum, r) => sum + r.qty, 0));
    const lines = i.items.map(r => ({
      amount: round(round(r.qty * (r.finalPrice ?? r.price)) * (1 - (r.discountPercent || 0) / 100)),
      rate: i.taxMode === 'non-gst' ? 0 : (r.gstPercent ?? i.gst),
    }));
    const sale = round(lines.reduce((sum, r) => sum + r.amount, 0));
    const net = round(Math.max(0, sale - i.discount - i.returns));
    const taxable = sale === 0 ? 0 : round(lines.reduce((sum,r) => sum + r.amount * net / sale / (i.pricingMode === 'exclusive' ? 1 : 1 + r.rate / 100), 0));
    const tax = i.pricingMode === 'exclusive' ? round(lines.reduce((sum,r) => sum + (sale ? r.amount * net / sale : 0) * r.rate / 100, 0)) : round(net - taxable);
    const cgst = round(tax / 2);
    const beforeRound = round(taxable + tax + (i.additionalCharges || 0));
    const grand = i.autoRoundOff ? Math.round(beforeRound) : beforeRound;
    return { qty, sale, net, taxable, tax, cgst, sgst: round(tax - cgst), grand, roundOff: round(grand - beforeRound) };
  }
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
                (1 + (i.taxMode === "non-gst" ? 0 : (r.gstPercent ?? i.gst)) / 100),
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
