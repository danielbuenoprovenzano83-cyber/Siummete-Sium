const { 
    default: makeWASocket, 
    DisconnectReason, 
    Browsers, 
    fetchLatestBaileysVersion 
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const qrcode = require("qrcode-terminal");
const express = require('express');
const mongoose = require("mongoose");
const { useMongoDBAuthState } = require("@adiwajshing/baileys-mongodb");

// --- SERVER PER RENDER ---
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot Anti-Nuke Online!'));
app.listen(port, () => console.log(`✅ Server attivo sulla porta ${port}`));

const nukeTracker = {};
const spamTracker = {}; 
const whitelist = ["393331234567@s.whatsapp.net"]; // CAMBIA CON IL TUO NUMERO
const mongoURL = process.env.MONGODB_URL;

async function startBot() {
    if (!mongoURL) {
        console.error("❌ ERRORE: MONGODB_URL mancante su Render!");
        process.exit(1);
    }

    // Connessione MongoDB e setup Auth
    await mongoose.connect(mongoURL);
    const collection = mongoose.connection.db.collection("auth_info_baileys");
    const { state, saveCreds } = await useMongoDBAuthState(collection);
    
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true,
        browser: Browsers.ubuntu('Chrome')
    });

    sock.ev.on("creds.update", saveCreds);

    const notifyAdmins = async (jid, text) => {
        try {
            const metadata = await sock.groupMetadata(jid);
            const admins = metadata.participants.filter(p => p.admin).map(p => p.id);
            await sock.sendMessage(jid, { text: text, mentions: admins });
        } catch (e) {}
    };

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) qrcode.generate(qr, { small: true });
        
        if (connection === "close") {
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            if (reason !== DisconnectReason.loggedOut) startBot();
        } else if (connection === "open") {
            console.log("🚀 BOT ONLINE!");
        }
    });

    // --- PROTEZIONE ANTI-NUKE ---
    sock.ev.on("group-participants.update", async (update) => {
        const { id, participants, action, author } = update;
        if (action === "add") {
            for (let p of participants) {
                if (["212", "92", "234", "254"].some(prefix => p.startsWith(prefix)) && !whitelist.includes(p)) {
                    await sock.groupParticipantsUpdate(id, [p], "remove");
                    await notifyAdmins(id, `🛡️ Rimosso sospetto: @${p.split('@')[0]}`);
                }
            }
        }
        if (action === "remove" && author && !whitelist.includes(author)) {
            nukeTracker[author] = (nukeTracker[author] || 0) + participants.length;
            if (nukeTracker[author] > 3) {
                await sock.groupParticipantsUpdate(id, [author], "remove");
                await notifyAdmins(id, `🚨 Nuke rilevato da @${author.split('@')[0]}`);
            }
            setTimeout(() => delete nukeTracker[author], 30000);
        }
    });

    // --- ANTI-LINK / ANTI-SPAM ---
    sock.ev.on("messages.upsert", async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;
        const jid = m.key.remoteJid;
        const sender = m.key.participant || m.key.remoteJid;
        const text = m.message.conversation || m.message.extendedTextMessage?.text || "";

        if (whitelist.includes(sender) || !jid.endsWith('@g.us')) return;

        if (m.key.id.startsWith("BAE5") || /(https?:\/\/[^\s]+)/g.test(text)) {
            await sock.sendMessage(jid, { delete: m.key });
            await sock.groupParticipantsUpdate(jid, [sender], "remove");
            return;
        }

        const spamKey = `${sender}_spam`;
        spamTracker[spamKey] = (spamTracker[spamKey] || 0) + 1;
        if (spamTracker[spamKey] >= 10) {
            await sock.groupParticipantsUpdate(jid, [sender], "remove");
            delete spamTracker[spamKey];
        }
        setTimeout(() => delete spamTracker[spamKey], 15000);
    });
}

startBot().catch(err => console.error(err));
