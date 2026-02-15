const express = require("express");
const app = express();
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { spawn, execSync } = require("child_process");
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

if (!fs.existsSync(CONFIG.FILE_PATH)) {
  fs.mkdirSync(CONFIG.FILE_PATH, { recursive: true });
}

// 关键：用 curl + tar 替代 exec + unzip
async function downloadAndExtract() {
  const xrayPath = path.join(CONFIG.FILE_PATH, "xray");
  
  if (fs.existsSync(xrayPath)) {
    console.log("[✓] Xray已存在");
    return xrayPath;
  }

  console.log("[下载] Xray 核心...");
  
  // 使用 tar.gz（Railway 自带解压工具）
  const url = "https://github.com/XTLS/Xray-core/releases/download/v24.1.10/Xray-linux-64.tar.gz";
  
  try {
    // 下载
    const response = await axios({
      url: url,
      method: "GET",
      responseType: "stream",
      timeout: 30000,
      httpAgent: { keepAlive: false },
      httpsAgent: { keepAlive: false }
    });

    const tarPath = path.join(CONFIG.FILE_PATH, "xray.tar.gz");
    
    await new Promise((resolve, reject) => {
      const stream = fs.createWriteStream(tarPath);
      response.data.pipe(stream);
      stream.on("finish", resolve);
      stream.on("error", reject);
    });

    // 使用 tar 命令解压（Railway 一定有）
    try {
      execSync(`tar -xzf ${tarPath} -C ${CONFIG.FILE_PATH}`, { stdio: 'pipe' });
      fs.unlinkSync(tarPath);
    } catch (err) {
      // 备选：用 Node.js 的 tar 库
      const tar = require('tar');
      await tar.x({
        file: tarPath,
        cwd: CONFIG.FILE_PATH
      });
      fs.unlinkSync(tarPath);
    }

    // 赋予执行权限
    fs.chmodSync(xrayPath, 0o755);
    console.log("[✓] Xray解压完成");
    return xrayPath;

  } catch (err) {
    console.error(`[错误] 下载失败: ${err.message}`);
    throw err;
  }
}

async function boot() {
  try {
    console.log("[启动] 纯净IP WebSocket模式...");
    
    const xrayPath = await downloadAndExtract();

    // 【核心配置】必须是 WebSocket（Railway 要求）
    const config = {
      log: { loglevel: "error" },
      
      inbounds: [
        {
          port: CONFIG.XRAY_PORT,
          protocol: "vless",
          settings: {
            clients: [
              {
                id: CONFIG.UUID,
                flow: "xtls-rprx-vision",  // Vision 流控
                level: 0
              }
            ],
            decryption: "none"
          },
          streamSettings: {
            network: "ws",  // 【必须】WebSocket 穿透 Railway
            wsSettings: {
              path: "/xray",
              connectionReuse: true,
              headers: {
                "User-Agent": "Mozilla/5.0"
              }
            },
            security: "none"  // Railway 不支持 TLS
          },
          sniffing: {
            enabled: true,
            destOverride: ["http", "tls", "quic"]
          }
        }
      ],

      outbounds: [
        {
          protocol: "freedom",
          tag: "direct"
        }
      ],

      policy: {
        levels: {
          0: {
            handshake: 4,
            connIdle: 300,
            uplinkOnly: 2,
            downlinkOnly: 5,
            bufferSize: 10240,
            statsUserUplink: false,
            statsUserDownlink: false
          }
        }
      }
    };

    fs.writeFileSync(
      path.join(CONFIG.FILE_PATH, "config.json"),
      JSON.stringify(config, null, 2)
    );

    // 启动 Xray
    const xray = spawn(xrayPath, ["-c", path.join(CONFIG.FILE_PATH, "config.json")], {
      stdio: ["ignore", "pipe", "pipe"]
    });

    xray.on("error", (err) => {
      console.error(`[Xray] 启动错误: ${err.message}`);
    });

    xray.stderr.on("data", (data) => {
      const msg = data.toString().trim();
      if (msg && (msg.includes("error") || msg.includes("failed"))) {
        console.error(`[Xray] ${msg}`);
      }
    });

    xray.on("exit", (code, signal) => {
      console.log(`[警告] Xray已退出 (code:${code}, signal:${signal})`);
      console.log("[重启] 30秒后重新启动...");
      setTimeout(boot, 30000);
    });

    console.log("[✓] Xray 核心启动成功");

  } catch (err) {
    console.error(`[启动失败] ${err.message}`);
    console.log("[重试] 10秒后重新尝试...");
    setTimeout(boot, 10000);
  }
}

// ===== Express 应用 =====

app.get("/", (req, res) => {
  res.send("Pure Native IP - WebSocket Mode");
});

// 【关键】订阅链接 - 必须是 ws:// 或 wss://
app.get(`/${CONFIG.SUB_PATH}`, (req, res) => {
  // 客户端连接到 Railway Domain，自动走 HTTPS
  // 然后通过 /xray 路径升级到 WebSocket
  const vless = `vless://${CONFIG.UUID}@${CONFIG.RAIL_DOMAIN}:443?encryption=none&flow=xtls-rprx-vision&security=tls&sni=${CONFIG.RAIL_DOMAIN}&type=ws&path=%2Fxray&host=${CONFIG.RAIL_DOMAIN}#Railway-Pure-Native`;
  
  res.type("text/plain");
  res.send(Buffer.from(vless).toString("base64"));
});

app.get("/health", (req, res) => {
  res.json({ 
    status: "online",
    mode: "websocket-vision",
    uptime: process.uptime()
  });
});

boot();

// 【重要】创建 HTTP 服务器并处理 WebSocket 升级
const server = http.createServer(app);

server.on("upgrade", (req, socket, head) => {
  // 只处理 /xray 路径
  if (req.url === "/xray") {
    
    // 连接到本地 Xray 实例
    const target = net.createConnection({
      port: CONFIG.XRAY_PORT,
      host: "127.0.0.1"
    });

    target.on("connect", () => {
      // 发送 WebSocket 升级响应
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        "Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n" +
        "\r\n"
      );
      
      // 转发 WebSocket 数据
      socket.pipe(target);
      target.pipe(socket);
    });

    target.on("error", (err) => {
      console.error(`[WebSocket] 连接错误: ${err.message}`);
      socket.destroy();
    });

    socket.on("error", (err) => {
      console.error(`[Socket] 错误: ${err.message}`);
      target.destroy();
    });

    // 转发初始数据
    if (head && head.length > 0) {
      target.write(head);
    }

  } else {
    socket.end();
  }
});

server.listen(CONFIG.PORT, "0.0.0.0", () => {
  console.log(`\n[✓] 服务已启动`);
  console.log(`    端口: 0.0.0.0:${CONFIG.PORT}`);
  console.log(`    Railway Domain: ${CONFIG.RAIL_DOMAIN}`);
  console.log(`    WebSocket 路径: /xray`);
  console.log(`    订阅地址: https://${CONFIG.RAIL_DOMAIN}/${CONFIG.SUB_PATH}`);
  console.log(`    健康检查: https://${CONFIG.RAIL_DOMAIN}/health\n`);
});

// 优雅关闭
process.on("SIGTERM", () => {
  console.log("[关闭] 收到 SIGTERM 信号");
  server.close();
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("[关闭] 收到 SIGINT 信号");
  server.close();
  process.exit(0);
});
