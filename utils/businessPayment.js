const invalid = (message) => Object.assign(new Error(message), { status: 400 });

export function validatePaymentUpdate(body) {
  const fields = {};
  for (const key of ["upiId", "payeeName"]) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== "string" || body[key].trim().length > 100)
      throw invalid(`${key === "upiId" ? "UPI ID" : "Payee name"} must be text of at most 100 characters.`);
    fields[key] = body[key].trim();
  }
  if (fields.upiId && !/^[\w.-]+@[\w.-]+$/.test(fields.upiId))
    throw invalid("Enter a valid UPI ID.");
  for (const key of ["showQrOnInvoices", "removeQrCode"]) {
    if (body[key] !== undefined && typeof body[key] !== "boolean")
      throw invalid(`${key} must be true or false.`);
  }
  if (body.showQrOnInvoices !== undefined)
    fields.showQrOnInvoices = body.showQrOnInvoices;
  let image;
  if (body.qrCode !== undefined && body.qrCode !== "") {
    if (body.removeQrCode) throw invalid("Choose either upload or remove QR code.");
    const match = typeof body.qrCode === "string" &&
      /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(body.qrCode);
    if (!match) throw invalid("Upload a PNG, JPEG or WebP QR image.");
    const buffer = Buffer.from(match[2], "base64");
    if (!buffer.length || buffer.length > 3 * 1024 * 1024)
      throw invalid("QR image must be no larger than 3 MB.");
    const signatureMatches = match[1] === "image/png"
      ? buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
      : match[1] === "image/jpeg"
        ? buffer.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))
        : buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP";
    if (!signatureMatches || buffer.toString("base64") !== match[2])
      throw invalid("The QR image data does not match its image format.");
    image = { buffer, contentType: match[1] };
  }
  return { fields, image, removeQrCode: body.removeQrCode === true };
}

export function paymentResponse(profile, qrCode = "") {
  return {
    upiId: profile?.upiId || "",
    payeeName: profile?.payeeName || "",
    showQrOnInvoices: profile?.showQrOnInvoices ?? true,
    qrCode,
  };
}
