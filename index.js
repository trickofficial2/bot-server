const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());
app.use(cors());

const TURSO_URL = "https://mybotdb-santo1.aws-ap-south-1.turso.io/v2/pipeline";
const TURSO_TOKEN = "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3OTA3ODEwNjksImlkIjoiMDFhMGYyZGQtZWYwMS03MmRlLTgzN2YtY2RlMjEyZjVlYTRkIiwia2lkIjoiRFNyRWttN3FMb0ZmSTUxenI2SDNidEpUWUFKMDhSYm9ES2V4OGlVNWtZOCIsInJpZCI6ImNlODkwZGMwLWZhZDEtNGQzMy1iNDgwLTZmZThjOGUwOTdhOCJ9.ayzLRsARR6ai8HihuDVKFhmkoWnQWGw8OIjyybkzrXPKU-5QR85tpP_60MXBC6DZbMq8f3AgMpK_ETAm36wyCQ";

async function queryTurso(sql, args = []) {
  const stmtArgs = args.map(arg => ({
    type: typeof arg === 'number' ? 'integer' : 'text',
    value: String(arg)
  }));

  const res = await fetch(TURSO_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TURSO_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      requests: [
        { type: "execute", stmt: { sql: sql, args: stmtArgs } },
        { type: "close" }
      ]
    })
  });

  const data = await res.json();
  const first = data.results && data.results[0];
  if (first && first.type === 'error') {
    throw new Error(first.error.message);
  }

  if (first && first.response && first.response.result) {
    const r = first.response.result;
    const cols = r.cols ? r.cols.map(c => c.name) : [];
    return r.rows ? r.rows.map(row => {
      const obj = {};
      row.forEach((cell, idx) => { obj[cols[idx]] = cell.value; });
      return obj;
    }) : [];
  }
  return [];
}

async function initDB() {
  await queryTurso(`
    CREATE TABLE IF NOT EXISTS bots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      token TEXT UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  // buttons ফিল্ড সহ কমান্ড টেবিল
  await queryTurso(`
    CREATE TABLE IF NOT EXISTS commands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_token TEXT,
      trigger TEXT,
      response TEXT,
      buttons TEXT
    );
  `);
}

// বটের তালিকা
app.get('/api/bots', async (req, res) => {
  try {
    await initDB();
    const rows = await queryTurso("SELECT id, name, token FROM bots ORDER BY id DESC;");
    res.json({ success: true, bots: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// নির্দিষ্ট বটের সব কমান্ড লোড করা
app.get('/api/commands', async (req, res) => {
  const { token } = req.query;
  try {
    await initDB();
    const rows = await queryTurso("SELECT id, trigger, response, buttons FROM commands WHERE bot_token = ? ORDER BY id DESC;", [token]);
    res.json({ success: true, commands: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// নতুন বট যুক্ত
app.post('/api/bots', async (req, res) => {
  const { name, token } = req.body;
  if (!name || !token) return res.status(400).json({ success: false, error: "Name and Token required" });

  try {
    await initDB();
    const serverUrl = "https://bot-server-rho.vercel.app";
    const webhookRes = await fetch(`https://api.telegram.org/bot${token}/setWebhook?url=${serverUrl}/webhook/${token}`);
    const webhookData = await webhookRes.json();

    if (!webhookData.ok) {
      return res.status(400).json({ success: false, error: webhookData.description || "Invalid Bot Token" });
    }

    await queryTurso("INSERT OR REPLACE INTO bots (name, token) VALUES (?, ?);", [name, token]);
    res.json({ success: true, message: "Bot connected successfully!" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// কমান্ড সেভ অথবা আপডেট করা (UPDATE / INSERT)
app.post('/api/commands', async (req, res) => {
  const { bot_token, trigger, response, buttons } = req.body;
  if (!bot_token || !trigger || !response) return res.status(400).json({ success: false, error: "Trigger & Response required" });

  const cleanTrigger = trigger.trim().toLowerCase();
  const btnData = buttons ? buttons.trim() : "";

  try {
    await initDB();
    // আগের কমান্ড থাকলে মুছে নতুন করে সেভ করবে (Update Effect)
    await queryTurso("DELETE FROM commands WHERE bot_token = ? AND trigger = ?;", [bot_token, cleanTrigger]);
    await queryTurso("INSERT INTO commands (bot_token, trigger, response, buttons) VALUES (?, ?, ?, ?);", [bot_token, cleanTrigger, response, btnData]);
    res.json({ success: true, message: "Command saved successfully!" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// টেলিগ্রাম ওয়েব হুক (বাটন সহ মেসেজ পাঠানো)
app.post('/webhook/:token', async (req, res) => {
  const { token } = req.params;
  const update = req.body;

  if (update.message && update.message.text) {
    const chatId = update.message.chat.id;
    const userText = update.message.text.trim().toLowerCase();

    const rows = await queryTurso("SELECT response, buttons FROM commands WHERE bot_token = ? AND trigger = ?;", [token, userText]);

    if (rows.length > 0) {
      const botReply = rows[0].response;
      const rawButtons = rows[0].buttons;

      const payload = {
        chat_id: chatId,
        text: botReply
      };

      // যদি বাটন যুক্ত করা থাকে, তবে স্ক্রিনশটের মতো কীবোর্ড তৈরি হবে
      if (rawButtons && rawButtons.length > 0) {
        const keyboard = [];
        const lines = rawButtons.split('\n'); // প্রতি লাইন একটি করে রো (Row)
        for (const line of lines) {
          if (line.trim().length > 0) {
            const btns = line.split(',').map(b => ({ text: b.trim() }));
            keyboard.push(btns);
          }
        }
        payload.reply_markup = {
          keyboard: keyboard,
          resize_keyboard: true
        };
      }

      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }
  }

  res.sendStatus(200);
});

module.exports = app;
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on ${PORT}`));
