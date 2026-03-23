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
const { useMongoDBAuthState } = require("baileys-mongodb-storage");

// --- SERVER PER RENDER ---
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot Anti-Nuke & Anti-Bot Online con MongoDB!'));
app.listen(port, () => console.log(`Server attivo sulla porta ${port}`));

const nukeTracker = {};
const spamTracker = {}; 
const whitelist = ["393331234567@s.whatsapp.net"]; // Sostituisci con il tuo numero
const mongoURL = process.env.MONGODB_URL; // Carica la URL dalle variabili d'ambiente

async function startBot() {
    // --- CONNESSIONE MONGODB PER SESSIONE PERSISTENTE ---
    if (!mongoURL) throw new Error("ERRORE: MONGODB_URL non configurata su Render!");
    await mongoose.connect(mongoURL);
    const collection = mongoose.connection.db.collection("auth_info_baileys");
    const { state, saveCreds } = await useMongoDBAuthState(collection);
    
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        browser: Browsers.ubuntu('Chrome'),
        printQRInTerminal: true
    });

    sock.ev.on("creds.update", saveCreds);

    // Funzione per notificare gli admin
    const notifyAdmins = async (jid, text) => {
        try {
            const metadata = await sock.groupMetadata(jid);
            const admins = metadata.participants.filter(p => p.admin).map(p => p.id);
            await sock.sendMessage(jid, { text: text, mentions: admins });
        } catch (e) { console.error("Errore notifica admin:", e); }
    };

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) qrcode.generate(qr, { small: true });
        if (connection === "close") {
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            if (reason !== DisconnectReason.loggedOut) startBot();
        } else if (connection === "open") {
            console.log("✅ BOT ONLINE E SESSIONE SALVATA SU CLOUD!");
        }
    });

    // --- PROTEZIONE ANTI-NUKE E ANTI-BOT (INGRESSO) ---
    sock.ev.on("group-participants.update", async (update) => {
        const { id, participants, action, author } = update;
        
        if (action === "add") {
            for (let participant of participants) {
                const prefix = participant.split('')[0] + participant.split('')[1];
                const blacklistedPrefixes = ["212", "92", "234", "254"]; 
                const isSuspicious = blacklistedPrefixes.some(p => participant.startsWith(p));

                if (isSuspicious && !whitelist.includes(participant)) {
                    await sock.groupParticipantsUpdate(id, [participant], "remove");
                    await notifyAdmins(id, `🛡️ *SISTEMA SICUREZZA* 🛡️\nRimossa entrata sospetta (Bot/Estero): @${participant.split('@')[0]}`);
                }
            }
        }

        if (action === "remove" && author && !whitelist.includes(author)) {
            nukeTracker[author] = (nukeTracker[author] || 0) + participants.length;
            if (nukeTracker[author] > 3) {
                await sock.groupParticipantsUpdate(id, [author], "remove");
                await notifyAdmins(id, `🚨 *ALLERTA NUKE* 🚨\nL'utente @${author.split('@')[0]} è stato rimosso per tentato nuke.`);
                delete nukeTracker[author];
            }
            setTimeout(() => { delete nukeTracker[author]; }, 30000);
        }
    });

    // --- ANTI-LINK, ANTI-SPAM E RILEVAMENTO FIRMA BOT ---
    sock.ev.on("messages.upsert", async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const jid = m.key.remoteJid;
        if (!jid.endsWith('@g.us')) return;

        const sender = m.key.participant || m.key.remoteJid;
        const msgId = m.key.id;
        const text = m.message.conversation || m.message.extendedTextMessage?.text || "";

        if (whitelist.includes(sender)) return;

        const isBotSignature = msgId.startsWith("BAE5") || msgId.startsWith("3EB0") || msgId.length < 15;
        if (isBotSignature) {
            await sock.sendMessage(jid, { delete: m.key });
            await sock.groupParticipantsUpdate(jid, [sender], "remove");
            await notifyAdmins(jid, `🤖 *BOT ESTERNO RILEVATO* 🤖\n@${sender.split('@')[0]} rimosso automaticamente.`);
            return;
        }

        if (/(https?:\/\/[^\s]+)/g.test(text)) {
            await sock.sendMessage(jid, { delete: m.key });
            await sock.groupParticipantsUpdate(jid, [sender], "remove");
            await notifyAdmins(jid, `🔗 *LINK NON AUTORIZZATO* 🔗\nUtente @${sender.split('@')[0]} rimosso.`);
            return;
        }

        const spamKey = `${sender}_${text.substring(0, 10)}`; 
        spamTracker[spamKey] = (spamTracker[spamKey] || 0) + 1;

        if (spamTracker[spamKey] >= 10) {
            await sock.sendMessage(jid, { delete: m.key });
            await sock.groupParticipantsUpdate(jid, [sender], "remove");
            await notifyAdmins(jid, `🚫 *SPAM DETECTED* 🚫\n@${sender.split('@')[0]} rimosso per spam eccessivo (10+ msg).`);
            delete spamTracker[spamKey];
        }
        setTimeout(() => { if(spamTracker[spamKey]) delete spamTracker[spamKey]; }, 15000);
    });
}

startBot().catch(err => console.error("Errore critico:", err));
