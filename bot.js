const { 
    default: makeWASocket, 
    DisconnectReason, 
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    jidDecode
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const express = require('express');
const pino = require('pino');
const mongoose = require('mongoose');
const fs = require('fs');

const MONGO_URL = process.env.MONGO_URL;
const ME_NUMBER = "6285137595799"; 
let whitelist = ["393331234567@s.whatsapp.net"];
let antiLinkActive = true;

const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('🛡️ Anti-Nuke & Warn System Active'));
app.listen(port, () => console.log(`✅ Server porta ${port}`));

// --- SCHEMI DB ---
const Session = mongoose.model('Session', new mongoose.Schema({ id: String, data: String }));
const UserData = mongoose.model('UserData', new mongoose.Schema({
    jid: String,
    warns: { type: Number, default: 0 },
    lastWarn: Date,
    isBlacklisted: { type: Boolean, default: false },
    isWhitelisted: { type: Boolean, default: false }
}));

const nukeTracker = {};
const spamTracker = {};
let messagesProcessedThisSecond = 0;
setInterval(() => { messagesProcessedThisSecond = 0; }, 1000);

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

// --- MODIFICA SOLO QUESTA PARTE NEL BLOCCO makeWASocket ---
    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ["Mac OS", "Chrome", "122.0.6261.112"], // Versione aggiornata a Mac OS
        printQRInTerminal: false
    });


    sock.ev.on('creds.update', async () => { await saveCreds(); await syncSession('save'); });

    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            let code = await sock.requestPairingCode(ME_NUMBER);
            console.log(`🔑 CODICE PAIRING: ${code?.match(/.{1,4}/g)?.join("-")}`);
        }, 6000);
    }

    // Helper: Gestione Warn/Ban
    const handleViolation = async (jid, participant, reason) => {
        let user = await UserData.findOne({ jid: participant }) || new UserData({ jid: participant });
        
        // Reset warn dopo 30 giorni
        if (user.lastWarn && (new Date() - user.lastWarn > 30 * 24 * 60 * 60 * 1000)) user.warns = 0;

        user.warns += 1;
        user.lastWarn = new Date();
        
        if (user.warns >= 3) {
            user.isBlacklisted = true;
            await sock.groupParticipantsUpdate(jid, [participant], "remove");
            await sock.sendMessage(jid, { text: `🚫 @${participant.split('@')[0]} bannato e blacklistato (3/3 Warn). Motivo: ${reason}`, mentions: [participant] });
        } else {
            await sock.sendMessage(jid, { text: `⚠️ @${participant.split('@')[0]} warnato (${user.warns}/3). Motivo: ${reason}`, mentions: [participant] });
        }
        await user.save();
    };

    // --- ANTI-NUKE ---
    sock.ev.on("group-participants.update", async (update) => {
        const { id, participants, action, author } = update;
        const admins = (await sock.groupMetadata(id)).participants.filter(p => p.admin).map(p => p.id);

        if (action === "add") {
            for (let p of participants) {
                const user = await UserData.findOne({ jid: p });
                if (user?.isBlacklisted || ["212", "92", "234", "254"].some(pre => p.startsWith(pre))) {
                    await sock.groupParticipantsUpdate(id, [p], "remove");
                }
            }
        }

        if (action === "remove" && author && !whitelist.includes(author) && !admins.includes(author)) {
            nukeTracker[author] = (nukeTracker[author] || 0) + participants.length;
            if (nukeTracker[author] > 3) {
                await sock.groupParticipantsUpdate(id, [author], "remove");
                await UserData.findOneAndUpdate({ jid: author }, { isBlacklisted: true }, { upsert: true });
                for (let admin of admins) {
                    await sock.sendMessage(admin, { text: `🚨 *ALLERTA NUKE*\nL'utente ${author} ha rimosso più membri ed è stato bannato.` });
                }
            }
        }
    });

    // --- COMANDI E ANTI-SPAM ---
    sock.ev.on("messages.upsert", async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;
        const jid = m.key.remoteJid;
        const sender = m.key.participant || jid;
        const text = m.message.conversation || m.message.extendedTextMessage?.text || "";
        const isCmd = text.startsWith("!");
        const args = text.slice(1).trim().split(/ +/);
        const command = args.shift().toLowerCase();

        const metadata = jid.endsWith('@g.us') ? await sock.groupMetadata(jid) : null;
        const isBotAdmin = metadata ? metadata.participants.find(p => p.id === sock.user.id.split(':')[0] + '@s.whatsapp.net')?.admin : false;
        const isAdmin = metadata ? metadata.participants.find(p => p.id === sender)?.admin : false;

        // Anti-Link & Anti-Spam
        if (metadata && !isAdmin && !whitelist.includes(sender)) {
            if (antiLinkActive && /(https?:\/\/[^\s]+)/g.test(text)) {
                await sock.sendMessage(jid, { delete: m.key });
                return await handleViolation(jid, sender, "Invio link non autorizzato");
            }

            spamTracker[sender] = (spamTracker[sender] || 0) + 1;
            if (spamTracker[sender] === 5) await handleViolation(jid, sender, "Spam rilevato (5 messaggi)");
            if (spamTracker[sender] >= 10) {
                await sock.groupParticipantsUpdate(jid, [sender], "remove");
                await UserData.findOneAndUpdate({ jid: sender }, { isBlacklisted: true }, { upsert: true });
                delete spamTracker[sender];
            }
            setTimeout(() => { if(spamTracker[sender]>0) spamTracker[sender]--; }, 10000);
        }

        // Comandi Admin
        if (isCmd && isAdmin) {
            const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || (args[0]?.includes('@') ? args[0] : null);

            switch(command) {
                case 'help':
                    await sock.sendMessage(jid, { text: `📜 *MENU ADMIN*\n\n!warn @user - Warn manuale\n!ban @user - Ban e Blacklist\n!antilink on/off - Attiva/Disattiva Anti-Link\n!whitelist add/remove @user\n!list - Mostra Banlist e Whitelist` });
                    break;
                case 'warn':
                    if (target) await handleViolation(jid, target, "Manuale da Admin");
                    break;
                case 'ban':
                    if (target) {
                        await sock.groupParticipantsUpdate(jid, [target], "remove");
                        await UserData.findOneAndUpdate({ jid: target }, { isBlacklisted: true }, { upsert: true });
                    }
                    break;
                case 'antilink':
                    antiLinkActive = args[0] === 'on';
                    await sock.sendMessage(jid, { text: `🔗 Anti-Link: ${antiLinkActive ? 'ATTIVO' : 'DISATTIVATO'}` });
                    break;
                case 'whitelist':
                    if (!target) return;
                    if (args[0] === 'add') {
                        whitelist.push(target);
                        await UserData.findOneAndUpdate({ jid: target }, { isWhitelisted: true }, { upsert: true });
                    } else {
                        whitelist = whitelist.filter(i => i !== target);
                        await UserData.findOneAndUpdate({ jid: target }, { isWhitelisted: false });
                    }
                    await sock.sendMessage(jid, { text: `✅ Whitelist aggiornata.` });
                    break;
                case 'list':
                    const banned = await UserData.find({ isBlacklisted: true });
                    const whited = await UserData.find({ isWhitelisted: true });
                    let msg = `🚫 *BANLIST*:\n${banned.map(u => "- " + u.jid).join('\n')}\n\n⚪ *WHITELIST*:\n${whited.map(u => "- " + u.jid).join('\n')}`;
                    await sock.sendMessage(jid, { text: msg });
                    break;
            }
        }
    });

    sock.ev.on('connection.update', (u) => { if(u.connection === 'close') startBot(); });
}

startBot().catch(console.error);
