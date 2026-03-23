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
app.get('/', (req, res) => res.send('🛡️ Bot Anti-Nuke Online con Pairing Code!'));
app.listen(port, () => console.log(`✅ Server attivo sulla porta ${port}`));

const nukeTracker = {};
const spamTracker = {}; 
const whitelist = ["393331234567@s.whatsapp.net"]; // CAMBIA COL TUO NUMERO
const ME_NUMBER = "6285137595799"; // 👈 INSERISCI QUI IL TUO NUMERO (es: 393471234567)

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'), // NON CAMBIARE QUESTO
        syncFullHistory: false
    });

    // --- LOGICA CODICE A 8 CIFRE ---
    if (!sock.authState.creds.registered) {
        console.log(`\n\n🔄 Generazione Pairing Code per il numero: ${ME_NUMBER}...`);
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(ME_NUMBER);
                code = code?.match(/.{1,4}/g)?.join("-") || code;
                console.log(`\n\n🔑 IL TUO CODICE DI COLLEGAMENTO È: ${code}\n\n`);
            } catch (error) {
                console.error("❌ Errore nella generazione del codice:", error);
            }
        }, 5000); // Aspetta 5 secondi per stabilizzare la connessione
    }

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === "close") {
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            if (reason !== DisconnectReason.loggedOut) startBot();
        } else if (connection === "open") {
            console.log("🚀 BOT ONLINE! Collegamento riuscito.");
        }
    });

    // --- PROTEZIONE ANTI-NUKE/BOT/ESTERO ---
    sock.ev.on("group-participants.update", async (update) => {
        const { id, participants, action, author } = update;
        if (action === "add") {
            for (let p of participants) {
                if (["212", "92", "234", "254"].some(pre => p.startsWith(pre)) && !whitelist.includes(p)) {
                    await sock.groupParticipantsUpdate(id, [p], "remove");
                }
            }
        }
        if (action === "remove" && author && !whitelist.includes(author)) {
            nukeTracker[author] = (nukeTracker[author] || 0) + participants.length;
            if (nukeTracker[author] > 3) {
                await sock.groupParticipantsUpdate(id, [author], "remove");
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
