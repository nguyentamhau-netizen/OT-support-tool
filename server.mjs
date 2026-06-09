import { createServer } from "node:http";
import { createSign, createHmac } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";

loadEnvFile(".env.local");

const port = Number(process.env.PORT || 4173);
const root = join(process.cwd(), "public");
const apiUrl = process.env.TAIGA_API_URL || "https://projects.kyanon.digital/api/v1";
const projectSlug = process.env.TAIGA_PROJECT_SLUG || "amaze-ot-log";
let cachedAdminToken = process.env.TAIGA_ADMIN_TOKEN || null;
const JWT_SECRET = process.env.JWT_SECRET || "supersecretjwtkeyforotsupporttool2026";
const DB_DIR = join(process.cwd(), "db_cache");

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
  schedule_slots: ["slot_id", "date", "month", "day_of_week", "slot_type", "title", "status", "created_by", "created_at", "updated_at", "note", "taiga_issue_id"],
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

let customAttrMap = {};
let projectId = null;

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

// JWT helpers
function signToken(payload) {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const data = base64url(JSON.stringify(payload));
  const signature = createHmac("sha256", JWT_SECRET)
    .update(`${header}.${data}`)
    .digest("base64url");
  return `${header}.${data}.${signature}`;
}

function verifyToken(token) {
  try {
    const [header, data, signature] = token.split(".");
    const expectedSignature = createHmac("sha256", JWT_SECRET)
      .update(`${header}.${data}`)
      .digest("base64url");
    if (signature !== expectedSignature) return null;
    return JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}
function parseCookies(cookieHeader) {
  const list = {};
  if (!cookieHeader) return list;
  cookieHeader.split(";").forEach(cookie => {
    const parts = cookie.split("=");
    const name = parts.shift().trim();
    const value = parts.join("=").trim();
    if (name) list[name] = value;
  });
  return list;
}

// CSV helpers
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

function serializeCSV(headers, rows) {
  const csvHeaders = headers.join(",");
  const csvRows = rows.map(row =>
    headers.map(header => {
      const cell = normalizeScalar(row[snakeToCamel(header)] ?? "");
      return `"${String(cell).replace(/"/g, '""')}"`;
    }).join(",")
  );
  return [csvHeaders, ...csvRows].join("\n");
}

function parseCSV(csvText) {
  const lines = csvText.split(/\r?\n/).filter(line => line.trim() !== "");
  if (lines.length === 0) return [];
  const headers = lines[0].split(",").map(h => h.replace(/^"|"$/g, "").trim()).map(snakeToCamel);
  return lines.slice(1).map(line => {
    const cells = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        cells.push(current);
        current = "";
      } else {
        current += char;
      }
    }
    cells.push(current);

    const obj = {};
    headers.forEach((header, index) => {
      let value = cells[index] ?? "";
      if (value !== "" && !Number.isNaN(Number(value)) && /^-?\d+(\.\d+)?$/.test(value)) {
        value = Number(value);
      }
      obj[header] = value;
    });
    return obj;
  });
}

async function ensureDbDir() {
  if (!existsSync(DB_DIR)) {
    await mkdir(DB_DIR, { recursive: true });
  }
}

async function writeCSVTable(tableName, rows) {
  await ensureDbDir();
  const headers = tableSchemas[tableName];
  const csvText = serializeCSV(headers, rows);
  await writeFile(join(DB_DIR, `${tableName}.csv`), csvText, "utf8");
}

async function readCSVTable(tableName) {
  const filePath = join(DB_DIR, `${tableName}.csv`);
  if (!existsSync(filePath)) return [];
  const csvText = await readFile(filePath, "utf8");
  return parseCSV(csvText);
}

// Google Chat Alert Helpers
async function getSettingValue(key, defaultValue = "") {
  try {
    const settings = await readCSVTable("settings");
    const found = settings.find(s => s.key === key);
    return found ? found.value : defaultValue;
  } catch {
    return defaultValue;
  }
}

async function getGoogleChatWebhookUrl() {
  const dbUrl = await getSettingValue("google_chat_webhook_url");
  if (dbUrl) return dbUrl;
  return process.env.GOOGLE_CHAT_WEBHOOK_URL || "";
}

async function sendGoogleChatMessage(text) {
  const url = await getGoogleChatWebhookUrl();
  if (!url) {
    console.log("Google Chat webhook URL not configured. Message suppressed:", text);
    return false;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ text })
    });
    if (!res.ok) {
      console.error(`Failed to send Google Chat message: ${res.status} ${await res.text()}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("Error sending Google Chat message:", err.message);
    return false;
  }
}

function formatDisplayDate(dateStr) {
  const parts = dateStr.split("-");
  if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
  return dateStr;
}

async function sendUpcomingReminders(targetDateStr) {
  const localState = await loadLocalState();
  const slots = (localState.scheduleSlots || []).filter(s => s.date === targetDateStr);
  if (!slots.length) return { sentCount: 0, openCount: 0 };

  let sentCount = 0;
  let openCount = 0;
  
  localState.chatNotifications = localState.chatNotifications || [];

  for (const slot of slots) {
    const regs = (localState.registrations || []).filter(r => r.slotId === slot.slotId && r.status === "ACTIVE");
    
    // Check if a SENT notification already exists for this slot
    const alreadySent = localState.chatNotifications.some(n => n.slotId === slot.slotId && n.status === "SENT");
    if (alreadySent) continue;

    const dateDisplay = formatDisplayDate(slot.date);
    let msgText = "";
    if (regs.length > 0) {
      const assignees = regs.map(r => {
        const u = (localState.users || []).find(user => user.email.toLowerCase() === r.userEmail.toLowerCase());
        return u ? `*${u.displayName}* (${r.userEmail})` : `*${r.userEmail}*`;
      }).join(", ");
      msgText = `📅 *NHẮC LỊCH TRỰC HÔM NAY/NGÀY MAI (${dateDisplay})*\n📌 Ca trực: *${slot.title}*\n👤 Người trực: ${assignees}\n⏰ Giờ quy định: *8h*\n⚠️ Vui lòng hoàn thành nhiệm vụ hỗ trợ dự án Amaze.`;
      sentCount++;
    } else {
      msgText = `⚠️ *CẢNH BÁO CA TRỰC CHƯA CÓ NGƯỜI ĐĂNG KÝ (${dateDisplay})*\n📌 Ca trực: *${slot.title}* đang *OPEN*.\n👉 Các PO/QC vui lòng đăng ký ngay để hỗ trợ dự án Amaze.`;
      openCount++;
    }

    const success = await sendGoogleChatMessage(msgText);
    
    const notificationId = `notif_${slot.slotId}_${Date.now()}`;
    localState.chatNotifications.push({
      notificationId,
      slotId: slot.slotId,
      message: msgText,
      scheduledFor: slot.date,
      sentAt: success ? new Date().toISOString() : "",
      status: success ? "SENT" : "FAILED",
      response: success ? "SUCCESS" : "ERROR",
      createdAt: new Date().toISOString()
    });
  }

  if (sentCount > 0 || openCount > 0) {
    await saveLocalState(localState);
  }

  return { sentCount, openCount };
}

async function sendWeekendReminders(saturdayStr, sundayStr) {
  const localState = await loadLocalState();
  const satSlots = (localState.scheduleSlots || []).filter(s => s.date === saturdayStr);
  const sunSlots = (localState.scheduleSlots || []).filter(s => s.date === sundayStr);

  const satDisplay = formatDisplayDate(saturdayStr);
  const sunDisplay = formatDisplayDate(sundayStr);

  let msgText = `📅 *THÔNG BÁO LỊCH TRỰC CUỐI TUẦN (${satDisplay} - ${sunDisplay})*\n\n`;

  // 1. Process Saturday Slots
  msgText += `*Thứ 7 (${satDisplay}):*\n`;
  const uniqueSatTitles = [...new Set(satSlots.map(s => s.title))];
  if (uniqueSatTitles.length === 0) {
    msgText += `_Không có ca trực nào được cấu hình._\n`;
  } else {
    for (const title of uniqueSatTitles) {
      const matchingSlots = satSlots.filter(s => s.title === title);
      const slotIds = matchingSlots.map(s => s.slotId);
      const regs = (localState.registrations || []).filter(r => slotIds.includes(r.slotId) && r.status === "ACTIVE");
      if (regs.length > 0) {
        const assignees = regs.map(r => `<users/${r.userEmail}>`).join(", ");
        msgText += `- Ca *${title}*: ${assignees}\n`;
      } else {
        msgText += `- Ca *${title}*: ⚠️ Chưa có người trực\n`;
      }
    }
  }

  msgText += `\n`;

  // 2. Process Sunday Slots
  msgText += `*Chủ Nhật (${sunDisplay}):*\n`;
  const uniqueSunTitles = [...new Set(sunSlots.map(s => s.title))];
  if (uniqueSunTitles.length === 0) {
    msgText += `_Không có ca trực nào được cấu hình._\n`;
  } else {
    for (const title of uniqueSunTitles) {
      const matchingSlots = sunSlots.filter(s => s.title === title);
      const slotIds = matchingSlots.map(s => s.slotId);
      const regs = (localState.registrations || []).filter(r => slotIds.includes(r.slotId) && r.status === "ACTIVE");
      if (regs.length > 0) {
        const assignees = regs.map(r => `<users/${r.userEmail}>`).join(", ");
        msgText += `- Ca *${title}*: ${assignees}\n`;
      } else {
        msgText += `- Ca *${title}*: ⚠️ Chưa có người trực\n`;
      }
    }
  }

  msgText += `\n👉 Các thành viên vui lòng kiểm tra và hoàn thành nhiệm vụ hỗ trợ dự án Amaze.`;

  const success = await sendGoogleChatMessage(msgText);

  // Log notifications for Saturday and Sunday slots
  localState.chatNotifications = localState.chatNotifications || [];
  const logNotification = (slotId, date) => {
    const notificationId = `notif_${slotId}_${Date.now()}`;
    localState.chatNotifications.push({
      notificationId,
      slotId,
      message: msgText,
      scheduledFor: date,
      sentAt: success ? new Date().toISOString() : "",
      status: success ? "SENT" : "FAILED",
      response: success ? "SUCCESS" : "ERROR",
      createdAt: new Date().toISOString()
    });
  };

  satSlots.forEach(s => logNotification(s.slotId, saturdayStr));
  sunSlots.forEach(s => logNotification(s.slotId, sundayStr));

  if (satSlots.length > 0 || sunSlots.length > 0) {
    await saveLocalState(localState);
  }

  return { ok: success, satCount: satSlots.length, sunCount: sunSlots.length };
}

async function checkAndSendReminders(now) {
  const dayOfWeek = now.getDay(); // 0 is Sunday, 5 is Friday, 6 is Saturday
  
  if (dayOfWeek === 5) {
    // It's Friday. Check Saturday (tomorrow) and Sunday (day after tomorrow)
    const satDate = new Date(now);
    satDate.setDate(now.getDate() + 1);
    const sunDate = new Date(now);
    sunDate.setDate(now.getDate() + 2);

    const satStr = dateKeyString(satDate);
    const sunStr = dateKeyString(sunDate);

    console.log(`[BACKGROUND-JOB] Friday weekend check: Saturday (${satStr}) and Sunday (${sunStr})`);
    return await sendWeekendReminders(satStr, sunStr);
  } else {
    // Normal weekday or weekend check. Check tomorrow.
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    const tomorrowStr = dateKeyString(tomorrow);

    console.log(`[BACKGROUND-JOB] Standard check for tomorrow: ${tomorrowStr}`);
    return await sendUpcomingReminders(tomorrowStr);
  }
}

function dateKeyString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Taiga API helpers
async function getAdminToken(forceRefresh = false) {
  if (cachedAdminToken && !forceRefresh) {
    return cachedAdminToken;
  }

  const username = process.env.TAIGA_USERNAME;
  const password = process.env.TAIGA_PASSWORD;

  if (!username || !password) {
    return process.env.TAIGA_ADMIN_TOKEN || "";
  }

  try {
    console.log("[TAIGA-AUTH] Requesting new token using credentials...");
    const authRes = await fetch(`${apiUrl}/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "normal", username, password })
    });

    if (!authRes.ok) {
      throw new Error(`Authentication failed: ${authRes.status} ${await authRes.text()}`);
    }

    const userData = await authRes.json();
    if (userData.auth_token) {
      cachedAdminToken = userData.auth_token;
      console.log("[TAIGA-AUTH] New token acquired successfully.");
      return cachedAdminToken;
    } else {
      throw new Error("No auth_token returned from Taiga auth endpoint.");
    }
  } catch (err) {
    console.error("[TAIGA-AUTH] Failed to login to Taiga:", err.message);
    return process.env.TAIGA_ADMIN_TOKEN || "";
  }
}

async function taigaFetch(path, options = {}, isRetry = false) {
  const token = await getAdminToken();
  const response = await fetch(`${apiUrl}${path}`, {
    ...options,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  if (response.status === 401 && !isRetry) {
    console.log("[TAIGA-AUTH] Received 401 from Taiga. Retrying with refreshed token...");
    await getAdminToken(true);
    return taigaFetch(path, options, true);
  }

  if (!response.ok) {
    throw new Error(`Taiga API failed: ${response.status} ${await response.text()}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

async function initTaigaConfig() {
  const token = await getAdminToken();
  if (!token) return;
  try {
    const project = await taigaFetch(`/projects/by_slug?slug=${projectSlug}`);
    projectId = project.id;

    try {
      const attrs = await taigaFetch(`/issue-custom-attributes?project=${projectId}`);
      attrs.forEach(attr => {
        customAttrMap[attr.name.toLowerCase()] = attr.id;
      });
    } catch (err) {
      console.warn("Could not load custom attributes:", err.message);
    }
  } catch (err) {
    console.error("Taiga connection error during startup:", err.message);
  }
}

async function syncUsersFromTaiga() {
  const memberships = await taigaFetch(`/memberships?project=${projectId}`);
  
  // Read existing local users to merge those added via admin app
  const localUsers = await readCSVTable("users");
  const localAdminAppUsers = localUsers.filter(u => u.source === "admin_app");

  const taigaUsers = memberships
    .filter(m => m.user_email || m.email)
    .map(m => {
      const email = (m.user_email || m.email).toLowerCase();
      const isUserAdmin = m.is_admin || m.role_name === "Owner" || m.role_name === "Admin" || email === "hau.nt@kyanon.digital";
      const username = email.split("@")[0];
      return {
        userId: `usr_${username.replace(/\./g, "_")}`,
        email: email,
        username: username,
        displayName: m.full_name || username,
        role: isUserAdmin ? "ADMIN" : "MEMBER",
        status: "ACTIVE",
        source: "taiga",
        createdAt: m.created_at || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
    });

  // Merge: keep all taiga users, and add local admin app users that are not already present in taiga users list
  const mergedUsers = [...taigaUsers];
  localAdminAppUsers.forEach(lu => {
    if (!mergedUsers.some(tu => tu.email.toLowerCase() === lu.email.toLowerCase())) {
      mergedUsers.push(lu);
    }
  });

  await writeCSVTable("users", mergedUsers);
  return mergedUsers;
}

async function syncFromTaiga() {
  await ensureDbDir();
  if (!projectId) {
    await initTaigaConfig();
  }

  const users = await syncUsersFromTaiga();
  const taigaUserIdToEmail = {};
  const memberships = await taigaFetch(`/memberships?project=${projectId}`);
  memberships.forEach(m => {
    const email = m.user_email || m.email;
    if (m.user && email) {
      taigaUserIdToEmail[m.user] = email.toLowerCase();
    }
  });

  const issues = await taigaFetch(`/issues?project=${projectId}&page_size=100`);

  const scheduleSlots = [];
  const capacities = [];
  const registrations = [];
  const holidaySettings = [];
  const updateRequests = [];
  const auditLogs = [];

  for (const issue of issues) {
    const slotMatch = issue.subject.match(/^\[OT-SLOT\]\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(.*)/i);
    if (!slotMatch) continue;

    const date = slotMatch[1];
    const title = slotMatch[2];
    const slotId = `slot_${date.replace(/-/g, "_")}`;
    const [year, monthIndex] = date.split("-").map(Number);
    const month = `${year}-${String(monthIndex).padStart(2, "0")}`;
    const slotDate = new Date(year, monthIndex - 1, Number(date.split("-")[2]));
    const dayOfWeek = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][slotDate.getDay()];

    let slotType = "WEEKEND";
    let hours = 8;
    let manMonthFactor = 1;

    try {
      const attrVals = await taigaFetch(`/issues/custom-attributes-values/${issue.id}`);
      const vals = attrVals.attributes_values || {};
      const slotTypeAttrId = customAttrMap["slot_type"];
      const hoursAttrId = customAttrMap["hours"];
      const factorAttrId = customAttrMap["man_month_factor"];

      if (vals[slotTypeAttrId]) slotType = vals[slotTypeAttrId];
      if (vals[hoursAttrId]) hours = Number(vals[hoursAttrId]) || 8;
      if (vals[factorAttrId]) manMonthFactor = Number(vals[factorAttrId]) || 1;
    } catch {
      // Attributes might not be loaded or set yet
    }

    scheduleSlots.push({
      slotId,
      date,
      month,
      dayOfWeek,
      slotType,
      title,
      status: issue.assigned_to ? "FULL" : "OPEN",
      createdBy: "taiga",
      createdAt: issue.created_date,
      updatedAt: issue.modified_date,
      note: issue.description || "",
      taigaIssueId: issue.id
    });

    const capacityId = `cap_${date.replace(/-/g, "_")}_qc_po`;
    capacities.push({
      capacityId,
      slotId,
      roleName: "QC/PO",
      requiredCount: 1,
      hoursPerPerson: hours,
      manMonthFactor,
      createdAt: issue.created_date,
      updatedAt: issue.modified_date,
      note: ""
    });

    if (slotType === "HOLIDAY" || slotType === "TET") {
      holidaySettings.push({
        holidayId: `hol_${date.replace(/-/g, "_")}`,
        date,
        name: title,
        holidayType: slotType,
        requiredRole: "QC/PO",
        requiredCount: 1,
        hoursPerPerson: hours,
        manMonthFactor,
        note: issue.description || "",
        createdBy: "taiga",
        createdAt: issue.created_date,
        updatedAt: issue.modified_date
      });
    }

    if (issue.assigned_to) {
      const userEmail = taigaUserIdToEmail[issue.assigned_to] || "";
      if (userEmail) {
        const username = userEmail.split("@")[0];
        registrations.push({
          registrationId: `reg_${issue.id}_${username.replace(/\./g, "_")}`,
          slotId,
          capacityId,
          userEmail,
          registeredByEmail: userEmail,
          status: "ACTIVE",
          approvedStatus: "AUTO_APPROVED",
          source: "self_registration",
          createdAt: issue.created_date,
          updatedAt: issue.modified_date,
          note: ""
        });
      }
    }

    try {
      const history = await taigaFetch(`/history/issue/${issue.id}`);
      for (const entry of history) {
        if (!entry.comment) continue;
        const commentText = entry.comment;

        if (commentText.includes("[UPDATE-REQUEST]")) {
          let requestedHours = 8;
          let reason = "";
          let evidenceUrl = "";

          const lines = commentText.split("\n");
          lines.forEach(line => {
            if (line.toLowerCase().startsWith("hours:")) {
              requestedHours = Number(line.split(":")[1].trim()) || 8;
            } else if (line.toLowerCase().startsWith("reason:")) {
              reason = line.split(":")[1].trim();
            } else if (line.toLowerCase().startsWith("evidence:")) {
              evidenceUrl = line.split(":")[1].trim();
            }
          });

          let status = "PENDING";
          let reviewedBy = "";
          let reviewedAt = "";

          for (const subEntry of history) {
            if (!subEntry.comment) continue;
            if (new Date(subEntry.created_date) <= new Date(entry.created_date)) continue;

            if (subEntry.comment.includes("[UPDATE-APPROVED]")) {
              status = "APPROVED";
              reviewedBy = subEntry.user.username;
              reviewedAt = subEntry.created_date;
            } else if (subEntry.comment.includes("[UPDATE-REJECTED]")) {
              status = "REJECTED";
              reviewedBy = subEntry.user.username;
              reviewedAt = subEntry.created_date;
            }
          }

          const requesterEmail = taigaUserIdToEmail[entry.user.id] || "";
          updateRequests.push({
            requestId: `req_${entry.id}`,
            userEmail: requesterEmail,
            targetRegistrationId: `reg_${issue.id}_${requesterEmail.split("@")[0].replace(/\./g, "_")}`,
            targetDate: date,
            requestedHours,
            reason,
            evidenceUrl,
            status,
            adminNote: "",
            reviewedBy,
            createdAt: entry.created_date,
            reviewedAt
          });
        }

        auditLogs.push({
          logId: `log_${entry.id}`,
          actorEmail: taigaUserIdToEmail[entry.user.id] || "system",
          action: commentText.includes("[UPDATE-APPROVED]") ? "UPDATE_REQUEST_APPROVED" :
                  commentText.includes("[UPDATE-REJECTED]") ? "UPDATE_REQUEST_REJECTED" :
                  commentText.includes("[UPDATE-REQUEST]") ? "UPDATE_REQUEST_CREATE" : "COMMENT_ADD",
          entityType: "issue",
          entityId: String(issue.id),
          beforeJson: "",
          afterJson: JSON.stringify({ comment: commentText }),
          createdAt: entry.created_date
        });
      }
    } catch {
      // History fetching might fail for new items
    }
  }

  await writeCSVTable("schedule_slots", scheduleSlots);
  await writeCSVTable("slot_capacities", capacities);
  await writeCSVTable("registrations", registrations);
  await writeCSVTable("holiday_settings", holidaySettings);
  await writeCSVTable("update_requests", updateRequests);
  await writeCSVTable("audit_logs", auditLogs);

  const settings = await readCSVTable("settings");
  if (settings.length === 0) {
    const defaultSettings = [
      { key: "company_domain", value: "kyanon.digital", description: "Company Domain Restriction", updated_at: new Date().toISOString() },
      { key: "admin_email", value: "hau.nt@kyanon.digital", description: "Admin Email Account", updated_at: new Date().toISOString() },
      { key: "default_weekend_role", value: "QC/PO", description: "Default Role Name", updated_at: new Date().toISOString() },
      { key: "default_day_hours", value: "8", description: "Default Hours Per Day", updated_at: new Date().toISOString() }
    ];
    await writeCSVTable("settings", defaultSettings);
  }
}

async function loadLocalState() {
  const state = {};
  for (const tableName of Object.keys(tableSchemas)) {
    state[stateKeys[tableName]] = await readCSVTable(tableName);
  }
  return state;
}

async function saveLocalState(state) {
  for (const tableName of Object.keys(tableSchemas)) {
    if (state[stateKeys[tableName]]) {
      await writeCSVTable(tableName, state[stateKeys[tableName]]);
    }
  }
}

async function handleExcelExport(req, res, url) {
  const month = url.searchParams.get("month");
  if (!month) {
    return sendJson(res, 400, { ok: false, error: "Missing month parameter." });
  }

  try {
    const { default: ExcelJS } = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    const templatePath = join(process.cwd(), "templates", "AMAZE _ Time log - Overtime - 2026.xlsx");
    await workbook.xlsx.readFile(templatePath);

    const worksheet = workbook.getWorksheet("Apr-May2026") || workbook.worksheets[0];
    const localState = await loadLocalState();

    const activeRegistrations = localState.registrations.filter(reg => {
      const slot = localState.scheduleSlots.find(s => s.slotId === reg.slotId);
      return reg.status === "ACTIVE" && slot && slot.month === month;
    });

    let startRow = 10;
    activeRegistrations.forEach((reg, index) => {
      const slot = localState.scheduleSlots.find(s => s.slotId === reg.slotId);
      const capacity = localState.capacities.find(c => c.capacityId === reg.capacityId);
      const user = localState.users.find(u => u.email.toLowerCase() === reg.userEmail.toLowerCase());
      
      const row = worksheet.getRow(startRow + index);
      row.getCell('A').value = index + 1;
      row.getCell('B').value = user ? user.displayName : reg.userEmail;
      row.getCell('C').value = slot.date;
      row.getCell('D').value = slot.dayOfWeek;
      row.getCell('E').value = slot.title;
      row.getCell('F').value = capacity ? capacity.hoursPerPerson : 8;
      row.getCell('G').value = "Support SOS Amaze project";
      row.commit();
    });

    res.writeHead(200, {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="AMAZE_OT_Report_${month}.xlsx"`,
      "Cache-Control": "no-store"
    });

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    sendJson(res, 500, { ok: false, error: "Failed to export Excel: " + error.message });
  }
}

async function handleApi(req, res, url) {
  try {
    if (req.method === "POST" && url.pathname === "/api/auth/login") {
      const { username, password } = await readJson(req);
      const authRes = await fetch(`${apiUrl}/auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "normal", username, password })
      });

      if (!authRes.ok) {
        return sendJson(res, 401, { ok: false, error: "Invalid username or password." });
      }

      const userData = await authRes.json();
      const email = userData.email.toLowerCase();

      if (!email.endsWith("@kyanon.digital")) {
        return sendJson(res, 403, { ok: false, error: "Only @kyanon.digital accounts are permitted." });
      }

      const isUserAdmin = email === "hau.nt@kyanon.digital";
      const token = signToken({
        email,
        username: userData.username,
        displayName: userData.full_name,
        role: isUserAdmin ? "ADMIN" : "MEMBER"
      });

      res.writeHead(200, {
        "Set-Cookie": `session_token=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000`,
        "Content-Type": "application/json"
      });
      return res.end(JSON.stringify({ ok: true, user: { email, displayName: userData.full_name, role: isUserAdmin ? "ADMIN" : "MEMBER" } }));
    }

    if (req.method === "POST" && url.pathname === "/api/auth/logout") {
      res.writeHead(200, {
        "Set-Cookie": "session_token=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0",
        "Content-Type": "application/json"
      });
      return res.end(JSON.stringify({ ok: true }));
    }

    // Verify session for state APIs
    const cookies = parseCookies(req.headers.cookie);
    const session = cookies.session_token ? verifyToken(cookies.session_token) : null;

    if (req.method === "GET" && url.pathname === "/api/state") {
      const forceSync = url.searchParams.get("sync") === "true";
      if (forceSync || !existsSync(join(DB_DIR, "schedule_slots.csv"))) {
        await syncFromTaiga();
      }
      sendJson(res, 200, { ok: true, state: await loadLocalState() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/state") {
      if (!session) {
        return sendJson(res, 401, { ok: false, error: "Unauthorized session." });
      }
      const body = await readJson(req);
      const incomingState = body.state || {};
      const localState = await loadLocalState();

      let memberships = await taigaFetch(`/memberships?project=${projectId}`);
      if (incomingState.users) {
        let membershipAdded = false;
        for (const u of incomingState.users) {
          const existsLocally = localState.users.some(existing => existing.email.toLowerCase() === u.email.toLowerCase());
          if (!existsLocally && u.source === "admin_app") {
            try {
              const roleId = u.role === "ADMIN" ? 2884 : 2886;
              await taigaFetch("/memberships", {
                method: "POST",
                body: JSON.stringify({
                  project: projectId,
                  role: roleId,
                  email: u.email,
                  username: u.username
                })
              });
              console.log(`Successfully added user ${u.email} to Taiga project memberships.`);
              u.source = "taiga";
              membershipAdded = true;
            } catch (err) {
              console.warn(`Failed to add user ${u.email} to Taiga memberships (keeping local user cache):`, err.message);
            }
          }
        }
        if (membershipAdded) {
          memberships = await taigaFetch(`/memberships?project=${projectId}`);
        }
      }

      const emailToTaigaUserId = {};
      memberships.forEach(m => {
        if (m.user && m.email) {
          emailToTaigaUserId[m.email.toLowerCase()] = m.user;
        }
      });

      // 1. Check for new registrations
      for (const reg of incomingState.registrations || []) {
        const isNew = !localState.registrations.some(r => r.registrationId === reg.registrationId);
        if (isNew && reg.status === "ACTIVE") {
          const slot = incomingState.scheduleSlots.find(s => s.slotId === reg.slotId);
          if (slot) {
            let taigaIssueId = slot.taigaIssueId;
            if (!taigaIssueId) {
              const existingLocalSlot = localState.scheduleSlots.find(s => s.date === slot.date && s.taigaIssueId);
              if (existingLocalSlot) {
                taigaIssueId = existingLocalSlot.taigaIssueId;
                slot.taigaIssueId = taigaIssueId;
              }
            }

            if (!taigaIssueId) {
              // Create the issue on Taiga (e.g. for auto-generated weekend slots)
              const createdIssue = await taigaFetch("/issues", {
                method: "POST",
                body: JSON.stringify({
                  project: projectId,
                  subject: `[OT-SLOT] ${slot.date} | ${slot.title}`,
                  description: slot.note || "Auto-generated weekend slot",
                  assigned_to: emailToTaigaUserId[reg.userEmail.toLowerCase()] || null
                })
              });
              taigaIssueId = createdIssue.id;
              slot.taigaIssueId = taigaIssueId;
              
              // Set custom attributes
              const slotTypeAttrId = customAttrMap["slot_type"];
              const hoursAttrId = customAttrMap["hours"];
              const factorAttrId = customAttrMap["man_month_factor"];
              
              const capacity = incomingState.capacities.find(c => c.slotId === slot.slotId);
              
              await taigaFetch(`/issues/custom-attributes-values/${taigaIssueId}`, {
                method: "PATCH",
                body: JSON.stringify({
                  version: createdIssue.version || 1,
                  attributes_values: {
                    [slotTypeAttrId]: slot.slotType,
                    [hoursAttrId]: String(capacity ? capacity.hoursPerPerson : 8),
                    [factorAttrId]: String(capacity ? capacity.manMonthFactor : 1)
                  }
                })
              });
            } else {
              // Update assignee for existing issue
              let existingIssue = null;
              try {
                existingIssue = await taigaFetch(`/issues/${taigaIssueId}`);
              } catch (err) {
                if (err.message.includes("404")) {
                  taigaIssueId = null;
                  slot.taigaIssueId = "";
                } else {
                  throw err;
                }
              }

              if (!taigaIssueId) {
                const createdIssue = await taigaFetch("/issues", {
                  method: "POST",
                  body: JSON.stringify({
                    project: projectId,
                    subject: `[OT-SLOT] ${slot.date} | ${slot.title}`,
                    description: slot.note || "Auto-generated weekend slot",
                    assigned_to: emailToTaigaUserId[reg.userEmail.toLowerCase()] || null
                  })
                });
                taigaIssueId = createdIssue.id;
                slot.taigaIssueId = taigaIssueId;

                const slotTypeAttrId = customAttrMap["slot_type"];
                const hoursAttrId = customAttrMap["hours"];
                const factorAttrId = customAttrMap["man_month_factor"];
                const capacity = incomingState.capacities.find(c => c.slotId === slot.slotId);

                await taigaFetch(`/issues/custom-attributes-values/${taigaIssueId}`, {
                  method: "PATCH",
                  body: JSON.stringify({
                    version: createdIssue.version || 1,
                    attributes_values: {
                      [slotTypeAttrId]: slot.slotType,
                      [hoursAttrId]: String(capacity ? capacity.hoursPerPerson : 8),
                      [factorAttrId]: String(capacity ? capacity.manMonthFactor : 1)
                    }
                  })
                });
              } else {
                await taigaFetch(`/issues/${taigaIssueId}`, {
                  method: "PATCH",
                  body: JSON.stringify({
                    version: existingIssue.version,
                    assigned_to: emailToTaigaUserId[reg.userEmail.toLowerCase()] || null
                  })
                });
              }
            }
            
            // Add comment
            if (taigaIssueId) {
              await taigaFetch(`/issues/${taigaIssueId}/upd`, {
                method: "POST",
                body: JSON.stringify({
                  comment: `[REGISTRATION] Registered by ${reg.userEmail}`
                })
              });
            }

            // Send Google Chat Alert! (disabled to avoid spam)
            // const dateStr = formatDisplayDate(slot.date);
            // sendGoogleChatMessage(`🔔 *Đăng ký trực mới*\n👤 Thành viên: *${reg.userEmail}*\n📅 Ngày trực: *${dateStr}*\n📝 Ca trực: *${slot.title}*`);
          }
        }
      }

      // 2. Check for cancelled registrations
      for (const reg of incomingState.registrations || []) {
        const oldReg = localState.registrations.find(r => r.registrationId === reg.registrationId);
        if (oldReg && oldReg.status === "ACTIVE" && reg.status === "CANCELLED") {
          const slot = incomingState.scheduleSlots.find(s => s.slotId === reg.slotId);
          if (slot && slot.taigaIssueId) {
            let existingIssue = null;
            try {
              existingIssue = await taigaFetch(`/issues/${slot.taigaIssueId}`);
            } catch (err) {
              if (err.message.includes("404")) {
                slot.taigaIssueId = "";
              } else {
                throw err;
              }
            }

            if (existingIssue) {
              await taigaFetch(`/issues/${slot.taigaIssueId}`, {
                method: "PATCH",
                body: JSON.stringify({
                  version: existingIssue.version,
                  assigned_to: null
                })
              });
              await taigaFetch(`/issues/${slot.taigaIssueId}/upd`, {
                method: "POST",
                body: JSON.stringify({
                  comment: `[REGISTRATION] Cancelled by ${session.email}`
                })
              });
            }

            // Send Google Chat Alert! (disabled to avoid spam)
            // const dateStr = formatDisplayDate(slot.date);
            // sendGoogleChatMessage(`⚠️ *Hủy đăng ký trực*\n👤 Thành viên: *${oldReg.userEmail}*\n📅 Ngày trực: *${dateStr}*\n📝 Ca trực: *${slot.title}*`);
          }
        }
      }

      // 3. Check for new holiday settings (which translates to new slots)
      for (const holiday of incomingState.holidaySettings || []) {
        const isNew = !localState.holidaySettings.some(h => h.holidayId === holiday.holidayId);
        if (isNew) {
          const createdIssue = await taigaFetch("/issues", {
            method: "POST",
            body: JSON.stringify({
              project: projectId,
              subject: `[OT-SLOT] ${holiday.date} | ${holiday.name}`,
              description: holiday.note || "Holiday slot"
            })
          });
          
          const slotTypeAttrId = customAttrMap["slot_type"];
          const hoursAttrId = customAttrMap["hours"];
          const factorAttrId = customAttrMap["man_month_factor"];

          await taigaFetch(`/issues/custom-attributes-values/${createdIssue.id}`, {
            method: "PATCH",
            body: JSON.stringify({
              version: createdIssue.version || 1,
              attributes_values: {
                [slotTypeAttrId]: holiday.holidayType,
                [hoursAttrId]: String(holiday.hoursPerPerson || 8),
                [factorAttrId]: String(holiday.manMonthFactor || 1)
              }
            })
          });
          
          const slot = incomingState.scheduleSlots.find(s => s.date === holiday.date);
          if (slot) slot.taigaIssueId = createdIssue.id;
        }
      }

      // 4. Check for update requests (submitted as comments)
      for (const reqObj of incomingState.updateRequests || []) {
        const oldReq = localState.updateRequests.find(r => r.requestId === reqObj.requestId);
        
        // New Update Request
        if (!oldReq) {
          const slot = incomingState.scheduleSlots.find(s => s.date === reqObj.targetDate);
          if (slot && slot.taigaIssueId) {
            try {
              await taigaFetch(`/issues/${slot.taigaIssueId}/upd`, {
                method: "POST",
                body: JSON.stringify({
                  comment: `[UPDATE-REQUEST]\nHours: ${reqObj.requestedHours}\nReason: ${reqObj.reason}\nEvidence: ${reqObj.evidenceUrl || ""}\nStatus: PENDING`
                })
              });
            } catch (err) {
              if (err.message.includes("404")) {
                slot.taigaIssueId = "";
              } else {
                throw err;
              }
            }

            // Send Google Chat Alert!
            const dateStr = formatDisplayDate(reqObj.targetDate);
            sendGoogleChatMessage(`📝 *Yêu cầu cập nhật giờ trực mới*\n👤 Thành viên: *${reqObj.userEmail}*\n📅 Ngày trực: *${dateStr}*\n⏰ Giờ thực tế: *${reqObj.requestedHours}h*\n💬 Lý do: ${reqObj.reason}`);
          }
        }
        
        // Admin reviewed request
        if (oldReq && oldReq.status === "PENDING" && reqObj.status !== "PENDING") {
          const slot = incomingState.scheduleSlots.find(s => s.date === reqObj.targetDate);
          if (slot && slot.taigaIssueId) {
            let customAttrs = null;
            try {
              customAttrs = await taigaFetch(`/issues/custom-attributes-values/${slot.taigaIssueId}`);
            } catch (err) {
              if (err.message.includes("404")) {
                slot.taigaIssueId = "";
              } else {
                throw err;
              }
            }

            if (customAttrs) {
              if (reqObj.status === "APPROVED") {
                const hoursAttrId = customAttrMap["hours"];
                await taigaFetch(`/issues/custom-attributes-values/${slot.taigaIssueId}`, {
                  method: "PATCH",
                  body: JSON.stringify({
                    version: customAttrs.version,
                    attributes_values: {
                      [hoursAttrId]: String(reqObj.requestedHours)
                    }
                  })
                });
                await taigaFetch(`/issues/${slot.taigaIssueId}/upd`, {
                  method: "POST",
                  body: JSON.stringify({
                    comment: `[UPDATE-APPROVED] Approved by ${session.username}`
                  })
                });
              } else {
                await taigaFetch(`/issues/${slot.taigaIssueId}/upd`, {
                  method: "POST",
                  body: JSON.stringify({
                    comment: `[UPDATE-REJECTED] Rejected by ${session.username}`
                  })
                });
              }
            }

            // Send Google Chat Alert!
            const dateStr = formatDisplayDate(reqObj.targetDate);
            const statusText = reqObj.status === "APPROVED" ? "✅ Đã phê duyệt" : "❌ Từ chối";
            sendGoogleChatMessage(`🔔 *Kết quả duyệt yêu cầu cập nhật giờ*\n👤 Thành viên: *${reqObj.userEmail}*\n📅 Ngày trực: *${dateStr}*\n⏰ Giờ: *${reqObj.requestedHours}h*\n📋 Trạng thái: *${statusText}*\n👤 Người duyệt: *${session.email}*`);
          }
        }
      }

      await saveLocalState(incomingState);
      sendJson(res, 200, { ok: true, state: await loadLocalState() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/export") {
      await handleExcelExport(req, res, url);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/settings") {
      if (!session || session.role !== "ADMIN") {
        return sendJson(res, 401, { ok: false, error: "Unauthorized." });
      }
      const settings = await readCSVTable("settings");
      sendJson(res, 200, { ok: true, settings });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/settings") {
      if (!session || session.role !== "ADMIN") {
        return sendJson(res, 401, { ok: false, error: "Unauthorized." });
      }
      const { key, value } = await readJson(req);
      const settings = await readCSVTable("settings");
      const found = settings.find(s => s.key === key);
      if (found) {
        found.value = value;
        found.updated_at = new Date().toISOString();
      } else {
        settings.push({
          key,
          value,
          description: "Configured setting",
          updated_at: new Date().toISOString()
        });
      }
      await writeCSVTable("settings", settings);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/chat/test") {
      if (!session || session.role !== "ADMIN") {
        return sendJson(res, 401, { ok: false, error: "Unauthorized." });
      }
      const success = await sendGoogleChatMessage("🔔 *Kiểm tra kết nối Google Chat*\nChúc mừng! Webhook cấu hình thành công trên OT Support Tracking Tool.");
      sendJson(res, 200, { ok: success });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/chat/trigger-reminders") {
      if (!session || session.role !== "ADMIN") {
        return sendJson(res, 401, { ok: false, error: "Unauthorized." });
      }
      const now = new Date();
      const resData = await checkAndSendReminders(now);
      sendJson(res, 200, { ok: true, ...resData });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, { ok: true, projectSlug });
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

// Background scheduler interval (checks every 30 minutes)
setInterval(async () => {
  try {
    const now = new Date();
    // Check if the current hour is 17 (5 PM)
    if (now.getHours() === 17) {
      console.log("[BACKGROUND-JOB] Running daily reminder check...");
      const resData = await checkAndSendReminders(now);
      console.log("[BACKGROUND-JOB] Check completed:", JSON.stringify(resData));
    }
  } catch (err) {
    console.error("[BACKGROUND-JOB] Error checking reminders:", err.message);
  }
}, 30 * 60 * 1000); // 30 minutes

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
}).listen(port, async () => {
  console.log(`OT Support Tool local app: http://localhost:${port}`);
  console.log(`Taiga integrated backend online. Project slug: ${projectSlug}`);
  await initTaigaConfig();
  if (projectId) {
    try {
      await syncFromTaiga();
      console.log("Initial Taiga data sync completed.");
    } catch (err) {
      console.error("Initial Taiga sync failed:", err.message);
    }
  }
});
