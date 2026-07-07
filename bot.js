const { 
    default: makeWASocket, 
    DisconnectReason, 
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    Browsers // 👈 AGGIUNGI QUESTO IMPORT CRITICO
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const express = require('express');
const pino = require('pino');
const mongoose = require('mongoose');
const fs = require('fs');

// --- CONFIGURAZIONE ---
const MONGO_URL = process.env.MONGO_URL;
const ME_NUMBER = "393899187143"; 
let antiLinkActive = true;
const groupCache = new Map();
let isResetting = false;

const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('🛡️ Security Bot V5.2 Full Control Online');
});

app.listen(port, () => {
    console.log(`✅ Server attivo sulla porta ${port}`);
    
    // 🌟 ANTI-CONGELAMENTO RENDER:
    // Effettua una richiesta HTTP fittizia su se stesso ogni 10 secondi.
    // Questo impedisce a Render di tagliare la connessione internet del server durante il pairing.
    setInterval(() => {
        const http = require('http');
        http.get(`http://localhost:${port}/`, (res) => {
            // Risposta ricevuta con successo, la linea rimane attiva
        }).on('error', (e) => {
            // Ignora eventuali micro-errori di boot
        });
    }, 10000); // 10 secondi
});

// --- SCHEMA MONGODB ---
const UserGroupData = mongoose.model('UserGroupData', new mongoose.Schema({
    jid: String, groupId: String,
    warns: { type: Number, default: 0 }, lastWarn: Date,
    isBlacklisted: { type: Boolean, default: false },
    isWhitelisted: { type: Boolean, default: false }, adminSince: { type: Date, default: null }
}));
const Session = mongoose.model('Session', new mongoose.Schema({ id: String, data: String }));

const nukeTracker = {};
const spamTracker = {};
const clean = (str) => String(str).split('@')[0].replace(/[^0-9]/g, '');

async function syncSession(action) {
    if (action === 'load') {
        const doc = await Session.findOne({ id: 'session' });
        if (doc) {
            if (!fs.existsSync('./auth_info')) fs.mkdirSync('./auth_info');
            const files = JSON.parse(doc.data);
            for (const [file, content] of Object.entries(files)) fs.writeFileSync(`./auth_info/${file}`, content);
        }
    } else {
        if (fs.existsSync('./auth_info')) {
            const files = fs.readdirSync('./auth_info').filter(f => f.endsWith('.json'));
            const sessionData = {};
            files.forEach(file => sessionData[file] = fs.readFileSync(`./auth_info/${file}`, 'utf-8'));
            await Session.findOneAndUpdate({ id: 'session' }, { data: JSON.stringify(sessionData) }, { upsert: true });
        }
    }
}

async function startBot() {
    if (global.isResettingBot) return; 

    try {
        if (!MONGO_URL) {
            console.error("❌ ERRORE: Variabile MONGO_URL mancante!");
            return;
        }

        console.log("🔄 Tentativo di connessione a MongoDB...");
        await mongoose.connect(MONGO_URL, { serverSelectionTimeoutMS: 5000 });
        console.log("💾 Connesso a MongoDB con successo!");
        
    } catch (dbError) {
        console.error("❌ ERRORE DATABASE:", dbError.message);
        setTimeout(() => startBot(), 15000); 
        return;
    }
/*
    // 🌟 ANTI-CONFLITTO RENDER: Evita che due istanze girino insieme durante il deploy
    try {
        const instanceKey = "active_instance_lock";
        // Cerchiamo se esiste già un blocco attivo creato meno di 30 secondi fa
        const existingLock = await Session.findOne({ id: instanceKey });
        if (existingLock && (new Date() - new Date(existingLock.data)) < 30000) {
            console.log("🛑 [SISTEMA] Rilevata istanza duplicata in esecuzione su Render. Arresto questo thread per evitare conflitti.");
            return; // Interrompe l'avvio della seconda istanza parassita
        }
        // Se non esiste o è vecchio, impostiamo il nostro blocco aggiornato in tempo reale
        await Session.findOneAndUpdate({ id: instanceKey }, { data: new Date().toISOString() }, { upsert: true });
        
        // Mantiene in vita il blocco aggiornando il timestamp ogni 15 secondi
        setInterval(async () => {
            await Session.findOneAndUpdate({ id: instanceKey }, { data: new Date().toISOString() }, { upsert: true });
        }, 15000);
    } catch (lockError) {
        console.error("Errore controllo istanza:", lockError.message);
    }
    */

    // ... Continua sotto con la pulizia automatica preventiva e il resto del codice

    // Pulizia automatica della sessione obsoleta su DB PRIMA di avviare Baileys.
    try {
        const checkSession = await Session.findOne({ id: 'session' });
        if (checkSession && (!fs.existsSync('./auth_info') || fs.readdirSync('./auth_info').length === 0)) {
            console.log("🧹 [PULIZIA AUTOMATICA] Rilevata sessione obsoleta su DB. Svuotamento in corso...");
            await Session.deleteOne({ id: 'session' });
            if (fs.existsSync('./auth_info')) {
                fs.rmSync('./auth_info', { recursive: true, force: true });
            }
            console.log("✨ Database e cartella locale resettati con successo!");
        }
    } catch (e) {
        console.error("Errore durante il controllo preventivo del DB:", e.message);
    }
    
    try {
        if (fs.existsSync('./auth_info')) {
            fs.rmSync('./auth_info', { recursive: true, force: true });
            console.log("🧹 Cartella locale auth_info eliminata per rigenerazione chiavi.");
        }
        
    } catch (fsErr) {
        console.error("Errore pulizia fisica:", fsErr.message);
    }
    
    await syncSession('load');

    const authStateData = await useMultiFileAuthState('auth_info');
    const botState = authStateData.state;
    const botSaveCreds = authStateData.saveCreds;

    // 🌟 FIX DEFINITIVO: Usiamo una stringa per evitare i bug di formattazione delle parentesi quadre
    const fallbackString = "2.3000.1017772710";
    let botVersion = fallbackString.split('.').map(Number);
    
    try {
        const versionData = await fetchLatestBaileysVersion();
        botVersion = versionData.version;
        console.log("ℹ️ Versione protocollo WhatsApp agganciata con successo!");
    } catch (vErr) {
        console.log("⚠️ Impossibile recuperare versione aggiornata, uso del fallback stabile.");
    }

    const sock = makeWASocket({
        auth: botState,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: Browsers.macOS("Safari"), // Safari gestisce l'handshake in modo più snello rispetto a Chrome

        // 🛑 BLOCCO COMPLETO DEI FLUSSI DATI (Niente più disconnessioni)
        syncFullHistory: false,
        fireInitQueries: false,
        shouldSyncHistoryMessage: () => false,
        markOnlineOnConnect: false,
        emitOwnEvents: false,

        // ⏳ ESTENSIONE TOTALE DEI TIMER DI RETE
        connectTimeoutMs: 120000,          // 2 minuti di tolleranza all'avvio
        defaultQueryTimeoutMs: 180000,     // 3 minuti di tolleranza per le risposte
        keepAliveIntervalMs: 60000,        // Invia il ping solo ogni 60 secondi (evita il sovraccarico)
        retryRequestDelayMs: 10000,        // Aspetta 10 secondi prima di considerare un pacchetto perso
        maxRetries: 10                     // Tenta fino a 10 volte il recupero prima di arrendersi
    });

    let saveTimeout;
    sock.ev.on('creds.update', async () => { 
        await botSaveCreds(); 
        clearTimeout(saveTimeout);
        saveTimeout = setTimeout(async () => {
            await syncSession('save'); 
        }, 4000);
    });

    let pairingRequested = false;

    // 🌟 DEBOUNCE DI SICUREZZA ANTI-428/401
    // Salva le credenziali su disco istantaneamente, ma attende 10 secondi di totale silenzio
    // prima di caricare i file su MongoDB. Questo evita di inviare dati parziali o corrotti.
    // 💾 SALVATAGGIO CON DEBOUNCE ISOLATO
    // Salva subito i file sul disco locale, ma aspetta 10 secondi prima di inviarli a MongoDB.
    // Questo impedisce al database di bloccarsi o corrompere le chiavi.
    let dbSaveTimeout;
    sock.ev.on('creds.update', async () => { 
        await botSaveCreds(); // Salva subito sul disco locale di Render (mantiene il pairing attivo)
        
        clearTimeout(dbSaveTimeout);
        dbSaveTimeout = setTimeout(async () => {
            console.log("💾 Sincronizzazione sicura delle credenziali su MongoDB...");
            await syncSession('save'); // Invia i file al database solo quando i dati sono stabili
        }, 10000); // Ritardo di 10 secondi
    });


            setTimeout(async () => {
                try {
                    const phoneNumber = ME_NUMBER.replace(/[^0-9]/g, '');
                    let code = await sock.requestPairingCode(phoneNumber);
                    console.log(`\n====================================`);
                    console.log(`🔑 IL TUO CODICE PAIRING: ${code?.match(/.{1,4}/g)?.join("-")}`);
                    console.log(`====================================\n`);
                } catch (e) { 
                    console.error("❌ Errore pairing code:", e.message); 
                    pairingRequested = false; 
                }
            }, 5000);
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error instanceof Boom) 
                ? lastDisconnect.error.output?.statusCode 
                : null;

            console.log(`🔌 Connessione chiusa (Status: ${statusCode})`);

            if (statusCode === 401 || statusCode === DisconnectReason.loggedOut) {
                console.log("⚠️ Sessione rifiutata (401). Svuoto la cache locale...");
                global.isResettingBot = true;
                
                try {
                    if (fs.existsSync('./auth_info')) {
                        fs.rmSync('./auth_info', { recursive: true, force: true });
                    }
                    console.log("🧹 Tabula rasa completata.");
                } catch(err) {
                    console.error("Errore pulizia:", err.message);
                }
                global.isResettingBot = false;
                console.log("⏳ Riavvio pulito tra 5 secondi...");
                setTimeout(() => startBot(), 5000);
                return;

            console.log("⏳ Attesa di 10 secondi prima di riconnettere...");
            setTimeout(() => startBot(), 10000);

        } else if (connection === 'open') {
            console.log('🚀 [LIVE] Security Bot V5.2 Connesso con Successo!');
            pairingRequested = false;
        }
    });
} catch (error) {
    console.error("Errore critico nel ciclo principale del bot:", error);
}

    // Rimuoviamo la vecchia funzione statica setTimeout esterna che generava conflitti

    const getMetadata = async (jid) => {
        if (groupCache.has(jid)) return groupCache.get(jid);
        try {
            const metadata = await sock.groupMetadata(jid);
            groupCache.set(jid, metadata);
            setTimeout(() => groupCache.delete(jid), 15000);
            return metadata;
        } catch (e) {
            return null;
        }
    };

    const handleViolation = async (jid, participant, reason) => {
        const pNum = clean(participant);
        let user = await UserGroupData.findOne({ jid: pNum, groupId: jid }) || new UserGroupData({ jid: pNum, groupId: jid });
        if (user.lastWarn && (new Date() - user.lastWarn > 30 * 24 * 60 * 60 * 1000)) user.warns = 0;
        user.warns += 1; user.lastWarn = new Date();
        if (user.warns >= 3) {
            user.isBlacklisted = true;
            try { await sock.groupParticipantsUpdate(jid, [participant], "remove"); } catch(e) {}
            await sock.sendMessage(jid, { text: `🚫 @${pNum} BANNATO (3/3 Warn). Motivo: ${reason}`, mentions: [participant] });
        } else {
            await sock.sendMessage(jid, { text: `⚠️ @${pNum} WARNATO (${user.warns}/3). Motivo: ${reason}`, mentions: [participant] });
        }
        await user.save();
    };

    sock.ev.on("group-participants.update", async (update) => {
        const { id, participants, action, author } = update;
        const metadata = await getMetadata(id);
        const admins = metadata.participants.filter(p => p.admin).map(p => p.id);

            // --- AGGIUNGI DA QUI ---
    // 🛡️ AUTO-DEMOTE & ANTI-BOT-ADMIN
    if (action === "add" || action === "promote") {
        for (let p of participants) {
            // Se l'utente NON sei tu (proprietario) e NON è il bot stesso
            if (p !== ME_NUMBER + "@s.whatsapp.net" && p !== botJid) {
                const user = await UserGroupData.findOne({ jid: p, groupId: id });
                
                // Se non è in whitelist, declassalo e rimuovilo istantaneamente
                if (!user?.isWhitelisted) {
                    try {
                        await sock.groupParticipantsUpdate(id, [p], "demote"); // Toglie admin
                        await sock.groupParticipantsUpdate(id, [p], "remove"); // Lo espelle
                        await sock.sendMessage(id, { 
                            text: `🛡️ *SISTEMA ANTI-NUKE:* Rilevato tentativo di ingresso/promozione admin non autorizzato (@${p.split('@')[0]}). Utente rimosso.`,
                            mentions: [p] 
                        });
                    } catch (e) {
                        console.error("Errore nel declassare il bot nemico:", e);
                    }
                }
            }
        }
    }

        if (action === "promote") {
            for (let p of participants) {
                await UserGroupData.findOneAndUpdate({ jid: clean(p), groupId: id }, { adminSince: new Date() }, { upsert: true });
                await sock.sendMessage(id, { text: `🔔 *ATTENZIONE! NUOVO ADMIN!*: @${clean(p)} non potrai usare i comandi prima di 24H.`, mentions: [p, ...admins] });
            }
        }
        if (action === "add") {
            for (let p of participants) {
                const user = await UserGroupData.findOne({ jid: clean(p), groupId: id });
                if (user?.isBlacklisted) try { await sock.groupParticipantsUpdate(id, [p], "remove"); } catch(e) {}
            }
        }
        if (action === "remove" && author) {
            const userAuthor = await UserGroupData.findOne({ jid: clean(author), groupId: id });
            if (userAuthor?.isWhitelisted) return;
            nukeTracker[author] = (nukeTracker[author] || 0) + participants.length;
            if (nukeTracker[author] > 3) {
                try { await sock.groupParticipantsUpdate(id, [author], "remove"); } catch(e) {}
                await UserGroupData.findOneAndUpdate({ jid: clean(author), groupId: id }, { isBlacklisted: true }, { upsert: true });
                await sock.sendMessage(id, { text: `🚨 *ALLERTA NUKE!!!*: @${clean(author)} blacklistato.`, mentions: [author, ...admins] });
            }
            setTimeout(() => delete nukeTracker[author], 30000);
        }
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
        const m = messages[0];
        if (!m || !m.message || m.key.fromMe) return;
        const jid = m.key.remoteJid;
        if (!jid.endsWith('@g.us')) return;
        const sender = m.key.participant || jid;
        const text = (m.message.conversation || m.message.extendedTextMessage?.text || "").trim();
        
        const userGroup = await UserGroupData.findOne({ jid: clean(sender), groupId: jid });

        // CONTROLLI ATTIVI PER TUTTI (Admin inclusi), tranne chi è in Whitelist
        if (!userGroup?.isWhitelisted) {
            // Anti-Text-Flood (2000+ caratteri)
            if (text.length > 1999) {
                await sock.sendMessage(jid, { delete: m.key });
                try { await sock.groupParticipantsUpdate(jid, [sender], "remove"); } catch(e) {}
                await UserGroupData.findOneAndUpdate({ jid: clean(sender), groupId: jid }, { isBlacklisted: true }, { upsert: true });
                return await sock.sendMessage(jid, { text: `🚫 @${clean(sender)} BANNATO per messaggio troppo lungo (+2000 caratteri).`, mentions: [sender] });
            }
            
            // Anti-Link
            if (antiLinkActive && /(https?:\/\/[^\s]+)/g.test(text)) {
                await sock.sendMessage(jid, { delete: m.key });
                return await handleViolation(jid, sender, "Link non autorizzato");
            }
            // Anti-Spam
            spamTracker[sender] = (spamTracker[sender] || 0) + 1;
            if (spamTracker[sender] === 5) await handleViolation(jid, sender, "Spam (5 msg)");
            if (spamTracker[sender] >= 10) {
                try { await sock.groupParticipantsUpdate(jid, [sender], "remove"); } catch(e) {}
                await UserGroupData.findOneAndUpdate({ jid: clean(sender), groupId: jid }, { isBlacklisted: true }, { upsert: true });
            }
            setTimeout(() => { if(spamTracker[sender]>0) spamTracker[sender]--; }, 10000);
        }

        // COMANDI (Solo per Admin da più di 24 ore)
        const metadata = await getMetadata(jid);
        const isAdmin = !!metadata.participants.find(p => p.id === sender && p.admin);

        if (text.startsWith("!") && isAdmin) {
            let adminData = await UserGroupData.findOne({ jid: clean(sender), groupId: jid });
            const hActive = adminData?.adminSince ? (new Date() - adminData.adminSince) / 3600000 : 25;
            if (hActive < 24) return await sock.sendMessage(jid, { text: "⏳ Sei admin da meno di 24h. Comandi disabilitati." });

            const args = text.slice(1).split(/ +/);
            const command = args.shift().toLowerCase();
            let target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || (args[0] ? clean(args[0]) + "@s.whatsapp.net" : null);

            switch(command) {
                case 'help':
                    await sock.sendMessage(jid, { text: `🛡️ *COMANDI ADMIN*\n!warn @tag\n!resetwarn @tag\n!ban @tag\n!unban numero\n!list\n!whitelist add @tag\n!whitelist remove @tag\n!antilink on/off\n!clearblacklist` });
                    break;
                case 'unban':
                    if (target) {
                        await UserGroupData.deleteMany({ jid: clean(target), groupId: jid });
                        await sock.sendMessage(jid, { text: `✅ ${clean(target)} è stato sbannato` });
                    }
                    break;
                case 'clearblacklist':
                    await UserGroupData.deleteMany({ groupId: jid, isBlacklisted: true });
                    await sock.sendMessage(jid, { text: "🧹 Blacklist svuotata." });
                    break;
                case 'resetwarn':
                    if (target) {
                        await UserGroupData.updateMany({ jid: clean(target), groupId: jid }, { $set: { warns: 0 } });
                        await sock.sendMessage(jid, { text: `✅ Warn resettati per ${clean(target)}` });
                    }
                    break;
                case 'whitelist':
                    if (target && args[0]) {
                        const isAdd = args[0].toLowerCase() === 'add';
                        await UserGroupData.findOneAndUpdate({ jid: clean(target), groupId: jid }, { isWhitelisted: isAdd }, { upsert: true });
                        await sock.sendMessage(jid, { text: `⚪ Whitelist ${isAdd ? 'ATTIVA' : 'DISATTIVATA'} per ${clean(target)}` });
                    }
                    break;
                case 'list':
                    const banned = await UserGroupData.find({ groupId: jid, isBlacklisted: true });
                    const whited = await UserGroupData.find({ groupId: jid, isWhitelisted: true });
                    let l = `🚫 *BANLIST*:\n${banned.map(u => "- " + u.jid).join('\n') || 'Vuota'}\n\n⚪ *Whitelist*:\n${whited.map(u => "- " + u.jid).join('\n') || 'Vuota'}`;
                    await sock.sendMessage(jid, { text: l });
                    break;
                case 'warn': if(target) await handleViolation(jid, target, "Manuale"); break;
                case 'ban': if(target) {
                    try { await sock.groupParticipantsUpdate(jid, [target], "remove"); } catch(e) {}
                    await UserGroupData.findOneAndUpdate({ jid: clean(target), groupId: jid }, { isBlacklisted: true, warns: 3 }, { upsert: true });
                    await sock.sendMessage(jid, { text: `🚫 Blacklistato @${clean(target)}`, mentions: [target] });
                } break;
                case 'antilink': 
                    antiLinkActive = args[0]?.toLowerCase() === 'on'; 
                    await sock.sendMessage(jid, { text: `🔗 Anti-Link: ${antiLinkActive ? 'ON' : 'OFF'}` }); 
                    break;
            }
        }
    });

    sock.ev.on('connection.update', (u) => { if (u.connection === 'close') startBot(); });
}

startBot().catch(console.error);
