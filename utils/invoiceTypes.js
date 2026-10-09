import { randomUUID } from "node:crypto";

export const defaultSeller = {
  name: "DYNAMIC UNIVERSAL MARKTING",
  address:
    "# Subbaraju Layout, No 13, Kanakapura RD, Doddakallasandra, Konanakunte, Bengaluru, Karnataka - 560062",
  gstin: "29AKFPU1710L1ZV",
  phone: "7899779304",
  bank: "IDFC FIRST BANK",
  branch: "JP NAGAR, BANGALORE",
  account: "923020037868455",
  ifsc: "UTIB0005011",
};

export const defaultDeclaration =
  "We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.";

export const defaultSettings = {
  invoicePrefix: "INV-",
  nextInvoiceNumber: 1,
  defaultMode: "Cash",
  declaration: defaultDeclaration,
  lowStockThreshold: 5,
  preventOutOfStock: true,
  allowNegativeStock: false,
  gstEnabled: true,
  gstRate: 18,
  cgstRate: 9,
  sgstRate: 9,
};

export function newInvoice(settings = defaultSettings) {
  const d = new Date();
  return {
    id: randomUUID(),
    status: "Draft",
    createdAt: d.toISOString(),
    updatedAt: d.toISOString(),
    revision: 0,
    declaration: settings.declaration,
    cgstRate: settings.gstEnabled ? settings.cgstRate : 0,
    sgstRate: settings.gstEnabled ? settings.sgstRate : 0,
    number: `INV-${d.getFullYear()}-${String(d.getTime()).slice(-6)}`,
    date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
    time: d.toTimeString().slice(0, 8),
    mode: settings.defaultMode,
    vehicle: "",
    buyer: { name: "", address: "", gstin: "", mobile: "" },
    items: [],
    discount: 0,
    returns: 0,
    gst: settings.gstEnabled ? settings.gstRate : 0,
  };
}
