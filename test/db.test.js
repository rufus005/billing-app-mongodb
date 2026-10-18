import assert from "node:assert/strict";
import { test, mock } from "node:test";
import mongoose from "mongoose";
import { connectDB } from "../config/db.js";

process.env.MONGO_URI = "mongodb://127.0.0.1:1/test-only";
test("concurrent requests share a connection attempt and recover after an initial failure", async () => {
  let attempts = 0;
  const connect = mock.method(mongoose, "connect", async () => {
    attempts++;
    await new Promise(resolve => setTimeout(resolve, 10));
    if (attempts === 1) throw Object.assign(new Error("private connection detail"), { name: "MongoServerSelectionError" });
    return mongoose;
  });
  const messages = [];
  const log = mock.method(console, "error", (...args) => messages.push(args));
  try {
    assert.deepEqual(await Promise.all([connectDB(), connectDB(), connectDB()]), [false, false, false]);
    assert.equal(attempts, 1);
    assert.deepEqual(await Promise.all([connectDB(), connectDB()]), [true, true]);
    assert.equal(attempts, 2);
    assert.doesNotMatch(JSON.stringify(messages), /private connection detail|mongodb:\/\//);
  } finally { connect.mock.restore(); log.mock.restore(); }
});
