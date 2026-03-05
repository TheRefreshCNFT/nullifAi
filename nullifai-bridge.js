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
<script>
(function() {
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
    return _origWsSend.call(this, data);
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
