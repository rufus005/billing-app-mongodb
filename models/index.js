import mongoose from "mongoose";
const { Schema } = mongoose;
const text = { type: String, default: "" };
const required = { type: String, required: true, trim: true };
const money = {
  type: Number,
  min: 0,
  required: true,
  validate: Number.isFinite,
};
const options = {
  timestamps: true,
  versionKey: false,
  toJSON: {
    transform: (_doc, r) => {
      delete r._id;
      return r;
    },
  },
};
const base = { id: { type: String, required: true, unique: true } };
const variant = new Schema(
  {
    id: required,
    color: required,
    hex: required,
    code: required,
    barcode: text,
    price: money,
    stock: { type: Number, required: true },
    image: text,
  },
  { _id: false },
);
export const Product = mongoose.model(
  "Product",
  new Schema(
    {
      ...base,
      name: required,
      code: required,
      barcode: text,
      hsn: text,
      category: text,
      price: money,
      gstPercent: { type: Number, min: 0, max: 100, default: 18 },
      stock: { type: Number, required: true },
      variants: [variant],
    },
    options,
  ),
);
export const Buyer = mongoose.model(
  "Buyer",
  new Schema(
    {
      ...base,
      name: required,
      mobile: text,
      address: text,
      gstin: text,
      email: text,
      notes: text,
      active: { type: Boolean, default: true },
    },
    options,
  ),
);
const priceSchema = new Schema(
  {
    ...base,
    buyer: required,
    product: required,
    variant: { type: String, default: "" },
    price: money,
    active: { type: Boolean, default: true },
  },
  options,
);
priceSchema.index({ buyer: 1, product: 1, variant: 1 }, { unique: true });
export const BuyerPrice = mongoose.model("BuyerPrice", priceSchema);
export const BusinessPayment = mongoose.model(
  "BusinessPayment",
  new Schema(
    {
      _id: { type: String, default: "business" },
      upiId: text,
      payeeName: { type: String, default: "", maxlength: 100 },
      showQrOnInvoices: { type: Boolean, default: true },
      qrFileId: { type: Schema.Types.ObjectId, default: null },
      qrContentType: text,
    },
    { versionKey: false },
  ),
);
const buyer = new Schema(
  { name: text, mobile: text, address: text, gstin: text },
  { _id: false },
);
const item = new Schema(
  {
    id: required,
    productId: String,
    variantId: String,
    color: String,
    code: String,
    barcode: String,
    stock: Number,
    name: text,
    hsn: text,
    qty: money,
    price: money,
    finalPrice: money,
    normalPriceAtSale: Number,
    buyerPriceAtSale: Number,
    gstPercent: { type: Number, min: 0, max: 100 },
    amount: money,
  },
  { _id: false },
);
export const Invoice = mongoose.model(
  "Invoice",
  new Schema(
    {
      ...base,
      number: { ...required, unique: true },
      buyerId: String,
      buyer,
      shipTo: buyer,
      dueDate: String,
      taxMode: { type: String, enum: ["gst", "non-gst"] },
      taxJurisdiction: { type: String, enum: ["intra", "inter"] },
      // Cumulative manually confirmed receipts, never an incremental debit.
      // No default: historical invoices with unknown receipts remain unknown.
      receivedAmount: { type: Number, min: 0, validate: Number.isFinite },
      items: [item],
      date: required,
      time: text,
      mode: text,
      vehicle: text,
      discount: money,
      returns: money,
      gst: { type: Number, min: 0, max: 100, required: true },
      status: {
        type: String,
        enum: ["Draft", "Completed", "Cancelled"],
        required: true,
      },
      revision: { type: Number, required: true },
      seller: Schema.Types.Mixed,
      declaration: String,
      cgstRate: Number,
      sgstRate: Number,
      totals: Schema.Types.Mixed,
    },
    options,
  ),
);
export const Lock = mongoose.model(
  "WriteLock",
  new Schema({ _id: String, revision: Number }),
);
