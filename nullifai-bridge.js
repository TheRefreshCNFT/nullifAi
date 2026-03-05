/**
 * nullifAi Bridge — Node.js WebSocket bridge for nullclaw
 *
 * Bypasses the broken Zig WebSocket server on Windows by:
 * 1. Serving a WebSocket endpoint that the chat UI connects to
 * 2. Running nullclaw in agent mode (stdin/stdout) for each message
 * 3. Translating between WebChannel v1 protocol and the CLI agent
 *
 * The bridge supports Kill/Launch from the UI:
 * - Kill: stops the WebSocket server, disconnects clients, kills agents
 * - Launch: restarts the WebSocket server so clients can reconnect
 * The HTTP server (UI + API) stays alive in both states.
 */

const { WebSocketServer } = require("ws");
const { spawn } = require("child_process");
const crypto = require("crypto");
const http = require("http");
const fs = require("fs");
const path = require("path");

// ── Config ──────────────────────────────────────────────────────────────
const NULLCLAW_EXE = process.env.NULLCLAW_EXE || "C:\\Tools\\nullclaw\\2026.3.4\\nullclaw.exe";
const WS_PORT = parseInt(process.env.WS_PORT || "32123", 10);
const UI_PORT = parseInt(process.env.UI_PORT || "4173", 10);
const UI_DIR = process.env.UI_DIR || path.join(__dirname, "nullclaw-chat-ui", "build");
const PAIRING_CODE = "123456";
const AGENT_ID = "default";

const JWT_SECRET = crypto.randomBytes(32);

// ── State ───────────────────────────────────────────────────────────────
const sessions = new Map();
const activeAgents = new Map();
let bridgeActive = true; // false = "killed" state (WS server down, HTTP still up)
let wsServer = null;
let wss = null;

// ── JWT helpers ─────────────────────────────────────────────────────────
function createToken(clientId) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    sub: clientId, aid: AGENT_ID, iat: now, exp: now + 86400,
  })).toString("base64url");
  const sig = crypto.createHmac("sha256", JWT_SECRET)
    .update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

function verifyToken(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const sig = crypto.createHmac("sha256", JWT_SECRET)
      .update(`${parts[0]}.${parts[1]}`).digest("base64url");
    if (sig !== parts[2]) return null;
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    if (claims.exp < Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch { return null; }
}

// ── Send WebChannel v1 envelope ─────────────────────────────────────────
function sendEvent(ws, type, sessionId, payload, extra = {}) {
  const msg = { v: 1, type, session_id: sessionId, agent_id: AGENT_ID, ...extra, payload };
  ws.send(JSON.stringify(msg));
}

// ── Run nullclaw agent for a single message ─────────────────────────────
function runAgent(sessionId, content, ws) {
  const args = ["agent", "-m", content, "-s", sessionId];
  const child = spawn(NULLCLAW_EXE, args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  activeAgents.set(sessionId, child);

  let fullResponse = "";
  let preambleDone = false;

  child.stdout.on("data", (data) => {
    let text = data.toString();
    fullResponse += text;

    if (!preambleDone) {
      text = text.replace(/^(Sending to [^\n]*\n|Session: [^\n]*\n|Model: [^\n]*\n|Loading[^\n]*\n)*/g, "");
      if (text.length > 0) {
        preambleDone = true;
      } else {
        return;
      }
    }

    sendEvent(ws, "assistant_chunk", sessionId, { content: text });
  });

  child.stderr.on("data", (data) => {
    const text = data.toString().trim();
    if (text) console.log(`  [agent stderr] ${text}`);
  });

  child.on("close", (code) => {
    activeAgents.delete(sessionId);
    const cleaned = fullResponse
      .replace(/^(Sending to [^\n]*\n|Session: [^\n]*\n|Model: [^\n]*\n|Loading[^\n]*\n)*/g, "")
      .replace(/\n> ?$/, "")
      .trim();
    sendEvent(ws, "assistant_final", sessionId, { content: cleaned });
    if (code !== 0) console.log(`  [agent] exited with code ${code}`);
  });

  child.on("error", (err) => {
    activeAgents.delete(sessionId);
    console.error(`  [agent] spawn error: ${err.message}`);
    sendEvent(ws, "error", sessionId, {
      code: "agent_error",
      message: `Failed to run agent: ${err.message}`,
    });
  });
}

// ── WebSocket setup ─────────────────────────────────────────────────────
function setupWebSocket(wsInstance, req) {
  const addr = req.socket.remoteAddress;
  console.log(`[ws] client connected from ${addr}`);

  wsInstance.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      wsInstance.send(JSON.stringify({ v: 1, type: "error", payload: { code: "parse_error", message: "Invalid JSON" } }));
      return;
    }

    const type = msg.type || "user_message";
    const sessionId = msg.session_id || "default";
    const payload = msg.payload || {};
    const requestId = msg.request_id;

    if (type === "pairing_request") {
      const code = payload.pairing_code || payload.code;
      console.log(`[ws] pairing request, code=${code}`);

      if (code !== PAIRING_CODE) {
        sendEvent(wsInstance, "pairing_result", sessionId, {
          ok: false, error: "invalid_code", message: "Invalid pairing code",
        }, requestId ? { request_id: requestId } : {});
        return;
      }

      const clientId = `ui-${crypto.randomBytes(8).toString("hex")}`;
      const accessToken = createToken(clientId);
      sessions.set(sessionId, { clientId, accessToken, ws: wsInstance });

      sendEvent(wsInstance, "pairing_result", sessionId, {
        ok: true, client_id: clientId, access_token: accessToken,
        token_type: "Bearer", expires_in: 86400, e2e_required: false,
      }, requestId ? { request_id: requestId } : {});

      console.log(`[ws] paired: session=${sessionId} client=${clientId}`);
      return;
    }

    if (type === "user_message") {
      const token = payload.access_token || msg.access_token;
      if (!token || !verifyToken(token)) {
        sendEvent(wsInstance, "error", sessionId, { code: "unauthorized", message: "Invalid or missing access token" });
        return;
      }
      const content = payload.content;
      if (!content || !content.trim()) {
        sendEvent(wsInstance, "error", sessionId, { code: "invalid_message", message: "Empty message content" });
        return;
      }
      console.log(`[ws] user_message: session=${sessionId} content="${content.substring(0, 60)}..."`);
      const session = sessions.get(sessionId);
      if (session) session.ws = wsInstance;
      runAgent(sessionId, content, wsInstance);
      return;
    }

    if (type === "approval_response") {
      console.log(`[ws] approval_response (not yet implemented)`);
      return;
    }

    console.log(`[ws] unknown message type: ${type}`);
  });

  wsInstance.on("close", () => console.log(`[ws] client disconnected from ${addr}`));
  wsInstance.on("error", (err) => console.error(`[ws] error: ${err.message}`));
}

// ── Start/Stop WebSocket server ─────────────────────────────────────────
function startWsServer() {
  return new Promise((resolve) => {
    wss = new WebSocketServer({ noServer: true });
    wsServer = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ name: "nullifAi bridge", status: "running", websocket: `ws://127.0.0.1:${WS_PORT}/ws` }));
    });
    wsServer.on("upgrade", (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    });
    wss.on("connection", setupWebSocket);
    wsServer.listen(WS_PORT, "127.0.0.1", () => {
      bridgeActive = true;
      console.log(`[ws] WebSocket server started on ws://127.0.0.1:${WS_PORT}/ws`);
      resolve();
    });
  });
}

function stopWsServer() {
  return new Promise((resolve) => {
    console.log("[ws] Stopping WebSocket server...");
    // Kill active agents
    for (const [sid, child] of activeAgents) {
      child.kill();
    }
    activeAgents.clear();
    sessions.clear();

    // Close WebSocket connections
    if (wss) {
      wss.clients.forEach((ws) => ws.close());
    }

    // Close the WS HTTP server
    if (wsServer) {
      wsServer.close(() => {
        console.log("[ws] WebSocket server stopped");
        wsServer = null;
        wss = null;
        bridgeActive = false;
        resolve();
      });
    } else {
      bridgeActive = false;
      resolve();
    }
  });
}

// ── Control bar HTML ────────────────────────────────────────────────────
const CONTROL_BAR_SCRIPT = `
<style>
  #nullifai-control {
    position: fixed; bottom: 0; left: 0; right: 0; z-index: 99999;
    background: #1a1a2e; border-top: 1px solid #333;
    display: flex; align-items: center; justify-content: space-between;
    padding: 6px 16px; font-family: system-ui, sans-serif; font-size: 13px;
    color: #aaa;
  }
  #nullifai-control .status-dot {
    width: 8px; height: 8px; border-radius: 50%; display: inline-block;
    margin-right: 8px;
  }
  #nullifai-control .status-dot.live { background: #4ade80; }
  #nullifai-control .status-dot.dead { background: #f87171; }
  #nullifai-control button {
    background: #333; color: #ddd; border: 1px solid #555; border-radius: 4px;
    padding: 4px 14px; cursor: pointer; font-size: 13px; margin-left: 8px;
  }
  #nullifai-control button:hover { background: #444; }
  #nullifai-control button.kill { border-color: #f87171; color: #f87171; }
  #nullifai-control button.kill:hover { background: #2a1515; }
  #nullifai-control button.launch { border-color: #4ade80; color: #4ade80; }
  #nullifai-control button.launch:hover { background: #152a15; }
  body { padding-bottom: 40px !important; }
</style>
<div id="nullifai-control">
  <div style="display:flex;align-items:center;">
    <span class="status-dot live" id="nai-dot"></span>
    <span id="nai-status">nullifAi running</span>
  </div>
  <div>
    <button class="kill" id="nai-kill" onclick="nullifaiKill()">Kill Session</button>
    <button class="launch" id="nai-launch" onclick="nullifaiLaunch()" style="display:none">Launch</button>
  </div>
</div>
<script>
(function() {
  function updateUI(alive) {
    var dot = document.getElementById('nai-dot');
    var status = document.getElementById('nai-status');
    var killBtn = document.getElementById('nai-kill');
    var launchBtn = document.getElementById('nai-launch');
    if (alive) {
      dot.className = 'status-dot live';
      status.textContent = 'nullifAi running';
      killBtn.style.display = '';
      launchBtn.style.display = 'none';
    } else {
      dot.className = 'status-dot dead';
      status.textContent = 'nullifAi stopped';
      killBtn.style.display = 'none';
      launchBtn.style.display = '';
    }
  }

  // Poll status every 3s
  setInterval(async function() {
    try {
      var r = await fetch('/api/status');
      var data = await r.json();
      updateUI(data.active);
    } catch { updateUI(false); }
  }, 3000);

  window.nullifaiKill = async function() {
    if (!confirm('Stop nullifAi? You can relaunch from this page.')) return;
    try { await fetch('/api/kill', { method: 'POST' }); } catch {}
    updateUI(false);
  };

  window.nullifaiLaunch = async function() {
    var btn = document.getElementById('nai-launch');
    btn.textContent = 'Starting...';
    btn.disabled = true;
    try {
      await fetch('/api/launch', { method: 'POST' });
    } catch {}
    // Poll until active
    var attempts = 0;
    var poll = setInterval(async function() {
      attempts++;
      try {
        var r = await fetch('/api/status');
        var data = await r.json();
        if (data.active) {
          clearInterval(poll);
          updateUI(true);
          btn.textContent = 'Launch';
          btn.disabled = false;
          window.location.reload();
        }
      } catch {}
      if (attempts > 15) {
        clearInterval(poll);
        btn.textContent = 'Launch';
        btn.disabled = false;
      }
    }, 1000);
  };
})();
</script>
`;

// ── HTTP Server (UI + API — always running) ─────────────────────────────
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

const uiServer = http.createServer(async (req, res) => {
  // ── API endpoints ─────────────────────────────────────────────────
  if (req.url === "/api/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: bridgeActive ? "running" : "stopped",
      active: bridgeActive,
      sessions: sessions.size,
      agents: activeAgents.size,
    }));
    return;
  }

  if (req.url === "/api/kill" && req.method === "POST") {
    console.log("[api] Kill requested");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    await stopWsServer();
    return;
  }

  if (req.url === "/api/launch" && req.method === "POST") {
    console.log("[api] Launch requested");
    if (bridgeActive) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, message: "Already running" }));
      return;
    }
    try {
      await startWsServer();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, message: err.message }));
    }
    return;
  }

  // ── Static file serving ───────────────────────────────────────────
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405);
    res.end("Method Not Allowed");
    return;
  }

  let urlPath = decodeURIComponent(req.url.split("?")[0].split("#")[0]);
  if (urlPath === "/") urlPath = "/index.html";

  const filePath = path.join(UI_DIR, urlPath);
  if (!filePath.startsWith(UI_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  const tryPath = fs.existsSync(filePath) ? filePath : path.join(UI_DIR, "index.html");
  const ext = path.extname(tryPath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  try {
    let content = fs.readFileSync(tryPath);

    // Inject control bar into HTML pages
    if (ext === ".html") {
      let html = content.toString();
      html = html.replace("</body>", CONTROL_BAR_SCRIPT + "\n</body>");
      res.writeHead(200, { "Content-Type": contentType });
      res.end(html);
      return;
    }

    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not Found");
  }
});

// ── Start ───────────────────────────────────────────────────────────────
async function main() {
  // Start WebSocket server
  await startWsServer();
  console.log(`  Pairing code: ${PAIRING_CODE}`);
  console.log(`  Agent: ${NULLCLAW_EXE}`);

  // Start UI + API server (this one never stops)
  uiServer.listen(UI_PORT, "127.0.0.1", () => {
    console.log(`  Chat UI:  http://127.0.0.1:${UI_PORT}`);
    console.log(`  API:      http://127.0.0.1:${UI_PORT}/api/status`);
    console.log();
    console.log(`Open http://127.0.0.1:${UI_PORT} in your browser.`);
  });
}

main().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});

// ── Handle signals ──────────────────────────────────────────────────────
process.on("SIGINT", async () => {
  console.log("\nShutting down completely...");
  await stopWsServer();
  uiServer.close();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await stopWsServer();
  uiServer.close();
  process.exit(0);
});
