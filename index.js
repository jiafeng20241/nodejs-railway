const express = require("express");
const app = express();
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const unzipper = require("unzipper");
const http = require("http");
const net = require("net");

const CONFIG = {
  UUID: process.env.UUID || "9afd1229-b893-40c1-84dd-51e7ce204913",
  PORT: parseInt(process.env.PORT) || 8080,
  XRAY_PORT: 3000, 
  RAIL_DOMAIN: process.env.RAILWAY_STATIC_URL || "nodejs-railway-production-ad5e.up.railway.app",
  SUB_PATH: (process.env.SUB_PATH || "sub").replace(/^\/+/, ""),
  FILE_PATH: "./bin_core",
};

if (!fs.existsSync(CONFIG.FILE_PATH)) fs.mkdirSync(CONFIG.FILE_PATH, { recursive: true });

async function boot() {
  const xrayZipUrl = `https://github.com/XTLS/Xray-core/releases/download/v26.2.6/Xray-linux-64.zip`;

  try {
    console.log("[INFO] 🚀 启动自修复硬核版...");
    const response = await axios({ url: xrayZipUrl, method: 'GET', responseType: 'stream' });
    await response.data.pipe(unzipper.Extract({ path: CONFIG.FILE_PATH })).promise();
    const xrayPath = path.join(CONFIG.FILE_PATH, 'xray');
    if (fs.existsSync(xrayPath)) fs.chmodSync(xrayPath, 0o755);
    else {
        const bin = fs.readdirSync(CONFIG.FILE_PATH).find(f => f.toLowerCase().includes('xray'));
        fs.renameSync(path.join(CONFIG.FILE_PATH, bin), xrayPath);
        fs.chmodSync(xrayPath, 0o755);
    }

    const config = {
      log: { loglevel: "error" },
      inbounds: [{
        port: CONFIG.XRAY_PORT,
        protocol: "vless",
        settings: { clients: [{ id: CONFIG.UUID, level: 0 }], decryption: "none" },
        streamSettings: { network: "ws", wsSettings: { path: "/speed" } }
      }],
      outbounds: [{ protocol: "freedom", settings: { domainStrategy: "UseIPv4" } }]
    };
    fs.writeFileSync(path.join(CONFIG.FILE_PATH, "config.json"), JSON.stringify(config, null, 2));
    spawn(xrayPath, ["-c", path.join(CONFIG.FILE_PATH, "config.json")], { stdio: 'inherit' });
    console.log(`[✓] Xray alive on ${CONFIG.XRAY_PORT}`);
  } catch (err) { console.error(`Boot Failed: ${err.message}`); }
}

app.get("/", (req, res) => res.send("Native Mode Online"));
app.get(`/${CONFIG.SUB_PATH}`, (req, res) => {
  const vless = `vless://${CONFIG.UUID}@${CONFIG.RAIL_DOMAIN}:443?encryption=none&security=tls&sni=${CONFIG.RAIL_DOMAIN}&type=ws&path=%2Fspeed#Railway-Native`;
  res.send(Buffer.from(vless).toString("base64"));
});

boot();

const server = http.createServer(app);
// 【自修复核心】更稳健的 WebSocket 转发逻辑
server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/speed')) {
    const target = net.connect(CONFIG.XRAY_PORT, '127.0.0.1', () => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
      target.write(head);
      socket.pipe(target).pipe(socket);
    });
    target.on('error', (e) => {
      console.error("[Proxy Error]", e.message);
      socket.end();
    });
  }
});

server.listen(CONFIG.PORT);
