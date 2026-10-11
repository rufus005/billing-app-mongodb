import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { MongoMemoryServer } from "mongodb-memory-server-core";

// Never connect this suite to .env or an existing database.
process.env.MONGO_URI = "";
process.env.ADMIN_USERNAME = "payment-test-admin";
process.env.ADMIN_PASSWORD = "payment-test-password";
process.env.JWT_SECRET = "payment-test-secret";
const origin = "https://billing-app-frontent.vercel.app";
process.env.CLIENT_URL = origin;
process.env.MONGOMS_DOWNLOAD_DIR = "/tmp/billing-test-mongodb";
const { createApp } = await import("../app.js");
const { BusinessPayment } = await import("../models/index.js");
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
let mongod, server, base, token;
const start = async () => {
  server = createApp().listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
};
const close = () => new Promise(resolve => server.close(resolve));
const request = (method = "GET", body, credential = token) => fetch(`${base}/api/business-payment`, {
  method, headers: { Origin: origin, "Content-Type": "application/json", ...(credential ? { Authorization: `Bearer ${credential}` } : {}) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const login = async () => {
  const response = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD }) });
  assert.equal(response.status, 200);
  token = (await response.json()).token;
};
const settings = async (method = "GET", body) => {
  const response = await request(method, body);
  assert.equal(response.status, 200, await response.clone().text());
  assert.match(response.headers.get("cache-control"), /no-store/);
  return response.json();
};
before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: "payment_regression" });
  await BusinessPayment.init();
  await start();
  await login();
});
after(async () => {
  if (server) await close();
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

test("payment APIs with real MongoDB and GridFS", async t => {
  const empty = { upiId: "", payeeName: "", showQrOnInvoices: true, qrCode: "" };
  const files = () => mongoose.connection.db.collection("businessQr.files");
  const chunks = () => mongoose.connection.db.collection("businessQr.chunks");
  await t.test("missing settings return defaults without creating a record", async () => {
    assert.deepEqual(await settings(), empty);
    assert.equal(await BusinessPayment.countDocuments(), 0);
  });
  await t.test("GET, POST and PUT require a valid unexpired admin token", async () => {
    const badTokens = [null, "invalid", jwt.sign({}, "wrong-secret"),
      jwt.sign({}, process.env.JWT_SECRET, { subject: process.env.ADMIN_USERNAME, issuer: "wrong" }),
      jwt.sign({}, process.env.JWT_SECRET, { subject: "another-admin", issuer: "billing-app" }),
      jwt.sign({}, process.env.JWT_SECRET, { subject: process.env.ADMIN_USERNAME, issuer: "billing-app", expiresIn: -1 })];
    for (const method of ["GET", "POST", "PUT"])
      for (const bad of badTokens) assert.equal((await request(method, method === "GET" ? undefined : {}, bad)).status, 401);
  });
  await t.test("preflight allows the frontend and auth headers without a token", async () => {
    for (const method of ["GET", "POST", "PUT"]) {
      const response = await fetch(`${base}/api/business-payment`, { method: "OPTIONS", headers: {
        Origin: origin, "Access-Control-Request-Method": method, "Access-Control-Request-Headers": "authorization,content-type",
      } });
      assert.equal(response.status, 204);
      assert.equal(response.headers.get("access-control-allow-origin"), origin);
      assert.match(response.headers.get("access-control-allow-headers"), /authorization/);
    }
  });
  await t.test("POST creates text settings and PUT preserves omitted fields", async () => {
    assert.deepEqual(await settings("POST", { upiId: " shop@bank ", payeeName: " Shop " }), { ...empty, upiId: "shop@bank", payeeName: "Shop" });
    assert.deepEqual(await settings("PUT", { showQrOnInvoices: false }), { ...empty, upiId: "shop@bank", payeeName: "Shop", showQrOnInvoices: false });
  });
  await t.test("the production dangling QR reference returns saved settings and an explicit warning without rewriting data", async () => {
    await BusinessPayment.updateOne({ _id: "business" }, { $set: { qrFileId: new mongoose.Types.ObjectId(), qrContentType: "" } });
    const before = await BusinessPayment.collection.findOne({ _id: "business" });
    const result = await settings();
    assert.equal(result.upiId, "shop@bank");
    assert.equal(result.qrCode, "");
    assert.match(result.qrCodeWarning, /missing.*Upload/);
    assert.deepEqual(await BusinessPayment.collection.findOne({ _id: "business" }), before);
    assert.equal((await settings("PUT", { payeeName: "Updated Shop" })).payeeName, "Updated Shop");
  });
  await t.test("upload repairs a dangling reference; refresh and login retain the image", async () => {
    const saved = await settings("PUT", { qrCode: png, showQrOnInvoices: true });
    assert.equal(saved.qrCode, png);
    assert.equal(saved.qrCodeWarning, undefined);
    assert.equal(await files().countDocuments(), 1);
    await close();
    await start();
    await login();
    assert.deepEqual(await settings(), saved);
    assert.deepEqual(await settings("PUT", { qrCode: "", payeeName: "Renamed" }), { ...saved, payeeName: "Renamed" });
  });
  await t.test("PNG, JPEG and WebP at the 3 MiB boundary round-trip and replace old files", async () => {
    for (const [format, signature] of [["png", Buffer.from("89504e470d0a1a0a", "hex")], ["jpeg", Buffer.from("ffd8ff", "hex")], ["webp", Buffer.from("RIFF0000WEBP")]]) {
      const bytes = Buffer.alloc(3 * 1024 * 1024);
      signature.copy(bytes);
      const qrCode = `data:image/${format};base64,${bytes.toString("base64")}`;
      assert.equal((await settings("PUT", { qrCode })).qrCode, qrCode);
      assert.equal((await settings()).qrCode, qrCode);
      assert.equal(await files().countDocuments(), 1);
    }
  });
  await t.test("invalid images, oversized images, conflicting actions and invalid fields do not alter saved data", async () => {
    const before = await settings();
    for (const body of [[], { upiId: "invalid" }, { payeeName: "x".repeat(101) }, { showQrOnInvoices: "false" },
      { qrCode: null }, { qrCode: "data:image/svg+xml;base64,PHN2Zz4=" }, { qrCode: "data:image/png;base64,aGVsbG8=" },
      { qrCode: png, removeQrCode: true }, { qrCode: `data:image/png;base64,${Buffer.alloc(3 * 1024 * 1024 + 1).toString("base64")}` }]) {
      assert.equal((await request("PUT", body)).status, 400);
    }
    assert.deepEqual(await settings(), before);
    assert.equal(await files().countDocuments(), 1);
  });
  await t.test("failed settings update cleans the new upload and preserves the old file", async t => {
    const before = await settings();
    const mock = t.mock.method(BusinessPayment, "findByIdAndUpdate", async () => { throw new Error("test storage failure"); });
    assert.equal((await request("PUT", { qrCode: png })).status, 500);
    mock.mock.restore();
    assert.deepEqual(await settings(), before);
    assert.equal(await files().countDocuments(), 1);
  });
  await t.test("database failures remain errors, never empty success responses", async t => {
    const mock = t.mock.method(BusinessPayment, "findById", async () => { throw new mongoose.mongo.MongoNetworkError("test network failure"); });
    assert.equal((await request()).status, 503);
    mock.mock.restore();
  });
  await t.test("corrupt GridFS chunks are an error rather than a missing-image fallback", async () => {
    await settings("PUT", { qrCode: png });
    const profile = await BusinessPayment.findById("business");
    await chunks().deleteMany({ files_id: profile.qrFileId });
    assert.equal((await request()).status, 500);
    await settings("PUT", { qrCode: png });
  });
  await t.test("removal clears reference and chunks and retains text across login", async () => {
    const result = await settings("PUT", { removeQrCode: true });
    assert.equal(result.qrCode, "");
    assert.equal(result.upiId, "shop@bank");
    assert.equal(await files().countDocuments(), 0);
    assert.equal(await chunks().countDocuments(), 0);
    await login();
    assert.deepEqual(await settings(), result);
    assert.equal((await settings("PUT", { upiId: "", payeeName: "", showQrOnInvoices: false })).showQrOnInvoices, false);
  });
});
