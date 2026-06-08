const COMPANY_DOMAIN = "kyanon.digital";
const ADMIN_EMAIL = "hau.nt@kyanon.digital";

let state = emptyState();
let session = loadSession();
let view = "dashboard";
let selectedMonth = monthKey(new Date());
let modal = null;
let isBootstrapping = true;
let bootstrapError = "";
let saveStatus = "";
let saveTimer = null;

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

async function loadStateFromDb() {
  isBootstrapping = true;
  bootstrapError = "";
  render();

  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || "Cannot load Google Sheets DB.");
    state = {
      ...emptyState(),
      ...payload.state
    };
    isBootstrapping = false;
    bootstrapError = "";
    saveStatus = "";
    ensureMonth(selectedMonth);
    render();
  } catch (error) {
    isBootstrapping = false;
    bootstrapError = error.message;
    render();
  }
}

async function saveStateToDb() {
  try {
    const response = await fetch("/api/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state })
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || "Cannot save Google Sheets DB.");
    state = {
      ...emptyState(),
      ...payload.state
    };
    saveStatus = "saved";
    render();
  } catch (error) {
    saveStatus = `error: ${error.message}`;
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

function persist() {
  saveStatus = "saving";
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(saveStateToDb, 350);
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
  return new Intl.DateTimeFormat("vi-VN", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(date);
}

function formatDateLong(value) {
  const date = typeof value === "string" ? parseLocalDate(value) : value;
  return new Intl.DateTimeFormat("vi-VN", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric"
  }).format(date);
}

function isPastDate(value) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return parseLocalDate(value) < today;
}

function isAdmin() {
  return session?.email?.toLowerCase() === ADMIN_EMAIL;
}

function currentUser() {
  if (!session) return null;
  return state.users.find((user) => user.email.toLowerCase() === session.email.toLowerCase());
}

function getSlotsForMonth(month) {
  ensureMonth(month);
  return state.scheduleSlots
    .filter((slot) => slot.month === month)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function ensureMonth(month) {
  const [year, monthIndex] = month.split("-").map(Number);
  const daysInMonth = new Date(year, monthIndex, 0).getDate();
  const existingDates = new Set(state.scheduleSlots.filter((slot) => slot.month === month).map((slot) => slot.date));
  const holidayDates = new Set(
    state.holidaySettings
      .filter((holiday) => holiday.date.startsWith(month))
      .map((holiday) => holiday.date)
  );

  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(year, monthIndex - 1, day);
    const key = dateKey(date);
    if (![0, 6].includes(date.getDay())) continue;
    if (existingDates.has(key) || holidayDates.has(key)) continue;

    const slotId = `slot_${key.replaceAll("-", "_")}`;
    const capacityId = `cap_${key.replaceAll("-", "_")}_qc_po`;
    state.scheduleSlots.push({
      slotId,
      date: key,
      month,
      dayOfWeek: dayName(date),
      slotType: "WEEKEND",
      title: "Weekend Support",
      status: "OPEN",
      createdBy: "system",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      note: "Auto-generated weekend slot"
    });
    state.capacities.push({
      capacityId,
      slotId,
      roleName: "QC/PO",
      requiredCount: 1,
      hoursPerPerson: 8,
      manMonthFactor: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      note: ""
    });
  }

  state.holidaySettings
    .filter((holiday) => holiday.date.startsWith(month))
    .forEach((holiday) => {
      const slotId = `slot_${holiday.date.replaceAll("-", "_")}`;
      const existing = state.scheduleSlots.find((slot) => slot.date === holiday.date);
      if (existing) {
        existing.slotType = holiday.holidayType;
        existing.title = holiday.name;
        existing.note = holiday.note;
        existing.updatedAt = nowIso();
      } else {
        state.scheduleSlots.push({
          slotId,
          date: holiday.date,
          month,
          dayOfWeek: dayName(parseLocalDate(holiday.date)),
          slotType: holiday.holidayType,
          title: holiday.name,
          status: "OPEN",
          createdBy: holiday.createdBy,
          createdAt: holiday.createdAt,
          updatedAt: holiday.updatedAt,
          note: holiday.note
        });
      }

      const existingCapacity = state.capacities.find((capacity) => capacity.slotId === slotId);
      if (existingCapacity) {
        Object.assign(existingCapacity, {
          roleName: holiday.requiredRole,
          requiredCount: holiday.requiredCount,
          hoursPerPerson: holiday.hoursPerPerson,
          manMonthFactor: holiday.manMonthFactor,
          updatedAt: holiday.updatedAt,
          note: holiday.note
        });
      } else {
        state.capacities.push({
          capacityId: `cap_${holiday.date.replaceAll("-", "_")}_${holiday.requiredRole.toLowerCase().replaceAll("/", "_")}`,
          slotId,
          roleName: holiday.requiredRole,
          requiredCount: holiday.requiredCount,
          hoursPerPerson: holiday.hoursPerPerson,
          manMonthFactor: holiday.manMonthFactor,
          createdAt: holiday.createdAt,
          updatedAt: holiday.updatedAt,
          note: holiday.note
        });
      }
    });

  persist();
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
      registeredSlot.month === month
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

function registerSlot(slotId, userEmail, registeredByEmail, options = {}) {
  const slot = state.scheduleSlots.find((item) => item.slotId === slotId);
  const capacity = getCapacity(slotId);
  const user = state.users.find((item) => item.email.toLowerCase() === userEmail.toLowerCase());

  if (!slot || !capacity || !user || user.status !== "ACTIVE") return "User hoặc slot không khả dụng.";
  if (isPastDate(slot.date) && !options.allowPast) return "Ngày đã qua. Nếu cần chỉnh sửa, vui lòng tạo update request.";
  if (remainingSlots(slot) <= 0) return "Slot này đã đủ người đăng ký.";
  if (!options.allowMonthlyOverride && findUserMonthlyRegistration(slot.month, userEmail)) return "Bạn đã đăng ký một ngày trực trong tháng này rồi.";

  state.registrations.push({
    registrationId: `reg_${Date.now()}_${user.username.replaceAll(".", "_")}`,
    slotId,
    capacityId: capacity.capacityId,
    userEmail,
    registeredByEmail,
    status: "ACTIVE",
    approvedStatus: registeredByEmail === userEmail ? "AUTO_APPROVED" : "ADMIN_APPROVED",
    source: registeredByEmail === userEmail ? "self_registration" : "admin_assignment",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    note: ""
  });
  refreshSlotStatus(slotId);
  audit(registeredByEmail, "REGISTRATION_CREATE", "registration", slotId, "", JSON.stringify({ slotId, userEmail }));
  persist();
  return "";
}

function cancelRegistration(registrationId) {
  const registration = state.registrations.find((item) => item.registrationId === registrationId);
  if (!registration) return "Không tìm thấy đăng ký.";
  const slot = state.scheduleSlots.find((item) => item.slotId === registration.slotId);
  if (slot && isPastDate(slot.date) && !isAdmin()) return "Ngày đã qua. Nếu cần chỉnh sửa, vui lòng tạo update request.";
  if (!isAdmin() && registration.userEmail.toLowerCase() !== session.email.toLowerCase()) return "Bạn chỉ có thể hủy đăng ký của chính mình.";
  registration.status = "CANCELLED";
  registration.updatedAt = nowIso();
  refreshSlotStatus(registration.slotId);
  audit(session.email, "REGISTRATION_CANCEL", "registration", registrationId, "", JSON.stringify(registration));
  persist();
  return "";
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
          <h2>Loading Google Sheets DB</h2>
          <p class="muted">Đang đọc dữ liệu từ OT Support Tool DB.</p>
        </div>
      </div>
    `;
    return;
  }

  if (bootstrapError) {
    app.innerHTML = `
      <div class="login-panel" style="min-height:100vh">
        <div class="login-box">
          <h2>Google Sheets DB chưa kết nối</h2>
          <div class="error">${escapeHtml(bootstrapError)}</div>
          <p class="muted">Tạo file <strong>.env.local</strong> từ <strong>.env.local.example</strong>, share Google Sheet DB cho service account với quyền Editor, rồi restart local server.</p>
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
    ["dashboard", "Register Dashboard"],
    ["stats", "Statistics"],
    ["requests", "Requests"],
    ...(isAdmin() ? [["admin-users", "Users"], ["admin-schedule", "Schedule"]] : [])
  ];

  app.innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-mark">OT</div>
          <div>
            <div class="brand-title">OT Support Tool</div>
            <div class="brand-subtitle">Amaze support tracking</div>
          </div>
        </div>
        <nav class="nav">
          ${navItems.map(([key, label]) => `<button class="${view === key ? "active" : ""}" data-nav="${key}">${label}</button>`).join("")}
        </nav>
        <div class="sidebar-footer">
          Google Sheets DB<br />
          kyanon.digital only
        </div>
      </aside>
      <main class="main">
        <header class="topbar">
          <h1 class="page-title">${pageTitle()}</h1>
          <div class="user-menu">
            <span class="status info">${escapeHtml(saveStatus || "Google Sheets DB")}</span>
            <div>
              <strong>${escapeHtml(user.displayName)}</strong>
              <div class="muted">${escapeHtml(user.email)}</div>
            </div>
            <div class="avatar">${user.displayName.slice(0, 1).toUpperCase()}</div>
            <button class="btn small" data-action="logout">Logout</button>
          </div>
        </header>
        <section class="content">${renderView()}</section>
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
          <p class="muted">Local build dùng email kyanon.digital để xác định user. Google Workspace OAuth sẽ được nối ở bản deploy.</p>
          ${message ? `<div class="error">${escapeHtml(message)}</div>` : ""}
          <form class="form" id="login-form">
            <div class="field">
              <label for="email">Company email</label>
              <input id="email" name="email" type="email" value="${ADMIN_EMAIL}" autocomplete="email" required />
            </div>
            <button class="btn primary" type="submit">Continue</button>
          </form>
        </div>
      </section>
    </div>
  `;

  document.querySelector("#login-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const email = new FormData(event.currentTarget).get("email").trim().toLowerCase();
    if (!email.endsWith(`@${COMPANY_DOMAIN}`)) {
      renderLogin(`Only @${COMPANY_DOMAIN} accounts can log in.`);
      return;
    }
    const user = state.users.find((item) => item.email.toLowerCase() === email);
    if (!user || user.status !== "ACTIVE") {
      renderLogin("This email is not active in the users sheet.");
      return;
    }
    saveSession({ email });
    render();
  });
}

function renderView() {
  if (view === "dashboard") return renderDashboard();
  if (view === "stats") return renderStats();
  if (view === "requests") return renderRequests();
  if (view === "admin-users") return renderAdminUsers();
  if (view === "admin-schedule") return renderAdminSchedule();
  return "";
}

function monthToolbar() {
  return `
    <div class="toolbar">
      <div class="toolbar-group">
        <button class="btn" data-action="prev-month">Previous</button>
        <input type="month" value="${selectedMonth}" data-action="month-input" />
        <button class="btn" data-action="next-month">Next</button>
      </div>
      <div class="toolbar-group">
        <button class="btn" data-action="refresh-db">Refresh DB</button>
        <button class="btn primary" data-action="export-preview">Export preview</button>
      </div>
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

  return `
    ${monthToolbar()}
    <div class="grid cols-4">
      ${metric("Support days", slots.length)}
      ${metric("Open slots", openSlots)}
      ${metric("Assigned people", registrations.length)}
      ${metric("Total hours", totalHours)}
    </div>
    <div class="split" style="margin-top:16px">
      <section class="panel">
        <div class="panel-header">
          <h2 class="panel-title">Calendar</h2>
          <span class="muted">${selectedMonth}</span>
        </div>
        <div class="panel-body">${renderCalendar(slots)}</div>
      </section>
      <section class="panel">
        <div class="panel-header">
          <h2 class="panel-title">Nhắc lịch trực</h2>
        </div>
        <div class="panel-body">${renderReminderPreview(slots)}</div>
      </section>
    </div>
    <section class="panel" style="margin-top:16px">
      <div class="panel-header">
        <h2 class="panel-title">Slot table</h2>
      </div>
      <div class="table-wrap">${renderSlotsTable(slots, false)}</div>
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

  for (let i = 0; i < 42; i += 1) {
    const date = new Date(start);
    date.setDate(start.getDate() + i);
    const key = dateKey(date);
    const daySlots = slots.filter((slot) => slot.date === key);
    cells.push(`
      <div class="day ${date.getMonth() === month - 1 ? "" : "out"}">
        <div class="day-number">${date.getDate()}</div>
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
  const names = getActiveRegistrations(slot.slotId)
    .map((registration) => userLabel(registration.userEmail))
    .join(", ");
  const css = `${slot.slotType !== "WEEKEND" ? "holiday" : ""} ${slot.status === "FULL" ? "full" : ""}`;
  return `
    <button class="slot-pill ${css}" data-action="focus-slot" data-slot="${slot.slotId}">
      <span class="slot-name">${escapeHtml(slot.title)}</span>
      <span class="slot-meta">${escapeHtml(names || `${remainingSlots(slot)} open`)}</span>
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
          ${modal.memberSelect ? `
            <div class="field" style="margin-top:14px">
              <label>Member</label>
              <select data-action="modal-member-select">
                ${state.users
                  .filter((user) => user.status === "ACTIVE")
                  .map((user) => `<option value="${user.email}" ${user.email === modal.defaultMemberEmail ? "selected" : ""}>${escapeHtml(user.displayName)} - ${escapeHtml(user.email)}</option>`)
                  .join("")}
              </select>
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
    const names = getActiveRegistrations(slotId).map((registration) => userLabel(registration.userEmail)).join(", ");
    if (remainingSlots(slot) <= 0) {
      modal = {
        type: "info",
        title: "Slot đã đủ người",
        message: `${formatDateLong(slot.date)} đã đủ slot${names ? `: ${names}` : "."}`,
        primary: { label: "Close", action: "modal-close" }
      };
      render();
      return;
    }

    modal = {
      type: "register-slot",
      slotId,
      memberSelect: true,
      defaultMemberEmail: session.email,
      title: "Admin đăng ký member",
      message: `Bạn muốn đăng ký trực ${formatDateLong(slot.date)} cho member được chọn phải không?${names ? ` Hiện đã có: ${names}.` : ""}`,
      primary: { label: "Yes", action: "modal-confirm-register" },
      secondary: { label: "No", action: "modal-close" }
    };
    render();
    return;
  }

  const ownRegistration = getActiveRegistrations(slotId).find((registration) => registration.userEmail.toLowerCase() === session.email.toLowerCase());
  if (ownRegistration) {
    if (isPastDate(slot.date)) {
      modal = {
        type: "info",
        title: "Không thể hủy đăng ký",
        message: "Ngày đã qua. Nếu cần chỉnh sửa, vui lòng tạo update request.",
        primary: { label: "Close", action: "modal-close" }
      };
      render();
      return;
    }

    modal = {
      type: "cancel-registration",
      registrationId: ownRegistration.registrationId,
      title: "Hủy đăng ký",
      message: `Bạn muốn hủy đăng ký trực ${formatDateLong(slot.date)}?`,
      primary: { label: "Yes", action: "modal-confirm-cancel" },
      secondary: { label: "No", action: "modal-close" }
    };
    render();
    return;
  }

  if (isPastDate(slot.date)) {
    modal = {
      type: "info",
      title: "Không thể đăng ký",
      message: "Ngày đã qua. Nếu cần chỉnh sửa, vui lòng tạo update request.",
      primary: { label: "Close", action: "modal-close" }
    };
    render();
    return;
  }

  if (remainingSlots(slot) <= 0) {
    const names = getActiveRegistrations(slotId).map((registration) => userLabel(registration.userEmail)).join(", ");
    modal = {
      type: "info",
      title: "Slot đã có người đăng ký",
      message: `${formatDateLong(slot.date)} đã đủ slot${names ? `: ${names}` : "."}`,
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
      title: "Đã đăng ký trong tháng",
      message: `Bạn đã đăng ký trực ${formatDateLong(existingSlot.date)} rồi.`,
      primary: { label: "Close", action: "modal-close" }
    };
    render();
    return;
  }

  modal = {
    type: "register-slot",
    slotId,
    title: "Xác nhận đăng ký",
    message: `Bạn muốn đăng ký trực ${formatDateLong(slot.date)} phải không?`,
    primary: { label: "Yes", action: "modal-confirm-register" },
    secondary: { label: "No", action: "modal-close" }
  };
  render();
}

function renderReminderPreview(slots) {
  const upcoming = slots
    .filter((slot) => !isPastDate(slot.date))
    .slice(0, 5);
  if (!upcoming.length) return `<div class="empty">Không có lịch nhắc sắp tới.</div>`;
  return `
    <div class="list">
      ${upcoming.map((slot) => {
        const names = getActiveRegistrations(slot.slotId).map((registration) => userLabel(registration.userEmail)).join(", ") || "Chưa có người đăng ký";
        return `
          <div class="item">
            <div class="item-title">${formatDate(slot.date)}</div>
            <div class="item-meta">Ngày ${formatDateLong(slot.date)}: ${escapeHtml(names)} sẽ support SOS dự án Amaze.</div>
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

  return `
    ${monthToolbar()}
    <section class="panel">
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
  const myRequests = isAdmin() ? state.updateRequests : state.updateRequests.filter((request) => request.userEmail.toLowerCase() === session.email.toLowerCase());
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
        <div class="panel-header">
          <h2 class="panel-title">${isAdmin() ? "All requests" : "My requests"}</h2>
        </div>
        <div class="panel-body">
          ${myRequests.length ? `
            <div class="list">
              ${myRequests.map((request) => `
                <div class="item">
                  <div class="item-title">${escapeHtml(request.userEmail)} - ${formatDate(request.targetDate)}</div>
                  <div class="item-meta">${escapeHtml(request.reason)}</div>
                  <div class="actions">
                    <span class="status ${request.status.toLowerCase()}">${request.status}</span>
                    ${isAdmin() && request.status === "PENDING" ? `
                      <button class="btn small primary" data-action="review-request" data-request="${request.requestId}" data-status="APPROVED">Approve</button>
                      <button class="btn small danger" data-action="review-request" data-request="${request.requestId}" data-status="REJECTED">Reject</button>
                    ` : ""}
                  </div>
                </div>
              `).join("")}
            </div>
          ` : `<div class="empty">No requests yet.</div>`}
        </div>
      </section>
    </div>
  `;
}

function renderAdminUsers() {
  if (!isAdmin()) return `<div class="error">Admin only.</div>`;
  return `
    <div class="split">
      <section class="panel">
        <div class="panel-header">
          <h2 class="panel-title">Users sheet preview</h2>
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
              ${state.users.map((user) => `
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
          <div class="notice" style="margin-top:14px">Thao tác này sẽ cập nhật tab <strong>users</strong> trong Google Sheets DB.</div>
        </div>
      </section>
    </div>
  `;
}

function renderUserActions(user) {
  if (user.email.toLowerCase() === ADMIN_EMAIL) return `<span class="muted">Protected admin</span>`;
  if (user.status === "ACTIVE") {
    return `<button class="btn small danger" data-action="deactivate-user" data-email="${user.email}">Deactivate</button>`;
  }
  return `<button class="btn small primary" data-action="reactivate-user" data-email="${user.email}">Reactivate</button>`;
}

function renderAdminSchedule() {
  if (!isAdmin()) return `<div class="error">Admin only.</div>`;
  const holidayRows = state.holidaySettings
    .filter((holiday) => holiday.date.startsWith(selectedMonth))
    .sort((a, b) => a.date.localeCompare(b.date));
  return `
    ${monthToolbar()}
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
        <div class="panel-header">
          <h2 class="panel-title">Configured holiday/Tet days</h2>
          <span class="muted">${selectedMonth}</span>
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
  `;
}

function bindShellEvents() {
  document.querySelectorAll("[data-nav]").forEach((button) => {
    button.addEventListener("click", () => {
      view = button.dataset.nav;
      render();
    });
  });

  document.querySelector("[data-action='logout']")?.addEventListener("click", () => {
    localStorage.removeItem("ot-support-session");
    session = null;
    render();
  });

  document.querySelector("[data-action='prev-month']")?.addEventListener("click", () => {
    const date = parseLocalDate(`${selectedMonth}-01`);
    date.setMonth(date.getMonth() - 1);
    selectedMonth = monthKey(date);
    render();
  });

  document.querySelector("[data-action='next-month']")?.addEventListener("click", () => {
    const date = parseLocalDate(`${selectedMonth}-01`);
    date.setMonth(date.getMonth() + 1);
    selectedMonth = monthKey(date);
    render();
  });

  document.querySelector("[data-action='month-input']")?.addEventListener("change", (event) => {
    selectedMonth = event.target.value;
    render();
  });

  document.querySelector("[data-action='refresh-db']")?.addEventListener("click", () => {
    loadStateFromDb();
  });

  document.querySelector("[data-action='export-preview']")?.addEventListener("click", () => {
    alert("Export preview: production build will fill the Excel template from Google Sheets DB for " + selectedMonth + ".");
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

  document.querySelector("[data-action='modal-confirm-register']")?.addEventListener("click", () => {
    if (!modal?.slotId) return;
    const selectedMember = document.querySelector("[data-action='modal-member-select']")?.value;
    const targetEmail = isAdmin() && selectedMember ? selectedMember : session.email;
    const error = registerSlot(modal.slotId, targetEmail, session.email, {
      allowPast: isAdmin(),
      allowMonthlyOverride: isAdmin()
    });
    modal = error
      ? { type: "info", title: "Không thể đăng ký", message: error, primary: { label: "Close", action: "modal-close" } }
      : { type: "info", title: "Đăng ký thành công", message: "Bạn đã đăng ký lịch trực thành công.", primary: { label: "Close", action: "modal-close" } };
    render();
  });

  document.querySelector("[data-action='modal-confirm-cancel']")?.addEventListener("click", () => {
    if (!modal?.registrationId) return;
    const error = cancelRegistration(modal.registrationId);
    modal = error
      ? { type: "info", title: "Không thể hủy đăng ký", message: error, primary: { label: "Close", action: "modal-close" } }
      : { type: "info", title: "Đã hủy đăng ký", message: "Đăng ký trực của bạn đã được hủy.", primary: { label: "Close", action: "modal-close" } };
    render();
  });

  document.querySelector("#request-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    state.updateRequests.push({
      requestId: `req_${Date.now()}`,
      userEmail: session.email,
      targetRegistrationId: "",
      targetDate: data.targetDate,
      requestedHours: Number(data.requestedHours),
      reason: data.reason,
      evidenceUrl: data.evidenceUrl,
      status: "PENDING",
      adminNote: "",
      reviewedBy: "",
      createdAt: nowIso(),
      reviewedAt: ""
    });
    audit(session.email, "UPDATE_REQUEST_CREATE", "update_request", data.targetDate, "", JSON.stringify(data));
    persist();
    render();
  });

  document.querySelectorAll("[data-action='review-request']").forEach((button) => {
    button.addEventListener("click", () => {
      const request = state.updateRequests.find((item) => item.requestId === button.dataset.request);
      if (!request) return;
      request.status = button.dataset.status;
      request.reviewedBy = session.email;
      request.reviewedAt = nowIso();
      audit(session.email, `UPDATE_REQUEST_${button.dataset.status}`, "update_request", request.requestId, "", JSON.stringify(request));
      persist();
      render();
    });
  });

  document.querySelector("#user-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    const email = data.email.trim().toLowerCase();
    if (!email.endsWith(`@${COMPANY_DOMAIN}`)) {
      alert(`Email must use @${COMPANY_DOMAIN}.`);
      return;
    }
    if (state.users.some((user) => user.email.toLowerCase() === email)) {
      alert("Email already exists in users sheet.");
      return;
    }
    const username = email.split("@")[0];
    const user = {
      userId: `usr_${username.replaceAll(".", "_")}`,
      email,
      username,
      displayName: data.displayName.trim(),
      role: data.role,
      status: "ACTIVE",
      source: "admin_app",
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    state.users.push(user);
    audit(session.email, "USER_CREATE", "user", user.email, "", JSON.stringify(user));
    persist();
    render();
  });

  document.querySelectorAll("[data-action='deactivate-user'], [data-action='reactivate-user']").forEach((button) => {
    button.addEventListener("click", () => {
      const user = state.users.find((item) => item.email === button.dataset.email);
      if (!user || user.email.toLowerCase() === ADMIN_EMAIL) return;
      const before = JSON.stringify(user);
      user.status = button.dataset.action === "deactivate-user" ? "INACTIVE" : "ACTIVE";
      user.updatedAt = nowIso();
      audit(session.email, `USER_${user.status}`, "user", user.email, before, JSON.stringify(user));
      persist();
      render();
    });
  });

  document.querySelector("#holiday-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    const start = parseLocalDate(data.startDate);
    const end = parseLocalDate(data.endDate);
    if (end < start) {
      alert("End date must be after or equal to start date.");
      return;
    }

    const createdDates = [];
    const cursor = new Date(start);
    while (cursor <= end) {
      const date = dateKey(cursor);
      const existing = state.holidaySettings.find((holiday) => holiday.date === date);
      const payload = {
        holidayId: `hol_${date.replaceAll("-", "_")}`,
        date,
        name: data.name,
        holidayType: data.holidayType,
        requiredRole: data.requiredRole,
        requiredCount: Number(data.requiredCount),
        hoursPerPerson: Number(data.hoursPerPerson),
        manMonthFactor: Number(data.manMonthFactor),
        note: data.note,
        createdBy: session.email,
        createdAt: nowIso(),
        updatedAt: nowIso()
      };

      if (existing) {
        Object.assign(existing, {
          name: payload.name,
          holidayType: payload.holidayType,
          requiredRole: payload.requiredRole,
          requiredCount: payload.requiredCount,
          hoursPerPerson: payload.hoursPerPerson,
          manMonthFactor: payload.manMonthFactor,
          note: payload.note,
          updatedAt: payload.updatedAt
        });
      } else {
        state.holidaySettings.push(payload);
      }
      createdDates.push(date);
      cursor.setDate(cursor.getDate() + 1);
    }

    selectedMonth = data.startDate.slice(0, 7);
    audit(session.email, "HOLIDAY_DURATION_CREATE", "holiday_setting", `${data.startDate}_${data.endDate}`, "", JSON.stringify({ ...data, dates: createdDates }));
    persist();
    render();
  });

}

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

loadStateFromDb();
