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
// Аддитивная миграция: столбец battery для уже существующей БД (идемпотентно).
try { db.exec(`ALTER TABLE readings ADD COLUMN battery REAL`); } catch (e) { /* столбец уже есть */ }
console.log(`DB: ${DB_PATH}`);

// ── Config ────────────────────────────────────────────────────────────────────
const API_KEY            = process.env.API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

// ── Telegram ──────────────────────────────────────────────────────────────────
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

// ── Alert state ───────────────────────────────────────────────────────────────
const ALERT_COOLDOWN    = 30 * 60 * 1000;  // 30 min between repeat alerts
const OFFLINE_THRESHOLD = 20 * 60 * 1000;  // 20 min silence = offline

const alertActive   = {};  // key -> bool  (condition currently active)
const alertCooldown = {};  // key -> timestamp of last send
const lastDataTime  = {};  // sensor_id -> timestamp
const lastValues    = {};  // sensor_id -> { temperature, humidity }

function canAlert(key) {
  return !alertCooldown[key] || Date.now() - alertCooldown[key] > ALERT_COOLDOWN;
}

function fireAlert(key, text) {
  alertActive[key]   = true;
  alertCooldown[key] = Date.now();
  console.log(`[alert] ${key}: ${text}`);
  sendTelegram(text);
}

function fireRecovery(key, text) {
  alertActive[key]   = false;
  alertCooldown[key] = Date.now();
  console.log(`[recovery] ${key}: ${text}`);
  sendTelegram(text);  // recovery always sends immediately
}

// ── Check alerts after each reading ──────────────────────────────────────────
function checkAlerts(sensor_id, temperature, humidity, battery = null) {
  lastDataTime[sensor_id] = Date.now();
  lastValues[sensor_id]   = { temperature, humidity };

  // ── Разряд батареи уличного (1S Li-ion): порог 3.40В, восстановление 3.60В ──
  if (sensor_id === 1 && battery != null) {
    if (battery < 3.40) {
      if (!alertActive['lowbat'] && canAlert('lowbat'))
        fireAlert('lowbat', `🔋 HomeClimate — Outdoor battery LOW: ${battery.toFixed(2)}V`);
    } else if (battery > 3.60 && alertActive['lowbat']) {
      fireRecovery('lowbat', `✅ HomeClimate — Outdoor battery OK: ${battery.toFixed(2)}V`);
    }
  }

  // Sensor came back online
  if (alertActive[`offline_${sensor_id}`]) {
    const label = sensor_id === 1 ? 'Outdoor' : 'Indoor';
    fireRecovery(`offline_${sensor_id}`, `✅ HomeClimate — ${label} sensor back online`);
  }

  if (temperature == null) return;

  // ── Outdoor sensor ────────────────────────────────────────────────────────
  if (sensor_id === 1) {
    // Frost: outdoor < 3°C
    if (temperature < 3) {
      if (!alertActive['frost'] && canAlert('frost'))
        fireAlert('frost', `❄️ HomeClimate — Frost warning: outdoor ${temperature.toFixed(1)}°C`);
    } else if (alertActive['frost']) {
      fireRecovery('frost', `✅ HomeClimate — No more frost: outdoor ${temperature.toFixed(1)}°C`);
    }
  }

  // ── Indoor sensor ─────────────────────────────────────────────────────────
  if (sensor_id === 2) {
    // Home too cold < 10°C
    if (temperature < 10) {
      if (!alertActive['home_cold'] && canAlert('home_cold'))
        fireAlert('home_cold', `🥶 HomeClimate — Home is cold: ${temperature.toFixed(1)}°C`);
    } else if (alertActive['home_cold']) {
      fireRecovery('home_cold', `✅ HomeClimate — Home temperature OK: ${temperature.toFixed(1)}°C`);
    }

    // High humidity > 70%
    if (humidity != null) {
      if (humidity > 70) {
        if (!alertActive['humidity_high'] && canAlert('humidity_high'))
          fireAlert('humidity_high', `💧 HomeClimate — High humidity: ${humidity.toFixed(0)}%`);
      } else if (alertActive['humidity_high']) {
        fireRecovery('humidity_high', `✅ HomeClimate — Humidity normal: ${humidity.toFixed(0)}%`);
      }
    }
  }

  // ── Cross-sensor: outdoor warmer than indoor → close windows ─────────────
  const out = lastValues[1]?.temperature;
  const ind = lastValues[2]?.temperature;
  if (out != null && ind != null) {
    if (out > ind + 2) {
      if (!alertActive['windows'] && canAlert('windows'))
        fireAlert('windows',
          `🌡 HomeClimate — Close windows! Outdoor (${out.toFixed(1)}°C) warmer than indoor (${ind.toFixed(1)}°C)`);
    } else if (alertActive['windows']) {
      fireRecovery('windows',
        `✅ HomeClimate — Outdoor cooler again: ${out.toFixed(1)}°C out / ${ind.toFixed(1)}°C in`);
    }
  }
}

// ── Periodic offline check (every 5 min) ─────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  [1, 2].forEach(id => {
    if (!lastDataTime[id]) return;
    const gap = now - lastDataTime[id];
    const label = id === 1 ? 'Outdoor' : 'Indoor';
    if (gap > OFFLINE_THRESHOLD && !alertActive[`offline_${id}`] && canAlert(`offline_${id}`))
      fireAlert(`offline_${id}`,
        `📡 HomeClimate — ${label} sensor offline (${Math.round(gap / 60000)} min without data)`);
  });
}, 5 * 60 * 1000);

// ── Auth ──────────────────────────────────────────────────────────────────────
function auth(req, res, next) {
  if (!API_KEY || req.headers['x-api-key'] !== API_KEY)
    return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── POST /api/data ────────────────────────────────────────────────────────────
app.post('/api/data', auth, (req, res) => {
  const { sensor_id, temperature, humidity, temp_valid, hum_valid, battery } = req.body;
  if (!sensor_id) return res.status(400).json({ error: 'sensor_id required' });
  try {
    db.prepare(
      `INSERT INTO readings (sensor_id, temperature, humidity, temp_valid, hum_valid, battery)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(sensor_id, temperature ?? null, humidity ?? null, temp_valid ? 1 : 0, hum_valid ? 1 : 0, battery ?? null);
    console.log(`[data] sensor=${sensor_id} t=${temperature} h=${humidity} bat=${battery ?? '-'}`);
    if (temp_valid) checkAlerts(sensor_id, temperature, hum_valid ? humidity : null, battery ?? null);
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
      SELECT sensor_id, temperature, humidity, temp_valid, hum_valid, battery, created_at
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
    let query   = `SELECT sensor_id, temperature, humidity, created_at FROM readings WHERE temp_valid = 1`;
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

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HomeClimate server on port ${PORT}`));
