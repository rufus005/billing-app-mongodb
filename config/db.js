import mongoose from "mongoose";

let pending;
export async function connectDB() {
  if (mongoose.connection.readyState === 1) return true;
  if (pending) return pending;
  if (!process.env.MONGO_URI || process.env.MONGO_URI.includes("<YOUR_PASSWORD>")) {
    console.error("MongoDB is not configured. Set MONGO_URI in the server environment.");
    return false;
  }
  // Share one bounded attempt, and release failures so a later request can recover.
  pending = (async () => {
    try {
      await mongoose.connect(process.env.MONGO_URI, {
        serverSelectionTimeoutMS: 5000,
      });
      console.log("MongoDB connected");
      return true;
    } catch (error) {
      // Never log the URI or driver message: either may contain credentials.
      console.error("MongoDB connection failed", { name: error.name, code: error.code });
      return false;
    } finally {
      pending = undefined;
    }
  })();
  return pending;
}
