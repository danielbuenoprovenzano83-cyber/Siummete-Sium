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

// --- SERVER PER RENDER ---
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('🛡️ Bot Anti-Nuke & Anti-Spam Online!'));
app.listen(port, () => console.log(`✅ [1/4] Server attivo sulla porta ${port}`));

const nukeTracker = {};
const spamTracker = {}; 
const whitelist = ["393331234567@s.whatsapp.net"]; // CAMBIA COL TUO NUMERO
const ME_NUMBER = "6285137595799"; 

// --- RATE LIMITING (60 msg/sec) ---
let messagesProcessedThisSecond = 0;
setInterval(() => { messagesProcessedThisSecond = 0; }, 1000);

async function startBot() {
    console.log("🚀 [2/4] Avvio procedura Baileys...");
    
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    console.log("📂 [3/4] Sessione caricata.");

    const { version } = await fetchLatestBaileysVersion();
    console.log(`🌐 [4/4] Connessione a WhatsApp v${version}...`);

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ["Mac OS", "Chrome", "122.0.6261.112"], 
        syncFullHistory: false,
        markOnlineOnConnect: true
    });

    sock.ev.on('creds.update', saveCreds);

    // --- LOGICA PAIRING CODE OTTIMIZZATA ---
    if (!sock.authState.creds.registered) {
        console.log(`\n⚠️ DISPOSITIVO NON COLLEGATO! Richiesta codice per: ${ME_NUMBER}`);
        
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(ME_NUMBER);
                code = code?.match(/.{1,4}/g)?.join("-") || code;
                console.log("\n********************************************");
                console.log(`* 🔑 IL TUO CODICE: ${code} *`);
                console.log("********************************************\n");
            } catch (error) {
                console.error("❌ Errore Pairing: WhatsApp ha rifiutato la richiesta (Rate Limit o IP).");
            }
        }, 5000); // 5 secondi di attesa per stabilizzare il socket
    }

    // --- 1. ANTI-NUKE & ANTI-BOT ---
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
                text: `🚫 *ANTI-SPAM* 🚫\nUtente rimosso per spam eccessivo.`, 
                mentions: admins 
            });
            delete spamTracker[sender];
            return;
        }

        setTimeout(() => {
            if (spamTracker[sender] > 0) spamTracker[sender]--;
        }, 10000);
    });

    // --- GESTIONE CONNESSIONE ---
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom) ? 
                lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true;
            console.log("🔄 Connessione chiusa. Riconnessione...");
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('✅ BOT COLLEGATO E ONLINE!');
        }
    });
}

startBot().catch(err => console.error("Errore critico:", err));
