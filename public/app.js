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
let isRefreshing = false;


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
    isBootstrapping = false;
    bootstrapError = "";
    isRefreshing = false;
    saveStatus = "";
    render();
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
    showToast("Đăng ký ca trực thành công!");
    render();
  } catch (error) {
    saveStatus = `error: ${error.message}`;
    modal = { type: "info", title: "Không thể đăng ký", message: error.message, primary: { label: "Close", action: "modal-close" } };
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
    showToast("Đã hủy đăng ký ca trực!");
    render();
  } catch (error) {
    saveStatus = `error: ${error.message}`;
    modal = { type: "info", title: "Không thể hủy đăng ký", message: error.message, primary: { label: "Close", action: "modal-close" } };
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
          <p class="muted">Đang tải dữ liệu từ Taiga và Cơ sở dữ liệu...</p>
        </div>
      </div>
    `;
    return;
  }

  if (bootstrapError) {
    app.innerHTML = `
      <div class="login-panel" style="min-height:100vh">
        <div class="login-box">
          <h2>Cơ sở dữ liệu chưa kết nối</h2>
          <div class="error">${escapeHtml(bootstrapError)}</div>
          <p class="muted">Không thể tải dữ liệu. Hãy kiểm tra kết nối mạng hoặc cấu hình API Taiga trong file <strong>.env</strong>, sau đó khởi động lại server.</p>
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
          Taiga & Local DB<br />
          kyanon.digital only
        </div>
      </aside>
      <main class="main">
        <header class="topbar">
          <h1 class="page-title">${pageTitle()}</h1>
          <div class="user-menu">
            <span class="status info">${escapeHtml(saveStatus || "Synced with Taiga")}</span>
            <div>
              <strong>${escapeHtml(user.displayName)}</strong>
              <div class="muted">${escapeHtml(user.email)}</div>
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
          <p class="muted">Đăng nhập bằng tài khoản Google Workspace hoặc Username của Taiga.</p>
          ${message ? `<div class="error">${escapeHtml(message)}</div>` : ""}
          <form class="form" id="login-form">
            <div class="field">
              <label for="email">Email or Username</label>
              <input id="email" name="email" type="text" placeholder="name@kyanon.digital" required />
            </div>
            <div class="field">
              <label for="password">Taiga Password</label>
              <input id="password" name="password" type="password" required />
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
      
      saveSession({ email: data.user.email });
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
  if (view === "admin-users") return renderAdminUsers();
  if (view === "admin-schedule") return renderAdminSchedule();
  return "";
}

function renderActionToolbar() {
  return `
    <div class="toolbar">
      <div></div>
      <div class="toolbar-group">
        <button class="btn" data-action="refresh-db" ${isRefreshing ? "disabled" : ""}>
          ${isRefreshing ? '<span class="spinner"></span>Refreshing...' : 'Refresh'}
        </button>
        <button class="btn primary" data-action="export-preview">Export preview</button>
      </div>
    </div>
  `;
}

function renderMonthSelector() {
  const [year, month] = selectedMonth.split("-").map(Number);
  
  let monthOptions = "";
  for (let m = 1; m <= 12; m++) {
    const monthVal = `${m}`.padStart(2, "0");
    monthOptions += `<option value="${monthVal}" ${m === month ? "selected" : ""}>Tháng ${m}</option>`;
  }
  
  let yearOptions = "";
  const currentYear = new Date().getFullYear();
  for (let y = currentYear - 2; y <= currentYear + 3; y++) {
    yearOptions += `<option value="${y}" ${y === year ? "selected" : ""}>Năm ${y}</option>`;
  }

  return `
    <div class="month-selector-container">
      <button class="today-btn" type="button" data-action="today-month">Hôm nay</button>
      <div class="nav-divider"></div>
      <button class="nav-btn" type="button" data-action="prev-month" title="Tháng trước">
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
      <button class="nav-btn" type="button" data-action="next-month" title="Tháng sau">
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
  const displayLabel = `Tháng ${parseInt(month, 10)} - ${year}`;

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

  const todayKey = dateKey(new Date());
  for (let i = 0; i < 42; i += 1) {
    const date = new Date(start);
    date.setDate(start.getDate() + i);
    const key = dateKey(date);
    const daySlots = slots.filter((slot) => slot.date === key);
    const isToday = key === todayKey;
    cells.push(`
      <div class="day ${date.getMonth() === month - 1 ? "" : "out"} ${isToday ? "today" : ""}">
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

  const css = `${isHoliday ? "holiday" : ""} ${statusClass}`;
  return `
    <button class="slot-pill ${css}" data-action="focus-slot" data-slot="${slot.slotId}">
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
              <label style="font-weight: 700; display: block; margin-bottom: 8px;">Thành viên đang đăng ký:</label>
              <div style="display: flex; flex-direction: column; gap: 8px; max-height: 150px; overflow-y: auto;">
                ${modal.activeRegistrations.map(reg => `
                  <div style="display: flex; align-items: center; justify-content: space-between; background: var(--bg); padding: 8px 10px; border-radius: 6px; border: 1px solid var(--line);">
                    <span style="font-size: 14px; font-weight: 600;">${escapeHtml(userLabel(reg.userEmail))}</span>
                    <button class="btn small danger" data-action="admin-cancel-reg" data-reg-id="${reg.registrationId}">Hủy</button>
                  </div>
                `).join("")}
              </div>
            </div>
          ` : ""}
          ${modal.memberSelect ? `
            <div class="field" style="margin-top:14px">
              <label>Đăng ký cho thành viên</label>
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
    const regs = getActiveRegistrations(slotId);
    modal = {
      type: "admin-manage-slot",
      slotId,
      title: "Admin quản lý slot",
      message: `Thông tin slot trực ngày ${formatDateLong(slot.date)}.`,
      activeRegistrations: regs,
      memberSelect: remainingSlots(slot) > 0,
      defaultMemberEmail: session.email,
      primary: remainingSlots(slot) > 0 ? { label: "Đăng ký", action: "modal-confirm-register" } : null,
      secondary: { label: "Đóng", action: "modal-close" }
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
    ${renderActionToolbar()}
    <section class="panel">
      <div class="panel-header" style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
        <h2 class="panel-title">Monthly member totals</h2>
        ${renderMonthSelector()}
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
          <div class="notice" style="margin-top:14px">Thao tác này sẽ cập nhật trực tiếp danh sách thành viên trên local DB và Taiga.</div>
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
          </div>
        </form>
        <div class="notice" style="margin-top: 14px; margin-bottom: 0;">
          Cấu hình Webhook URL của Google Chat để gửi cảnh báo tự động khi đăng ký, hủy trực hoặc duyệt yêu cầu, và gửi nhắc lịch hàng ngày lúc 17:00.
        </div>
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

  document.querySelector("[data-action='modal-confirm-register']")?.addEventListener("click", () => {
    if (!modal?.slotId) return;
    const selectedMember = document.querySelector("[data-action='modal-member-select']")?.value;
    const targetEmail = isAdmin() && selectedMember ? selectedMember : session.email;
    const error = registerSlot(modal.slotId, targetEmail, session.email, {
      allowPast: isAdmin(),
      allowMonthlyOverride: isAdmin()
    });
    if (error) {
      modal = { type: "info", title: "Không thể đăng ký", message: error, primary: { label: "Close", action: "modal-close" } };
    } else {
      modal = null;
      showToast("Đăng ký ca trực thành công!");
    }
    render();
  });

  document.querySelector("[data-action='modal-confirm-cancel']")?.addEventListener("click", () => {
    if (!modal?.registrationId) return;
    const error = cancelRegistration(modal.registrationId);
    if (error) {
      modal = { type: "info", title: "Không thể hủy đăng ký", message: error, primary: { label: "Close", action: "modal-close" } };
    } else {
      modal = null;
      showToast("Đã hủy đăng ký ca trực!");
    }
    render();
  });

  document.querySelectorAll("[data-action='admin-cancel-reg']").forEach((button) => {
    button.addEventListener("click", () => {
      const regId = button.dataset.regId;
      const error = cancelRegistration(regId);
      if (error) {
        modal = { type: "info", title: "Không thể hủy đăng ký", message: error, primary: { label: "Close", action: "modal-close" } };
      } else {
        modal = null;
        showToast("Đã hủy đăng ký ca trực!");
      }
      render();
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
      showToast("Gửi yêu cầu cập nhật thành công!");
      render();
    } catch (error) {
      saveStatus = `error: ${error.message}`;
      alert("Error submitting request: " + error.message);
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
        showToast(`Yêu cầu đã được ${status === "APPROVED" ? "Phê duyệt" : "Từ chối"}!`);
        render();
      } catch (error) {
        saveStatus = `error: ${error.message}`;
        alert("Error reviewing request: " + error.message);
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
      showToast("Thêm thành viên thành công!");
      render();
    } catch (error) {
      saveStatus = `error: ${error.message}`;
      alert("Error adding user: " + error.message);
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
        showToast(`${status === "ACTIVE" ? "Kích hoạt" : "Khóa"} thành viên thành công!`);
        render();
      } catch (error) {
        saveStatus = `error: ${error.message}`;
        alert("Error updating user status: " + error.message);
        render();
      }
    });
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
      showToast("Tạo các ca trực ngày lễ thành công!");
      render();
    } catch (error) {
      saveStatus = `error: ${error.message}`;
      alert("Error creating holiday slots: " + error.message);
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
        alert("Settings saved successfully.");
        await loadStateFromDb(false, selectedMonth);
      } else {
        alert("Failed to save settings.");
      }
    } catch (err) {
      alert("Error saving settings: " + err.message);
    }
  });

  document.querySelector("[data-action='test-chat']")?.addEventListener("click", async () => {
    const btn = document.querySelector("[data-action='test-chat']");
    btn.disabled = true;
    try {
      const response = await fetch("/api/chat/test", { method: "POST" });
      const data = await response.json();
      if (response.ok && data.ok) {
        alert("Test message sent successfully. Please check your Google Chat space!");
      } else {
        alert("Failed to send test message. Check that the webhook URL is correct.");
      }
    } catch (err) {
      alert("Error sending test message: " + err.message);
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
        alert(`Reminders triggered! Sent: ${data.sentCount} notifications, Open slots warned: ${data.openCount}.`);
        await loadStateFromDb(false, selectedMonth);
      } else {
        alert("Failed to trigger reminders.");
      }
    } catch (err) {
      alert("Error triggering reminders: " + err.message);
    } finally {
      btn.disabled = false;
    }
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

loadStateFromDb(false, selectedMonth);

// Auto-polling background synchronization (every 30 seconds)
setInterval(async () => {
  if (session && document.visibilityState === "visible" && !isRefreshing && !isBootstrapping) {
    console.log("[POLLING] Fetching latest state from server...");
    await loadStateFromDb(false, selectedMonth, true);
  }
}, 30 * 1000);
