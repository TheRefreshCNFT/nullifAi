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
// Root config is for gateway/Discord — DO NOT modify it from the bridge
const NULLCLAW_CONFIG_ROOT = process.env.NULLCLAW_CONFIG || path.join(require("os").homedir(), ".nullclaw", "config.json");
// Workspace config is for local UI agent sessions only
const NULLCLAW_CONFIG = process.env.NULLCLAW_WORKSPACE_CONFIG || path.join(require("os").homedir(), ".nullclaw", "workspace", ".nullclaw", "config.json");
const WS_PORT = parseInt(process.env.WS_PORT || "32123", 10);
const UI_PORT = parseInt(process.env.UI_PORT || "4173", 10);
const UI_DIR = process.env.UI_DIR || path.join(__dirname, "nullclaw-chat-ui", "build");
const AGENT_ID = "default";

// Dynamic pairing code — regenerated on each WS server start
let pairingCode = generatePairingCode();
function generatePairingCode() {
  return crypto.randomInt(100000, 999999).toString();
}

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

// ── Persistent agent sessions (one process per session) ──────────────────
const agentSessions = new Map(); // sessionId -> { child, ws, phase, ... }
const AGENT_SETUP_CMDS = ["/think high", "/reason on", "/exec security=full"];

// Track which model is active per session (default = from config)
const sessionModels = new Map(); // sessionId -> modelString

function readDefaultModel() {
  try {
    const raw = require("fs").readFileSync(NULLCLAW_CONFIG, "utf-8");
    const cfg = JSON.parse(raw);
    return (cfg.agents && cfg.agents.defaults && cfg.agents.defaults.model && cfg.agents.defaults.model.primary) || null;
  } catch { return null; }
}

function getOrCreateAgent(sessionId, ws, modelOverride) {
  if (agentSessions.has(sessionId)) {
    const sess = agentSessions.get(sessionId);
    sess.ws = ws;
    return sess;
  }

  const model = modelOverride || sessionModels.get(sessionId) || readDefaultModel();
  if (model) { sessionModels.set(sessionId, model); }

  // Do NOT pass --model flag — nullclaw reads from config naturally and handles
  // provider prefix stripping correctly. We write the model to config before spawning.
  const spawnArgs = ["agent", "-s", sessionId];

  console.log(`  [agent ${sessionId}] spawning (model from config: ${model || "default"})`);
  const child = spawn(NULLCLAW_EXE, spawnArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  // phase: "booting" -> "setup" -> "ready" -> "responding" -> "ready"
  const sess = {
    child, ws,
    phase: "booting",
    accum: "",          // accumulated stdout for current phase
    idleTimer: null,    // fires when output stops (prompt detected)
    queue: [],          // queued user messages
    setupIdx: 0,        // which setup cmd we're on
  };
  agentSessions.set(sessionId, sess);

  function onIdle() {
    // Called when stdout has been quiet for a bit — means prompt is showing
    const output = sess.accum;
    sess.accum = "";

    if (sess.phase === "booting") {
      // Initial banner done, send first setup command
      sess.phase = "setup";
      sess.setupIdx = 0;
      console.log(`  [agent ${sessionId}] booted, sending setup`);
      child.stdin.write(AGENT_SETUP_CMDS[0] + "\n");
      return;
    }

    if (sess.phase === "setup") {
      sess.setupIdx++;
      if (sess.setupIdx < AGENT_SETUP_CMDS.length) {
        child.stdin.write(AGENT_SETUP_CMDS[sess.setupIdx] + "\n");
        return;
      }
      // All setup done
      sess.phase = "ready";
      console.log(`  [agent ${sessionId}] setup complete, ready`);
      if (sess.queue.length > 0) {
        const next = sess.queue.shift();
        sess.phase = "responding";
        child.stdin.write(next + "\n");
      }
      return;
    }

    if (sess.phase === "responding") {
      // Response complete — clean and send
      const cleaned = output
        .replace(/^(Sending to [^\n]*\n|Session: [^\n]*\n|Model: [^\n]*\n|Loading[^\n]*\n)*/g, "")
        .replace(/\n> ?$/, "")
        .replace(/^> ?\n?/, "")
        .trim();
      if (cleaned) {
        sendEvent(sess.ws, "assistant_final", sessionId, { content: cleaned });
      } else {
        sendEvent(sess.ws, "assistant_final", sessionId, { content: "" });
      }
      sess.phase = "ready";
      // Process next queued message
      if (sess.queue.length > 0) {
        const next = sess.queue.shift();
        sess.phase = "responding";
        child.stdin.write(next + "\n");
      }
      return;
    }
  }

  child.stdout.on("data", (data) => {
    const text = data.toString();
    sess.accum += text;

    // Stream chunks to UI while responding (skip prompt lines)
    if (sess.phase === "responding") {
      let chunk = text.replace(/\n?> ?$/, "").replace(/^> ?\n?/, "");
      if (sess.accum.length === text.length) {
        chunk = chunk.replace(/^(Sending to [^\n]*\n|Session: [^\n]*\n|Model: [^\n]*\n|Loading[^\n]*\n)*/g, "");
      }
      if (chunk) {
        sendEvent(sess.ws, "assistant_chunk", sessionId, { content: chunk });
      }
    }

    // Reset idle timer — each data chunk resets the clock
    // 2000ms gives large models (480b-cloud) time to fully load before we treat them as ready
    if (sess.idleTimer) clearTimeout(sess.idleTimer);
    sess.idleTimer = setTimeout(onIdle, 2000);
  });

  child.stderr.on("data", (data) => {
    const text = data.toString().trim();
    if (text) console.log(`  [agent ${sessionId} stderr] ${text}`);
  });

  child.on("close", (code) => {
    console.log(`  [agent ${sessionId}] exited code=${code}`);
    if (sess.idleTimer) clearTimeout(sess.idleTimer);
    agentSessions.delete(sessionId);
    if (sess.phase === "responding" && sess.accum) {
      const cleaned = sess.accum.replace(/\n> ?$/, "").trim();
      sendEvent(sess.ws, "assistant_final", sessionId, { content: cleaned });
    }
  });

  child.on("error", (err) => {
    console.error(`  [agent ${sessionId}] spawn error: ${err.message}`);
    agentSessions.delete(sessionId);
    sendEvent(ws, "error", sessionId, {
      code: "agent_error",
      message: `Failed to run agent: ${err.message}`,
    });
  });

  return sess;
}

function killAgentSession(sessionId) {
  if (agentSessions.has(sessionId)) {
    const sess = agentSessions.get(sessionId);
    if (sess.idleTimer) clearTimeout(sess.idleTimer);
    try { sess.child.kill(); } catch {}
    agentSessions.delete(sessionId);
  }
  activeAgents.delete(sessionId);
}

function runAgent(sessionId, content, ws) {
  // ── /model <name> interception ────────────────────────────────────
  // Detect model-switch command before routing to agent stdin.
  // Kill the existing session and respawn with the new model.
  const modelSwitchMatch = content.trim().match(/^\/model\s+(\S+)/i);
  if (modelSwitchMatch) {
    const newModel = modelSwitchMatch[1];
    console.log(`  [agent ${sessionId}] /model switch → ${newModel}`);
    killAgentSession(sessionId);
    sessionModels.set(sessionId, newModel);
    // Update config.json default model too so it persists
    try {
      const raw = require("fs").readFileSync(NULLCLAW_CONFIG, "utf-8");
      const cfg = JSON.parse(raw);
      if (!cfg.agents) cfg.agents = {};
      if (!cfg.agents.defaults) cfg.agents.defaults = {};
      if (!cfg.agents.defaults.model) cfg.agents.defaults.model = {};
      cfg.agents.defaults.model.primary = newModel;
      require("fs").writeFileSync(NULLCLAW_CONFIG, JSON.stringify(cfg, null, 2) + "\n");
      console.log(`  [config] Updated default model → ${newModel}`);
    } catch (e) { console.error(`  [config] Failed to update model in config: ${e.message}`); }
    // Notify UI
    sendEvent(ws, "assistant_final", sessionId, {
      content: `✓ Model switched to **${newModel}**. Next message will use the new model.`
    });
    return;
  }

  const sess = getOrCreateAgent(sessionId, ws);
  activeAgents.set(sessionId, sess.child);

  if (sess.phase === "ready") {
    sess.phase = "responding";
    sess.accum = "";
    sess.child.stdin.write(content + "\n");
  } else {
    // Still booting/setup/responding — queue it
    sess.queue.push(content);
  }
}

// ── Image description via Ollama vision models ──────────────────────────
const VISION_PREFIXES = ["llava", "bakllava", "moondream", "minicpm-v", "cogvlm"];

async function describeImageWithOllama(base64Image) {
  const tagResp = await fetch("http://127.0.0.1:11434/api/tags");
  const { models } = await tagResp.json();

  const visionModel = models.find(m =>
    VISION_PREFIXES.some(p => m.name.toLowerCase().startsWith(p))
  );

  if (!visionModel) {
    return { ok: false, error: "no_vision_model",
      message: "No vision model installed. Run: ollama pull moondream" };
  }

  const imageData = base64Image.replace(/^data:image\/[^;]+;base64,/, "");

  const genResp = await fetch("http://127.0.0.1:11434/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: visionModel.name,
      prompt: "Describe this image in detail. Include any visible text, layout, colors, and content.",
      images: [imageData],
      stream: false,
    }),
  });

  const genData = await genResp.json();
  return { ok: true, description: genData.response, model: visionModel.name };
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

      if (code !== pairingCode) {
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
      pairingCode = generatePairingCode();
      console.log(`[ws] WebSocket server started on ws://127.0.0.1:${WS_PORT}/ws`);
      console.log(`[ws] Pairing code: ${pairingCode}`);
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

// ── Injected HTML (control bar + auto-pairing) ─────────────────────────
const INJECTED_SCRIPT = `
<style>
  #nullifai-control {
    background: #1a1a2e; border-bottom: 1px solid #333;
    display: flex; align-items: center; justify-content: space-between;
    padding: 4px 16px; font-family: system-ui, sans-serif; font-size: 12px;
    color: #aaa; height: 28px; flex-shrink: 0;
  }
  #nullifai-control .status-dot {
    width: 7px; height: 7px; border-radius: 50%; display: inline-block;
    margin-right: 6px;
  }
  #nullifai-control .status-dot.live { background: #4ade80; }
  #nullifai-control .status-dot.dead { background: #f87171; }
  #nullifai-control button {
    background: #333; color: #ddd; border: 1px solid #555; border-radius: 3px;
    padding: 2px 10px; cursor: pointer; font-size: 11px; margin-left: 6px;
  }
  #nullifai-control button:hover { background: #444; }
  #nullifai-control button.kill { border-color: #f87171; color: #f87171; }
  #nullifai-control button.kill:hover { background: #2a1515; }
  #nullifai-control button.launch { border-color: #4ade80; color: #4ade80; }
  #nullifai-control button.launch:hover { background: #152a15; }
  #nai-file-preview {
    display: none; padding: 6px 16px; flex-wrap: wrap; gap: 6px;
    align-items: center; background: var(--bg-surface);
    border-top: 1px solid var(--border); font-family: var(--font-mono); font-size: 12px;
  }
  #nai-file-preview .file-chip {
    display: inline-flex; align-items: center; gap: 4px;
    background: #333; padding: 2px 8px; border-radius: 3px; border: 1px solid #555;
  }
  #nai-file-preview .file-chip .fname { color: var(--accent); max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #nai-file-preview .file-chip .fremove { cursor: pointer; color: var(--error); margin-left: 4px; font-size: 14px; }
  #nai-file-preview .file-chip .fremove:hover { text-shadow: 0 0 5px var(--error); }
  #nai-file-preview .file-chip.loading { opacity: 0.6; }
  .nai-attach-btn {
    background: transparent !important; border: 1px solid var(--border) !important;
    color: var(--fg-dim) !important; padding: 8px 10px !important;
    cursor: pointer; font-size: 16px !important; border-radius: 0 !important;
    transition: all 0.2s; box-shadow: none !important;
    align-self: flex-end; height: 48px !important; display: flex; align-items: center;
  }
  .nai-attach-btn:hover { color: var(--accent) !important; border-color: var(--accent) !important; background: transparent !important; }
  #nai-drop-overlay {
    display: none; position: fixed; inset: 0; z-index: 99998;
    background: rgba(0,0,0,0.7); align-items: center; justify-content: center;
    font-family: var(--font-mono); font-size: 18px; color: var(--accent); letter-spacing: 2px;
  }
  #nai-drop-overlay .drop-box {
    border: 2px dashed var(--accent); padding: 40px 60px; border-radius: 8px;
    background: rgba(0, 255, 65, 0.05); text-shadow: 0 0 10px var(--accent);
  }
  /* ── Sidebar Layout ─────────────────────────────────────────── */
  #nai-content-wrapper {
    display: flex; flex-direction: row; flex: 1; min-height: 0; overflow: hidden;
  }
  #nai-sidebar {
    width: 260px; min-width: 260px; max-width: 260px;
    background: #0d0d1a; border-right: 1px solid #222;
    display: flex; flex-direction: column;
    transition: width 0.2s ease, min-width 0.2s ease, max-width 0.2s ease;
    overflow: hidden; font-family: var(--font-mono, monospace); font-size: 12px; z-index: 50;
  }
  #nai-sidebar.collapsed { width: 44px; min-width: 44px; max-width: 44px; }
  .nai-sidebar-content { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; }
  #nai-sidebar.collapsed .nai-sidebar-content { display: none; }
  .nai-sidebar-toggle {
    background: transparent; border: none; border-bottom: 1px solid #222;
    color: #888; padding: 10px 12px; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: color 0.2s, background 0.2s; flex-shrink: 0; height: 40px;
  }
  .nai-sidebar-toggle:hover { color: var(--accent, #0f0); background: rgba(255,255,255,0.03); }
  .nai-new-adventure {
    display: flex; align-items: center; gap: 8px;
    margin: 10px 10px 6px; padding: 8px 12px;
    background: transparent; border: 1px dashed rgba(0,255,65,0.3);
    color: var(--accent, #0f0); font-size: 12px; font-family: var(--font-mono, monospace);
    cursor: pointer; border-radius: 4px; text-transform: uppercase;
    letter-spacing: 1px; font-weight: 700; transition: all 0.2s;
  }
  .nai-new-adventure:hover { background: rgba(0,255,65,0.05); border-color: var(--accent, #0f0); }
  .nai-sidebar-nav {
    display: flex; border-bottom: 1px solid #222; flex-shrink: 0;
  }
  .nai-nav-btn {
    flex: 1; display: flex; flex-direction: column; align-items: center; gap: 2px;
    padding: 8px 4px 6px; background: transparent; border: none;
    border-bottom: 2px solid transparent; color: #666;
    font-size: 9px; font-family: var(--font-mono, monospace);
    cursor: pointer; transition: all 0.2s; text-transform: uppercase; letter-spacing: 0.5px;
  }
  .nai-nav-btn:hover { color: #aaa; background: rgba(255,255,255,0.03); }
  .nai-nav-btn.active { color: var(--accent, #0f0); border-bottom-color: var(--accent, #0f0); }
  .nai-view { flex: 1; overflow-y: auto; overflow-x: hidden; min-height: 0; }
  #nai-cust-sub { overflow-y: auto; max-height: 100%; }
  #nai-cust-main { overflow-y: auto; max-height: 100%; }
  .nai-session-list { padding: 4px 0; }
  .nai-session-item {
    display: flex; align-items: flex-start; flex-direction: column;
    padding: 8px 12px; cursor: pointer; border-left: 2px solid transparent;
    transition: all 0.15s; position: relative;
  }
  .nai-session-item:hover { background: rgba(255,255,255,0.03); }
  .nai-session-item.active { background: rgba(0,255,65,0.05); border-left-color: var(--accent, #0f0); }
  .nai-session-title {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: #ccc; font-size: 12px; width: 100%;
  }
  .nai-session-meta { font-size: 9px; color: #555; margin-top: 2px; }
  .nai-session-delete {
    display: none; position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
    background: transparent; border: none; color: #f87171; cursor: pointer;
    font-size: 14px; padding: 2px 4px;
  }
  .nai-session-item:hover .nai-session-delete { display: block; }
  .nai-session-delete:hover { text-shadow: 0 0 5px #f87171; }
  .nai-search-box { padding: 10px; border-bottom: 1px solid #222; }
  .nai-search-box input {
    width: 100%; padding: 6px 10px; font-size: 12px; box-sizing: border-box;
    background: #111; border: 1px solid #333; color: #ccc;
    font-family: var(--font-mono, monospace); border-radius: 3px;
  }
  .nai-search-box input:focus { border-color: var(--accent, #0f0); outline: none; }
  .nai-search-result {
    padding: 8px 12px; cursor: pointer;
    border-bottom: 1px solid rgba(255,255,255,0.05); transition: background 0.15s;
  }
  .nai-search-result:hover { background: rgba(255,255,255,0.03); }
  .nai-result-title { font-weight: 700; color: var(--accent, #0f0); font-size: 11px; margin-bottom: 4px; }
  .nai-result-snippet { font-size: 11px; color: #666; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .nai-search-result mark { background: rgba(0,255,65,0.3); color: #fff; padding: 0 2px; border-radius: 2px; }
  #nai-content-wrapper .chat-screen { flex: 1; min-width: 0; }
  /* Restored message bubbles (no Svelte hash) */
  .nai-restored { width: 100%; padding: 8px 16px; margin: 0; border-left: 2px solid transparent; }
  .nai-restored.user { border-left-color: var(--accent-dim, rgba(0,255,65,0.3)); background: rgba(0,0,0,0.15); }
  .nai-restored.assistant { border-left-color: var(--warning, #fa0); background: rgba(255,170,0,0.03); }
  .nai-restored .nai-meta { display: flex; gap: 6px; font-size: 11px; margin-bottom: 4px; opacity: 0.7; }
  .nai-restored .nai-msg-content { font-size: 14px; line-height: 1.6; word-wrap: break-word; white-space: pre-wrap; color: #ccc; }
  .nai-empty-sidebar { padding: 20px 12px; color: #555; text-align: center; font-size: 11px; }
  /* ── Customization Center ────────────────────────────────────── */
  .nai-cust-title { font-size: 15px; color: var(--accent, #0f0); font-weight: 700; text-align: center; margin-bottom: 4px; }
  .nai-cust-tagline { font-size: 10px; color: #555; text-align: center; margin-bottom: 16px; line-height: 1.4; padding: 0 8px; }
  .nai-cust-grid { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 10px; justify-content: center; }
  .nai-cust-pill {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 6px 12px; background: rgba(255,255,255,0.03);
    border: 1px solid #333; border-radius: 16px; color: #aaa;
    font-size: 11px; font-family: var(--font-mono, monospace);
    cursor: pointer; transition: all 0.2s; white-space: nowrap;
  }
  .nai-cust-pill:hover { border-color: var(--accent, #0f0); color: var(--accent, #0f0); background: rgba(0,255,65,0.05); }
  .nai-cust-pill .pill-icon { font-size: 13px; opacity: 0.7; }
  .nai-cust-pill.cat-pill { padding: 8px 14px; font-size: 12px; font-weight: 600; }
  .nai-cust-pill.active { border-color: var(--accent, #0f0); color: var(--accent, #0f0); background: rgba(0,255,65,0.08); }
  .nai-cust-pill.dim { opacity: 0.4; border-style: dashed; }
.nai-cust-pill.template { border-style: dashed; opacity: 0.7; }
.nai-cust-pill.template:hover { opacity: 1; }
  .nai-cust-pill.dim:hover { opacity: 0.8; }
  .nai-cust-back {
    display: flex; align-items: center; gap: 6px; padding: 8px 12px;
    background: transparent; border: none; border-bottom: 1px solid #222;
    color: #888; font-size: 11px; font-family: var(--font-mono, monospace);
    cursor: pointer; transition: color 0.2s; width: 100%;
  }
  .nai-cust-back:hover { color: var(--accent, #0f0); }
  .nai-cust-back svg { flex-shrink: 0; }
  .nai-cust-sub-title { font-size: 13px; color: var(--accent, #0f0); font-weight: 700; padding: 10px 12px 6px; }
  .nai-cust-group-label { font-size: 9px; color: #555; text-transform: uppercase; letter-spacing: 1px; padding: 10px 12px 4px; }
  .nai-cust-desc { font-size: 9px; color: #555; padding: 0 12px 10px; }
</style>
<div id="nullifai-control">
  <div style="display:flex;align-items:center;">
    <span class="status-dot live" id="nai-dot"></span>
    <span id="nai-status">nullifAi</span>
  </div>
  <div>
    <button class="kill" id="nai-kill" onclick="nullifaiKill()">Kill</button>
    <button class="launch" id="nai-launch" onclick="nullifaiLaunch()" style="display:none">Launch</button>
  </div>
</div>
<div id="nai-sidebar" class="nai-sidebar" style="display:none">
  <button id="nai-sidebar-toggle" class="nai-sidebar-toggle" title="Toggle sidebar">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12h18M3 6h18M3 18h18"/></svg>
  </button>
  <div id="nai-sidebar-content" class="nai-sidebar-content">
    <button id="nai-new-adventure" class="nai-new-adventure">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>
      <span>New Adventure</span>
    </button>
    <div class="nai-sidebar-nav">
      <button class="nai-nav-btn active" data-view="explorations">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
        <span>Explorations</span>
      </button>
      <button class="nai-nav-btn" data-view="search">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
        <span>Search</span>
      </button>
      <button class="nai-nav-btn" data-view="customize">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09a1.65 1.65 0 00-1.08-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09a1.65 1.65 0 001.51-1.08 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001.08 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9c.26.604.852.997 1.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1.08z"/></svg>
        <span>Customize</span>
      </button>
    </div>
    <div id="nai-view-explorations" class="nai-view active">
      <div id="nai-session-list" class="nai-session-list"></div>
    </div>
    <div id="nai-view-search" class="nai-view" style="display:none">
      <div class="nai-search-box"><input type="text" id="nai-search-input" placeholder="Search explorations..." /></div>
      <div id="nai-search-results"></div>
    </div>
    <div id="nai-view-customize" class="nai-view" style="display:none">
      <div id="nai-cust-main" style="padding:16px 0;">
        <div class="nai-cust-title">Customization Center</div>
        <div class="nai-cust-tagline">Where this becomes more than a tool and an extension of you.</div>
        <div class="nai-cust-grid" id="nai-cust-categories"></div>
      </div>
      <div id="nai-cust-sub" style="display:none;">
        <button class="nai-cust-back" id="nai-cust-back-btn">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
          <span>Back</span>
        </button>
        <div id="nai-cust-sub-title" class="nai-cust-sub-title"></div>
        <div id="nai-cust-sub-desc" class="nai-cust-desc"></div>
        <div id="nai-cust-sub-content" class="nai-cust-grid" style="padding-top:4px;"></div>
      </div>
    </div>
  </div>
</div>
<script>
(function() {
  // ── Utility ──────────────────────────────────────────────────────
  function escapeHtml(str) {
    var d = document.createElement('div'); d.textContent = str; return d.innerHTML;
  }

  // ── WebSocket constructor wrap (captures assistant messages) ─────
  var _OrigWebSocket = window.WebSocket;
  var _assistantBuffer = {};
  window.WebSocket = function(url, protocols) {
    var ws = protocols ? new _OrigWebSocket(url, protocols) : new _OrigWebSocket(url);
    ws.addEventListener('message', function(event) {
      try {
        var msg = JSON.parse(event.data);
        if (!msg || !msg.type) return;
        var sid = msg.session_id || 'default';
        if (msg.type === 'assistant_chunk') {
          if (!_assistantBuffer[sid]) _assistantBuffer[sid] = '';
          if (msg.payload && msg.payload.content) _assistantBuffer[sid] += msg.payload.content;
        }
        if (msg.type === 'assistant_final') {
          var content = (msg.payload && msg.payload.content) || _assistantBuffer[sid] || '';
          if (content && typeof NaiSessions !== 'undefined' && NaiSessions.currentSessionId) {
            NaiStorage.addMessage(NaiSessions.currentSessionId, 'assistant', content);
            if (typeof NaiSidebar !== 'undefined') NaiSidebar.refreshSessionList();
          }
          delete _assistantBuffer[sid];
        }
      } catch(e) {}
    });
    return ws;
  };
  window.WebSocket.prototype = _OrigWebSocket.prototype;
  window.WebSocket.CONNECTING = _OrigWebSocket.CONNECTING;
  window.WebSocket.OPEN = _OrigWebSocket.OPEN;
  window.WebSocket.CLOSING = _OrigWebSocket.CLOSING;
  window.WebSocket.CLOSED = _OrigWebSocket.CLOSED;

  // ── NaiStorage — localStorage persistence ────────────────────────
  var NaiStorage = {
    SIDEBAR_KEY: 'nullifai_sidebar_state',
    INDEX_KEY: 'nullifai_sessions_index',
    SESSION_PREFIX: 'nullifai_session_',

    getSidebarState: function() {
      try { var r = localStorage.getItem(this.SIDEBAR_KEY); return r ? JSON.parse(r) : { collapsed: false, activeSessionId: null, activeView: 'explorations' }; }
      catch(e) { return { collapsed: false, activeSessionId: null, activeView: 'explorations' }; }
    },
    saveSidebarState: function(state) {
      try { localStorage.setItem(this.SIDEBAR_KEY, JSON.stringify(state)); } catch(e) {}
    },
    getSessionIndex: function() {
      try { var r = localStorage.getItem(this.INDEX_KEY); return r ? JSON.parse(r) : []; }
      catch(e) { return []; }
    },
    saveSessionIndex: function(index) {
      try { localStorage.setItem(this.INDEX_KEY, JSON.stringify(index)); } catch(e) {}
    },
    getSession: function(id) {
      try { var r = localStorage.getItem(this.SESSION_PREFIX + id); return r ? JSON.parse(r) : null; }
      catch(e) { return null; }
    },
    saveSession: function(session) {
      try { localStorage.setItem(this.SESSION_PREFIX + session.id, JSON.stringify(session)); } catch(e) {}
    },
    deleteSession: function(id) {
      try { localStorage.removeItem(this.SESSION_PREFIX + id); } catch(e) {}
    },
    createSession: function(id) {
      var now = Date.now();
      var session = { id: id, title: 'New Adventure', createdAt: now, updatedAt: now, messages: [] };
      this.saveSession(session);
      var index = this.getSessionIndex();
      index.unshift({ id: id, title: session.title, createdAt: now, updatedAt: now, messageCount: 0 });
      this.saveSessionIndex(index);
      return session;
    },
    addMessage: function(sessionId, role, content) {
      var session = this.getSession(sessionId);
      if (!session) session = this.createSession(sessionId);
      var msg = { role: role, content: content, timestamp: Date.now() };
      session.messages.push(msg);
      session.updatedAt = msg.timestamp;
      if (session.title === 'New Adventure' && role === 'user' && content.trim()) {
        var clean = content.trim().replace(/\\[\\w+:[^\\]]*\\]\\n---[\\s\\S]*?---\\n\\n/g, '').trim();
        if (!clean) clean = content.trim();
        session.title = clean.substring(0, 40) + (clean.length > 40 ? '...' : '');
      }
      this.saveSession(session);
      var index = this.getSessionIndex();
      var entry = index.find(function(e) { return e.id === sessionId; });
      if (entry) { entry.title = session.title; entry.updatedAt = session.updatedAt; entry.messageCount = session.messages.length; }
      this.saveSessionIndex(index);
      return msg;
    }
  };

  // ── NaiSessions — session lifecycle ──────────────────────────────
  var NaiSessions = {
    currentSessionId: null,
    init: function() {
      var state = NaiStorage.getSidebarState();
      if (state.activeSessionId && NaiStorage.getSession(state.activeSessionId)) {
        this.currentSessionId = state.activeSessionId;
      } else {
        this.newSession();
      }
    },
    generateId: function() {
      return Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 8);
    },
    newSession: function() {
      var id = this.generateId();
      NaiStorage.createSession(id);
      this.currentSessionId = id;
      var state = NaiStorage.getSidebarState();
      state.activeSessionId = id;
      NaiStorage.saveSidebarState(state);
      return id;
    },
    switchSession: function(id) {
      this.currentSessionId = id;
      var state = NaiStorage.getSidebarState();
      state.activeSessionId = id;
      NaiStorage.saveSidebarState(state);
    },
    deleteSession: function(id) {
      NaiStorage.deleteSession(id);
      var index = NaiStorage.getSessionIndex();
      index = index.filter(function(e) { return e.id !== id; });
      NaiStorage.saveSessionIndex(index);
      if (this.currentSessionId === id) {
        if (index.length > 0) this.switchSession(index[0].id);
        else this.newSession();
      }
    }
  };

  // ── Input injection helper ────────────────────────────────────────
  function injectToInput(text, autoSend) {
    var ta = document.querySelector('[class*="input-area"] textarea');
    if (!ta) return;
    var nativeSet = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    nativeSet.call(ta, text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();
    if (autoSend) {
      setTimeout(function() {
        var sendBtn = ta.closest('form');
        if (sendBtn) { sendBtn.requestSubmit ? sendBtn.requestSubmit() : sendBtn.submit(); return; }
        ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      }, 50);
    }
  }

  // ── NaiCustomize — Customization Center ──────────────────────────
  var NaiCustomize = {
    categories: {
      commands: {
        icon: '\u2318', label: 'Commands',
        desc: 'Agent commands sent directly to the chat.',
        groups: [
          { label: 'Info', items: [
            { label: '/help', desc: 'Show available commands', action: '/help', send: true },
            { label: '/status', desc: 'System status', action: '/status', send: true },
            { label: '/version', desc: 'Show agent version', action: '/version', send: true },
            { label: '/whoami', desc: 'Identity info', action: '/whoami', send: true },
            { label: '/capabilities', desc: 'List capabilities', action: '/capabilities', send: true },
            { label: '/debug', desc: 'Debug info', action: '/debug', send: true }
          ]},
          { label: 'Session', items: [
            { label: '/new', desc: 'Start new session', action: '/new', send: true },
            { label: '/reset', desc: 'Reset with optional model', action: '/reset ' },
            { label: '/restart', desc: 'Restart with optional model', action: '/restart ' },
            { label: '/compact', desc: 'Compact context', action: '/compact', send: true },
            { label: '/export', desc: 'Export session', action: '/export', send: true },
            { label: '/session ttl', desc: 'Set session timeout', action: '/session ttl ' }
          ]},
          { label: 'Models', items: [
            { label: '/models', desc: 'List all models', action: '/models', send: true },
            { label: '/model', desc: 'Switch model', action: '/model ' }
          ]},
          { label: 'Thinking', items: [
            { label: '/think', desc: 'Check status', action: '/think', send: true },
            { label: '/think high', desc: 'Enable thinking', action: '/think high', send: true },
            { label: '/think xhigh', desc: 'Max thinking', action: '/think xhigh', send: true },
            { label: '/think off', desc: 'Disable thinking', action: '/think off', send: true }
          ]},
          { label: 'Verbose', items: [
            { label: '/verbose', desc: 'Check status', action: '/verbose', send: true },
            { label: '/verbose on', desc: 'Enable verbose', action: '/verbose on', send: true },
            { label: '/verbose off', desc: 'Disable verbose', action: '/verbose off', send: true }
          ]},
          { label: 'Reasoning', items: [
            { label: '/reason', desc: 'Check status', action: '/reason', send: true },
            { label: '/reason on', desc: 'Enable reasoning', action: '/reason on', send: true },
            { label: '/reason off', desc: 'Disable reasoning', action: '/reason off', send: true }
          ]},
          { label: 'Memory', items: [
            { label: '/memory list', desc: 'List memories', action: '/memory list', send: true },
            { label: '/memory stats', desc: 'Memory statistics', action: '/memory stats', send: true },
            { label: '/memory search', desc: 'Search memories', action: '/memory search ' },
            { label: '/memory recall', desc: 'Recall by topic', action: '/memory recall ' },
            { label: '/doctor', desc: 'Memory diagnostics', action: '/doctor', send: true }
          ]},
          { label: 'Agents', items: [
            { label: '/subagents', desc: 'List sub-agents', action: '/subagents', send: true },
            { label: '/focus', desc: 'Focus an agent', action: '/focus ' },
            { label: '/unfocus', desc: 'Unfocus agent', action: '/unfocus', send: true },
            { label: '/steer', desc: 'Steer an agent', action: '/steer ' },
            { label: '/tell', desc: 'Tell an agent', action: '/tell ' }
          ]},
          { label: 'Features', items: [
            { label: '/tts', desc: 'Text-to-speech toggle', action: '/tts', send: true },
            { label: '/voice', desc: 'Voice settings', action: '/voice', send: true },
            { label: '/queue', desc: 'Queue settings', action: '/queue', send: true },
            { label: '/usage', desc: 'Token usage', action: '/usage', send: true },
            { label: '/config', desc: 'Configuration', action: '/config', send: true }
          ]},
          { label: 'Execution & Access', items: [
            { label: '/exec', desc: 'Execution settings', action: '/exec', send: true },
            { label: '/exec security=full', desc: 'Unlock all tools', action: '/exec security=full', send: true },
            { label: '/exec security=allowlist', desc: 'Restrict to allowlist', action: '/exec security=allowlist', send: true },
            { label: '/allowlist', desc: 'View allowlist', action: '/allowlist', send: true },
            { label: '/approve', desc: 'Approve pending', action: '/approve', send: true },
            { label: '/elevated', desc: 'Elevated mode', action: '/elevated', send: true },
            { label: '/context', desc: 'Context settings', action: '/context', send: true }
          ]},
          { label: 'Config Toggles (local UI + all channels)', items: [
            { label: 'File Access: Everywhere', desc: 'autonomy.workspace_only=false — read files anywhere on the system', configKey: 'autonomy.workspace_only', configValues: [false, true], configLabels: ['Everywhere \u2713', 'Workspace Only'], toggle: true },
            { label: 'Shell: No Approval', desc: 'Skip approval for medium-risk commands', configKey: 'autonomy.require_approval_for_medium_risk', configValues: [false, true], configLabels: ['No Approval \u2713', 'Require Approval'], toggle: true },
            { label: 'High-Risk Commands: Allowed', desc: 'Allow destructive shell commands', configKey: 'autonomy.block_high_risk_commands', configValues: [false, true], configLabels: ['Allowed \u2713', 'Blocked'], toggle: true },
            { label: 'Autonomy: Full', desc: 'Agent autonomy level', configKey: 'autonomy.level', configValues: ['full', 'supervised', 'read_only'], configLabels: ['Full \u2713', 'Supervised', 'Read-Only'], toggle: true },
            { label: '\u21BB Reset Local Sessions', desc: 'Kill all local agent sessions so they reload with updated config (local UI only, Discord unaffected)', configAction: 'reset-sessions' },
            { label: '\u21BB Restart Gateway', desc: 'Apply config changes to Discord & all other channels (does NOT affect local UI sessions)', configAction: 'restart-gateway' }
          ]}
        ]
      },
      skills: {
        icon: '\u2726', label: 'Skills',
        desc: 'Extend the agent with installable skill packs.',
        items: [
          { label: '/skill', desc: 'Skill management', action: '/skill', send: true },
          { label: 'Install a Skill', desc: 'Install by name', action: '/skill install ' }
        ],
        emptyNote: 'No skills installed yet. Use /skill to manage skill packs via CLI: nullclaw skills install <name>'
      },
      tools: {
        icon: '\u2699', label: 'Tools',
        desc: 'Built-in tools the agent can use during conversations.',
        groups: [
          { label: 'File System', items: [
            { label: '/file_read', desc: 'Read any file', action: '/file_read ' },
            { label: '/file_write', desc: 'Write to a file', action: '/file_write ' },
            { label: '/file_edit', desc: 'Edit a file', action: '/file_edit ' },
            { label: '/shell type', desc: 'Read any file via shell', action: '/shell type ' }
          ]},
          { label: 'System', items: [
            { label: '/shell', desc: 'Run shell commands', action: '/shell ' },
            { label: '/git', desc: 'Git operations', action: '/git ' },
            { label: '/image_info', desc: 'Analyze images', action: '/image_info ' }
          ]},
          { label: 'Memory', items: [
            { label: '/memory store', desc: 'Save a memory', action: '/memory store ' },
            { label: '/memory recall', desc: 'Recall memories', action: '/memory recall ' },
            { label: '/memory list', desc: 'List all memories', action: '/memory list', send: true },
            { label: '/memory search', desc: 'Search memories', action: '/memory search ' },
            { label: '/memory forget', desc: 'Remove a memory', action: '/memory forget ' }
          ]},
          { label: 'Agent', items: [
            { label: '/delegate', desc: 'Delegate to sub-agent', action: '/delegate ' },
            { label: '/schedule', desc: 'Schedule a task', action: '/schedule ' },
            { label: '/spawn', desc: 'Spawn background task', action: '/spawn ' }
          ]},
          { label: 'Disabled (enable in config)', items: [
            { label: 'http_request', desc: 'HTTP requests', action: 'Enable the http_request tool in your config and confirm it is active', dim: true, send: true },
            { label: 'browser', desc: 'Browser automation', action: 'Enable the browser tool in your config and confirm it is active', dim: true, send: true },
            { label: 'screenshot', desc: 'Screenshots', action: 'Enable the screenshot tool in your config and confirm it is active', dim: true, send: true },
            { label: 'composio', desc: 'Composio integration', action: 'Enable the composio tool in your config and confirm it is active', dim: true, send: true },
            { label: 'browser_open', desc: 'Open browser URLs', action: 'Enable the browser_open tool in your config and confirm it is active', dim: true, send: true },
            { label: 'hardware_board_info', desc: 'Hardware board info', action: 'Enable the hardware_board_info tool in your config and confirm it is active', dim: true, send: true },
            { label: 'hardware_memory', desc: 'Hardware memory', action: 'Enable the hardware_memory tool in your config and confirm it is active', dim: true, send: true },
            { label: 'i2c', desc: 'I2C bus control', action: 'Enable the i2c tool in your config and confirm it is active', dim: true, send: true }
          ]}
        ]
      },
      connectors: {
        icon: '\u2B21', label: 'Connectors',
        desc: 'Communication channels the agent can connect to.',
        configured: ['cli', 'web'],
        dockable: [
          { label: 'telegram', action: '/dock-telegram', send: true },
          { label: 'discord', action: '/dock-discord', send: true },
          { label: 'slack', action: '/dock-slack', send: true }
        ],
        available: ['webhook', 'imessage', 'matrix', 'mattermost', 'whatsapp', 'irc', 'lark', 'dingtalk', 'signal', 'email', 'line', 'qq', 'onebot', 'maixcam', 'nostr']
      },
      models: {
        icon: '\u25C8', label: 'Models',
        desc: 'AI models available for conversations.',
        dynamic: true
      }
    },

    init: function() {
      var grid = document.getElementById('nai-cust-categories');
      if (!grid) return;
      var self = this;
      var cats = this.categories;
      var html = '';
      for (var key in cats) {
        var c = cats[key];
        html += '<button class="nai-cust-pill cat-pill" data-cat="' + key + '">'
          + '<span class="pill-icon">' + c.icon + '</span>' + c.label + '</button>';
      }
      grid.innerHTML = html;
      grid.addEventListener('click', function(e) {
        var pill = e.target.closest('[data-cat]');
        if (pill) self.openCategory(pill.getAttribute('data-cat'));
      });
      document.getElementById('nai-cust-back-btn').addEventListener('click', function() {
        self.goBack();
      });
      document.getElementById('nai-cust-sub-content').addEventListener('click', function(e) {
        var pill = e.target.closest('[data-action]');
        if (pill) injectToInput(pill.getAttribute('data-action'), pill.hasAttribute('data-send'));
        // Config toggle pills
        var cfgPill = e.target.closest('[data-config-key]');
        if (cfgPill) {
          var key = cfgPill.getAttribute('data-config-key');
          var values = JSON.parse(cfgPill.getAttribute('data-config-values'));
          var labels = JSON.parse(cfgPill.getAttribute('data-config-labels'));
          var curIdx = parseInt(cfgPill.getAttribute('data-config-idx') || '0');
          var nextIdx = (curIdx + 1) % values.length;
          fetch('/api/config', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ path: key, value: values[nextIdx] }) })
            .then(function(r) { return r.json(); })
            .then(function(d) {
              if (d.ok) {
                cfgPill.setAttribute('data-config-idx', nextIdx);
                cfgPill.textContent = labels[nextIdx];
                cfgPill.title = key + ' = ' + JSON.stringify(values[nextIdx]);
                cfgPill.className = nextIdx === 0 ? 'nai-cust-pill active' : 'nai-cust-pill dim';
              }
            });
        }
        // Config action buttons (restart-gateway, reset-sessions)
        var restartPill = e.target.closest('[data-config-restart]');
        if (restartPill) {
          var action = restartPill.getAttribute('data-config-restart');
          if (action === 'reset-sessions') {
            restartPill.textContent = 'Resetting sessions...';
            restartPill.classList.add('dim');
            fetch('/api/reset-sessions', { method: 'POST' }).then(function() {
              setTimeout(function() { restartPill.textContent = '\u21BB Reset Local Sessions'; restartPill.classList.remove('dim'); }, 3000);
            });
          } else {
            restartPill.textContent = 'Restarting...';
            restartPill.classList.add('dim');
            fetch('/api/gateway/restart', { method: 'POST' }).then(function() {
              setTimeout(function() { restartPill.textContent = '\u21BB Restart Gateway'; restartPill.classList.remove('dim'); }, 5000);
            });
          }
        }
      });
    },

    goBack: function() {
      document.getElementById('nai-cust-main').style.display = '';
      document.getElementById('nai-cust-sub').style.display = 'none';
    },

    openCategory: function(key) {
      document.getElementById('nai-cust-main').style.display = 'none';
      document.getElementById('nai-cust-sub').style.display = '';
      var cat = this.categories[key];
      document.getElementById('nai-cust-sub-title').textContent = cat.icon + ' ' + cat.label;
      document.getElementById('nai-cust-sub-desc').textContent = cat.desc || '';

      if (key === 'models') { this.renderModels(); return; }
      if (key === 'connectors') { this.renderConnectors(); return; }
      if (cat.groups) { this.renderGrouped(key); return; }

      // Skills — simple item list
      var content = document.getElementById('nai-cust-sub-content');
      var html = '';
      if (cat.items) {
        html = cat.items.map(function(it) {
          var sendAttr = it.send ? ' data-send' : '';
          var cls = it.send ? 'nai-cust-pill' : 'nai-cust-pill template';
          return '<button class="' + cls + '" data-action="' + escapeHtml(it.action) + '"' + sendAttr + ' title="' + escapeHtml(it.desc) + '">'
            + escapeHtml(it.label) + (it.send ? '' : ' \u270E') + '</button>';
        }).join('');
      }
      if (cat.emptyNote) {
        html += '<div class="nai-empty-sidebar" style="width:100%;margin-top:8px;">' + escapeHtml(cat.emptyNote) + '</div>';
      }
      content.innerHTML = html;
    },

    renderGrouped: function(key) {
      var content = document.getElementById('nai-cust-sub-content');
      var groups = this.categories[key].groups;
      var html = '';
      var configLoaded = false;
      var configPills = [];
      groups.forEach(function(g) {
        html += '<div class="nai-cust-group-label" style="width:100%;">' + escapeHtml(g.label) + '</div>';
        html += g.items.map(function(it) {
          // Config toggle pill
          if (it.toggle && it.configKey) {
            var id = 'cfg-' + it.configKey.replace(/\./g, '-');
            configPills.push({ id: id, key: it.configKey, values: it.configValues, labels: it.configLabels });
            return '<button class="nai-cust-pill active" id="' + id + '" data-config-key="' + escapeHtml(it.configKey) + '" data-config-values="' + escapeHtml(JSON.stringify(it.configValues)) + '" data-config-labels="' + escapeHtml(JSON.stringify(it.configLabels)) + '" data-config-idx="0" title="' + escapeHtml(it.desc) + '">'
              + escapeHtml(it.configLabels[0]) + '</button>';
          }
          // Config action buttons (restart-gateway, reset-sessions, etc.)
          if (it.configAction) {
            return '<button class="nai-cust-pill" data-config-restart="' + escapeHtml(it.configAction) + '" title="' + escapeHtml(it.desc) + '">'
              + escapeHtml(it.label) + '</button>';
          }
          // Normal pill
          var sendAttr = it.send ? ' data-send' : '';
          var cls = 'nai-cust-pill';
          if (it.dim) cls += ' dim';
          else if (!it.send) cls += ' template';
          return '<button class="' + cls + '" data-action="' + escapeHtml(it.action || '') + '"' + sendAttr + ' title="' + escapeHtml(it.desc) + '">'
            + escapeHtml(it.label) + (!it.send && !it.dim ? ' \u270E' : '') + '</button>';
        }).join('');
      });
      content.innerHTML = html;
      // Load current config values and sync toggle states
      if (configPills.length > 0) {
        fetch('/api/config').then(function(r) { return r.json(); }).then(function(d) {
          if (!d.ok) return;
          configPills.forEach(function(cp) {
            var el = document.getElementById(cp.id);
            if (!el) return;
            var parts = cp.key.split('.');
            var val = d.config;
            for (var i = 0; i < parts.length; i++) { val = val ? val[parts[i]] : undefined; }
            // Find which index matches current value
            var idx = 0;
            for (var j = 0; j < cp.values.length; j++) {
              if (JSON.stringify(val) === JSON.stringify(cp.values[j])) { idx = j; break; }
            }
            el.setAttribute('data-config-idx', idx);
            el.textContent = cp.labels[idx];
            el.title = cp.key + ' = ' + JSON.stringify(val);
            el.className = idx === 0 ? 'nai-cust-pill active' : 'nai-cust-pill dim';
          });
        });
      }
    },

    renderConnectors: function() {
      var content = document.getElementById('nai-cust-sub-content');
      var cat = this.categories.connectors;
      var html = '<div class="nai-cust-group-label" style="width:100%;">Active</div>';
      html += cat.configured.map(function(c) {
        return '<button class="nai-cust-pill active" data-action="/status" data-send>'
          + escapeHtml(c) + '</button>';
      }).join('');
      html += '<div class="nai-cust-group-label" style="width:100%;">Quick Dock</div>';
      html += cat.dockable.map(function(c) {
        return '<button class="nai-cust-pill" data-action="' + escapeHtml(c.action) + '" data-send>'
          + escapeHtml(c.label) + '</button>';
      }).join('');
      html += '<div class="nai-cust-group-label" style="width:100%;">Available</div>';
      html += cat.available.map(function(c) {
        return '<button class="nai-cust-pill dim template" data-action="Help me set up the ' + c + ' connector">'
          + escapeHtml(c) + ' \u270E</button>';
      }).join('');
      content.innerHTML = html;
    },

    renderModels: function() {
      var content = document.getElementById('nai-cust-sub-content');
      content.innerHTML = '<div class="nai-empty-sidebar" style="width:100%;">Loading models...</div>';
      fetch('/api/models').then(function(r) { return r.json(); }).then(function(data) {
        if (!data.models || data.models.length === 0) {
          content.innerHTML = '<div class="nai-empty-sidebar" style="width:100%;">No models found. Is Ollama running?</div>';
          return;
        }
        var activeModel = data.activeModel || '';
        var html = data.models.map(function(m) {
          var name = m.name;
          var size = m.size ? (m.size / 1e9).toFixed(1) + 'GB' : '';
          var isActive = name === activeModel ? ' active' : '';
          var displayLabel = m.label || name;
          if (size && size !== '0.0GB') displayLabel += ' (' + size + ')';
          var badge = m.provider && m.provider !== 'ollama' ? ' [' + escapeHtml(m.provider) + ']' : '';
          return '<button class="nai-cust-pill' + isActive + '" data-action="/model ' + escapeHtml(name) + '" data-send title="' + escapeHtml(isActive ? 'Currently active' : 'Click to switch to ' + name) + '">'
            + escapeHtml(displayLabel) + badge + (isActive ? ' \u2713' : '') + '</button>';
        }).join('');
        content.innerHTML = html;
      }).catch(function() {
        content.innerHTML = '<div class="nai-empty-sidebar" style="width:100%;">Failed to load models.</div>';
      });
    }
  };

  // ── NaiSidebar — DOM setup and rendering ─────────────────────────
  var NaiSidebar = {
    setup: function() {
      var chatScreen = document.querySelector('.chat-screen');
      var sidebar = document.getElementById('nai-sidebar');
      if (!chatScreen || !sidebar) return false;

      // Create flex-row wrapper
      var wrapper = document.createElement('div');
      wrapper.id = 'nai-content-wrapper';
      chatScreen.parentNode.insertBefore(wrapper, chatScreen);
      wrapper.appendChild(sidebar);
      wrapper.appendChild(chatScreen);
      sidebar.style.display = '';

      // Restore state
      var state = NaiStorage.getSidebarState();
      if (state.collapsed) sidebar.classList.add('collapsed');
      this.bindEvents();
      this.refreshSessionList();
      this.setActiveView(state.activeView || 'explorations');
      NaiCustomize.init();
      return true;
    },

    bindEvents: function() {
      var self = this;
      document.getElementById('nai-sidebar-toggle').addEventListener('click', function() {
        var sb = document.getElementById('nai-sidebar');
        sb.classList.toggle('collapsed');
        var state = NaiStorage.getSidebarState();
        state.collapsed = sb.classList.contains('collapsed');
        NaiStorage.saveSidebarState(state);
      });

      document.getElementById('nai-new-adventure').addEventListener('click', function() {
        NaiSessions.newSession();
        self.clearChatDOM();
        self.refreshSessionList();
      });

      document.querySelectorAll('.nai-nav-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
          self.setActiveView(btn.getAttribute('data-view'));
        });
      });

      var searchInput = document.getElementById('nai-search-input');
      if (searchInput) {
        var debounce = null;
        searchInput.addEventListener('input', function() {
          clearTimeout(debounce);
          debounce = setTimeout(function() { self.performSearch(searchInput.value.trim()); }, 300);
        });
      }

      document.getElementById('nai-session-list').addEventListener('click', function(e) {
        var del = e.target.closest('.nai-session-delete');
        if (del) {
          e.stopPropagation();
          var id = del.getAttribute('data-id');
          if (confirm('Delete this adventure?')) {
            NaiSessions.deleteSession(id);
            self.loadSessionIntoDOM(NaiSessions.currentSessionId);
            self.refreshSessionList();
          }
          return;
        }
        var item = e.target.closest('.nai-session-item');
        if (item) {
          var id = item.getAttribute('data-id');
          if (id !== NaiSessions.currentSessionId) {
            NaiSessions.switchSession(id);
            self.loadSessionIntoDOM(id);
            self.refreshSessionList();
          }
        }
      });
    },

    setActiveView: function(viewName) {
      document.querySelectorAll('.nai-nav-btn').forEach(function(btn) {
        btn.classList.toggle('active', btn.getAttribute('data-view') === viewName);
      });
      ['explorations', 'search', 'customize'].forEach(function(v) {
        var el = document.getElementById('nai-view-' + v);
        if (el) el.style.display = v === viewName ? '' : 'none';
      });
      var state = NaiStorage.getSidebarState();
      state.activeView = viewName;
      NaiStorage.saveSidebarState(state);
    },

    refreshSessionList: function() {
      var list = document.getElementById('nai-session-list');
      if (!list) return;
      var index = NaiStorage.getSessionIndex();
      var activeId = NaiSessions.currentSessionId;
      if (index.length === 0) {
        list.innerHTML = '<div class="nai-empty-sidebar">No adventures yet</div>';
        return;
      }
      list.innerHTML = index.map(function(s) {
        var active = s.id === activeId ? ' active' : '';
        var d = new Date(s.updatedAt);
        var ts = d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
        return '<div class="nai-session-item' + active + '" data-id="' + s.id + '">'
          + '<div class="nai-session-title">' + escapeHtml(s.title) + '</div>'
          + '<div class="nai-session-meta">' + ts + ' &middot; ' + (s.messageCount || 0) + ' msgs</div>'
          + '<button class="nai-session-delete" data-id="' + s.id + '" title="Delete">&times;</button>'
          + '</div>';
      }).join('');
    },

    clearChatDOM: function() {
      var msgs = document.querySelector('.messages');
      if (!msgs) return;
      msgs.querySelectorAll('.bubble-container, .nai-restored').forEach(function(b) { b.remove(); });
      // Show empty state if it exists
      var empty = msgs.querySelector('[class*="empty"]');
      if (empty) empty.style.display = '';
    },

    loadSessionIntoDOM: function(sessionId) {
      this.clearChatDOM();
      var session = NaiStorage.getSession(sessionId);
      if (!session || session.messages.length === 0) return;
      var msgs = document.querySelector('.messages');
      if (!msgs) return;
      // Hide empty state
      var empty = msgs.querySelector('[class*="empty"]');
      if (empty) empty.style.display = 'none';

      session.messages.forEach(function(msg) {
        var el = document.createElement('div');
        el.className = 'nai-restored ' + msg.role;

        var meta = document.createElement('div');
        meta.className = 'nai-meta';
        var prompt = msg.role === 'user' ? '<span style="color:var(--accent,#0f0);font-weight:700">&gt;</span>' : '<span style="color:var(--warning,#fa0);font-weight:700">$</span>';
        var ts = new Date(msg.timestamp).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
        meta.innerHTML = prompt + '<span style="color:#555">::</span><span style="color:#555;font-size:10px">' + ts + '</span>';

        var content = document.createElement('div');
        content.className = 'nai-msg-content';
        content.textContent = msg.content;

        el.appendChild(meta);
        el.appendChild(content);
        msgs.appendChild(el);
      });
      msgs.scrollTop = msgs.scrollHeight;
    },

    performSearch: function(query) {
      var resultsEl = document.getElementById('nai-search-results');
      if (!resultsEl) return;
      if (!query || query.length < 2) {
        resultsEl.innerHTML = '<div class="nai-empty-sidebar">Type at least 2 characters</div>';
        return;
      }
      var index = NaiStorage.getSessionIndex();
      var results = [];
      var lq = query.toLowerCase();
      index.forEach(function(entry) {
        var session = NaiStorage.getSession(entry.id);
        if (!session) return;
        session.messages.forEach(function(msg) {
          var pos = msg.content.toLowerCase().indexOf(lq);
          if (pos === -1) return;
          var start = Math.max(0, pos - 30);
          var end = Math.min(msg.content.length, pos + query.length + 30);
          var snippet = (start > 0 ? '...' : '') + msg.content.substring(start, end) + (end < msg.content.length ? '...' : '');
          results.push({ sessionId: entry.id, sessionTitle: entry.title, snippet: snippet, matchPos: pos - start + (start > 0 ? 3 : 0), matchLen: query.length });
        });
      });
      if (results.length === 0) {
        resultsEl.innerHTML = '<div class="nai-empty-sidebar">No results found</div>';
        return;
      }
      results = results.slice(0, 50);
      var self = this;
      resultsEl.innerHTML = results.map(function(r) {
        var esc = escapeHtml(r.snippet);
        var hl = esc.substring(0, r.matchPos) + '<mark>' + esc.substring(r.matchPos, r.matchPos + r.matchLen) + '</mark>' + esc.substring(r.matchPos + r.matchLen);
        return '<div class="nai-search-result" data-session="' + r.sessionId + '">'
          + '<div class="nai-result-title">' + escapeHtml(r.sessionTitle) + '</div>'
          + '<div class="nai-result-snippet">' + hl + '</div></div>';
      }).join('');
      resultsEl.querySelectorAll('.nai-search-result').forEach(function(el) {
        el.addEventListener('click', function() {
          var sid = el.getAttribute('data-session');
          NaiSessions.switchSession(sid);
          self.loadSessionIntoDOM(sid);
          self.refreshSessionList();
          self.setActiveView('explorations');
        });
      });
    }
  };

  // ── Control bar logic ─────────────────────────────────────────────
  function updateUI(alive) {
    var dot = document.getElementById('nai-dot');
    var status = document.getElementById('nai-status');
    var killBtn = document.getElementById('nai-kill');
    var launchBtn = document.getElementById('nai-launch');
    if (alive) {
      dot.className = 'status-dot live';
      status.textContent = 'nullifAi';
      killBtn.style.display = '';
      launchBtn.style.display = 'none';
    } else {
      dot.className = 'status-dot dead';
      status.textContent = 'nullifAi stopped';
      killBtn.style.display = 'none';
      launchBtn.style.display = '';
    }
  }

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
    try { await fetch('/api/launch', { method: 'POST' }); } catch {}
    var attempts = 0;
    var poll = setInterval(async function() {
      attempts++;
      try {
        var r = await fetch('/api/status');
        var data = await r.json();
        if (data.active) {
          clearInterval(poll);
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

  // ── Insert control bar into app layout (below status bar) ────────
  function placeControlBar() {
    var bar = document.getElementById('nullifai-control');
    var statusBar = document.querySelector('.status-bar');
    if (!bar || !statusBar) return false;
    // Insert bar right after the status bar in the flex column
    statusBar.parentNode.insertBefore(bar, statusBar.nextSibling);
    // Fix chat-screen: use flex instead of fixed height so adding
    // our bar doesn't push the input below the viewport
    var chatScreen = document.querySelector('.chat-screen');
    if (chatScreen) {
      chatScreen.style.flex = '1';
      chatScreen.style.height = 'auto';
      chatScreen.style.minHeight = '0';
    }
    return true;
  }
  // Poll until the Svelte app renders the status bar
  var placeTries = 0;
  var placeTimer = setInterval(function() {
    placeTries++;
    if (placeControlBar() || placeTries > 50) clearInterval(placeTimer);
  }, 100);

  // ── Rebrand: nullclaw → nullifAi ──────────────────────────────────
  function rebrand() {
    if (document.title.match(/nullclaw/i)) document.title = document.title.replace(/nullclaw/gi, 'nullifAi');
    document.querySelectorAll('[class*="ascii-logo"], [data-text]').forEach(function(el) {
      if (el.textContent.match(/nullclaw/i)) el.textContent = el.textContent.replace(/nullclaw/gi, 'nullifAi');
      var dt = el.getAttribute('data-text');
      if (dt && dt.match(/nullclaw/i)) el.setAttribute('data-text', dt.replace(/nullclaw/gi, 'nullifAi'));
    });
  }
  setInterval(rebrand, 500);

  // ── Auto-pairing ─────────────────────────────────────────────────
  // Watches for the pairing screen, fetches the dynamic code from the
  // bridge API, fills it in, and auto-submits. The user never sees
  // the pairing screen.
  async function autoPair() {
    // Fetch the current pairing code from the bridge
    var code;
    try {
      var r = await fetch('/api/pairing-code');
      var data = await r.json();
      code = data.code;
    } catch { return; }
    if (!code) return;

    // Watch for the pairing input to appear
    var observer = new MutationObserver(function() {
      // Look for the 6-digit pairing input (placeholder="______")
      var input = document.querySelector('input[placeholder="______"]');
      if (!input) return;

      // Fill in the code
      var nativeSet = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      ).set;
      nativeSet.call(input, code);
      input.dispatchEvent(new Event('input', { bubbles: true }));

      // Find and click the connect/pair button
      setTimeout(function() {
        // Look for buttons in the pairing screen
        var buttons = document.querySelectorAll('button');
        for (var i = 0; i < buttons.length; i++) {
          var txt = buttons[i].textContent.toLowerCase().trim();
          if (txt.includes('connect') || txt.includes('pair') || txt.includes('link')) {
            buttons[i].click();
            observer.disconnect();
            return;
          }
        }
        // If no labeled button found, try any primary/submit button near the input
        var form = input.closest('form') || input.closest('div');
        if (form) {
          var btn = form.querySelector('button[type="submit"], button:not([type])');
          if (btn) {
            btn.click();
            observer.disconnect();
          }
        }
      }, 100);
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // Also check immediately (pairing screen might already be visible)
    setTimeout(function() {
      var input = document.querySelector('input[placeholder="______"]');
      if (input) {
        var nativeSet = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value'
        ).set;
        nativeSet.call(input, code);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        setTimeout(function() {
          var buttons = document.querySelectorAll('button');
          for (var i = 0; i < buttons.length; i++) {
            var txt = buttons[i].textContent.toLowerCase().trim();
            if (txt.includes('connect') || txt.includes('pair') || txt.includes('link')) {
              buttons[i].click();
              observer.disconnect();
              return;
            }
          }
        }, 100);
      }
    }, 500);

    // Auto-disconnect observer after 30s to avoid memory leaks
    setTimeout(function() { observer.disconnect(); }, 30000);
  }

  // Run auto-pair on page load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoPair);
  } else {
    autoPair();
  }

  // ── File Upload System ──────────────────────────────────────────
  var attachedFiles = [];
  var MAX_FILE_SIZE = 10 * 1024 * 1024;
  var MAX_TEXT_LEN = 50000;
  var TEXT_EXTS = /\\.(txt|md|csv|json|xml|html|htm|css|js|ts|jsx|tsx|py|java|c|cpp|h|hpp|rs|go|rb|php|sh|bash|zsh|yml|yaml|toml|ini|cfg|conf|log|sql|zig|svelte|vue|swift|kt|scala|r|pl|lua|ex|exs|dart|bat|cmd|ps1|gitignore|env|dockerfile|makefile)$/i;
  var IMAGE_EXTS = /\\.(png|jpg|jpeg|gif|webp|bmp|tiff|tif)$/i;

  // Lazy-load Tesseract.js for OCR
  var tesseractReady = null;
  var tesseractWorker = null;
  function loadTesseract() {
    if (tesseractReady) return tesseractReady;
    tesseractReady = new Promise(function(resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
      s.onload = resolve;
      s.onerror = function() { tesseractReady = null; reject(new Error('Failed to load OCR library')); };
      document.head.appendChild(s);
    });
    return tesseractReady;
  }

  // Lazy-load pdf.js for PDF extraction
  var pdfjsReady = null;
  function loadPdfJs() {
    if (pdfjsReady) return pdfjsReady;
    pdfjsReady = new Promise(function(resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
      s.onload = function() {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc =
          'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        resolve();
      };
      s.onerror = function() { pdfjsReady = null; reject(new Error('Failed to load PDF library')); };
      document.head.appendChild(s);
    });
    return pdfjsReady;
  }

  function truncText(text) {
    if (text.length > MAX_TEXT_LEN)
      return text.substring(0, MAX_TEXT_LEN) + '\\n\\n[... truncated at ' + MAX_TEXT_LEN + ' characters]';
    return text;
  }

  function readAsText(file) {
    return new Promise(function(resolve) {
      var reader = new FileReader();
      reader.onload = function() { resolve({ name: file.name, content: truncText(reader.result), type: 'text' }); };
      reader.onerror = function() { resolve({ name: file.name, content: '[Error reading file]', type: 'error' }); };
      reader.readAsText(file);
    });
  }

  function readAsBase64(file) {
    return new Promise(function(resolve) {
      var reader = new FileReader();
      reader.onload = function() { resolve(reader.result); };
      reader.onerror = function() { resolve(''); };
      reader.readAsDataURL(file);
    });
  }

  async function processFile(file) {
    if (file.size > MAX_FILE_SIZE)
      return { name: file.name, content: '[File too large: ' + (file.size/1024/1024).toFixed(1) + 'MB, max 10MB]', type: 'error' };
    var ext = file.name.lastIndexOf('.') > -1 ? file.name.substring(file.name.lastIndexOf('.')).toLowerCase() : '';
    try {
      // PDF
      if (ext === '.pdf' || file.type === 'application/pdf') {
        await loadPdfJs();
        var buf = await file.arrayBuffer();
        var pdf = await pdfjsLib.getDocument({ data: buf }).promise;
        var pages = [];
        for (var p = 1; p <= pdf.numPages; p++) {
          var page = await pdf.getPage(p);
          var tc = await page.getTextContent();
          pages.push('[Page ' + p + ']\\n' + tc.items.map(function(it) { return it.str; }).join(' '));
        }
        return { name: file.name, content: truncText(pages.join('\\n\\n')), type: 'pdf', extra: pdf.numPages + ' pages' };
      }
      // Image → vision model first, OCR fallback
      if (IMAGE_EXTS.test(file.name) || file.type.startsWith('image/')) {
        // Try server-side vision model (Ollama)
        try {
          var b64 = await readAsBase64(file);
          var descResp = await fetch('/api/describe-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: b64 })
          });
          var descData = await descResp.json();
          if (descData.ok && descData.description) {
            return { name: file.name, content: truncText(descData.description), type: 'vision' };
          }
        } catch(e) {}
        // Fallback: OCR for text-in-images
        try {
          await loadTesseract();
          if (!tesseractWorker) {
            tesseractWorker = await Tesseract.createWorker('eng', 1, {
              workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js',
              corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5/tesseract-core-simd-lstm.wasm.js',
              langPath: 'https://tessdata.projectnaptha.com/4.0.0',
            });
          }
          var result = await tesseractWorker.recognize(file);
          var ocrText = result.data.text.trim();
          if (ocrText) return { name: file.name, content: truncText(ocrText), type: 'ocr' };
        } catch(e) {}
        // No vision model and no OCR text
        return { name: file.name, content: '[Image file. No vision model available for image analysis. Install one with: ollama pull moondream]', type: 'info' };
      }
      // Text-based files
      if (TEXT_EXTS.test(file.name) || file.type.startsWith('text/') || file.type === 'application/json')
        return await readAsText(file);
      // Unknown — try as text
      return await readAsText(file);
    } catch (err) {
      return { name: file.name, content: '[Error: ' + err.message + ']', type: 'error' };
    }
  }

  function renderPreview() {
    var el = document.getElementById('nai-file-preview');
    if (!el) return;
    if (attachedFiles.length === 0) { el.style.display = 'none'; el.innerHTML = ''; return; }
    el.style.display = 'flex';
    el.innerHTML = attachedFiles.map(function(f, i) {
      var tag = f.type === 'loading' ? '...' : f.type === 'error' ? '!' : f.type === 'vision' ? 'IMG' : f.type === 'ocr' ? 'OCR' : f.type === 'pdf' ? 'PDF' : f.type === 'info' ? '?' : 'TXT';
      var cls = f.type === 'loading' ? ' loading' : '';
      return '<span class="file-chip' + cls + '">'
        + '<span style="color:var(--fg-dim);font-size:10px;font-weight:700;">[' + tag + ']</span> '
        + '<span class="fname">' + f.name + '</span>'
        + (f.type !== 'loading' ? '<span class="fremove" data-remove="' + i + '">&times;</span>' : '')
        + '</span>';
    }).join('');
  }

  async function handleFiles(files) {
    for (var i = 0; i < files.length; i++) {
      var idx = attachedFiles.length;
      attachedFiles.push({ name: files[i].name, content: '', type: 'loading' });
      renderPreview();
      var result = await processFile(files[i]);
      if (idx < attachedFiles.length && attachedFiles[idx].type === 'loading') attachedFiles[idx] = result;
      renderPreview();
    }
  }

  // Setup file upload UI once input area renders
  function setupFileUpload() {
    var inputArea = document.querySelector('[class*="input-area"]');
    var textarea = inputArea ? inputArea.querySelector('textarea') : null;
    if (!inputArea || !textarea) return false;

    // Hidden file input
    var fi = document.createElement('input');
    fi.type = 'file'; fi.multiple = true; fi.accept = '*/*'; fi.style.display = 'none';
    document.body.appendChild(fi);

    // Attach button
    var abtn = document.createElement('button');
    abtn.className = 'nai-attach-btn'; abtn.type = 'button';
    abtn.innerHTML = '&#128206;'; abtn.title = 'Attach files (or drag & drop)';
    abtn.onclick = function(e) { e.preventDefault(); fi.click(); };
    var sendBtn = inputArea.querySelector('button:last-of-type');
    if (sendBtn) inputArea.insertBefore(abtn, sendBtn);
    else inputArea.appendChild(abtn);

    fi.onchange = function() { handleFiles(fi.files); fi.value = ''; };

    // File preview bar
    var preview = document.createElement('div');
    preview.id = 'nai-file-preview';
    inputArea.parentNode.insertBefore(preview, inputArea);
    preview.addEventListener('click', function(e) {
      var rm = e.target.closest('[data-remove]');
      if (rm) { attachedFiles.splice(parseInt(rm.dataset.remove), 1); renderPreview(); }
    });

    // Drop overlay
    var overlay = document.createElement('div');
    overlay.id = 'nai-drop-overlay';
    overlay.innerHTML = '<div class="drop-box">DROP FILES TO ATTACH</div>';
    document.body.appendChild(overlay);

    var dragCount = 0;
    document.addEventListener('dragenter', function(e) {
      if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.indexOf('Files') > -1) {
        dragCount++; overlay.style.display = 'flex';
      }
    });
    document.addEventListener('dragleave', function() {
      dragCount--; if (dragCount <= 0) { dragCount = 0; overlay.style.display = 'none'; }
    });
    document.addEventListener('dragover', function(e) { e.preventDefault(); });
    document.addEventListener('drop', function(e) {
      e.preventDefault(); dragCount = 0; overlay.style.display = 'none';
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0)
        handleFiles(e.dataTransfer.files);
    });

    return true;
  }

  var fuTries = 0;
  var fuTimer = setInterval(function() {
    fuTries++;
    if (setupFileUpload() || fuTries > 50) clearInterval(fuTimer);
  }, 200);

  // Intercept WebSocket.send to prepend attached file content
  var _origWsSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function(data) {
    if (attachedFiles.length > 0) {
      try {
        var msg = JSON.parse(data);
        if (msg.type === 'user_message' && msg.payload && msg.payload.content) {
          var ready = attachedFiles.filter(function(f) { return f.type !== 'loading'; });
          if (ready.length > 0) {
            var prefix = ready.map(function(f) {
              var label = f.type === 'vision' ? 'Image' : f.type === 'ocr' ? 'Image OCR' : f.type === 'pdf' ? 'PDF' : f.type === 'info' ? 'Note' : 'File';
              return '[' + label + ': ' + f.name + ']\\n---\\n' + f.content + '\\n---';
            }).join('\\n\\n');
            msg.payload.content = prefix + '\\n\\n' + msg.payload.content;
            data = JSON.stringify(msg);
            attachedFiles = [];
            renderPreview();
          }
        }
      } catch(e) {}
    }
    // Capture user messages for sidebar persistence
    try {
      var _parsed = JSON.parse(data);
      if (_parsed.type === 'user_message' && _parsed.payload && _parsed.payload.content && NaiSessions.currentSessionId) {
        NaiStorage.addMessage(NaiSessions.currentSessionId, 'user', _parsed.payload.content);
        NaiSidebar.refreshSessionList();
      }
    } catch(e) {}
    return _origWsSend.call(this, data);
  };

  // ── Sidebar initialization ────────────────────────────────────────
  NaiSessions.init();
  var sidebarTries = 0;
  var sidebarTimer = setInterval(function() {
    sidebarTries++;
    if (NaiSidebar.setup() || sidebarTries > 50) clearInterval(sidebarTimer);
  }, 200);
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

  if (req.url === "/api/pairing-code") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: pairingCode }));
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

  if (req.url === "/api/describe-image" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 15 * 1024 * 1024) { req.destroy(); return; }
    });
    req.on("end", async () => {
      try {
        const { image } = JSON.parse(body);
        const result = await describeImageWithOllama(image);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  if (req.url === "/api/models" && req.method === "GET") {
    try {
      const activeModel = readDefaultModel();
      let ollamaModels = [];
      try {
        const tagResp = await fetch("http://127.0.0.1:11434/api/tags");
        const data = await tagResp.json();
        ollamaModels = (data.models || []).map(m => ({
          name: "ollama/" + m.name,
          size: m.size,
          provider: "ollama"
        }));
      } catch {}

      // Cloud models from config providers
      const cloudModels = [];
      try {
        const raw = require("fs").readFileSync(NULLCLAW_CONFIG, "utf-8");
        const cfg = JSON.parse(raw);
        const providers = (cfg.models && cfg.models.providers) || {};
        if (providers.xai && providers.xai.api_key) {
          cloudModels.push({ name: "xai/grok-4-1-fast-non-reasoning", provider: "xai", label: "Grok 4.1 Fast" });
          cloudModels.push({ name: "xai/grok-4-1-fast-reasoning", provider: "xai", label: "Grok 4.1 Fast Reasoning" });
        }
        if (providers.anthropic && providers.anthropic.api_key) {
          cloudModels.push({ name: "anthropic/claude-sonnet-4-6", provider: "anthropic", label: "Claude Sonnet 4.6" });
          cloudModels.push({ name: "anthropic/claude-haiku-4-5", provider: "anthropic", label: "Claude Haiku 4.5" });
        }
        if (providers.gemini && providers.gemini.api_key) {
          cloudModels.push({ name: "gemini/gemini-2.5-pro", provider: "gemini", label: "Gemini 2.5 Pro" });
          cloudModels.push({ name: "gemini/gemini-2.5-flash", provider: "gemini", label: "Gemini 2.5 Flash" });
        }
      } catch {}

      const allModels = [...cloudModels, ...ollamaModels];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models: allModels, activeModel }));
    } catch (err) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models: [], activeModel: readDefaultModel(), error: err.message }));
    }
    return;
  }

  // ── Config API (read/update nullclaw config.json) ────────────────
  if (req.url === "/api/config" && req.method === "GET") {
    try {
      const raw = require("fs").readFileSync(NULLCLAW_CONFIG, "utf-8");
      const cfg = JSON.parse(raw);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, config: cfg }));
    } catch (err) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (req.url === "/api/config" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; if (body.length > 1024 * 1024) req.destroy(); });
    req.on("end", async () => {
      try {
        const { path: keyPath, value } = JSON.parse(body);
        if (!keyPath || typeof keyPath !== "string") throw new Error("Missing 'path'");
        const raw = require("fs").readFileSync(NULLCLAW_CONFIG, "utf-8");
        const cfg = JSON.parse(raw);
        // Navigate to nested key (e.g. "autonomy.workspace_only")
        const parts = keyPath.split(".");
        let obj = cfg;
        for (let i = 0; i < parts.length - 1; i++) {
          if (obj[parts[i]] === undefined) obj[parts[i]] = {};
          obj = obj[parts[i]];
        }
        obj[parts[parts.length - 1]] = value;
        require("fs").writeFileSync(NULLCLAW_CONFIG, JSON.stringify(cfg, null, 2) + "\n");
        console.log(`[config] Updated ${keyPath} = ${JSON.stringify(value)}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, updated: keyPath, value }));
      } catch (err) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  if (req.url === "/api/reset-sessions" && req.method === "POST") {
    console.log("[api] Reset all local agent sessions requested");
    let count = 0;
    for (const [sid] of agentSessions) {
      killAgentSession(sid);
      count++;
    }
    agentSessions.clear();
    activeAgents.clear();
    sessions.clear();
    console.log(`[api] Killed ${count} local agent session(s). New sessions will use updated config.`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, message: `Reset ${count} session(s). Re-pair to start fresh.` }));
    return;
  }

  if (req.url === "/api/gateway/restart" && req.method === "POST") {
    console.log("[api] Gateway restart requested");
    try {
      const { execSync } = require("child_process");
      // Only kill gateway processes, not agent sessions
      execSync('powershell -Command "Get-CimInstance Win32_Process -Filter \\\"CommandLine LIKE \'%nullclaw%gateway%\'\\\" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"');
      setTimeout(() => {
        const { spawn: sp } = require("child_process");
        const gw = sp(NULLCLAW_EXE, ["gateway"], { detached: true, stdio: "ignore", windowsHide: true });
        gw.unref();
        console.log("[api] Gateway restarted");
      }, 2000);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, message: "Gateway restarting..." }));
    } catch (err) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
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
      html = html.replace("</body>", INJECTED_SCRIPT + "\n</body>");
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
  console.log(`  Pairing: auto (dynamic code)`);
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
