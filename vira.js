// Vira Earth — secure connector between the dashboard and Airtable.
// Runs on Netlify. The Airtable token lives only here (as an environment
// variable), never in the web page.
//
// Environment variables (Netlify → Site configuration → Environment variables):
//   AIRTABLE_TOKEN    your Airtable personal access token (starts with "pat")
//   AIRTABLE_BASE_ID  the base id (starts with "app")
//   APP_SECRET        any long random text; used to sign logins
//   AIRTABLE_API      (optional, testing only) a different Airtable address
const crypto = require('crypto');

const TABLES = ['Products','Customers','Users','Gold Rates','Settings','Karigars',
  'Quotations','Orders','Estimates','On Approval','Receipts','Memos','Material Issues',
  'Leaves','Day Close','App Data'];
const API = (process.env.AIRTABLE_API || 'https://api.airtable.com/v0').replace(/\/$/,'');
const TOKEN = process.env.AIRTABLE_TOKEN || '';
const BASE = process.env.AIRTABLE_BASE_ID || '';
const SECRET = process.env.APP_SECRET || '';
const SESSION_HOURS = 12;
const SCHEMA = require('./schema.json');
// Your existing stock sheet (from the earlier price dashboard). Read only; shown in Inventory.
const STOCK_TABLE = process.env.AIRTABLE_TABLE || 'inventory';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const json = (status, body) => ({ statusCode: status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' },
  body: JSON.stringify(body) });

async function at(path, opts = {}, tries = 3) {
  const res = await fetch(API + '/' + BASE + '/' + path, Object.assign({}, opts, {
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' } }));
  if (res.status === 429 && tries > 0) { await sleep(1500); return at(path, opts, tries - 1); }
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }
  if (!res.ok) {
    const msg = (data && data.error && (data.error.message || data.error.type || data.error)) || ('HTTP ' + res.status);
    const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg)); err.status = res.status; throw err;
  }
  return data;
}
const tpath = t => encodeURIComponent(t);

async function listAll(table, formula) {
  let out = [], offset = '';
  do {
    let q = '?pageSize=100' + (offset ? '&offset=' + encodeURIComponent(offset) : '');
    if (formula) q += '&filterByFormula=' + encodeURIComponent(formula);
    const d = await at(tpath(table) + q);
    out = out.concat((d.records || []).map(r => ({ id: r.id, fields: r.fields || {} })));
    offset = d.offset || '';
    if (offset) await sleep(210);
  } while (offset);
  return out;
}

// ── signed login tokens ──
const b64 = s => Buffer.from(s).toString('base64url');
function sign(payload) {
  const body = b64(JSON.stringify(payload));
  return body + '.' + crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
}
function verify(tok) {
  if (!tok || tok.indexOf('.') < 0) return null;
  const [body, sig] = tok.split('.');
  const good = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return p.exp > Date.now() ? p : null; } catch (e) { return null; }
}
const esc = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const isActive = f => !(f.Active === false || String(f.Active).toLowerCase() === 'no');

async function findUser(id) {
  const rows = await listAll('Users', "UPPER(TRIM({ID}))='" + esc(String(id).trim().toUpperCase()) + "'");
  return rows[0] || null;
}


// ── one-time setup: creates every table and column, then the first logins ──
async function meta(path, opts = {}) {
  const res = await fetch(API + '/meta/bases/' + BASE + '/' + path, Object.assign({}, opts, {
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' } }));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    let msg = (data.error && (data.error.message || data.error.type)) || ('HTTP ' + res.status);
    if (res.status === 403 || res.status === 401) msg = 'Airtable refused. Check the token has the schema.bases:read and schema.bases:write scopes and access to this base. (' + msg + ')';
    const e = new Error(msg); e.status = 400; throw e;
  }
  return data;
}
async function runSetup(req) {
  const log = [];
  const have = (await meta('tables')).tables || [];
  for (const t of SCHEMA.tables) {
    const cur = have.find(x => x.name.toLowerCase() === t.name.toLowerCase());
    if (!cur) {
      await meta('tables', { method: 'POST', body: JSON.stringify(t) });
      log.push('Created table ' + t.name + ' (' + t.fields.length + ' columns)');
    } else {
      let added = 0;
      for (const f of t.fields) {
        if (cur.fields.some(x => x.name.toLowerCase() === f.name.toLowerCase())) continue;
        await meta('tables/' + cur.id + '/fields', { method: 'POST', body: JSON.stringify(f) });
        added++; await sleep(210);
      }
      log.push(t.name + ' already there' + (added ? ', added ' + added + ' missing columns' : ''));
    }
    await sleep(250);
  }
  const users = await listAll('Users');
  if (!users.length) {
    const a = String(req.adminPin || ''), e = String(req.staffPin || '');
    const today = new Date().toISOString().slice(0, 10);
    const rows = [['RITU','Ritu','Admin',a],['VARUN','Varun','Admin',a],['E01','Vikas Saini','Employee',e],['E02','Bhawna Maheshwary','Employee',e],['E03','Kamini','Employee',e]]
      .map(r => ({ fields: { ID: r[0], Name: r[1], Role: r[2], PIN: r[3], Active: true, Created: today } }));
    await at(tpath('Users'), { method: 'POST', body: JSON.stringify({ records: rows, typecast: true }) });
    log.push('Added logins: RITU, VARUN (admins), E01, E02, E03 (employees)');
  } else log.push('Users already has ' + users.length + ' logins, left unchanged');
  const settings = await listAll('Settings');
  if (!settings.length) {
    for (let i = 0; i < SCHEMA.settings.length; i += 10) {
      await at(tpath('Settings'), { method: 'POST', body: JSON.stringify({ records: SCHEMA.settings.slice(i, i + 10).map(f => ({ fields: f })), typecast: true }) });
      await sleep(210);
    }
    log.push('Added ' + SCHEMA.settings.length + ' shop settings');
  } else log.push('Settings already filled, left unchanged');
  return log;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  let req; try { req = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Bad request' }); }
  const configured = !!(TOKEN && BASE && SECRET);
  if (req.action === 'ping') return json(200, { ok: true, configured, missing: [['AIRTABLE_TOKEN', TOKEN], ['AIRTABLE_BASE_ID', BASE], ['APP_SECRET', SECRET]].filter(x => !x[1]).map(x => x[0]) });
  if (!configured) return json(500, { error: 'Connector not set up: add AIRTABLE_TOKEN, AIRTABLE_BASE_ID and APP_SECRET in Netlify.' });

  try {
    if (req.action === 'setup') {
      const k = String(req.key || '');
      if (k.length !== SECRET.length || !crypto.timingSafeEqual(Buffer.from(k), Buffer.from(SECRET))) return json(401, { error: 'Setup key is wrong. Use the APP_SECRET value from Netlify.' });
      if (String(req.adminPin || '').length < 6 || String(req.staffPin || '').length < 4) return json(400, { error: 'Admin password needs 6+ characters, staff PIN 4+.' });
      return json(200, { ok: true, log: await runSetup(req) });
    }
    if (req.action === 'login') {
      const u = await findUser(req.id || '');
      const f = u ? u.fields : {};
      if (!u || !isActive(f) || String(f.PIN == null ? '' : f.PIN) !== String(req.pin || '') || !String(req.pin || ''))
        return json(401, { error: 'Invalid ID or password.' });
      const role = String(f.Role || '').toLowerCase() === 'admin' ? 'admin' : 'staff';
      const user = { id: String(f.ID).trim().toUpperCase(), name: f.Name || f.ID, role };
      return json(200, { ok: true, user, token: sign(Object.assign({}, user, { exp: Date.now() + SESSION_HOURS * 3600e3 })) });
    }

    const auth = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '');
    const me = verify(auth);
    if (!me) return json(401, { error: 'Please sign in again.' });

    if (req.action === 'changePin') {
      const u = await findUser(me.id);
      if (!u || String(u.fields.PIN || '') !== String(req.current || '')) return json(400, { error: 'Current password is incorrect.' });
      if (String(req.next || '').length < 4) return json(400, { error: 'New password must be at least 4 characters.' });
      await at(tpath('Users'), { method: 'PATCH', body: JSON.stringify({ records: [{ id: u.id, fields: { PIN: String(req.next) } }], typecast: true }) });
      return json(200, { ok: true });
    }

    if (req.table === '__stock') {
      if (req.action !== 'list') return json(403, { error: 'The stock sheet is read only.' });
      try { return json(200, { ok: true, records: await listAll(STOCK_TABLE) }); }
      catch (e) { return json(200, { ok: true, records: [], note: 'No stock sheet: ' + e.message }); }
    }
    const table = req.table;
    if (TABLES.indexOf(table) < 0) return json(400, { error: 'Unknown table: ' + table });

    if (req.action === 'list') {
      let rows = await listAll(table);
      if (table === 'Users') rows = rows.map(r => { const f = Object.assign({}, r.fields); delete f.PIN; return { id: r.id, fields: f }; });
      return json(200, { ok: true, records: rows });
    }

    if (req.action === 'write') {
      const creates = (req.creates || []).slice(0, 50), updates = (req.updates || []).slice(0, 50), deletes = (req.deletes || []).slice(0, 50);
      if (table === 'Users' && me.role !== 'admin') {
        // Staff may only rename themselves.
        if (creates.length || deletes.length) return json(403, { error: 'Only an admin can add or remove staff.' });
        for (const u of updates) {
          const cur = await at(tpath('Users') + '/' + encodeURIComponent(u.id));
          if (String(cur.fields.ID || '').toUpperCase() !== me.id) return json(403, { error: 'Not allowed.' });
          u.fields = { Name: u.fields.Name };
        }
      }
      if (table === 'Users') { // never let a write change someone into an admin unless an admin did it
        if (me.role !== 'admin') updates.forEach(u => { delete u.fields.Role; delete u.fields.PIN; });
      }
      const out = { created: [], updated: [], deleted: [] };
      for (let i = 0; i < creates.length; i += 10) {
        const d = await at(tpath(table), { method: 'POST', body: JSON.stringify({ records: creates.slice(i, i + 10).map(f => ({ fields: f })), typecast: true }) });
        out.created = out.created.concat(d.records.map(r => ({ id: r.id, fields: r.fields })));
        await sleep(210);
      }
      for (let i = 0; i < updates.length; i += 10) {
        const d = await at(tpath(table), { method: 'PATCH', body: JSON.stringify({ records: updates.slice(i, i + 10).map(u => ({ id: u.id, fields: u.fields })), typecast: true }) });
        out.updated = out.updated.concat(d.records.map(r => ({ id: r.id, fields: r.fields })));
        await sleep(210);
      }
      for (let i = 0; i < deletes.length; i += 10) {
        const q = deletes.slice(i, i + 10).map(id => 'records[]=' + encodeURIComponent(id)).join('&');
        const d = await at(tpath(table) + '?' + q, { method: 'DELETE' });
        out.deleted = out.deleted.concat((d.records || []).map(r => r.id));
        await sleep(210);
      }
      if (table === 'Users') { out.created.forEach(r => delete r.fields.PIN); out.updated.forEach(r => delete r.fields.PIN); }
      return json(200, Object.assign({ ok: true }, out));
    }
    return json(400, { error: 'Unknown action' });
  } catch (e) {
    return json(e.status && e.status < 500 ? e.status : 502, { error: e.message || String(e), table: req.table });
  }
};
