import express from "express";
import { validatePaymentUpdate, paymentResponse } from "./utils/businessPayment.js";
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
  app.get("/api/health", (_req, res) =>
    res
      .status(mongoose.connection.readyState === 1 ? 200 : 503)
      .json({
        server: "ok",
        database:
          mongoose.connection.readyState === 1 ? "connected" : "disconnected",
      }),
  );
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
  app.use("/api", (_req, res, next) =>
    mongoose.connection.readyState === 1
      ? next()
      : res
          .status(503)
          .json({
            message: "MongoDB unavailable. Your local data has been preserved.",
          }),
  );
  app.get("/api/business-payment", async (_req, res) => {
    const profile = await BusinessPayment.findById("business");
    let qrCode = "";
    if (profile?.qrFileId) {
      const chunks = [];
      await new Promise((resolve, reject) => {
        const stream = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
          bucketName: "businessQr",
        }).openDownloadStream(profile.qrFileId);
        stream.on("data", (chunk) => chunks.push(chunk));
        stream.on("error", reject);
        stream.on("end", resolve);
      });
      qrCode = `data:${profile.qrContentType};base64,${Buffer.concat(chunks).toString("base64")}`;
    }
    res.json(paymentResponse(profile, qrCode));
  });
  app.put("/api/business-payment", async (req, res) => {
    const { fields, image, removeQrCode } = validatePaymentUpdate(req.body);
    const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
      bucketName: "businessQr",
    });
    let uploadedId;
    if (removeQrCode) Object.assign(fields, { qrFileId: null, qrContentType: "" });
    if (image) {
      const upload = bucket.openUploadStream("business-qr", { contentType: image.contentType });
      await new Promise((resolve, reject) => {
        upload.on("error", reject);
        upload.on("finish", resolve);
        upload.end(image.buffer);
      });
      uploadedId = upload.id;
      Object.assign(fields, { qrFileId: uploadedId, qrContentType: image.contentType });
    }
    let previous;
    try {
      // Return the prior document so concurrent replacements clean up the right file.
      previous = await BusinessPayment.findByIdAndUpdate(
        "business",
        { $set: fields },
        { upsert: true, new: false, setDefaultsOnInsert: true, runValidators: true },
      );
    } catch (error) {
      if (uploadedId) await bucket.delete(uploadedId).catch(() => {});
      throw error;
    }
    if ((image || removeQrCode) && previous?.qrFileId)
      await bucket.delete(previous.qrFileId).catch(() => {});
    const profile = { ...(previous?.toObject() || {}), ...fields };
    let qrCode = "";
    if (profile.qrFileId) {
      if (image) qrCode = req.body.qrCode;
      else {
        const chunks = [];
        for await (const chunk of bucket.openDownloadStream(profile.qrFileId)) chunks.push(chunk);
        qrCode = `data:${profile.qrContentType};base64,${Buffer.concat(chunks).toString("base64")}`;
      }
    }
    res.json(paymentResponse(profile, qrCode));
  });
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
                body.revision = (old?.revision || 0) + 1;
                body.totals = calculate(body);
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

if (await connectDB()) await initialize();
export default createApp();
