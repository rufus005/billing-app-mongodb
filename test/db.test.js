import assert from "node:assert/strict";
import { test, mock } from "node:test";
import mongoose from "mongoose";
import { connectDB } from "../config/db.js";

process.env.MONGO_URI = "mongodb://127.0.0.1:1/test-only";
test("concurrent requests share a connection attempt and recover after an initial failure", async () => {
  let attempts = 0;
  const failure = Object.assign(new Error("private connection detail"), { name: "MongoServerSelectionError" });
  const connect = mock.method(mongoose, "connect", async () => {
    attempts++;
    await new Promise(resolve => setTimeout(resolve, 10));
    if (attempts === 1) throw failure;
    return mongoose;
  });
  try {
    const first = await Promise.allSettled([connectDB(), connectDB(), connectDB()]);
    assert.deepEqual(first.map(result => result.status), ["rejected", "rejected", "rejected"]);
    assert.ok(first.every(result => result.status === "rejected" && result.reason === failure));
    assert.equal(attempts, 1);
    assert.deepEqual(await Promise.all([connectDB(), connectDB()]), [true, true]);
    assert.equal(attempts, 2);
  } finally { connect.mock.restore(); }
});
