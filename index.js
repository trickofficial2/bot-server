const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { createClient } = require('@libsql/client');

const app = express();
app.use(express.json());
app.use(cors());

// Turso Database কানেকশন
const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// ডাটাবেজ টেবিল তৈরি (যদি আগে না থাকে)
async function initDB() {
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
  console.log("Database tables ready!");
}
initDB().catch(console.error);

// ১. হেলথ চেক রুট
app.get('/', (req, res) => {
  res.send('Telegram Bot Server is Running smoothly!');
});

// ২. অ্যান্ড্রয়েড অ্যাপের জন্য: সব বটের লিস্ট দেখা
app.get('/api/bots', async (req, res) => {
  try {
    const result = await db.execute("SELECT * FROM bots ORDER BY id DESC");
    res.json({ success: true, bots: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ৩. অ্যান্ড্রয়েড অ্যাপের জন্য: নতুন বট যুক্ত করা
app.post('/api/bots', async (req, res) => {
  const { name, token } = req.body;
  if (!name || !token) return res.status(400).json({ error: "Name and Token required" });

  try {
    // টেলিগ্রামে ওয়েবহুক সেট করা
    const serverUrl = process.env.SERVER_URL; // Render URL
    const webhookRes = await fetch(`https://api.telegram.org/bot${token}/setWebhook?url=${serverUrl}/webhook/${token}`);
    const webhookData = await webhookRes.json();

    if (!webhookData.ok) {
      return res.status(400).json({ success: false, message: "Invalid Bot Token or Telegram error" });
    }

    await db.execute({
      sql: "INSERT INTO bots (name, token) VALUES (?, ?)",
      args: [name, token]
    });

    res.json({ success: true, message: "Bot added & Webhook connected!" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ৪. অ্যান্ড্রয়েড অ্যাপের জন্য: বটের কমান্ড যুক্ত করা
app.post('/api/commands', async (req, res) => {
  const { bot_token, trigger, response } = req.body;
  if (!bot_token || !trigger || !response) return res.status(400).json({ error: "Missing fields" });

  try {
    await db.execute({
      sql: "INSERT INTO commands (bot_token, trigger, response) VALUES (?, ?, ?)",
      args: [bot_token, trigger.trim().toLowerCase(), response]
    });
    res.json({ success: true, message: "Command saved successfully!" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ৫. টেলিগ্রাম থেকে মেসেজ রিসিভ ও অটো-রিপ্লাই দেওয়ার রুট
app.post('/webhook/:token', async (req, res) => {
  const { token } = req.params;
  const update = req.body;

  if (update.message && update.message.text) {
    const chatId = update.message.chat.id;
    const userText = update.message.text.trim().toLowerCase();

    // ডাটাবেজ থেকে এই বটের কমান্ড চেক করা
    const cmdResult = await db.execute({
      sql: "SELECT response FROM commands WHERE bot_token = ? AND trigger = ?",
      args: [token, userText]
    });

    if (cmdResult.rows.length > 0) {
      const botReply = cmdResult.rows[0].response;
      // টেলিগ্রামে উত্তর পাঠানো
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: botReply })
      });
    }
  }

  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
