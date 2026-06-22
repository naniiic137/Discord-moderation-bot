require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
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

const trackedChannels = new Map(); // guildId -> Set of channelIds
const messageCounts = new Map();   // channelUserKey -> { startTime, count }
const rateLimit = new Map();       // channelId -> limit
const resetTime = new Map();       // channelId -> ms (default 24h)
const blockedUsers = new Map();    // channelUserKey -> boolean
const allowedRoles = new Map();    // channelId -> array of roleIds
const lockedChannels = new Map();  // channelId -> { lockedAt, expiresAt }

const DEFAULT_LIMIT = 3;
const DEFAULT_RESET_TIME = 24 * 60 * 60 * 1000; // 24 hours in ms
const botStartTime = Date.now();
let totalMessagesDeleted = new Map(); // channelId -> count
let totalMessagesTracked = new Map(); // channelId -> count

function getChannelUserKey(channelId, userId) {
    return `${channelId}:${userId}`;
}

// Clear all message counts for a specific guild (not all guilds)
function clearGuildCounts(guildId) {
    const channels = trackedChannels.get(guildId) || new Set();
    for (const channelId of channels) {
        clearChannelCounts(channelId);
    }
}

// Clear message counts for a specific channel
function clearChannelCounts(channelId) {
    for (const key of messageCounts.keys()) {
        if (key.startsWith(channelId + ':')) {
            messageCounts.delete(key);
        }
    }
}

// ═══════════════════════════════════════════════════
//  Persistent Storage — saves settings to data.json
// ═══════════════════════════════════════════════════
let saveTimer = null;

function saveData() {
    // Cancel any pending throttled write — this immediate write supersedes it
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
            resetTime: Object.fromEntries(resetTime),
            blockedUsers: Object.fromEntries(blockedUsers),
            allowedRoles: Object.fromEntries(allowedRoles),
            lockedChannels: Object.fromEntries(lockedChannels),
            totalMessagesDeleted: Object.fromEntries(totalMessagesDeleted),
            totalMessagesTracked: Object.fromEntries(totalMessagesTracked),
            messageCounts: Object.fromEntries(messageCounts),
        };
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
        console.error('Failed to save data:', err.message);
    }
}

// Coalesce high-frequency writes (per-message count updates) into at most one
// disk write per second so a busy channel never blocks the event loop on every
// message. Config/admin changes still call saveData() directly for durability.
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
        const raw = fs.readFileSync(DATA_FILE, 'utf-8');
        const data = JSON.parse(raw);

        if (data.trackedChannels) {
            for (const [guildId, arr] of Object.entries(data.trackedChannels)) {
                trackedChannels.set(guildId, new Set(arr));
            }
        }
        if (data.rateLimit) {
            for (const [k, v] of Object.entries(data.rateLimit)) rateLimit.set(k, v);
        }
        if (data.resetTime) {
            for (const [k, v] of Object.entries(data.resetTime)) resetTime.set(k, v);
        }
        if (data.blockedUsers) {
            for (const [k, v] of Object.entries(data.blockedUsers)) blockedUsers.set(k, v);
        }
        if (data.allowedRoles) {
            for (const [k, v] of Object.entries(data.allowedRoles)) allowedRoles.set(k, v);
        }
        if (data.lockedChannels) {
            const now = Date.now();
            for (const [channelId, v] of Object.entries(data.lockedChannels)) {
                // Skip expired lockdowns
                if (v.expiresAt && now >= v.expiresAt) continue;
                lockedChannels.set(channelId, v);
                // Re-schedule auto-unlock for timed lockdowns
                if (v.expiresAt) {
                    const remaining = v.expiresAt - now;
                    setTimeout(() => {
                        const current = lockedChannels.get(channelId);
                        if (current && current.lockedAt === v.lockedAt) {
                            lockedChannels.delete(channelId);
                            clearChannelCounts(channelId);
                            saveData();
                        }
                    }, remaining);
                }
            }
        }
        if (data.totalMessagesDeleted) {
            for (const [k, v] of Object.entries(data.totalMessagesDeleted)) totalMessagesDeleted.set(k, v);
        }
        if (data.totalMessagesTracked) {
            for (const [k, v] of Object.entries(data.totalMessagesTracked)) totalMessagesTracked.set(k, v);
        }
        if (data.messageCounts) {
            for (const [k, v] of Object.entries(data.messageCounts)) messageCounts.set(k, v);
        }

        console.log('Data loaded from data.json');
    } catch (err) {
        console.error('Failed to load data:', err.message);
    }
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

// Format milliseconds into a human readable string
function formatDuration(ms) {
    const days = Math.floor(ms / (24 * 60 * 60 * 1000));
    ms %= 24 * 60 * 60 * 1000;
    const hours = Math.floor(ms / (60 * 60 * 1000));
    ms %= 60 * 60 * 1000;
    const mins = Math.floor(ms / (60 * 1000));
    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (mins > 0) parts.push(`${mins}m`);
    return parts.join(' ') || '0m';
}

async function isAdmin(member) {
    if (!member) return false;
    return member.permissions.has(PermissionFlagsBits.Administrator);
}

async function handleMessage(message) {
    if (message.author.bot) return;
    if (!message.guild) return;
    if (message.content.startsWith('/')) return;

    const guildId = message.guild.id;
    const channelId = message.channel.id;
    const userId = message.author.id;

    const trackedChannelsSet = trackedChannels.get(guildId);
    if (!trackedChannelsSet || !trackedChannelsSet.has(channelId)) return;

    const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
    if (await isAdmin(member)) return;

    // Check lockdown — nobody except admins can talk
    const lockInfo = lockedChannels.get(channelId);
    if (lockInfo) {
        if (lockInfo.expiresAt && Date.now() >= lockInfo.expiresAt) {
            // Lockdown expired — remove it and give everyone a fresh start
            lockedChannels.delete(channelId);
            clearChannelCounts(channelId);
            saveData();
            // Fall through — let this message go through normal checks with clean counts
        } else {
            // Lockdown still active
            message.delete().catch(() => {});
            return;
        }
    }

    // Check role restriction
    const roles = allowedRoles.get(channelId);
    if (roles && roles.length > 0) {
        const userRoles = member ? [...member.roles.cache.keys()] : [];
        const hasAllowedRole = roles.some(r => userRoles.includes(r));
        if (!hasAllowedRole) {
            message.delete().catch(() => {});
            return;
        }
    }

    // Check if user is blocked
    if (blockedUsers.has(getChannelUserKey(channelId, userId))) {
        message.delete().catch(() => {});
        return;
    }

    // Rate limit check using configurable reset time
    const channelUserKey = getChannelUserKey(channelId, userId);
    const now = Date.now();
    const limit = rateLimit.get(channelId) || DEFAULT_LIMIT;
    const windowMs = resetTime.get(channelId) || DEFAULT_RESET_TIME;

    if (!messageCounts.has(channelUserKey)) {
        messageCounts.set(channelUserKey, { startTime: now, count: 0 });
    }

    const userCounts = messageCounts.get(channelUserKey);

    // If the reset window has passed, reset the count
    if (now - userCounts.startTime >= windowMs) {
        userCounts.startTime = now;
        userCounts.count = 0;
    }

    userCounts.count++;

    // Track total messages
    totalMessagesTracked.set(channelId, (totalMessagesTracked.get(channelId) || 0) + 1);

    if (userCounts.count > limit) {
        message.delete().catch(() => {});
        totalMessagesDeleted.set(channelId, (totalMessagesDeleted.get(channelId) || 0) + 1);
    }

    // Persist updated counts (throttled) so a crash doesn't wipe them completely
    scheduleSave();
}

// Build the main dashboard embed showing all tracked channels
function buildMainDashboard(guildId, guild) {
    const now = Date.now();
    const uptime = now - botStartTime;
    const trackedChannelsSet = trackedChannels.get(guildId) || new Set();
    const channels = Array.from(trackedChannelsSet);

    // ── Build the embed ──
    const embed = new EmbedBuilder()
        .setTitle('🛡️ Meme Guardian — Multi-Channel Dashboard')
        .setColor(0x5865F2)
        .setTimestamp()
        .setFooter({ text: `Bot uptime: ${formatDuration(uptime)}` });

    if (guild && guild.iconURL()) {
        embed.setThumbnail(guild.iconURL({ dynamic: true, size: 128 }));
    }

    // ── Status Overview ──
    embed.addFields({
        name: '📊 Overview',
        value: `**${channels.length}** tracked channels`,
        inline: true
    });

    embed.addFields({
        name: '🔄 Actions',
        value: 'Use buttons below to manage channels',
        inline: true
    });

    embed.addFields({
        name: '\u200b',
        value: '\u200b',
        inline: true
    });

    // ── Channel List ──
    if (channels.length > 0) {
        let channelList = '';
        channels.forEach(channelId => {
            const tracked = totalMessagesTracked.get(channelId) || 0;
            const deleted = totalMessagesDeleted.get(channelId) || 0;
            const lockInfo = lockedChannels.get(channelId);
            const activeLock = lockInfo && (!lockInfo.expiresAt || Date.now() < lockInfo.expiresAt);

            const statusIcon = activeLock ? '🔴' : '🟢';
            channelList += `${statusIcon} <#${channelId}> — ${tracked} tracked, ${deleted} deleted\n`;
        });

        embed.addFields({
            name: `📌 Tracked Channels (${channels.length})`,
            value: channelList,
            inline: false
        });
    } else {
        embed.addFields({
            name: '📌 Tracked Channels',
            value: '*No channels are being tracked*',
            inline: false
        });
    }

    // ── Buttons ──
    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('dash_add_channel')
            .setLabel('Add Channel')
            .setEmoji('➕')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId('dash_refresh')
            .setLabel('Refresh')
            .setEmoji('🔄')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('dash_remove_channel')
            .setLabel('Remove Channel')
            .setEmoji('➖')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(channels.length === 0),
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('dash_view_channel')
            .setLabel('View Channel Stats')
            .setEmoji('📊')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(channels.length === 0),
        new ButtonBuilder()
            .setCustomId('dash_reset_all')
            .setLabel('Reset All Counts')
            .setEmoji('🗑️')
            .setStyle(ButtonStyle.Danger),
    );

    return { embed, rows: [row1, row2] };
}

// Build the dashboard embed for a specific channel
function buildChannelDashboard(channelId, guild) {
    const now = Date.now();
    const limit = rateLimit.get(channelId) || DEFAULT_LIMIT;
    const currentWindow = resetTime.get(channelId) || DEFAULT_RESET_TIME;
    const uptime = now - botStartTime;
    const tracked = totalMessagesTracked.get(channelId) || 0;
    const deleted = totalMessagesDeleted.get(channelId) || 0;

    // Gather users for this channel
    let users = [];
    for (const [key, data] of messageCounts.entries()) {
        if (key.startsWith(channelId + ':') && (now - data.startTime < currentWindow)) {
            const remaining = currentWindow - (now - data.startTime);
            users.push({ id: key.split(':')[1], count: data.count, remaining });
        }
    }
    users.sort((a, b) => b.count - a.count);

    // Gather blocked users for this channel
    let blocked = [];
    for (const [key] of blockedUsers.entries()) {
        if (key.startsWith(channelId + ':')) {
            blocked.push(key.split(':')[1]);
        }
    }

    // Gather allowed roles for this channel
    const roles = allowedRoles.get(channelId);

    // Lockdown info
    const lockInfo = lockedChannels.get(channelId);
    let lockExpired = false;
    if (lockInfo && lockInfo.expiresAt && now >= lockInfo.expiresAt) {
        lockedChannels.delete(channelId);
        clearChannelCounts(channelId);
        saveData();
        lockExpired = true;
    }
    const activeLock = lockExpired ? null : lockedChannels.get(channelId);

    // ── Build the embed ──
    const embed = new EmbedBuilder()
        .setTitle(`🛡️ Meme Guardian — Channel Dashboard`)
        .setDescription(`Channel: <#${channelId}>`)
        .setColor(activeLock ? 0xFF4444 : 0x5865F2)
        .setTimestamp()
        .setFooter({ text: `Bot uptime: ${formatDuration(uptime)}` });

    if (guild && guild.iconURL()) {
        embed.setThumbnail(guild.iconURL({ dynamic: true, size: 128 }));
    }

    // ── Status Overview ──
    let statusIcon = activeLock ? '🔴' : '🟢';
    let statusText = activeLock ? 'LOCKED DOWN' : 'Active';

    embed.addFields({
        name: `${statusIcon} Status`,
        value: `**${statusText}**`,
        inline: true
    });

    embed.addFields({
        name: '📊 Message Limit',
        value: `**${limit}** messages`,
        inline: true
    });

    embed.addFields({
        name: '⏱️ Reset Window',
        value: `**${formatDuration(currentWindow)}**`,
        inline: true
    });

    // ── Configuration ──
    embed.addFields({
        name: '🎭 Role Restriction',
        value: roles && roles.length > 0 ? roles.map(r => `<@&${r}>`).join(' ') : '*Everyone allowed*',
        inline: true
    });

    // ── Lockdown ──
    if (activeLock) {
        let lockValue = '';
        if (activeLock.expiresAt) {
            const remaining = activeLock.expiresAt - now;
            lockValue = `🔒 Active — **${formatDuration(remaining)}** remaining`;
        } else {
            lockValue = '🔒 Active — **Indefinite** (use button below to unlock)';
        }
        embed.addFields({
            name: '⚠️ LOCKDOWN',
            value: lockValue,
            inline: false
        });
    }

    // ── Statistics ──
    embed.addFields({
        name: '📈 Session Stats',
        value: [
            `Messages tracked: **${tracked}**`,
            `Messages deleted: **${deleted}**`,
            `Active users: **${users.length}**`,
            `Blocked users: **${blocked.length}**`
        ].join('\n'),
        inline: true
    });

    // ── User Leaderboard ──
    const atLimit = users.filter(u => u.count >= limit);
    const under = users.filter(u => u.count < limit);

    if (users.length > 0) {
        let leaderboard = '';

        if (atLimit.length > 0) {
            leaderboard += '**🔴 At/Over Limit:**\n';
            atLimit.forEach((u, i) => {
                const bar = '█'.repeat(Math.min(limit, 10)) + ' ';
                leaderboard += `> <@${u.id}> — ${u.count}/${limit} ${bar} *(resets in ${formatDuration(u.remaining)})*\n`;
            });
        }

        if (under.length > 0) {
            if (leaderboard) leaderboard += '\n';
            leaderboard += '**🟢 Under Limit:**\n';
            under.forEach((u, i) => {
                const filled = Math.round((u.count / limit) * 10);
                const empty = 10 - filled;
                const bar = '█'.repeat(filled) + '░'.repeat(empty);
                leaderboard += `> <@${u.id}> — ${u.count}/${limit} ${bar} *(resets in ${formatDuration(u.remaining)})*\n`;
            });
        }

        embed.addFields({
            name: '👥 User Activity',
            value: leaderboard.substring(0, 1024),
            inline: false
        });
    } else {
        embed.addFields({
            name: '👥 User Activity',
            value: '*No active users in this window*',
            inline: false
        });
    }

    // ── Blocked Users ──
    if (blocked.length > 0) {
        embed.addFields({
            name: `🚫 Blocked Users (${blocked.length})`,
            value: blocked.map(u => `<@${u}>`).join(', ').substring(0, 1024),
            inline: false
        });
    }

    // ── Buttons ──
    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('dash_back')
            .setLabel('Back to Main')
            .setEmoji('⬅️')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('dash_refresh')
            .setLabel('Refresh')
            .setEmoji('🔄')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('dash_reset_all')
            .setLabel('Reset All Counts')
            .setEmoji('🗑️')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId('dash_toggle_lock')
            .setLabel(activeLock ? 'Unlock Channel' : 'Lock Channel')
            .setEmoji(activeLock ? '🔓' : '🔒')
            .setStyle(activeLock ? ButtonStyle.Success : ButtonStyle.Danger),
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('dash_clear_blocked')
            .setLabel('Unblock All')
            .setEmoji('✅')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(blocked.length === 0),
        new ButtonBuilder()
            .setCustomId('dash_clear_roles')
            .setLabel('Clear Role Restriction')
            .setEmoji('🎭')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!roles || roles.length === 0),
        new ButtonBuilder()
            .setCustomId('dash_reset_stats')
            .setLabel('Reset Session Stats')
            .setEmoji('📊')
            .setStyle(ButtonStyle.Secondary),
    );

    return { embed, rows: [row1, row2], channelId };
}

client.on('messageCreate', handleMessage);

client.on('ready', async () => {
    console.log(`Bot is ready! Logged in as ${client.user.tag}`);

    const commands = [
        // ── The mega setup command ──
        new SlashCommandBuilder()
            .setName('setup')
            .setDescription('Configure everything in one command (all options are optional)')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addChannelOption(opt => opt.setName('channel').setDescription('Channel to track').setRequired(false))
            .addIntegerOption(opt => opt.setName('limit').setDescription('Max messages per window (default: 3)').setRequired(false))
            .addStringOption(opt => opt.setName('resettime').setDescription('How long until counts reset, e.g. 24h, 3d, 12h (default: 24h)').setRequired(false))
            .addStringOption(opt => opt.setName('roles').setDescription('Allowed role IDs (space-separated) — or type "clear" to remove').setRequired(false))
            .addUserOption(opt => opt.setName('blockuser').setDescription('Block a user').setRequired(false))
            .addUserOption(opt => opt.setName('unblockuser').setDescription('Unblock a user').setRequired(false))
            .addStringOption(opt => opt.setName('lockdown').setDescription('Lock channel: "on", "off", or a duration like "24h" / "3d"').setRequired(false)),

        // ── Multi-channel commands ──
        new SlashCommandBuilder()
            .setName('addchannel')
            .setDescription('Add a channel to track')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addChannelOption(opt => opt.setName('channel').setDescription('Channel to track').setRequired(true))
            .addIntegerOption(opt => opt.setName('limit').setDescription('Max messages per window (optional)').setRequired(false))
            .addStringOption(opt => opt.setName('resettime').setDescription('Reset window e.g. 24h, 3d (optional)').setRequired(false)),

        new SlashCommandBuilder()
            .setName('removechannel')
            .setDescription('Remove a channel from tracking')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addChannelOption(opt => opt.setName('channel').setDescription('Channel to remove').setRequired(true)),

        new SlashCommandBuilder()
            .setName('listchannels')
            .setDescription('List all tracked channels')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

        new SlashCommandBuilder()
            .setName('channeldashboard')
            .setDescription('Show dashboard for a specific channel')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addChannelOption(opt => opt.setName('channel').setDescription('Channel to view').setRequired(true)),

        new SlashCommandBuilder()
            .setName('setlimit')
            .setDescription('Set max messages per window')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addIntegerOption(opt => opt.setName('limit').setDescription('Number of messages').setRequired(true))
            .addChannelOption(opt => opt.setName('channel').setDescription('Specific channel (optional, applies to all if not set)').setRequired(false)),

        new SlashCommandBuilder()
            .setName('setresettime')
            .setDescription('Set how long until message counts reset')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addStringOption(opt => opt.setName('time').setDescription('Duration e.g. 24h, 3d, 12h, 1d12h').setRequired(true))
            .addChannelOption(opt => opt.setName('channel').setDescription('Specific channel (optional, applies to all if not set)').setRequired(false)),

        new SlashCommandBuilder()
            .setName('blockuser')
            .setDescription('Block a user from sending messages')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addUserOption(opt => opt.setName('user').setDescription('User to block').setRequired(true))
            .addChannelOption(opt => opt.setName('channel').setDescription('Specific channel (optional, blocks in all if not set)').setRequired(false)),

        new SlashCommandBuilder()
            .setName('unblockuser')
            .setDescription('Unblock a user')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addUserOption(opt => opt.setName('user').setDescription('User to unblock').setRequired(true))
            .addChannelOption(opt => opt.setName('channel').setDescription('Specific channel (optional, unblocks in all if not set)').setRequired(false)),

        new SlashCommandBuilder()
            .setName('setroles')
            .setDescription('Set roles that can type')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addStringOption(opt => opt.setName('roles').setDescription('Role IDs separated by space').setRequired(true))
            .addChannelOption(opt => opt.setName('channel').setDescription('Specific channel (optional, applies to all if not set)').setRequired(false)),

        new SlashCommandBuilder()
            .setName('clearroles')
            .setDescription('Remove role restriction - allow everyone')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addChannelOption(opt => opt.setName('channel').setDescription('Specific channel (optional, applies to all if not set)').setRequired(false)),

        new SlashCommandBuilder()
            .setName('info')
            .setDescription('Show your message count')
            .addChannelOption(opt => opt.setName('channel').setDescription('Specific channel (optional)').setRequired(false)),

        new SlashCommandBuilder()
            .setName('reset')
            .setDescription('Reset a user count')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addUserOption(opt => opt.setName('user').setDescription('User to reset').setRequired(true))
            .addChannelOption(opt => opt.setName('channel').setDescription('Specific channel (optional, resets in all if not set)').setRequired(false)),

        new SlashCommandBuilder()
            .setName('dashboard')
            .setDescription('Show all channels overview')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

        new SlashCommandBuilder()
            .setName('lockdown')
            .setDescription('Block all conversation in a channel')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addChannelOption(opt => opt.setName('channel').setDescription('Channel to lock').setRequired(true))
            .addStringOption(opt => opt.setName('duration').setDescription('How long? e.g. 24h, 3d (leave empty = forever)').setRequired(false)),

        new SlashCommandBuilder()
            .setName('unlock')
            .setDescription('Remove the lockdown from a channel')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addChannelOption(opt => opt.setName('channel').setDescription('Channel to unlock').setRequired(true)),

        new SlashCommandBuilder()
            .setName('help')
            .setDescription('Show all available commands with detailed information')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    ];

    try {
        await client.application.commands.set(commands);
        console.log('Commands registered');
    } catch (err) {
        console.error('Failed:', err);
    }
});

client.on('interactionCreate', async (interaction) => {

    // ═══════════════════════════════════════════════════
    //  Button interactions (from dashboard)
    // ═══════════════════════════════════════════════════
    if (interaction.isButton()) {
        const guildId = interaction.guildId;
        if (!guildId) return;

        const member = interaction.member || await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        const admin = await isAdmin(member);
        if (!admin) {
            await interaction.reply({ content: '❌ Admin only', ephemeral: true });
            return;
        }

        // Check if we're in channel-specific dashboard mode
        const messageEmbed = interaction.message.embeds[0];
        const isChannelDashboard = messageEmbed && messageEmbed.description && messageEmbed.description.includes('<#');
        let currentChannelId = null;

        if (isChannelDashboard && messageEmbed.description) {
            const match = messageEmbed.description.match(/<#(\d+)>/);
            if (match) {
                currentChannelId = match[1];
            }
        }

        if (interaction.customId === 'dash_refresh') {
            if (isChannelDashboard && currentChannelId) {
                const { embed, rows } = buildChannelDashboard(currentChannelId, interaction.guild);
                await interaction.update({ embeds: [embed], components: rows });
            } else {
                const { embed, rows } = buildMainDashboard(guildId, interaction.guild);
                await interaction.update({ embeds: [embed], components: rows });
            }
            return;
        }

        if (interaction.customId === 'dash_back') {
            const { embed, rows } = buildMainDashboard(guildId, interaction.guild);
            await interaction.update({ embeds: [embed], components: rows });
            return;
        }

        if (interaction.customId === 'dash_add_channel') {
            await interaction.reply({
                content: 'Use `/addchannel` command to add a channel to tracking',
                ephemeral: true
            });
            return;
        }

        if (interaction.customId === 'dash_remove_channel') {
            await interaction.reply({
                content: 'Use `/removechannel` command to remove a channel from tracking',
                ephemeral: true
            });
            return;
        }

        if (interaction.customId === 'dash_view_channel') {
            const trackedChannelsSet = trackedChannels.get(guildId) || new Set();
            const channels = Array.from(trackedChannelsSet);
            if (channels.length === 0) {
                await interaction.reply({ content: '❌ No channels are being tracked', ephemeral: true });
                return;
            }

            // Show first channel dashboard
            const { embed, rows } = buildChannelDashboard(channels[0], interaction.guild);
            await interaction.update({ embeds: [embed], components: rows });
            return;
        }

        if (interaction.customId === 'dash_reset_all') {
            if (isChannelDashboard && currentChannelId) {
                clearChannelCounts(currentChannelId);
            } else {
                clearGuildCounts(guildId);
            }
            saveData();

            if (isChannelDashboard && currentChannelId) {
                const { embed, rows } = buildChannelDashboard(currentChannelId, interaction.guild);
                await interaction.update({ embeds: [embed], components: rows });
            } else {
                const { embed, rows } = buildMainDashboard(guildId, interaction.guild);
                await interaction.update({ embeds: [embed], components: rows });
            }
            return;
        }

        if (interaction.customId === 'dash_toggle_lock') {
            if (!isChannelDashboard || !currentChannelId) {
                await interaction.reply({ content: '❌ This action requires a specific channel', ephemeral: true });
                return;
            }

            const lockInfo = lockedChannels.get(currentChannelId);
            if (lockInfo) {
                lockedChannels.delete(currentChannelId);
                clearChannelCounts(currentChannelId);
            } else {
                lockedChannels.set(currentChannelId, { lockedAt: Date.now(), expiresAt: null });
            }
            saveData();

            const { embed, rows } = buildChannelDashboard(currentChannelId, interaction.guild);
            await interaction.update({ embeds: [embed], components: rows });
            return;
        }

        if (interaction.customId === 'dash_clear_blocked') {
            if (!isChannelDashboard || !currentChannelId) {
                await interaction.reply({ content: '❌ This action requires a specific channel', ephemeral: true });
                return;
            }

            for (const key of blockedUsers.keys()) {
                if (key.startsWith(currentChannelId + ':')) blockedUsers.delete(key);
            }
            saveData();

            const { embed, rows } = buildChannelDashboard(currentChannelId, interaction.guild);
            await interaction.update({ embeds: [embed], components: rows });
            return;
        }

        if (interaction.customId === 'dash_clear_roles') {
            if (!isChannelDashboard || !currentChannelId) {
                await interaction.reply({ content: '❌ This action requires a specific channel', ephemeral: true });
                return;
            }

            allowedRoles.delete(currentChannelId);
            saveData();

            const { embed, rows } = buildChannelDashboard(currentChannelId, interaction.guild);
            await interaction.update({ embeds: [embed], components: rows });
            return;
        }

        if (interaction.customId === 'dash_reset_stats') {
            if (!isChannelDashboard || !currentChannelId) {
                await interaction.reply({ content: '❌ This action requires a specific channel', ephemeral: true });
                return;
            }

            totalMessagesTracked.set(currentChannelId, 0);
            totalMessagesDeleted.set(currentChannelId, 0);
            saveData();

            const { embed, rows } = buildChannelDashboard(currentChannelId, interaction.guild);
            await interaction.update({ embeds: [embed], components: rows });
            return;
        }

        return;
    }

    if (!interaction.isCommand()) return;

    const guildId = interaction.guildId;
    if (!guildId) return interaction.reply({ content: '❌ This command only works in a server.', ephemeral: true });

    const userId = interaction.user.id;
    const member = interaction.member || await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    const admin = await isAdmin(member);

    // ═══════════════════════════════════════════════════
    //  /setup — the mega command
    // ═══════════════════════════════════════════════════
    if (interaction.commandName === 'setup') {
        if (!admin) return interaction.reply({ content: '❌ Admin only', ephemeral: true });

        const results = [];
        let settingsChanged = false;

        // Channel
        const channel = interaction.options.getChannel('channel');
        if (channel) {
            if (!trackedChannels.has(guildId)) {
                trackedChannels.set(guildId, new Set());
            }
            trackedChannels.get(guildId).add(channel.id);
            results.push(`📌 Tracking <#${channel.id}>`);
            settingsChanged = true;
        }

        // Limit
        const newLimit = interaction.options.getInteger('limit');
        if (newLimit !== null) {
            // Apply to all tracked channels
            const channels = trackedChannels.get(guildId) || new Set();
            channels.forEach(channelId => {
                rateLimit.set(channelId, newLimit);
            });
            results.push(`📊 Limit set to **${newLimit}** messages for all channels`);
            settingsChanged = true;
        }

        // Reset time
        const resetStr = interaction.options.getString('resettime');
        if (resetStr) {
            const ms = parseDuration(resetStr);
            if (ms) {
                // Apply to all tracked channels
                const channels = trackedChannels.get(guildId) || new Set();
                channels.forEach(channelId => {
                    resetTime.set(channelId, ms);
                });
                results.push(`⏱️ Reset window set to **${formatDuration(ms)}** for all channels`);
                settingsChanged = true;
            } else {
                results.push(`⚠️ Invalid reset time: "${resetStr}" — use format like 24h, 3d, 1d12h`);
            }
        }

        // Clear all counts when any rate-limit setting changes so users get a fresh start
        if (settingsChanged) {
            clearGuildCounts(guildId);
        }

        // Roles
        const rolesStr = interaction.options.getString('roles');
        if (rolesStr) {
            if (rolesStr.toLowerCase() === 'clear') {
                // Clear roles for all tracked channels
                const channels = trackedChannels.get(guildId) || new Set();
                channels.forEach(channelId => {
                    allowedRoles.delete(channelId);
                });
                results.push(`🔓 Role restriction removed — everyone can type`);
            } else {
                const roleIds = rolesStr.trim().split(/\s+/).filter(r => r);
                // Apply to all tracked channels
                const channels = trackedChannels.get(guildId) || new Set();
                channels.forEach(channelId => {
                    allowedRoles.set(channelId, roleIds);
                });
                results.push(`🎭 Allowed roles: ${roleIds.map(r => `<@&${r}>`).join(' ')} for all channels`);
            }
        }

        // Block user
        const blockTarget = interaction.options.getUser('blockuser');
        if (blockTarget) {
            // Block user from all tracked channels
            const channels = trackedChannels.get(guildId) || new Set();
            channels.forEach(channelId => {
                blockedUsers.set(getChannelUserKey(channelId, blockTarget.id), true);
            });
            results.push(`🚫 Blocked <@${blockTarget.id}> from all channels`);
        }

        // Unblock user
        const unblockTarget = interaction.options.getUser('unblockuser');
        if (unblockTarget) {
            // Unblock user from all tracked channels
            const channels = trackedChannels.get(guildId) || new Set();
            channels.forEach(channelId => {
                blockedUsers.delete(getChannelUserKey(channelId, unblockTarget.id));
            });
            results.push(`✅ Unblocked <@${unblockTarget.id}> from all channels`);
        }

        // Lockdown
        const lockdownStr = interaction.options.getString('lockdown');
        if (lockdownStr) {
            const lower = lockdownStr.toLowerCase().trim();
            if (lower === 'off' || lower === 'no' || lower === 'false') {
                // Remove lockdown from all tracked channels
                const channels = trackedChannels.get(guildId) || new Set();
                channels.forEach(channelId => {
                    lockedChannels.delete(channelId);
                    clearChannelCounts(channelId);
                });
                results.push(`🔓 Lockdown removed from all channels`);
            } else if (lower === 'on' || lower === 'yes' || lower === 'true') {
                // Lock all tracked channels
                const channels = trackedChannels.get(guildId) || new Set();
                channels.forEach(channelId => {
                    lockedChannels.set(channelId, { lockedAt: Date.now(), expiresAt: null });
                });
                results.push(`🔒 All channels locked indefinitely`);
            } else {
                const dur = parseDuration(lower);
                if (dur) {
                    // Lock all tracked channels with duration
                    const channels = trackedChannels.get(guildId) || new Set();
                    channels.forEach(channelId => {
                        const lockData = { lockedAt: Date.now(), expiresAt: Date.now() + dur };
                        lockedChannels.set(channelId, lockData);
                        setTimeout(() => {
                            const current = lockedChannels.get(channelId);
                            if (current && current.lockedAt === lockData.lockedAt) {
                                lockedChannels.delete(channelId);
                                clearChannelCounts(channelId);
                                saveData();
                            }
                        }, dur);
                    });
                    results.push(`🔒 All channels locked for **${formatDuration(dur)}**`);
                } else {
                    results.push(`⚠️ Invalid lockdown value: "${lockdownStr}" — use "on", "off", or a duration like 24h`);
                }
            }
        }

        if (results.length === 0) {
            await interaction.reply({ content: 'ℹ️ No options provided — use the options to configure!', ephemeral: true });
        } else {
            saveData();
            await interaction.reply({ content: `**Setup updated:**\n${results.join('\n')}`, ephemeral: true });
        }
        return;
    }

    // ═══════════════════════════════════════════════════
    //  Individual commands
    // ═══════════════════════════════════════════════════

    if (interaction.commandName === 'addchannel') {
        if (!admin) return interaction.reply({ content: '❌ Admin only', ephemeral: true });
        const channel = interaction.options.getChannel('channel');
        const newLimit = interaction.options.getInteger('limit');
        const resetStr = interaction.options.getString('resettime');

        if (!trackedChannels.has(guildId)) {
            trackedChannels.set(guildId, new Set());
        }
        trackedChannels.get(guildId).add(channel.id);

        if (newLimit !== null) {
            rateLimit.set(channel.id, newLimit);
        }
        if (resetStr) {
            const ms = parseDuration(resetStr);
            if (ms) {
                resetTime.set(channel.id, ms);
            }
        }

        let msg = `✅ Now tracking <#${channel.id}>`;
        if (newLimit !== null) {
            msg += `\n📊 Limit: **${newLimit}** messages`;
        }
        if (resetStr) {
            const ms = parseDuration(resetStr);
            if (ms) {
                msg += `\n⏱️ Reset window: **${formatDuration(ms)}**`;
            }
        }

        saveData();
        await interaction.reply({ content: msg, ephemeral: true });
        return;
    }

    if (interaction.commandName === 'removechannel') {
        if (!admin) return interaction.reply({ content: '❌ Admin only', ephemeral: true });
        const channel = interaction.options.getChannel('channel');

        const channels = trackedChannels.get(guildId);
        if (channels && channels.has(channel.id)) {
            channels.delete(channel.id);
            clearChannelCounts(channel.id);
            rateLimit.delete(channel.id);
            resetTime.delete(channel.id);
            allowedRoles.delete(channel.id);
            lockedChannels.delete(channel.id);
            totalMessagesTracked.delete(channel.id);
            totalMessagesDeleted.delete(channel.id);

            saveData();
            await interaction.reply({ content: `✅ Stopped tracking <#${channel.id}>`, ephemeral: true });
        } else {
            await interaction.reply({ content: `❌ Channel is not being tracked`, ephemeral: true });
        }
        return;
    }

    if (interaction.commandName === 'listchannels') {
        if (!admin) return interaction.reply({ content: '❌ Admin only', ephemeral: true });
        const channels = trackedChannels.get(guildId) || new Set();

        if (channels.size === 0) {
            await interaction.reply({ content: '❌ No channels are being tracked', ephemeral: true });
            return;
        }

        let msg = '📌 **Tracked Channels:**\n';
        channels.forEach(channelId => {
            const limit = rateLimit.get(channelId) || DEFAULT_LIMIT;
            const windowMs = resetTime.get(channelId) || DEFAULT_RESET_TIME;
            msg += `• <#${channelId}> — Limit: ${limit}, Reset: ${formatDuration(windowMs)}\n`;
        });

        await interaction.reply({ content: msg, ephemeral: true });
        return;
    }

    if (interaction.commandName === 'setlimit') {
        if (!admin) return interaction.reply({ content: '❌ Admin only', ephemeral: true });
        const newLimit = interaction.options.getInteger('limit');
        const channel = interaction.options.getChannel('channel');

        if (channel) {
            rateLimit.set(channel.id, newLimit);
            clearChannelCounts(channel.id);

            saveData();
            await interaction.reply({ content: `✅ Limit set to ${newLimit} messages for <#${channel.id}> — counts reset`, ephemeral: true });
        } else {
            // Apply to all tracked channels
            const channels = trackedChannels.get(guildId) || new Set();
            channels.forEach(channelId => {
                rateLimit.set(channelId, newLimit);
            });
            clearGuildCounts(guildId);

            saveData();
            await interaction.reply({ content: `✅ Limit set to ${newLimit} messages for all channels — all counts reset`, ephemeral: true });
        }
        return;
    }

    if (interaction.commandName === 'setresettime') {
        if (!admin) return interaction.reply({ content: '❌ Admin only', ephemeral: true });
        const timeStr = interaction.options.getString('time');
        const channel = interaction.options.getChannel('channel');
        const ms = parseDuration(timeStr);

        if (!ms) {
            return interaction.reply({ content: `❌ Invalid format: "${timeStr}" — use e.g. 24h, 3d, 12h, 1d12h`, ephemeral: true });
        }

        if (channel) {
            resetTime.set(channel.id, ms);
            clearChannelCounts(channel.id);

            saveData();
            await interaction.reply({ content: `✅ Message counts for <#${channel.id}> now reset every **${formatDuration(ms)}** — counts reset`, ephemeral: true });
        } else {
            // Apply to all tracked channels
            const channels = trackedChannels.get(guildId) || new Set();
            channels.forEach(channelId => {
                resetTime.set(channelId, ms);
            });
            clearGuildCounts(guildId);

            saveData();
            await interaction.reply({ content: `✅ All channels now reset every **${formatDuration(ms)}** — all counts reset`, ephemeral: true });
        }
        return;
    }

    if (interaction.commandName === 'blockuser') {
        if (!admin) return interaction.reply({ content: '❌ Admin only', ephemeral: true });
        const target = interaction.options.getUser('user');
        const channel = interaction.options.getChannel('channel');

        if (channel) {
            blockedUsers.set(getChannelUserKey(channel.id, target.id), true);

            saveData();
            await interaction.reply({ content: `✅ Blocked <@${target.id}> in <#${channel.id}>`, ephemeral: true });
        } else {
            // Block in all tracked channels
            const channels = trackedChannels.get(guildId) || new Set();
            channels.forEach(channelId => {
                blockedUsers.set(getChannelUserKey(channelId, target.id), true);
            });

            saveData();
            await interaction.reply({ content: `✅ Blocked <@${target.id}> in all channels`, ephemeral: true });
        }
        return;
    }

    if (interaction.commandName === 'unblockuser') {
        if (!admin) return interaction.reply({ content: '❌ Admin only', ephemeral: true });
        const target = interaction.options.getUser('user');
        const channel = interaction.options.getChannel('channel');

        if (channel) {
            blockedUsers.delete(getChannelUserKey(channel.id, target.id));

            saveData();
            await interaction.reply({ content: `✅ Unblocked <@${target.id}> in <#${channel.id}>`, ephemeral: true });
        } else {
            // Unblock in all tracked channels
            const channels = trackedChannels.get(guildId) || new Set();
            channels.forEach(channelId => {
                blockedUsers.delete(getChannelUserKey(channelId, target.id));
            });

            saveData();
            await interaction.reply({ content: `✅ Unblocked <@${target.id}> in all channels`, ephemeral: true });
        }
        return;
    }

    if (interaction.commandName === 'setroles') {
        if (!admin) return interaction.reply({ content: '❌ Admin only', ephemeral: true });
        const rolesStr = interaction.options.getString('roles');
        const channel = interaction.options.getChannel('channel');
        const roleIds = rolesStr.trim().split(/\s+/).filter(r => r);

        if (channel) {
            allowedRoles.set(channel.id, roleIds);

            saveData();
            if (roleIds.length === 0) {
                await interaction.reply({ content: `✅ No role restriction for <#${channel.id}> - everyone can type`, ephemeral: true });
            } else {
                await interaction.reply({ content: `✅ Only these roles can type in <#${channel.id}>: ${roleIds.map(r => `<@&${r}>`).join(' ')}`, ephemeral: true });
            }
        } else {
            // Apply to all tracked channels
            const channels = trackedChannels.get(guildId) || new Set();
            channels.forEach(channelId => {
                allowedRoles.set(channelId, roleIds);
            });

            saveData();
            if (roleIds.length === 0) {
                await interaction.reply({ content: `✅ No role restriction for all channels - everyone can type`, ephemeral: true });
            } else {
                await interaction.reply({ content: `✅ Only these roles can type in all channels: ${roleIds.map(r => `<@&${r}>`).join(' ')}`, ephemeral: true });
            }
        }
        return;
    }

    if (interaction.commandName === 'clearroles') {
        if (!admin) return interaction.reply({ content: '❌ Admin only', ephemeral: true });
        const channel = interaction.options.getChannel('channel');

        if (channel) {
            allowedRoles.delete(channel.id);

            saveData();
            await interaction.reply({ content: `✅ Role restriction removed for <#${channel.id}> - everyone can type`, ephemeral: true });
        } else {
            // Clear for all tracked channels
            const channels = trackedChannels.get(guildId) || new Set();
            channels.forEach(channelId => {
                allowedRoles.delete(channelId);
            });

            saveData();
            await interaction.reply({ content: `✅ Role restriction removed for all channels - everyone can type`, ephemeral: true });
        }
        return;
    }

    if (interaction.commandName === 'info') {
        const channelId = interaction.options.getChannel('channel')?.id;
        let targetChannelId = channelId;

        // If no specific channel provided, show all tracked channels or first one
        if (!targetChannelId) {
            const channels = trackedChannels.get(guildId) || new Set();
            if (channels.size > 0) {
                targetChannelId = Array.from(channels)[0];
            }
        }

        if (!targetChannelId) {
            await interaction.reply({ content: 'No channels are being tracked', ephemeral: true });
            return;
        }

        const userKey = getChannelUserKey(targetChannelId, userId);
        const userCounts = messageCounts.get(userKey);
        const currentLimit = rateLimit.get(targetChannelId) || DEFAULT_LIMIT;
        const currentWindow = resetTime.get(targetChannelId) || DEFAULT_RESET_TIME;
        const blocked = blockedUsers.has(userKey);

        let count = 0;
        let timeLeft = '';
        if (userCounts) {
            const elapsed = Date.now() - userCounts.startTime;
            if (elapsed < currentWindow) {
                count = userCounts.count;
                const remaining = currentWindow - elapsed;
                timeLeft = `\nResets in: **${formatDuration(remaining)}**`;
            }
        }

        let lockStatus = 'No';
        const lockInfo = lockedChannels.get(targetChannelId);
        if (lockInfo) {
            if (lockInfo.expiresAt && Date.now() >= lockInfo.expiresAt) {
                lockedChannels.delete(targetChannelId);
                clearChannelCounts(targetChannelId);
                saveData();
            } else if (lockInfo.expiresAt) {
                lockStatus = `Yes (${formatDuration(lockInfo.expiresAt - Date.now())} remaining)`;
            } else {
                lockStatus = 'Yes (no time limit)';
            }
        }

        const channelMsg = channelId ? `<#${targetChannelId}>` : '(all channels)';
        await interaction.reply({
            content: `Channel: ${channelMsg}\nYour messages: ${count}/${currentLimit} (window: ${formatDuration(currentWindow)})${timeLeft}\nBlocked: ${blocked ? 'Yes' : 'No'}\nLockdown: ${lockStatus}`,
            ephemeral: true
        });
        return;
    }

    if (interaction.commandName === 'reset') {
        if (!admin) return interaction.reply({ content: '❌ Admin only', ephemeral: true });
        const target = interaction.options.getUser('user');
        const channel = interaction.options.getChannel('channel');

        if (channel) {
            messageCounts.delete(getChannelUserKey(channel.id, target.id));

            saveData();
            await interaction.reply({ content: `✅ Reset <@${target.id}> in <#${channel.id}>`, ephemeral: true });
        } else {
            // Reset in all tracked channels
            const channels = trackedChannels.get(guildId) || new Set();
            channels.forEach(channelId => {
                messageCounts.delete(getChannelUserKey(channelId, target.id));
            });

            saveData();
            await interaction.reply({ content: `✅ Reset <@${target.id}> in all channels`, ephemeral: true });
        }
        return;
    }

    if (interaction.commandName === 'dashboard') {
        if (!admin) return interaction.reply({ content: '❌ Admin only', ephemeral: true });
        const { embed, rows } = buildMainDashboard(guildId, interaction.guild);
        await interaction.reply({ embeds: [embed], components: rows, ephemeral: true });
        return;
    }

    if (interaction.commandName === 'channeldashboard') {
        if (!admin) return interaction.reply({ content: '❌ Admin only', ephemeral: true });
        const channel = interaction.options.getChannel('channel');

        if (!channel) {
            return interaction.reply({ content: '❌ Please specify a channel', ephemeral: true });
        }

        const channels = trackedChannels.get(guildId) || new Set();
        if (!channels.has(channel.id)) {
            return interaction.reply({ content: '❌ That channel is not being tracked', ephemeral: true });
        }

        const { embed, rows } = buildChannelDashboard(channel.id, interaction.guild);
        await interaction.reply({ embeds: [embed], components: rows, ephemeral: true });
        return;
    }

    if (interaction.commandName === 'lockdown') {
        if (!admin) return interaction.reply({ content: '❌ Admin only', ephemeral: true });
        const channel = interaction.options.getChannel('channel');
        const durationStr = interaction.options.getString('duration');
        const durationMs = parseDuration(durationStr);

        if (!channel) {
            return interaction.reply({ content: '❌ Please specify a channel', ephemeral: true });
        }

        const lockData = { lockedAt: Date.now(), expiresAt: durationMs ? Date.now() + durationMs : null };
        lockedChannels.set(channel.id, lockData);

        if (durationMs) {
            setTimeout(() => {
                const current = lockedChannels.get(channel.id);
                if (current && current.lockedAt === lockData.lockedAt) {
                    lockedChannels.delete(channel.id);
                    clearChannelCounts(channel.id);
                    saveData();
                }
            }, durationMs);

            saveData();
            await interaction.reply({ content: `🔒 <#${channel.id}> locked for **${formatDuration(durationMs)}**`, ephemeral: true });
        } else {
            saveData();
            await interaction.reply({ content: `🔒 <#${channel.id}> locked **indefinitely** — use \`/unlock\` to remove`, ephemeral: true });
        }
        return;
    }

    if (interaction.commandName === 'unlock') {
        if (!admin) return interaction.reply({ content: '❌ Admin only', ephemeral: true });
        const channel = interaction.options.getChannel('channel');

        if (!channel) {
            return interaction.reply({ content: '❌ Please specify a channel', ephemeral: true });
        }

        if (!lockedChannels.has(channel.id)) {
            return interaction.reply({ content: 'ℹ️ That channel is not locked', ephemeral: true });
        }

        lockedChannels.delete(channel.id);
        clearChannelCounts(channel.id);

        saveData();
        await interaction.reply({ content: `🔓 <#${channel.id}> unlocked — conversation is open again`, ephemeral: true });
        return;
    }

    if (interaction.commandName === 'help') {
        if (!admin) return interaction.reply({ content: '❌ Admin only', ephemeral: true });

        const embed = new EmbedBuilder()
            .setTitle('📚 Meme Guardian Bot — Command Reference')
            .setColor(0x5865F2)
            .setTimestamp();

        embed.addFields({
            name: '⭐ /setup',
            value: '**The All-in-One Command**\nConfigure everything in one command. All options are optional.\n\n' +
                   '`channel` - Channel to track\n' +
                   '`limit` - Max messages per window (default: 3)\n' +
                   '`resettime` - Reset window (e.g. 24h, 3d, 12h)\n' +
                   '`roles` - Allowed role IDs (space-separated) or "clear"\n' +
                   '`blockuser` - Block a user\n' +
                   '`unblockuser` - Unblock a user\n' +
                   '`lockdown` - "on", "off", or duration (e.g. 24h)',
            inline: false
        });

        embed.addFields({
            name: '🎯 Multi-Channel Commands',
            value: '**/addchannel <channel> [limit] [resettime]**\nAdd a channel to track with optional settings\n\n' +
                   '**/removechannel <channel>**\nRemove a channel from tracking\n\n' +
                   '**/listchannels**\nList all tracked channels\n\n' +
                   '**/channeldashboard <channel>**\nShow detailed dashboard for a specific channel',
            inline: false
        });

        embed.addFields({
            name: '⚙️ Configuration Commands',
            value: '**/setlimit <number> [channel]**\nSet max messages per window. Optional channel applies to all if not set.\n\n' +
                   '**/setresettime <time> [channel]**\nSet reset window (e.g. 24h, 3d, 12h, 1d12h)\n\n' +
                   '**/setroles <role IDs> [channel]**\nSet roles that can type (space-separated role IDs)\n\n' +
                   '**/clearroles [channel]**\nRemove role restriction - everyone can type',
            inline: false
        });

        embed.addFields({
            name: '🔒 Lockdown Commands',
            value: '**/lockdown <channel> [duration]**\nLock a channel - no one can talk. Optional duration (e.g. 24h, 3d). Leave empty for indefinite.\n\n' +
                   '**/unlock <channel>**\nRemove lockdown from a channel',
            inline: false
        });

        embed.addFields({
            name: '🚫 User Management',
            value: '**/blockuser <user> [channel]**\nBlock a user. Optional channel targets specific channel or all.\n\n' +
                   '**/unblockuser <user> [channel]**\nUnblock a user\n\n' +
                   '**/reset <user> [channel]**\nReset a user\'s message count',
            inline: false
        });

        embed.addFields({
            name: '📊 Dashboard & Info',
            value: '**/dashboard**\nShow main dashboard with all tracked channels overview\n\n' +
                   '**/info [channel]**\nShow your message count and status (for everyone)\n\n' +
                   '**/help**\nShow this help message (you\'re here!)',
            inline: false
        });

        embed.addFields({
            name: '📝 Duration Format',
            value: 'All time-based settings support flexible formats:\n' +
                   '`30m` - 30 minutes\n' +
                   '`6h` - 6 hours\n' +
                   '`24h` - 24 hours\n' +
                   '`3d` - 3 days\n' +
                   '`1d12h` - 1 day and 12 hours\n' +
                   '`2d6h30m` - 2 days, 6 hours, 30 minutes',
            inline: false
        });

        embed.addFields({
            name: '💡 Quick Examples',
            value: 'Add channel: `/addchannel #memes limit:3 resettime:24h`\n' +
                   'Lock channel: `/lockdown #memes 2h`\n' +
                   'Block user: `/blockuser @spammer #memes`\n' +
                   'View dashboard: `/dashboard`\n' +
                   'Check status: `/info`',
            inline: false
        });

        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
    }
});

// Periodic cleanup — every 30 seconds
setInterval(() => {
    const now = Date.now();
    // Clean expired lockdowns
    for (const [channelId, lockInfo] of lockedChannels.entries()) {
        if (lockInfo.expiresAt && now >= lockInfo.expiresAt) {
            lockedChannels.delete(channelId);
            clearChannelCounts(channelId);
            saveData();
        }
    }
}, 30 * 1000);

// Flush any pending throttled write on graceful shutdown so counts survive restarts
function flushAndExit() {
    saveData();
    process.exit(0);
}
process.on('SIGINT', flushAndExit);
process.on('SIGTERM', flushAndExit);

// Load data immediately on boot
loadData();

client.login(process.env.DISCORD_TOKEN);
