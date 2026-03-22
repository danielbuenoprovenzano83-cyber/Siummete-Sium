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
app.get('/', (req, res) => res.send('Bot Anti-Nuke & Anti-Bot Attivo!'));
app.listen(port, () => console.log(`Server attivo sulla porta ${port}`));

const nukeTracker = {};
const spamTracker = {}; 
const whitelist = ["393331234567@s.whatsapp.net"]; // Sostituisci con il tuo numero

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
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
            console.log("✅ BOT ONLINE E PROTEZIONI ATTIVE!");
        }
    });

    // --- PROTEZIONE ANTI-NUKE E ANTI-BOT (INGRESSO) ---
    sock.ev.on("group-participants.update", async (update) => {
        const { id, participants, action, author } = update;
        
        // 1. BLOCCO BOT STRANIERI/SOSPETTI ALL'ENTRATA
        if (action === "add") {
            for (let participant of participants) {
                const prefix = participant.split('')[0] + participant.split('')[1];
                // Esempio: blocca prefissi +212, +92, +234 (comuni nei nuke) se non in whitelist
                const blacklistedPrefixes = ["212", "92", "234", "254"]; 
                const isSuspicious = blacklistedPrefixes.some(p => participant.startsWith(p));

                if (isSuspicious && !whitelist.includes(participant)) {
                    await sock.groupParticipantsUpdate(id, [participant], "remove");
                    await notifyAdmins(id, `🛡️ *SISTEMA SICUREZZA* 🛡️\nRimossa entrata sospetta (Bot/Estero): @${participant.split('@')[0]}`);
                }
            }
        }

        // 2. ANTI-NUKE (RIMOZIONE DI MASSA)
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

    // --- ANTI-LINK, ANTI-SPAM (20) E RILEVAMENTO FIRMA BOT ---
    sock.ev.on("messages.upsert", async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const jid = m.key.remoteJid;
        if (!jid.endsWith('@g.us')) return;

        const sender = m.key.participant || m.key.remoteJid;
        const msgId = m.key.id;
        const text = m.message.conversation || m.message.extendedTextMessage?.text || "";

        if (whitelist.includes(sender)) return;

        // 1. IDENTIFICAZIONE FIRMA BOT (BAILEYS/ALTRI)
        const isBotSignature = msgId.startsWith("BAE5") || msgId.startsWith("3EB0") || msgId.length < 15;
        if (isBotSignature) {
            await sock.sendMessage(jid, { delete: m.key });
            await sock.groupParticipantsUpdate(jid, [sender], "remove");
            await notifyAdmins(jid, `🤖 *BOT ESTERNO RILEVATO* 🤖\n@${sender.split('@')[0]} rimosso automaticamente.`);
            return;
        }

        // 2. ANTI-LINK
        if (/(https?:\/\/[^\s]+)/g.test(text)) {
            await sock.sendMessage(jid, { delete: m.key });
            await sock.groupParticipantsUpdate(jid, [sender], "remove");
            await notifyAdmins(jid, `🔗 *LINK NON AUTORIZZATO* 🔗\nUtente @${sender.split('@')[0]} rimosso.`);
            return;
        }

        // 3. ANTI-SPAM (20 MESSAGGI UGUALI)
        const spamKey = `${sender}_${text.substring(0, 20)}`; // Chiave basata su utente + inizio testo
        spamTracker[spamKey] = (spamTracker[spamKey] || 0) + 1;

        if (spamTracker[spamKey] >= 20) {
            await sock.sendMessage(jid, { delete: m.key });
            await sock.groupParticipantsUpdate(jid, [sender], "remove");
            await notifyAdmins(jid, `🚫 *SPAM DETECTED* 🚫\n@${sender.split('@')[0]} rimosso per spam eccessivo (20+ msg).`);
            delete spamTracker[spamKey];
        }
        setTimeout(() => { if(spamTracker[spamKey]) delete spamTracker[spamKey]; }, 15000);
    });
}

startBot().catch(err => console.error("Errore critico:", err));
