import mongoose from "mongoose";

mongoose.set("bufferCommands", false);

let pending;
export async function connectDB() {
  if (mongoose.connection.readyState === 1) return true;
  if (pending) return pending;
  if (!process.env.MONGO_URI || process.env.MONGO_URI.includes("<YOUR_PASSWORD>")) {
    const error = new Error(
      "MongoDB is not configured. Set MONGO_URI in the server environment.",
    );
    console.error("MongoDB connection failed", error);
    throw Object.assign(error, { status: 503 });
  }
  pending = (async () => {
    try {
      await mongoose.connect(process.env.MONGO_URI, {
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 5000,
      });
      console.log("MongoDB connected");
      return true;
    } finally {
      pending = undefined;
    }
  })();
  return pending;
}
