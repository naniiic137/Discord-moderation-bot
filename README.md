<div align="center">

# 🛡️ Meme Guardian Bot

### A powerful Discord moderation bot built to control and manage message flow in specific channels.

[![Discord.js](https://img.shields.io/badge/discord.js-v14-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.js.org/)
[![Node.js](https://img.shields.io/badge/Node.js-16%2B-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge)](LICENSE)

<br>

**Rate limiting** · **Multi-Channel Support** · **Lockdowns** · **Role restrictions** · **User blocking** · **One-command setup**

</div>

---

## 📖 Table of Contents

- [Overview](#-overview)
- [Features](#-features)
- [How It Works](#-how-it-works)
- [Getting Started](#-getting-started)
- [Commands Reference](#-commands-reference)
- [Usage Examples](#-usage-examples)
- [Architecture](#-architecture)
- [FAQ](#-faq)
- [Contributing](#-contributing)
- [License](#-license)

---

## 🔍 Overview

**Meme Guardian Bot** is a Discord bot designed to give server administrators full control over message flow in designated channels. Whether you're managing a meme channel that gets too chaotic, running a structured Q&A channel, or need to enforce posting limits — this bot handles it all.

It tracks how many messages each user sends within a configurable time window, automatically deletes messages that exceed the limit, and provides powerful moderation tools like instant lockdowns, user blocking, and role-based access control.

The bot supports **multiple channels per server**, with each channel having its own independent settings, stats, and dashboard.

> **Key principle:** All admin commands are completely invisible to regular users. They only see `/info`.

---

## ✨ Features

### 🎯 Core Features

| Feature | Description |
|---------|-------------|
| **📊 Rate Limiting** | Limit how many messages each user can send within a customizable time window |
| **⏱️ Configurable Reset Time** | Set the cooldown window to anything — `30m`, `12h`, `3d`, `1d12h`, etc. |
| **🔒 Channel Lockdown** | Instantly block ALL conversation in a specific channel — with optional auto-expire timer |
| **🚫 User Blocking** | Permanently block specific users — their messages are deleted on sight |
| **🎭 Role Restrictions** | Only allow certain roles to type in tracked channels |
| **📌 Multi-Channel Support** | Track multiple channels simultaneously with independent settings per channel |
| **⚡ One-Command Setup** | Configure everything with a single `/setup` command |
| **🎛️ Interactive Dashboard** | Rich embed dashboards — one main overview + per-channel stats with buttons for instant moderation |
| **👻 Stealth Mode** | All command responses are ephemeral (hidden) — only the admin sees them |
| **🛡️ Admin-Only Access** | Non-admin users can't see or use any admin commands |

### 🔐 Permission Model

```
┌─────────────────────────────────────────────┐
│  👑 Server Administrator                    │
│  ├── Can use ALL commands                   │
│  ├── Bypasses all rate limits               │
│  ├── Bypasses lockdowns                     │
│  └── Commands are hidden from other users   │
│                                             │
│  👤 Regular User                            │
│  ├── Can only use /info                     │
│  ├── Subject to rate limits                 │
│  ├── Subject to lockdowns                   │
│  └── Cannot see admin commands at all       │
└─────────────────────────────────────────────┘
```

---

## ⚙️ How It Works

### Message Flow

```
User sends a message
        │
        ▼
   Is it a bot? ──── Yes ──→ Ignore
        │
       No
        │
        ▼
  Is it in a
  tracked channel? ── No ──→ Ignore
        │
       Yes
        │
        ▼
  Is user an Admin? ── Yes ──→ Allow ✅
        │
       No
        │
        ▼
  Is this channel locked? ── Yes ──→ Delete 🗑️
        │
       No
        │
        ▼
  Does user have an
  allowed role? ──────── No ──→ Delete 🗑️
  (if roles are set)
        │
       Yes
        │
        ▼
  Is user blocked? ──── Yes ──→ Delete 🗑️
        │
       No
        │
        ▼
  Is user over the
  message limit? ────── Yes ──→ Delete 🗑️
        │
       No
        │
        ▼
     Allow ✅
```

### Rate Limiting System

Unlike simple daily resets, the bot uses a **per-user sliding window**:

1. When a user sends their **first message**, a timer starts for that user
2. The user can send up to `limit` messages within the `resettime` window
3. Any messages beyond the limit are **automatically deleted**
4. Once the window expires, the count resets and they can post again

**Example:** With `limit: 3` and `resettime: 12h`:
- User posts 3 memes → ✅ All allowed
- User tries to post a 4th → 🗑️ Deleted
- 12 hours later → Counter resets, user can post 3 more

---

## 🚀 Getting Started

### Prerequisites

- **Node.js** v16.9.0 or higher ([Download](https://nodejs.org/))
- A **Discord account** with a server you have admin access to

### Step 1: Clone the Repository

```bash
git clone https://github.com/YOUR_USERNAME/meme-guardian-bot.git
cd meme-guardian-bot
```

### Step 2: Install Dependencies

```bash
npm install
```

### Step 3: Create a Discord Bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **"New Application"** and give it a name
3. Navigate to **Bot** → **"Reset Token"** and copy your bot token
4. Under **Privileged Gateway Intents**, enable:
   - ✅ Message Content Intent
   - ✅ Server Members Intent

### Step 4: Configure Environment

Create a `.env` file in the project root:

```env
DISCORD_TOKEN=your_bot_token_here
```

> ⚠️ **Never share or commit your bot token.** The `.gitignore` already excludes `.env`.

### Step 5: Invite the Bot to Your Server

1. In the Developer Portal, go to **OAuth2** → **URL Generator**
2. Select scopes: **`bot`**, **`applications.commands`**
3. Select bot permissions:
   - ✅ Administrator
   - ✅ Send Messages
   - ✅ Manage Messages
   - ✅ Read Message History
   - ✅ Use Application Commands
4. Copy the generated URL and open it in your browser to add the bot

### Step 6: Start the Bot

```bash
npm start
```

You should see:
```
Bot is ready! Logged in as YourBot#1234
Commands registered
```

> 📝 **Note:** Global slash commands can take up to **1 hour** to appear in Discord the first time. After that, updates are instant.

---

## 📋 Commands Reference

### ⭐ `/setup` — The All-in-One Command

Configure **everything** in a single command. All parameters are optional — only include what you want to change.

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `channel` | Channel | Channel to track | `#memes` |
| `limit` | Integer | Max messages per window | `5` |
| `resettime` | String | Time until counts reset | `24h`, `3d`, `12h` |
| `roles` | String | Allowed role IDs (space-separated), or `clear` | `123456 789012` |
| `blockuser` | User | Block a user | `@spammer` |
| `unblockuser` | User | Unblock a user | `@forgiven` |
| `lockdown` | String | `on`, `off`, or a duration | `on`, `24h`, `off` |

---

### Individual Commands

#### 👤 Everyone

| Command | Description |
|---------|-------------|
| `/info [channel]` | Shows your message count, time until reset, blocked status, and lockdown status |

#### 👑 Admin Only

| Command | Description |
|---------|-------------|
| `/addchannel <channel> [limit] [resettime]` | Add a channel to track with optional settings |
| `/removechannel <channel>` | Remove a channel from tracking |
| `/listchannels` | List all tracked channels |
| `/setlimit <number> [channel]` | Set max messages per window (applies to all or specific channel) |
| `/setresettime <duration> [channel]` | Set reset time (applies to all or specific channel) |
| `/lockdown <channel> [duration]` | Lock a specific channel — no one can talk |
| `/unlock <channel>` | Remove lockdown from a specific channel |
| `/blockuser <user> [channel]` | Block a user (specific channel or all) |
| `/unblockuser <user> [channel]` | Unblock a user (specific channel or all) |
| `/setroles <role IDs> [channel]` | Set allowed roles (applies to all or specific channel) |
| `/clearroles [channel]` | Remove role restrictions (applies to all or specific channel) |
| `/reset <user> [channel]` | Reset a user's count (specific channel or all) |
| `/dashboard` | View main dashboard with all channels overview |
| `/channeldashboard <channel>` | View detailed stats for a specific channel |
| `/help` | Show all available commands with detailed information |

---

### Duration Format

Durations are flexible and support any combination:

| Input | Meaning |
|-------|---------|
| `30m` | 30 minutes |
| `6h` | 6 hours |
| `24h` | 24 hours |
| `3d` | 3 days |
| `1d12h` | 1 day and 12 hours |
| `2d6h30m` | 2 days, 6 hours, 30 minutes |

---

## 💡 Usage Examples

### Track Multiple Channels

```
/addchannel #memes limit:3 resettime:24h
/addchannel #general limit:10 resettime:1h
```
> Each channel has its own independent limit, reset time, and stats.

### View Channel Dashboard

```
/channeldashboard #memes
```
> Shows detailed stats for the memes channel — user activity, blocked users, etc.

### Quick Setup — Limit a Memes Channel

```
/setup channel:#memes limit:3 resettime:24h
```
> Users can post 3 memes per day. Done.

### Emergency Lockdown

```
/lockdown #memes
```
> Instantly blocks all conversation in #memes. Only admins can still type.

### Timed Lockdown — Cool Down Period

```
/lockdown #memes 2h
```
> Locks channel for 2 hours, then automatically reopens.

### Restrict to Specific Roles

```
/setup channel:#verified-memes roles:1234567890 9876543210
```
> Only members with those role IDs can post.

### Block a Spammer and Lock for 30 Minutes

```
/setup channel:#memes blockuser:@spammer lockdown:30m
```
> Block the user AND lock the channel — all in one command.

### Check Your Status (as a regular user)

```
/info
```
> Shows: your message count, the limit, when it resets, and if the channel is locked.

### View Main Dashboard (admin)

```
/dashboard
```
> Shows an overview of all tracked channels with summary stats. Click "View Channel Stats" to see per-channel details.

### Get Help (admin)

```
/help
```
> Shows a detailed list of all available commands with descriptions and examples.

---

## 🏗️ Architecture

### Tech Stack

| Technology | Purpose |
|------------|---------|
| **Node.js** | Runtime environment |
| **discord.js v14** | Discord API wrapper |
| **dotenv** | Environment variable management |

### Project Structure

```
meme-guardian-bot/
├── bot.js              # Main bot logic — all commands and event handlers
├── package.json        # Dependencies and scripts
├── .env                # Bot token (not committed)
├── .gitignore          # Files excluded from git
└── README.md           # You are here
```

---

## ❓ FAQ

<details>
<summary><b>Why can't I see the bot's commands?</b></summary>

Only users with **Administrator** permission can see admin commands. Regular users can only see `/info`. This is enforced both by Discord's permission system and the bot's code.
</details>

<details>
<summary><b>The commands aren't showing up at all!</b></summary>

Global slash commands can take up to **1 hour** to register with Discord the first time. Wait a bit and try again. You can also try:
- Restarting Discord (Ctrl+R)
- Checking that the bot is online in your server
</details>

<details>
<b>Does the bot save data between restarts?</b></summary>

No. This version runs in-memory only — all data resets when the bot restarts. This is intentional for simpler deployment.
</details>

<details>
<summary><b>Can I use this bot in multiple servers?</b></summary>

Yes! The bot supports multiple servers simultaneously. Each server has its own independent configuration, tracked channels, limits, blocked users, and lockdown states.
</details>

<details>
<summary><b>Does the bot delete its own messages?</b></summary>

No. All bot responses use Discord's **ephemeral messages** — they're only visible to the person who ran the command and disappear automatically. The bot never posts visible messages in the channel.
</details>

<details>
<summary><b>Can admins be rate-limited or locked out?</b></summary>

No. Users with the **Administrator** permission bypass all restrictions — rate limits, lockdowns, role restrictions, and blocking.
</details>

<details>
<summary><b>What's the difference between blocking a user and a lockdown?</b></summary>

- **Block** (`/blockuser`): Targets a **specific user** — their messages are always deleted, even when there's no lockdown.
- **Lockdown** (`/lockdown`): Blocks **everyone** (except admins) from talking in the specified channel. Can be timed.
</details>

<details>
<summary><b>How is data structured for multiple channels?</b></summary>

Each tracked channel has its own independent:
- Message limit and reset time
- Role restrictions
- Blocked users list
- Lockdown state
- Per-user message counts
- Statistics (messages tracked/deleted)

The `/dashboard` command shows an overview of all channels, and `/channeldashboard` shows detailed stats for a specific channel.
</details>

---

## 🤝 Contributing

Contributions are welcome! Here's how:

1. **Fork** the repository
2. **Create** a feature branch (`git checkout -b feature/amazing-feature`)
3. **Commit** your changes (`git commit -m 'Add amazing feature'`)
4. **Push** to the branch (`git push origin feature/amazing-feature`)
5. **Open** a Pull Request

### Ideas for Contributions

- [ ] Per-guild timezone configuration
- [ ] Warning system before hitting the limit
- [ ] Logging channel for moderation actions
- [ ] Web dashboard for configuration
- [ ] Custom auto-response when a message is deleted
- [ ] Data persistence option (JSON file or database)

---

## 📄 License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

---

<div align="center">

**Built with ❤️ for Discord communities**

If this helped you, give it a ⭐!

</div>