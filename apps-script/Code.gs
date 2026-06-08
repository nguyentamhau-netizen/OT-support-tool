const SECRET_TOKEN = 'CHANGE_ME_TO_A_RANDOM_SECRET';

const TABLE_SCHEMAS = {
  settings: ['key', 'value', 'description', 'updated_at'],
  users: ['user_id', 'email', 'username', 'display_name', 'role', 'status', 'source', 'created_at', 'updated_at'],
  schedule_slots: ['slot_id', 'date', 'month', 'day_of_week', 'slot_type', 'title', 'status', 'created_by', 'created_at', 'updated_at', 'note'],
  slot_capacities: ['capacity_id', 'slot_id', 'role_name', 'required_count', 'hours_per_person', 'man_month_factor', 'created_at', 'updated_at', 'note'],
  registrations: ['registration_id', 'slot_id', 'capacity_id', 'user_email', 'registered_by_email', 'status', 'approved_status', 'source', 'created_at', 'updated_at', 'note'],
  holiday_settings: ['holiday_id', 'date', 'name', 'holiday_type', 'required_role', 'required_count', 'hours_per_person', 'man_month_factor', 'note', 'created_by', 'created_at', 'updated_at'],
  update_requests: ['request_id', 'user_email', 'target_registration_id', 'target_date', 'requested_hours', 'reason', 'evidence_url', 'status', 'admin_note', 'reviewed_by', 'created_at', 'reviewed_at'],
  audit_logs: ['log_id', 'actor_email', 'action', 'entity_type', 'entity_id', 'before_json', 'after_json', 'created_at'],
  export_jobs: ['export_id', 'month', 'status', 'file_url', 'created_by', 'created_at', 'note'],
  chat_notifications: ['notification_id', 'slot_id', 'message', 'scheduled_for', 'sent_at', 'status', 'response', 'created_at']
};

const STATE_KEYS = {
  settings: 'settings',
  users: 'users',
  schedule_slots: 'scheduleSlots',
  slot_capacities: 'capacities',
  registrations: 'registrations',
  holiday_settings: 'holidaySettings',
  update_requests: 'updateRequests',
  audit_logs: 'auditLogs',
  export_jobs: 'exportJobs',
  chat_notifications: 'chatNotifications'
};

function doGet(e) {
  if (!isAuthorized(e)) return json({ ok: false, error: 'Unauthorized' });
  return json({ ok: true, state: loadState() });
}

function doPost(e) {
  if (!isAuthorized(e)) return json({ ok: false, error: 'Unauthorized' });
  const body = JSON.parse(e.postData.contents || '{}');
  if (!body.state) return json({ ok: false, error: 'Missing state payload' });
  saveState(body.state);
  return json({ ok: true, state: loadState() });
}

function isAuthorized(e) {
  return e && e.parameter && e.parameter.token === SECRET_TOKEN;
}

function loadState() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const state = {};

  Object.keys(TABLE_SCHEMAS).forEach((tableName) => {
    const sheet = getOrCreateSheet(ss, tableName);
    const values = sheet.getDataRange().getValues();
    state[STATE_KEYS[tableName]] = rowsToObjects(values);
  });

  state.db = {
    spreadsheetId: ss.getId(),
    url: ss.getUrl()
  };

  return state;
}

function saveState(state) {
  const lock = LockService.getDocumentLock();
  lock.waitLock(30000);

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    Object.keys(TABLE_SCHEMAS).forEach((tableName) => {
      const sheet = getOrCreateSheet(ss, tableName);
      const rows = objectsToRows(tableName, state[STATE_KEYS[tableName]] || []);
      sheet.clearContents();
      sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
      sheet.setFrozenRows(1);
    });
  } finally {
    lock.releaseLock();
  }
}

function getOrCreateSheet(ss, tableName) {
  let sheet = ss.getSheetByName(tableName);
  if (!sheet) sheet = ss.insertSheet(tableName);

  const headers = TABLE_SCHEMAS[tableName];
  const existing = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  const needsHeader = existing.every((value) => value === '');
  if (needsHeader) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  }

  return sheet;
}

function rowsToObjects(values) {
  if (!values || values.length === 0) return [];
  const headers = values[0].map(snakeToCamel);
  return values.slice(1)
    .filter((row) => row.some((cell) => cell !== ''))
    .map((row) => {
      const object = {};
      headers.forEach((header, index) => {
        object[header] = row[index] === undefined ? '' : row[index];
      });
      return object;
    });
}

function objectsToRows(tableName, rows) {
  const headers = TABLE_SCHEMAS[tableName];
  return [
    headers,
    ...rows.map((row) => headers.map((header) => {
      const value = row[snakeToCamel(header)];
      return value === undefined || value === null ? '' : value;
    }))
  ];
}

function snakeToCamel(value) {
  return value.replace(/_([a-z])/g, function (_, letter) {
    return letter.toUpperCase();
  });
}

function json(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
