#!/usr/bin/env node
/**
 * E2E support servers, bundled in one process so Playwright can manage them
 * as a single webServer entry (readiness = the HTTP port answers).
 *
 *   HTTP :3101  /            widget host page — embeds the real widget script
 *                       for ?key=… against the app origin (?app=http://localhost:3000)
 *              /healthz     readiness probe
 *              /_smtp       captured outbound emails (JSON)
 *              /_smtp/reset empties the capture
 *   HTTP :3102  /            same host page on a second port — cookies and
 *                       storage partition keys ignore ports, so this is how
 *                       the "fresh port" session-stickiness case is tested
 *                       (issue #61)
 *   SMTP :1025  minimal catch server the app sends to via SMTP_URL
 */
import http from "node:http";
import net from "node:net";

const HTTP_PORT = Number(process.env.E2E_SUPPORT_PORT || 3101);
const HTTP_PORT_ALT = HTTP_PORT + 1;
const SMTP_PORT = Number(process.env.E2E_SMTP_PORT || 1025);

const messages = [];

const HOST_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>E2E host page</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; }
  h1 { font-size: 1.25rem; }
</style>
</head>
<body>
<h1>Customer site (E2E host page)</h1>
<p id="marker">host-page-marker</p>
<script>
(function () {
  var params = new URLSearchParams(window.location.search);
  var app = params.get("app") || "http://localhost:3000";
  var key = params.get("key");
  if (!key) return;
  if (params.get("identify") === "1") {
    // Mirrors a real integration pushing identify(): the
    // loader picks up the pre-existing queue.
    window.SupportSealWidget = window.SupportSealWidget || { q: [] };
    SupportSealWidget.q.push(["identify", {
      userId: "e2e-user-42",
      email: "identified@e2e.test",
      name: "Identified Visitor"
    }]);
  }
  var s = document.createElement("script");
  s.async = true;
  s.src = app + "/widget.js";
  s.dataset.key = key;
  document.body.appendChild(s);
})();
</script>
</body>
</html>`;

/**
 * Diagnostics host page (?diag=1): plants canary secrets in every banned
 * location (DX-04) and exposes __triggerDiag() which fires one event of each
 * capture kind (DX-03). The widget loads against ?app= like HOST_PAGE.
 */
const DIAG_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>E2E diagnostics host page</title>
</head>
<body>
<h1>Customer site (diagnostics)</h1>
<p id="marker">diag-page-marker</p>
<input type="password" id="pw" value="CANARY_PASSWORD" aria-label="Password">
<script>
  document.cookie = "ss_canary=CANARY_COOKIE; path=/";
  try {
    localStorage.setItem("canary", "CANARY_STORAGE");
    sessionStorage.setItem("canary", "CANARY_SESSION");
  } catch (e) {}
</script>
<script>
  window.__triggerDiag = function () {
    console.log("secret log CANARY_LOG");
    console.warn("SupportSeal diag warn 4f2a");
    console.error("SupportSeal diag console error 9b1c");
    fetch("/_diag/fail", {
      method: "POST",
      headers: { Authorization: "Bearer CANARY_AUTH" },
      body: JSON.stringify({ secret: "CANARY_BODY" })
    }).then(function (r) { window.__fetchStatus = r.status; }, function () { window.__fetchStatus = 0; });
    fetch("http://127.0.0.1:9/unreachable").catch(function () { window.__unreachableFailed = true; });
    var xhr = new XMLHttpRequest();
    xhr.open("POST", "/_diag/fail");
    xhr.onloadend = function () { window.__xhrStatus = xhr.status; };
    xhr.send(JSON.stringify({ secret: "CANARY_BODY" }));
    setTimeout(function () {
      window.__threw = true;
      throw new Error("<img src=x onerror=window.__diagXss=1> CANARY_THROW");
    }, 0);
    Promise.reject(new Error("diag rejection 77e5 password=CANARY_BODY"));
  };
  (function () {
    var params = new URLSearchParams(window.location.search);
    var app = params.get("app") || "http://localhost:3000";
    var key = params.get("key");
    if (!key) return;
    var s = document.createElement("script");
    s.async = true;
    s.src = app + "/widget.js";
    s.dataset.key = key;
    document.body.appendChild(s);
  })();
</script>
</body>
</html>`;

const handler = (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${HTTP_PORT}`);
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  if (url.pathname === "/_diag/fail") {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("server error");
    return;
  }
  if (url.pathname === "/_smtp" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ messages }));
    return;
  }
  if (url.pathname === "/_smtp/reset" && req.method === "POST") {
    messages.length = 0;
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
    return;
  }
  if (url.pathname === "/" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(url.searchParams.get("diag") === "1" ? DIAG_PAGE : HOST_PAGE);
    return;
  }
  res.writeHead(404);
  res.end("not found");
};

const httpServers = [
  http.createServer(handler).listen(HTTP_PORT, "127.0.0.1"),
  http.createServer(handler).listen(HTTP_PORT_ALT, "127.0.0.1"),
];

/** Minimal SMTP receiver: EHLO/MAIL/RCPT/DATA/QUIT, no auth, no TLS. */
const smtp = net.createServer((socket) => {
  let buffer = "";
  let from = "";
  let recipients = [];
  let inData = false;

  const reply = (line) => socket.write(line + "\r\n");
  reply("220 e2e-smtp ready");

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    if (!inData) {
      let index = buffer.indexOf("\r\n");
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (line.toUpperCase() === "DATA") {
          inData = true;
          reply("354 End data with <CR><LF>.<CR><LF>");
          break;
        }
        handleCommand(line);
        index = buffer.indexOf("\r\n");
      }
    }
    if (inData) {
      const endIdx = buffer.indexOf("\r\n.\r\n");
      if (endIdx === -1) return;
      const data = buffer.slice(0, endIdx + 2);
      buffer = buffer.slice(endIdx + 5);
      inData = false;
      messages.push(parseMessage(from, recipients, data));
      if (messages.length > 100) messages.shift();
      from = "";
      recipients = [];
      reply("250 OK");
    }
  });

  function handleCommand(line) {
    const upper = line.toUpperCase();
    if (upper.startsWith("EHLO") || upper.startsWith("HELO")) {
      reply("250-e2e-smtp");
      reply("250 8BITMIME");
    } else if (upper.startsWith("MAIL FROM:")) {
      from = line.slice(10).trim().replace(/^<|>$/gu, "");
      reply("250 OK");
    } else if (upper.startsWith("RCPT TO:")) {
      recipients.push(line.slice(8).trim().replace(/^<|>$/gu, ""));
      reply("250 OK");
    } else if (upper === "QUIT") {
      reply("221 Bye");
      socket.end();
    } else if (upper === "RSET") {
      from = "";
      recipients = [];
      reply("250 OK");
    } else {
      reply("250 OK");
    }
  }

  socket.on("error", () => {});
});

function parseMessage(from, recipients, raw) {
  const separator = raw.indexOf("\r\n\r\n");
  const headerBlock = separator === -1 ? raw : raw.slice(0, separator);
  let body = separator === -1 ? "" : raw.slice(separator + 4);
  const headers = {};
  let lastKey = null;
  for (const line of headerBlock.split("\r\n")) {
    if (/^[ \t]/u.test(line) && lastKey) {
      headers[lastKey] += " " + line.trim();
      continue;
    }
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    lastKey = line.slice(0, colon).trim().toLowerCase();
    headers[lastKey] = line.slice(colon + 1).trim();
  }
  const encoding = (headers["content-transfer-encoding"] || "").trim().toLowerCase();
  if (encoding === "base64") {
    try {
      body = Buffer.from(body.replace(/\s/gu, ""), "base64").toString("utf8");
    } catch {}
  } else if (encoding === "quoted-printable") {
    body = body
      .replace(/=\r?\n/gu, "")
      .replace(/=([0-9A-Fa-f]{2})/gu, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    try {
      body = decodeURIComponent(escape(body));
    } catch {}
  }
  return {
    from,
    to: recipients,
    headers,
    subject: headers["subject"] || "",
    replyTo: headers["reply-to"] || "",
    messageId: headers["message-id"] || "",
    inReplyTo: headers["in-reply-to"] || "",
    references: headers["references"] || "",
    body,
    capturedAt: new Date().toISOString(),
  };
}

smtp.listen(SMTP_PORT, "127.0.0.1");

function shutdown() {
  for (const s of httpServers) s.close();
  smtp.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
