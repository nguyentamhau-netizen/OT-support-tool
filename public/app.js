const COMPANY_DOMAIN = "kyanon.digital";

let state = emptyState();
let session = loadSession();
let view = "dashboard";
let selectedMonth = monthKey(new Date());
let modal = null;
let isBootstrapping = true;
let bootstrapError = "";
let saveStatus = "";
let saveTimer = null;
let isRefreshing = false;

// Enhanced state
let darkMode = localStorage.getItem("ot-dark-mode") === "true";
let sidebarOpen = false;
let slotFilter = "ALL"; // ALL, OPEN, FULL
let userSearch = "";
let requestFilter = "ALL"; // ALL, PENDING, APPROVED, REJECTED
let exportToMonth = "";
let selectedBulkIds = new Set();
let sseSource = null;

if (darkMode) document.documentElement.setAttribute("data-theme", "dark");

// Global fetch interceptor to handle unauthorized sessions (expired session_token cookie)
const originalFetch = window.fetch;
window.fetch = async function (resource, options) {
  const response = await originalFetch(resource, options);
  const url = typeof resource === "string" ? resource : (resource?.url || "");
  if (response.status === 401 && url.includes("/api/") && !url.includes("/api/auth/login")) {
    localStorage.removeItem("ot-support-session");
    session = null;
    modal = null;
    render();
  }
  return response;
};

const app = document.querySelector("#app");

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem("ot-support-session") || "null");
  } catch {
    return null;
  }
}

function saveSession(nextSession) {
  session = nextSession;
  localStorage.setItem("ot-support-session", JSON.stringify(nextSession));
}

function showToast(message, type = "success") {
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.innerText = message;
  document.body.appendChild(toast);
  
  setTimeout(() => {
    toast.classList.add("show");
  }, 10);

  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => {
      toast.remove();
    }, 300);
  }, 3000);
}

function getSettingValueClient(key, defaultValue = "") {
  if (!state.settings) return defaultValue;
  const found = state.settings.find(s => s.key === key);
  return found ? found.value : defaultValue;
}

async function loadStateFromDb(sync = false, month = selectedMonth, isPolling = false) {
  if (!isPolling) {
    if (sync || !isBootstrapping) {
      isRefreshing = true;
    } else {
      isBootstrapping = true;
      bootstrapError = "";
    }
    render();
  }

  try {
    let url = `/api/state?month=${month}`;
    if (sync) url += "&sync=true";
    const response = await fetch(url, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || "Cannot load database.");
    state = {
      ...emptyState(),
      ...payload.state
    };
    // Update session info from server (role-based admin)
    if (payload.session && session) {
      session = { ...session, ...payload.session };
      localStorage.setItem("ot-support-session", JSON.stringify(session));
    }
    isBootstrapping = false;
    bootstrapError = "";
    isRefreshing = false;
    saveStatus = "";
    render();
    connectSSE();
  } catch (error) {
    isBootstrapping = false;
    isRefreshing = false;
    if (sync) {
      saveStatus = `error: ${error.message}`;
    } else {
      bootstrapError = error.message;
    }
    render();
  }
}

function emptyState() {
  return {
    settings: [],
    users: [],
    scheduleSlots: [],
    capacities: [],
    registrations: [],
    holidaySettings: [],
    updateRequests: [],
    auditLogs: [],
    exportJobs: [],
    chatNotifications: [],
    db: null
  };
}

function nowIso() {
  return new Date().toISOString();
}

function monthKey(date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  return `${year}-${month}`;
}

function parseLocalDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function dateKey(date) {
  return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, "0")}-${`${date.getDate()}`.padStart(2, "0")}`;
}

function dayName(date) {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getDay()];
}

function formatDate(value) {
  const date = typeof value === "string" ? parseLocalDate(value) : value;
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Asia/Ho_Chi_Minh"
  }).format(date);
}

function formatDateLong(value) {
  const date = typeof value === "string" ? parseLocalDate(value) : value;
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
    timeZone: "Asia/Ho_Chi_Minh"
  }).format(date);
}

function isPastDate(value) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return parseLocalDate(value) < today;
}

function isAdmin() {
  return session?.role === "ADMIN";
}

function currentUser() {
  if (!session) return null;
  return state.users.find((user) => user.email.toLowerCase() === session.email.toLowerCase());
}

function getSlotsForMonth(month) {
  return state.scheduleSlots
    .filter((slot) => slot.month === month)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function getCapacity(slotId) {
  return state.capacities.find((capacity) => capacity.slotId === slotId);
}

function getActiveRegistrations(slotId) {
  return state.registrations.filter((registration) => registration.slotId === slotId && registration.status === "ACTIVE");
}

function findUserMonthlyRegistration(month, email) {
  return state.registrations.find((registration) => {
    const registeredSlot = state.scheduleSlots.find((slot) => slot.slotId === registration.slotId);
    return (
      registration.status === "ACTIVE" &&
      registration.userEmail.toLowerCase() === email.toLowerCase() &&
      registeredSlot && registeredSlot.month === month
    );
  });
}

function remainingSlots(slot) {
  const capacity = getCapacity(slot.slotId);
  return Math.max(0, (capacity?.requiredCount || 0) - getActiveRegistrations(slot.slotId).length);
}

function getRegistrationHours(registration) {
  const capacity = state.capacities.find((item) => item.capacityId === registration.capacityId);
  return capacity?.hoursPerPerson || 0;
}

function getRegistrationManMonth(registration) {
  const slot = state.scheduleSlots.find((item) => item.slotId === registration.slotId);
  const capacity = state.capacities.find((item) => item.capacityId === registration.capacityId);
  if (!capacity) return 0;
  if (slot?.slotType === "HOLIDAY" || slot?.slotType === "TET") {
    const activeCount = Math.max(1, getActiveRegistrations(slot.slotId).length);
    return Number(capacity.manMonthFactor || 0) / activeCount;
  }
  return Number(capacity.manMonthFactor || 0);
}

function refreshSlotStatus(slotId) {
  const slot = state.scheduleSlots.find((item) => item.slotId === slotId);
  if (!slot) return;
  if (slot.status === "CANCELLED" || slot.status === "CLOSED") return;
  slot.status = remainingSlots(slot) <= 0 ? "FULL" : "OPEN";
  slot.updatedAt = nowIso();
}

async function registerSlot(slotId, userEmail) {
  try {
    saveStatus = "saving";
    render();
    const response = await fetch("/api/slots/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slotId, userEmail })
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || "Cannot register slot.");
    state = {
      ...emptyState(),
      ...payload.state
    };
    saveStatus = "saved";
    showToast("Registration successful!");
    render();
  } catch (error) {
    saveStatus = `error: ${error.message}`;
    modal = { type: "info", title: "Cannot Register", message: error.message, primary: { label: "Close", action: "modal-close" } };
    render();
  }
}

async function cancelRegistration(registrationId) {
  try {
    saveStatus = "saving";
    render();
    const response = await fetch("/api/slots/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ registrationId })
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || "Cannot cancel registration.");
    state = {
      ...emptyState(),
      ...payload.state
    };
    saveStatus = "saved";
    showToast("Registration cancelled!");
    render();
  } catch (error) {
    saveStatus = `error: ${error.message}`;
    modal = { type: "info", title: "Cannot Cancel", message: error.message, primary: { label: "Close", action: "modal-close" } };
    render();
  }
}

function audit(actorEmail, action, entityType, entityId, beforeJson, afterJson) {
  state.auditLogs.push({
    logId: `log_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    actorEmail,
    action,
    entityType,
    entityId,
    beforeJson,
    afterJson,
    createdAt: nowIso()
  });
}

function render() {
  if (isBootstrapping) {
    app.innerHTML = `
      <div class="login-panel" style="min-height:100vh">
        <div class="login-box">
          <h2>Loading OT Support Database</h2>
          <p class="muted">Loading data from database...</p>
          <div class="grid cols-4" style="margin-top:20px">
            <div class="skeleton skeleton-metric"></div>
            <div class="skeleton skeleton-metric"></div>
            <div class="skeleton skeleton-metric"></div>
            <div class="skeleton skeleton-metric"></div>
          </div>
        </div>
      </div>
    `;
    return;
  }

  if (bootstrapError) {
    app.innerHTML = `
      <div class="login-panel" style="min-height:100vh">
        <div class="login-box">
          <h2>Database Not Connected</h2>
          <div class="error">${escapeHtml(bootstrapError)}</div>
          <p class="muted">Cannot load data. Please check your database connection or restart the server.</p>
          <button class="btn primary" data-action="retry-bootstrap">Retry</button>
        </div>
      </div>
    `;
    document.querySelector("[data-action='retry-bootstrap']")?.addEventListener("click", loadStateFromDb);
    return;
  }

  if (!session) {
    renderLogin();
    return;
  }

  const user = currentUser();
  if (!user || user.status !== "ACTIVE") {
    renderLogin("Account is not active in the OT Support DB.");
    return;
  }

  const navItems = [
    ["dashboard", "📋", "Register Dashboard"],
    ["stats", "📊", "Statistics"],
    ["requests", "📝", "Requests"],
    ["profile", "👤", "My Profile"],
    ...(isAdmin() ? [["admin-users", "👥", "Users"], ["admin-schedule", "⚙️", "Schedule"]] : [])
  ];

  app.innerHTML = `
    <button class="hamburger" data-action="toggle-sidebar">☰</button>
    <div class="sidebar-overlay" data-action="close-sidebar"></div>
    <div class="shell">
      <aside class="sidebar ${sidebarOpen ? 'open' : ''}">
        <div class="brand">
          <div class="brand-mark">OT</div>
          <div>
            <div class="brand-title">OT Support Tool</div>
            <div class="brand-subtitle">Amaze support tracking</div>
          </div>
        </div>
        <nav class="nav">
          ${navItems.map(([key, icon, label]) => `<button class="${view === key ? "active" : ""}" data-nav="${key}">${icon} ${label}</button>`).join("")}
        </nav>
        <div class="sidebar-footer">
          OT Support Database<br />
          <span class="kbd">←</span><span class="kbd">→</span> navigate months
        </div>
      </aside>
      <main class="main">
        <header class="topbar">
          <h1 class="page-title">${pageTitle()}</h1>
          <div class="user-menu">
            <span class="status info">${escapeHtml(saveStatus || "Synced")}</span>
            <button class="theme-toggle" data-action="toggle-theme" title="Toggle dark mode">${darkMode ? '☀️' : '🌙'}</button>
            <div>
              <strong>${escapeHtml(user.displayName)}</strong>
              <div class="muted">${escapeHtml(session.role || 'MEMBER')}</div>
            </div>
            <div class="avatar">${user.displayName.slice(0, 1).toUpperCase()}</div>
            <button class="btn small" data-action="logout">Logout</button>
          </div>
        </header>
        <section class="content ${isRefreshing ? "loading-fade" : ""}">${renderView()}</section>
        ${renderModal()}
      </main>
    </div>
  `;

  bindShellEvents();
}

function pageTitle() {
  const titles = {
    dashboard: "Register Dashboard",
    stats: "Support Statistics",
    requests: "Update Requests",
    profile: "My Profile",
    "admin-users": "Admin User Management",
    "admin-schedule": "Admin Schedule Setup"
  };
  return titles[view] || "OT Support Tool";
}

function renderLogin(message = "") {
  app.innerHTML = `
    <div class="login">
      <section class="login-visual">
        <div>
          <h1>OT Support Tool</h1>
          <p>Track weekend support, holiday coverage, member registrations, monthly summaries, and Excel approval exports in one internal workspace.</p>
        </div>
      </section>
      <section class="login-panel">
        <div class="login-box">
          <h2>Sign in</h2>
          <p class="muted">Sign in with your company account.</p>
          ${message ? `<div class="error">${escapeHtml(message)}</div>` : ""}
          <div class="notice" style="margin-bottom:16px;font-size:0.85rem">
            🔑 <strong>Mật khẩu mặc định:</strong> <code>Amaze@2026</code> (có thể đổi tại trang cá nhân).
          </div>
          <form class="form" id="login-form">
            <div class="field">
              <label for="email">Email / Username</label>
              <input id="email" name="email" type="text" placeholder="member@kyanon.digital" required />
            </div>
            <div class="field">
              <label for="password">Password</label>
              <input id="password" name="password" type="password" placeholder="••••••••" required />
            </div>
            <button class="btn primary" type="submit">Login</button>
          </form>
        </div>
      </section>
    </div>
  `;

  document.querySelector("#login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const email = formData.get("email").trim().toLowerCase();
    const password = formData.get("password");

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: email, password })
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "Login failed");
      
      saveSession({ email: data.user.email, role: data.user.role || "MEMBER" });
      await loadStateFromDb();
    } catch (err) {
      renderLogin(err.message);
    }
  });
}

function renderView() {
  if (view === "dashboard") return renderDashboard();
  if (view === "stats") return renderStats();
  if (view === "requests") return renderRequests();
  if (view === "profile") return renderProfile();
  if (view === "admin-users") return renderAdminUsers();
  if (view === "admin-schedule") return renderAdminSchedule();
  return "";
}

function renderActionToolbar() {
  return `
    <div class="toolbar">
      <div class="toolbar-group">
        <button class="btn" data-action="refresh-db" ${isRefreshing ? "disabled" : ""}>
          ${isRefreshing ? '<span class="spinner"></span>Refreshing...' : '🔄 Refresh'}
        </button>
        <button class="btn primary" data-action="export-preview" title="Export report for ${selectedMonth}">📥 Export Excel (${selectedMonth})</button>
      </div>
    </div>
  `;
}

function renderMonthSelector() {
  const [year, month] = selectedMonth.split("-").map(Number);
  
  let monthOptions = "";
  for (let m = 1; m <= 12; m++) {
    const monthVal = `${m}`.padStart(2, "0");
    monthOptions += `<option value="${monthVal}" ${m === month ? "selected" : ""}>Month ${m}</option>`;
  }
  
  let yearOptions = "";
  const currentYear = new Date().getFullYear();
  for (let y = currentYear - 2; y <= currentYear + 3; y++) {
    yearOptions += `<option value="${y}" ${y === year ? "selected" : ""}>Year ${y}</option>`;
  }

  return `
    <div class="month-selector-container">
      <button class="today-btn" type="button" data-action="today-month">Today</button>
      <div class="nav-divider"></div>
      <button class="nav-btn" type="button" data-action="prev-month" title="Previous month">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
      </button>
      <div class="select-wrapper">
        <select data-action="select-month">
          ${monthOptions}
        </select>
      </div>
      <div class="select-wrapper">
        <select data-action="select-year">
          ${yearOptions}
        </select>
      </div>
      <button class="nav-btn" type="button" data-action="next-month" title="Next month">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
      </button>
    </div>
  `;
}

function renderDashboard() {
  const slots = getSlotsForMonth(selectedMonth);
  const registrations = slots.flatMap((slot) => getActiveRegistrations(slot.slotId));
  const openSlots = slots.filter((slot) => slot.status === "OPEN").length;
  const totalHours = registrations.reduce((sum, registration) => {
    return sum + getRegistrationHours(registration);
  }, 0);

  const [year, month] = selectedMonth.split("-");
  const displayLabel = `Month ${parseInt(month, 10)} - ${year}`;

  if (slots.length === 0) {
    return `
      ${renderActionToolbar()}
      <div class="grid cols-4">
        ${metric("Support days", 0)}
        ${metric("Open slots", 0)}
        ${metric("Assigned people", 0)}
        ${metric("Total hours", 0)}
      </div>
      <div class="split" style="margin-top:16px">
        <section class="panel">
          <div class="panel-header" style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
            <h2 class="panel-title">Calendar</h2>
            ${renderMonthSelector()}
          </div>
          <div class="panel-body">${renderCalendar(slots)}</div>
        </section>
        <section class="panel">
          <div class="panel-body">
            <div class="empty-state">
              <div class="empty-state-icon">📅</div>
              <div class="empty-state-title">No schedule yet</div>
              <div class="empty-state-desc">${isAdmin() ? 'Create a schedule for this month. Weekend slots will be auto-generated on refresh.' : 'No schedule for this month. Please contact admin.'}</div>
              ${isAdmin() ? '<button class="btn primary" data-action="refresh-db">🔄 Generate Slots</button>' : ''}
            </div>
          </div>
        </section>
      </div>
    `;
  }

  // Filter slots for table
  const filteredSlots = slotFilter === "ALL" ? slots : slots.filter(s => s.status === slotFilter);

  return `
    ${renderActionToolbar()}
    <div class="grid cols-4">
      ${metric("Support days", slots.length)}
      ${metric("Open slots", openSlots)}
      ${metric("Assigned people", registrations.length)}
      ${metric("Total hours", totalHours)}
    </div>
    <div class="split" style="margin-top:16px">
      <section class="panel">
        <div class="panel-header" style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
          <h2 class="panel-title">Calendar</h2>
          ${renderMonthSelector()}
        </div>
        <div class="panel-body">${renderCalendar(slots)}</div>
      </section>
      <section class="panel">
        <div class="panel-header">
          <h2 class="panel-title">Upcoming Reminders</h2>
        </div>
        <div class="panel-body">${renderReminderPreview(slots)}</div>
      </section>
    </div>
    <section class="panel" style="margin-top:16px">
      <div class="panel-header" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
        <h2 class="panel-title">Slot table</h2>
        <select class="filter-select" data-action="filter-slot">
          <option value="ALL" ${slotFilter === "ALL" ? "selected" : ""}>All Status</option>
          <option value="OPEN" ${slotFilter === "OPEN" ? "selected" : ""}>Open</option>
          <option value="FULL" ${slotFilter === "FULL" ? "selected" : ""}>Full</option>
        </select>
      </div>
      <div class="table-wrap">${renderSlotsTable(filteredSlots, false)}</div>
    </section>
  `;
}

function metric(label, value) {
  return `
    <div class="metric">
      <div class="metric-value">${value}</div>
      <div class="metric-label">${label}</div>
    </div>
  `;
}

function renderCalendar(slots) {
  const [year, month] = selectedMonth.split("-").map(Number);
  const first = new Date(year, month - 1, 1);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());
  const cells = [];

  const todayKey = dateKey(new Date());
  for (let i = 0; i < 42; i += 1) {
    const date = new Date(start);
    date.setDate(start.getDate() + i);
    const key = dateKey(date);
    const daySlots = slots.filter((slot) => slot.date === key);
    const isToday = key === todayKey;
    const holidayLabel = getHolidayLabel(date);
    cells.push(`
      <div class="day ${date.getMonth() === month - 1 ? "" : "out"} ${isToday ? "today" : ""}">
        <div class="day-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <div class="day-number" style="margin-bottom: 0;">${date.getDate()}</div>
          <span class="lunar-day-number">${getLunarDayText(date)}</span>
        </div>
        ${holidayLabel ? `<div class="day-holiday-badge" title="${escapeHtml(holidayLabel)}"># ${escapeHtml(holidayLabel)}</div>` : ""}
        ${daySlots.map(renderCalendarSlot).join("")}
      </div>
    `);
  }

  return `
    <div class="calendar">
      ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => `<div class="weekday">${day}</div>`).join("")}
      ${cells.join("")}
    </div>
  `;
}

function renderCalendarSlot(slot) {
  const regs = getActiveRegistrations(slot.slotId);
  const names = regs
    .map((registration) => userLabel(registration.userEmail))
    .join(", ");
  
  const isHoliday = slot.slotType !== "WEEKEND";
  const isFull = slot.status === "FULL";
  const isAssigned = regs.length > 0;
  
  let statusClass = "empty";
  if (isFull) {
    statusClass = "full";
  } else if (isAssigned) {
    statusClass = "assigned";
  }

  // Build detailed tooltip
  const capacity = getCapacity(slot.slotId);
  const tooltipLines = [
    `${slot.title} - ${slot.slotType}`,
    `Hours: ${capacity?.hoursPerPerson || 8}h`,
    names ? `Assigned: ${names}` : `No one assigned (${remainingSlots(slot)} slots open)`
  ];

  const css = `${isHoliday ? "holiday" : ""} ${statusClass}`;
  return `
    <button class="slot-pill ${css}" data-action="focus-slot" data-slot="${slot.slotId}" title="${escapeHtml(tooltipLines.join('\n'))}">
      <span class="slot-name">${escapeHtml(slot.title)}</span>
      <span class="slot-meta ${names ? 'assigned' : ''}">${escapeHtml(names || `${remainingSlots(slot)} open`)}</span>
    </button>
  `;
}

function renderModal() {
  if (!modal) return "";
  return `
    <div class="modal-backdrop" role="presentation" data-action="modal-close">
      <section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div class="modal-header">
          <h2 id="modal-title">${escapeHtml(modal.title)}</h2>
        </div>
        <div class="modal-body">
          <p>${escapeHtml(modal.message)}</p>
          ${modal.activeRegistrations && modal.activeRegistrations.length > 0 ? `
            <div class="active-regs-section" style="margin-top: 14px; border-top: 1px solid var(--line); padding-top: 12px;">
              <label style="font-weight: 700; display: block; margin-bottom: 8px;">Currently registered members:</label>
              <div style="display: flex; flex-direction: column; gap: 8px; max-height: 150px; overflow-y: auto;">
                ${modal.activeRegistrations.map(reg => `
                  <div style="display: flex; align-items: center; justify-content: space-between; background: var(--bg); padding: 8px 10px; border-radius: 6px; border: 1px solid var(--line);">
                    <span style="font-size: 14px; font-weight: 600;">${escapeHtml(userLabel(reg.userEmail))}</span>
                    <button class="btn small danger" data-action="admin-cancel-reg" data-reg-id="${reg.registrationId}">Cancel</button>
                  </div>
                `).join("")}
              </div>
            </div>
          ` : ""}
          ${modal.memberSelect ? `
            <div class="field" style="margin-top:14px">
              <label>Register for member</label>
              <select data-action="modal-member-select">
                ${state.users
                  .filter((user) => user.status === "ACTIVE")
                  .map((user) => `<option value="${user.email}" ${user.email === modal.defaultMemberEmail ? "selected" : ""}>${escapeHtml(user.displayName)} - ${escapeHtml(user.email)}</option>`)
                  .join("")}
              </select>
            </div>
          ` : ""}
          ${modal.type === "admin-manage-slot" && modal.activeRegistrations && modal.activeRegistrations.length > 0 ? `
            <div style="margin-top: 14px; border-top: 1px solid var(--line); padding-top: 12px;">
              <label style="font-weight: 700; display: block; margin-bottom: 8px;">🔄 Swap Shift</label>
              <div class="field" style="margin-bottom:8px">
                <label>From:</label>
                <select data-action="swap-from-select" style="padding:6px 10px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--text)">
                  ${modal.activeRegistrations.map(reg => `<option value="${reg.userEmail}">${escapeHtml(userLabel(reg.userEmail))}</option>`).join("")}
                </select>
              </div>
              <div class="field" style="margin-bottom:8px">
                <label>To:</label>
                <select data-action="swap-to-select" style="padding:6px 10px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--text)">
                  ${state.users
                    .filter(u => u.status === "ACTIVE" && !modal.activeRegistrations.some(r => r.userEmail.toLowerCase() === u.email.toLowerCase()))
                    .map(u => `<option value="${u.email}">${escapeHtml(u.displayName)}</option>`)
                    .join("")}
                </select>
              </div>
              <button class="btn small primary" data-action="modal-confirm-swap" data-slot-swap="${modal.slotId}">🔄 Swap</button>
            </div>
          ` : ""}
        </div>
        <div class="modal-actions">
          ${modal.secondary ? `<button class="btn" data-action="${modal.secondary.action}">${escapeHtml(modal.secondary.label)}</button>` : ""}
          ${modal.primary ? `<button class="btn primary" data-action="${modal.primary.action}">${escapeHtml(modal.primary.label)}</button>` : ""}
        </div>
      </section>
    </div>
  `;
}

function openSlotModal(slotId) {
  const slot = state.scheduleSlots.find((item) => item.slotId === slotId);
  if (!slot) return;

  if (isAdmin()) {
    const regs = getActiveRegistrations(slotId);
    modal = {
      type: "admin-manage-slot",
      slotId,
      title: "Admin Slot Management",
      message: `Slot details for ${formatDateLong(slot.date)}.`,
      activeRegistrations: regs,
      memberSelect: remainingSlots(slot) > 0,
      defaultMemberEmail: session.email,
      primary: remainingSlots(slot) > 0 ? { label: "Register", action: "modal-confirm-register" } : null,
      secondary: { label: "Close", action: "modal-close" }
    };
    render();
    return;
  }

  const ownRegistration = getActiveRegistrations(slotId).find((registration) => registration.userEmail.toLowerCase() === session.email.toLowerCase());
  if (ownRegistration) {
    if (isPastDate(slot.date)) {
      modal = {
        type: "info",
        title: "Cannot Cancel Registration",
        message: "This date has passed. If you need changes, please create an update request.",
        primary: { label: "Close", action: "modal-close" }
      };
      render();
      return;
    }

    modal = {
      type: "cancel-registration",
      registrationId: ownRegistration.registrationId,
      title: "Cancel Registration",
      message: `Do you want to cancel your registration for ${formatDateLong(slot.date)}?`,
      primary: { label: "Yes", action: "modal-confirm-cancel" },
      secondary: { label: "No", action: "modal-close" }
    };
    render();
    return;
  }

  if (isPastDate(slot.date)) {
    modal = {
      type: "info",
      title: "Cannot Register",
      message: "This date has passed. If you need changes, please create an update request.",
      primary: { label: "Close", action: "modal-close" }
    };
    render();
    return;
  }

  if (remainingSlots(slot) <= 0) {
    const names = getActiveRegistrations(slotId).map((registration) => userLabel(registration.userEmail)).join(", ");
    modal = {
      type: "info",
      title: "Slot Already Full",
      message: `${formatDateLong(slot.date)} is fully booked${names ? `: ${names}` : "."}`,
      primary: { label: "Close", action: "modal-close" }
    };
    render();
    return;
  }

  const existingRegistration = findUserMonthlyRegistration(slot.month, session.email);
  if (existingRegistration) {
    const existingSlot = state.scheduleSlots.find((item) => item.slotId === existingRegistration.slotId);
    modal = {
      type: "info",
      title: "Already Registered This Month",
      message: `You have already registered for ${formatDateLong(existingSlot.date)}.`,
      primary: { label: "Close", action: "modal-close" }
    };
    render();
    return;
  }

  modal = {
    type: "register-slot",
    slotId,
    title: "Confirm Registration",
    message: `Do you want to register for support on ${formatDateLong(slot.date)}?`,
    primary: { label: "Yes", action: "modal-confirm-register" },
    secondary: { label: "No", action: "modal-close" }
  };
  render();
}

function renderReminderPreview(slots) {
  const upcoming = slots
    .filter((slot) => !isPastDate(slot.date))
    .slice(0, 5);
  if (!upcoming.length) return `<div class="empty">No upcoming reminders.</div>`;
  return `
    <div class="list">
      ${upcoming.map((slot) => {
        const names = getActiveRegistrations(slot.slotId).map((registration) => userLabel(registration.userEmail)).join(", ") || "No one registered";
        return `
          <div class="item">
            <div class="item-title">${formatDate(slot.date)}</div>
            <div class="item-meta">${formatDateLong(slot.date)}: ${escapeHtml(names)} will support Amaze project.</div>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function renderSlotsTable(slots) {
  return `
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>Day</th>
          <th>Type</th>
          <th>Role</th>
          <th>Registered</th>
          <th>Remaining</th>
          <th>Status</th>
          <th>Approval</th>
        </tr>
      </thead>
      <tbody>
        ${slots.map((slot) => {
          const capacity = getCapacity(slot.slotId);
          const regs = getActiveRegistrations(slot.slotId);
          return `
            <tr>
              <td><strong>${formatDate(slot.date)}</strong><div class="muted">${slot.date}</div></td>
              <td>${slot.dayOfWeek}</td>
              <td>${slot.slotType}</td>
              <td>${escapeHtml(capacity?.roleName || "")}</td>
              <td>${regs.map((registration) => escapeHtml(userLabel(registration.userEmail))).join("<br>") || "<span class='muted'>None</span>"}</td>
              <td>${remainingSlots(slot)}</td>
              <td><span class="status ${slot.status.toLowerCase()}">${slot.status}</span></td>
              <td><span class="status approved">AUTO_APPROVED</span></td>
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
  `;
}

function renderStats() {
  const slots = getSlotsForMonth(selectedMonth);
  const rows = state.users
    .filter((user) => user.status === "ACTIVE")
    .map((user) => {
      const regs = state.registrations.filter((registration) => {
        const slot = slots.find((item) => item.slotId === registration.slotId);
        return registration.status === "ACTIVE" && slot && registration.userEmail.toLowerCase() === user.email.toLowerCase();
      });
      const hours = regs.reduce((sum, registration) => {
        return sum + getRegistrationHours(registration);
      }, 0);
      const manMonth = regs.reduce((sum, registration) => sum + getRegistrationManMonth(registration), 0);
      return { user, regs, hours, manMonth };
    });

  // Render chart after DOM
  requestAnimationFrame(() => {
    const ctx = document.getElementById("stats-chart");
    if (!ctx || typeof Chart === "undefined") return;
    const labels = rows.map(r => r.user.displayName);
    const daysData = rows.map(r => r.regs.length);
    const hoursData = rows.map(r => r.hours);

    const isDark = darkMode;
    const gridColor = isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.08)";
    const textColor = isDark ? "#c8d8e8" : "#657386";

    new Chart(ctx, {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label: "Support Days",
            data: daysData,
            backgroundColor: "rgba(31, 122, 109, 0.75)",
            borderColor: "rgba(31, 122, 109, 1)",
            borderWidth: 1,
            borderRadius: 4
          },
          {
            label: "Total Hours",
            data: hoursData,
            backgroundColor: "rgba(47, 102, 197, 0.65)",
            borderColor: "rgba(47, 102, 197, 1)",
            borderWidth: 1,
            borderRadius: 4
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: textColor, font: { family: "'Inter', sans-serif" } } }
        },
        scales: {
          x: {
            ticks: { color: textColor, font: { family: "'Inter', sans-serif", size: 11 } },
            grid: { color: gridColor }
          },
          y: {
            beginAtZero: true,
            ticks: { color: textColor, font: { family: "'Inter', sans-serif", size: 11 } },
            grid: { color: gridColor }
          }
        }
      }
    });
  });

  return `
    ${renderActionToolbar()}
    <div class="split">
      <section class="panel">
        <div class="panel-header" style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
          <h2 class="panel-title">📊 Monthly member chart</h2>
          ${renderMonthSelector()}
        </div>
        <div class="panel-body">
          <div class="chart-container" style="height:320px">
            <canvas id="stats-chart"></canvas>
          </div>
        </div>
      </section>
      <section class="panel">
        <div class="panel-header">
          <h2 class="panel-title">Summary</h2>
        </div>
        <div class="panel-body">
          <div class="grid cols-2" style="margin-bottom:16px">
            ${metric("Total slots", slots.length)}
            ${metric("Total registrations", rows.reduce((s, r) => s + r.regs.length, 0))}
          </div>
          <div class="grid cols-2">
            ${metric("Total hours", rows.reduce((s, r) => s + r.hours, 0))}
            ${metric("Total man/month", rows.reduce((s, r) => s + r.manMonth, 0).toFixed(2))}
          </div>
        </div>
      </section>
    </div>
    <section class="panel" style="margin-top:16px">
      <div class="panel-header">
        <h2 class="panel-title">Monthly member totals</h2>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Member</th>
              <th>Email</th>
              <th>Support days</th>
              <th>Total hours</th>
              <th>Man/month factor</th>
              <th>Dates</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(({ user, regs, hours, manMonth }) => `
              <tr>
                <td><strong>${escapeHtml(user.displayName)}</strong></td>
                <td>${escapeHtml(user.email)}</td>
                <td>${regs.length}</td>
                <td>${hours}</td>
                <td>${manMonth.toFixed(2)}</td>
                <td>${regs.map((registration) => {
                  const slot = slots.find((item) => item.slotId === registration.slotId);
                  return slot ? formatDate(slot.date) : "";
                }).join("<br>") || "<span class='muted'>None</span>"}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderRequests() {
  let myRequests = isAdmin() ? state.updateRequests : state.updateRequests.filter((request) => request.userEmail.toLowerCase() === session.email.toLowerCase());
  // Apply filter
  if (requestFilter !== "ALL") {
    myRequests = myRequests.filter(r => r.status === requestFilter);
  }
  const pendingCount = (isAdmin() ? state.updateRequests : myRequests).filter(r => r.status === "PENDING").length;

  return `
    <div class="grid cols-2">
      <section class="panel">
        <div class="panel-header">
          <h2 class="panel-title">Create update request</h2>
        </div>
        <div class="panel-body">
          <form class="form" id="request-form">
            <div class="field">
              <label>Date to update</label>
              <input type="date" name="targetDate" required />
            </div>
            <div class="field">
              <label>Actual hours</label>
              <input type="number" name="requestedHours" min="0" step="0.5" value="8" required />
            </div>
            <div class="field">
              <label>Evidence URL or note</label>
              <input name="evidenceUrl" placeholder="Google Drive URL or short note" />
            </div>
            <div class="field">
              <label>Reason</label>
              <textarea name="reason" required></textarea>
            </div>
            <button class="btn primary" type="submit">Submit request</button>
          </form>
        </div>
      </section>
      <section class="panel">
        <div class="panel-header" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
          <h2 class="panel-title">${isAdmin() ? "All requests" : "My requests"} ${pendingCount > 0 ? `<span class="status pending">${pendingCount} pending</span>` : ""}</h2>
          <div class="toolbar-group">
            <select class="filter-select" data-action="filter-request">
              <option value="ALL" ${requestFilter === "ALL" ? "selected" : ""}>All</option>
              <option value="PENDING" ${requestFilter === "PENDING" ? "selected" : ""}>Pending</option>
              <option value="APPROVED" ${requestFilter === "APPROVED" ? "selected" : ""}>Approved</option>
              <option value="REJECTED" ${requestFilter === "REJECTED" ? "selected" : ""}>Rejected</option>
            </select>
            ${isAdmin() ? `
              <button class="btn small primary" data-action="bulk-review" data-status="APPROVED">✅ Bulk Approve</button>
              <button class="btn small danger" data-action="bulk-review" data-status="REJECTED">❌ Bulk Reject</button>
            ` : ""}
          </div>
        </div>
        <div class="panel-body">
          ${myRequests.length ? `
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    ${isAdmin() ? `<th class="checkbox-cell"><input type="checkbox" data-action="bulk-check-all" /></th>` : ""}
                    <th>User</th>
                    <th>Date</th>
                    <th>Hours</th>
                    <th>Reason</th>
                    <th>Status</th>
                    ${isAdmin() ? "<th>Actions</th>" : ""}
                  </tr>
                </thead>
                <tbody>
                  ${myRequests.map((request) => `
                    <tr>
                      ${isAdmin() ? `<td class="checkbox-cell"><input type="checkbox" data-action="bulk-check" data-request-id="${request.requestId}" ${selectedBulkIds.has(request.requestId) ? "checked" : ""} /></td>` : ""}
                      <td><strong>${escapeHtml(userLabel(request.userEmail))}</strong></td>
                      <td>${formatDate(request.targetDate)}</td>
                      <td>${request.requestedHours}h</td>
                      <td>${escapeHtml(request.reason)}</td>
                      <td><span class="status ${request.status.toLowerCase()}">${request.status}</span></td>
                      ${isAdmin() && request.status === "PENDING" ? `
                        <td>
                          <button class="btn small primary" data-action="review-request" data-request="${request.requestId}" data-status="APPROVED">Approve</button>
                          <button class="btn small danger" data-action="review-request" data-request="${request.requestId}" data-status="REJECTED">Reject</button>
                        </td>
                      ` : isAdmin() ? "<td></td>" : ""}
                    </tr>
                  `).join("")}
                </tbody>
              </table>
            </div>
          ` : `
            <div class="empty-state">
              <div class="empty-state-icon">📋</div>
              <div class="empty-state-title">No requests yet</div>
              <div class="empty-state-desc">Create an update request to adjust hours or change info using the form on the left.</div>
            </div>
          `}
        </div>
      </section>
    </div>
  `;
}

function renderAdminUsers() {
  if (!isAdmin()) return `<div class="error">Admin only.</div>`;
  const filteredUsers = userSearch
    ? state.users.filter(u => u.displayName.toLowerCase().includes(userSearch) || u.email.toLowerCase().includes(userSearch))
    : state.users;
  return `
    <div class="split">
      <section class="panel">
        <div class="panel-header" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
          <h2 class="panel-title">Users (${filteredUsers.length}/${state.users.length})</h2>
          <input class="search-input" type="text" placeholder="🔍 Search users..." value="${escapeHtml(userSearch)}" data-action="search-user" />
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>User ID</th>
                <th>Email</th>
                <th>Name</th>
                <th>Role</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              ${filteredUsers.map((user) => `
                <tr>
                  <td>${escapeHtml(user.userId)}</td>
                  <td>${escapeHtml(user.email)}</td>
                  <td>${escapeHtml(user.displayName)}</td>
                  <td>${user.role}</td>
                  <td><span class="status ${user.status.toLowerCase()}">${user.status}</span></td>
                  <td>${renderUserActions(user)}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </section>
      <section class="panel">
        <div class="panel-header">
          <h2 class="panel-title">Add user</h2>
        </div>
        <div class="panel-body">
          <form class="form" id="user-form">
            <div class="field">
              <label>Email</label>
              <input type="email" name="email" placeholder="member@kyanon.digital" required />
            </div>
            <div class="field">
              <label>Display name</label>
              <input name="displayName" placeholder="Member Name" required />
            </div>
            <div class="field">
              <label>Role</label>
              <select name="role">
                <option value="MEMBER">MEMBER</option>
                <option value="ADMIN">ADMIN</option>
              </select>
            </div>
            <button class="btn primary" type="submit">Add user</button>
          </form>
          <div class="notice" style="margin-top:14px">Mật khẩu mặc định khởi tạo cho thành viên mới là: <strong>Amaze@2026</strong>.</div>
        </div>
      </section>
    </div>
  `;
}

function renderUserActions(user) {
  // Protect admin based on DB setting, not hardcoded email
  const adminEmail = (state.settings?.find(s => s.key === "admin_email")?.value || "hau.nt@kyanon.digital").toLowerCase();
  const resetBtn = `<button class="btn small" data-action="reset-user-password" data-email="${escapeHtml(user.email)}" title="Reset password to default (Amaze@2026)">🔑 Reset Pass</button>`;
  if (user.email.toLowerCase() === adminEmail) return resetBtn;
  if (user.status === "ACTIVE") {
    return `${resetBtn} <button class="btn small danger" data-action="deactivate-user" data-email="${user.email}">Deactivate</button>`;
  }
  return `${resetBtn} <button class="btn small primary" data-action="reactivate-user" data-email="${user.email}">Reactivate</button>`;
}

function renderAdminSchedule() {
  if (!isAdmin()) return `<div class="error">Admin only.</div>`;
  const holidayRows = state.holidaySettings
    .filter((holiday) => holiday.date.startsWith(selectedMonth))
    .sort((a, b) => a.date.localeCompare(b.date));

  return `
    ${renderActionToolbar()}
    <div class="grid cols-2">
      <section class="panel">
        <div class="panel-header">
          <h2 class="panel-title">Create holiday or Tet duration</h2>
        </div>
        <div class="panel-body">
          <form class="form" id="holiday-form">
            <div class="field">
              <label>Start date</label>
              <input type="date" name="startDate" required />
            </div>
            <div class="field">
              <label>End date</label>
              <input type="date" name="endDate" required />
            </div>
            <div class="field">
              <label>Name</label>
              <input name="name" placeholder="Tet holiday" required />
            </div>
            <div class="field">
              <label>Type</label>
              <select name="holidayType">
                <option value="HOLIDAY">HOLIDAY</option>
                <option value="TET">TET</option>
              </select>
            </div>
            <div class="field">
              <label>Required role</label>
              <input name="requiredRole" value="QC/PO" required />
            </div>
            <div class="field">
              <label>Required count</label>
              <input type="number" name="requiredCount" min="1" value="1" required />
            </div>
            <div class="field">
              <label>Hours per person</label>
              <input type="number" name="hoursPerPerson" min="0" value="8" required />
            </div>
            <div class="field">
              <label>Man/month factor</label>
              <input type="number" name="manMonthFactor" min="0" step="0.25" value="1" required />
            </div>
            <div class="field">
              <label>Note</label>
              <textarea name="note"></textarea>
            </div>
            <button class="btn primary" type="submit">Create duration slots</button>
          </form>
        </div>
      </section>
      <section class="panel">
        <div class="panel-header" style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
          <h2 class="panel-title">Configured holiday/Tet days</h2>
          ${renderMonthSelector()}
        </div>
        <div class="panel-body">
          ${holidayRows.length ? `
            <div class="list">
              ${holidayRows.map((holiday) => `
                <div class="item">
                  <div class="item-title">${formatDate(holiday.date)} - ${escapeHtml(holiday.name)}</div>
                  <div class="item-meta">${holiday.holidayType} / ${escapeHtml(holiday.requiredRole)} / ${holiday.requiredCount} person / ${holiday.hoursPerPerson}h</div>
                </div>
              `).join("")}
            </div>
          ` : `<div class="empty">No holiday or Tet setup for this month.</div>`}
        </div>
      </section>
    </div>
    
    <section class="panel" style="margin-top: 16px;">
      <div class="panel-header">
        <h2 class="panel-title">Google Chat Notifications</h2>
      </div>
      <div class="panel-body">
        <form class="form" id="chat-settings-form">
          <div class="field">
            <label>Google Chat Webhook URL</label>
            <input type="url" name="webhookUrl" placeholder="https://chat.googleapis.com/v1/spaces/..." value="${escapeHtml(getSettingValueClient('google_chat_webhook_url'))}" />
          </div>
          <div class="actions" style="margin-top: 12px;">
            <button class="btn primary small" type="submit">Save Settings</button>
            <button class="btn small" type="button" data-action="test-chat">Send Test Message</button>
            <button class="btn small" type="button" data-action="trigger-reminders">Send Tomorrow's Reminders</button>
            <button class="btn small" type="button" data-action="sync-taiga" title="Đồng bộ / Sao lưu toàn bộ dữ liệu ca trực và đăng ký từ Taiga về hệ thống">🔄 Sync/Backup from Taiga</button>
          </div>
        </form>
        <div class="notice" style="margin-top: 14px; margin-bottom: 0;">
          Configure the Google Chat Webhook URL to send automatic alerts on registration, cancellation, review actions, and daily 5:00 PM reminders.
        </div>
      </div>
    </section>
    <section class="panel" style="margin-top: 16px;">
      <div class="panel-header">
        <h2 class="panel-title">Notification History</h2>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Type</th>
              <th>Message</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            ${(state.chatNotifications || []).slice(-20).reverse().map(n => `
              <tr>
                <td>${n.sentAt ? new Date(n.sentAt).toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }) : "N/A"}</td>
                <td>${escapeHtml(n.type || "CHAT")}</td>
                <td class="notif-message" title="${escapeHtml(n.message || "")}">${escapeHtml((n.message || "").slice(0, 60))}${(n.message || "").length > 60 ? "..." : ""}</td>
                <td><span class="status ${(n.status || "sent").toLowerCase()}">${n.status || "SENT"}</span></td>
                <td>${n.status === "FAILED" ? `<button class="btn small" data-action="resend-notif" data-notif-id="${n.notificationId}">Resend</button>` : ""}</td>
              </tr>
            `).join("") || `<tr><td colspan="5" class="empty">No notifications yet.</td></tr>`}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function bindShellEvents() {
  document.querySelectorAll("[data-nav]").forEach((button) => {
    button.addEventListener("click", () => {
      view = button.dataset.nav;
      render();
    });
  });

  document.querySelector("[data-action='logout']")?.addEventListener("click", async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch (err) {
      console.error("Backend logout failed", err);
    }
    localStorage.removeItem("ot-support-session");
    session = null;
    render();
  });

  document.querySelectorAll("[data-action='today-month']").forEach((btn) => {
    btn.addEventListener("click", () => {
      const today = new Date();
      selectedMonth = monthKey(today);
      loadStateFromDb(false, selectedMonth);
    });
  });

  document.querySelectorAll("[data-action='prev-month']").forEach((btn) => {
    btn.addEventListener("click", () => {
      const date = parseLocalDate(`${selectedMonth}-01`);
      date.setMonth(date.getMonth() - 1);
      selectedMonth = monthKey(date);
      loadStateFromDb(false, selectedMonth);
    });
  });

  document.querySelectorAll("[data-action='next-month']").forEach((btn) => {
    btn.addEventListener("click", () => {
      const date = parseLocalDate(`${selectedMonth}-01`);
      date.setMonth(date.getMonth() + 1);
      selectedMonth = monthKey(date);
      loadStateFromDb(false, selectedMonth);
    });
  });

  document.querySelectorAll("[data-action='select-month']").forEach((select) => {
    select.addEventListener("change", (e) => {
      const [year] = selectedMonth.split("-");
      const monthVal = e.target.value;
      selectedMonth = `${year}-${monthVal}`;
      loadStateFromDb(false, selectedMonth);
    });
  });

  document.querySelectorAll("[data-action='select-year']").forEach((select) => {
    select.addEventListener("change", (e) => {
      const [, month] = selectedMonth.split("-");
      const yearVal = e.target.value;
      selectedMonth = `${yearVal}-${month}`;
      loadStateFromDb(false, selectedMonth);
    });
  });

  document.querySelector("[data-action='refresh-db']")?.addEventListener("click", () => {
    loadStateFromDb(true, selectedMonth);
  });

  document.querySelector("[data-action='export-preview']")?.addEventListener("click", () => {
    window.location.href = `/api/export?month=${selectedMonth}`;
  });

  document.querySelectorAll("[data-action='focus-slot']").forEach((button) => {
    button.addEventListener("click", () => {
      openSlotModal(button.dataset.slot);
    });
  });

  document.querySelectorAll("[data-action='modal-close']").forEach((element) => {
    element.addEventListener("click", (event) => {
      if (event.target !== element && element.classList.contains("modal-backdrop")) return;
      modal = null;
      render();
    });
  });

  document.querySelector("[data-action='modal-confirm-register']")?.addEventListener("click", async () => {
    if (!modal?.slotId) return;
    const slotId = modal.slotId;
    const selectedMember = document.querySelector("[data-action='modal-member-select']")?.value;
    const targetEmail = isAdmin() && selectedMember ? selectedMember : session.email;
    modal = null;
    await registerSlot(slotId, targetEmail);
  });

  document.querySelector("[data-action='modal-confirm-cancel']")?.addEventListener("click", async () => {
    if (!modal?.registrationId) return;
    const registrationId = modal.registrationId;
    modal = null;
    await cancelRegistration(registrationId);
  });

  document.querySelectorAll("[data-action='admin-cancel-reg']").forEach((button) => {
    button.addEventListener("click", async () => {
      const regId = button.dataset.regId;
      modal = null;
      await cancelRegistration(regId);
    });
  });

  document.querySelector("#request-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try {
      saveStatus = "saving";
      render();
      const response = await fetch("/api/update-requests/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetDate: data.targetDate,
          requestedHours: Number(data.requestedHours),
          reason: data.reason,
          evidenceUrl: data.evidenceUrl
        })
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Cannot submit update request.");
      state = {
        ...emptyState(),
        ...payload.state
      };
      saveStatus = "saved";
      showToast("Update request submitted successfully!");
      render();
    } catch (error) {
      saveStatus = `error: ${error.message}`;
      showToast("Error submitting request: " + error.message, "error");
      render();
    }
  });

  document.querySelectorAll("[data-action='review-request']").forEach((button) => {
    button.addEventListener("click", async () => {
      const requestId = button.dataset.request;
      const status = button.dataset.status;
      try {
        saveStatus = "saving";
        render();
        const response = await fetch("/api/update-requests/review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestId, status })
        });
        const payload = await response.json();
        if (!response.ok || !payload.ok) throw new Error(payload.error || "Cannot review update request.");
        state = {
          ...emptyState(),
          ...payload.state
        };
        saveStatus = "saved";
        showToast(`Request ${status === "APPROVED" ? "approved" : "rejected"} successfully!`);
        render();
      } catch (error) {
        saveStatus = `error: ${error.message}`;
        showToast("Error reviewing request: " + error.message, "error");
        render();
      }
    });
  });

  document.querySelector("#user-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    const email = data.email.trim().toLowerCase();
    try {
      saveStatus = "saving";
      render();
      const response = await fetch("/api/users/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          displayName: data.displayName.trim(),
          role: data.role
        })
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Cannot add user.");
      state = {
        ...emptyState(),
        ...payload.state
      };
      saveStatus = "saved";
      showToast("User added successfully!");
      render();
    } catch (error) {
      saveStatus = `error: ${error.message}`;
      showToast("Error adding user: " + error.message, "error");
      render();
    }
  });

  document.querySelectorAll("[data-action='deactivate-user'], [data-action='reactivate-user']").forEach((button) => {
    button.addEventListener("click", async () => {
      const email = button.dataset.email;
      const status = button.dataset.action === "deactivate-user" ? "INACTIVE" : "ACTIVE";
      try {
        saveStatus = "saving";
        render();
        const response = await fetch("/api/users/status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, status })
        });
        const payload = await response.json();
        if (!response.ok || !payload.ok) throw new Error(payload.error || "Cannot update user status.");
        state = {
          ...emptyState(),
          ...payload.state
        };
        saveStatus = "saved";
        showToast(`User ${status === "ACTIVE" ? "activated" : "deactivated"} successfully!`);
        render();
      } catch (error) {
        saveStatus = `error: ${error.message}`;
        showToast("Error updating user status: " + error.message, "error");
        render();
      }
    });
  });

  document.querySelectorAll("[data-action='reset-user-password']").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const email = btn.dataset.email;
      if (!confirm(`Are you sure you want to reset password for ${email} to default (Amaze@2026)?`)) return;
      try {
        const res = await fetch("/api/admin/users/reset-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email })
        });
        const result = await res.json();
        if (!res.ok || !result.ok) throw new Error(result.error || "Failed to reset password");
        showToast(result.message || `Password reset for ${email}!`);
      } catch (err) {
        showToast(err.message, "error");
      }
    });
  });

  document.querySelector("#change-password-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    if (data.newPassword !== data.confirmPassword) {
      showToast("New passwords do not match!", "error");
      return;
    }
    if (data.newPassword.length < 6) {
      showToast("New password must be at least 6 characters!", "error");
      return;
    }
    try {
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: data.currentPassword, newPassword: data.newPassword })
      });
      const result = await res.json();
      if (!res.ok || !result.ok) throw new Error(result.error || "Failed to update password");
      showToast("Password updated successfully!");
      event.target.reset();
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  document.querySelector("#holiday-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try {
      saveStatus = "saving";
      render();
      const response = await fetch("/api/holidays/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startDate: data.startDate,
          endDate: data.endDate,
          name: data.name,
          holidayType: data.holidayType,
          requiredRole: data.requiredRole,
          requiredCount: Number(data.requiredCount),
          hoursPerPerson: Number(data.hoursPerPerson),
          manMonthFactor: Number(data.manMonthFactor),
          note: data.note
        })
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Cannot create holiday slots.");
      state = {
        ...emptyState(),
        ...payload.state
      };
      selectedMonth = data.startDate.slice(0, 7);
      saveStatus = "saved";
      showToast("Holiday slots created successfully!");
      render();
    } catch (error) {
      saveStatus = `error: ${error.message}`;
      showToast("Error creating holiday slots: " + error.message, "error");
      render();
    }
  });

  document.querySelector("#chat-settings-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const response = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "google_chat_webhook_url", value: data.webhookUrl.trim() })
      });
      if (response.ok) {
        showToast("Settings saved successfully.");
        await loadStateFromDb(false, selectedMonth);
      } else {
        showToast("Failed to save settings.", "error");
      }
    } catch (err) {
      showToast("Error saving settings: " + err.message, "error");
    }
  });

  document.querySelector("[data-action='test-chat']")?.addEventListener("click", async () => {
    const btn = document.querySelector("[data-action='test-chat']");
    btn.disabled = true;
    try {
      const response = await fetch("/api/chat/test", { method: "POST" });
      const data = await response.json();
      if (response.ok && data.ok) {
        showToast("Test message sent! Check Google Chat.");
      } else {
        showToast("Failed to send test. Check webhook URL.", "error");
      }
    } catch (err) {
      showToast("Error: " + err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });

  document.querySelector("[data-action='trigger-reminders']")?.addEventListener("click", async () => {
    const btn = document.querySelector("[data-action='trigger-reminders']");
    btn.disabled = true;
    try {
      const response = await fetch("/api/chat/trigger-reminders", { method: "POST" });
      const data = await response.json();
      if (response.ok && data.ok) {
        showToast(`Reminders sent: ${data.sentCount}, Open warned: ${data.openCount}`);
        await loadStateFromDb(false, selectedMonth);
      } else {
        showToast("Failed to trigger reminders.", "error");
      }
    } catch (err) {
      showToast("Error: " + err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });

  document.querySelector("[data-action='sync-taiga']")?.addEventListener("click", async () => {
    if (!confirm("Bạn có muốn đồng bộ toàn bộ dữ liệu ca trực và đăng ký từ Taiga về hệ thống không?")) return;
    const btn = document.querySelector("[data-action='sync-taiga']");
    if (btn) btn.disabled = true;
    showToast("Đang đồng bộ dữ liệu từ Taiga...", "info");
    try {
      const response = await fetch("/api/admin/taiga-sync", { method: "POST" });
      const data = await response.json();
      if (response.ok && data.ok) {
        showToast(`Đồng bộ thành công! (${data.registrationsCount || 0} lượt đăng ký)`, "success");
        if (data.state) {
          state = { ...emptyState(), ...data.state };
          render();
        } else {
          await loadStateFromDb(false, selectedMonth);
        }
      } else {
        showToast(`Đồng bộ thất bại: ${data.error || "Lỗi kết nối Taiga"}`, "error");
      }
    } catch (err) {
      showToast("Lỗi: " + err.message, "error");
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  // ===== New Event Handlers =====

  // Sidebar toggle (mobile)
  document.querySelector("[data-action='toggle-sidebar']")?.addEventListener("click", () => {
    sidebarOpen = !sidebarOpen;
    document.querySelector(".sidebar")?.classList.toggle("open", sidebarOpen);
    document.querySelector(".sidebar-overlay")?.classList.toggle("show", sidebarOpen);
  });
  document.querySelector("[data-action='close-sidebar']")?.addEventListener("click", () => {
    sidebarOpen = false;
    document.querySelector(".sidebar")?.classList.remove("open");
    document.querySelector(".sidebar-overlay")?.classList.remove("show");
  });

  // Dark mode toggle
  document.querySelector("[data-action='toggle-theme']")?.addEventListener("click", () => {
    darkMode = !darkMode;
    localStorage.setItem("ot-dark-mode", darkMode);
    document.documentElement.setAttribute("data-theme", darkMode ? "dark" : "");
    render();
  });

  // Slot status filter
  document.querySelector("[data-action='filter-slot']")?.addEventListener("change", (e) => {
    slotFilter = e.target.value;
    render();
  });

  // Request status filter
  document.querySelector("[data-action='filter-request']")?.addEventListener("change", (e) => {
    requestFilter = e.target.value;
    render();
  });

  // User search
  document.querySelector("[data-action='search-user']")?.addEventListener("input", (e) => {
    userSearch = e.target.value.toLowerCase();
    render();
  });



  // Swap ca trực (Admin)
  document.querySelector("[data-action='modal-confirm-swap']")?.addEventListener("click", async () => {
    if (!modal?.slotId) return;
    const slotId = modal.slotId;
    const fromSelect = document.querySelector("[data-action='swap-from-select']");
    const toSelect = document.querySelector("[data-action='swap-to-select']");
    const fromEmail = fromSelect?.value;
    const toEmail = toSelect?.value;
    if (!fromEmail || !toEmail) return;
    modal = null;
    try {
      saveStatus = "saving";
      render();
      const response = await fetch("/api/slots/swap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slotId, fromEmail, toEmail })
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Cannot swap.");
      state = { ...emptyState(), ...payload.state };
      saveStatus = "saved";
      showToast("Shift swapped successfully!");
      render();
    } catch (error) {
      saveStatus = `error: ${error.message}`;
      showToast("Swap error: " + error.message, "error");
      render();
    }
  });

  // Bulk review
  document.querySelectorAll("[data-action='bulk-check']").forEach(cb => {
    cb.addEventListener("change", (e) => {
      if (e.target.checked) selectedBulkIds.add(e.target.dataset.requestId);
      else selectedBulkIds.delete(e.target.dataset.requestId);
    });
  });
  document.querySelector("[data-action='bulk-check-all']")?.addEventListener("change", (e) => {
    const checkboxes = document.querySelectorAll("[data-action='bulk-check']");
    checkboxes.forEach(cb => {
      cb.checked = e.target.checked;
      if (e.target.checked) selectedBulkIds.add(cb.dataset.requestId);
      else selectedBulkIds.delete(cb.dataset.requestId);
    });
  });
  document.querySelectorAll("[data-action='bulk-review']").forEach(btn => {
    btn.addEventListener("click", async () => {
      const status = btn.dataset.status;
      if (selectedBulkIds.size === 0) return showToast("Select at least 1 request.", "warning");
      try {
        saveStatus = "saving";
        render();
        const response = await fetch("/api/update-requests/bulk-review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestIds: [...selectedBulkIds], status })
        });
        const payload = await response.json();
        if (!response.ok || !payload.ok) throw new Error(payload.error || "Bulk review failed.");
        state = { ...emptyState(), ...payload.state };
        selectedBulkIds.clear();
        saveStatus = "saved";
        showToast(`${status === "APPROVED" ? "Approved" : "Rejected"} ${payload.processed} requests.`);
        render();
      } catch (error) {
        saveStatus = `error: ${error.message}`;
        showToast("Error: " + error.message, "error");
        render();
      }
    });
  });

  // Resend notification
  document.querySelectorAll("[data-action='resend-notif']").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.notifId;
      try {
        const response = await fetch("/api/chat/resend", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ notificationId: id })
        });
        const data = await response.json();
        if (data.ok) showToast("Notification resent!");
        else showToast("Resend failed.", "error");
      } catch (err) {
        showToast("Error: " + err.message, "error");
      }
    });
  });

  // Confirm review request (modal version)
  document.querySelector("[data-action='modal-confirm-review']")?.addEventListener("click", async () => {
    if (!modal?.requestId) return;
    const requestId = modal.requestId;
    const status = modal.reviewStatus;
    modal = null;
    try {
      saveStatus = "saving";
      render();
      const response = await fetch("/api/update-requests/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, status })
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Cannot review.");
      state = { ...emptyState(), ...payload.state };
      saveStatus = "saved";
      showToast(`Request ${status === "APPROVED" ? "approved" : "rejected"} successfully!`);
      render();
    } catch (error) {
      saveStatus = `error: ${error.message}`;
      showToast("Error: " + error.message, "error");
      render();
    }
  });

}

// ===== Profile View =====
function renderProfile() {
  const allSlots = state.scheduleSlots || [];
  const allRegs = (state.registrations || []).filter(r => r.userEmail.toLowerCase() === session.email.toLowerCase() && r.status === "ACTIVE");
  const allRequests = (state.updateRequests || []).filter(r => r.userEmail.toLowerCase() === session.email.toLowerCase());

  const totalDays = allRegs.length;
  const totalHours = allRegs.reduce((sum, r) => sum + getRegistrationHours(r), 0);
  const totalManMonth = allRegs.reduce((sum, r) => sum + getRegistrationManMonth(r), 0);

  return `
    <div class="profile-stats">
      ${metric("Total support days", totalDays)}
      ${metric("Total hours", totalHours)}
      ${metric("Man/month factor", totalManMonth.toFixed(2))}
    </div>
    <section class="panel">
      <div class="panel-header">
        <h2 class="panel-title">Registration History (${selectedMonth})</h2>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Date</th><th>Type</th><th>Hours</th><th>Status</th></tr></thead>
          <tbody>
            ${allRegs.length ? allRegs.map(r => {
              const slot = allSlots.find(s => s.slotId === r.slotId);
              return `<tr>
                <td><strong>${slot ? formatDate(slot.date) : "N/A"}</strong></td>
                <td>${slot?.slotType || ""}</td>
                <td>${getRegistrationHours(r)}h</td>
                <td><span class="status active">ACTIVE</span></td>
              </tr>`;
            }).join("") : `<tr><td colspan="4" class="empty">No registrations this month.</td></tr>`}
          </tbody>
        </table>
      </div>
    </section>
    <section class="panel" style="margin-top:16px">
      <div class="panel-header">
        <h2 class="panel-title">My Update Requests</h2>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Date</th><th>Hours</th><th>Reason</th><th>Status</th></tr></thead>
          <tbody>
            ${allRequests.length ? allRequests.map(r => `
              <tr>
                <td>${formatDate(r.targetDate)}</td>
                <td>${r.requestedHours}h</td>
                <td>${escapeHtml(r.reason)}</td>
                <td><span class="status ${r.status.toLowerCase()}">${r.status}</span></td>
              </tr>
            `).join("") : `<tr><td colspan="4" class="empty">No requests yet.</td></tr>`}
          </tbody>
        </table>
      </div>
    </section>
    <section class="panel" style="margin-top:16px">
      <div class="panel-header">
        <h2 class="panel-title">Change Password</h2>
      </div>
      <div class="panel-body">
        <form class="form" id="change-password-form" style="max-width:420px">
          <div class="field">
            <label>Current Password</label>
            <input type="password" name="currentPassword" required placeholder="••••••••" />
          </div>
          <div class="field">
            <label>New Password (min 6 characters)</label>
            <input type="password" name="newPassword" minlength="6" required placeholder="••••••••" />
          </div>
          <div class="field">
            <label>Confirm New Password</label>
            <input type="password" name="confirmPassword" minlength="6" required placeholder="••••••••" />
          </div>
          <button class="btn primary" type="submit">Update Password</button>
        </form>
      </div>
    </section>
  `;
}

// ===== SSE Connection =====
function connectSSE() {
  if (sseSource) return;
  try {
    sseSource = new EventSource("/api/events");
    sseSource.addEventListener("registration", (e) => {
      const data = JSON.parse(e.data);
      if (data.action === "register") {
        showToast(`${data.displayName} registered for ${data.date}`, "info");
      } else if (data.action === "cancel") {
        showToast(`${data.displayName} cancelled registration for ${data.date}`, "warning");
      } else if (data.action === "swap") {
        showToast(`Shift swap: ${data.fromEmail} → ${data.toEmail}`, "info");
      }
      loadStateFromDb(false, selectedMonth, true);
    });
    sseSource.addEventListener("review", (e) => {
      const data = JSON.parse(e.data);
      showToast(`${data.count} requests ${data.status === "APPROVED" ? "approved" : "rejected"}`, "info");
      loadStateFromDb(false, selectedMonth, true);
    });
    sseSource.onerror = () => {
      sseSource?.close();
      sseSource = null;
      setTimeout(connectSSE, 5000);
    };
  } catch (e) {
    console.warn("SSE not available:", e);
  }
}

// ===== Keyboard Shortcuts =====
document.addEventListener("keydown", (e) => {
  if (!session || e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") return;

  if (e.key === "ArrowLeft") {
    const date = parseLocalDate(`${selectedMonth}-01`);
    date.setMonth(date.getMonth() - 1);
    selectedMonth = monthKey(date);
    loadStateFromDb(false, selectedMonth);
  }
  if (e.key === "ArrowRight") {
    const date = parseLocalDate(`${selectedMonth}-01`);
    date.setMonth(date.getMonth() + 1);
    selectedMonth = monthKey(date);
    loadStateFromDb(false, selectedMonth);
  }
  if (e.key === "t" || e.key === "T") {
    selectedMonth = monthKey(new Date());
    loadStateFromDb(false, selectedMonth);
  }
  if (e.key === "r" || e.key === "R") {
    loadStateFromDb(true, selectedMonth);
  }
  if (e.key === "Escape") {
    if (modal) { modal = null; render(); }
    if (sidebarOpen) { sidebarOpen = false; render(); }
  }
});

function userLabel(email) {
  const user = state.users.find((item) => item.email.toLowerCase() === email.toLowerCase());
  return user?.displayName || email;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

loadStateFromDb(false, selectedMonth);

// Auto-polling background synchronization (every 30 seconds)
setInterval(async () => {
  if (session && document.visibilityState === "visible" && !isRefreshing && !isBootstrapping) {
    console.log("[POLLING] Fetching latest state from server...");
    await loadStateFromDb(false, selectedMonth, true);
  }
}, 30 * 1000);

// ==========================================
// VIETNAMESE LUNAR CALENDAR ALGORITHM
// (C) 2004 Ho Ngoc Duc. Adapted for client-side
// ==========================================
const TK19 = [
  0x30baa3, 0x56ab50, 0x422ba0, 0x2cab61, 0x52a370, 0x3c51e8, 0x60d160, 0x4ae4b0, 0x376926, 0x58daa0,
  0x445b50, 0x3116d2, 0x562ae0, 0x3ea2e0, 0x28e2d2, 0x4ec950, 0x38d556, 0x5cb520, 0x46b690, 0x325da4,
  0x5855d0, 0x4225d0, 0x2ca5b3, 0x52a2b0, 0x3da8b7, 0x60a950, 0x4ab4a0, 0x35b2a5, 0x5aad50, 0x4455b0,
  0x302b74, 0x562570, 0x4052f9, 0x6452b0, 0x4e6950, 0x386d56, 0x5e5aa0, 0x46ab50, 0x3256d4, 0x584ae0,
  0x42a570, 0x2d4553, 0x50d2a0, 0x3be8a7, 0x60d550, 0x4a5aa0, 0x34ada5, 0x5a95d0, 0x464ae0, 0x2eaab4,
  0x54a4d0, 0x3ed2b8, 0x64b290, 0x4cb550, 0x385757, 0x5e2da0, 0x4895d0, 0x324d75, 0x5849b0, 0x42a4b0,
  0x2da4b3, 0x506a90, 0x3aad98, 0x606b50, 0x4c2b60, 0x359365, 0x5a9370, 0x464970, 0x306964, 0x52e4a0,
  0x3cea6a, 0x62da90, 0x4e5ad0, 0x392ad6, 0x5e2ae0, 0x4892e0, 0x32cad5, 0x56c950, 0x40d4a0, 0x2bd4a3,
  0x50b690, 0x3a57a7, 0x6055b0, 0x4c25d0, 0x3695b5, 0x5a92b0, 0x44a950, 0x2ed954, 0x54b4a0, 0x3cb550,
  0x286b52, 0x4e55b0, 0x3a2776, 0x5e2570, 0x4852b0, 0x32aaa5, 0x56e950, 0x406aa0, 0x2abaa3, 0x50ab50
];
const TK20 = [
  0x3c4bd8, 0x624ae0, 0x4ca570, 0x3854d5, 0x5cd260, 0x44d950, 0x315554, 0x5656a0, 0x409ad0, 0x2a55d2,
  0x504ae0, 0x3aa5b6, 0x60a4d0, 0x48d250, 0x33d255, 0x58b540, 0x42d6a0, 0x2cada2, 0x5295b0, 0x3f4977,
  0x644970, 0x4ca4b0, 0x36b4b5, 0x5c6a50, 0x466d40, 0x2fab54, 0x562b60, 0x409570, 0x2c52f2, 0x504970,
  0x3a6566, 0x5ed4a0, 0x48ea50, 0x336a95, 0x585ad0, 0x442b60, 0x2f86e3, 0x5292e0, 0x3dc8d7, 0x62c950,
  0x4cd4a0, 0x35d8a6, 0x5ab550, 0x4656a0, 0x31a5b4, 0x5625d0, 0x4092d0, 0x2ad2b2, 0x50a950, 0x38b557,
  0x5e6ca0, 0x48b550, 0x355355, 0x584da0, 0x42a5b0, 0x2f4573, 0x5452b0, 0x3ca9a8, 0x60e950, 0x4c6aa0,
  0x36aea6, 0x5aab50, 0x464b60, 0x30aae4, 0x56a570, 0x405260, 0x28f263, 0x4ed940, 0x38db47, 0x5cd6a0,
  0x4896d0, 0x344dd5, 0x5a4ad0, 0x42a4d0, 0x2cd4b4, 0x52b250, 0x3cd558, 0x60b540, 0x4ab5a0, 0x3755a6,
  0x5c95b0, 0x4649b0, 0x30a974, 0x56a4b0, 0x40aa50, 0x29aa52, 0x4e6d20, 0x39ad47, 0x5eab60, 0x489370,
  0x344af5, 0x5a4970, 0x4464b0, 0x2c74a3, 0x50ea50, 0x3d6a58, 0x6256a0, 0x4aaad0, 0x3696d5, 0x5c92e0
];
const TK21 = [
  0x46c960, 0x2ed954, 0x54d4a0, 0x3eda50, 0x2a7552, 0x4e56a0, 0x38a7a7, 0x5ea5d0, 0x4a92b0, 0x32aab5,
  0x58a950, 0x42b4a0, 0x2cbaa4, 0x50ad50, 0x3c55d9, 0x624ba0, 0x4ca5b0, 0x375176, 0x5c5270, 0x466930,
  0x307934, 0x546aa0, 0x3ead50, 0x2a5b52, 0x504b60, 0x38a6e6, 0x5ea4e0, 0x48d260, 0x32ea65, 0x56d520,
  0x40daa0, 0x2d56a3, 0x5256d0, 0x3c4afb, 0x6249d0, 0x4ca4d0, 0x37d0b6, 0x5ab250, 0x44b520, 0x2edd25,
  0x54b5a0, 0x3e55d0, 0x2a55b2, 0x5049b0, 0x3aa577, 0x5ea4b0, 0x48aa50, 0x33b255, 0x586d20, 0x40ad60,
  0x2d4b63, 0x525370, 0x3e49e8, 0x60c970, 0x4c54b0, 0x3768a6, 0x5ada50, 0x445aa0, 0x2fa6a4, 0x54aad0,
  0x4052e0, 0x28d2e3, 0x4ec950, 0x38d557, 0x5ed4a0, 0x46d950, 0x325d55, 0x5856a0, 0x42a6d0, 0x2c55d4,
  0x5252b0, 0x3ca9b8, 0x62a930, 0x4ab490, 0x34b6a6, 0x5aad50, 0x4655a0, 0x2eab64, 0x54a570, 0x4052b0,
  0x2ab173, 0x4e6930, 0x386b37, 0x5e6aa0, 0x48ad50, 0x332ad5, 0x582b60, 0x42a570, 0x2e52e4, 0x50d160,
  0x3ae958, 0x60d520, 0x4ada90, 0x355aa6, 0x5a56d0, 0x462ae0, 0x30a9d4, 0x54a2d0, 0x3ed150, 0x28e952
];
const TK22 = [
  0x4eb520, 0x38d727, 0x5eada0, 0x4a55b0, 0x362db5, 0x5a45b0, 0x44a2b0, 0x2eb2b4, 0x54a950, 0x3cb559,
  0x626b20, 0x4cad50, 0x385766, 0x5c5370, 0x484570, 0x326574, 0x5852b0, 0x406950, 0x2a7953, 0x505aa0,
  0x3baaa7, 0x5ea6d0, 0x4a4ae0, 0x35a2e5, 0x5aa550, 0x42d2a0, 0x2de2a4, 0x52d550, 0x3e5abb, 0x6256a0,
  0x4c96d0, 0x3949b6, 0x5e4ab0, 0x46a8d0, 0x30d4b5, 0x56b290, 0x40b550, 0x2a6d52, 0x504da0, 0x3b9567,
  0x609570, 0x4a49b0, 0x34a975, 0x5a64b0, 0x446a90, 0x2cba94, 0x526b50, 0x3e2b60, 0x28ab61, 0x4c9570,
  0x384ae6, 0x5cd160, 0x46e4a0, 0x2eed25, 0x54da90, 0x405b50, 0x2c36d3, 0x502ae0, 0x3a93d7, 0x6092d0,
  0x4ac950, 0x32d556, 0x58b4a0, 0x42b690, 0x2e5d94, 0x5255b0, 0x3e25fa, 0x6425b0, 0x4e92b0, 0x36aab6,
  0x5c6950, 0x4674a0, 0x31b2a5, 0x54ad50, 0x4055a0, 0x2aab73, 0x522570, 0x3a5377, 0x6052b0, 0x4a6950,
  0x346d56, 0x585aa0, 0x42ab50, 0x2e56d4, 0x544ae0, 0x3ca570, 0x2864d2, 0x4cd260, 0x36eaa6, 0x5ad550,
  0x465aa0, 0x30ada5, 0x5695d0, 0x404ad0, 0x2aa9b3, 0x50a4d0, 0x3ad2b7, 0x5eb250, 0x48b540, 0x33d556
];

function LunarDate(dd, mm, yy, leap, jd) {
  this.day = dd;
  this.month = mm;
  this.year = yy;
  this.leap = leap;
  this.jd = jd;
}

function INT(d) {
  return Math.floor(d);
}

function jdn(dd, mm, yy) {
  const a = INT((14 - mm) / 12);
  const y = yy + 4800 - a;
  const m = mm + 12 * a - 3;
  return dd + INT((153 * m + 2) / 5) + 365 * y + INT(y / 4) - INT(y / 100) + INT(y / 400) - 32045;
}

function decodeLunarYear(yy, k) {
  const ly = [];
  const monthLengths = [29, 30];
  const regularMonths = new Array(12);
  const offsetOfTet = k >> 17;
  const leapMonth = k & 0xf;
  const leapMonthLength = monthLengths[(k >> 16) & 0x1];
  const solarNY = jdn(1, 1, yy);
  let currentJD = solarNY + offsetOfTet;
  let j = k >> 4;
  for (let i = 0; i < 12; i++) {
    regularMonths[12 - i - 1] = monthLengths[j & 0x1];
    j >>= 1;
  }
  if (leapMonth === 0) {
    for (let mm = 1; mm <= 12; mm++) {
      ly.push(new LunarDate(1, mm, yy, 0, currentJD));
      currentJD += regularMonths[mm - 1];
    }
  } else {
    for (let mm = 1; mm <= leapMonth; mm++) {
      ly.push(new LunarDate(1, mm, yy, 0, currentJD));
      currentJD += regularMonths[mm - 1];
    }
    ly.push(new LunarDate(1, leapMonth, yy, 1, currentJD));
    currentJD += leapMonthLength;
    for (let mm = leapMonth + 1; mm <= 12; mm++) {
      ly.push(new LunarDate(1, mm, yy, 0, currentJD));
      currentJD += regularMonths[mm - 1];
    }
  }
  return ly;
}

function getYearInfo(yyyy) {
  let yearCode;
  if (yyyy < 1900) {
    yearCode = TK19[yyyy - 1800];
  } else if (yyyy < 2000) {
    yearCode = TK20[yyyy - 1900];
  } else if (yyyy < 2100) {
    yearCode = TK21[yyyy - 2000];
  } else {
    yearCode = TK22[yyyy - 2100];
  }
  return decodeLunarYear(yyyy, yearCode);
}

const FIRST_DAY = jdn(25, 1, 1800);
const LAST_DAY = jdn(31, 12, 2199);

function findLunarDate(jd, ly) {
  if (jd > LAST_DAY || jd < FIRST_DAY || ly[0].jd > jd) {
    return new LunarDate(0, 0, 0, 0, jd);
  }
  let i = ly.length - 1;
  while (jd < ly[i].jd) {
    i--;
  }
  const off = jd - ly[i].jd;
  return new LunarDate(ly[i].day + off, ly[i].month, ly[i].year, ly[i].leap, jd);
}

function getLunarDate(dd, mm, yyyy) {
  let ly = getYearInfo(yyyy);
  const jd = jdn(dd, mm, yyyy);
  if (jd < ly[0].jd) {
    ly = getYearInfo(yyyy - 1);
  }
  return findLunarDate(jd, ly);
}

function getLunarDayText(date) {
  const d = date.getDate();
  const m = date.getMonth() + 1;
  const y = date.getFullYear();
  const lunar = getLunarDate(d, m, y);
  if (!lunar || lunar.day === 0) return "";
  
  if (lunar.day === 1) {
    return `${lunar.day}/${lunar.month}${lunar.leap ? 'n' : ''}`;
  }
  return `${lunar.day}`;
}

function getHolidayLabel(date) {
  const d = date.getDate();
  const m = date.getMonth() + 1;
  const y = date.getFullYear();
  
  // 1. Check solar holidays
  if (d === 1 && m === 1) return "New Year's Day";
  if (d === 30 && m === 4) return "Reunification Day";
  if (d === 1 && m === 5) return "Labour Day";
  if (d === 2 && m === 9) return "National Day";
  
  // 2. Check lunar holidays
  const lunar = getLunarDate(d, m, y);
  if (lunar && lunar.day !== 0) {
    const ld = lunar.day;
    const lm = lunar.month;
    
    // Giỗ Tổ Hùng Vương: 10/3 âm lịch
    if (ld === 10 && lm === 3 && !lunar.leap) {
      return "Hung Kings' Day";
    }
    
    // Tết Nguyên Đán: 30/12 (hoặc 29/12) đến 5/1 âm lịch
    // Tất niên / Giao thừa
    const nextDay = new Date(date);
    nextDay.setDate(nextDay.getDate() + 1);
    const nextLunar = getLunarDate(nextDay.getDate(), nextDay.getMonth() + 1, nextDay.getFullYear());
    if (nextLunar && nextLunar.day === 1 && nextLunar.month === 1 && !nextLunar.leap) {
      return "Lunar New Year's Eve";
    }

    if (lm === 1 && (ld === 1 || ld === 2 || ld === 3 || ld === 4 || ld === 5) && !lunar.leap) {
      return "Lunar New Year";
    }
  }

  // 3. Fallback to holidaySettings in database
  const key = dateKey(date);
  if (state.holidaySettings) {
    const holiday = state.holidaySettings.find(h => h.date === key);
    if (holiday) return holiday.name;
  }

  // Also check scheduleSlots of type HOLIDAY or TET
  if (state.scheduleSlots) {
    const slot = state.scheduleSlots.find(s => s.date === key && (s.slotType === "HOLIDAY" || s.slotType === "TET"));
    if (slot) return slot.title;
  }
  
  return null;
}

