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
  const charges = Array.isArray(i.additionalCharges)
    ? i.additionalCharges
    : typeof i.additionalCharges === "number" && i.additionalCharges > 0
      ? [{ amount: i.additionalCharges, taxable: false }]
      : [];
  const taxableCharges = charges.filter(
    (charge) => charge.taxable && i.taxMode !== "non-gst",
  );
  const afterTaxCharges = charges
    .filter((charge) => !taxableCharges.includes(charge))
    .reduce((sum, charge) => sum + charge.amount, 0);
  const chargeSubtotal = round(
    charges.reduce((sum, charge) => sum + charge.amount, 0),
  );
  const chargeTaxable = round(taxableCharges.reduce(
    (sum, charge) => sum + (i.pricingMode === 'exclusive'
      ? charge.amount
      : charge.amount / (1 + i.gst / 100)), 0,
  ));
  const chargeTax = round(taxableCharges.reduce(
    (sum, charge) => sum + (i.pricingMode === 'exclusive'
      ? charge.amount * i.gst / 100
      : charge.amount - charge.amount / (1 + i.gst / 100)), 0,
  ));
  // Optional pricing fields select the new calculation path. Legacy invoices
  // retain their original algorithm and stored totals until explicitly edited.
  if (i.pricingMode === 'exclusive' || charges.length || i.autoRoundOff || i.items.some(r => r.discountPercent)) {
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
    const totalTaxable = round(taxable + chargeTaxable);
    const totalTax = round(tax + chargeTax);
    const beforeRound = round(totalTaxable + totalTax + afterTaxCharges);
    const grand = i.autoRoundOff ? Math.round(beforeRound) : beforeRound;
    return { qty, sale: round(sale + chargeSubtotal), net: round(net + chargeSubtotal), taxable: totalTaxable, tax: totalTax, cgst: round(totalTax / 2), sgst: round(totalTax - round(totalTax / 2)), grand, roundOff: round(grand - beforeRound) };
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
