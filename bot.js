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
const groupCache = new Map();

const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('🛡️ Security Bot V5.2 Full Control Online'));
app.listen(port, () => console.log(`✅ Server attivo`));

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
    await mongoose.connect(MONGO_URL);
    await syncSession('load');
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version, auth: state, logger: pino({ level: 'silent' }),
        browser: ["Mac OS", "Chrome", "122.0.6261.112"]
    });

    sock.ev.on('creds.update', async () => { await saveCreds(); await syncSession('save'); });

    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(ME_NUMBER);
                console.log(`\n🔑 CODICE PAIRING: ${code?.match(/.{1,4}/g)?.join("-")}\n`);
            } catch (e) { console.error("Errore pairing"); }
        }, 8000);
    }

    const getMetadata = async (jid) => {
        if (groupCache.has(jid)) return groupCache.get(jid);
        const metadata = await sock.groupMetadata(jid);
        groupCache.set(jid, metadata);
        setTimeout(() => groupCache.delete(jid), 15000);
        return metadata;
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

        if (action === "promote") {
            for (let p of participants) {
                await UserGroupData.findOneAndUpdate({ jid: clean(p), groupId: id }, { adminSince: new Date() }, { upsert: true });
                await sock.sendMessage(id, { text: `🔔 *PROMO*: @${clean(p)} attesa 24h per i comandi.`, mentions: [p, ...admins] });
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
                await sock.sendMessage(id, { text: `🚨 *NUKE*: @${clean(author)} blacklistato.`, mentions: [author, ...admins] });
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
                    await sock.sendMessage(jid, { text: `🛡️ *HELP*\n!warn @tag\n!resetwarn @tag\n!ban @tag\n!unban numero\n!list\n!whitelist add @tag\n!whitelist remove @tag\n!antilink on/off\n!clearblacklist` });
                    break;
                case 'unban':
                    if (target) {
                        await UserGroupData.deleteMany({ jid: clean(target), groupId: jid });
                        await sock.sendMessage(jid, { text: `✅ Sbloccato ${clean(target)}` });
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
                        await sock.sendMessage(jid, { text: `⚪ Whitelist ${isAdd ? 'ATTIVA' : 'REMOVATA'} per ${clean(target)}` });
                    }
                    break;
                case 'list':
                    const banned = await UserGroupData.find({ groupId: jid, isBlacklisted: true });
                    const whited = await UserGroupData.find({ groupId: jid, isWhitelisted: true });
                    let l = `🚫 *BANLIST*:\n${banned.map(u => "- " + u.jid).join('\n') || 'Vuota'}\n\n⚪ *WL*:\n${whited.map(u => "- " + u.jid).join('\n') || 'Vuota'}`;
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
