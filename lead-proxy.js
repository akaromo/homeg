/*
 * KCS Homegrown lead portal server
 *
 * Serves the portal UI and forwards lead submissions to LeadByte with the
 * required API key (browsers cannot send this directly).
 *
 * LeadByte campaign reference:
 *   http://3waygroup.leadbyte.co.uk/integration?slice=6903344c4d278031379420
 *
 * Local storage is still supported, but when SUPABASE_URL and
 * SUPABASE_SERVICE_ROLE_KEY are present, users, passwords, settings, API key,
 * and submission logs are stored in Supabase so they survive redeploys.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 8787;
const HOST = "0.0.0.0";
const LEADBYTE_URL = process.env.LEADBYTE_URL || "https://3waygroup.leadbyte.co.uk/restapi/v1.3/leads";
const STORE_FILE = path.join(__dirname, "homegrown-store.json");
const UI_FILE = path.join(__dirname, "Homegrown-Lead-Form.html");
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const USE_SUPABASE = !!(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_LOG = 500;

/* Roles are ranked: agent can only capture leads, admin also reports and
 * configures, superadmin is the only one who can see the LeadByte API key. */
const ROLE_RANK = { agent: 1, admin: 2, superadmin: 3 };

/* Accounts created the first time the store is empty. Passwords are temporary. */
const FIRST_RUN_USERS = [
  { username: "assafi", password: "Assafi@123", role: "superadmin" },
  { username: "milly", password: "Milly@123", role: "admin" },
  { username: "vhuyiswa", password: "Vhuyiswa@123", role: "admin" }
];

/* ---------------------------------------------------------------- store */

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function makeUser(password, role) {
  const salt = crypto.randomBytes(16).toString("hex");
  return {
    role,
    salt,
    hash: hashPassword(password, salt),
    mustChange: true
  };
}

function verifyPassword(user, password) {
  if (!user || !user.salt || !user.hash) return false;
  const attempt = Buffer.from(hashPassword(password, user.salt), "hex");
  const known = Buffer.from(user.hash, "hex");
  return attempt.length === known.length && crypto.timingSafeEqual(attempt, known);
}

function defaultCampaign() {
  return {
    campid: "CAR3WMSA",
    sid: "3561",
    ssid: "DEFAULT",
    brand: "Miway Homegrown",
    channel: "Warmup",
    sub_category: "Car_Insurance",
    tenant_name: "3 Way Marketing"
  };
}

function seedUsers() {
  const users = {};
  FIRST_RUN_USERS.forEach(entry => {
    users[entry.username] = makeUser(entry.password, entry.role);
  });
  return users;
}

function defaultStore() {
  return {
    campaign: defaultCampaign(),
    apiKey: "",
    users: seedUsers(),
    leads: []
  };
}

let store = defaultStore();

function logSeedUsers() {
  console.log(`Storage mode: ${USE_SUPABASE ? "Supabase" : "local file"}`);
  console.log("Created default portal accounts with temporary passwords:");
  FIRST_RUN_USERS.forEach(entry => {
    console.log(`  ${entry.username} / ${entry.password}  (${entry.role})`);
  });
  console.log("Each user is asked to set their own password on first sign in.");
}

async function supabaseRequest(pathname, { method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, {
    method,
    headers: {
      "apikey": SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Accept": "application/json",
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (error) {
    data = text;
  }

  if (!response.ok) {
    const message = typeof data === "string"
      ? data
      : (data && (data.message || data.error || JSON.stringify(data)));
    throw new Error(`Supabase ${method} ${pathname} failed (${response.status}): ${message || "Unknown error"}`);
  }

  return data;
}

function usersToRows(users) {
  return Object.entries(users).map(([username, user]) => ({
    username,
    role: user.role,
    salt: user.salt,
    hash: user.hash,
    must_change: !!user.mustChange
  }));
}

function rowsToUsers(rows) {
  const users = {};
  (rows || []).forEach(row => {
    users[String(row.username || "").toLowerCase()] = {
      role: row.role,
      salt: row.salt,
      hash: row.hash,
      mustChange: !!row.must_change
    };
  });
  return users;
}

function leadsToRows(leads) {
  return (leads || []).map(lead => ({
    created_at: lead.timestamp || new Date().toISOString(),
    agent_username: lead.username || "",
    payload: {
      firstname: lead.firstname || "",
      lastname: lead.lastname || "",
      phone1: lead.phone1 || "",
      id_number: lead.id_number || "",
      email: lead.email || "",
      testmode: lead.testmode ? "yes" : "no"
    },
    result: {
      status: lead.status || "",
      code: lead.code || "",
      message: lead.message || "",
      queueId: lead.queueId || "",
      httpStatus: lead.httpStatus || 0,
      response: lead.response || "",
      errors: lead.errors || []
    },
    status: lead.status || "",
    code: lead.code || "",
    queue_id: lead.queueId || ""
  }));
}

function rowsToLeads(rows) {
  return (rows || []).map(row => {
    const payload = row.payload || {};
    const result = row.result || {};
    const errors = Array.isArray(result.errors) ? result.errors : [];
    return {
      id: crypto.randomUUID(),
      timestamp: row.created_at,
      username: row.agent_username || "",
      testmode: payload.testmode === "yes" || payload.testmode === true,
      firstname: payload.firstname || "",
      lastname: payload.lastname || "",
      phone1: payload.phone1 || "",
      id_number: payload.id_number || "",
      email: payload.email || "",
      httpStatus: result.httpStatus || 0,
      status: row.status || result.status || "",
      code: row.code || result.code || "",
      message: result.message || "",
      queueId: row.queue_id || result.queueId || "",
      response: result.response || "",
      errors
    };
  });
}

async function loadStoreFromLocal() {
  let loaded = null;
  try {
    loaded = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
  } catch (error) {
    loaded = null;
  }

  const users = loaded && loaded.users ? loaded.users : {};
  store = {
    campaign: { ...defaultCampaign(), ...(loaded && loaded.campaign ? loaded.campaign : {}) },
    apiKey: loaded && loaded.apiKey ? loaded.apiKey : "",
    users: Object.keys(users).length ? users : seedUsers(),
    leads: Array.isArray(loaded && loaded.leads) ? loaded.leads : []
  };

  if (!loaded || !Object.keys(users).length) {
    await saveStore();
    logSeedUsers();
  }
}

async function loadStoreFromSupabase() {
  const [settingsRows, userRows, leadRows] = await Promise.all([
    supabaseRequest("portal_settings?id=eq.1&select=id,leadbyte_x_key,campaign"),
    supabaseRequest("portal_users?select=username,role,salt,hash,must_change"),
    supabaseRequest(`lead_submissions?select=created_at,agent_username,payload,result,status,code,queue_id&order=created_at.desc&limit=${MAX_LOG}`)
  ]);

  const settings = Array.isArray(settingsRows) && settingsRows[0] ? settingsRows[0] : null;
  const users = rowsToUsers(userRows);

  store = {
    campaign: { ...defaultCampaign(), ...(settings && settings.campaign ? settings.campaign : {}) },
    apiKey: settings && settings.leadbyte_x_key ? settings.leadbyte_x_key : "",
    users: Object.keys(users).length ? users : seedUsers(),
    leads: rowsToLeads(leadRows)
  };

  if (!settings || !Object.keys(users).length) {
    await saveStore();
    logSeedUsers();
  }
}

async function loadStore() {
  if (USE_SUPABASE) {
    await loadStoreFromSupabase();
    return;
  }
  await loadStoreFromLocal();
}

async function saveStore() {
  if (!USE_SUPABASE) {
    fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
    return;
  }

  await supabaseRequest("portal_settings?on_conflict=id", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Prefer": "resolution=merge-duplicates,return=minimal"
    },
    body: {
      id: 1,
      leadbyte_x_key: store.apiKey || "",
      campaign: store.campaign,
      updated_at: new Date().toISOString()
    }
  });

  const userRows = usersToRows(store.users);
  if (userRows.length) {
    await supabaseRequest("portal_users?on_conflict=username", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal"
      },
      body: userRows
    });
  }

  await supabaseRequest("lead_submissions?id=gt.0", {
    method: "DELETE",
    headers: { "Prefer": "return=minimal" }
  });

  const leadRows = leadsToRows(store.leads);
  if (leadRows.length) {
    await supabaseRequest("lead_submissions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Prefer": "return=minimal"
      },
      body: leadRows
    });
  }
}

/* ------------------------------------------------------------- sessions */

const sessions = new Map();

function createSession(username) {
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, {
    username,
    role: store.users[username].role,
    expires: Date.now() + SESSION_TTL_MS
  });
  return token;
}

function getSession(req) {
  const header = String(req.headers.authorization || "");
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expires < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return { token, ...session };
}

function hasRole(session, minimum) {
  return (ROLE_RANK[session.role] || 0) >= ROLE_RANK[minimum];
}

function getVisibleUsersForSession(session) {
  const canSeeSuperAdmins = hasRole(session, "superadmin");
  return Object.entries(store.users)
    .filter(([, user]) => canSeeSuperAdmins || user.role !== "superadmin")
    .map(([name, user]) => ({
      username: name,
      role: user.role,
      mustChange: !!user.mustChange
    }));
}

function hasEffectiveApiKey() {
  return !!(store.apiKey || process.env.LEADBYTE_X_KEY || "");
}

/* ------------------------------------------------------------ utilities */

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  });
  res.end(JSON.stringify(payload));
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) reject(new Error("Request body too large."));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function readJson(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch (error) {
    return {};
  }
}

/* --------------------------------------------------------- lead posting */

function buildLeadPayload(input, testmode) {
  const campaign = store.campaign;
  const payload = {
    campid: campaign.campid,
    sid: campaign.sid,
    ssid: campaign.ssid,
    firstname: String(input.firstname || "").trim(),
    lastname: String(input.lastname || "").trim(),
    phone1: String(input.phone1 || "").trim(),
    id_number: String(input.id_number || "").trim(),
    email: String(input.email || "").trim(),
    brand: campaign.brand,
    channel: campaign.channel,
    sub_category: campaign.sub_category,
    tenant_name: campaign.tenant_name
  };
  if (testmode) payload.testmode = "yes";
  return payload;
}

async function addLog(entry) {
  store.leads.unshift(entry);
  if (store.leads.length > MAX_LOG) store.leads.length = MAX_LOG;
  await saveStore();
}

async function submitLead({ input, username, testmode }) {
  const apiKey = store.apiKey || process.env.LEADBYTE_X_KEY || "";
  const payload = buildLeadPayload(input, testmode);
  const record = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    username,
    testmode: !!testmode,
    firstname: payload.firstname,
    lastname: payload.lastname,
    phone1: payload.phone1,
    id_number: payload.id_number,
    email: payload.email
  };

  if (!apiKey) {
    const body = {
      status: "Error",
      code: "-1",
      message: "No LeadByte API key configured.",
      errors: ["A super admin must save the LeadByte API key under Access."]
    };
    await addLog({ ...record, httpStatus: 0, status: "Error", code: "-1", message: body.message, errors: body.errors });
    return { httpStatus: 400, body };
  }

  let upstream;
  try {
    upstream = await fetch(LEADBYTE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X_KEY": apiKey
      },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    const body = {
      status: "Error",
      code: "-100",
      message: "Could not reach LeadByte.",
      errors: [error.message]
    };
    await addLog({ ...record, httpStatus: 0, status: "Error", code: "-100", message: error.message, errors: body.errors });
    return { httpStatus: 502, body };
  }

  const text = await upstream.text();
  const parsed = readJson(text);

  await addLog({
    ...record,
    httpStatus: upstream.status,
    status: parsed.status || (upstream.ok ? "Success" : "Error"),
    code: parsed.code !== undefined ? String(parsed.code) : "",
    message: parsed.message || "",
    queueId: parsed.results && parsed.results[0] ? parsed.results[0].queueId || "" : "",
    response: text.slice(0, 2000),
    errors: Array.isArray(parsed.errors) ? parsed.errors : []
  });

  return { httpStatus: upstream.status, body: parsed, raw: text };
}

/* --------------------------------------------------------------- routes */

async function handleLogin(req, res) {
  const body = readJson(await collectBody(req));
  const username = String(body.username || "").trim().toLowerCase();
  const password = String(body.password || "");
  const user = store.users[username];

  if (!verifyPassword(user, password)) {
    sendJson(res, 401, { status: "Error", message: "Incorrect username or password." });
    return;
  }

  const token = createSession(username);
  sendJson(res, 200, {
    status: "Success",
    token,
    username,
    role: user.role,
    mustChangePassword: !!user.mustChange
  });
}

async function handleLeads(req, res, session) {
  const body = readJson(await collectBody(req));
  const canUseTestMode = hasRole(session, "admin");

  // Test mode silently disables delivery, so agents are never allowed to set it.
  const testmode = canUseTestMode && body.testmode === true;

  const result = await submitLead({
    input: body,
    username: session.username,
    testmode
  });

  sendJson(res, result.httpStatus, result.body);
}

async function handleSaveConfig(req, res) {
  const body = readJson(await collectBody(req));
  const campaign = body.campaign || {};
  const allowed = ["campid", "sid", "ssid", "brand", "channel", "sub_category", "tenant_name"];

  allowed.forEach(key => {
    if (typeof campaign[key] === "string") store.campaign[key] = campaign[key].trim();
  });

  await saveStore();
  sendJson(res, 200, { status: "Success", campaign: store.campaign });
}

/* Super admin only - this is the key that actually posts leads. */
async function handleSaveApiKey(req, res) {
  const body = readJson(await collectBody(req));

  if (body.clear === true) {
    store.apiKey = "";
    await saveStore();
    sendJson(res, 200, { status: "Success", message: "API key removed.", hasApiKey: false });
    return;
  }

  const apiKey = String(body.apiKey || "").trim();
  if (!apiKey) {
    sendJson(res, 400, { status: "Error", message: "Paste the API key first." });
    return;
  }

  store.apiKey = apiKey;
  await saveStore();
  sendJson(res, 200, { status: "Success", message: "API key saved.", hasApiKey: true });
}

async function handleCreateUser(req, res, session) {
  const body = readJson(await collectBody(req));
  const username = String(body.username || "").trim().toLowerCase();
  const password = String(body.password || "");
  const role = String(body.role || "agent").trim().toLowerCase();

  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    sendJson(res, 400, {
      status: "Error",
      message: "Username must be 3-32 characters: letters, numbers, dot, dash or underscore."
    });
    return;
  }
  if (store.users[username]) {
    sendJson(res, 409, { status: "Error", message: "That username already exists." });
    return;
  }
  if (role !== "admin" && role !== "agent" && role !== "superadmin") {
    sendJson(res, 400, { status: "Error", message: "Role must be agent, admin or superadmin." });
    return;
  }
  if (role === "superadmin" && session.role !== "superadmin") {
    sendJson(res, 403, { status: "Error", message: "Only a super admin can create another super admin." });
    return;
  }
  if (password.length < 8) {
    sendJson(res, 400, { status: "Error", message: "Password must be at least 8 characters." });
    return;
  }

  store.users[username] = makeUser(password, role);
  await saveStore();

  sendJson(res, 201, {
    status: "Success",
    message: `User "${username}" created as ${role}.`,
    username,
    role
  });
}

/* Any signed-in user changing their own password. */
async function handleOwnPassword(req, res, session) {
  const body = readJson(await collectBody(req));
  const user = store.users[session.username];
  const currentPassword = String(body.currentPassword || "");
  const newPassword = String(body.newPassword || "");

  if (!verifyPassword(user, currentPassword)) {
    sendJson(res, 403, { status: "Error", message: "Current password is incorrect." });
    return;
  }
  if (newPassword.length < 8) {
    sendJson(res, 400, { status: "Error", message: "New password must be at least 8 characters." });
    return;
  }

  user.salt = crypto.randomBytes(16).toString("hex");
  user.hash = hashPassword(newPassword, user.salt);
  user.mustChange = false;
  await saveStore();

  sendJson(res, 200, { status: "Success", message: "Your password has been updated." });
}

async function handlePassword(req, res, session) {
  const body = readJson(await collectBody(req));
  const username = String(body.username || "").trim().toLowerCase();
  const currentPassword = String(body.currentPassword || "");
  const newPassword = String(body.newPassword || "");
  const user = store.users[username];

  if (!user) {
    sendJson(res, 404, { status: "Error", message: "Unknown user." });
    return;
  }

  if (user.role === "superadmin" && session.role !== "superadmin") {
    sendJson(res, 403, { status: "Error", message: "Only a super admin can change a super admin password." });
    return;
  }

  // An admin can reset any password. Everyone else must prove the current one.
  const isSelf = username === session.username;
  if (!(hasRole(session, "admin") && !isSelf) && !verifyPassword(user, currentPassword)) {
    sendJson(res, 403, { status: "Error", message: "Current password is incorrect." });
    return;
  }

  if (newPassword.length < 8) {
    sendJson(res, 400, { status: "Error", message: "New password must be at least 8 characters." });
    return;
  }

  user.salt = crypto.randomBytes(16).toString("hex");
  user.hash = hashPassword(newPassword, user.salt);
  // A password someone else set is temporary until the owner changes it.
  user.mustChange = !isSelf;
  await saveStore();

  sendJson(res, 200, { status: "Success", message: "Password updated." });
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  const route = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    });
    res.end();
    return;
  }

  if (req.method === "GET" && route === "/health") {
    sendJson(res, 200, {
      status: "ok",
      upstream: LEADBYTE_URL,
      storage: USE_SUPABASE ? "supabase" : "local"
    });
    return;
  }

  if (req.method === "GET" && (route === "/" || route === "/index.html")) {
    fs.readFile(UI_FILE, (error, file) => {
      if (error) {
        sendJson(res, 500, { status: "Error", message: "Portal UI file not found." });
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0"
      });
      res.end(file);
    });
    return;
  }

  if (req.method === "POST" && route === "/api/login") {
    await handleLogin(req, res);
    return;
  }

  if (!route.startsWith("/api/")) {
    sendJson(res, 404, { status: "Error", message: "Not found." });
    return;
  }

  const session = getSession(req);
  if (!session) {
    sendJson(res, 401, { status: "Error", message: "Not signed in." });
    return;
  }

  if (req.method === "POST" && route === "/api/logout") {
    sessions.delete(session.token);
    sendJson(res, 200, { status: "Success" });
    return;
  }

  if (req.method === "GET" && route === "/api/session") {
    const currentUser = store.users[session.username];
    sendJson(res, 200, {
      status: "Success",
      username: session.username,
      role: session.role,
      mustChangePassword: !!(currentUser && currentUser.mustChange)
    });
    return;
  }

  if (req.method === "GET" && route === "/api/campaign") {
    sendJson(res, 200, {
      status: "Success",
      campaign: store.campaign,
      hasApiKey: hasEffectiveApiKey(),
      storage: USE_SUPABASE ? "supabase" : "local"
    });
    return;
  }

  if (req.method === "POST" && route === "/api/password") {
    await handleOwnPassword(req, res, session);
    return;
  }

  if (req.method === "POST" && route === "/api/leads") {
    await handleLeads(req, res, session);
    return;
  }

  if (route.startsWith("/api/admin/")) {
    if (!hasRole(session, "admin")) {
      sendJson(res, 403, { status: "Error", message: "Admin access required." });
      return;
    }

    if (req.method === "GET" && route === "/api/admin/config") {
      const payload = {
        status: "Success",
        campaign: store.campaign,
        hasApiKey: hasEffectiveApiKey(),
        users: getVisibleUsersForSession(session),
        storage: USE_SUPABASE ? "supabase" : "local"
      };
      // Only the super admin gets any hint of what the key is.
      if (hasRole(session, "superadmin")) {
        payload.apiKeyHint = store.apiKey ? "*".repeat(8) + store.apiKey.slice(-4) : "";
      }
      sendJson(res, 200, payload);
      return;
    }

    if (req.method === "PUT" && route === "/api/admin/config") {
      await handleSaveConfig(req, res);
      return;
    }

    if (req.method === "PUT" && route === "/api/admin/apikey") {
      if (!hasRole(session, "superadmin")) {
        sendJson(res, 403, {
          status: "Error",
          message: "Only the super admin can manage the LeadByte API key."
        });
        return;
      }
      await handleSaveApiKey(req, res);
      return;
    }

    if (req.method === "POST" && route === "/api/admin/users") {
      await handleCreateUser(req, res, session);
      return;
    }

    if (req.method === "POST" && route === "/api/admin/password") {
      await handlePassword(req, res, session);
      return;
    }

    if (req.method === "GET" && route === "/api/admin/leads") {
      sendJson(res, 200, { status: "Success", leads: store.leads, storage: USE_SUPABASE ? "supabase" : "local" });
      return;
    }

    if (req.method === "POST" && route === "/api/admin/leads/clear") {
      store.leads = [];
      await saveStore();
      sendJson(res, 200, { status: "Success" });
      return;
    }
  }

  sendJson(res, 404, { status: "Error", message: "Not found." });
}

async function start() {
  await loadStore();

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch(error => {
      sendJson(res, 500, { status: "Error", message: error.message });
    });
  });

  server.listen(PORT, HOST, () => {
    console.log(`KCS Homegrown portal running on http://${HOST}:${PORT}`);
    console.log(`Forwarding leads to ${LEADBYTE_URL}`);
    console.log(`Using ${USE_SUPABASE ? "Supabase" : "local file"} storage`);
  });
}

start().catch(error => {
  console.error(error.message);
  process.exit(1);
});
