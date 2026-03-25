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

const MONGO_URL = process.env.MONGO_URL;
const ME_NUMBER = "6285137595799"; 
let antiLinkActive = true;

const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('🛡️ Anti-Nuke Security V3 Online'));
app.listen(port, () => console.log(`✅ Server attivo`));

// --- SCHEMA DB AGGIORNATO ---
const Session = mongoose.model('Session', new mongoose.Schema({ id: String, data: String }));
const UserGroupData = mongoose.model('UserGroupData', new mongoose.Schema({
    jid: String,
    groupId: String,
    warns: { type: Number, default: 0 },
    lastWarn: Date,
    isBlacklisted: { type: Boolean, default: false },
    isWhitelisted: { type: Boolean, default: false },
    adminSince: { type: Date, default: null } // Data di promozione
}));

const nukeTracker = {};
const spamTracker = {};

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
            let code = await sock.requestPairingCode(ME_NUMBER);
            console.log(`🔑 CODICE: ${code?.match(/.{1,4}/g)?.join("-")}`);
        }, 6000);
    }

    const handleViolation = async (jid, participant, reason) => {
        let user = await UserGroupData.findOne({ jid: participant, groupId: jid }) || new UserGroupData({ jid: participant, groupId: jid });
        if (user.lastWarn && (new Date() - user.lastWarn > 30 * 24 * 60 * 60 * 1000)) user.warns = 0;
        user.warns += 1;
        user.lastWarn = new Date();
        if (user.warns >= 3) {
            user.isBlacklisted = true;
            await sock.groupParticipantsUpdate(jid, [participant], "remove");
            await sock.sendMessage(jid, { text: `🚫 @${participant.split('@')} bannato (3/3 Warn). Motivo: ${reason}`, mentions: [participant] });
        } else {
            await sock.sendMessage(jid, { text: `⚠️ @${participant.split('@')} warnato (${user.warns}/3). Motivo: ${reason}`, mentions: [participant] });
        }
        await user.save();
    };

    // --- MONITORAGGIO PARTECIPANTI E ADMIN ---
    sock.ev.on("group-participants.update", async (update) => {
        const { id, participants, action, author } = update;
        const metadata = await sock.groupMetadata(id);
        const admins = metadata.participants.filter(p => p.admin).map(p => p.id);

        if (action === "promote") {
            for (let p of participants) {
                await UserGroupData.findOneAndUpdate({ jid: p, groupId: id }, { adminSince: new Date() }, { upsert: true });
                for (let admin of admins) {
                    await sock.sendMessage(admin, { text: `🔔 *NUOVO ADMIN*\nL'utente @${p.split('@')} è stato promosso nel gruppo ${metadata.subject}. Potrà usare i comandi tra 24 ore.`, mentions: [p] });
                }
            }
        }

        if (action === "demote") {
            for (let p of participants) {
                await UserGroupData.findOneAndUpdate({ jid: p, groupId: id }, { adminSince: null });
            }
        }

        if (action === "add") {
            for (let p of participants) {
                const user = await UserGroupData.findOne({ jid: p, groupId: id });
                if (user?.isBlacklisted || ["212", "92", "234", "254"].some(pre => p.startsWith(pre))) {
                    await sock.groupParticipantsUpdate(id, [p], "remove");
                }
            }
        }

        if (action === "remove" && author) {
            const userAuthor = await UserGroupData.findOne({ jid: author, groupId: id });
            // Gli admin NON sono più whitelistati automaticamente
            if (userAuthor?.isWhitelisted) return;

            nukeTracker[author] = (nukeTracker[author] || 0) + participants.length;
            if (nukeTracker[author] > 3) {
                await sock.groupParticipantsUpdate(id, [author], "remove");
                await UserGroupData.findOneAndUpdate({ jid: author, groupId: id }, { isBlacklisted: true }, { upsert: true });
                for (let admin of admins) {
                    await sock.sendMessage(admin, { text: `🚨 *ALLERTA NUKE*\n${author} ha rimosso membri ed è stato blacklistato.` });
                }
            }
        }
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
        const m = messages;
        if (!m || !m.message || m.key.fromMe) return;
        const jid = m.key.remoteJid;
        if (!jid.endsWith('@g.us')) return;
        const sender = m.key.participant || jid;
        const text = (m.message.conversation || m.message.extendedTextMessage?.text || "").trim();
        
        const metadata = await sock.groupMetadata(jid);
        const adminObj = metadata.participants.find(p => p.id === sender && p.admin);
        const isAdmin = !!adminObj;

        // Controllo Anzianità Admin (24 ore)
        let canUseCommands = false;
        if (isAdmin) {
            let adminData = await UserGroupData.findOne({ jid: sender, groupId: jid });
            if (!adminData || !adminData.adminSince) {
                // Se non c'è data, lo impostiamo come "vecchio admin" per non bloccare i fondatori
                adminData = await UserGroupData.findOneAndUpdate({ jid: sender, groupId: jid }, { adminSince: new Date(0) }, { upsert: true, new: true });
            }
            const hoursActive = (new Date() - adminData.adminSince) / (1000 * 60 * 60);
            if (hoursActive >= 24) canUseCommands = true;
        }

        const userGroup = await UserGroupData.findOne({ jid: sender, groupId: jid });

        // PROTEZIONE (Admin non sono whitelistati auto, subiscono controlli se non in WL)
        if (!userGroup?.isWhitelisted) {
            if (antiLinkActive && /(https?:\/\/[^\s]+)/g.test(text)) {
                await sock.sendMessage(jid, { delete: m.key });
                return await handleViolation(jid, sender, "Link non autorizzato");
            }
            spamTracker[sender] = (spamTracker[sender] || 0) + 1;
            if (spamTracker[sender] === 5) await handleViolation(jid, sender, "Spam (5 msg)");
            if (spamTracker[sender] >= 10) {
                await sock.groupParticipantsUpdate(jid, [sender], "remove");
                await UserGroupData.findOneAndUpdate({ jid: sender, groupId: jid }, { isBlacklisted: true }, { upsert: true });
            }
            setTimeout(() => { if(spamTracker[sender]>0) spamTracker[sender]--; }, 10000);
        }

        if (text.startsWith("!") && isAdmin) {
            // Controllo 24 ore
            let adminData = await UserGroupData.findOne({ jid: sender, groupId: jid });
            const hoursActive = adminData?.adminSince ? (new Date() - adminData.adminSince) / (1000 * 60 * 60) : 25; // Default 25 per i vecchi admin
            if (hoursActive < 24) return await sock.sendMessage(jid, { text: "⏳ Sei admin da meno di 24h. Comandi disabilitati." });

            const args = text.slice(1).split(/ +/);
            const command = args.shift().toLowerCase();
            
            // --- LOGICA TARGET MIGLIORATA ---
            let target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0]; // Prende il primo tag
            if (!target && args.length > 0) {
                const rawNum = args[0].replace(/[^0-9]/g, ''); // Prende il primo argomento (il numero)
                if (rawNum.length >= 8) target = rawNum + '@s.whatsapp.net';
            }

            switch(command) {
                case 'help':
                    await sock.sendMessage(jid, { text: `🛡️ *ADMIN MENU (24h+)*\n\n!warn @tag\n!resetwarn @tag\n!ban @tag\n!unban @tag/numero\n!antilink on/off\n!whitelist add @tag\n!whitelist remove @tag\n!list` });
                    break;
            switch(command) {
                case 'unban':
                    if (target) {
                        await UserGroupData.findOneAndUpdate(
                            { jid: target, groupId: jid }, 
                            { isBlacklisted: false, warns: 0 },
                            { upsert: true }
                        );
                        await sock.sendMessage(jid, { text: `✅ Utente ${target.split('@')[0]} rimosso dalla blacklist di questo gruppo e warn resettati.` });
                    } else {
                        await sock.sendMessage(jid, { text: "⚠️ Tagga un utente o scrivi il numero. Es: !unban 393331234567" });
                    }
                    break;
                case 'whitelist':
                    if (!target) return;
                    // Prende il secondo argomento per capire se add o remove
                    const subCommand = args[0]?.toLowerCase(); 
                    const isAdd = subCommand === 'add';
                    await UserGroupData.findOneAndUpdate({ jid: target, groupId: jid }, { isWhitelisted: isAdd }, { upsert: true });
                    await sock.sendMessage(jid, { text: `✅ Whitelist ${isAdd ? 'aggiunto' : 'rimosso'}: ${target.split('@')[0]}` });
                    break;
                case 'list':
                    const banned = await UserGroupData.find({ groupId: jid, isBlacklisted: true });
                    const whited = await UserGroupData.find({ groupId: jid, isWhitelisted: true });
                    await sock.sendMessage(jid, { text: `🚫 *BANLIST*:\n${banned.map(u => "- " + u.jid.split('@')[0]).join('\n') || 'Vuota'}\n\n⚪ *WHITELIST*:\n${whited.map(u => "- " + u.jid.split('@')[0]).join('\n') || 'Vuota'}` });
                    break;
                case 'warn': if(target) await handleViolation(jid, target, "Manuale"); break;
                case 'resetwarn': if(target) { await UserGroupData.findOneAndUpdate({ jid: target, groupId: jid }, { warns: 0 }); await sock.sendMessage(jid, { text: "✅ Warn resettati" }); } break;
                case 'ban': if(target) { 
                    await sock.groupParticipantsUpdate(jid, [target], "remove"); 
                    await UserGroupData.findOneAndUpdate({ jid: target, groupId: jid }, { isBlacklisted: true }, { upsert: true }); 
                } break;
                case 'antilink': antiLinkActive = args[0] === 'on'; await sock.sendMessage(jid, { text: `🔗 Anti-Link: ${antiLinkActive ? 'ON' : 'OFF'}` }); break;
            }
        }
    });

    sock.ev.on('connection.update', (u) => { if(u.connection === 'close') startBot(); });
}

startBot().catch(console.error);
