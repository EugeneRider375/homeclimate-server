const express = require('express');
const { Pool }  = require('pg');
const path      = require('path');
const https     = require('https');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── PostgreSQL (Railway) ───────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS readings (
      id          SERIAL PRIMARY KEY,
      sensor_id   INTEGER NOT NULL,
      temperature REAL,
      humidity    REAL,
      temp_valid  BOOLEAN DEFAULT true,
      hum_valid   BOOLEAN DEFAULT false,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_readings_time ON readings (created_at DESC)`);
  console.log('DB ready');
}

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
app.post('/api/data', auth, async (req, res) => {
  const { sensor_id, temperature, humidity, temp_valid, hum_valid } = req.body;
  if (!sensor_id) return res.status(400).json({ error: 'sensor_id required' });
  try {
    await pool.query(
      `INSERT INTO readings (sensor_id, temperature, humidity, temp_valid, hum_valid) VALUES ($1,$2,$3,$4,$5)`,
      [sensor_id, temperature ?? null, humidity ?? null, temp_valid ?? true, hum_valid ?? false]
    );
    console.log(`[data] sensor=${sensor_id} t=${temperature} h=${humidity}`);
    if (temp_valid) checkAlerts(sensor_id, temperature);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── GET /api/latest ───────────────────────────────────────────────────────────
app.get('/api/latest', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT ON (sensor_id)
        sensor_id, temperature, humidity, temp_valid, hum_valid, created_at
      FROM readings ORDER BY sensor_id, created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'DB error' });
  }
});

// ── GET /api/history ──────────────────────────────────────────────────────────
app.get('/api/history', async (req, res) => {
  const all       = req.query.all === 'true';
  const hours     = all ? null : Math.min(Math.max(parseInt(req.query.hours) || 24, 1), 87600);
  const sensor_id = parseInt(req.query.sensor_id) || null;
  try {
    let query, params = [];
    if (all) {
      query = `SELECT sensor_id, temperature, humidity, created_at FROM readings WHERE temp_valid = true`;
      if (sensor_id) { params.push(sensor_id); query += ` AND sensor_id = $1`; }
    } else {
      params.push(hours);
      query = `SELECT sensor_id, temperature, humidity, created_at FROM readings WHERE created_at > NOW() - ($1 || ' hours')::interval AND temp_valid = true`;
      if (sensor_id) { params.push(sensor_id); query += ` AND sensor_id = $2`; }
    }
    query += ` ORDER BY created_at ASC`;
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Старт ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`HomeClimate server on port ${PORT}`);
  initDB().catch(err => console.error('DB init error:', err));
});
