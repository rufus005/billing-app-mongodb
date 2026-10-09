import mongoose from "mongoose";
export async function connectDB() {
  if (
    !process.env.MONGO_URI ||
    process.env.MONGO_URI.includes("<YOUR_PASSWORD>")
  ) {
    console.error(
      "MongoDB is not configured. Set MONGO_URI in the server environment.",
    );
    return false;
  }
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 5000,
    });
    console.log("MongoDB connected");
    return true;
  } catch {
    console.error(
      "MongoDB connection failed. Check credentials, network access and Atlas configuration.",
    );
    return false;
  }
}
