import { createApp } from "./app.js";

const appName = process.env.APP_NAME || "app";
const port = Number(process.env.PORT || 3000);
const nodeEnv = process.env.NODE_ENV || "development";

const server = createApp();

server.listen(port, () => {
  console.log(`[${appName}] API listening on port ${port} in ${nodeEnv} mode`);
});
