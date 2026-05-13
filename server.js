const express = require('express');
const { Pool }  = require('pg');
const path      = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const API_KEY = process.env.API_KEY;

// ── База данных ───────────────────────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS readings (
      id         SERIAL PRIMARY KEY,
      sensor_id  INTEGER   NOT NULL,
      temperature REAL,
      humidity    REAL,
      temp_valid  BOOLEAN   DEFAULT true,
      hum_valid   BOOLEAN   DEFAULT false,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Удалять записи старше 30 дней автоматически
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_readings_time ON readings (created_at DESC)
  `);
  console.log('DB ready');
}

// ── Авторизация ───────────────────────────────────────────────────────────────
function auth(req, res, next) {
  if (!API_KEY || req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── POST /api/data — приём данных с D1 Mini ───────────────────────────────────
app.post('/api/data', auth, async (req, res) => {
  const { sensor_id, temperature, humidity, temp_valid, hum_valid } = req.body;
  if (!sensor_id) return res.status(400).json({ error: 'sensor_id required' });

  try {
    await pool.query(
      `INSERT INTO readings (sensor_id, temperature, humidity, temp_valid, hum_valid)
       VALUES ($1, $2, $3, $4, $5)`,
      [sensor_id, temperature ?? null, humidity ?? null, temp_valid ?? true, hum_valid ?? false]
    );
    console.log(`[data] sensor=${sensor_id} t=${temperature} h=${humidity}`);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── GET /api/latest — последние показания каждого датчика ─────────────────────
app.get('/api/latest', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT ON (sensor_id)
        sensor_id, temperature, humidity, temp_valid, hum_valid, created_at
      FROM readings
      ORDER BY sensor_id, created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'DB error' });
  }
});

// ── GET /api/history?hours=24 — история для графиков ─────────────────────────
app.get('/api/history', async (req, res) => {
  const hours     = Math.min(Math.max(parseInt(req.query.hours) || 24, 1), 168);
  const sensor_id = parseInt(req.query.sensor_id) || null;

  try {
    const params = [hours];
    let query = `
      SELECT sensor_id, temperature, humidity, created_at
      FROM readings
      WHERE created_at > NOW() - ($1 || ' hours')::interval
        AND temp_valid = true
    `;
    if (sensor_id) {
      params.push(sensor_id);
      query += ` AND sensor_id = $2`;
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
