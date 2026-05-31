const http = require("http");
const fs = require("fs");
const path = require("path");

const host = process.env.UWMK_HARNESS_HOST || "127.0.0.1";
const port = Number(process.env.UWMK_HARNESS_PORT || 18777);
const logDir =
  process.env.UWMK_HARNESS_LOG_DIR || path.join(__dirname, "..", "logs", "object-query");

fs.mkdirSync(logDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const logFile = path.join(logDir, `${stamp}.jsonl`);
const latestFile = path.join(logDir, "latest.jsonl");

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    send(res, 204, {});
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    send(res, 200, { ok: true, logFile });
    return;
  }

  if (req.method === "POST" && req.url === "/log") {
    try {
      const raw = await readBody(req);
      const event = raw ? JSON.parse(raw) : {};
      const row = {
        receivedAt: new Date().toISOString(),
        ...event,
      };
      const line = JSON.stringify(row) + "\n";
      fs.appendFileSync(logFile, line);
      fs.appendFileSync(latestFile, line);
      console.log(`[${row.level || "info"}] ${row.stage || "event"} ${row.message || ""}`);
      if (row.data !== undefined) console.dir(row.data, { depth: 5 });
      send(res, 200, { ok: true });
    } catch (err) {
      send(res, 400, {
        ok: false,
        error: err && err.message ? err.message : String(err),
      });
    }
    return;
  }

  send(res, 404, { ok: false, error: "not found" });
});

server.listen(port, host, () => {
  console.log(`UnityWebModkit object-query harness listening on http://${host}:${port}`);
  console.log(`Writing logs to ${logFile}`);
});
