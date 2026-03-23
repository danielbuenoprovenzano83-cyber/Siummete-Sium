const { 
    default: makeWASocket, 
    DisconnectReason, 
    useMultiFileAuthState,
    fetchLatestBaileysVersion 
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const express = require('express');
const pino = require('pino');
const mongoose = require('mongoose');
const fs = require('fs');

// --- CONFIGURAZIONE ---
const MONGO_URL = process.env.MONGO_URL;
const ME_NUMBER = "6285137595799"; 
const whitelist = ["393331234567@s.whatsapp.net"];

// --- SERVER PER RENDER ---
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('🛡️ Bot Anti-Nuke Online con MongoDB!'));
app.listen(port, () => console.log(`✅ [1/4] Server attivo sulla porta ${port}`));

// --- SCHEMA MONGODB PER LA SESSIONE ---
const SessionSchema = new mongoose.Schema({
    id: { type: String, default: 'session' },
    data: { type: String }
});
const Session = mongoose.model('Session', SessionSchema);

const nukeTracker = {};
const spamTracker = {}; 
let messagesProcessedThisSecond = 0;
setInterval(() => { messagesProcessedThisSecond = 0; }, 1000);

// Funzione per salvare/caricare file da MongoDB
async function syncSession(action) {
    if (action === 'load') {
        const doc = await Session.findOne({ id: 'session' });
        if (doc) {
            if (!fs.existsSync('./auth_info')) fs.mkdirSync('./auth_info');
            const files = JSON.parse(doc.data);
            for (const [file, content] of Object.entries(files)) {
                fs.writeFileSync(`./auth_info/${file}`, content);
            }
            console.log("📂 Sessione recuperata da MongoDB");
        }
    } else {
        if (fs.existsSync('./auth_info')) {
            const files = fs.readdirSync('./auth_info');
            const sessionData = {};
            files.forEach(file => {
                if (file.endsWith('.json')) sessionData[file] = fs.readFileSync(`./auth_info/${file}`, 'utf-8');
            });
            await Session.findOneAndUpdate({ id: 'session' }, { data: JSON.stringify(sessionData) }, { upsert: true });
        }
    }
}

async function startBot() {
    console.log("🚀 [2/4] Connessione a MongoDB...");
    try {
        await mongoose.connect(MONGO_URL);
        await syncSession('load');
    } catch (e) { console.log("⚠️ Errore DB, procedo in locale"); }

    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();
    console.log(`🌐 [3/4] WhatsApp v${version}`);

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ["Mac OS", "Chrome", "122.0.6261.112"], 
        syncFullHistory: false,
        markOnlineOnConnect: true
    });

    // Salva le credenziali sia in locale che su MongoDB
    sock.ev.on('creds.update', async () => {
        await saveCreds();
        await syncSession('save');
    });

    // --- PAIRING CODE ---
    if (!sock.authState.creds.registered) {
        console.log(`\n⚠️ RICHIESTA CODICE PER: ${ME_NUMBER}`);
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(ME_NUMBER);
                console.log(`\n********************************************`);
                console.log(`* 🔑 CODICE PAIRING: ${code?.match(/.{1,4}/g)?.join("-")} *`);
                console.log(`********************************************\n`);
            } catch (error) { console.error("❌ Errore Pairing"); }
        }, 6000);
    }

    // --- 1. ANTI-NUKE ---
    sock.ev.on("group-participants.update", async (update) => {
        const { id, participants, action, author } = update;
        if (action === "add") {
            for (let p of participants) {
                const blacklisted = ["212", "92", "234", "254"]; 
                if (blacklisted.some(pre => p.startsWith(pre)) && !whitelist.includes(p)) {
                    await sock.groupParticipantsUpdate(id, [p], "remove");
                }
            }
        }
        if (action === "remove" && author && !whitelist.includes(author)) {
            nukeTracker[author] = (nukeTracker[author] || 0) + participants.length;
            if (nukeTracker[author] > 3) {
                await sock.groupParticipantsUpdate(id, [author], "remove");
                delete nukeTracker[author];
            }
            setTimeout(() => delete nukeTracker[author], 30000);
        }
    });

    // --- 2. ANTI-SPAM & RATE LIMIT ---
    sock.ev.on("messages.upsert", async ({ messages }) => {
        const m = messages[0];
        if (!m || !m.message || m.key.fromMe) return;

        if (messagesProcessedThisSecond >= 60) return;
        messagesProcessedThisSecond++;

        const jid = m.key.remoteJid;
        if (!jid.endsWith('@g.us')) return;

        const sender = m.key.participant || m.key.remoteJid;
        const msgId = m.key.id;
        const text = m.message.conversation || m.message.extendedTextMessage?.text || "";

        if (whitelist.includes(sender)) return;

        const isBot = msgId.startsWith("BAE5") || msgId.startsWith("3EB0") || msgId.length < 15;
        const hasLink = /(https?:\/\/[^\s]+)/g.test(text);

        if (isBot || hasLink) {
            await sock.sendMessage(jid, { delete: m.key });
            await sock.groupParticipantsUpdate(jid, [sender], "remove");
            return;
        }

        if (!spamTracker[sender]) spamTracker[sender] = 0;
        spamTracker[sender]++;

        if (spamTracker[sender] >= 10) { 
            await sock.sendMessage(jid, { delete: m.key });
            await sock.groupParticipantsUpdate(jid, [sender], "remove");
            const metadata = await sock.groupMetadata(jid);
            const admins = metadata.participants.filter(p => p.admin).map(p => p.id);
            await sock.sendMessage(jid, { 
                text: `🚫 *ANTI-SPAM*\nUtente rimosso per spam eccessivo.`, 
                mentions: admins 
            });
            delete spamTracker[sender];
            return;
        }
        setTimeout(() => { if (spamTracker[sender] > 0) spamTracker[sender]--; }, 10000);
    });

    // --- CONNESSIONE ---
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom) ? 
                lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true;
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('✅ [4/4] BOT ONLINE E SINCRONIZZATO!');
        }
    });
}

startBot().catch(err => console.error("Errore fatale:", err));
