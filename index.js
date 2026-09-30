const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { createClient } = require('@libsql/client');

const app = express();
app.use(express.json());
app.use(cors());

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function initDB() {
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS bots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        token TEXT UNIQUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await db.execute(`
      CREATE TABLE IF NOT EXISTS commands (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_token TEXT,
        trigger TEXT,
        response TEXT
      );
    `);
  } catch (e) {
    console.error("DB Init Error:", e);
  }
}

app.get('/', (req, res) => {
  res.send('Telegram Bot Server is Running smoothly!');
});

app.get('/api/bots', async (req, res) => {
  try {
    await initDB();
    const result = await db.execute("SELECT * FROM bots ORDER BY id DESC");
    res.json({ success: true, bots: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/bots', async (req, res) => {
  const { name, token } = req.body;
  if (!name || !token) return res.status(400).json({ success: false, error: "Name and Token required" });

  try {
    await initDB();
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'bot-server-rho.vercel.app';
    const serverUrl = `https://${host}`;
    
    // Telegram Webhook Setup
    const webhookRes = await fetch(`https://api.telegram.org/bot${token}/setWebhook?url=${serverUrl}/webhook/${token}`);
    const webhookData = await webhookRes.json();

    if (!webhookData.ok) {
      return res.status(400).json({ success: false, error: webhookData.description || "Invalid Bot Token" });
    }

    await db.execute({
      sql: "INSERT OR REPLACE INTO bots (name, token) VALUES (?, ?)",
      args: [name, token]
    });

    res.json({ success: true, message: "Bot added successfully!" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/webhook/:token', async (req, res) => {
  const { token } = req.params;
  const update = req.body;

  if (update.message && update.message.text) {
    const chatId = update.message.chat.id;
    const userText = update.message.text.trim().toLowerCase();

    const cmdResult = await db.execute({
      sql: "SELECT response FROM commands WHERE bot_token = ? AND trigger = ?",
      args: [token, userText]
    });

    if (cmdResult.rows.length > 0) {
      const botReply = cmdResult.rows[0].response;
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: botReply })
      });
    }
  }

  res.sendStatus(200);
});

module.exports = app;
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on port ${PORT}`));
