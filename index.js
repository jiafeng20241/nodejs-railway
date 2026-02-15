、const express = require("express");
const httpProxy = require("http-proxy");
const app = express();

const CONFIG = {
  PORT: parseInt(process.env.PORT) || 8080,
  UUID: process.env.UUID || "9afd1229-b893-40c1-84dd-51e7ce204913",
  SUB_PATH: (process.env.SUB_PATH || "sub").replace(/^\/+/, ""),
  NAME: process.env.NAME || "Railway-Proxy",
};

const proxy = httpProxy.createProxyServer({
  changeOrigin: true,
  xfwd: true,
});

proxy.on("error", (err, req, res) => {
  console.error("[Proxy Error]", err);
  if (!res.headersSent) {
    res.writeHead(500);
    res.end("Proxy Error");
  }
});

app.get("/", (req, res) => {
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Railway Proxy Service</title>
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 40px; background: #f5f5f5; }
            .container { max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            h1 { color: #333; margin-top: 0; }
            .status { color: #27ae60; font-size: 18px; }
            .info { background: #ecf0f1; padding: 15px; border-radius: 5px; margin: 20px 0; }
            code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🚀 Railway Proxy Service</h1>
            <p class="status">✓ System Online</p>
            <div class="info">
                <p><strong>Status:</strong> Active</p>
                <p><strong>Node.js:</strong> ${process.version}</p>
                <p><strong>UUID:</strong> ${CONFIG.UUID}</p>
            </div>
            <p>Subscribe URL: <code>/${CONFIG.SUB_PATH}</code></p>
        </div>
    </body>
    </html>
  `;
  res.type("html").send(html);
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "alive",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

app.get(`/${CONFIG.SUB_PATH}`, (req, res) => {
  const host = req.get("host");
  const proxyConfig = `http://${CONFIG.UUID}@${host}`;
  const base64 = Buffer.from(proxyConfig).toString("base64");
  res.type("text/plain").send(base64);
});

const server = app.listen(CONFIG.PORT, "::", () => {
  console.log(`[✓] HTTP Server listening on [::]:${CONFIG.PORT}`);
});

server.keepAliveTimeout = 65000;
