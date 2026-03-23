const { 
    default: makeWASocket, 
    DisconnectReason, 
    Browsers, 
    useMultiFileAuthState,
    fetchLatestBaileysVersion 
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const express = require('express');
const pino = require('pino');

// --- SERVER PER RENDER (Per UptimeRobot) ---
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('🛡️ Bot Anti-Nuke & Anti-Spam Online!'));
app.listen(port, () => console.log(`✅ Server attivo sulla porta ${port}`));

const nukeTracker = {};
const spamTracker = {}; 
const whitelist = ["393331234567@s.whatsapp.net"]; // CAMBIA COL TUO NUMERO
const ME_NUMBER = "6285137595799"; // 👈 METTI IL TUO NUMERO PER IL PAIRING CODE

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false
    });

    // --- LOGICA PAIRING CODE ---
    if (!sock.authState.creds.registered) {
        console.log(`\n\n🔄 Richiesta Pairing Code per: ${ME_NUMBER}...`);
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(ME_NUMBER);
                code = code?.match(/.{1,4}/g)?.join("-") || code;
                console.log(`\n\n🔑 CODICE DA INSERIRE SU WHATSAPP: ${code}\n\n`);
            } catch (error) { console.error("Errore pairing:", error); }
        }, 8000);
    }

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === "close") {
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            if (reason !== DisconnectReason.loggedOut) startBot();
        } else if (connection === "open") {
            console.log("🚀 BOT ONLINE E PROTETTO!");
        }
    });

    // --- 1. ANTI-NUKE & ANTI-BOT (INGRESSI) ---
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

    // --- 2. ANTI-SPAM (AGRESSIVO), ANTI-LINK & BOT FIRMA ---
    sock.ev.on("messages.upsert", async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const jid = m.key.remoteJid;
        if (!jid.endsWith('@g.us')) return;

        const sender = m.key.participant || m.key.remoteJid;
        const msgId = m.key.id;
        const text = m.message.conversation || m.message.extendedTextMessage?.text || "";

        if (whitelist.includes(sender)) return;

        // --- RILEVAMENTO BOT ESTERNI & LINK ---
        const isBot = msgId.startsWith("BAE5") || msgId.startsWith("3EB0") || msgId.length < 15;
        const hasLink = /(https?:\/\/[^\s]+)/g.test(text);

        if (isBot || hasLink) {
            await sock.sendMessage(jid, { delete: m.key });
            await sock.groupParticipantsUpdate(jid, [sender], "remove");
            return;
        }

        // --- ANTI-SPAM AGGRESSIVO (Qualsiasi messaggio corto o lungo) ---
        if (!spamTracker[sender]) spamTracker[sender] = 0;
        spamTracker[sender]++;

        // Se l'utente invia 7 messaggi in meno di 10 secondi, viene rimosso
        if (spamTracker[sender] >= 10) { 
            console.log(`🚫 Spam rilevato da ${sender}`);
            await sock.sendMessage(jid, { delete: m.key });
            await sock.groupParticipantsUpdate(jid, [sender], "remove");
            
            // Notifica Admin
            const metadata = await sock.groupMetadata(jid);
            const admins = metadata.participants.filter(p => p.admin).map(p => p.id);
            await sock.sendMessage(jid, { 
                text: `🚫 *ANTI-SPAM* 🚫\nL'utente @${sender.split('@')[0]} è stato rimosso per spam eccessivo.`, 
                mentions: admins 
            });

            delete spamTracker[sender];
            return;
        }

        // Reset del contatore ogni 10 secondi
        setTimeout(() => {
            if (spamTracker[sender] > 0) spamTracker[sender]--;
        }, 10000);
    });
}

startBot().catch(err => console.error(err));
