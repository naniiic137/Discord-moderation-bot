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

const trackedChannel = new Map();
const messageCounts = new Map();   // userKey -> { startTime, count }
const rateLimit = new Map();
const resetTime = new Map();       // guildId -> ms (default 24h)
const blockedUsers = new Map();
const allowedRoles = new Map();
const lockedChannels = new Map();  // guildId -> { lockedAt, expiresAt }

const DEFAULT_LIMIT = 3;
const DEFAULT_RESET_TIME = 24 * 60 * 60 * 1000; // 24 hours in ms
const botStartTime = Date.now();
let totalMessagesDeleted = new Map(); // guildId -> count
let totalMessagesTracked = new Map(); // guildId -> count

function getUserKey(guildId, userId) {
    return `${guildId}:${userId}`;
}

// Clear all message counts for a specific guild (not all guilds)
function clearGuildCounts(guildId) {
    for (const key of messageCounts.keys()) {
        if (key.startsWith(guildId + ':')) {
            messageCounts.delete(key);
        }
    }
}

// ═══════════════════════════════════════════════════
//  Persistent Storage — saves settings to data.json
// ═══════════════════════════════════════════════════
function saveData() {
    try {
        const data = {
            trackedChannel: Object.fromEntries(trackedChannel),
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

function loadData() {
    try {
        if (!fs.existsSync(DATA_FILE)) return;
        const raw = fs.readFileSync(DATA_FILE, 'utf-8');
        const data = JSON.parse(raw);

        if (data.trackedChannel) {
            for (const [k, v] of Object.entries(data.trackedChannel)) trackedChannel.set(k, v);
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
            for (const [k, v] of Object.entries(data.lockedChannels)) {
                // Skip expired lockdowns
                if (v.expiresAt && now >= v.expiresAt) continue;
                lockedChannels.set(k, v);
                // Re-schedule auto-unlock for timed lockdowns
                if (v.expiresAt) {
                    const remaining = v.expiresAt - now;
                    setTimeout(() => {
                        const current = lockedChannels.get(k);
                        if (current && current.lockedAt === v.lockedAt) {
                            lockedChannels.delete(k);
                            clearGuildCounts(k);
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

    const trackedChannelId = trackedChannel.get(guildId);
    if (!trackedChannelId || channelId !== trackedChannelId) return;

    const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
    if (await isAdmin(member)) return;

    // Check lockdown — nobody except admins can talk
    const lockInfo = lockedChannels.get(guildId);
    if (lockInfo) {
        if (lockInfo.expiresAt && Date.now() >= lockInfo.expiresAt) {
            // Lockdown expired — remove it and give everyone a fresh start
            lockedChannels.delete(guildId);
            clearGuildCounts(guildId);
            // Fall through — let this message go through normal checks with clean counts
        } else {
            // Lockdown still active
            message.delete().catch(() => {});
            return;
        }
    }

    // Check role restriction
    const roles = allowedRoles.get(guildId);
    if (roles && roles.length > 0) {
        const userRoles = member ? [...member.roles.cache.keys()] : [];
        const hasAllowedRole = roles.some(r => userRoles.includes(r));
        if (!hasAllowedRole) {
            message.delete().catch(() => {});
            return;
        }
    }

    // Check if user is blocked
    if (blockedUsers.has(getUserKey(guildId, userId))) {
        message.delete().catch(() => {});
        return;
    }

    // Rate limit check using configurable reset time
    const userKey = getUserKey(guildId, userId);
    const now = Date.now();
    const limit = rateLimit.get(guildId) || DEFAULT_LIMIT;
    const windowMs = resetTime.get(guildId) || DEFAULT_RESET_TIME;

    if (!messageCounts.has(userKey)) {
        messageCounts.set(userKey, { startTime: now, count: 0 });
    }

    const userCounts = messageCounts.get(userKey);

    // If the reset window has passed, reset the count
    if (now - userCounts.startTime >= windowMs) {
        userCounts.startTime = now;
        userCounts.count = 0;
    }

    userCounts.count++;

    // Track total messages
    totalMessagesTracked.set(guildId, (totalMessagesTracked.get(guildId) || 0) + 1);

    if (userCounts.count > limit) {
        message.delete().catch(() => {});
        totalMessagesDeleted.set(guildId, (totalMessagesDeleted.get(guildId) || 0) + 1);
    }
    
    // Save updated counts periodically so a crash doesn't wipe them completely
    saveData();
}

// Build the dashboard embed + buttons
function buildDashboard(guildId, guild) {
    const now = Date.now();
    const limit = rateLimit.get(guildId) || DEFAULT_LIMIT;
    const currentWindow = resetTime.get(guildId) || DEFAULT_RESET_TIME;
    const channelId = trackedChannel.get(guildId);
    const uptime = now - botStartTime;
    const tracked = totalMessagesTracked.get(guildId) || 0;
    const deleted = totalMessagesDeleted.get(guildId) || 0;

    // Gather users
    let users = [];
    for (const [key, data] of messageCounts.entries()) {
        if (key.startsWith(guildId + ':') && (now - data.startTime < currentWindow)) {
            const remaining = currentWindow - (now - data.startTime);
            users.push({ id: key.split(':')[1], count: data.count, remaining });
        }
    }
    users.sort((a, b) => b.count - a.count);

    // Gather blocked users
    let blocked = [];
    for (const [key] of blockedUsers.entries()) {
        if (key.startsWith(guildId + ':')) {
            blocked.push(key.split(':')[1]);
        }
    }

    // Gather allowed roles
    const roles = allowedRoles.get(guildId);

    // Lockdown info
    const lockInfo = lockedChannels.get(guildId);
    let lockExpired = false;
    if (lockInfo && lockInfo.expiresAt && now >= lockInfo.expiresAt) {
        lockedChannels.delete(guildId);
        clearGuildCounts(guildId);
        lockExpired = true;
    }
    const activeLock = lockExpired ? null : lockedChannels.get(guildId);

    // ── Build the embed ──
    const embed = new EmbedBuilder()
        .setTitle('🛡️ Meme Guardian — Dashboard')
        .setColor(activeLock ? 0xFF4444 : 0x5865F2)
        .setTimestamp()
        .setFooter({ text: `Bot uptime: ${formatDuration(uptime)}` });

    if (guild && guild.iconURL()) {
        embed.setThumbnail(guild.iconURL({ dynamic: true, size: 128 }));
    }

    // ── Status Overview ──
    let statusIcon = activeLock ? '🔴' : '🟢';
    let statusText = activeLock ? 'LOCKED DOWN' : 'Active';
    if (!channelId) {
        statusIcon = '⚪';
        statusText = 'No channel set';
    }

    embed.addFields({
        name: `${statusIcon} Status`,
        value: `**${statusText}**`,
        inline: true
    });

    embed.addFields({
        name: '📌 Tracked Channel',
        value: channelId ? `<#${channelId}>` : '*Not set*',
        inline: true
    });

    embed.addFields({
        name: '\u200b',
        value: '\u200b',
        inline: true
    });

    // ── Configuration ──
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
            lockValue = '🔒 Active — **Indefinite** (use /unlock or button below)';
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

    return { embed, rows: [row1, row2] };
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

        // ── Individual commands still work ──
        new SlashCommandBuilder()
            .setName('setchannel')
            .setDescription('Set the channel to track')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addChannelOption(opt => opt.setName('channel').setDescription('Channel to track').setRequired(true))
            .addIntegerOption(opt => opt.setName('limit').setDescription('Max messages per window (optional)').setRequired(false))
            .addStringOption(opt => opt.setName('resettime').setDescription('Reset window e.g. 24h, 3d (optional)').setRequired(false)),

        new SlashCommandBuilder()
            .setName('removechannel')
            .setDescription('Remove the tracked channel')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

        new SlashCommandBuilder()
            .setName('setlimit')
            .setDescription('Set max messages per window')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addIntegerOption(opt => opt.setName('limit').setDescription('Number of messages').setRequired(true)),

        new SlashCommandBuilder()
            .setName('setresettime')
            .setDescription('Set how long until message counts reset')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addStringOption(opt => opt.setName('time').setDescription('Duration e.g. 24h, 3d, 12h, 1d12h').setRequired(true)),

        new SlashCommandBuilder()
            .setName('blockuser')
            .setDescription('Block a user from sending messages')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addUserOption(opt => opt.setName('user').setDescription('User to block').setRequired(true)),

        new SlashCommandBuilder()
            .setName('unblockuser')
            .setDescription('Unblock a user')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addUserOption(opt => opt.setName('user').setDescription('User to unblock').setRequired(true)),

        new SlashCommandBuilder()
            .setName('setroles')
            .setDescription('Set roles that can type')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addStringOption(opt => opt.setName('roles').setDescription('Role IDs separated by space').setRequired(true)),

        new SlashCommandBuilder()
            .setName('clearroles')
            .setDescription('Remove role restriction - allow everyone')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

        new SlashCommandBuilder()
            .setName('info')
            .setDescription('Show your message count'),

        new SlashCommandBuilder()
            .setName('reset')
            .setDescription('Reset a user count')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addUserOption(opt => opt.setName('user').setDescription('User to reset').setRequired(true)),

        new SlashCommandBuilder()
            .setName('dashboard')
            .setDescription('Show all user stats')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

        new SlashCommandBuilder()
            .setName('lockdown')
            .setDescription('Block all conversation in the tracked channel')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addStringOption(opt => opt.setName('duration').setDescription('How long? e.g. 24h, 3d (leave empty = forever)').setRequired(false)),

        new SlashCommandBuilder()
            .setName('unlock')
            .setDescription('Remove the lockdown')
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
        if (!admin) return interaction.reply({ content: '❌ Admin only', ephemeral: true });

        if (interaction.customId === 'dash_refresh') {
            const { embed, rows } = buildDashboard(guildId, interaction.guild);
            await interaction.update({ embeds: [embed], components: rows });
            return;
        }

        if (interaction.customId === 'dash_reset_all') {
            clearGuildCounts(guildId);
            saveData();
            const { embed, rows } = buildDashboard(guildId, interaction.guild);
            await interaction.update({ embeds: [embed], components: rows });
            return;
        }

        if (interaction.customId === 'dash_toggle_lock') {
            const lockInfo = lockedChannels.get(guildId);
            if (lockInfo) {
                lockedChannels.delete(guildId);
                clearGuildCounts(guildId);
            } else {
                lockedChannels.set(guildId, { lockedAt: Date.now(), expiresAt: null });
            }
            saveData();
            const { embed, rows } = buildDashboard(guildId, interaction.guild);
            await interaction.update({ embeds: [embed], components: rows });
            return;
        }

        if (interaction.customId === 'dash_clear_blocked') {
            for (const key of blockedUsers.keys()) {
                if (key.startsWith(guildId + ':')) blockedUsers.delete(key);
            }
            saveData();
            const { embed, rows } = buildDashboard(guildId, interaction.guild);
            await interaction.update({ embeds: [embed], components: rows });
            return;
        }

        if (interaction.customId === 'dash_clear_roles') {
            allowedRoles.delete(guildId);
            saveData();
            const { embed, rows } = buildDashboard(guildId, interaction.guild);
            await interaction.update({ embeds: [embed], components: rows });
            return;
        }

        if (interaction.customId === 'dash_reset_stats') {
            totalMessagesTracked.set(guildId, 0);
            totalMessagesDeleted.set(guildId, 0);
            saveData();
            const { embed, rows } = buildDashboard(guildId, interaction.guild);
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
    const limit = rateLimit.get(guildId) || DEFAULT_LIMIT;
    const windowMs = resetTime.get(guildId) || DEFAULT_RESET_TIME;

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
            trackedChannel.set(guildId, channel.id);
            results.push(`📌 Tracking <#${channel.id}>`);
            settingsChanged = true;
        }

        // Limit
        const newLimit = interaction.options.getInteger('limit');
        if (newLimit !== null) {
            rateLimit.set(guildId, newLimit);
            results.push(`📊 Limit set to **${newLimit}** messages`);
            settingsChanged = true;
        }

        // Reset time
        const resetStr = interaction.options.getString('resettime');
        if (resetStr) {
            const ms = parseDuration(resetStr);
            if (ms) {
                resetTime.set(guildId, ms);
                results.push(`⏱️ Reset window set to **${formatDuration(ms)}**`);
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
                allowedRoles.delete(guildId);
                results.push(`🔓 Role restriction removed — everyone can type`);
            } else {
                const roleIds = rolesStr.trim().split(/\s+/).filter(r => r);
                allowedRoles.set(guildId, roleIds);
                results.push(`🎭 Allowed roles: ${roleIds.map(r => `<@&${r}>`).join(' ')}`);
            }
        }

        // Block user
        const blockTarget = interaction.options.getUser('blockuser');
        if (blockTarget) {
            blockedUsers.set(getUserKey(guildId, blockTarget.id), true);
            results.push(`🚫 Blocked <@${blockTarget.id}>`);
        }

        // Unblock user
        const unblockTarget = interaction.options.getUser('unblockuser');
        if (unblockTarget) {
            blockedUsers.delete(getUserKey(guildId, unblockTarget.id));
            results.push(`✅ Unblocked <@${unblockTarget.id}>`);
        }

        // Lockdown
        const lockdownStr = interaction.options.getString('lockdown');
        if (lockdownStr) {
            const lower = lockdownStr.toLowerCase().trim();
            if (lower === 'off' || lower === 'no' || lower === 'false') {
                lockedChannels.delete(guildId);
                clearGuildCounts(guildId);
                results.push(`🔓 Lockdown removed`);
            } else if (lower === 'on' || lower === 'yes' || lower === 'true') {
                lockedChannels.set(guildId, { lockedAt: Date.now(), expiresAt: null });
                results.push(`🔒 Channel locked indefinitely`);
            } else {
                const dur = parseDuration(lower);
                if (dur) {
                    const lockData = { lockedAt: Date.now(), expiresAt: Date.now() + dur };
                    lockedChannels.set(guildId, lockData);
                    setTimeout(() => {
                        const current = lockedChannels.get(guildId);
                        if (current && current.lockedAt === lockData.lockedAt) {
                            lockedChannels.delete(guildId);
                            clearGuildCounts(guildId);
                        }
                    }, dur);
                    results.push(`🔒 Channel locked for **${formatDuration(dur)}**`);
                } else {
                    results.push(`⚠️ Invalid lockdown value: "${lockdownStr}" — use "on", "off", or a duration like 24h`);
                }
            }
        }

        if (settingsChanged || results.length > 0) {
            saveData();
        }

        if (results.length === 0) {
            await interaction.reply({ content: 'ℹ️ No options provided — use the options to configure!', ephemeral: true });
        } else {
            await interaction.reply({ content: `**Setup updated:**\n${results.join('\n')}`, ephemeral: true });
        }
        return;
    }

    // ═══════════════════════════════════════════════════
    //  Individual commands
    // ═══════════════════════════════════════════════════

    if (interaction.commandName === 'setchannel') {
        if (!admin) return interaction.reply({ content: '❌ Admin only', ephemeral: true });
        const channel = interaction.options.getChannel('channel');
        const newLimit = interaction.options.getInteger('limit');
        const resetStr = interaction.options.getString('resettime');
        trackedChannel.set(guildId, channel.id);
        clearGuildCounts(guildId);
        let msg = `✅ Now tracking <#${channel.id}>`;
        if (newLimit !== null) {
            rateLimit.set(guildId, newLimit);
            msg += `\n📊 Limit: **${newLimit}** messages`;
        }
        if (resetStr) {
            const ms = parseDuration(resetStr);
            if (ms) {
                resetTime.set(guildId, ms);
                msg += `\n⏱️ Reset window: **${formatDuration(ms)}**`;
            }
        }
        saveData();
        await interaction.reply({ content: msg, ephemeral: true });
        return;
    }

    if (interaction.commandName === 'removechannel') {
        if (!admin) return interaction.reply({ content: '❌ Admin only', ephemeral: true });
        trackedChannel.delete(guildId);
        clearGuildCounts(guildId);
        saveData();
        await interaction.reply({ content: '✅ Tracking disabled', ephemeral: true });
        return;
    }

    if (interaction.commandName === 'setlimit') {
        if (!admin) return interaction.reply({ content: '❌ Admin only', ephemeral: true });
        const newLimit = interaction.options.getInteger('limit');
        rateLimit.set(guildId, newLimit);
        clearGuildCounts(guildId);
        saveData();
        await interaction.reply({ content: `✅ Limit set to ${newLimit} messages — all counts reset`, ephemeral: true });
        return;
    }

    if (interaction.commandName === 'setresettime') {
        if (!admin) return interaction.reply({ content: '❌ Admin only', ephemeral: true });
        const timeStr = interaction.options.getString('time');
        const ms = parseDuration(timeStr);
        if (!ms) {
            return interaction.reply({ content: `❌ Invalid format: "${timeStr}" — use e.g. 24h, 3d, 12h, 1d12h`, ephemeral: true });
        }
        resetTime.set(guildId, ms);
        clearGuildCounts(guildId);
        saveData();
        await interaction.reply({ content: `✅ Message counts now reset every **${formatDuration(ms)}** — all counts reset`, ephemeral: true });
        return;
    }

    if (interaction.commandName === 'blockuser') {
        if (!admin) return interaction.reply({ content: '❌ Admin only', ephemeral: true });
        const target = interaction.options.getUser('user');
        blockedUsers.set(getUserKey(guildId, target.id), true);
        saveData();
        await interaction.reply({ content: `✅ Blocked <@${target.id}>`, ephemeral: true });
        return;
    }

    if (interaction.commandName === 'unblockuser') {
        if (!admin) return interaction.reply({ content: '❌ Admin only', ephemeral: true });
        const target = interaction.options.getUser('user');
        blockedUsers.delete(getUserKey(guildId, target.id));
        saveData();
        await interaction.reply({ content: `✅ Unblocked <@${target.id}>`, ephemeral: true });
        return;
    }

    if (interaction.commandName === 'setroles') {
        if (!admin) return interaction.reply({ content: '❌ Admin only', ephemeral: true });
        const rolesStr = interaction.options.getString('roles');
        const roleIds = rolesStr.trim().split(/\s+/).filter(r => r);
        allowedRoles.set(guildId, roleIds);
        saveData();
        if (roleIds.length === 0) {
            await interaction.reply({ content: '✅ No role restriction - everyone can type', ephemeral: true });
        } else {
            await interaction.reply({ content: `✅ Only these roles can type: ${roleIds.map(r => `<@&${r}>`).join(' ')}`, ephemeral: true });
        }
        return;
    }

    if (interaction.commandName === 'clearroles') {
        if (!admin) return interaction.reply({ content: '❌ Admin only', ephemeral: true });
        allowedRoles.delete(guildId);
        saveData();
        await interaction.reply({ content: '✅ Role restriction removed - everyone can type', ephemeral: true });
        return;
    }

    if (interaction.commandName === 'info') {
        const channelId = trackedChannel.get(guildId);
        const userKey = getUserKey(guildId, userId);
        const userCounts = messageCounts.get(userKey);
        const currentLimit = rateLimit.get(guildId) || DEFAULT_LIMIT;
        const currentWindow = resetTime.get(guildId) || DEFAULT_RESET_TIME;
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
        const lockInfo = lockedChannels.get(guildId);
        if (lockInfo) {
            if (lockInfo.expiresAt && Date.now() >= lockInfo.expiresAt) {
                lockedChannels.delete(guildId);
                clearGuildCounts(guildId);
            } else if (lockInfo.expiresAt) {
                lockStatus = `Yes (${formatDuration(lockInfo.expiresAt - Date.now())} remaining)`;
            } else {
                lockStatus = 'Yes (no time limit)';
            }
        }

        await interaction.reply({
            content: `Channel: ${channelId ? `<#${channelId}>` : 'Not set'}\nYour messages: ${count}/${currentLimit} (window: ${formatDuration(currentWindow)})${timeLeft}\nBlocked: ${blocked ? 'Yes' : 'No'}\nLockdown: ${lockStatus}`,
            ephemeral: true
        });
        return;
    }

    if (interaction.commandName === 'reset') {
        if (!admin) return interaction.reply({ content: '❌ Admin only', ephemeral: true });
        const target = interaction.options.getUser('user');
        messageCounts.delete(getUserKey(guildId, target.id));
        saveData();
        await interaction.reply({ content: `✅ Reset <@${target.id}>`, ephemeral: true });
        return;
    }

    if (interaction.commandName === 'dashboard') {
        if (!admin) return interaction.reply({ content: '❌ Admin only', ephemeral: true });
        const { embed, rows } = buildDashboard(guildId, interaction.guild);
        await interaction.reply({ embeds: [embed], components: rows, ephemeral: true });
        return;
    }

    if (interaction.commandName === 'lockdown') {
        if (!admin) return interaction.reply({ content: '❌ Admin only', ephemeral: true });
        const durationStr = interaction.options.getString('duration');
        const durationMs = parseDuration(durationStr);
        const lockData = { lockedAt: Date.now(), expiresAt: durationMs ? Date.now() + durationMs : null };
        lockedChannels.set(guildId, lockData);

        if (durationMs) {
            setTimeout(() => {
                const current = lockedChannels.get(guildId);
                if (current && current.lockedAt === lockData.lockedAt) {
                    lockedChannels.delete(guildId);
                    clearGuildCounts(guildId);
                    saveData();
                }
            }, durationMs);
            saveData();
            await interaction.reply({ content: `🔒 Channel locked for **${formatDuration(durationMs)}**`, ephemeral: true });
        } else {
            saveData();
            await interaction.reply({ content: `🔒 Channel locked **indefinitely** — use \`/unlock\` to remove`, ephemeral: true });
        }
        return;
    }

    if (interaction.commandName === 'unlock') {
        if (!admin) return interaction.reply({ content: '❌ Admin only', ephemeral: true });
        if (!lockedChannels.has(guildId)) {
            return interaction.reply({ content: 'ℹ️ Channel is not locked', ephemeral: true });
        }
        lockedChannels.delete(guildId);
        clearGuildCounts(guildId);
        saveData();
        await interaction.reply({ content: '🔓 Lockdown removed — conversation is open again', ephemeral: true });
        return;
    }
});

// Periodic cleanup — every 30 seconds
setInterval(() => {
    const now = Date.now();
    // Clean expired lockdowns
    for (const [guildId, lockInfo] of lockedChannels.entries()) {
        if (lockInfo.expiresAt && now >= lockInfo.expiresAt) {
            lockedChannels.delete(guildId);
            clearGuildCounts(guildId);
            saveData();
        }
    }
}, 30 * 1000);

// Load data immediately on boot
loadData();

client.login(process.env.DISCORD_TOKEN);