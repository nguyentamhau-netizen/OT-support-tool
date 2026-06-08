import { createServer } from "node:http";
import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";

loadEnvFile(".env.local");

const port = Number(process.env.PORT || 4173);
const root = join(process.cwd(), "public");
const spreadsheetId = process.env.GOOGLE_SHEETS_DB_ID || "1ts9sj3cdT_Z3BMrtHo2_R5H35gxPmRlnztXxLkM8fog";
const apiMode = process.env.GOOGLE_SHEETS_API_MODE || "service_account";

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

const tableSchemas = {
  settings: ["key", "value", "description", "updated_at"],
  users: ["user_id", "email", "username", "display_name", "role", "status", "source", "created_at", "updated_at"],
  schedule_slots: ["slot_id", "date", "month", "day_of_week", "slot_type", "title", "status", "created_by", "created_at", "updated_at", "note"],
  slot_capacities: ["capacity_id", "slot_id", "role_name", "required_count", "hours_per_person", "man_month_factor", "created_at", "updated_at", "note"],
  registrations: ["registration_id", "slot_id", "capacity_id", "user_email", "registered_by_email", "status", "approved_status", "source", "created_at", "updated_at", "note"],
  holiday_settings: ["holiday_id", "date", "name", "holiday_type", "required_role", "required_count", "hours_per_person", "man_month_factor", "note", "created_by", "created_at", "updated_at"],
  update_requests: ["request_id", "user_email", "target_registration_id", "target_date", "requested_hours", "reason", "evidence_url", "status", "admin_note", "reviewed_by", "created_at", "reviewed_at"],
  audit_logs: ["log_id", "actor_email", "action", "entity_type", "entity_id", "before_json", "after_json", "created_at"],
  export_jobs: ["export_id", "month", "status", "file_url", "created_by", "created_at", "note"],
  chat_notifications: ["notification_id", "slot_id", "message", "scheduled_for", "sent_at", "status", "response", "created_at"]
};

const stateKeys = {
  settings: "settings",
  users: "users",
  schedule_slots: "scheduleSlots",
  slot_capacities: "capacities",
  registrations: "registrations",
  holiday_settings: "holidaySettings",
  update_requests: "updateRequests",
  audit_logs: "auditLogs",
  export_jobs: "exportJobs",
  chat_notifications: "chatNotifications"
};

let tokenCache = null;

function loadEnvFile(fileName) {
  const filePath = join(process.cwd(), fileName);
  if (!existsSync(filePath)) return;

  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function resolvePath(urlPath) {
  const cleanPath = urlPath.split("?")[0] === "/" ? "/index.html" : urlPath.split("?")[0];
  const decoded = decodeURIComponent(cleanPath);
  const resolved = normalize(join(root, decoded));
  if (!resolved.startsWith(root)) return join(root, "index.html");
  return resolved;
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function getServiceAccount() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8"));
  }

  const localPath = join(process.cwd(), "service-account.json");
  if (existsSync(localPath)) {
    return JSON.parse(readFileSync(localPath, "utf8"));
  }

  throw new Error("Missing Google service account credentials. Create .env.local from .env.local.example.");
}

async function getAccessToken() {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.accessToken;

  const account = getServiceAccount();
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const privateKey = account.private_key.replaceAll("\\n", "\n");
  const signature = signer.sign(privateKey, "base64url");
  const assertion = `${unsigned}.${signature}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });

  if (!response.ok) {
    throw new Error(`Google OAuth failed: ${response.status} ${await response.text()}`);
  }

  const token = await response.json();
  tokenCache = {
    accessToken: token.access_token,
    expiresAt: Date.now() + token.expires_in * 1000
  };
  return tokenCache.accessToken;
}

async function sheetsRequest(path, options = {}) {
  const accessToken = await getAccessToken();
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    throw new Error(`Google Sheets API failed: ${response.status} ${await response.text()}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

function snakeToCamel(value) {
  return value.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

function normalizeScalar(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  const text = String(value);
  if (text !== "" && !Number.isNaN(Number(text)) && /^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return text;
}

function rowsToObjects(values = []) {
  if (!values.length) return [];
  const headers = values[0].map(snakeToCamel);
  return values.slice(1).filter((row) => row.some((cell) => cell !== "")).map((row) => {
    const object = {};
    headers.forEach((header, index) => {
      object[header] = row[index] ?? "";
    });
    return object;
  });
}

function objectsToRows(tableName, rows = []) {
  const headers = tableSchemas[tableName];
  return [
    headers,
    ...rows.map((row) => headers.map((header) => normalizeScalar(row[snakeToCamel(header)])))
  ];
}

async function loadSheetsState() {
  if (apiMode === "apps_script") return loadAppsScriptState();

  const ranges = Object.keys(tableSchemas).map((name) => `${name}!A1:Z5000`);
  const params = new URLSearchParams();
  ranges.forEach((range) => params.append("ranges", range));
  params.set("majorDimension", "ROWS");
  const data = await sheetsRequest(`/values:batchGet?${params.toString()}`);

  const state = {};
  for (const tableName of Object.keys(tableSchemas)) {
    state[stateKeys[tableName]] = [];
  }

  for (const valueRange of data.valueRanges || []) {
    const tableName = valueRange.range.split("!")[0].replaceAll("'", "");
    if (!tableSchemas[tableName]) continue;
    state[stateKeys[tableName]] = rowsToObjects(valueRange.values || []);
  }

  return {
    ...state,
    db: {
      spreadsheetId,
      url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`
    }
  };
}

async function saveSheetsState(nextState) {
  if (apiMode === "apps_script") return saveAppsScriptState(nextState);

  const tableNames = Object.keys(tableSchemas);
  await sheetsRequest("/values:batchClear", {
    method: "POST",
    body: JSON.stringify({
      ranges: tableNames.map((name) => `${name}!A1:Z5000`)
    })
  });

  await sheetsRequest("/values:batchUpdate", {
    method: "POST",
    body: JSON.stringify({
      valueInputOption: "USER_ENTERED",
      data: tableNames.map((name) => ({
        range: `${name}!A1`,
        majorDimension: "ROWS",
        values: objectsToRows(name, nextState[stateKeys[name]] || [])
      }))
    })
  });

  return loadSheetsState();
}

function getAppsScriptConfig() {
  if (!process.env.APPS_SCRIPT_URL) throw new Error("Missing APPS_SCRIPT_URL.");
  if (!process.env.APPS_SCRIPT_TOKEN) throw new Error("Missing APPS_SCRIPT_TOKEN.");
  return {
    url: process.env.APPS_SCRIPT_URL,
    token: process.env.APPS_SCRIPT_TOKEN
  };
}

async function callAppsScript(method, body) {
  const config = getAppsScriptConfig();
  const separator = config.url.includes("?") ? "&" : "?";
  const url = `${config.url}${separator}token=${encodeURIComponent(config.token)}`;
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  if (text.trimStart().startsWith("<")) {
    throw new Error("Apps Script returned HTML instead of JSON. Deploy the Web App with access set to Anyone, then use the /exec URL. Testing while logged into Google can hide this issue.");
  }
  const payload = JSON.parse(text);
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `Apps Script API failed: ${response.status}`);
  }
  return payload.state;
}

async function loadAppsScriptState() {
  return callAppsScript("GET");
}

async function saveAppsScriptState(nextState) {
  return callAppsScript("POST", { state: nextState });
}

async function handleApi(req, res, url) {
  try {
    if (req.method === "GET" && url.pathname === "/api/state") {
      sendJson(res, 200, { ok: true, state: await loadSheetsState() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/state") {
      const body = await readJson(req);
      sendJson(res, 200, { ok: true, state: await saveSheetsState(body.state || {}) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, { ok: true, spreadsheetId });
      return;
    }

    sendJson(res, 404, { ok: false, error: "API route not found." });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: error.message
    });
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) {
    await handleApi(req, res, url);
    return;
  }

  try {
    const filePath = resolvePath(req.url || "/");
    const file = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": contentTypes[extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(file);
  } catch {
    const file = await readFile(join(root, "index.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(file);
  }
}).listen(port, () => {
  console.log(`OT Support Tool local app: http://localhost:${port}`);
  console.log(`Google Sheets API mode: ${apiMode}`);
  console.log(`Google Sheets DB: https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`);
});
