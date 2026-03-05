/**
 * nullifAi Bridge — Node.js WebSocket bridge for nullclaw
 *
 * Bypasses the broken Zig WebSocket server on Windows by:
 * 1. Serving a WebSocket endpoint that the chat UI connects to
 * 2. Running nullclaw in agent mode (stdin/stdout) for each message
 * 3. Translating between WebChannel v1 protocol and the CLI agent
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
const PAIRING_CODE = "123456"; // Fixed local pairing code (matches nullclaw local mode)
const AGENT_ID = "default";

// Simple JWT-like token (local only, no real crypto needed)
const JWT_SECRET = crypto.randomBytes(32);

// ── State ───────────────────────────────────────────────────────────────
const sessions = new Map(); // session_id -> { clientId, accessToken, ws }
const activeAgents = new Map(); // session_id -> child_process (interactive agent)

// ── JWT helpers (minimal HS256 for local use) ───────────────────────────
function createToken(clientId) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    sub: clientId,
    aid: AGENT_ID,
    iat: now,
    exp: now + 86400,
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

  let fullResponse = "";
  let preambleDone = false; // Track whether we've passed nullclaw's diagnostic preamble

  child.stdout.on("data", (data) => {
    let text = data.toString();
    fullResponse += text;

    // nullclaw agent prints diagnostic lines before the actual response
    // e.g. "Sending to ollama...\nSession: test-session\n"
    // We skip these and only forward the actual AI content to the UI
    if (!preambleDone) {
      // Strip known preamble lines
      text = text.replace(/^(Sending to [^\n]*\n|Session: [^\n]*\n|Model: [^\n]*\n|Loading[^\n]*\n)*/g, "");
      if (text.length > 0) {
        preambleDone = true;
      } else {
        return; // Still in preamble, don't send anything to UI yet
      }
    }

    // Send chunks as they arrive (only actual AI content)
    sendEvent(ws, "assistant_chunk", sessionId, { content: text });
  });

  child.stderr.on("data", (data) => {
    // Log stderr but don't send to UI (it's diagnostic info)
    const text = data.toString().trim();
    if (text) console.log(`  [agent stderr] ${text}`);
  });

  child.on("close", (code) => {
    // Strip diagnostic preamble and trailing prompt artifacts from the full response
    const cleaned = fullResponse
      .replace(/^(Sending to [^\n]*\n|Session: [^\n]*\n|Model: [^\n]*\n|Loading[^\n]*\n)*/g, "")
      .replace(/\n> ?$/, "")
      .trim();

    // Send final message
    sendEvent(ws, "assistant_final", sessionId, { content: cleaned });

    if (code !== 0) {
      console.log(`  [agent] exited with code ${code}`);
    }
  });

  child.on("error", (err) => {
    console.error(`  [agent] spawn error: ${err.message}`);
    sendEvent(ws, "error", sessionId, {
      code: "agent_error",
      message: `Failed to run agent: ${err.message}`,
    });
  });
}

// ── WebSocket Server ────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws, req) => {
  const addr = req.socket.remoteAddress;
  console.log(`[ws] client connected from ${addr}`);

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ v: 1, type: "error", payload: { code: "parse_error", message: "Invalid JSON" } }));
      return;
    }

    const type = msg.type || "user_message";
    const sessionId = msg.session_id || "default";
    const payload = msg.payload || {};
    const requestId = msg.request_id;

    // ── Pairing ─────────────────────────────────────────────────────
    if (type === "pairing_request") {
      const code = payload.pairing_code || payload.code;
      console.log(`[ws] pairing request, code=${code}`);

      if (code !== PAIRING_CODE) {
        sendEvent(ws, "pairing_result", sessionId, {
          ok: false,
          error: "invalid_code",
          message: "Invalid pairing code",
        }, requestId ? { request_id: requestId } : {});
        return;
      }

      const clientId = `ui-${crypto.randomBytes(8).toString("hex")}`;
      const accessToken = createToken(clientId);

      sessions.set(sessionId, { clientId, accessToken, ws });

      sendEvent(ws, "pairing_result", sessionId, {
        ok: true,
        client_id: clientId,
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 86400,
        e2e_required: false,
      }, requestId ? { request_id: requestId } : {});

      console.log(`[ws] paired: session=${sessionId} client=${clientId}`);
      return;
    }

    // ── User message ────────────────────────────────────────────────
    if (type === "user_message") {
      // Validate token
      const token = payload.access_token || msg.access_token;
      if (!token || !verifyToken(token)) {
        sendEvent(ws, "error", sessionId, {
          code: "unauthorized",
          message: "Invalid or missing access token",
        });
        return;
      }

      const content = payload.content;
      if (!content || !content.trim()) {
        sendEvent(ws, "error", sessionId, {
          code: "invalid_message",
          message: "Empty message content",
        });
        return;
      }

      console.log(`[ws] user_message: session=${sessionId} content="${content.substring(0, 60)}..."`);

      // Update session's ws reference (in case of reconnect)
      const session = sessions.get(sessionId);
      if (session) session.ws = ws;

      // Run nullclaw agent
      runAgent(sessionId, content, ws);
      return;
    }

    // ── Approval response ───────────────────────────────────────────
    if (type === "approval_response") {
      console.log(`[ws] approval_response (not yet implemented)`);
      return;
    }

    console.log(`[ws] unknown message type: ${type}`);
  });

  ws.on("close", () => {
    console.log(`[ws] client disconnected from ${addr}`);
  });

  ws.on("error", (err) => {
    console.error(`[ws] error: ${err.message}`);
  });
});

// ── HTTP Server (serves UI + handles WS upgrade) ───────────────────────
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

// UI static file server
const uiServer = http.createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405);
    res.end("Method Not Allowed");
    return;
  }

  let urlPath = decodeURIComponent(req.url.split("?")[0].split("#")[0]);
  if (urlPath === "/") urlPath = "/index.html";

  const filePath = path.join(UI_DIR, urlPath);

  // Security: prevent path traversal
  if (!filePath.startsWith(UI_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  // Try exact file, then SPA fallback
  const tryPath = fs.existsSync(filePath) ? filePath : path.join(UI_DIR, "index.html");

  const ext = path.extname(tryPath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  try {
    const content = fs.readFileSync(tryPath);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not Found");
  }
});

// WebSocket server on the gateway port
const wsServer = http.createServer((req, res) => {
  // Non-WS requests get a simple status page
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    name: "nullifAi bridge",
    version: "1.0.0",
    status: "running",
    websocket: `ws://127.0.0.1:${WS_PORT}/ws`,
    sessions: sessions.size,
  }));
});

wsServer.on("upgrade", (req, socket, head) => {
  // Accept WebSocket upgrades on any path (the UI connects to /ws)
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

// ── Start ───────────────────────────────────────────────────────────────
wsServer.listen(WS_PORT, "127.0.0.1", () => {
  console.log(`nullifAi bridge started`);
  console.log(`  WebSocket: ws://127.0.0.1:${WS_PORT}/ws`);
  console.log(`  Pairing code: ${PAIRING_CODE}`);
  console.log(`  Agent: ${NULLCLAW_EXE}`);
});

uiServer.listen(UI_PORT, "127.0.0.1", () => {
  console.log(`  Chat UI:  http://127.0.0.1:${UI_PORT}`);
  console.log();
  console.log(`Open http://127.0.0.1:${UI_PORT} in your browser.`);
  console.log(`Connect to ws://127.0.0.1:${WS_PORT}/ws, pairing code: ${PAIRING_CODE}`);
});

// ── Graceful shutdown ───────────────────────────────────────────────────
process.on("SIGINT", () => {
  console.log("\nShutting down...");
  wss.clients.forEach((ws) => ws.close());
  wsServer.close();
  uiServer.close();
  // Kill any running agents
  for (const [sid, child] of activeAgents) {
    child.kill();
  }
  process.exit(0);
});
