import assert from "node:assert/strict";
import { test } from "node:test";
import { validatePaymentUpdate, paymentResponse } from "../utils/businessPayment.js";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
test("payment settings preserve omitted fields and accept explicit clearing", () => {
  assert.deepEqual(validatePaymentUpdate({ showQrOnInvoices: false }).fields, { showQrOnInvoices: false });
  assert.deepEqual(validatePaymentUpdate({ upiId: " store@bank ", payeeName: " Shop " }).fields,
    { upiId: "store@bank", payeeName: "Shop" });
  assert.equal(validatePaymentUpdate({ upiId: "" }).fields.upiId, "");
  assert.deepEqual(paymentResponse(null), { upiId: "", payeeName: "", showQrOnInvoices: true, qrCode: "" });
  assert.equal(paymentResponse({ showQrOnInvoices: false }).showQrOnInvoices, false);
});
test("invalid payment fields are rejected before storage", () => {
  for (const body of [{ upiId: 12 }, { upiId: "invalid" }, { payeeName: "x".repeat(101) },
    { showQrOnInvoices: "false" }, { removeQrCode: "true" }, { qrCode: null },
    { qrCode: png, removeQrCode: true }, { qrCode: "data:image/png;base64,aGVsbG8=" }])
    assert.throws(() => validatePaymentUpdate(body), { status: 400 });
});
test("PNG, JPEG and WebP signatures are accepted and upload size is bounded", () => {
  assert.equal(validatePaymentUpdate({ qrCode: png }).image.contentType, "image/png");
  for (const [format, bytes] of [["jpeg", Buffer.from("ffd8ffe00010", "hex")],
    ["webp", Buffer.from("RIFF0000WEBP")]]) {
    assert.equal(validatePaymentUpdate({ qrCode: `data:image/${format};base64,${bytes.toString("base64")}` }).image.contentType, `image/${format}`);
  }
  const large = Buffer.alloc(3 * 1024 * 1024 + 1);
  assert.throws(() => validatePaymentUpdate({ qrCode: `data:image/png;base64,${large.toString("base64")}` }), /3 MB/);
});
