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
let antiLinkActive = true;

const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('🛡️ Security Bot Multi-Group V4.0 Online'));
app.listen(port, () => console.log(`✅ Server attivo sulla porta ${port}`));

// --- SCHEMA MONGODB ---
const Session = mongoose.model('Session', new mongoose.Schema({ id: String, data: String }));
const UserGroupData = mongoose.model('UserGroupData', new mongoose.Schema({
    jid: String, // Solo numeri puliti
    groupId: String,
    name: { type: String, default: "Sconosciuto" }, // Nome salvato
    warns: { type: Number, default: 0 },
    lastWarn: Date,
    isBlacklisted: { type: Boolean, default: false },
    isWhitelisted: { type: Boolean, default: false },
    adminSince: { type: Date, default: null }
}));

const nukeTracker = {};
const spamTracker = {};

// Funzione di pulizia totale (Solo cifre)
const clean = (str) => {
    if (!str) return "";
    let s = String(str).split('@')[0];
    return s.replace(/[^0-9]/g, '');
};

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
    await mongoose.connect(MONGO_URL);
    await syncSession('load');
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ["Mac OS", "Chrome", "122.0.6261.112"],
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', async () => { await saveCreds(); await syncSession('save'); });

    // --- PAIRING CODE ---
    if (!sock.authState.creds.registered) {
        console.log(`⚠️ RICHIESTA CODICE PER: ${ME_NUMBER}`);
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(ME_NUMBER);
                console.log(`\n********************************************`);
                console.log(`* 🔑 CODICE PAIRING: ${code?.match(/.{1,4}/g)?.join("-")} *`);
                console.log(`********************************************\n`);
            } catch (e) { console.error("❌ Errore Pairing"); }
        }, 10000); // 10 secondi per sicurezza
    }

    const handleViolation = async (jid, participant, reason) => {
        const pNum = clean(participant);
        let user = await UserGroupData.findOne({ jid: pNum, groupId: jid }) || new UserGroupData({ jid: pNum, groupId: jid });
        if (user.lastWarn && (new Date() - user.lastWarn > 30 * 24 * 60 * 60 * 1000)) user.warns = 0;
        user.warns += 1;
        user.lastWarn = new Date();
        if (user.warns >= 3) {
            user.isBlacklisted = true;
            await sock.groupParticipantsUpdate(jid, [participant], "remove");
            await sock.sendMessage(jid, { text: `🚫 @${pNum} BANNATO (3/3 Warn).\nMotivo: ${reason}`, mentions: [participant] });
        } else {
            await sock.sendMessage(jid, { text: `⚠️ @${pNum} WARNATO (${user.warns}/3).\nMotivo: ${reason}`, mentions: [participant] });
        }
        await user.save();
    };

    sock.ev.on("group-participants.update", async (update) => {
        const { id, participants, action, author } = update;
        const metadata = await sock.groupMetadata(id);
        const admins = metadata.participants.filter(p => p.admin).map(p => p.id);

        if (action === "promote") {
            for (let p of participants) {
                const name = metadata.participants.find(u => u.id === p)?.notify || "Sconosciuto";
                await UserGroupData.findOneAndUpdate({ jid: clean(p), groupId: id }, { adminSince: new Date(), name: name }, { upsert: true });
                await sock.sendMessage(id, { text: `🔔 *PROMOZIONE*: @${clean(p)} potrà usare i comandi tra 24h.`, mentions: [p, ...admins] });
            }
        }

        if (action === "add") {
            for (let p of participants) {
                const user = await UserGroupData.findOne({ jid: clean(p), groupId: id });
                if (user?.isBlacklisted || ["212", "92", "234", "254"].some(pre => p.startsWith(pre))) {
                    await sock.groupParticipantsUpdate(id, [p], "remove");
                }
            }
        }

        if (action === "remove" && author) {
            const userAuthor = await UserGroupData.findOne({ jid: clean(author), groupId: id });
            if (userAuthor?.isWhitelisted) return;
            nukeTracker[author] = (nukeTracker[author] || 0) + participants.length;
            if (nukeTracker[author] > 3) {
                await sock.groupParticipantsUpdate(id, [author], "remove");
                await UserGroupData.findOneAndUpdate({ jid: clean(author), groupId: id }, { isBlacklisted: true }, { upsert: true });
                await sock.sendMessage(id, { text: `🚨 *NUKE RILEVATO*: @${clean(author)} blacklistato.`, mentions: [author, ...admins] });
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
        
        const metadata = await sock.groupMetadata(jid);
        const isAdmin = !!metadata.participants.find(p => p.id === sender && p.admin);
        const userGroup = await UserGroupData.findOne({ jid: clean(sender), groupId: jid });

        // PROTEZIONE SPAM E LINK
        if (!isAdmin && !userGroup?.isWhitelisted) {
            if (antiLinkActive && /(https?:\/\/[^\s]+)/g.test(text)) {
                await sock.sendMessage(jid, { delete: m.key });
                return await handleViolation(jid, sender, "Link");
            }
            spamTracker[sender] = (spamTracker[sender] || 0) + 1;
            if (spamTracker[sender] === 5) await handleViolation(jid, sender, "Spam (5 msg)");
            if (spamTracker[sender] >= 10) {
                await sock.groupParticipantsUpdate(jid, [sender], "remove");
                await UserGroupData.findOneAndUpdate({ jid: clean(sender), groupId: jid }, { isBlacklisted: true }, { upsert: true });
            }
            setTimeout(() => { if(spamTracker[sender]>0) spamTracker[sender]--; }, 10000);
        }

        // COMANDI
        if (text.startsWith("!") && isAdmin) {
            let adminData = await UserGroupData.findOne({ jid: clean(sender), groupId: jid });
            const hoursActive = adminData?.adminSince ? (new Date() - adminData.adminSince) / (1000 * 60 * 60) : 25;
            if (hoursActive < 24) return await sock.sendMessage(jid, { text: "⏳ Attesa 24h per i comandi." });

            const args = text.slice(1).split(/ +/);
            const command = args.shift().toLowerCase();
            const fullArg = args.join("");

            let tJid = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
            let tNum = tJid ? clean(tJid) : clean(fullArg);

            switch(command) {
                case 'help':
                    await sock.sendMessage(jid, { text: `🛡️ *HELP ADMIN*\n!warn @tag\n!resetwarn @tag\n!ban @tag\n!unban numero\n!list\n!whitelist add @tag\n!antilink on/off` });
                    break;
                case 'unban':
                    if (tNum) {
                        await UserGroupData.deleteMany({ jid: tNum, groupId: jid });
                        await sock.sendMessage(jid, { text: `✅ Numero ${tNum} eliminato DEFINITIVAMENTE dalla blacklist.` });
                    }
                    break;
                case 'list':
                    const banned = await UserGroupData.find({ groupId: jid, isBlacklisted: true });
                    const whited = await UserGroupData.find({ groupId: jid, isWhitelisted: true });
                    let msg = `🚫 *BANLIST*:\n${banned.map(u => "- " + u.jid + " [" + (u.name || "N/A") + "]").join('\n') || 'Vuota'}\n\n⚪ *WHITELIST*:\n${whited.map(u => "- " + u.jid).join('\n') || 'Vuota'}`;
                    await sock.sendMessage(jid, { text: msg });
                    break;
                case 'warn': if(tNum) await handleViolation(jid, tNum + "@s.whatsapp.net", "Manuale"); break;
                case 'resetwarn': if(tNum) { await UserGroupData.updateMany({ jid: tNum, groupId: jid }, { $set: { warns: 0 } }); await sock.sendMessage(jid, { text: "✅ Warn resettati." }); } break;
                case 'ban': if(tNum) { 
                    try { await sock.groupParticipantsUpdate(jid, [tNum + "@s.whatsapp.net"], "remove"); } catch(e) {}
                    await UserGroupData.findOneAndUpdate({ jid: tNum, groupId: jid }, { isBlacklisted: true, warns: 3 }, { upsert: true }); 
                    await sock.sendMessage(jid, { text: "🚫 Bannato e blacklistato." });
                } break;
                case 'whitelist':
                    if (tNum && fullArg) {
                        const isA = fullArg.toLowerCase().includes('add');
                        await UserGroupData.findOneAndUpdate({ jid: tNum, groupId: jid }, { isWhitelisted: isA }, { upsert: true });
                        await sock.sendMessage(jid, { text: `⚪ Whitelist ${isA ? 'OK' : 'OFF'} per ${tNum}` });
                    }
                    break;
                case 'antilink': antiLinkActive = fullArg.toLowerCase() === 'on'; await sock.sendMessage(jid, { text: `🔗 Anti-Link: ${fullArg}` }); break;
            }
        }
    });

    sock.ev.on('connection.update', (u) => { 
        if (u.connection === 'close') {
            const reconnect = (u.lastDisconnect.error instanceof Boom) ? u.lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true;
            if (reconnect) startBot();
        } else if (u.connection === 'open') console.log('✅ BOT ONLINE E SINCRONIZZATO!');
    });
}

startBot().catch(console.error);
