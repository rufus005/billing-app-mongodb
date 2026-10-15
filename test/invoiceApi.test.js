import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
process.env.MONGO_URI = "";
process.env.ADMIN_USERNAME = "invoice-test";
process.env.ADMIN_PASSWORD = "invoice-test-password";
process.env.JWT_SECRET = "invoice-test-secret";
process.env.MONGOMS_DOWNLOAD_DIR = "/tmp/billing-test-mongodb";
const { createApp, initialize } = await import("../app.js");
const { Invoice } = await import("../models/index.js");
const { newInvoice, defaultSeller } = await import("../utils/invoiceTypes.js");
let db, server, base, token;
before(async () => {
  db = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(db.getUri());
  await initialize();
  server = createApp().listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
  const login = await fetch(base + "/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD }) });
  token = (await login.json()).token;
});
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect();
  if (db) await db.stop();
});
async function request(path, method = "GET", data, status = 200) {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, ...(data ? { body: JSON.stringify(data) } : {}) });
  const body = await res.json();
  assert.equal(res.status, status, JSON.stringify(body));
  return body;
}
test("confirmed receipt totals persist, edits replace totals, retries cannot double debit, and legacy invoices survive", async () => {
  let saved = await request("/invoices", "POST", {
    ...newInvoice(), number: "PAY-18000", receivedAmount: 5000,
    seller: defaultSeller, status: "Completed", taxMode: "gst", taxJurisdiction: "inter", dueDate: "2026-11-01",
    shipTo: { name: "Warehouse", address: "Long delivery address", mobile: "123", gstin: "" },
    items: [{ id: "line", name: "Inclusive item", hsn: "1234", qty: 1, price: 18000, gstPercent: 18 }],
  }, 201);
  assert.equal(saved.receivedAmount, 5000);
  assert.equal(saved.totals.grand, 18000);
  assert.equal(saved.totals.taxable, 15254.24);
  assert.equal(saved.totals.tax, 2745.76);
  let loaded = (await request("/invoices")).find(i => i.id === saved.id);
  assert.equal(loaded.totals.grand - loaded.receivedAmount, 13000);
  assert.equal(loaded.shipTo.name, "Warehouse");
  assert.equal(loaded.taxJurisdiction, "inter");
  assert.equal(loaded.dueDate, "2026-11-01");
  saved = await request(`/invoices/${saved.id}`, "PUT", saved);
  assert.equal(saved.receivedAmount, 5000);
  await request(`/invoices/${saved.id}`, "PUT", loaded, 409);
  saved = await request(`/invoices/${saved.id}`, "PUT", { ...saved, receivedAmount: 6000 });
  assert.equal(saved.totals.grand - saved.receivedAmount, 12000);
  for (const bad of [-1, null, "5000"]) await request(`/invoices/${saved.id}`, "PUT", { ...saved, receivedAmount: bad }, 400);
  const omit = { ...saved }; delete omit.receivedAmount;
  saved = await request(`/invoices/${saved.id}`, "PUT", omit);
  assert.equal(saved.receivedAmount, 6000);
  saved = await request(`/invoices/${saved.id}`, "PUT", { ...saved, receivedAmount: 18000 });
  assert.equal(saved.totals.grand - saved.receivedAmount, 0);
  saved = await request(`/invoices/${saved.id}`, "PUT", { ...saved, receivedAmount: 0, taxMode: "non-gst" });
  assert.equal(saved.receivedAmount, 0);
  assert.equal(saved.totals.tax, 0);
  assert.equal(saved.totals.taxable, 18000);
  const legacy = await Invoice.create({ ...newInvoice(), number: "LEGACY" });
  assert.equal((await request("/invoices")).find(i => i.id === legacy.id).receivedAmount, undefined);
});
