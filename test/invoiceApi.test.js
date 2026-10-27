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
test("invoice list ignores empty optional filters and applies non-empty status filters", async () => {
  const draft = await request("/invoices", "POST", {
    ...newInvoice(),
    id: "empty-filter-draft",
    number: "EMPTY-FILTER-DRAFT",
    status: "Draft",
    date: "2026-10-01",
  }, 201);
  const cancelled = await request("/invoices", "POST", {
    ...newInvoice(),
    id: "empty-filter-cancelled",
    number: "EMPTY-FILTER-CANCELLED",
    status: "Cancelled",
    date: "2026-10-02",
  }, 201);

  const all = await request("/invoices");
  const withEmptyFilters = await request("/invoices?search=&status=&from=&to=");
  assert.equal(withEmptyFilters.length, all.length);
  assert.ok(withEmptyFilters.some((invoice) => invoice.id === draft.id));
  assert.ok(withEmptyFilters.some((invoice) => invoice.id === cancelled.id));

  const drafts = await request("/invoices?status=Draft&from=&to=");
  assert.ok(drafts.some((invoice) => invoice.id === draft.id));
  assert.ok(drafts.every((invoice) => invoice.status === "Draft"));
  const searched = await request("/invoices?search=EMPTY-FILTER-CANCELLED");
  assert.deepEqual(searched.map((invoice) => invoice.id), [cancelled.id]);
});

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

test('party details and business profiles survive round trips without losing old fields', async () => {
  let party = await request('/buyers','POST',{id:'party-upgrade',name:'Test Customer',mobile:'9000000000',address:'Original address',gstin:'',email:'a@example.test',notes:'Keep me',active:true,partyType:'Supplier',pan:'ABCDE1234F',openingBalance:400,openingBalanceType:'To Pay',addressParts:{area:'Street',pin:'560062',city:'Bengaluru',state:'Karnataka'},shippingAddress:'Warehouse',creditDays:30,creditLimit:50000,contactName:'Accounts',contactPhone:'123',bankName:'Test Bank',bankAccount:'123456',bankIfsc:'TEST0001234',customFields:'Region: South'},201);
  assert.equal(party.addressParts.pin,'560062');
  party = await request('/buyers/party-upgrade','PUT',{...party,name:'Edited Customer'});
  assert.equal(party.notes,'Keep me'); assert.equal(party.shippingAddress,'Warehouse'); assert.equal(party.creditDays,30);
  await request('/business-profile','PUT',{...defaultSeller,pan:'ABCDE1234F',qrMode:'dynamic',website:'https://example.test'});
  await request('/business-profile','PUT',{city:'Bengaluru'});
  const profile = await request('/business-profile');
  assert.equal(profile.name,defaultSeller.name); assert.equal(profile.qrMode,'dynamic'); assert.equal(profile.city,'Bengaluru');
});

test('payment ledger is idempotent under retries, concurrent payments and invoice edits', async () => {
  const product = {id:'ledger-product',name:'Cabinet',code:'ledger',barcode:'123456789',hsn:'9403',category:'Furniture',price:18000,stock:10,variants:[]};
  await request('/products','POST',product,201);
  let invoice = await request('/invoices','POST',{...newInvoice(),number:'LEDGER-18000',status:'Completed',seller:defaultSeller,receivedAmount:5000,items:[{id:'ledger-line',productId:product.id,name:'Cabinet',qty:1,price:18000,hsn:'9403'}]},201);
  const path = `/invoices/${invoice.id}/payments`;
  const first = {id:'pay-1',amount:3000,date:'2026-10-16',method:'UPI',reference:'UPI-001'};
  await Promise.all([request(path,'POST',first),request(path,'POST',first)]);
  invoice = await request(`/invoices/${invoice.id}`);
  assert.equal(invoice.receivedAmount,8000); assert.equal(invoice.payments.length,1); assert.equal(invoice.paymentOpeningReceived,5000);
  assert.equal((await request('/products/ledger-product')).stock,9);
  await request(path,'POST',{...first,amount:4000},409);
  await request(path,'POST',{...first,id:'pay-ref-duplicate'},409);
  await request(path,'POST',{...first,id:'too-large',amount:10001,reference:''},400);
  await request(`/invoices/${invoice.id}`,'PUT',{...invoice,receivedAmount:9000},400);
  await request(`/invoices/${invoice.id}`,'DELETE',invoice,400);
  invoice = await request(path,'POST',{...first,id:'pay-final',amount:10000,reference:'UPI-002'});
  assert.equal(invoice.receivedAmount,18000); assert.equal(invoice.payments.length,2);
  assert.equal((await request('/products/ledger-product')).stock,9);
  const before = invoice.totals;
  invoice = await request(`/invoices/${invoice.id}`,'PUT',{...invoice,status:'Cancelled'});
  assert.deepEqual(invoice.totals,before); assert.equal(invoice.payments.length,2);
  assert.equal((await request('/products/ledger-product')).stock,10);
});

test('optional exclusive pricing, discounts, charges and rounding persist', async () => {
  const invoice = await request('/invoices','POST',{...newInvoice(),number:'EXCLUSIVE',status:'Completed',seller:defaultSeller,receivedAmount:0,pricingMode:'exclusive',autoRoundOff:true,additionalCharges:10.25,items:[{id:'e1',name:'Item',qty:2,price:100,hsn:'123',discountPercent:10,gstPercent:18}]},201);
  assert.equal(invoice.totals.taxable,180); assert.equal(invoice.totals.tax,32.4); assert.equal(invoice.totals.grand,223); assert.equal(invoice.totals.roundOff,0.35);
});

test('billing address survives buyer and invoice saves, and requests reconnect after disconnection', async () => {
  const parts = {area: '42 Main Road', pin: '560062', city: 'Bengaluru', state: 'Karnataka'};
  const address = `${parts.area}\nCity / District: ${parts.city}\nState: ${parts.state}\nPIN Code: ${parts.pin}`;
  const buyer = await request('/buyers', 'POST', {id:'address-regression',name:'Address Buyer',mobile:'9000000000',address,addressParts:parts,gstin:'',active:true}, 201);
  const invoice = await request('/invoices', 'POST', {...newInvoice(),number:'ADDRESS-REGRESSION',seller:defaultSeller,buyerId:buyer.id,buyer:{name:buyer.name,mobile:buyer.mobile,gstin:buyer.gstin,address}}, 201);
  await request('/buyers/'+buyer.id, 'PUT', {...buyer,address:address.replace('42 Main Road','43 Main Road'),addressParts:{...parts,area:'43 Main Road'}});
  assert.equal((await request('/invoices/'+invoice.id)).buyer.address,address);
  const previousUri = process.env.MONGO_URI;
  try {
    process.env.MONGO_URI = db.getUri();
    await mongoose.disconnect();
    const [reloaded, health] = await Promise.all([request('/buyers/'+buyer.id), request('/health')]);
    assert.equal(reloaded.addressParts.pin, parts.pin);
    assert.match(reloaded.address,/43 Main Road/);
    assert.equal(health.database,'connected');
  } finally { process.env.MONGO_URI = previousUri; }
});
