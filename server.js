const express  = require('express');
const Database = require('better-sqlite3');
const path     = require('path');
const https    = require('https');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── SQLite ────────────────────────────────────────────────────────────────────
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'homeclimate.db');
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS readings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    sensor_id   INTEGER NOT NULL,
    temperature REAL,
    humidity    REAL,
    temp_valid  INTEGER DEFAULT 1,
    hum_valid   INTEGER DEFAULT 0,
    created_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  );
  CREATE INDEX IF NOT EXISTS idx_readings_time ON readings (created_at DESC);
`);
console.log(`DB: ${DB_PATH}`);

// ── Конфиг ────────────────────────────────────────────────────────────────────
const API_KEY            = process.env.API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const TEMP_MIN           = parseFloat(process.env.TEMP_MIN || '-10');
const TEMP_MAX           = parseFloat(process.env.TEMP_MAX || '35');

// ── Telegram алерты ───────────────────────────────────────────────────────────
const lastAlert = {};
const ALERT_COOLDOWN = 30 * 60 * 1000;

function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const body = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text });
  const req = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  });
  req.on('error', () => {});
  req.write(body);
  req.end();
}

function checkAlerts(sensor_id, temperature) {
  if (temperature == null) return;
  const now = Date.now();
  if (temperature < TEMP_MIN || temperature > TEMP_MAX) {
    if (!lastAlert[sensor_id] || now - lastAlert[sensor_id] > ALERT_COOLDOWN) {
      lastAlert[sensor_id] = now;
      const label = sensor_id === 1 ? 'Улица' : 'Дом';
      const emoji = temperature < TEMP_MIN ? '🥶' : '🌡';
      sendTelegram(`${emoji} HomeClimate — ${label}: ${temperature.toFixed(1)}°C`);
    }
  }
}

// ── Авторизация ───────────────────────────────────────────────────────────────
function auth(req, res, next) {
  if (!API_KEY || req.headers['x-api-key'] !== API_KEY)
    return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── POST /api/data ────────────────────────────────────────────────────────────
app.post('/api/data', auth, (req, res) => {
  const { sensor_id, temperature, humidity, temp_valid, hum_valid } = req.body;
  if (!sensor_id) return res.status(400).json({ error: 'sensor_id required' });
  try {
    db.prepare(
      `INSERT INTO readings (sensor_id, temperature, humidity, temp_valid, hum_valid)
       VALUES (?, ?, ?, ?, ?)`
    ).run(sensor_id, temperature ?? null, humidity ?? null, temp_valid ? 1 : 0, hum_valid ? 1 : 0);
    console.log(`[data] sensor=${sensor_id} t=${temperature} h=${humidity}`);
    if (temp_valid) checkAlerts(sensor_id, temperature);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── GET /api/latest ───────────────────────────────────────────────────────────
app.get('/api/latest', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT sensor_id, temperature, humidity, temp_valid, hum_valid, created_at
      FROM readings
      WHERE id IN (SELECT MAX(id) FROM readings GROUP BY sensor_id)
      ORDER BY sensor_id
    `).all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'DB error' });
  }
});

// ── GET /api/history ──────────────────────────────────────────────────────────
app.get('/api/history', (req, res) => {
  const all       = req.query.all === 'true';
  const hours     = all ? null : Math.min(Math.max(parseInt(req.query.hours) || 24, 1), 87600);
  const sensor_id = parseInt(req.query.sensor_id) || null;
  try {
    let query  = `SELECT sensor_id, temperature, humidity, created_at FROM readings WHERE temp_valid = 1`;
    const params = [];
    if (!all) {
      query += ` AND datetime(created_at) > datetime('now', ?)`;
      params.push(`-${hours} hours`);
    }
    if (sensor_id) {
      query += ` AND sensor_id = ?`;
      params.push(sensor_id);
    }
    query += ` ORDER BY created_at ASC`;
    res.json(db.prepare(query).all(...params));
  } catch (err) {
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Старт ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HomeClimate server on port ${PORT}`));
