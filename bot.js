const { 
    default: makeWASocket, 
    DisconnectReason, 
    Browsers, 
    useMultiFileAuthState,
    fetchLatestBaileysVersion 
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const qrcode = require("qrcode-terminal");
const express = require('express');

// --- SERVER PER RENDER ---
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot Anti-Nuke Attivo!'));
app.listen(port, () => console.log(`Server attivo sulla porta ${port}`));

const msgCounter = {}; 
const nukeTracker = {};
const whitelist = ["393331234567@s.whatsapp.net"]; // Metti il tuo numero qui

async function startBot() {
    // Sessione salvata nella cartella "auth_info"
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        browser: Browsers.ubuntu('Chrome'),
        printQRInTerminal: true
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log("📷 SCANSIONA IL QR NEI LOG DI RENDER:");
            qrcode.generate(qr, { small: true });
        }
        if (connection === "close") {
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            if (reason !== DisconnectReason.loggedOut) startBot();
        } else if (connection === "open") {
            console.log("✅ BOT ONLINE E COLLEGATO!");
        }
    });

    // --- PROTEZIONE ANTI-NUKE ---
    sock.ev.on("group-participants.update", async (update) => {
        const { id, participants, action, author } = update;
        if (action === "remove" && author && !whitelist.includes(author)) {
            nukeTracker[author] = (nukeTracker[author] || 0) + participants.length;
            if (nukeTracker[author] > 3) {
                await sock.groupParticipantsUpdate(id, [author], "remove");
                await sock.sendMessage(id, { text: "🚨 Sistema Anti-Nuke: Utente rimosso." });
                delete nukeTracker[author];
            }
            setTimeout(() => { delete nukeTracker[author]; }, 30000);
        }
    });

    // --- ANTI-LINK & ANTI-SPAM ---
    sock.ev.on("messages.upsert", async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;
        const jid = m.key.remoteJid;
        if (!jid.endsWith('@g.us')) return;
        const sender = m.key.participant || m.key.remoteJid;
        const text = m.message.conversation || m.message.extendedTextMessage?.text || "";

        if (/(https?:\/\/[^\s]+)/g.test(text) && !whitelist.includes(sender)) {
            await sock.sendMessage(jid, { delete: m.key });
            await sock.groupParticipantsUpdate(jid, [sender], "remove");
        }
    });
}

startBot().catch(err => console.error("Errore:", err));
