import "dotenv/config";

import { createApp } from "./app.js";

// Everything the server does lives in `createApp` (src/app.js), so that the
// tests and `npm run verify:local` can run the same routes in-process.
const { app, ticker, port } = await createApp();

// HOST=127.0.0.1 keeps the app off the network entirely (the Day 27 manual check).
const host = process.env.HOST || undefined;
app.listen(port, host, () => {
  console.log(`first-agent listening on http://${host ?? "localhost"}:${port}`);
  // The ticker starts with the server; a scheduler that is not up yet is
  // logged once and waited for.
  ticker.start();
});
