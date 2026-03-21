const { 
    default: makeWASocket, 
    DisconnectReason, 
    Browsers, 
    fetchLatestBaileysVersion 
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const qrcode = require("qrcode-terminal");
const express = require('express');
const mongoose = require('mongoose');
const { useMongoDBAuthState } = require("@distube/baileys-mongodb");

// --- CONFIGURAZIONE SERVER PER RENDER ---
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot Anti-Nuke Online!'));
app.listen(port, () => console.log(`Server attivo sulla porta ${port}`));

// --- CONFIGURAZIONE MONGODB E WHITELIST ---
const mongoURI = process.env.MONGO_URI; 
const ownerNumber = "393331234567@s.whatsapp.net"; // Cambia con il tuo numero se vuoi
const whitelist = [ownerNumber]; 

const msgCounter = {}; 
const nukeTracker = {};

async function startBot() {
    if (!mongoURI) return console.error("❌ ERRORE: Manca la variabile MONGO_URI su Render!");

    await mongoose.connect(mongoURI);
    console.log("✅ Connesso a MongoDB");

    const collection = mongoose.connection.db.collection("auth");
    const { state, saveCreds } = await useMongoDBAuthState(collection);
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
            console.log("✅ BOT ONLINE E PROTETTO SU MONGODB!");
        }
    });

    // --- LOGICA ANTI-NUKE & ANTI-VOIP ---
    sock.ev.on("group-participants.update", async (update) => {
        const { id, participants, action, author } = update;
        
        if (action === "remove" && author && !whitelist.includes(author)) {
            nukeTracker[author] = (nukeTracker[author] || 0) + participants.length;
            if (nukeTracker[author] > 3) {
                await sock.groupParticipantsUpdate(id, [author], "remove");
                await sock.sendMessage(id, { text: `🚨 @${author.split('@')[0]} BANNAVATO PER TENTATO NUKE!`, mentions: [author] });
                delete nukeTracker[author];
            }
            setTimeout(() => { delete nukeTracker[author]; }, 30000);
        }

        if (action === "add") {
            for (let p of participants) {
                if (p.startsWith("1") || p.startsWith("234") || p.startsWith("44")) {
                    await sock.groupParticipantsUpdate(id, [p], "remove");
                    if (author && !whitelist.includes(author)) {
                        await sock.groupParticipantsUpdate(id, [author], "remove");
                    }
                }
            }
        }
    });

    // --- LOGICA ANTI-LINK & ANTI-SPAM ---
    sock.ev.on("messages.upsert", async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const jid = m.key.remoteJid;
        if (!jid.endsWith('@g.us')) return;

        const sender = m.key.participant || m.key.remoteJid;
        const text = m.message.conversation || m.message.extendedTextMessage?.text || "";

        if (whitelist.includes(sender)) return;

        if (/(https?:\/\/[^\s]+)/g.test(text)) {
            await sock.sendMessage(jid, { delete: m.key });
            await sock.groupParticipantsUpdate(jid, [sender], "remove");
            return;
        }

        msgCounter[sender] = (msgCounter[sender] || { text: "", count: 0 });
        if (msgCounter[sender].text === text) {
            msgCounter[sender].count++;
        } else {
            msgCounter[sender].text = text;
            msgCounter[sender].count = 1;
        }

        if (msgCounter[sender].count >= 10) {
            await sock.sendMessage(jid, { delete: m.key });
            await sock.groupParticipantsUpdate(jid, [sender], "remove");
        }
    });
}

startBot().catch(err => console.error("Errore critico:", err));
