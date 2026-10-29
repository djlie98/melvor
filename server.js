// Melvor Idle self-host server (plain Node + Express).
//
//  - Talks to the Steam client on this machine through steamworks.js (Valve's steam_api64.dll), so ownership of
//    the base game and DLCs is checked against Steam the same way the desktop app does.
//  - Reverse-proxies https://steam.melvoridle.com (the page the desktop app loads in its iframe) onto this origin
//    and injects bridge.js, which stands in for the NW.js parent window the game expects.
//  - Requires a password, since whoever reaches this server plays as your Steam account.
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const zlib = require("zlib");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const express = require("express");

const CONFIG_PATH = path.join(__dirname, "config.json");
const LOG_PATH = path.join(__dirname, "selfhost.log");

const BASE_APP_ID = 1267910;
const DLC_APP_IDS = {
  2055140: "Throne of the Herald",
  2492940: "Atlas of Discovery",
  2860590: "Into the Abyss",
};
const SESSION_COOKIE = "melvor_selfhost";
const SESSION_MAX_AGE_S = 60 * 60 * 24 * 30;

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_PATH, line + "\n");
  } catch (e) {}
}

// ---------------------------------------------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------------------------------------------

function loadConfig() {
  const defaults = {
    host: "0.0.0.0",
    port: 8787,
    password: "",
    sessionSecret: "",
    upstream: "https://steam.melvoridle.com",
    tls: { cert: "", key: "" },
    trustProxy: false,
  };
  const exists = fs.existsSync(CONFIG_PATH);
  const cfg = Object.assign(
    {},
    defaults,
    exists ? JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) : {},
  );
  // Drop keys left over from the NW.js/greenworks version.
  delete cfg.gameDir;
  let changed = !exists;
  if (!cfg.password) {
    cfg.password = crypto.randomBytes(12).toString("base64url");
    changed = true;
    log(`No password configured; generated one and saved it to ${CONFIG_PATH}`);
  }
  if (!cfg.sessionSecret) {
    cfg.sessionSecret = crypto.randomBytes(32).toString("hex");
    changed = true;
  }
  if (changed) fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  return cfg;
}

const config = loadConfig();
const UPSTREAM = new URL(config.upstream);

// ---------------------------------------------------------------------------------------------------------------
// Steam (steamworks.js)
// ---------------------------------------------------------------------------------------------------------------

let steam = null;
let steamError = "Steam has not been initialized yet.";

let lastInitAttempt = 0;

/** Lazily (re)connects to Steam, so the server can start before Steam does. Retries at most every 5s. */
function tryInitSteam() {
  if (steam) return true;
  if (Date.now() - lastInitAttempt < 5000) return false;
  lastInitAttempt = Date.now();
  try {
    steam = require("steamworks.js").init(BASE_APP_ID);
  } catch (e) {
    steamError = `Steam init failed: ${e.message}. Is Steam running and signed in to an account that owns Melvor Idle?`;
    log(steamError);
    return false;
  }
  steamError = "";
  log(
    `Steam initialized as ${steam.localplayer.getName()} (${steam.localplayer.getSteamId().steamId64})`,
  );
  for (const [appId, name] of Object.entries(
    Object.assign({ [BASE_APP_ID]: "Melvor Idle" }, DLC_APP_IDS),
  ))
    log(
      `  ${name} (${appId}): ${steam.apps.isSubscribedApp(Number(appId)) ? "owned" : "NOT owned"}`,
    );
  return true;
}

function safe(fn, fallback) {
  try {
    return fn();
  } catch (e) {
    return fallback;
  }
}

/** Fresh snapshot handed to bridge.js. Ownership is asked of Steam on every page load. */
function steamState() {
  const owned = { [BASE_APP_ID]: steam.apps.isSubscribedApp(BASE_APP_ID) };
  for (const id of Object.keys(DLC_APP_IDS))
    owned[id] = steam.apps.isSubscribedApp(Number(id));
  const sid = steam.localplayer.getSteamId();
  return {
    appId: BASE_APP_ID,
    steamId: {
      steamId: String(sid.steamId64),
      accountId: sid.accountId,
      screenName: steam.localplayer.getName(),
    },
    owned,
    cloudEnabled: safe(() => steam.cloud.isEnabledForApp(), false),
    cloudEnabledForUser: safe(() => steam.cloud.isEnabledForAccount(), false),
  };
}

function ownsBaseGame() {
  return tryInitSteam() && steam.apps.isSubscribedApp(BASE_APP_ID);
}

/** The game only ever uses savegame_<key>.txt; don't let the API touch anything else in Steam Cloud. */
function validCloudFile(f) {
  return typeof f === "string" && /^savegame_[A-Za-z0-9_-]{1,64}\.txt$/.test(f);
}

const steamApi = {
  achievement: (b) => {
    if (typeof b.name !== "string" || !/^[A-Z0-9_]{1,64}$/.test(b.name))
      return { ok: false, error: "bad name" };
    return { ok: steam.achievement.activate(b.name) };
  },
  richpresence: (b) => {
    if (typeof b.key !== "string" || typeof b.value !== "string")
      return { ok: false, error: "bad args" };
    steam.localplayer.setRichPresence(
      b.key.slice(0, 64),
      b.value.slice(0, 256),
    );
    return { ok: true };
  },
  // Used by the game to link this Steam account to Melvor Cloud (PlayFab).
  ticket: async () => {
    const t = await steam.auth.getSessionTicket();
    return { ok: true, hex: t.getBytes().toString("hex") };
  },
  "cloud/write": (b) => {
    if (!validCloudFile(b.file) || typeof b.text !== "string")
      return { ok: false, error: "bad args" };
    return { ok: steam.cloud.writeFile(b.file, b.text) };
  },
  "cloud/read": (b) => {
    if (!validCloudFile(b.file)) return { ok: false, error: "bad args" };
    return { ok: true, text: steam.cloud.readFile(b.file) };
  },
  "cloud/delete": (b) => {
    if (!validCloudFile(b.file)) return { ok: false, error: "bad args" };
    return { ok: steam.cloud.deleteFile(b.file) };
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------------------------------------------

function sign(value) {
  return crypto
    .createHmac("sha256", config.sessionSecret)
    .update(value)
    .digest("base64url");
}

function makeSession() {
  const exp = String(Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_S);
  return `${exp}.${sign(exp)}`;
}

function validSession(token) {
  if (!token) return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig) return false;
  const expected = sign(exp);
  if (
    sig.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  )
    return false;
  return Number(exp) > Date.now() / 1000;
}

function parseCookies(header) {
  const out = {};
  for (const part of (header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function passwordMatches(given) {
  const a = crypto.createHash("sha256").update(String(given)).digest();
  const b = crypto.createHash("sha256").update(config.password).digest();
  return crypto.timingSafeEqual(a, b);
}

const loginFailures = new Map(); // ip -> { count, until }

// ---------------------------------------------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#1b1d22;color:#e6e6e6;font:16px system-ui,sans-serif}
main{width:min(360px,calc(100vw - 32px))}h1{font-size:20px}input,button{box-sizing:border-box;width:100%;padding:10px;margin-top:8px;font:inherit;border-radius:6px;border:1px solid #444}
input{background:#111;color:#eee}button{background:#5c8ae6;color:#fff;border:0;cursor:pointer}.err{color:#ff8a80}
</style></head><body><main>${body}</main></body></html>`;
}

function loginPage(error) {
  return page(
    "Melvor Idle – sign in",
    `<h1>Melvor Idle (self-hosted)</h1>
<form method="post" action="/__selfhost/login"><input type="password" name="password" placeholder="Password" autofocus required>
<button type="submit">Sign in</button></form>${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}`,
  );
}

function steamErrorPage() {
  const reason = steam
    ? "The Steam account on the server does not own Melvor Idle."
    : steamError;
  return page(
    "Melvor Idle – ownership check failed",
    `<h1>Ownership check failed</h1><p>${escapeHtml(reason)}</p><p>Start Steam on the server, sign in to the account that owns the game, then reload.</p>`,
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Upstream proxy
// ---------------------------------------------------------------------------------------------------------------

const BRIDGE_SRC = fs.readFileSync(path.join(__dirname, "bridge.js"), "utf8");

// The game gates achievement sync on being served from steam.melvoridle.com; we serve it from our own origin.
const ORIGIN_CHECK =
  /location\.origin\s*===?\s*(['"])https:\/\/steam\.melvoridle\.com\1/g;

// On desktop the asset loader reads images from the NW.js package via require('fs') and chrome.runtime.id, neither
// of which exists in a browser. Make it load from Melvor's CDN, exactly as the browser version of the game does.
const FILE_REWRITES = {
  "/assets/js/built/assets.js": (text) =>
    text.replace(/nativeManager\.isDesktop/g, "false"),
};

function rewriteJs(pathname, text) {
  text = text.replace(ORIGIN_CHECK, "true");
  const extra = FILE_REWRITES[pathname];
  return extra ? extra(text) : text;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);
const DROPPED_RESPONSE_HEADERS = new Set([
  "content-security-policy",
  "content-security-policy-report-only",
  "strict-transport-security",
  "alt-svc",
  "report-to",
  "nel",
]);

function rewriteKind(pathname, contentType) {
  if (/text\/html/i.test(contentType)) return "html";
  if (
    /^\/assets\/js\/built\//.test(pathname) &&
    /javascript/i.test(contentType)
  )
    return "js";
  return null;
}

function decode(buf, encoding) {
  switch ((encoding || "").toLowerCase()) {
    case "gzip":
    case "x-gzip":
      return zlib.gunzipSync(buf);
    case "deflate":
      return zlib.inflateSync(buf);
    case "br":
      return zlib.brotliDecompressSync(buf);
    default:
      return buf;
  }
}

function injectBridge(html) {
  const state = JSON.stringify(steamState()).replace(/</g, "\\u003c");
  const script = `<script>${BRIDGE_SRC.replace("var S = __SELFHOST_STATE__;", () => `var S = ${state};`)}</script>`;
  const m = /<head[^>]*>/i.exec(html);
  return m
    ? html.slice(0, m.index + m[0].length) +
        script +
        html.slice(m.index + m[0].length)
    : script + html;
}

function rewriteSetCookie(value, secure) {
  let parts = value.split(";").map((p) => p.trim());
  parts = parts.filter((p) => !/^domain=/i.test(p));
  if (!secure)
    parts = parts
      .filter((p) => !/^secure$/i.test(p))
      .map((p) => (/^samesite=none$/i.test(p) ? "SameSite=Lax" : p));
  return parts.join("; ");
}

function proxy(req, res, next) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (
      HOP_BY_HOP.has(k) ||
      k.startsWith("x-forwarded-") ||
      k === "cf-connecting-ip"
    )
      continue;
    headers[k] = v;
  }
  headers.host = UPSTREAM.host;
  headers["accept-encoding"] = "gzip, deflate, br";
  if (headers.origin) headers.origin = UPSTREAM.origin;
  if (headers.referer)
    headers.referer = headers.referer.replace(
      /^https?:\/\/[^/]+/,
      UPSTREAM.origin,
    );
  const cookies = parseCookies(req.headers.cookie);
  delete cookies[SESSION_COOKIE];
  const cookieStr = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  if (cookieStr) headers.cookie = cookieStr;
  else delete headers.cookie;

  const upReq = https.request(
    {
      hostname: UPSTREAM.hostname,
      port: UPSTREAM.port || 443,
      method: req.method,
      path: req.originalUrl,
      headers,
    },
    (upRes) => {
      const outHeaders = {};
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (HOP_BY_HOP.has(k) || DROPPED_RESPONSE_HEADERS.has(k)) continue;
        outHeaders[k] = v;
      }
      if (outHeaders.location)
        outHeaders.location = String(outHeaders.location).replace(
          UPSTREAM.origin,
          "",
        );
      if (outHeaders["set-cookie"])
        outHeaders["set-cookie"] = []
          .concat(outHeaders["set-cookie"])
          .map((c) => rewriteSetCookie(c, req.secure));

      const kind = rewriteKind(req.path, upRes.headers["content-type"] || "");
      if (!kind) {
        res.writeHead(upRes.statusCode, outHeaders);
        upRes.pipe(res);
        return;
      }
      const chunks = [];
      upRes.on("data", (c) => chunks.push(c));
      upRes.on("error", next);
      upRes.on("end", () => {
        try {
          let text = decode(
            Buffer.concat(chunks),
            upRes.headers["content-encoding"],
          ).toString("utf8");
          text = kind === "js" ? rewriteJs(req.path, text) : injectBridge(text);
          delete outHeaders["content-encoding"];
          delete outHeaders["content-length"];
          delete outHeaders.etag;
          delete outHeaders["last-modified"];
          delete outHeaders.expires;
          // Rewritten files change with this server's code, so never let the browser keep a stale copy.
          outHeaders["cache-control"] = "no-store";
          res.writeHead(upRes.statusCode, outHeaders);
          res.end(text);
        } catch (e) {
          next(e);
        }
      });
    },
  );
  upReq.on("error", next);
  req.pipe(upReq);
}

// ---------------------------------------------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------------------------------------------

const app = express();
app.disable("x-powered-by");
if (config.trustProxy) app.set("trust proxy", true);

app.use((req, res, next) => {
  res.set("cache-control", "no-store");
  next();
});

app.get("/__selfhost/login", (req, res) => res.type("html").send(loginPage()));

app.post(
  "/__selfhost/login",
  express.urlencoded({ extended: false, limit: "4kb" }),
  (req, res) => {
    const ip = req.ip;
    const f = loginFailures.get(ip);
    if (f && f.until > Date.now())
      return res
        .status(429)
        .type("html")
        .send(loginPage("Too many attempts. Try again in a minute."));
    if (!passwordMatches((req.body && req.body.password) || "")) {
      const count = (f ? f.count : 0) + 1;
      loginFailures.set(ip, {
        count,
        until: count >= 5 ? Date.now() + 60000 : 0,
      });
      log(`failed login from ${ip}`);
      return res.status(401).type("html").send(loginPage("Wrong password."));
    }
    loginFailures.delete(ip);
    res.cookie(SESSION_COOKIE, makeSession(), {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: req.secure,
      maxAge: SESSION_MAX_AGE_S * 1000,
    });
    res.redirect(303, "/");
  },
);

app.get("/__selfhost/logout", (req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.redirect(303, "/__selfhost/login");
});

app.use((req, res, next) => {
  if (validSession(parseCookies(req.headers.cookie)[SESSION_COOKIE]))
    return next();
  if (req.method === "GET" && req.accepts("html"))
    return res.redirect(303, "/__selfhost/login");
  res.status(401).type("text").send("unauthorized");
});

app.get("/__selfhost/status", (req, res) => {
  const status = { steamInitialized: tryInitSteam(), steamError };
  if (steam) status.state = steamState();
  res.json(status);
});

// Only the game page on this origin may call the Steam API (blocks cross-site POSTs riding the cookie).
app.post(
  "/__selfhost/api/*path",
  (req, res, next) => {
    const origin = req.get("origin");
    if (origin && origin !== `${req.protocol}://${req.get("host")}`)
      return res.status(403).json({ ok: false, error: "bad origin" });
    if (!ownsBaseGame())
      return res.status(403).json({ ok: false, error: "not owned" });
    next();
  },
  express.json({ limit: "8mb" }),
  async (req, res, next) => {
    const fn = steamApi[[].concat(req.params.path).join("/")];
    if (!fn) return res.status(404).json({ ok: false, error: "unknown" });
    try {
      res.json(await fn(req.body || {}));
    } catch (e) {
      res.json({ ok: false, error: String((e && e.message) || e) });
    }
  },
);

// Ownership gate: nothing from the game is served unless Steam says this account owns it.
app.use((req, res, next) => {
  if (ownsBaseGame()) return next();
  res.status(403).type("html").send(steamErrorPage());
});

app.use(proxy);

app.use((err, req, res, next) => {
  log("error:", String((err && err.stack) || err));
  if (res.headersSent) return res.destroy();
  res
    .status(502)
    .type("html")
    .send(
      page(
        "Upstream error",
        `<h1>Could not reach ${escapeHtml(UPSTREAM.host)}</h1>`,
      ),
    );
});

// ---------------------------------------------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------------------------------------------

tryInitSteam();

const server =
  config.tls && config.tls.cert && config.tls.key
    ? https.createServer(
        {
          cert: fs.readFileSync(path.resolve(__dirname, config.tls.cert)),
          key: fs.readFileSync(path.resolve(__dirname, config.tls.key)),
        },
        app,
      )
    : http.createServer(app);

server.listen(config.port, config.host, () => {
  const scheme = server instanceof https.Server ? "https" : "http";
  log(
    `Melvor self-host listening on ${scheme}://${config.host}:${config.port} (upstream ${UPSTREAM.origin})`,
  );
});
