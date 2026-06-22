require('dotenv').config();
const {
    Client, GatewayIntentBits, SlashCommandBuilder, PermissionFlagsBits,
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    ModalBuilder, TextInputBuilder, TextInputStyle,
    StringSelectMenuBuilder, UserSelectMenuBuilder, ChannelSelectMenuBuilder,
    ChannelType
} = require('discord.js');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data.json');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

// ── State (all persisted to data.json) ──
const trackedChannels = new Map(); // guildId   -> Set<channelId>
const messageCounts = new Map();   // chanUserKey -> { startTime, count, lastSubmission }
const rateLimit = new Map();       // channelId -> daily limit
const cooldown = new Map();        // channelId -> ms between accepted submissions
const resetTime = new Map();       // channelId -> ms (daily window length)
const userLimits = new Map();      // chanUserKey -> per-user limit override
const blockedUsers = new Map();    // chanUserKey -> true
const allowedRoles = new Map();    // channelId -> [roleId]
const lockedChannels = new Map();  // channelId -> { lockedAt, expiresAt }
const warnOnDelete = new Map();    // channelId -> true (DM a member when their post is removed)
const totalMessagesDeleted = new Map(); // channelId -> count
const totalMessagesTracked = new Map(); // channelId -> count

const DEFAULT_LIMIT = 5;
const DEFAULT_COOLDOWN = 60 * 60 * 1000;          // 1 hour
const DEFAULT_RESET_TIME = 24 * 60 * 60 * 1000;   // 24 hours
const MAX_LIMIT = 1_000_000;                      // "maximized" / unlimited sentinel
const botStartTime = Date.now();

const COLORS = {
    primary: 0x5865F2,
    locked: 0xED4245,
    success: 0x57F287,
};

function getChannelUserKey(channelId, userId) {
    return `${channelId}:${userId}`;
}

function channelIdFromKey(key) {
    return key.slice(0, key.indexOf(':'));
}

// ── Effective-setting resolvers (?? so an explicit 0 is honoured) ──
function getLimit(channelId) {
    const v = rateLimit.get(channelId);
    return v ?? DEFAULT_LIMIT;
}
function getEffectiveLimit(channelId, userId) {
    const o = userLimits.get(getChannelUserKey(channelId, userId));
    return o ?? getLimit(channelId);
}
function getCooldown(channelId) {
    const v = cooldown.get(channelId);
    return v ?? DEFAULT_COOLDOWN;
}
function getResetWindow(channelId) {
    const v = resetTime.get(channelId);
    return v ?? DEFAULT_RESET_TIME;
}
function isUnlimited(limit) {
    return limit >= MAX_LIMIT;
}

function clearChannelCounts(channelId) {
    for (const key of messageCounts.keys()) {
        if (key.startsWith(channelId + ':')) messageCounts.delete(key);
    }
}
function clearGuildCounts(guildId) {
    const channels = trackedChannels.get(guildId) || new Set();
    for (const channelId of channels) clearChannelCounts(channelId);
}

// ═══════════════════════════════════════════════════
//  Persistent Storage — saves settings to data.json
// ═══════════════════════════════════════════════════
let saveTimer = null;

function saveData() {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    try {
        const data = {
            // Set is not JSON-serializable — store each guild's channel set as an array
            trackedChannels: Object.fromEntries(
                [...trackedChannels.entries()].map(([guildId, set]) => [guildId, [...set]])
            ),
            rateLimit: Object.fromEntries(rateLimit),
            cooldown: Object.fromEntries(cooldown),
            resetTime: Object.fromEntries(resetTime),
            userLimits: Object.fromEntries(userLimits),
            blockedUsers: Object.fromEntries(blockedUsers),
            allowedRoles: Object.fromEntries(allowedRoles),
            lockedChannels: Object.fromEntries(lockedChannels),
            warnOnDelete: Object.fromEntries(warnOnDelete),
            totalMessagesDeleted: Object.fromEntries(totalMessagesDeleted),
            totalMessagesTracked: Object.fromEntries(totalMessagesTracked),
            messageCounts: Object.fromEntries(messageCounts),
        };
        // Atomic write: a crash mid-write leaves the previous data.json intact.
        const tmp = DATA_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
        fs.renameSync(tmp, DATA_FILE);
    } catch (err) {
        console.error('Failed to save data:', err.message);
    }
}

// Coalesce high-frequency writes (per-message updates) into at most one disk
// write per second so a busy channel never blocks the event loop on every
// message. Config/admin changes call saveData() directly for durability.
function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        saveData();
    }, 1000);
}

function loadData() {
    try {
        if (!fs.existsSync(DATA_FILE)) return;
        const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));

        if (data.trackedChannels) {
            for (const [guildId, arr] of Object.entries(data.trackedChannels)) {
                trackedChannels.set(guildId, new Set(arr));
            }
        }
        const restore = (src, target) => {
            if (src) for (const [k, v] of Object.entries(src)) target.set(k, v);
        };
        restore(data.rateLimit, rateLimit);
        restore(data.cooldown, cooldown);
        restore(data.resetTime, resetTime);
        restore(data.userLimits, userLimits);
        restore(data.blockedUsers, blockedUsers);
        restore(data.allowedRoles, allowedRoles);
        restore(data.warnOnDelete, warnOnDelete);
        restore(data.totalMessagesDeleted, totalMessagesDeleted);
        restore(data.totalMessagesTracked, totalMessagesTracked);
        restore(data.messageCounts, messageCounts);

        if (data.lockedChannels) {
            const now = Date.now();
            for (const [channelId, v] of Object.entries(data.lockedChannels)) {
                if (v.expiresAt && now >= v.expiresAt) continue; // drop expired
                lockedChannels.set(channelId, v);
                if (v.expiresAt) scheduleUnlock(channelId, v); // resume auto-unlock
            }
        }

        console.log('Data loaded from data.json');
    } catch (err) {
        console.error('Failed to load data:', err.message);
    }
}

// Schedule (or re-schedule) the auto-unlock for a timed lockdown.
function scheduleUnlock(channelId, lockData) {
    const remaining = lockData.expiresAt - Date.now();
    setTimeout(() => {
        const current = lockedChannels.get(channelId);
        if (current && current.lockedAt === lockData.lockedAt) {
            lockedChannels.delete(channelId);
            clearChannelCounts(channelId);
            saveData();
        }
    }, Math.max(0, remaining));
}

// Parse duration strings like "24h", "3d", "1d12h", "30m"
function parseDuration(str) {
    if (!str) return null;
    str = str.toLowerCase().trim();
    let totalMs = 0;
    const dayMatch = str.match(/(\d+)\s*d/);
    const hourMatch = str.match(/(\d+)\s*h/);
    const minMatch = str.match(/(\d+)\s*m/);
    if (dayMatch) totalMs += parseInt(dayMatch[1]) * 24 * 60 * 60 * 1000;
    if (hourMatch) totalMs += parseInt(hourMatch[1]) * 60 * 60 * 1000;
    if (minMatch) totalMs += parseInt(minMatch[1]) * 60 * 1000;
    return totalMs > 0 ? totalMs : null;
}

// Parse a cooldown/duration that is allowed to be zero ("off"/"0" disables it).
function parseCooldownInput(str) {
    if (!str) return null;
    const s = str.toLowerCase().trim();
    if (['0', 'off', 'none', 'disable', 'disabled'].includes(s)) return 0;
    return parseDuration(s); // null if invalid
}

function formatDuration(ms) {
    if (ms <= 0) return '0m';
    const days = Math.floor(ms / (24 * 60 * 60 * 1000));
    ms %= 24 * 60 * 60 * 1000;
    const hours = Math.floor(ms / (60 * 60 * 1000));
    ms %= 60 * 60 * 1000;
    const mins = Math.floor(ms / (60 * 1000));
    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (mins > 0) parts.push(`${mins}m`);
    return parts.join(' ') || '<1m';
}

// Discord relative timestamp — renders as a live, self-updating "in 3 hours" /
// "5 minutes ago" in every client, localised to the viewer.
function tsR(unixMs) {
    return `<t:${Math.floor(unixMs / 1000)}:R>`;
}

function progressBar(count, limit) {
    if (isUnlimited(limit)) return '∞';
    if (limit <= 0) return '🚫 (0 allowed)';
    const slots = 10;
    const filled = Math.max(0, Math.min(slots, Math.round((count / limit) * slots)));
    return '▰'.repeat(filled) + '▱'.repeat(slots - filled);
}

async function isAdmin(member) {
    if (!member) return false;
    return member.permissions.has(PermissionFlagsBits.Administrator);
}

// ── Per-user status snapshot, shared by /info, /checkuser and the user panel ──
function getUserStatus(channelId, userId) {
    const key = getChannelUserKey(channelId, userId);
    const now = Date.now();
    const limit = getEffectiveLimit(channelId, userId);
    const windowMs = getResetWindow(channelId);
    const cd = getCooldown(channelId);
    const entry = messageCounts.get(key);

    let used = 0;
    let resetAt = null;       // absolute ms when the daily count resets
    let cooldownEndsAt = null; // absolute ms when the next post is allowed
    if (entry) {
        if (now - entry.startTime < windowMs) {
            used = entry.count;
            resetAt = entry.startTime + windowMs;
        }
        if (cd > 0 && entry.lastSubmission && now - entry.lastSubmission < cd) {
            cooldownEndsAt = entry.lastSubmission + cd;
        }
    }
    return {
        used,
        limit,
        windowMs,
        cooldownMs: cd,
        resetAt,
        cooldownEndsAt,
        lastSubmission: entry?.lastSubmission || 0,
        hasOverride: userLimits.has(key),
        blocked: blockedUsers.has(key),
        remaining: isUnlimited(limit) ? Infinity : Math.max(0, limit - used),
    };
}

function userStatusText(channelId, userId, { selfView = false } = {}) {
    const s = getUserStatus(channelId, userId);
    const who = selfView ? 'You have' : `<@${userId}> has`;
    const lines = [];

    if (isUnlimited(s.limit)) {
        lines.push(`♾️ ${who} an **unlimited** allowance (maximized).`);
    } else {
        lines.push(`📊 ${who} used **${s.used}/${s.limit}** memes ${progressBar(s.used, s.limit)}`);
        lines.push(`   Remaining: **${s.remaining}**`);
    }
    if (s.hasOverride) lines.push('   *(custom per-user limit set by an admin)*');
    if (s.resetAt) lines.push(`⏳ Daily count resets ${tsR(s.resetAt)}`);
    if (!isUnlimited(s.limit) && s.cooldownMs > 0) {
        lines.push(s.cooldownEndsAt
            ? `🕒 Cooldown: next meme ${tsR(s.cooldownEndsAt)}`
            : `🕒 Cooldown: **ready to post** (${formatDuration(s.cooldownMs)} between memes)`);
    }
    if (s.blocked) lines.push('🚫 **Blocked** in this channel.');

    const lockInfo = lockedChannels.get(channelId);
    if (lockInfo && (!lockInfo.expiresAt || Date.now() < lockInfo.expiresAt)) {
        lines.push(lockInfo.expiresAt
            ? `🔒 Channel is **locked** (unlocks ${tsR(lockInfo.expiresAt)})`
            : '🔒 Channel is **locked**.');
    }
    return lines.join('\n');
}

// ═══════════════════════════════════════════════════
//  Message handling — limit + cooldown enforcement
// ═══════════════════════════════════════════════════
async function handleMessage(message) {
    if (message.author.bot) return;
    if (!message.guild) return;
    if (message.content.startsWith('/')) return;

    const guildId = message.guild.id;
    const channelId = message.channel.id;
    const userId = message.author.id;

    const set = trackedChannels.get(guildId);
    if (!set || !set.has(channelId)) return;

    const member = message.member || await message.guild.members.fetch(userId).catch(() => null);
    if (await isAdmin(member)) return; // admins bypass everything

    // Lockdown — only admins may talk
    const lockInfo = lockedChannels.get(channelId);
    if (lockInfo) {
        if (lockInfo.expiresAt && Date.now() >= lockInfo.expiresAt) {
            lockedChannels.delete(channelId);
            clearChannelCounts(channelId);
            saveData();
        } else {
            message.delete().catch(() => {});
            return;
        }
    }

    // Role restriction
    const roles = allowedRoles.get(channelId);
    if (roles && roles.length > 0) {
        const userRoles = member ? [...member.roles.cache.keys()] : [];
        if (!roles.some(r => userRoles.includes(r))) {
            message.delete().catch(() => {});
            return;
        }
    }

    // Blocked user
    if (blockedUsers.has(getChannelUserKey(channelId, userId))) {
        message.delete().catch(() => {});
        return;
    }

    const key = getChannelUserKey(channelId, userId);
    const now = Date.now();
    const limit = getEffectiveLimit(channelId, userId);
    const windowMs = getResetWindow(channelId);
    const cd = getCooldown(channelId);

    let entry = messageCounts.get(key);
    if (!entry) {
        entry = { startTime: now, count: 0, lastSubmission: 0 };
        messageCounts.set(key, entry);
    }
    // New daily window?
    if (now - entry.startTime >= windowMs) {
        entry.startTime = now;
        entry.count = 0;
    }

    totalMessagesTracked.set(channelId, (totalMessagesTracked.get(channelId) || 0) + 1);

    const warnEnabled = !!warnOnDelete.get(channelId);
    const removeOver = (reason) => {
        message.delete().catch(() => {});
        totalMessagesDeleted.set(channelId, (totalMessagesDeleted.get(channelId) || 0) + 1);
        // One DM per blocked streak: warn only if enabled and we haven't already
        // warned since their last accepted post (entry.warned resets on accept).
        if (warnEnabled && !entry.warned) {
            entry.warned = true;
            message.author.send({ content: reason, allowedMentions: NO_PING }).catch(() => {});
        }
        scheduleSave();
    };

    // Maximized users post freely (no limit, no cooldown)
    if (!isUnlimited(limit)) {
        // Daily limit reached — reject without consuming anything further
        if (entry.count >= limit) {
            return removeOver(`🛑 Your post in <#${channelId}> was removed — you've used all **${limit}/${limit}** memes for now. You can post again ${tsR(entry.startTime + windowMs)}.`);
        }
        // Cooldown still active — reject (does not count toward the daily tally)
        if (cd > 0 && entry.lastSubmission && now - entry.lastSubmission < cd) {
            return removeOver(`🕒 Your post in <#${channelId}> was removed — please slow down. You can post again ${tsR(entry.lastSubmission + cd)}.`);
        }
    }

    // Accepted submission
    entry.count++;
    entry.lastSubmission = now;
    entry.warned = false;
    scheduleSave();
}

// ═══════════════════════════════════════════════════
//  Dashboard / view builders
//  Each returns { embed, rows }. Context is encoded in component
//  customIds (e.g. "ch_setlimit:<channelId>") so views survive refreshes
//  without re-parsing the embed.
// ═══════════════════════════════════════════════════
function channelName(guild, channelId) {
    return guild?.channels?.cache?.get(channelId)?.name || channelId;
}

function buildMainDashboard(guild) {
    const guildId = guild.id;
    const now = Date.now();
    const channels = Array.from(trackedChannels.get(guildId) || new Set());

    const embed = new EmbedBuilder()
        .setTitle('🛡️ Meme Guardian — Control Center')
        .setDescription('Overview of every tracked channel. Pick one below to configure its limits, cooldown and members.')
        .setColor(COLORS.primary)
        .setTimestamp()
        .setFooter({ text: `Uptime: ${formatDuration(now - botStartTime)}` });

    if (guild.iconURL()) embed.setThumbnail(guild.iconURL({ size: 128 }));

    embed.addFields({ name: '📡 Tracked channels', value: `**${channels.length}**`, inline: true });

    if (channels.length > 0) {
        const list = channels.map(cid => {
            const lock = lockedChannels.get(cid);
            const locked = lock && (!lock.expiresAt || now < lock.expiresAt);
            const icon = locked ? '🔴' : '🟢';
            const lim = isUnlimited(getLimit(cid)) ? '∞' : getLimit(cid);
            const cd = getCooldown(cid);
            const tracked = totalMessagesTracked.get(cid) || 0;
            const deleted = totalMessagesDeleted.get(cid) || 0;
            return `${icon} <#${cid}> · limit **${lim}**/${formatDuration(getResetWindow(cid))}` +
                   ` · cooldown **${cd > 0 ? formatDuration(cd) : 'off'}** · ${tracked} seen, ${deleted} blocked`;
        }).join('\n');
        embed.addFields({ name: '📌 Channels', value: list.slice(0, 1024), inline: false });
    } else {
        embed.addFields({ name: '📌 Channels', value: '*None yet — use **Add Channel** below.*', inline: false });
    }

    const rows = [];
    if (channels.length > 0) {
        const options = channels.slice(0, 25).map(cid => ({
            label: `#${channelName(guild, cid)}`.slice(0, 100),
            value: cid,
        }));
        rows.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('main_selectchannel')
                .setPlaceholder('⚙️ Select a channel to manage…')
                .addOptions(options)
        ));
    }
    rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('main_addchannel').setLabel('Add Channel').setEmoji('➕').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('main_removechannel').setLabel('Remove Channel').setEmoji('➖').setStyle(ButtonStyle.Danger).setDisabled(channels.length === 0),
        new ButtonBuilder().setCustomId('main_refresh').setLabel('Refresh').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
    ));
    return { embed, rows };
}

function activeUsers(channelId) {
    const now = Date.now();
    const windowMs = getResetWindow(channelId);
    const out = [];
    for (const [key, data] of messageCounts.entries()) {
        if (key.startsWith(channelId + ':') && now - data.startTime < windowMs) {
            out.push({ id: key.split(':')[1], count: data.count, last: data.lastSubmission || 0 });
        }
    }
    return out;
}

function buildChannelDashboard(channelId, guild) {
    const now = Date.now();
    const limit = getLimit(channelId);
    const cd = getCooldown(channelId);
    const windowMs = getResetWindow(channelId);
    const tracked = totalMessagesTracked.get(channelId) || 0;
    const deleted = totalMessagesDeleted.get(channelId) || 0;

    const users = activeUsers(channelId).sort((a, b) => b.count - a.count);
    const blocked = [];
    for (const key of blockedUsers.keys()) {
        if (key.startsWith(channelId + ':')) blocked.push(key.split(':')[1]);
    }
    const roles = allowedRoles.get(channelId);

    const lockInfo = lockedChannels.get(channelId);
    const activeLock = lockInfo && (!lockInfo.expiresAt || now < lockInfo.expiresAt) ? lockInfo : null;

    const embed = new EmbedBuilder()
        .setTitle('🛡️ Channel Control')
        .setDescription(`Channel: <#${channelId}>\nEdit settings or manage members with the buttons below.`)
        .setColor(activeLock ? COLORS.locked : COLORS.primary)
        .setTimestamp()
        .setFooter({ text: `Uptime: ${formatDuration(now - botStartTime)}` });
    if (guild.iconURL()) embed.setThumbnail(guild.iconURL({ size: 128 }));

    embed.addFields(
        { name: activeLock ? '🔴 Status' : '🟢 Status', value: activeLock ? '**LOCKED DOWN**' : '**Active**', inline: true },
        { name: '📊 Daily limit', value: isUnlimited(limit) ? '**∞**' : `**${limit}** memes`, inline: true },
        { name: '🕒 Cooldown', value: cd > 0 ? `**${formatDuration(cd)}**` : '**off**', inline: true },
        { name: '⏱️ Reset window', value: `**${formatDuration(windowMs)}**`, inline: true },
        { name: '🎭 Roles', value: roles && roles.length ? roles.map(r => `<@&${r}>`).join(' ') : '*Everyone*', inline: true },
        { name: '🚫 Blocked', value: `**${blocked.length}**`, inline: true },
        { name: '🔔 Warn on delete', value: warnOnDelete.get(channelId) ? '**on** (DMs members)' : 'off', inline: true },
    );

    if (activeLock) {
        embed.addFields({
            name: '⚠️ Lockdown',
            value: activeLock.expiresAt
                ? `🔒 unlocks ${tsR(activeLock.expiresAt)}`
                : '🔒 Indefinite — use the Lock/Unlock button',
            inline: false,
        });
    }

    embed.addFields({
        name: '📈 Stats',
        value: [
            `Submissions seen: **${tracked}**`,
            `Blocked/deleted: **${deleted}**`,
            `Active members (this window): **${users.length}**`,
        ].join('\n'),
        inline: false,
    });

    // Compact top 5 — full lists live behind the buttons
    if (users.length > 0) {
        const top = users.slice(0, 5).map(u => {
            const lim = getEffectiveLimit(channelId, u.id);
            const star = userLimits.has(getChannelUserKey(channelId, u.id)) ? ' ⭐' : '';
            return `<@${u.id}>${star} — ${isUnlimited(lim) ? '∞' : `${u.count}/${lim}`} ${progressBar(u.count, lim)}`;
        }).join('\n');
        embed.addFields({ name: '🏆 Top members', value: top.slice(0, 1024), inline: false });
    }

    const rows = [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`ch_setlimit:${channelId}`).setLabel('Set Limit').setEmoji('📊').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`ch_setcooldown:${channelId}`).setLabel('Set Cooldown').setEmoji('🕒').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`ch_setreset:${channelId}`).setLabel('Set Window').setEmoji('⏱️').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`ch_togglelock:${channelId}`).setLabel(activeLock ? 'Unlock' : 'Lock').setEmoji(activeLock ? '🔓' : '🔒').setStyle(activeLock ? ButtonStyle.Success : ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`ch_togglewarn:${channelId}`).setLabel(warnOnDelete.get(channelId) ? 'Warn: On' : 'Warn: Off').setEmoji('🔔').setStyle(warnOnDelete.get(channelId) ? ButtonStyle.Success : ButtonStyle.Secondary),
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`ch_recent:${channelId}`).setLabel('Recent 10').setEmoji('🕒').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`ch_fulllist:${channelId}:0`).setLabel("Today's List").setEmoji('📋').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`ch_manageuser:${channelId}`).setLabel('Manage / Look Up Member').setEmoji('👤').setStyle(ButtonStyle.Secondary),
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`ch_resetcounts:${channelId}`).setLabel('Reset Counts').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`ch_resetstats:${channelId}`).setLabel('Reset Stats').setEmoji('📊').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`ch_unblockall:${channelId}`).setLabel('Unblock All').setEmoji('✅').setStyle(ButtonStyle.Secondary).setDisabled(blocked.length === 0),
            new ButtonBuilder().setCustomId(`ch_clearroles:${channelId}`).setLabel('Clear Roles').setEmoji('🎭').setStyle(ButtonStyle.Secondary).setDisabled(!roles || !roles.length),
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('main_refresh').setLabel('Back to Overview').setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`ch_refresh:${channelId}`).setLabel('Refresh').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
        ),
    ];
    return { embed, rows };
}

function buildRecentList(channelId, guild) {
    const users = activeUsers(channelId)
        .filter(u => u.last > 0)
        .sort((a, b) => b.last - a.last)
        .slice(0, 10);

    const embed = new EmbedBuilder()
        .setTitle('🕒 Recent submissions')
        .setColor(COLORS.primary)
        .setDescription(
            `The **last ${users.length} member${users.length === 1 ? '' : 's'}** to post in <#${channelId}> ` +
            `(most recent first, current ${formatDuration(getResetWindow(channelId))} window).`
        )
        .setTimestamp();

    if (users.length === 0) {
        embed.addFields({ name: 'Nobody yet', value: '*No submissions in this window.*' });
    } else {
        const body = users.map((u, i) => {
            const lim = getEffectiveLimit(channelId, u.id);
            const used = isUnlimited(lim) ? '∞' : `${u.count}/${lim}`;
            return `**${i + 1}.** <@${u.id}> — ${used} · posted ${tsR(u.last)}`;
        }).join('\n');
        embed.addFields({ name: 'Members', value: body.slice(0, 1024) });
    }

    const rows = [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`ch_refresh:${channelId}`).setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`ch_recent:${channelId}`).setLabel('Refresh').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
    )];
    return { embed, rows };
}

const FULL_LIST_PAGE = 15;

function buildFullList(channelId, guild, page) {
    const now = Date.now();
    const users = activeUsers(channelId).sort((a, b) => b.count - a.count);
    const pages = Math.max(1, Math.ceil(users.length / FULL_LIST_PAGE));
    page = Math.max(0, Math.min(page, pages - 1));
    const slice = users.slice(page * FULL_LIST_PAGE, page * FULL_LIST_PAGE + FULL_LIST_PAGE);

    const embed = new EmbedBuilder()
        .setTitle("📋 Today's submitters")
        .setColor(COLORS.primary)
        .setTimestamp()
        .setFooter({ text: `Page ${page + 1}/${pages}` });

    let desc = `**Every member** who posted in <#${channelId}> during the current ` +
               `${formatDuration(getResetWindow(channelId))} window — **${users.length}** total, sorted by memes used.\n\n`;
    if (slice.length === 0) {
        desc += '*No submissions in this window.*';
    } else {
        desc += slice.map((u, i) => {
            const rank = page * FULL_LIST_PAGE + i + 1;
            const lim = getEffectiveLimit(channelId, u.id);
            const used = isUnlimited(lim) ? '∞ (maximized)' : `${u.count}/${lim}`;
            const atLimit = !isUnlimited(lim) && u.count >= lim ? ' 🔴' : '';
            const star = userLimits.has(getChannelUserKey(channelId, u.id)) ? ' ⭐' : '';
            return `**${rank}.** <@${u.id}>${star} — ${used}${atLimit}`;
        }).join('\n');
    }
    embed.setDescription(desc.slice(0, 4096));

    const rows = [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`ch_fulllist:${channelId}:${page - 1}`).setLabel('Prev').setEmoji('◀️').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
            new ButtonBuilder().setCustomId(`ch_fulllist:${channelId}:${page + 1}`).setLabel('Next').setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1),
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`ch_refresh:${channelId}`).setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`ch_fulllist:${channelId}:${page}`).setLabel('Refresh').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
        ),
    ];
    return { embed, rows };
}

function buildUserPanel(channelId, userId, guild) {
    const s = getUserStatus(channelId, userId);
    const name = guild?.members?.cache?.get(userId)?.displayName;

    const embed = new EmbedBuilder()
        .setTitle('👤 Member limits')
        .setColor(s.blocked ? COLORS.locked : COLORS.primary)
        .setDescription(`Member: <@${userId}>${name ? ` (${name})` : ''}\nChannel: <#${channelId}>`)
        .addFields(
            { name: 'Used today', value: isUnlimited(s.limit) ? '∞ (maximized)' : `**${s.used}/${s.limit}** ${progressBar(s.used, s.limit)}`, inline: false },
            { name: 'Per-user override', value: s.hasOverride ? (isUnlimited(s.limit) ? '∞ maximized' : `**${s.limit}**`) : '*none (uses channel default)*', inline: true },
            { name: 'Cooldown', value: s.cooldownMs <= 0 ? 'off' : (s.cooldownEndsAt ? `next ${tsR(s.cooldownEndsAt)}` : 'ready'), inline: true },
            { name: 'Daily reset', value: s.resetAt ? tsR(s.resetAt) : 'not started', inline: true },
            { name: 'Blocked', value: s.blocked ? '🚫 yes' : 'no', inline: true },
            { name: 'Last post', value: s.lastSubmission ? tsR(s.lastSubmission) : 'never', inline: true },
        )
        .setTimestamp();

    const rows = [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`u_setlimit:${channelId}:${userId}`).setLabel('Set Custom Limit').setEmoji('✏️').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`u_maximize:${channelId}:${userId}`).setLabel('Maximize').setEmoji('♾️').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`u_clearoverride:${channelId}:${userId}`).setLabel('Clear Override').setEmoji('↩️').setStyle(ButtonStyle.Secondary).setDisabled(!s.hasOverride),
            new ButtonBuilder().setCustomId(`u_resetusage:${channelId}:${userId}`).setLabel('Reset Usage').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`u_toggleblock:${channelId}:${userId}`).setLabel(s.blocked ? 'Unblock' : 'Block').setEmoji(s.blocked ? '✅' : '🚫').setStyle(s.blocked ? ButtonStyle.Success : ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`ch_refresh:${channelId}`).setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
        ),
    ];
    return { embed, rows };
}

// ── Shared send helpers (always suppress mentions so member lists never ping) ──
const NO_PING = { parse: [] };

async function showView(interaction, view) {
    await interaction.update({ embeds: [view.embed], components: view.rows, allowedMentions: NO_PING });
}
async function replyView(interaction, view) {
    await interaction.reply({ embeds: [view.embed], components: view.rows, ephemeral: true, allowedMentions: NO_PING });
}
// After a modal submit (triggered from a message component) edit the source message.
async function updateFromModal(interaction, view) {
    if (interaction.isFromMessage()) {
        await interaction.update({ embeds: [view.embed], components: view.rows, allowedMentions: NO_PING });
    } else {
        await interaction.reply({ embeds: [view.embed], components: view.rows, ephemeral: true, allowedMentions: NO_PING });
    }
}

function isChannelTracked(guildId, channelId) {
    const set = trackedChannels.get(guildId);
    return !!set && set.has(channelId);
}

// A modal with a single text field
function numberModal(customId, title, label, placeholder, value) {
    return new ModalBuilder().setCustomId(customId).setTitle(title).addComponents(
        new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('value')
                .setLabel(label)
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setPlaceholder(placeholder)
                .setValue(value != null ? String(value) : '')
        )
    );
}

client.on('messageCreate', handleMessage);

// ═══════════════════════════════════════════════════
//  Slash command registration
// ═══════════════════════════════════════════════════
client.on('ready', async () => {
    console.log(`Bot is ready! Logged in as ${client.user.tag}`);

    const adminOpt = b => b.setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

    const commands = [
        adminOpt(new SlashCommandBuilder()
            .setName('setup')
            .setDescription('Configure everything in one command (all options optional)')
            .addChannelOption(o => o.setName('channel').setDescription('Channel to track').setRequired(false))
            .addIntegerOption(o => o.setName('limit').setDescription('Max memes per window (default 5)').setRequired(false).setMinValue(0))
            .addStringOption(o => o.setName('cooldown').setDescription('Time between memes, e.g. 1h, 30m, or "off" (default 1h)').setRequired(false))
            .addStringOption(o => o.setName('resettime').setDescription('Daily window, e.g. 24h, 12h (default 24h)').setRequired(false))
            .addStringOption(o => o.setName('roles').setDescription('Allowed role IDs (space-separated) or "clear"').setRequired(false))
            .addUserOption(o => o.setName('blockuser').setDescription('Block a user').setRequired(false))
            .addUserOption(o => o.setName('unblockuser').setDescription('Unblock a user').setRequired(false))
            .addStringOption(o => o.setName('lockdown').setDescription('"on", "off", or a duration like 24h').setRequired(false))
            .addStringOption(o => o.setName('warn').setDescription('DM members when their post is removed: "on" or "off"').setRequired(false))),

        adminOpt(new SlashCommandBuilder()
            .setName('addchannel')
            .setDescription('Add a channel to track')
            .addChannelOption(o => o.setName('channel').setDescription('Channel to track').setRequired(true))
            .addIntegerOption(o => o.setName('limit').setDescription('Max memes per window').setRequired(false).setMinValue(0))
            .addStringOption(o => o.setName('cooldown').setDescription('Time between memes, e.g. 1h or "off"').setRequired(false))
            .addStringOption(o => o.setName('resettime').setDescription('Daily window, e.g. 24h').setRequired(false))),

        adminOpt(new SlashCommandBuilder()
            .setName('removechannel')
            .setDescription('Remove a channel from tracking')
            .addChannelOption(o => o.setName('channel').setDescription('Channel to remove').setRequired(true))),

        adminOpt(new SlashCommandBuilder().setName('listchannels').setDescription('List all tracked channels')),

        adminOpt(new SlashCommandBuilder()
            .setName('channeldashboard')
            .setDescription('Open the control panel for a specific channel')
            .addChannelOption(o => o.setName('channel').setDescription('Channel to view').setRequired(true))),

        adminOpt(new SlashCommandBuilder()
            .setName('setlimit')
            .setDescription('Set max memes per window')
            .addIntegerOption(o => o.setName('limit').setDescription('Number of memes').setRequired(true).setMinValue(0))
            .addChannelOption(o => o.setName('channel').setDescription('Specific channel (else all)').setRequired(false))),

        adminOpt(new SlashCommandBuilder()
            .setName('setcooldown')
            .setDescription('Set the cooldown between submissions')
            .addStringOption(o => o.setName('time').setDescription('e.g. 1h, 30m, or "off"').setRequired(true))
            .addChannelOption(o => o.setName('channel').setDescription('Specific channel (else all)').setRequired(false))),

        adminOpt(new SlashCommandBuilder()
            .setName('setresettime')
            .setDescription('Set how long until message counts reset')
            .addStringOption(o => o.setName('time').setDescription('e.g. 24h, 3d, 1d12h').setRequired(true))
            .addChannelOption(o => o.setName('channel').setDescription('Specific channel (else all)').setRequired(false))),

        adminOpt(new SlashCommandBuilder()
            .setName('setwarn')
            .setDescription('DM members when their post is removed (on/off)')
            .addStringOption(o => o.setName('state').setDescription('on or off').setRequired(true)
                .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }))
            .addChannelOption(o => o.setName('channel').setDescription('Specific channel (else all)').setRequired(false))),

        adminOpt(new SlashCommandBuilder()
            .setName('setuserlimit')
            .setDescription('Override the daily limit for one member')
            .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))
            .addIntegerOption(o => o.setName('limit').setDescription('Custom limit (use a huge number to maximize)').setRequired(true).setMinValue(0))
            .addChannelOption(o => o.setName('channel').setDescription('Specific channel (else all)').setRequired(false))),

        adminOpt(new SlashCommandBuilder()
            .setName('blockuser')
            .setDescription('Block a user from sending messages')
            .addUserOption(o => o.setName('user').setDescription('User to block').setRequired(true))
            .addChannelOption(o => o.setName('channel').setDescription('Specific channel (else all)').setRequired(false))),

        adminOpt(new SlashCommandBuilder()
            .setName('unblockuser')
            .setDescription('Unblock a user')
            .addUserOption(o => o.setName('user').setDescription('User to unblock').setRequired(true))
            .addChannelOption(o => o.setName('channel').setDescription('Specific channel (else all)').setRequired(false))),

        adminOpt(new SlashCommandBuilder()
            .setName('setroles')
            .setDescription('Set roles that can type')
            .addStringOption(o => o.setName('roles').setDescription('Role IDs separated by space').setRequired(true))
            .addChannelOption(o => o.setName('channel').setDescription('Specific channel (else all)').setRequired(false))),

        adminOpt(new SlashCommandBuilder()
            .setName('clearroles')
            .setDescription('Remove role restriction - allow everyone')
            .addChannelOption(o => o.setName('channel').setDescription('Specific channel (else all)').setRequired(false))),

        new SlashCommandBuilder()
            .setName('info')
            .setDescription('Check your meme limit for the day')
            .addChannelOption(o => o.setName('channel').setDescription('Specific channel (optional)').setRequired(false)),

        adminOpt(new SlashCommandBuilder()
            .setName('checkuser')
            .setDescription("Look up a member's limit status (no ping)")
            .addUserOption(o => o.setName('user').setDescription('Member to look up').setRequired(true))
            .addChannelOption(o => o.setName('channel').setDescription('Specific channel (optional)').setRequired(false))),

        adminOpt(new SlashCommandBuilder()
            .setName('reset')
            .setDescription("Reset a member's daily count")
            .addUserOption(o => o.setName('user').setDescription('User to reset').setRequired(true))
            .addChannelOption(o => o.setName('channel').setDescription('Specific channel (else all)').setRequired(false))),

        adminOpt(new SlashCommandBuilder().setName('dashboard').setDescription('Open the control center')),

        adminOpt(new SlashCommandBuilder()
            .setName('lockdown')
            .setDescription('Block all conversation in a channel')
            .addChannelOption(o => o.setName('channel').setDescription('Channel to lock').setRequired(true))
            .addStringOption(o => o.setName('duration').setDescription('e.g. 24h, 3d (empty = forever)').setRequired(false))),

        adminOpt(new SlashCommandBuilder()
            .setName('unlock')
            .setDescription('Remove the lockdown from a channel')
            .addChannelOption(o => o.setName('channel').setDescription('Channel to unlock').setRequired(true))),

        adminOpt(new SlashCommandBuilder().setName('help').setDescription('Show all commands and how the bot works')),
    ];

    try {
        await client.application.commands.set(commands);
        console.log('Commands registered');
    } catch (err) {
        console.error('Failed:', err);
    }
});

// ═══════════════════════════════════════════════════
//  Interaction routing
// ═══════════════════════════════════════════════════
client.on('interactionCreate', async (interaction) => {
    try {
        if (interaction.isChatInputCommand()) return await handleCommand(interaction);
        if (interaction.isButton()) return await handleButton(interaction);
        if (interaction.isStringSelectMenu()) return await handleStringSelect(interaction);
        if (interaction.isUserSelectMenu()) return await handleUserSelect(interaction);
        if (interaction.isChannelSelectMenu()) return await handleChannelSelect(interaction);
        if (interaction.isModalSubmit()) return await handleModal(interaction);
    } catch (err) {
        console.error('Interaction error:', err);
        // Best-effort error surface; ignore if the interaction was already answered
        const msg = { content: '⚠️ Something went wrong handling that action.', ephemeral: true };
        if (interaction.isRepliable()) {
            if (interaction.replied || interaction.deferred) interaction.followUp(msg).catch(() => {});
            else interaction.reply(msg).catch(() => {});
        }
    }
});

async function requireAdmin(interaction) {
    const member = interaction.member || await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    if (await isAdmin(member)) return true;
    await interaction.reply({ content: '❌ Admin only', ephemeral: true });
    return false;
}

// ── Buttons ──
async function handleButton(interaction) {
    const guildId = interaction.guildId;
    if (!guildId) return;
    const [action, channelId, extra] = interaction.customId.split(':');

    // Everything below is admin-only.
    if (!await requireAdmin(interaction)) return;

    switch (action) {
        case 'main_refresh':
            return showView(interaction, buildMainDashboard(interaction.guild));

        case 'main_addchannel': {
            const row = new ActionRowBuilder().addComponents(
                new ChannelSelectMenuBuilder()
                    .setCustomId('main_addchannel_select')
                    .setPlaceholder('Pick a channel to start tracking…')
                    .addChannelTypes(ChannelType.GuildText)
            );
            const back = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('main_refresh').setLabel('Cancel').setEmoji('✖️').setStyle(ButtonStyle.Secondary)
            );
            const embed = new EmbedBuilder().setTitle('➕ Add a channel').setColor(COLORS.primary)
                .setDescription('Select a text channel below to start tracking it with default settings (limit 5, cooldown 1h).');
            return interaction.update({ embeds: [embed], components: [row, back] });
        }

        case 'main_removechannel': {
            const channels = Array.from(trackedChannels.get(guildId) || new Set());
            if (!channels.length) return showView(interaction, buildMainDashboard(interaction.guild));
            const row = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder().setCustomId('main_removechannel_select').setPlaceholder('Pick a channel to stop tracking…')
                    .addOptions(channels.slice(0, 25).map(cid => ({ label: `#${channelName(interaction.guild, cid)}`.slice(0, 100), value: cid })))
            );
            const back = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('main_refresh').setLabel('Cancel').setEmoji('✖️').setStyle(ButtonStyle.Secondary)
            );
            const embed = new EmbedBuilder().setTitle('➖ Remove a channel').setColor(COLORS.locked)
                .setDescription('Select a channel to stop tracking. Its settings, counts and stats will be cleared.');
            return interaction.update({ embeds: [embed], components: [row, back] });
        }
    }

    // Channel-scoped actions need a tracked channel
    if (action.startsWith('ch_') || action.startsWith('u_')) {
        if (!isChannelTracked(guildId, channelId)) {
            return interaction.reply({ content: '⚠️ That channel is no longer tracked. Reopen the dashboard.', ephemeral: true });
        }
    }

    switch (action) {
        case 'ch_refresh':
            return showView(interaction, buildChannelDashboard(channelId, interaction.guild));
        case 'ch_recent':
            return showView(interaction, buildRecentList(channelId, interaction.guild));
        case 'ch_fulllist':
            return showView(interaction, buildFullList(channelId, interaction.guild, parseInt(extra, 10) || 0));

        case 'ch_setlimit':
            return interaction.showModal(numberModal(`ch_setlimit_modal:${channelId}`, 'Set daily limit',
                'Max memes per window (0-1000000)', 'e.g. 5', isUnlimited(getLimit(channelId)) ? '' : getLimit(channelId)));
        case 'ch_setcooldown':
            return interaction.showModal(numberModal(`ch_setcooldown_modal:${channelId}`, 'Set cooldown',
                'Time between memes (e.g. 1h, 30m, off)', 'e.g. 1h', getCooldown(channelId) > 0 ? formatDuration(getCooldown(channelId)) : 'off'));
        case 'ch_setreset':
            return interaction.showModal(numberModal(`ch_setreset_modal:${channelId}`, 'Set reset window',
                'How long until counts reset (e.g. 24h)', 'e.g. 24h', formatDuration(getResetWindow(channelId))));

        case 'ch_togglelock': {
            const lock = lockedChannels.get(channelId);
            if (lock) {
                lockedChannels.delete(channelId);
                clearChannelCounts(channelId);
            } else {
                lockedChannels.set(channelId, { lockedAt: Date.now(), expiresAt: null });
            }
            saveData();
            return showView(interaction, buildChannelDashboard(channelId, interaction.guild));
        }
        case 'ch_resetcounts':
            clearChannelCounts(channelId);
            saveData();
            return showView(interaction, buildChannelDashboard(channelId, interaction.guild));
        case 'ch_resetstats':
            totalMessagesTracked.set(channelId, 0);
            totalMessagesDeleted.set(channelId, 0);
            saveData();
            return showView(interaction, buildChannelDashboard(channelId, interaction.guild));
        case 'ch_unblockall':
            for (const key of blockedUsers.keys()) if (key.startsWith(channelId + ':')) blockedUsers.delete(key);
            saveData();
            return showView(interaction, buildChannelDashboard(channelId, interaction.guild));
        case 'ch_clearroles':
            allowedRoles.delete(channelId);
            saveData();
            return showView(interaction, buildChannelDashboard(channelId, interaction.guild));
        case 'ch_togglewarn':
            if (warnOnDelete.get(channelId)) warnOnDelete.delete(channelId);
            else warnOnDelete.set(channelId, true);
            saveData();
            return showView(interaction, buildChannelDashboard(channelId, interaction.guild));

        case 'ch_manageuser': {
            const row = new ActionRowBuilder().addComponents(
                new UserSelectMenuBuilder().setCustomId(`ch_userselect:${channelId}`).setPlaceholder('Pick a member to look up / manage…').setMinValues(1).setMaxValues(1)
            );
            const back = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`ch_refresh:${channelId}`).setLabel('Cancel').setEmoji('✖️').setStyle(ButtonStyle.Secondary)
            );
            const embed = new EmbedBuilder().setTitle('👤 Manage / look up a member').setColor(COLORS.primary)
                .setDescription(`Select any member to see their limits in <#${channelId}> and adjust them. Selecting a member does **not** ping them.`);
            return interaction.update({ embeds: [embed], components: [row, back] });
        }

        // Per-user actions
        case 'u_setlimit':
            return interaction.showModal(numberModal(`u_setlimit_modal:${channelId}:${extra}`, 'Set custom limit',
                'Daily limit for this member (0-1000000)', 'e.g. 10', isUnlimited(getEffectiveLimit(channelId, extra)) ? '' : getEffectiveLimit(channelId, extra)));
        case 'u_maximize':
            userLimits.set(getChannelUserKey(channelId, extra), MAX_LIMIT);
            saveData();
            return showView(interaction, buildUserPanel(channelId, extra, interaction.guild));
        case 'u_clearoverride':
            userLimits.delete(getChannelUserKey(channelId, extra));
            saveData();
            return showView(interaction, buildUserPanel(channelId, extra, interaction.guild));
        case 'u_resetusage':
            messageCounts.delete(getChannelUserKey(channelId, extra));
            saveData();
            return showView(interaction, buildUserPanel(channelId, extra, interaction.guild));
        case 'u_toggleblock': {
            const key = getChannelUserKey(channelId, extra);
            if (blockedUsers.has(key)) blockedUsers.delete(key);
            else blockedUsers.set(key, true);
            saveData();
            return showView(interaction, buildUserPanel(channelId, extra, interaction.guild));
        }
    }
}

// ── String select menus ──
async function handleStringSelect(interaction) {
    if (!interaction.guildId) return;
    if (!await requireAdmin(interaction)) return;
    const [action] = interaction.customId.split(':');
    const value = interaction.values[0];

    if (action === 'main_selectchannel') {
        if (!isChannelTracked(interaction.guildId, value)) return showView(interaction, buildMainDashboard(interaction.guild));
        return showView(interaction, buildChannelDashboard(value, interaction.guild));
    }
    if (action === 'main_removechannel_select') {
        removeChannel(interaction.guildId, value);
        saveData();
        return showView(interaction, buildMainDashboard(interaction.guild));
    }
}

// ── User select menu (manage member) ──
async function handleUserSelect(interaction) {
    if (!interaction.guildId) return;
    if (!await requireAdmin(interaction)) return;
    const [action, channelId] = interaction.customId.split(':');
    if (action === 'ch_userselect') {
        if (!isChannelTracked(interaction.guildId, channelId)) return showView(interaction, buildMainDashboard(interaction.guild));
        return showView(interaction, buildUserPanel(channelId, interaction.values[0], interaction.guild));
    }
}

// ── Channel select menu (add channel) ──
async function handleChannelSelect(interaction) {
    if (!interaction.guildId) return;
    if (!await requireAdmin(interaction)) return;
    const [action] = interaction.customId.split(':');
    if (action === 'main_addchannel_select') {
        const cid = interaction.values[0];
        if (!trackedChannels.has(interaction.guildId)) trackedChannels.set(interaction.guildId, new Set());
        trackedChannels.get(interaction.guildId).add(cid);
        saveData();
        return showView(interaction, buildChannelDashboard(cid, interaction.guild));
    }
}

// ── Modal submissions ──
async function handleModal(interaction) {
    if (!interaction.guildId) return;
    if (!await requireAdmin(interaction)) return;
    const [action, channelId, userId] = interaction.customId.split(':');
    const raw = interaction.fields.getTextInputValue('value').trim();

    if (action === 'ch_setlimit_modal' || action === 'u_setlimit_modal') {
        if (!/^\d+$/.test(raw)) return interaction.reply({ content: '❌ Enter a whole number (0 or higher).', ephemeral: true });
        const n = Math.min(parseInt(raw, 10), MAX_LIMIT);
        if (action === 'ch_setlimit_modal') {
            rateLimit.set(channelId, n);
            clearChannelCounts(channelId);
            saveData();
            return updateFromModal(interaction, buildChannelDashboard(channelId, interaction.guild));
        }
        userLimits.set(getChannelUserKey(channelId, userId), n);
        saveData();
        return updateFromModal(interaction, buildUserPanel(channelId, userId, interaction.guild));
    }

    if (action === 'ch_setcooldown_modal') {
        const ms = parseCooldownInput(raw);
        if (ms === null) return interaction.reply({ content: '❌ Invalid. Use e.g. `1h`, `30m`, `90m`, or `off`.', ephemeral: true });
        cooldown.set(channelId, ms);
        saveData();
        return updateFromModal(interaction, buildChannelDashboard(channelId, interaction.guild));
    }

    if (action === 'ch_setreset_modal') {
        const ms = parseDuration(raw);
        if (!ms) return interaction.reply({ content: '❌ Invalid. Use e.g. `24h`, `12h`, `3d`, `1d12h`.', ephemeral: true });
        resetTime.set(channelId, ms);
        clearChannelCounts(channelId);
        saveData();
        return updateFromModal(interaction, buildChannelDashboard(channelId, interaction.guild));
    }
}

function removeChannel(guildId, channelId) {
    const channels = trackedChannels.get(guildId);
    if (channels) channels.delete(channelId);
    clearChannelCounts(channelId);
    rateLimit.delete(channelId);
    cooldown.delete(channelId);
    resetTime.delete(channelId);
    allowedRoles.delete(channelId);
    lockedChannels.delete(channelId);
    warnOnDelete.delete(channelId);
    totalMessagesTracked.delete(channelId);
    totalMessagesDeleted.delete(channelId);
    for (const key of userLimits.keys()) if (key.startsWith(channelId + ':')) userLimits.delete(key);
    for (const key of blockedUsers.keys()) if (key.startsWith(channelId + ':')) blockedUsers.delete(key);
}

// ═══════════════════════════════════════════════════
//  Slash command handlers
// ═══════════════════════════════════════════════════
function eachTrackedChannel(guildId, fn) {
    const channels = trackedChannels.get(guildId) || new Set();
    channels.forEach(fn);
    return channels.size;
}

async function handleCommand(interaction) {
    const guildId = interaction.guildId;
    if (!guildId) return interaction.reply({ content: '❌ This command only works in a server.', ephemeral: true });

    const userId = interaction.user.id;
    const member = interaction.member || await interaction.guild.members.fetch(userId).catch(() => null);
    const admin = await isAdmin(member);
    const name = interaction.commandName;

    // ── /info (everyone) ──
    if (name === 'info') {
        let cid = interaction.options.getChannel('channel')?.id;
        if (!cid) {
            // default to the channel the command was used in, if it's tracked
            if (isChannelTracked(guildId, interaction.channelId)) cid = interaction.channelId;
            else {
                const set = trackedChannels.get(guildId) || new Set();
                if (set.size) cid = [...set][0];
            }
        }
        if (!cid) return interaction.reply({ content: 'No channels are being tracked yet.', ephemeral: true });
        const embed = new EmbedBuilder()
            .setTitle('🪪 Your meme limit')
            .setColor(COLORS.primary)
            .setDescription(`Channel: <#${cid}>\n\n${userStatusText(cid, userId, { selfView: true })}`)
            .setTimestamp();
        return interaction.reply({ embeds: [embed], ephemeral: true, allowedMentions: NO_PING });
    }

    // Everything else is admin-only
    if (!admin) return interaction.reply({ content: '❌ Admin only', ephemeral: true });

    if (name === 'dashboard') return replyView(interaction, buildMainDashboard(interaction.guild));

    if (name === 'channeldashboard') {
        const cid = interaction.options.getChannel('channel').id;
        if (!isChannelTracked(guildId, cid)) return interaction.reply({ content: '❌ That channel is not being tracked.', ephemeral: true });
        return replyView(interaction, buildChannelDashboard(cid, interaction.guild));
    }

    if (name === 'checkuser') {
        const target = interaction.options.getUser('user');
        let cid = interaction.options.getChannel('channel')?.id;
        if (!cid) {
            if (isChannelTracked(guildId, interaction.channelId)) cid = interaction.channelId;
            else { const set = trackedChannels.get(guildId) || new Set(); if (set.size) cid = [...set][0]; }
        }
        if (!cid) return interaction.reply({ content: 'No channels are being tracked yet.', ephemeral: true });
        const embed = new EmbedBuilder()
            .setTitle('🔎 Member lookup')
            .setColor(COLORS.primary)
            .setDescription(`Channel: <#${cid}>\n\n${userStatusText(cid, target.id)}`)
            .setTimestamp();
        return interaction.reply({ embeds: [embed], ephemeral: true, allowedMentions: NO_PING });
    }

    if (name === 'setup') {
        const results = [];
        let countsTouched = false;

        const channel = interaction.options.getChannel('channel');
        if (channel) {
            if (!trackedChannels.has(guildId)) trackedChannels.set(guildId, new Set());
            trackedChannels.get(guildId).add(channel.id);
            results.push(`📌 Tracking <#${channel.id}>`);
        }

        const limit = interaction.options.getInteger('limit');
        if (limit !== null) {
            eachTrackedChannel(guildId, cid => rateLimit.set(cid, Math.min(limit, MAX_LIMIT)));
            results.push(`📊 Limit → **${limit}** (all channels)`);
            countsTouched = true;
        }

        const cdStr = interaction.options.getString('cooldown');
        if (cdStr) {
            const ms = parseCooldownInput(cdStr);
            if (ms === null) results.push(`⚠️ Invalid cooldown "${cdStr}"`);
            else { eachTrackedChannel(guildId, cid => cooldown.set(cid, ms)); results.push(`🕒 Cooldown → **${ms > 0 ? formatDuration(ms) : 'off'}** (all channels)`); }
        }

        const resetStr = interaction.options.getString('resettime');
        if (resetStr) {
            const ms = parseDuration(resetStr);
            if (!ms) results.push(`⚠️ Invalid reset time "${resetStr}"`);
            else { eachTrackedChannel(guildId, cid => resetTime.set(cid, ms)); results.push(`⏱️ Window → **${formatDuration(ms)}** (all channels)`); countsTouched = true; }
        }

        if (countsTouched) clearGuildCounts(guildId);

        const rolesStr = interaction.options.getString('roles');
        if (rolesStr) {
            if (rolesStr.toLowerCase() === 'clear') {
                eachTrackedChannel(guildId, cid => allowedRoles.delete(cid));
                results.push('🔓 Role restriction removed');
            } else {
                const ids = rolesStr.trim().split(/\s+/).filter(Boolean);
                eachTrackedChannel(guildId, cid => allowedRoles.set(cid, ids));
                results.push(`🎭 Roles → ${ids.map(r => `<@&${r}>`).join(' ')}`);
            }
        }

        const blockT = interaction.options.getUser('blockuser');
        if (blockT) { eachTrackedChannel(guildId, cid => blockedUsers.set(getChannelUserKey(cid, blockT.id), true)); results.push(`🚫 Blocked <@${blockT.id}>`); }
        const unblockT = interaction.options.getUser('unblockuser');
        if (unblockT) { eachTrackedChannel(guildId, cid => blockedUsers.delete(getChannelUserKey(cid, unblockT.id))); results.push(`✅ Unblocked <@${unblockT.id}>`); }

        const lockStr = interaction.options.getString('lockdown');
        if (lockStr) {
            const lower = lockStr.toLowerCase().trim();
            if (['off', 'no', 'false'].includes(lower)) {
                eachTrackedChannel(guildId, cid => { lockedChannels.delete(cid); clearChannelCounts(cid); });
                results.push('🔓 Lockdown removed (all channels)');
            } else if (['on', 'yes', 'true'].includes(lower)) {
                eachTrackedChannel(guildId, cid => lockedChannels.set(cid, { lockedAt: Date.now(), expiresAt: null }));
                results.push('🔒 All channels locked');
            } else {
                const dur = parseDuration(lower);
                if (!dur) results.push(`⚠️ Invalid lockdown "${lockStr}"`);
                else {
                    eachTrackedChannel(guildId, cid => {
                        const data = { lockedAt: Date.now(), expiresAt: Date.now() + dur };
                        lockedChannels.set(cid, data);
                        scheduleUnlock(cid, data);
                    });
                    results.push(`🔒 All channels locked for **${formatDuration(dur)}**`);
                }
            }
        }

        const warnStr = interaction.options.getString('warn');
        if (warnStr) {
            const lower = warnStr.toLowerCase().trim();
            if (['on', 'yes', 'true'].includes(lower)) { eachTrackedChannel(guildId, cid => warnOnDelete.set(cid, true)); results.push('🔔 Delete warnings on (all channels)'); }
            else if (['off', 'no', 'false'].includes(lower)) { eachTrackedChannel(guildId, cid => warnOnDelete.delete(cid)); results.push('🔕 Delete warnings off (all channels)'); }
            else results.push(`⚠️ Invalid warn "${warnStr}"`);
        }

        if (!results.length) return interaction.reply({ content: 'ℹ️ No options provided.', ephemeral: true });
        saveData();
        return interaction.reply({ content: `**Setup updated:**\n${results.join('\n')}`, ephemeral: true, allowedMentions: NO_PING });
    }

    if (name === 'addchannel') {
        const channel = interaction.options.getChannel('channel');
        if (!trackedChannels.has(guildId)) trackedChannels.set(guildId, new Set());
        trackedChannels.get(guildId).add(channel.id);
        const limit = interaction.options.getInteger('limit');
        if (limit !== null) rateLimit.set(channel.id, Math.min(limit, MAX_LIMIT));
        const cdStr = interaction.options.getString('cooldown');
        if (cdStr) { const ms = parseCooldownInput(cdStr); if (ms !== null) cooldown.set(channel.id, ms); }
        const resetStr = interaction.options.getString('resettime');
        if (resetStr) { const ms = parseDuration(resetStr); if (ms) resetTime.set(channel.id, ms); }
        saveData();
        return interaction.reply({
            content: `✅ Now tracking <#${channel.id}>\n📊 Limit **${isUnlimited(getLimit(channel.id)) ? '∞' : getLimit(channel.id)}** · 🕒 Cooldown **${getCooldown(channel.id) > 0 ? formatDuration(getCooldown(channel.id)) : 'off'}** · ⏱️ Window **${formatDuration(getResetWindow(channel.id))}**`,
            ephemeral: true,
        });
    }

    if (name === 'removechannel') {
        const channel = interaction.options.getChannel('channel');
        if (!isChannelTracked(guildId, channel.id)) return interaction.reply({ content: '❌ Channel is not being tracked', ephemeral: true });
        removeChannel(guildId, channel.id);
        saveData();
        return interaction.reply({ content: `✅ Stopped tracking <#${channel.id}>`, ephemeral: true });
    }

    if (name === 'listchannels') {
        const channels = trackedChannels.get(guildId) || new Set();
        if (!channels.size) return interaction.reply({ content: '❌ No channels are being tracked', ephemeral: true });
        const msg = [...channels].map(cid =>
            `• <#${cid}> — limit **${isUnlimited(getLimit(cid)) ? '∞' : getLimit(cid)}**, cooldown **${getCooldown(cid) > 0 ? formatDuration(getCooldown(cid)) : 'off'}**, window **${formatDuration(getResetWindow(cid))}**`
        ).join('\n');
        return interaction.reply({ content: `📌 **Tracked channels:**\n${msg}`, ephemeral: true });
    }

    if (name === 'setlimit') {
        const limit = Math.min(interaction.options.getInteger('limit'), MAX_LIMIT);
        const channel = interaction.options.getChannel('channel');
        if (channel) { rateLimit.set(channel.id, limit); clearChannelCounts(channel.id); saveData(); return interaction.reply({ content: `✅ Limit for <#${channel.id}> → **${limit}** (counts reset)`, ephemeral: true }); }
        eachTrackedChannel(guildId, cid => rateLimit.set(cid, limit));
        clearGuildCounts(guildId); saveData();
        return interaction.reply({ content: `✅ Limit → **${limit}** for all channels (counts reset)`, ephemeral: true });
    }

    if (name === 'setcooldown') {
        const ms = parseCooldownInput(interaction.options.getString('time'));
        if (ms === null) return interaction.reply({ content: '❌ Invalid. Use e.g. `1h`, `30m`, or `off`.', ephemeral: true });
        const channel = interaction.options.getChannel('channel');
        if (channel) { cooldown.set(channel.id, ms); saveData(); return interaction.reply({ content: `✅ Cooldown for <#${channel.id}> → **${ms > 0 ? formatDuration(ms) : 'off'}**`, ephemeral: true }); }
        eachTrackedChannel(guildId, cid => cooldown.set(cid, ms)); saveData();
        return interaction.reply({ content: `✅ Cooldown → **${ms > 0 ? formatDuration(ms) : 'off'}** for all channels`, ephemeral: true });
    }

    if (name === 'setresettime') {
        const ms = parseDuration(interaction.options.getString('time'));
        if (!ms) return interaction.reply({ content: '❌ Invalid format. Use e.g. `24h`, `3d`, `1d12h`.', ephemeral: true });
        const channel = interaction.options.getChannel('channel');
        if (channel) { resetTime.set(channel.id, ms); clearChannelCounts(channel.id); saveData(); return interaction.reply({ content: `✅ Window for <#${channel.id}> → **${formatDuration(ms)}** (counts reset)`, ephemeral: true }); }
        eachTrackedChannel(guildId, cid => resetTime.set(cid, ms));
        clearGuildCounts(guildId); saveData();
        return interaction.reply({ content: `✅ Window → **${formatDuration(ms)}** for all channels (counts reset)`, ephemeral: true });
    }

    if (name === 'setwarn') {
        const on = interaction.options.getString('state') === 'on';
        const channel = interaction.options.getChannel('channel');
        const apply = cid => on ? warnOnDelete.set(cid, true) : warnOnDelete.delete(cid);
        if (channel) { apply(channel.id); saveData(); return interaction.reply({ content: `✅ Delete warnings for <#${channel.id}> → **${on ? 'on' : 'off'}**`, ephemeral: true }); }
        eachTrackedChannel(guildId, apply); saveData();
        return interaction.reply({ content: `✅ Delete warnings → **${on ? 'on' : 'off'}** for all channels`, ephemeral: true });
    }

    if (name === 'setuserlimit') {
        const target = interaction.options.getUser('user');
        const limit = Math.min(interaction.options.getInteger('limit'), MAX_LIMIT);
        const channel = interaction.options.getChannel('channel');
        const note = isUnlimited(limit) ? '∞ (maximized)' : `**${limit}**`;
        if (channel) { userLimits.set(getChannelUserKey(channel.id, target.id), limit); saveData(); return interaction.reply({ content: `✅ <@${target.id}> limit in <#${channel.id}> → ${note}`, ephemeral: true, allowedMentions: NO_PING }); }
        eachTrackedChannel(guildId, cid => userLimits.set(getChannelUserKey(cid, target.id), limit)); saveData();
        return interaction.reply({ content: `✅ <@${target.id}> limit → ${note} in all channels`, ephemeral: true, allowedMentions: NO_PING });
    }

    if (name === 'blockuser' || name === 'unblockuser') {
        const target = interaction.options.getUser('user');
        const channel = interaction.options.getChannel('channel');
        const block = name === 'blockuser';
        const apply = cid => block ? blockedUsers.set(getChannelUserKey(cid, target.id), true) : blockedUsers.delete(getChannelUserKey(cid, target.id));
        const verb = block ? 'Blocked' : 'Unblocked';
        if (channel) { apply(channel.id); saveData(); return interaction.reply({ content: `✅ ${verb} <@${target.id}> in <#${channel.id}>`, ephemeral: true, allowedMentions: NO_PING }); }
        eachTrackedChannel(guildId, apply); saveData();
        return interaction.reply({ content: `✅ ${verb} <@${target.id}> in all channels`, ephemeral: true, allowedMentions: NO_PING });
    }

    if (name === 'setroles') {
        const ids = interaction.options.getString('roles').trim().split(/\s+/).filter(Boolean);
        const channel = interaction.options.getChannel('channel');
        const note = ids.length ? `Only ${ids.map(r => `<@&${r}>`).join(' ')} can type` : 'No role restriction - everyone can type';
        if (channel) { allowedRoles.set(channel.id, ids); saveData(); return interaction.reply({ content: `✅ <#${channel.id}>: ${note}`, ephemeral: true }); }
        eachTrackedChannel(guildId, cid => allowedRoles.set(cid, ids)); saveData();
        return interaction.reply({ content: `✅ All channels: ${note}`, ephemeral: true });
    }

    if (name === 'clearroles') {
        const channel = interaction.options.getChannel('channel');
        if (channel) { allowedRoles.delete(channel.id); saveData(); return interaction.reply({ content: `✅ Role restriction removed for <#${channel.id}>`, ephemeral: true }); }
        eachTrackedChannel(guildId, cid => allowedRoles.delete(cid)); saveData();
        return interaction.reply({ content: '✅ Role restriction removed for all channels', ephemeral: true });
    }

    if (name === 'reset') {
        const target = interaction.options.getUser('user');
        const channel = interaction.options.getChannel('channel');
        if (channel) { messageCounts.delete(getChannelUserKey(channel.id, target.id)); saveData(); return interaction.reply({ content: `✅ Reset <@${target.id}> in <#${channel.id}>`, ephemeral: true, allowedMentions: NO_PING }); }
        eachTrackedChannel(guildId, cid => messageCounts.delete(getChannelUserKey(cid, target.id))); saveData();
        return interaction.reply({ content: `✅ Reset <@${target.id}> in all channels`, ephemeral: true, allowedMentions: NO_PING });
    }

    if (name === 'lockdown') {
        const channel = interaction.options.getChannel('channel');
        const durMs = parseDuration(interaction.options.getString('duration'));
        const data = { lockedAt: Date.now(), expiresAt: durMs ? Date.now() + durMs : null };
        lockedChannels.set(channel.id, data);
        if (durMs) scheduleUnlock(channel.id, data);
        saveData();
        return interaction.reply({ content: durMs ? `🔒 <#${channel.id}> locked for **${formatDuration(durMs)}**` : `🔒 <#${channel.id}> locked **indefinitely** — use \`/unlock\``, ephemeral: true });
    }

    if (name === 'unlock') {
        const channel = interaction.options.getChannel('channel');
        if (!lockedChannels.has(channel.id)) return interaction.reply({ content: 'ℹ️ That channel is not locked', ephemeral: true });
        lockedChannels.delete(channel.id);
        clearChannelCounts(channel.id);
        saveData();
        return interaction.reply({ content: `🔓 <#${channel.id}> unlocked`, ephemeral: true });
    }

    if (name === 'help') {
        const embed = new EmbedBuilder()
            .setTitle('📚 Meme Guardian — Help')
            .setColor(COLORS.primary)
            .setDescription('Two independent limits guard each channel: a **daily limit** (memes per window) and a **cooldown** (minimum time between memes). Admins bypass everything. Members only see `/info`.')
            .addFields(
                { name: '👤 For members', value: '**/info [channel]** — see your memes used today, what\'s left, your cooldown, and when it resets. Defaults to the channel you run it in.', inline: false },
                { name: '⭐ /setup', value: 'One-shot config (applies to all tracked channels): `channel`, `limit`, `cooldown` (e.g. 1h/off), `resettime`, `roles`, `blockuser`, `unblockuser`, `lockdown`.', inline: false },
                { name: '📌 Channels', value: '**/addchannel** `<channel> [limit] [cooldown] [resettime]` · **/removechannel** `<channel>` · **/listchannels** · **/channeldashboard** `<channel>`', inline: false },
                { name: '⚙️ Limits', value: '**/setlimit** `<n> [channel]` · **/setcooldown** `<time|off> [channel]` · **/setresettime** `<time> [channel]` · **/setuserlimit** `<user> <n> [channel]` (per-member override) · **/setwarn** `<on|off> [channel]` (DM on delete)', inline: false },
                { name: '👥 Members', value: '**/checkuser** `<user> [channel]` (no ping) · **/reset** `<user> [channel]` · **/blockuser** · **/unblockuser**', inline: false },
                { name: '🔒 Lockdown & roles', value: '**/lockdown** `<channel> [duration]` · **/unlock** `<channel>` · **/setroles** · **/clearroles**', inline: false },
                { name: '🎛️ Dashboard', value: '**/dashboard** opens the control center: pick a channel, edit limit/cooldown/window via pop-ups, view **Recent 10** or **Today\'s full list**, and **Manage / Look Up** any member (set a custom limit, maximize, reset, block) without pinging them.', inline: false },
                { name: '📝 Durations', value: '`30m`, `6h`, `24h`, `3d`, `1d12h`, `2d6h30m`. Cooldown also accepts `off`.', inline: false },
            )
            .setTimestamp();
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }
}

// ═══════════════════════════════════════════════════
//  Periodic maintenance — every 30s
// ═══════════════════════════════════════════════════
setInterval(() => {
    const now = Date.now();
    let dirty = false;

    for (const [channelId, lockInfo] of lockedChannels.entries()) {
        if (lockInfo.expiresAt && now >= lockInfo.expiresAt) {
            lockedChannels.delete(channelId);
            clearChannelCounts(channelId);
            dirty = true;
        }
    }

    // Prune stale per-user counters (window AND cooldown both elapsed) so the
    // maps don't grow without bound over a long-running process.
    for (const [key, entry] of messageCounts.entries()) {
        const cid = channelIdFromKey(key);
        const windowMs = getResetWindow(cid);
        const cd = getCooldown(cid);
        if (now - entry.startTime >= windowMs && now - (entry.lastSubmission || 0) >= cd) {
            messageCounts.delete(key);
            dirty = true;
        }
    }

    if (dirty) saveData();
}, 30 * 1000);

function flushAndExit() {
    saveData();
    process.exit(0);
}
process.on('SIGINT', flushAndExit);
process.on('SIGTERM', flushAndExit);

loadData();
client.login(process.env.DISCORD_TOKEN);
