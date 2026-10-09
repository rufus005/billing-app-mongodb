import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { connectDB } from "./config/db.js";
import { createApp, initialize } from "./app.js";

dotenv.config({
  path: [
    fileURLToPath(new URL("./.env", import.meta.url)),
    fileURLToPath(new URL("../.env", import.meta.url)),
  ],
});

if (await connectDB()) await initialize();
const server = createApp().listen(process.env.PORT || 5000, () =>
  console.log(`Billing API listening on port ${process.env.PORT || 5000}`),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () =>
    server.close(async () => {
      await mongoose.disconnect();
      process.exit(0);
    }),
  );
