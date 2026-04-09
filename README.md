<div align="center">

# 🛡️ Meme Guardian Bot

### A powerful Discord moderation bot built to control and manage message flow in specific channels.

[![Discord.js](https://img.shields.io/badge/discord.js-v14-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.js.org/)
[![Node.js](https://img.shields.io/badge/Node.js-16%2B-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge)](LICENSE)

<br>

**Rate limiting** · **Lockdowns** · **Role restrictions** · **User blocking** · **One-command setup**

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

> **Key principle:** All admin commands are completely invisible to regular users. They only see `/info`.

---

## ✨ Features

### 🎯 Core Features

| Feature | Description |
|---------|-------------|
| **📊 Rate Limiting** | Limit how many messages each user can send within a customizable time window |
| **⏱️ Configurable Reset Time** | Set the cooldown window to anything — `30m`, `12h`, `3d`, `1d12h`, etc. |
| **🔒 Channel Lockdown** | Instantly block ALL conversation — with optional auto-expire timer |
| **🚫 User Blocking** | Permanently block specific users — their messages are deleted on sight |
| **🎭 Role Restrictions** | Only allow certain roles to type in the tracked channel |
| **⚡ One-Command Setup** | Configure everything with a single `/setup` command |
| **🎛️ Interactive Dashboard** | A rich embed dashboard with buttons for instant moderation and live stats |
| **💾 Bulletproof Persistence** | Fully back up state across reboots. Timers resume organically after a crash |
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
  Is it in the
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
  Is channel locked? ── Yes ──→ Delete 🗑️
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
| `/info` | Shows your message count, time until reset, blocked status, and lockdown status |

#### 👑 Admin Only

| Command | Description |
|---------|-------------|
| `/setchannel <channel> [limit] [resettime]` | Set the tracked channel (with optional limit & reset time) |
| `/removechannel` | Stop tracking the channel |
| `/setlimit <number>` | Set max messages per window |
| `/setresettime <duration>` | Set how long until message counts reset |
| `/lockdown [duration]` | Lock the channel — no one can talk (optional auto-expire) |
| `/unlock` | Remove an active lockdown |
| `/blockuser <user>` | Permanently block a user |
| `/unblockuser <user>` | Unblock a user |
| `/setroles <role IDs>` | Set which roles can type (space-separated IDs) |
| `/clearroles` | Remove role restrictions — everyone can type |
| `/reset <user>` | Reset a specific user's message count |
| `/dashboard` | View full server stats — limits, lockdowns, blocked users, activity |

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

### Quick Setup — Limit a Memes Channel

```
/setup channel:#memes limit:3 resettime:24h
```
> Users can post 3 memes per day. Done.

### Emergency Lockdown

```
/lockdown
```
> Instantly blocks all conversation. Only admins can still type.

### Timed Lockdown — Cool Down Period

```
/setup lockdown:2h
```
> Locks channel for 2 hours, then automatically reopens.

### Restrict to Specific Roles

```
/setup channel:#verified-memes roles:1234567890 9876543210
```
> Only members with those role IDs can post.

### Block a Spammer and Lock for 30 Minutes

```
/setup blockuser:@spammer lockdown:30m
```
> Block the user AND lock the channel — all in one command.

### Check Your Status (as a regular user)

```
/info
```
> Shows: your message count, the limit, when it resets, and if the channel is locked.

### View Server Dashboard (admin)

```
/dashboard
```
> Summons the **Interactive Dashboard**, showing live stats, user leaderboards, and lockdown status. It includes buttons to instantly refresh data, reset counts, trigger lockdowns, and clear roles without typing commands.

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

### Data Storage

All data is automatically and persistently stored in a local `data.json` file. This means the bot can safely restart, crash, or update without losing any information:

| Data Type | Persistence |
|-----|---------|
| `trackedChannel` | Saved across restarts |
| `messageCounts` | User timestamps and counts survive reboots |
| `rateLimit` | Saved across restarts |
| `resetTime` | Saved across restarts |
| `blockedUsers` | Saved across restarts |
| `allowedRoles` | Saved across restarts |
| `lockedChannels` | Saved across restarts (auto-unlock timers will resume) |

> 💾 **Zero-Config Database:** You don't need to setup MongoDB or SQL. The bot manages the JSON file automatically.

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
<summary><b>What happens when the bot restarts?</b></summary>

Nothing is lost! The bot saves everything (limits, locked channels, connected users' progress) to a local `data.json` file. When the bot restarts, it immediately resumes exactly where it left off.
</details>

<details>
<summary><b>Can I use this bot in multiple servers?</b></summary>

Yes! The bot supports multiple servers simultaneously. Each server has its own independent configuration, limits, blocked users, and lockdown state.
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
- **Lockdown** (`/lockdown`): Blocks **everyone** (except admins) from talking in the tracked channel. Can be timed.
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

---

## 📄 License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

---

<div align="center">

**Built with ❤️ for Discord communities**

If this helped you, give it a ⭐!

</div>
