import express from "express";
import { getPaymentSettings, savePaymentSettings } from "./utils/paymentStorage.js";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { connectDB } from "./config/db.js";
import cors from "cors";
import jwt from "jsonwebtoken";
import { timingSafeEqual, createHash, randomUUID } from "node:crypto";
import mongoose from "mongoose";
import {
  Product,
  Buyer,
  BuyerPrice,
  Invoice,
  Lock,
  BusinessPayment,
  BusinessProfile,
} from "./models/index.js";
import { auth } from "./middleware/authMiddleware.js";
import { updateCompletedSale } from "./utils/stock.js";
import { validateProducts } from "./utils/products.js";
import { calculate, round } from "./utils/calculations.js";
import { defaultSettings } from "./utils/invoiceTypes.js";
dotenv.config({
  path: [
    fileURLToPath(new URL("./.env", import.meta.url)),
    fileURLToPath(new URL("../.env", import.meta.url)),
  ],
});
const fail = (message, status = 400) =>
  Object.assign(new Error(message), { status });
const clean = (d) => (d ? JSON.parse(JSON.stringify(d)) : null);
const equal = (a, b) =>
  timingSafeEqual(
    createHash("sha256")
      .update(String(a || ""))
      .digest(),
    createHash("sha256")
      .update(String(b || ""))
      .digest(),
  );
const literal = (v) => ({
  $regex: String(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  $options: "i",
});
export async function initialize() {
  for (const m of [Product, Buyer, BuyerPrice, Invoice, Lock, BusinessPayment])
    await m.init();
  await Lock.updateOne(
    { _id: "business" },
    { $setOnInsert: { revision: 0 } },
    { upsert: true },
  );
}
async function transaction(fn) {
  return mongoose.connection.transaction(async (session) => {
    await Lock.updateOne(
      { _id: "business" },
      { $inc: { revision: 1 } },
      { session },
    );
    return fn(session);
  });
}
export function createApp() {
  const app = express();
  let initialized = false;
  let databaseReady;
  const ensureDatabase = () => {
    if (mongoose.connection.readyState === 1 && initialized) return Promise.resolve(true);
    if (databaseReady) return databaseReady;
    databaseReady = (async () => {
      if (!(await connectDB())) return false;
      if (!initialized) {
        await initialize();
        initialized = true;
      }
      return true;
    })().catch((error) => {
      console.error("Database initialization failed", { name: error.name, code: error.code });
      return false;
    }).finally(() => { databaseReady = undefined; });
    return databaseReady;
  };
  const configuredOrigins = (process.env.CLIENT_URL || "http://localhost:5173,http://localhost:5174")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);

  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || configuredOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(fail("Not allowed by CORS", 403));
      },
      credentials: true,
      // Application-level cors handles OPTIONS before JSON parsing and auth.
      methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      optionsSuccessStatus: 204,
      // Reuse successful preflights; every actual request still checks origin and JWT.
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: "10mb" }));
  app.use((req, _res, next) => {
    req.body ??= {};
    next();
  });
  app.get("/", (_req, res) =>
    res.json({ name: "Billing API", server: "ok", health: "/api/health" }),
  );
  app.get("/api/health", async (_req, res) => {
    const connected = await ensureDatabase();
    res.set("Cache-Control", "no-store").status(connected ? 200 : 503).json({
      server: "ok", database: connected ? "connected" : "disconnected",
    });
  });
  app.post("/api/auth/login", (req, res) => {
    if (
      !process.env.ADMIN_USERNAME ||
      !process.env.ADMIN_PASSWORD ||
      !process.env.JWT_SECRET
    )
      return res.status(503).json({ message: "Login is not configured." });
    if (
      !equal(req.body.username, process.env.ADMIN_USERNAME) ||
      !equal(req.body.password, process.env.ADMIN_PASSWORD)
    )
      return res.status(401).json({ message: "Invalid username or password." });
    res.json({
      token: jwt.sign({}, process.env.JWT_SECRET, {
        subject: process.env.ADMIN_USERNAME,
        issuer: "billing-app",
        expiresIn: "8h",
        algorithm: "HS256",
      }),
    });
  });
  app.use("/api", auth);
  app.get("/api/auth/me", (_req, res) =>
    res.json({ username: process.env.ADMIN_USERNAME }),
  );
  app.use("/api", async (_req, res, next) =>
    await ensureDatabase()
      ? next()
      : res
          .status(503)
          .json({
            message: "MongoDB unavailable. Your local data has been preserved.",
          }),
  );
  app.get('/api/business-profile', async (_req, res) => res.json(await BusinessProfile.findById('business')));
  app.put('/api/business-profile', async (req, res) => {
    const fields = {};
    const unset = {};
    for (const key of ['name','address','gstin','phone','email','pan','website','pin','city','state','bank','branch','account','ifsc','logo','signature','seal','qrMode']) {
      if (req.body[key] === undefined) continue;
      if (key === 'qrMode' && req.body[key] === null) { unset.qrMode = 1; continue; }
      if (typeof req.body[key] !== 'string' || req.body[key].length > (['logo','signature','seal'].includes(key) ? 4000000 : 2000)) throw fail('Invalid business field: ' + key);
      fields[key] = req.body[key];
    }
    res.json(await BusinessProfile.findByIdAndUpdate('business', {$set: fields, $unset: unset}, {upsert: true, new: true, runValidators: true}));
  });
  app.post('/api/invoices/:id/payments', async (req, res) => {
    const result = await transaction(async session => {
      const invoice = await Invoice.findOne({id: req.params.id}).session(session);
      if (!invoice) throw fail('Invoice not found.', 404);
      const { id, amount, date, method, reference = '' } = req.body;
      if (typeof id !== 'string' || !id || id.length > 100 || typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || round(amount) !== amount || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || !['Cash','UPI','Bank Transfer'].includes(method) || typeof reference !== 'string' || reference.length > 200) throw fail('Enter a valid payment amount, date, method and reference.');
      const existing = invoice.payments?.find(p => p.id === id);
      if (existing) {
        if (existing.amount !== amount || existing.date !== date || existing.method !== method || existing.reference !== reference.trim()) throw fail('Payment ID already used with different details.', 409);
        return invoice;
      }
      if (invoice.status !== 'Completed') throw fail('Payments require a completed invoice.');
      if (invoice.receivedAmount === undefined) throw fail('Confirm the historical received total before recording a new payment.');
      const total = invoice.totals?.grand ?? calculate(invoice).grand;
      if (round(invoice.receivedAmount + amount) > total) throw fail('Payment exceeds the outstanding balance.');
      if (reference.trim() && invoice.payments?.some(p => p.reference === reference.trim() && p.method === method)) throw fail('This payment reference is already recorded.', 409);
      invoice.paymentOpeningReceived ??= invoice.receivedAmount;
      invoice.payments ??= [];
      invoice.payments.push({id, amount, date, method, reference: reference.trim()});
      invoice.receivedAmount = round(invoice.receivedAmount + amount);
      invoice.revision += 1;
      await invoice.save({session});
      return invoice;
    });
    res.json(result);
  });
  const paymentRouter = express.Router();
  paymentRouter.use((_req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    next();
  });
  paymentRouter.get("/", async (_req, res) => res.json(await getPaymentSettings()));
  for (const method of ["post", "put"])
    paymentRouter[method]("/", async (req, res) => res.json(await savePaymentSettings(req.body)));
  paymentRouter.use((error, req, res, _next) => {
    if (error.status === 400 || error.name === "ValidationError")
      return res.status(400).json({ message: error.status === 400 ? error.message : "Invalid payment settings." });
    const unavailable = /Mongo(Network|ServerSelection|TopologyClosed)|MongooseServerSelection/.test(error.name);
    console.error("Business payment request failed", {
      method: req.method, name: error.name, code: error.code,
    });
    res.status(unavailable ? 503 : 500).json({
      message: unavailable
        ? "Payment storage is unavailable. Please retry shortly."
        : "Unable to access payment settings or the QR image. Please retry or contact support.",
    });
  });
  app.use("/api/business-payment", paymentRouter);
  app.post("/api/import", async (req, res) => {
    const result = await transaction(async (session) => {
      if (
        (await Product.exists({}).session(session)) ||
        (await Invoice.exists({}).session(session))
      )
        throw fail(
          "Import requires an empty product catalogue and sales history.",
          409,
        );
      const { products, sales } = req.body;
      if (
        !Array.isArray(products) ||
        !Array.isArray(sales) ||
        (!products.length && !sales.length)
      )
        throw fail("Choose a non-empty local backup.");
      validateProducts(products);
      const invoices = sales.map((i) => ({
        ...i,
        revision: i.revision || 1,
        status: i.status || "Draft",
        items: i.items.map((r) => ({
          ...r,
          finalPrice: r.finalPrice ?? r.price,
          price: r.finalPrice ?? r.price,
          amount: round(r.qty * (r.finalPrice ?? r.price)),
        })),
      }));
      for (const i of invoices) {
        i.totals = calculate(i);
        for (const r of i.items)
          if (i.status === "Completed" && r.productId) {
            const p = products.find((p) => p.id === r.productId);
            if (
              !p ||
              (r.variantId && !p.variants?.some((v) => v.id === r.variantId))
            )
              throw fail(
                "Backup has a completed sale referencing missing stock.",
              );
          }
      }
      if (products.length) await Product.create(products, { session });
      if (invoices.length) await Invoice.create(invoices, { session });
      return { products: products.length, invoices: invoices.length };
    });
    res.json(result);
  });
  app.get("/api/buyer-prices/resolve", async (req, res) => {
    const p = await Product.findOne({ id: String(req.query.productId) });
    if (!p) throw fail("Product not found.", 404);
    const v = req.query.variantId
      ? p.variants.find((v) => v.id === req.query.variantId)
      : null;
    if (req.query.variantId && !v) throw fail("Variant not found.", 404);
    const b = await Buyer.findOne({
      id: String(req.query.buyerId),
      active: true,
    });
    const rate = b
      ? await BuyerPrice.findOne({
          buyer: b.id,
          product: p.id,
          variant: String(req.query.variantId || ""),
          active: true,
        })
      : null;
    res.json({
      source: rate ? "buyer-price" : "normal-price",
      normalPrice: v?.price ?? p.price,
      price: rate?.price ?? v?.price ?? p.price,
    });
  });
  app.get("/api/buyer-prices/buyer/:id", async (req, res) =>
    res.json(await BuyerPrice.find({ buyer: req.params.id })),
  );
  for (const [path, Model] of [
    ["products", Product],
    ["buyers", Buyer],
    ["buyer-prices", BuyerPrice],
    ["invoices", Invoice],
  ]) {
    app.get("/api/" + path, async (req, res) => {
      const q = {};
      if (path === "buyers" && req.query.search)
        q.$or = ["name", "mobile", "gstin"].map((k) => ({
          [k]: literal(req.query.search),
        }));
      if (path === "buyer-prices" && req.query.buyer)
        q.buyer = String(req.query.buyer);
      if (path === "invoices") {
        for (const [arg, key] of [
          ["buyer", "buyer.name"],
          ["mobile", "buyer.mobile"],
          ["invoiceNumber", "number"],
        ])
          if (req.query[arg]) q[key] = literal(req.query[arg]);
        if (req.query.search)
          q.$or = ["number", "buyer.name", "buyer.mobile"].map((k) => ({
            [k]: literal(req.query.search),
          }));
        if (req.query.from || req.query.to) {
          q.date = {};
          for (const [key, op] of [
            ["from", "$gte"],
            ["to", "$lte"],
          ])
            if (req.query[key]) {
              if (!/^\d{4}-\d{2}-\d{2}$/.test(req.query[key]))
                throw fail("Invalid date filter.");
              q.date[op] = req.query[key];
            }
        }
      }
      res.json(await Model.find(q).sort({ createdAt: -1 }));
    });
    app.get("/api/" + path + "/:id", async (req, res) => {
      const d = await Model.findOne({ id: req.params.id });
      if (!d) throw fail("Record not found.", 404);
      res.json(d);
    });
    for (const method of ["post", "put", "delete"])
      app[method](
        "/api/" + path + (method === "post" ? "" : "/:id"),
        async (req, res) => {
          const result = await transaction(async (session) => {
            if (req.body.id !== undefined && typeof req.body.id !== "string")
              throw fail("Invalid record ID.");
            const id =
              method === "post" ? req.body.id || randomUUID() : req.params.id;
            const old =
              method === "post"
                ? null
                : await Model.findOne({ id }).session(session);
            if (method !== "post" && !old) throw fail("Record not found.", 404);
            if (
              method !== "post" &&
              req.body.updatedAt &&
              new Date(req.body.updatedAt).getTime() !== old.updatedAt.getTime()
            )
              throw fail("Record changed. Reload before saving.", 409);
            const body = { ...req.body, id };
            delete body._id;
            delete body.createdAt;
            delete body.updatedAt;
            if (path === "products") {
              const products = clean(await Product.find().session(session));
              const next =
                method === "delete"
                  ? products.filter((p) => p.id !== id)
                  : old
                    ? products.map((p) => (p.id === id ? body : p))
                    : [...products, body];
              validateProducts(next);
              if (
                next.some(
                  (p) => p.stock < 0 || p.variants?.some((v) => v.stock < 0),
                )
              )
                throw fail("Negative stock is disabled.");
              const sales = await Invoice.find({
                status: "Completed",
                "items.productId": id,
              }).session(session);
              for (const s of sales)
                for (const r of s.items.filter((r) => r.productId === id)) {
                  if (
                    method === "delete" ||
                    (r.variantId &&
                      !body.variants?.some((v) => v.id === r.variantId)) ||
                    (!r.variantId && body.variants?.length)
                  )
                    throw fail(
                      "Cancel completed sales before deleting referenced products or variants.",
                    );
                }
            }
            if (path === "buyer-prices" && method !== "delete") {
              const b = await Buyer.findOne({ id: body.buyer }).session(
                session,
              );
              const p = await Product.findOne({ id: body.product }).session(
                session,
              );
              body.variant = body.variant || "";
              if (
                !b ||
                !p ||
                (body.variant && !p.variants.some((v) => v.id === body.variant))
              )
                throw fail("Buyer, product or variant not found.");
            }
            if (path === "invoices") {
              delete body.payments;
              delete body.paymentOpeningReceived;
              if (old?.payments?.length && method === 'delete') throw fail('Invoices with payment history cannot be deleted.');
              if (old?.payments?.length && body.receivedAmount !== undefined && body.receivedAmount !== old.receivedAmount) throw fail('Use Record Payment to update receipts with payment history.');
              if (old && req.body.revision !== old.revision)
                throw fail("Invoice changed. Reload it before saving.", 409);
              if (method !== "delete") {
                body.items = (body.items || []).map((r) => ({
                  ...r,
                  finalPrice: r.finalPrice ?? r.price,
                  price: r.finalPrice ?? r.price,
                  amount: round(r.qty * (r.finalPrice ?? r.price)),
                }));
                if (old?.status === "Cancelled" && body.status === "Completed")
                  throw fail(
                    "Duplicate a cancelled invoice to create a new sale.",
                  );
                if (
                  body.status === "Completed" &&
                  (!body.items.length ||
                    !body.seller?.name?.trim() ||
                    body.items.some((r) => !r.name?.trim() || r.qty <= 0))
                )
                  throw fail(
                    "A completed invoice needs seller details and named items with positive quantities.",
                  );
                if (body.receivedAmount !== undefined) {
                  if (typeof body.receivedAmount !== "number" || !Number.isFinite(body.receivedAmount) || body.receivedAmount < 0)
                    throw fail("Received amount must be a non-negative number.");
                  body.receivedAmount = round(body.receivedAmount);
                }
                body.revision = (old?.revision || 0) + 1;
                body.totals = calculate(body);
                if (old?.payments?.length && body.totals.grand < old.receivedAmount) throw fail('Invoice total cannot be reduced below confirmed receipts.');
                await new Invoice(body).validate();
              }
              const products = clean(await Product.find().session(session));
              const next = updateCompletedSale(
                products,
                clean(old),
                method === "delete" ? undefined : body,
                defaultSettings,
              );
              for (let n = 0; n < next.length; n++)
                if (JSON.stringify(next[n]) !== JSON.stringify(products[n]))
                  await Product.updateOne(
                    { id: next[n].id },
                    {
                      $set: {
                        stock: next[n].stock,
                        variants: next[n].variants,
                      },
                    },
                    { session },
                  );
            }
            if (method === "delete") {
              await Model.deleteOne({ id }, { session });
              if (path === "buyers" || path === "products")
                await BuyerPrice.deleteMany(
                  { [path === "buyers" ? "buyer" : "product"]: id },
                  { session },
                );
              return { ok: true };
            }
            if (old) {
              old.set(body);
              await old.save({ session });
              return old;
            }
            return (await Model.create([body], { session }))[0];
          });
          res.status(method === "post" ? 201 : 200).json(result);
        },
      );
  }
  app.use((err, _req, res, _next) => {
    const duplicate = err.code === 11000;
    res
      .status(duplicate ? 409 : err.status || 400)
      .json({
        message: duplicate
          ? "Duplicate record: invoice number, ID or buyer/product/variant price already exists."
          : err.name === "ValidationError"
            ? "Invalid record. Check required fields and non-negative prices."
            : err.status ||
                err.message?.includes("stock") ||
                err.message?.includes("Stock")
              ? err.message
              : "Request failed. Check the submitted data and database connection.",
      });
  });
  return app;
}

export default createApp();
