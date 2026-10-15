/**
 * WHATSAPP IMS AUTOMATION BOT (RENDER + POSTGRESQL + GOOGLE SHEETS)
 */
const express = require('express');
const { default: makeWASocket, DisconnectReason, BufferJSON, initAuthCreds } = require('@whiskeysockets/baileys');
const { Pool } = require('pg');
const QRCode = require('qrcode');
const axios = require('axios');
const pino = require('pino');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL && DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false }
});

let sock = null;
let currentQR = null;
let connectionStatus = "INITIALIZING";
let connectedUser = null;

async function usePostgresAuthState(dbPool) {
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_sessions (
      key VARCHAR(255) PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const readData = async (key) => {
    try {
      const res = await dbPool.query('SELECT value FROM whatsapp_sessions WHERE key = $1', [key]);
      return res.rows.length > 0 ? JSON.parse(res.rows[0].value, BufferJSON.reviver) : null;
    } catch (err) {
      return null;
    }
  };

  const writeData = async (key, value) => {
    try {
      const strVal = JSON.stringify(value, BufferJSON.replacer);
      await dbPool.query(`
        INSERT INTO whatsapp_sessions (key, value)
        VALUES ($1, $2)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
      `, [key, strVal]);
    } catch (err) {
      console.error(`DB Write Error:`, err);
    }
  };

  const removeData = async (key) => {
    try {
      await dbPool.query('DELETE FROM whatsapp_sessions WHERE key = $1', [key]);
    } catch (err) {}
  };

  let creds = await readData('creds');
  if (!creds) {
    creds = initAuthCreds();
    await writeData('creds', creds);
  }

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          for (const id of ids) {
            const val = await readData(`${type}-${id}`);
            if (val) data[id] = val;
          }
          return data;
        },
        set: async (data) => {
          for (const category in data) {
            for (const id in data[category]) {
              const val = data[category][id];
              if (val) {
                await writeData(`${category}-${id}`, val);
              } else {
                await removeData(`${category}-${id}`);
              }
            }
          }
        }
      }
    },
    saveCreds: () => writeData('creds', creds)
  };
}

async function startWhatsAppBot() {
  try {
    if (!DATABASE_URL) {
      console.error("DATABASE_URL missing!");
      connectionStatus = "DB_URL_MISSING";
      return;
    }

    const { state, saveCreds } = await usePostgresAuthState(pool);

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
      logger: pino({ level: 'silent' }),
      browser: ['Arawali IMS Bot', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQR = qr;
        connectionStatus = "SCAN_QR";
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        connectionStatus = "DISCONNECTED";
        currentQR = null;

        if (statusCode === DisconnectReason.loggedOut) {
          await pool.query('DELETE FROM whatsapp_sessions;');
        }
        if (shouldReconnect) setTimeout(startWhatsAppBot, 5000);
      } else if (connection === 'open') {
        connectionStatus = "CONNECTED";
        currentQR = null;
        connectedUser = sock.user?.id || "Bot";
        console.log(`✅ WhatsApp Bot Connected! ID: ${connectedUser}`);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;
        const from = msg.key.remoteJid;
        if (!from || from.includes('@g.us') || from.includes('status@broadcast')) continue;

        const text = msg.message.conversation ||
                     msg.message.extendedTextMessage?.text ||
                     msg.message.imageMessage?.caption || "";

        const senderPhone = from.replace('@s.whatsapp.net', '');

        if (APPS_SCRIPT_URL) {
          try {
            const response = await axios.post(APPS_SCRIPT_URL, {
              from: senderPhone,
              body: text
            }, { timeout: 15000 });

            if (response.data && response.data.reply) {
              await sock.sendMessage(from, { text: response.data.reply });
            }
          } catch (err) {
            console.error("Apps Script forward error:", err.message);
          }
        }
      }
    });

  } catch (err) {
    connectionStatus = "ERROR: " + err.message;
    setTimeout(startWhatsAppBot, 10000);
  }
}

app.get('/', (req, res) => {
  res.send(`
    <div style="font-family: Arial; padding: 40px; text-align: center;">
      <h2>📦 Arawali IMS WhatsApp Bot</h2>
      <p>Status: <b style="color: ${connectionStatus === 'CONNECTED' ? 'green' : 'orange'};">${connectionStatus}</b></p>
      ${connectionStatus === 'CONNECTED' 
        ? `<p style="color: green;">✅ Connected as: <b>${connectedUser}</b></p>` 
        : `<p><a href="/qr" style="padding: 10px 20px; background: #25D366; color: white; text-decoration: none; border-radius: 6px;">Scan WhatsApp QR Code</a></p>`
      }
    </div>
  `);
});

app.get('/qr', async (req, res) => {
  if (connectionStatus === 'CONNECTED') {
    return res.send(`<h3>✅ WhatsApp Bot Connected hai!</h3><a href="/">Home</a>`);
  }
  if (!currentQR) {
    return res.send(`<h3>⏳ QR Code taiyar ho raha hai... 5 sec me refresh karein.</h3><script>setTimeout(() => location.reload(), 5000);</script>`);
  }
  try {
    const qrImage = await QRCode.toDataURL(currentQR);
    res.send(`
      <div style="font-family: Arial; text-align: center; padding: 30px;">
        <h2>📲 WhatsApp QR Code Scan Karein</h2>
        <p>WhatsApp ➔ Linked Devices ➔ Link a Device</p>
        <img src="${qrImage}" style="border: 4px solid #25D366; padding: 10px; border-radius: 10px;" />
        <script>setTimeout(() => location.reload(), 15000);</script>
      </div>
    `);
  } catch (err) {
    res.status(500).send("QR Error: " + err.message);
  }
});

app.post('/send-message', async (req, res) => {
  const { to, message, body } = req.body;
  const msgText = message || body;

  if (!sock || connectionStatus !== 'CONNECTED') {
    return res.status(503).json({ error: "WhatsApp Bot is not connected yet" });
  }
  if (!to || !msgText) {
    return res.status(400).json({ error: "Missing 'to' or 'message'" });
  }

  let cleanPhone = String(to).replace(/[^0-9]/g, '');
  if (cleanPhone.length === 10) cleanPhone = "91" + cleanPhone;
  const jid = `${cleanPhone}@s.whatsapp.net`;

  try {
    await sock.sendMessage(jid, { text: msgText });
    return res.json({ success: true, to: cleanPhone });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startWhatsAppBot();
});
