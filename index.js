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
  if (first && first.type === 'error') throw new Error(first.error.message);

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
  await queryTurso(`
    CREATE TABLE IF NOT EXISTS commands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_token TEXT,
      trigger TEXT,
      response TEXT,
      buttons TEXT
    );
  `);
  await queryTurso(`
    CREATE TABLE IF NOT EXISTS properties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_token TEXT,
      user_id TEXT,
      prop_key TEXT,
      prop_value TEXT
    );
  `);
}

// টেলিগ্রাম API কল করার হেল্পার
async function callTelegram(token, method, payload) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return await res.json();
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

app.get('/', (req, res) => res.send('Bots.Business Engine is Active!'));

app.get('/api/bots', async (req, res) => {
  try {
    await initDB();
    const rows = await queryTurso("SELECT id, name, token FROM bots ORDER BY id DESC;");
    res.json({ success: true, bots: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/bots', async (req, res) => {
  const { name, token } = req.body;
  if (!name || !token) return res.status(400).json({ success: false, error: "Name and Token required" });

  try {
    await initDB();
    const serverUrl = "https://bot-server-rho.vercel.app";
    const webhookRes = await fetch(`https://api.telegram.org/bot${token}/setWebhook?url=${serverUrl}/webhook/${token}`);
    const webhookData = await webhookRes.json();

    if (!webhookData.ok) return res.status(400).json({ success: false, error: webhookData.description || "Invalid Bot Token" });

    await queryTurso("INSERT OR REPLACE INTO bots (name, token) VALUES (?, ?);", [name, token]);
    res.json({ success: true, message: "Bot connected successfully!" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/bots/update', async (req, res) => {
  const { old_token, new_name, new_token } = req.body;
  try {
    await initDB();
    const serverUrl = "https://bot-server-rho.vercel.app";
    const webhookRes = await fetch(`https://api.telegram.org/bot${new_token}/setWebhook?url=${serverUrl}/webhook/${new_token}`);
    const webhookData = await webhookRes.json();

    if (!webhookData.ok) return res.status(400).json({ success: false, error: "Invalid New Token" });

    if (old_token !== new_token) {
      await fetch(`https://api.telegram.org/bot${old_token}/deleteWebhook`);
      await queryTurso("UPDATE commands SET bot_token = ? WHERE bot_token = ?;", [new_token, old_token]);
      await queryTurso("UPDATE properties SET bot_token = ? WHERE bot_token = ?;", [new_token, old_token]);
    }

    await queryTurso("UPDATE bots SET name = ?, token = ? WHERE token = ?;", [new_name, new_token, old_token]);
    res.json({ success: true, message: "Bot updated successfully!" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/bots/delete', async (req, res) => {
  const { token } = req.body;
  try {
    await initDB();
    await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`);
    await queryTurso("DELETE FROM commands WHERE bot_token = ?;", [token]);
    await queryTurso("DELETE FROM properties WHERE bot_token = ?;", [token]);
    await queryTurso("DELETE FROM bots WHERE token = ?;", [token]);
    res.json({ success: true, message: "Bot deleted successfully" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

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

app.post('/api/commands', async (req, res) => {
  const { bot_token, trigger, response, buttons } = req.body;
  if (!bot_token || !trigger) return res.status(400).json({ success: false, error: "Trigger required" });

  const cleanTrigger = trigger.trim().toLowerCase();
  const respData = response ? response.trim() : "";
  const btnData = buttons ? buttons.trim() : "";

  try {
    await initDB();
    await queryTurso("DELETE FROM commands WHERE bot_token = ? AND trigger = ?;", [bot_token, cleanTrigger]);
    await queryTurso("INSERT INTO commands (bot_token, trigger, response, buttons) VALUES (?, ?, ?, ?);", [bot_token, cleanTrigger, respData, btnData]);
    res.json({ success: true, message: "Command saved successfully!" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/commands/delete', async (req, res) => {
  const { bot_token, trigger } = req.body;
  try {
    await initDB();
    await queryTurso("DELETE FROM commands WHERE bot_token = ? AND trigger = ?;", [bot_token, trigger.trim().toLowerCase()]);
    res.json({ success: true, message: "Command deleted successfully" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// বটের মেসেজ ও BJS এক্সিকিউশন
async function executeBotLogic(token, chatId, userId, triggerText, update) {
  const rows = await queryTurso("SELECT response, buttons FROM commands WHERE bot_token = ? AND trigger = ?;", [token, triggerText]);
  if (rows.length === 0) return;

  const codeOrText = rows[0].response || "";
  const rawButtons = rows[0].buttons || "";
  const fullCode = (codeOrText.includes("Bot.") || codeOrText.includes("User.") || codeOrText.includes("Api.")) ? codeOrText : rawButtons;

  if (fullCode && (fullCode.includes("Bot.") || fullCode.includes("User.") || fullCode.includes("Api."))) {
    // সম্পূর্ণ Bots.Business এনভায়রনমেন্ট
    const Bot = {
      sendMessage: async (text, opts = {}) => {
        const payload = { chat_id: chatId, text: String(text) };
        if (opts.is_html) payload.parse_mode = 'HTML';
        if (opts.parse_mode) payload.parse_mode = opts.parse_mode;
        return await callTelegram(token, 'sendMessage', payload);
      },
      sendKeyboard: async (buttonsStr, text) => {
        const keyboard = [];
        for (const line of buttonsStr.split('\n')) {
          if (line.trim().length > 0) keyboard.push(line.split(',').map(b => ({ text: b.trim() })));
        }
        return await callTelegram(token, 'sendMessage', {
          chat_id: chatId,
          text: String(text),
          reply_markup: { keyboard: keyboard, resize_keyboard: true }
        });
      },
      runCommand: async (cmd) => {
        await executeBotLogic(token, chatId, userId, cmd.trim().toLowerCase(), update);
      },
      getProperty: (k, def) => def,
      setProperty: async (k, v) => {}
    };

    const User = {
      setProperty: async (k, v) => {},
      getProperty: (k, def) => def
    };

    const Api = {
      deleteMessage: async (opts) => await callTelegram(token, 'deleteMessage', { chat_id: opts.chat_id || chatId, message_id: opts.message_id }),
      editMessageText: async (opts) => await callTelegram(token, 'editMessageText', { chat_id: opts.chat_id || chatId, message_id: opts.message_id, text: opts.text, parse_mode: opts.parse_mode || 'HTML' }),
      sendMessage: async (opts) => await callTelegram(token, 'sendMessage', { chat_id: opts.chat_id || chatId, text: opts.text, parse_mode: opts.parse_mode || 'HTML' })
    };

    try {
      const runFn = new Function('Bot', 'User', 'Api', 'request', 'chat', 'content', `return (async () => { ${fullCode} })();`);
      await runFn(Bot, User, Api, update, { chatid: chatId }, "");
    } catch (e) {
      console.error("BJS Error:", e);
    }
  } else {
    // সাধারণ টেক্সট ও কীবোর্ড বাটন
    const payload = { chat_id: chatId, text: codeOrText };
    if (rawButtons.length > 0) {
      const keyboard = [];
      for (const line of rawButtons.split('\n')) {
        if (line.trim().length > 0) {
          keyboard.push(line.split(',').map(b => ({ text: b.trim() })));
        }
      }
      payload.reply_markup = { keyboard: keyboard, resize_keyboard: true };
    }
    await callTelegram(token, 'sendMessage', payload);
  }
}

app.post('/webhook/:token', async (req, res) => {
  const { token } = req.params;
  const update = req.body;

  if (update.message && update.message.text) {
    const chatId = update.message.chat.id;
    const userId = String(update.message.from.id);
    const userText = update.message.text.trim().toLowerCase();
    await executeBotLogic(token, chatId, userId, userText, update);
  }

  res.sendStatus(200);
});

module.exports = app;
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on ${PORT}`));
