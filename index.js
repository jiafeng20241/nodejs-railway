const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const unzipper = require("unzipper");

const CONFIG = {
  UUID: process.env.UUID || "9afd1229-b893-40c1-84dd-51e7ce204913",
  PORT: parseInt(process.env.PORT) || 8080,
  XRAY_PORT: 3000,
  
  // 【关键】Railway TCP Proxy 端点（原生 IP）
  TCP_DOMAIN: process.env.RAILWAY_TCP_PROXY_DOMAIN || "",
  TCP_PORT: parseInt(process.env.RAILWAY_TCP_PROXY_PORT) || 0,
  
  // HTTP 域名仅用于订阅
  HTTP_DOMAIN: process.env.RAILWAY_STATIC_URL || "",
  
  FILE_PATH: "./bin_core",
};

if (!fs.existsSync(CONFIG.FILE_PATH)) {
  fs.mkdirSync(CONFIG.FILE_PATH, { recursive: true });
}

// ========== 下载并启动 Xray ==========
async function boot() {
  const xrayZipUrl = "https://github.com/XTLS/Xray-core/releases/download/v26.2.6/Xray-linux-64.zip";

  try {
    console.log("[启动] 🚀 2026 原生IP直连模式（VLESS + TCP）...\n");
    
    const xrayPath = path.join(CONFIG.FILE_PATH, "xray");
    
    // 下载 Xray
    if (!fs.existsSync(xrayPath)) {
      console.log("[下载] Xray 核心...");
      const response = await axios({
        url: xrayZipUrl,
        method: "GET",
        responseType: "stream"
      });
      
      await response.data.pipe(unzipper.Extract({ path: CONFIG.FILE_PATH })).promise();
      
      // 查找并重命名
      const files = fs.readdirSync(CONFIG.FILE_PATH);
      const xrayBin = files.find(f => f.toLowerCase().includes("xray") && !f.includes("."));
      if (xrayBin) {
        fs.renameSync(path.join(CONFIG.FILE_PATH, xrayBin), xrayPath);
      }
      
      fs.chmodSync(xrayPath, 0o755);
      console.log("[✓] Xray 下载完成\n");
    }

    // 【核心配置】VLESS + TCP（无 TLS，直连）
    const config = {
      log: {
        loglevel: "warning"
      },
      inbounds: [{
        port: CONFIG.XRAY_PORT,
        listen: "0.0.0.0",  // 监听所有接口
        protocol: "vless",
        settings: {
          clients: [{
            id: CONFIG.UUID,
            level: 0
          }],
          decryption: "none"
        },
        streamSettings: {
          network: "tcp",  // 【关键】纯 TCP
          security: "none"  // 【关键】无加密
        }
      }],
      outbounds: [{
        protocol: "freedom",
        settings: {
          domainStrategy: "UseIP"
        }
      }]
    };

    fs.writeFileSync(
      path.join(CONFIG.FILE_PATH, "config.json"),
      JSON.stringify(config, null, 2)
    );

    // 启动 Xray
    const xray = spawn(xrayPath, ["-c", path.join(CONFIG.FILE_PATH, "config.json")]);
    
    xray.stdout.on("data", (data) => {
      console.log(`[Xray] ${data.toString().trim()}`);
    });
    
    xray.stderr.on("data", (data) => {
      const msg = data.toString().trim();
      // 忽略弃用警告
      if (msg && !msg.includes("deprecated")) {
        console.error(`[Xray] ${msg}`);
      }
    });
    
    xray.on("exit", (code) => {
      console.error(`\n[错误] Xray 退出 (code ${code})`);
      console.log("[重启] 30秒后重新启动...\n");
      setTimeout(boot, 30000);
    });

    console.log("[✓] Xray 启动成功（TCP 直连模式）\n");

  } catch (err) {
    console.error(`[启动失败] ${err.message}`);
    console.log("[重试] 10秒后重新尝试...\n");
    setTimeout(boot, 10000);
  }
}

// ========== Express HTTP 服务器（仅用于订阅） ==========
const app = express();

app.get("/", (req, res) => {
  if (!CONFIG.TCP_DOMAIN || !CONFIG.TCP_PORT) {
    return res.send(`
      <h1>⚠️ 配置错误</h1>
      <p><strong>Railway TCP Proxy 未启用！</strong></p>
      <p>请在 Railway 后台操作：</p>
      <ol>
        <li>进入 Service Settings → Networking</li>
        <li>点击 TCP Proxy</li>
        <li>输入端口：3000</li>
        <li>重新部署</li>
      </ol>
    `);
  }

  res.send(`
    <h1>🚀 Railway 原生 IP 代理</h1>
    <h2>VLESS + TCP 直连模式</h2>
    <p><strong>订阅地址：</strong></p>
    <p><code>https://${CONFIG.HTTP_DOMAIN}/sub</code></p>
    <hr>
    <p><strong>TCP 端点（原生 IP）：</strong></p>
    <p><code>${CONFIG.TCP_DOMAIN}:${CONFIG.TCP_PORT}</code></p>
    <p><em>✅ 不走 Cloudflare CDN</em></p>
    <p><em>✅ 美国家庭宽带级纯净 IP</em></p>
  `);
});

app.get("/sub", (req, res) => {
  if (!CONFIG.TCP_DOMAIN || !CONFIG.TCP_PORT) {
    return res.status(500).send("错误：未配置 TCP Proxy！请在 Railway 后台启用。");
  }

  // 【订阅链接】VLESS + TCP 直连
  const vless = `vless://${CONFIG.UUID}@${CONFIG.TCP_DOMAIN}:${CONFIG.TCP_PORT}?` +
    `encryption=none&` +
    `security=none&` +
    `type=tcp&` +
    `#Railway-Native-IP`;
  
  res.type("text/plain");
  res.send(Buffer.from(vless).toString("base64"));
});

app.get("/health", (req, res) => {
  res.json({
    status: "online",
    protocol: "VLESS + TCP (Direct)",
    native_ip: true,
    tcp_endpoint: `${CONFIG.TCP_DOMAIN}:${CONFIG.TCP_PORT}`,
    uptime: process.uptime()
  });
});

// ========== 启动服务 ==========
boot();

app.listen(CONFIG.PORT, "0.0.0.0", () => {
  console.log("========================================");
  console.log(`✅ HTTP 订阅服务已启动`);
  console.log(`   地址: https://${CONFIG.HTTP_DOMAIN}/sub`);
  console.log(`\n✅ TCP Proxy 端点（原生 IP）:`);
  console.log(`   ${CONFIG.TCP_DOMAIN}:${CONFIG.TCP_PORT}`);
  console.log("========================================\n");
});

process.on("SIGTERM", () => {
  console.log("\n[关闭] 收到 SIGTERM 信号");
  process.exit(0);
});
```

---

## 📋 **部署步骤（一步都不能错）**

### **1. 在 Railway 启用 TCP Proxy（最关键！）**
```
进入你的 Railway 项目
→ 点击 Service
→ Settings
→ Networking
→ 点击 TCP Proxy
→ 输入端口：3000
→ 点击 Enable
```

Railway 会生成端点，例如：
```
shuttle.proxy.rlwy.net:12345
```

**环境变量会自动设置**：
```
RAILWAY_TCP_PROXY_DOMAIN=shuttle.proxy.rlwy.net
RAILWAY_TCP_PROXY_PORT=12345
