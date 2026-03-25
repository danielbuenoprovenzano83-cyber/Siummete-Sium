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
app.get('/', (req, res) => res.send('🛡️ Security Bot Multi-Group Online'));
app.listen(port, () => console.log(`✅ Server attivo`));

// --- DB SCHEMA ---
const Session = mongoose.model('Session', new mongoose.Schema({ id: String, data: String }));
const UserGroupData = mongoose.model('UserGroupData', new mongoose.Schema({
    jid: String,
    groupId: String,
    warns: { type: Number, default: 0 },
    lastWarn: Date,
    isBlacklisted: { type: Boolean, default: false },
    isWhitelisted: { type: Boolean, default: false },
    adminSince: { type: Date, default: null }
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
            try {
                let code = await sock.requestPairingCode(ME_NUMBER);
                console.log(`🔑 CODICE: ${code?.match(/.{1,4}/g)?.join("-")}`);
            } catch (e) { console.error("Errore pairing"); }
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
            await sock.sendMessage(jid, { text: `🚫 @${participant.split('@')[0]} BANNATO (3/3 Warn).\nMotivo: ${reason}`, mentions: [participant] });
        } else {
            await sock.sendMessage(jid, { text: `⚠️ @${participant.split('@')[0]} WARNATO (${user.warns}/3).\nMotivo: ${reason}`, mentions: [participant] });
        }
        await user.save();
    };

    sock.ev.on("group-participants.update", async (update) => {
        const { id, participants, action, author } = update;
        const metadata = await sock.groupMetadata(id);
        const admins = metadata.participants.filter(p => p.admin).map(p => p.id);

        if (action === "promote") {
            for (let p of participants) {
                await UserGroupData.findOneAndUpdate({ jid: p, groupId: id }, { adminSince: new Date() }, { upsert: true });
                for (let admin of admins) {
                    await sock.sendMessage(admin, { text: `🔔 *NUOVO ADMIN*\nL'utente @${p.split('@')[0]} è stato promosso in "${metadata.subject}".\nPotrà usare i comandi tra 24 ore.`, mentions: [p] });
                }
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
            if (userAuthor?.isWhitelisted) return;

            nukeTracker[author] = (nukeTracker[author] || 0) + participants.length;
            if (nukeTracker[author] > 3) {
                await sock.groupParticipantsUpdate(id, [author], "remove");
                await UserGroupData.findOneAndUpdate({ jid: author, groupId: id }, { isBlacklisted: true }, { upsert: true });
                for (let admin of admins) {
                    await sock.sendMessage(admin, { text: `🚨 *ALLERTA NUKE*\nL'utente ${author} sta eliminando membri in "${metadata.subject}".\nÈ stato bannato e blacklistato.` });
                }
            }
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
        const userGroup = await UserGroupData.findOne({ jid: sender, groupId: jid });

        // PROTEZIONE (Admin non whitelistati subiscono i controlli)
        if (!userGroup?.isWhitelisted) {
            if (antiLinkActive && /(https?:\/\/[^\s]+)/g.test(text)) {
                await sock.sendMessage(jid, { delete: m.key });
                return await handleViolation(jid, sender, "Invio link");
            }
            spamTracker[sender] = (spamTracker[sender] || 0) + 1;
            if (spamTracker[sender] === 5) await handleViolation(jid, sender, "Spam (5 messaggi)");
            if (spamTracker[sender] >= 10) {
                await sock.groupParticipantsUpdate(jid, [sender], "remove");
                await UserGroupData.findOneAndUpdate({ jid: sender, groupId: jid }, { isBlacklisted: true }, { upsert: true });
            }
            setTimeout(() => { if(spamTracker[sender]>0) spamTracker[sender]--; }, 10000);
        }
        // COMANDI ADMIN
        if (text.startsWith("!") && isAdmin) {
            let adminData = await UserGroupData.findOne({ jid: sender, groupId: jid });
            const hoursActive = adminData?.adminSince ? (new Date() - adminData.adminSince) / (1000 * 60 * 60) : 25;
            if (hoursActive < 24) return await sock.sendMessage(jid, { text: "⏳ Comandi bloccati: devi essere admin da almeno 24 ore." });

            const args = text.slice(1).split(/ +/);
            const command = args.shift().toLowerCase();
            
            // Logica Target: Tag o Numero manuale
            let target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
            if (!target && args[0]) {
                const rawNum = args[0].replace(/[^0-9]/g, '');
                if (rawNum.length >= 10) target = rawNum + '@s.whatsapp.net';
            }

            switch(command) {
                case 'help':
                    const helpMsg = `🛡️ *HELP ADMIN*\n\n` +
                                   `•!warn @tag - Warn utente\n
` +
                                   `•!resetwarn @tag - Resetta warn\n
` +
                                   `•!ban @tag - Ban e Blacklist\n
` +
                                   `•!unban @tag/numero - Sblocca\n
` +
                                   `•!antilink on/off - Attiva/Disattiva\n
` +
                                   `•!whitelist add @tag - Proteggi admin/utente\n
 ` +
                                   `•!whitelist remove @tag - Togli protezione\n
 ` +
                                   `•!list - Vedi Banlist e Whitelist`;
                    await sock.sendMessage(jid, { text: helpMsg });
                    break;

                case 'unban':
                    if (target) {
                        await UserGroupData.findOneAndUpdate({ jid: target, groupId: jid }, { isBlacklisted: false, warns: 0 }, { upsert: true });
                        await sock.sendMessage(jid, { text: `✅ Utente ${target.split('@')[0]} rimosso dalla blacklist di questo gruppo.` });
                    } else {
                        await sock.sendMessage(jid, { text: "⚠️ Usa: !unban @tag o !unban numero" });
                    }
                    break;

                case 'whitelist':
                    if (target && args[0]) {
                        const isAdd = args[0].toLowerCase() === 'add';
                        await UserGroupData.findOneAndUpdate({ jid: target, groupId: jid }, { isWhitelisted: isAdd }, { upsert: true });
                        await sock.sendMessage(jid, { text: `✅ Whitelist ${isAdd ? 'AGGIUNTO' : 'RIMOSSO'}: ${target.split('@')[0]}` });
                    } else {
                        await sock.sendMessage(jid, { text: "⚠️ Usa: !whitelist add @tag o !whitelist remove @tag" });
                    }
                    break;

                case 'list':
                    const banned = await UserGroupData.find({ groupId: jid, isBlacklisted: true });
                    const whited = await UserGroupData.find({ groupId: jid, isWhitelisted: true });
                    let msg = `🚫 *BANLIST (Blacklist)*:\n${banned.map(u => "- " + u.jid.split('@')[0]).join('\n') || 'Nessuno'}\n\n`;
                    msg += `⚪ *WHITELIST*:\n${whited.map(u => "- " + u.jid.split('@')[0]).join('\n') || 'Nessuno'}`;
                    await sock.sendMessage(jid, { text: msg });
                    break;

                case 'warn': if(target) await handleViolation(jid, target, "Manuale"); break;
                
                case 'resetwarn': 
                    if(target) { 
                        await UserGroupData.findOneAndUpdate({ jid: target, groupId: jid }, { warns: 0 }); 
                        await sock.sendMessage(jid, { text: "✅ Warn resettati." }); 
                    } 
                    break;

                case 'ban': 
                    if(target) { 
                        try { await sock.groupParticipantsUpdate(jid, [target], "remove"); } catch(e) {}
                        await UserGroupData.findOneAndUpdate({ jid: target, groupId: jid }, { isBlacklisted: true }, { upsert: true }); 
                        await sock.sendMessage(jid, { text: "🚫 Utente rimosso e blacklistato." });
                    } 
                    break;

                case 'antilink': 
                    antiLinkActive = args[0]?.toLowerCase() === 'on'; 
                    await sock.sendMessage(jid, { text: `🔗 Anti-Link: ${antiLinkActive ? 'ATTIVO' : 'DISATTIVATO'}` }); 
                    break;
            }
        }
    });

    sock.ev.on('connection.update', (u) => { 
        if (u.connection === 'close') {
            const shouldReconnect = (u.lastDisconnect.error instanceof Boom) ? u.lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true;
            if (shouldReconnect) startBot();
        } else if (u.connection === 'open') {
            console.log('✅ BOT ONLINE E SINCRONIZZATO!');
        }
    });
}

startBot().catch(console.error);

