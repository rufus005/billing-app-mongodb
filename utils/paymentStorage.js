import mongoose from "mongoose";
import { BusinessPayment } from "../models/index.js";
import { paymentResponse, validatePaymentUpdate } from "./businessPayment.js";

const qrBucket = () => new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
  bucketName: "businessQr",
});
const missingFile = (error) => error.code === "ENOENT";

async function readPayment(profile, bucket = qrBucket()) {
  if (!profile?.qrFileId) return paymentResponse(profile);
  try {
    const chunks = [];
    const stream = bucket.openDownloadStream(profile.qrFileId);
    let file;
    stream.on("file", (metadata) => { file = metadata; });
    for await (const chunk of stream) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);
    // GridFS can end without an error when all chunks have disappeared.
    if (!file || !buffer.length || buffer.length !== file.length)
      throw new Error("Stored QR image is incomplete.");
    const qrCode = `data:${profile.qrContentType || file.contentType};base64,${buffer.toString("base64")}`;
    try {
      validatePaymentUpdate({ qrCode });
    } catch {
      throw new Error("Stored QR image has invalid content or metadata.");
    }
    return paymentResponse(profile, qrCode);
  } catch (error) {
    // A dangling reference must not make the saved text settings inaccessible.
    // Keep the record untouched and explicitly report that the image needs repair.
    if (!missingFile(error)) throw error;
    console.warn("Business payment QR file missing", { fileId: String(profile.qrFileId) });
    return {
      ...paymentResponse(profile),
      qrCodeWarning: "The saved QR image is missing. Upload it again or remove it in Business Settings.",
    };
  }
}

async function deleteQr(bucket, id) {
  try {
    await bucket.delete(id);
  } catch (error) {
    if (!missingFile(error) && !(error.name === "MongoRuntimeError" && error.message === `File not found for id ${id}`)) {
      // The new settings are already durable; cleanup failure must not imply
      // that the save failed. Keep enough diagnostics to retry orphan cleanup.
      console.error("Business payment QR cleanup failed", {
        fileId: String(id), name: error.name, code: error.code,
      });
    }
  }
}

export async function getPaymentSettings() {
  return readPayment(await BusinessPayment.findById("business"));
}

export async function savePaymentSettings(body) {
  const { fields, image, removeQrCode } = validatePaymentUpdate(body);
  const bucket = qrBucket();
  let uploadedId;
  if (removeQrCode) Object.assign(fields, { qrFileId: null, qrContentType: "" });
  if (image) {
    const upload = bucket.openUploadStream("business-qr", { contentType: image.contentType });
    try {
      await new Promise((resolve, reject) => {
        upload.on("error", reject);
        upload.on("finish", resolve);
        upload.end(image.buffer);
      });
    } catch (error) {
      await deleteQr(bucket, upload.id);
      throw error;
    }
    uploadedId = upload.id;
    Object.assign(fields, { qrFileId: uploadedId, qrContentType: image.contentType });
  }
  let previous;
  try {
    // Publish the reference only after GridFS finishes writing the image.
    // The atomic preimage identifies the file replaced by this specific save.
    previous = await BusinessPayment.findByIdAndUpdate(
      "business", { $set: fields },
      { upsert: true, new: false, setDefaultsOnInsert: true, runValidators: true },
    );
  } catch (error) {
    if (uploadedId) await deleteQr(bucket, uploadedId);
    throw error;
  }
  if ((image || removeQrCode) && previous?.qrFileId) await deleteQr(bucket, previous.qrFileId);
  const profile = { ...(previous?.toObject() || {}), ...fields };
  return image ? paymentResponse(profile, body.qrCode) : readPayment(profile, bucket);
}
