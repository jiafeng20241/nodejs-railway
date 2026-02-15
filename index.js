const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const axios = require("axios");
const net = require("net");
const crypto = require("crypto");

const CONFIG = {
  UUID: process.env.UUID || "9afd1229-b893-40c1-84dd-51e7ce204913",
  PORT: parseInt(process.env.PORT) || 8080,
  XRAY_PORT: 3001,
  
  // 【关键】使用 Railway TCP Proxy 端点（需要在 Railway 后台启用）
  TCP_PROXY: process.env.RAILWAY_TCP_PROXY_DOMAIN || "",
  TCP_PORT: parseInt(process.env.RAILWAY_TCP_PROXY_PORT) || 0,
  
  // HTTP 域名仅用于获取订阅
  HTTP_DOMAIN: process.env.RAILWAY_STATIC_URL || "",
  
  FILE_PATH: "./bin_core",
};

// ========== 下载并启动 Xray ==========
async function bootXray() {
  console.log("[启动] 原生IP直连版本...\n");
  
  if (!fs.existsSync(CONFIG.FILE_PATH)) {
    fs.mkdirSync(CONFIG.FILE_PATH, { recursive: true });
  }

  const xrayPath = path.join(CONFIG.FILE_PATH, "xray");
  
  if (!fs.existsSync(xrayPath)) {
    console.log("[下载] Xray 核心...");
    
    // 使用正确的版本号格式
    const url = "https://github.com/XTLS/Xray-core/releases/download/v24.12.18/Xray-linux-64.zip";
    
    try {
      const response = await axios({
        url: url,
        method: "GET",
        responseType: "arraybuffer",
        timeout: 60000
      });

      const zipPath = path.join(CONFIG.FILE_PATH, "xray.zip");
      fs.writeFileSync(zipPath, response.data);

      // 解压
      const AdmZip = require('adm-zip');
      const zip = new AdmZip(zipPath);
      zip.extractAllTo(CONFIG.FILE_PATH, true);
      fs.unlinkSync(zipPath);

      if (fs.existsSync(xrayPath)) {
        fs.chmodSync(xrayPath, 0o755);
        console.log("[✓] Xray 下载完成\n");
      }
    } catch (err) {
      console.error(`[错误] 下载失败: ${err.message}`);
      process.exit(1);
    }
  }

  // 【核心配置】纯 VLESS + TCP（无 TLS，无 WebSocket）
  const config = {
    log: { 
      loglevel: "warning" 
    },
    
    inbounds: [{
      port: CONFIG.XRAY_PORT,
      listen: "127.0.0.1",
      protocol: "vless",
      settings: {
        clients: [{
          id: CONFIG.UUID,
          level: 0
        }],
        decryption: "none"
      },
      streamSettings: {
        network: "tcp",  // 【关键】使用纯 TCP，不用 WebSocket
        tcpSettings: {
          header: {
            type: "none"  // 无混淆
          }
        },
        security: "none"  // 【关键】无 TLS 加密
      }
    }],

    outbounds: [{
      protocol: "freedom",
      settings: {
        domainStrategy: "UseIP"  // 直接使用 IP，避免 DNS 污染
      }
    }]
  };

  fs.writeFileSync(
    path.join(CONFIG.FILE_PATH, "config.json"),
    JSON.stringify(config, null, 2)
  );

  // 启动 Xray
  const xray = spawn(xrayPath, ["-c", path.join(CONFIG.FILE_PATH, "config.json")]);
  
  xray.stdout.on("data", (data) => console.log(`[Xray] ${data}`));
  xray.stderr.on("data", (data) => console.error(`[Xray] ${data}`));
  
  xray.on("exit", (code) => {
    console.error(`[错误] Xray 退出 (code ${code})，10秒后重启...`);
    setTimeout(bootXray, 10000);
  });

  console.log("[✓] Xray 已启动（纯 TCP 模式）\n");
}

// ========== HTTP 服务器（仅用于订阅） ==========
const app = express();

app.get("/", (req, res) => {
  res.send(`
    <h1>Railway 原生IP代理</h1>
    <p>订阅地址: <code>https://${CONFIG.HTTP_DOMAIN}/sub</code></p>
    <p><strong>注意：必须使用 Railway TCP Proxy 端点！</strong></p>
  `);
});

app.get("/sub", (req, res) => {
  if (!CONFIG.TCP_PROXY || !CONFIG.TCP_PORT) {
    return res.status(500).send("错误：未配置 TCP Proxy！请在 Railway 后台启用 TCP Proxy。");
  }

  // 【关键】订阅链接指向 Railway TCP Proxy 端点
  const vless = `vless://${CONFIG.UUID}@${CONFIG.TCP_PROXY}:${CONFIG.TCP_PORT}?encryption=none&security=none&type=tcp&headerType=none#Railway-Native-IP`;
  
  res.type("text/plain");
  res.send(Buffer.from(vless).toString("base64"));
});

app.get("/health", (req, res) => {
  res.json({
    status: "online",
    mode: "TCP-Direct",
    tcp_endpoint: `${CONFIG.TCP_PROXY}:${CONFIG.TCP_PORT}`,
    native_ip: true
  });
});

// ========== TCP 端口转发到 Xray ==========
const tcpServer = net.createServer((clientSocket) => {
  console.log(`[连接] 新客户端: ${clientSocket.remoteAddress}`);
  
  const xraySocket = net.createConnection({
    port: CONFIG.XRAY_PORT,
    host: "127.0.0.1"
  });

  xraySocket.on("connect", () => {
    console.log("[转发] 已连接到 Xray");
    clientSocket.pipe(xraySocket);
    xraySocket.pipe(clientSocket);
  });

  xraySocket.on("error", (err) => {
    console.error(`[错误] Xray 连接失败: ${err.message}`);
    clientSocket.destroy();
  });

  clientSocket.on("error", (err) => {
    console.error(`[错误] 客户端错误: ${err.message}`);
    xraySocket.destroy();
  });

  clientSocket.on("close", () => {
    console.log("[断开] 客户端已断开");
    xraySocket.destroy();
  });
});

// ========== 启动服务 ==========
bootXray();

// HTTP 服务器（用于订阅）
app.listen(CONFIG.PORT, "0.0.0.0", () => {
  console.log(`[HTTP] 订阅服务: http://0.0.0.0:${CONFIG.PORT}`);
  console.log(`[订阅] https://${CONFIG.HTTP_DOMAIN}/sub\n`);
});

// TCP 服务器（用于代理流量）
tcpServer.listen(CONFIG.PORT, "0.0.0.0", () => {
  console.log(`[TCP] 代理端口: ${CONFIG.PORT}`);
  console.log(`[端点] ${CONFIG.TCP_PROXY}:${CONFIG.TCP_PORT}\n`);
  console.log(`========================================`);
  console.log(`✅ 原生IP直连模式已启动`);
  console.log(`========================================\n`);
});
