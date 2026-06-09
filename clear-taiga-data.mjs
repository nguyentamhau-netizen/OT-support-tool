import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// 1. Load Environment Variables
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

loadEnvFile(".env.local");

const apiUrl = process.env.TAIGA_API_URL || "https://projects.kyanon.digital/api/v1";
const projectSlug = process.env.TAIGA_PROJECT_SLUG || "amaze-ot-log";
const username = process.env.TAIGA_USERNAME;
const password = process.env.TAIGA_PASSWORD;
const DB_DIR = join(process.cwd(), "db_cache");

const tableSchemas = {
  schedule_slots: ["slot_id", "date", "month", "day_of_week", "slot_type", "title", "status", "created_by", "created_at", "updated_at", "note", "taiga_issue_id"],
  slot_capacities: ["capacity_id", "slot_id", "role_name", "required_count", "hours_per_person", "man_month_factor", "created_at", "updated_at", "note"],
  registrations: ["registration_id", "slot_id", "capacity_id", "user_email", "registered_by_email", "status", "approved_status", "source", "created_at", "updated_at", "note"],
  holiday_settings: ["holiday_id", "date", "name", "holiday_type", "required_role", "required_count", "hours_per_person", "man_month_factor", "note", "created_by", "created_at", "updated_at"],
  update_requests: ["request_id", "user_email", "target_registration_id", "target_date", "requested_hours", "reason", "evidence_url", "status", "admin_note", "reviewed_by", "created_at", "reviewed_at"],
  audit_logs: ["log_id", "actor_email", "action", "entity_type", "entity_id", "before_json", "after_json", "created_at"],
  chat_notifications: ["notification_id", "slot_id", "message", "scheduled_for", "sent_at", "status", "response", "created_at"]
};

async function getAdminToken() {
  if (!username || !password) {
    throw new Error("Missing TAIGA_USERNAME or TAIGA_PASSWORD in .env.local");
  }

  const authRes = await fetch(`${apiUrl}/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "normal", username, password })
  });

  if (!authRes.ok) {
    throw new Error(`Authentication failed: ${authRes.status} ${await authRes.text()}`);
  }

  const userData = await authRes.json();
  return userData.auth_token;
}

async function run() {
  try {
    console.log("=== STEP 1: Authenticating with Taiga ===");
    const token = await getAdminToken();
    console.log("Auth Token acquired successfully.");

    // Fetch project ID
    console.log("\n=== STEP 2: Fetching Project ID ===");
    const projectRes = await fetch(`${apiUrl}/projects/by_slug?slug=${projectSlug}`, {
      headers: { "Authorization": `Bearer ${token}` }
    });
    if (!projectRes.ok) {
      throw new Error(`Failed to fetch project: ${projectRes.status} ${await projectRes.text()}`);
    }
    const project = await projectRes.json();
    const projectId = project.id;
    console.log(`Project Slug "${projectSlug}" maps to ID: ${projectId}`);

    // Fetch issues
    console.log("\n=== STEP 3: Fetching Issues ===");
    const issuesRes = await fetch(`${apiUrl}/issues?project=${projectId}&page_size=100`, {
      headers: { "Authorization": `Bearer ${token}` }
    });
    if (!issuesRes.ok) {
      throw new Error(`Failed to fetch issues: ${issuesRes.status} ${await issuesRes.text()}`);
    }
    const issues = await issuesRes.json();
    console.log(`Found ${issues.length} issues in the project.`);

    // Delete issues
    console.log("\n=== STEP 4: Deleting Issues ===");
    for (const issue of issues) {
      console.log(`Deleting issue ${issue.id}: "${issue.subject}"...`);
      const deleteRes = await fetch(`${apiUrl}/issues/${issue.id}`, {
        method: "DELETE",
        headers: { "Authorization": `Bearer ${token}` }
      });
      if (deleteRes.ok || deleteRes.status === 204) {
        console.log(`Successfully deleted issue ${issue.id}.`);
      } else {
        console.error(`Failed to delete issue ${issue.id}: ${deleteRes.status} ${await deleteRes.text()}`);
      }
    }

    // Clear local CSV caches
    console.log("\n=== STEP 5: Clearing Local CSV Caches ===");
    for (const [tableName, headers] of Object.entries(tableSchemas)) {
      const filePath = join(DB_DIR, `${tableName}.csv`);
      if (existsSync(filePath)) {
        console.log(`Clearing ${tableName}.csv...`);
        const headerLine = headers.join(",") + "\n";
        writeFileSync(filePath, headerLine, "utf8");
      }
    }

    console.log("\n=== SUCCESS: Cleanup completed successfully! ===");
  } catch (err) {
    console.error("\n=== ERROR: Cleanup failed ===");
    console.error(err.message);
  }
}

run();
