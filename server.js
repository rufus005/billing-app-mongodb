import mongoose from "mongoose";
import app from "./app.js";

const server = app.listen(process.env.PORT || 5000, () =>
  console.log(`Billing API listening on port ${process.env.PORT || 5000}`),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () =>
    server.close(async () => {
      await mongoose.disconnect();
      process.exit(0);
    }),
  );
