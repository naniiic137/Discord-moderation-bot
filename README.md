<div align="center">

# 🛡️ Meme Guardian Bot

### A powerful Discord moderation bot built to control and manage message flow in specific channels.

[![Discord.js](https://img.shields.io/badge/discord.js-v14-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.js.org/)
[![Node.js](https://img.shields.io/badge/Node.js-16%2B-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge)](LICENSE)

<br>

**Daily limits** · **Per-submission cooldowns** · **Multi-channel** · **Per-member overrides** · **Lockdowns** · **Roles** · **Interactive dashboard** · **Persistent**

</div>

---

## 📖 Table of Contents

- [Overview](#-overview)
- [Features](#-features)
- [How It Works](#-how-it-works)
- [Getting Started](#-getting-started)
- [Commands Reference](#-commands-reference)
- [The Dashboard](#-the-dashboard)
- [Usage Examples](#-usage-examples)
- [Architecture](#-architecture)
- [FAQ](#-faq)
- [Contributing](#-contributing)
- [License](#-license)

---

## 🔍 Overview

**Meme Guardian Bot** gives server admins full control over how often members can post in designated channels. It tracks each member's submissions, enforces both a **daily limit** and a **cooldown between posts**, and deletes anything over the line - all while staying invisible to regular members.

Each server can track **multiple channels**, every channel keeps its **own independent settings**, and everything is **persisted to disk** so nothing is lost across restarts or crashes.

> **Key principle:** All admin tools are invisible to regular members. They only ever see `/info`.

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| **📊 Daily Limit** | Cap how many memes each member can post per window (default **5**) |
| **🕒 Per-Submission Cooldown** | Enforce a minimum gap between accepted posts (default **1h**) - independent from the daily limit |
| **⏱️ Configurable Window** | The "day" can be any duration - `30m`, `12h`, `24h`, `3d`, `1d12h`, … |
| **👤 Per-Member Overrides** | Give a single member a custom limit, **maximize** them (unlimited, no cooldown), clear their override, or reset their usage |
| **📌 Multi-Channel** | Track many channels at once, each with its own limit, cooldown, roles, locks and stats |
| **🔒 Lockdown** | Instantly freeze a channel (optionally auto-expiring) - only admins can talk |
| **🚫 User Blocking** | Permanently block specific members; their messages are deleted on sight |
| **🎭 Role Restrictions** | Restrict posting to specific roles |
| **🎛️ Interactive Dashboard** | Configure limits/cooldowns via pop-ups, browse member lists, and manage any member - all from buttons and menus |
| **🔔 Warn on Delete** | Optionally DM a member when their post is removed, explaining why and when they can post again (one DM per blocked streak, default off). Each DM has an **opt-out button** so the member can silence future alerts (and turn them back on) themselves |
| **⚠️ Near-Limit Warning** | Optionally post a short, auto-deleting in-channel notice when a member has **1 meme left**, so the next removal is no surprise (default off). Works even when members have DMs disabled |
| **⏲️ Live Countdowns** | Reset and cooldown times render as Discord timestamps that tick down live in every client |
| **🔎 Member Lookup** | Check any member's status, or pick them from a menu, **without pinging them** |
| **💾 Persistent Storage** | All settings and live state are saved to `data.json`; timed lockdowns resume after a restart |
| **👻 Stealth Mode** | Every bot response is ephemeral - only the person who ran the command sees it |

### 🔐 Permission Model

```
┌─────────────────────────────────────────────┐
│  👑 Server Administrator                    │
│  ├── Can use ALL commands & the dashboard   │
│  ├── Bypasses limits, cooldowns & lockdowns │
│  └── Admin commands hidden from members     │
│                                             │
│  👤 Regular Member                          │
│  ├── Can only use /info                     │
│  ├── Subject to limits, cooldowns & locks   │
│  └── Cannot see admin commands at all       │
└─────────────────────────────────────────────┘
```

---

## ⚙️ How It Works

### Two independent guards

Every accepted meme must pass **both** checks:

1. **Daily limit** - how many memes you may post within the reset window.
2. **Cooldown** - the minimum time that must pass between two accepted memes.

A message blocked by either guard is deleted and **does not count** against the daily limit - only accepted memes increment your tally and start your cooldown. **Maximized** members skip both guards entirely.

### Message Flow

```
Message in a tracked channel (non-admin)
        │
        ▼
  Channel locked? ─── Yes ──→ Delete 🗑️
        │ No
        ▼
  Allowed role? ───── No  ──→ Delete 🗑️   (if roles are set)
        │ Yes
        ▼
  Member blocked? ─── Yes ──→ Delete 🗑️
        │ No
        ▼
  Maximized? ──────── Yes ──→ Allow ✅
        │ No
        ▼
  Daily limit reached? ─ Yes ──→ Delete 🗑️ (doesn't count)
        │ No
        ▼
  Still in cooldown? ─── Yes ──→ Delete 🗑️ (doesn't count)
        │ No
        ▼
  Allow ✅  (count +1, cooldown starts)
```

**Example** - `limit: 5`, `cooldown: 1h`, `window: 24h`:
- A member may post **5 memes per day**, at most **one per hour**.
- A 6th meme (or a 2nd within the hour) is deleted automatically.
- The daily count resets 24h after their first post of the window.

---

## 🚀 Getting Started

### Prerequisites

- **Node.js** v16.9.0 or higher ([Download](https://nodejs.org/))
- A **Discord account** with a server you have admin access to

### Step 1: Clone & install

```bash
git clone https://github.com/YOUR_USERNAME/meme-guardian-bot.git
cd meme-guardian-bot
npm install
```

### Step 2: Create a Discord Bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. **New Application** → name it
3. **Bot** → **Reset Token** → copy the token
4. Under **Privileged Gateway Intents**, enable:
   - ✅ Message Content Intent
   - ✅ Server Members Intent

### Step 3: Configure environment

Create a `.env` file in the project root:

```env
DISCORD_TOKEN=your_bot_token_here
# DATA_DIR=/data   # optional: persist data.json to a mounted volume on hosted platforms (Railway, etc.)
```

> ⚠️ Never share or commit your bot token. `.gitignore` already excludes `.env` and `data.json`.

### Step 4: Invite the bot

In **OAuth2 → URL Generator**, select scopes **`bot`** and **`applications.commands`**, then permissions: **Administrator** (or at minimum **Send Messages**, **Manage Messages**, **Read Message History**, **Use Application Commands**). Open the generated URL to add it.

### Step 5: Start it

```bash
npm start
```

```
Bot is ready! Logged in as YourBot#1234
Commands registered
```

> 📝 Global slash commands can take up to **1 hour** to appear the first time. After that, updates are instant.

---

## 📋 Commands Reference

### 👤 Everyone

| Command | Description |
|---------|-------------|
| `/info [channel]` | Your memes used today, what's left, your cooldown, and when it resets. Defaults to the channel you run it in. Reply is private. |

### 👑 Admin only

#### Channels
| Command | Description |
|---------|-------------|
| `/setup [channel] [limit] [cooldown] [resettime] [roles] [blockuser] [unblockuser] [lockdown] [warn] [nearwarn]` | Configure everything at once (applies to all tracked channels) |
| `/addchannel <channel> [limit] [cooldown] [resettime]` | Start tracking a channel |
| `/removechannel <channel>` | Stop tracking a channel |
| `/listchannels` | List tracked channels and their settings |
| `/channeldashboard <channel>` | Open the control panel for one channel |
| `/dashboard` | Open the multi-channel control center |

#### Limits & cooldown
| Command | Description |
|---------|-------------|
| `/setlimit <number> [channel]` | Daily limit (default 5). No channel = all channels |
| `/setcooldown <time\|off> [channel]` | Time between posts (default 1h). `off` disables it |
| `/setresettime <duration> [channel]` | Length of the daily window |
| `/setuserlimit <user> <limit> [channel]` | Per-member override (use a huge number to maximize) |
| `/setwarn <on\|off> [channel]` | DM members when their post is removed |
| `/setnearwarn <on\|off> [channel]` | In-channel notice when a member has 1 meme left |

#### Members
| Command | Description |
|---------|-------------|
| `/checkuser <user> [channel]` | Look up a member's status - **does not ping** them |
| `/reset <user> [channel]` | Reset a member's daily count |
| `/blockuser <user> [channel]` | Block a member |
| `/unblockuser <user> [channel]` | Unblock a member |
| `/testdm [user]` | Send a test DM to check the bot can reach a member (defaults to you) |

#### Channel control
| Command | Description |
|---------|-------------|
| `/lockdown <channel> [duration]` | Freeze a channel (optional auto-expire) |
| `/unlock <channel>` | Remove a lockdown |
| `/setroles <role IDs> [channel]` | Restrict posting to roles |
| `/clearroles [channel]` | Remove the role restriction |
| `/help` | Full command reference inside Discord |

### Duration format

`30m` · `6h` · `24h` · `3d` · `1d12h` · `2d6h30m`. Cooldown also accepts `off`.

---

## 🎛️ The Dashboard

`/dashboard` opens the **Control Center**:

- **Overview** - every tracked channel with its limit, cooldown, window and live stats. A dropdown jumps into any channel; buttons **Add Channel** (channel picker) and **Remove Channel** work inline - no commands needed.
- **Channel panel** - shows status, limit, cooldown, window, roles and top members, with buttons to:
  - **Set Limit / Set Cooldown / Set Window** via pop-up text inputs
  - **Warn: On/Off** - toggle DMing members when their post is removed
  - **Near-limit: On/Off** - toggle the auto-deleting in-channel "1 meme left" notice
  - **Lock / Unlock**, **Reset Counts**, **Reset Stats**, **Unblock All**, **Clear Roles**
  - **Recent 10** - the last 10 members to post (newest first)
  - **Today's List** - the full, paginated list of everyone who posted this window
  - **Manage / Look Up Member** - pick any member from the full list, or from a quick list of members who **posted this window** (no ping), to see their status and **set a custom limit**, **maximize**, **clear override**, **reset usage**, **block/unblock**, or nudge their **posts left this window** with the **⬆️ +1 / ⬇️ -1** arrows (give a slot back after a deleted meme, without changing their overall limit)

All dashboard replies are private to the admin who opened them, and member lists never send pings.

---

## 💡 Usage Examples

```
/addchannel #memes limit:5 cooldown:1h resettime:24h
```
> 5 memes/day, one per hour, in #memes.

```
/setcooldown 30m #memes
/setlimit 10 #memes
```
> Loosen #memes to 10/day, one every 30 minutes.

```
/setuserlimit @TrustedPoster 9999999 #memes
```
> Effectively unlimited for one member (same as **Maximize** in the dashboard).

```
/checkuser @SomeMember
```
> Privately see their usage and cooldown - they're never notified.

```
/lockdown #memes 2h
```
> Freeze #memes for two hours, then auto-reopen.

```
/info
```
> What a member runs to see their own remaining memes and cooldown.

---

## 🏗️ Architecture

| Technology | Purpose |
|------------|---------|
| **Node.js** | Runtime |
| **discord.js v14** | Discord API (slash commands, buttons, modals, select menus) |
| **dotenv** | Environment variables |

### Project Structure

```
meme-guardian-bot/
├── bot.js              # All bot logic - commands, dashboard, enforcement
├── package.json        # Dependencies and scripts
├── data.json           # Persisted state (auto-created, not committed)
├── .env                # Bot token (not committed)
├── .gitignore
└── README.md
```

### Data Storage

State is persisted to `data.json`, keyed **per channel** so each tracked channel is independent. The file is created automatically.

| Data | Scope |
|------|-------|
| `trackedChannels` | Per guild: set of tracked channels |
| `messageCounts` | Per channel + member: count, window start, last post time |
| `rateLimit` | Per channel: daily limit |
| `cooldown` | Per channel: time between posts |
| `resetTime` | Per channel: window length |
| `userLimits` | Per channel + member: limit override |
| `blockedUsers` | Per channel + member: block flag |
| `allowedRoles` | Per channel: allowed roles |
| `lockedChannels` | Per channel: lockdown state (auto-unlock timers resume on restart) |
| `totalMessagesTracked` / `totalMessagesDeleted` | Per channel: stats |

> 💾 **Zero-config:** no database needed. Config and admin actions are written immediately; high-frequency per-message updates are coalesced (≤1 write/sec) to avoid blocking the event loop, and pending writes are flushed on graceful shutdown (`SIGINT`/`SIGTERM`). Stale counters are pruned automatically.

> 🚢 **Hosted/ephemeral platforms (Railway, etc.):** the container filesystem is wiped on every deploy and restart, which would reset all counts and settings. Mount a persistent volume and set `DATA_DIR` to its mount path (e.g. `/data`) so `data.json` lives on the volume and survives restarts.

---

## ❓ FAQ

<details>
<summary><b>What's the difference between the daily limit and the cooldown?</b></summary>

The **limit** caps how many memes a member can post per window (e.g. 5/day). The **cooldown** is the minimum gap between two accepted memes (e.g. 1h). Both must pass; a blocked message is deleted and doesn't count toward the limit.
</details>

<details>
<summary><b>What does "maximize" do?</b></summary>

It gives a member an unlimited allowance in that channel and skips the cooldown too - they can post freely. Use **Clear Override** (dashboard) to return them to the channel default.
</details>

<details>
<summary><b>Can I look up a member without pinging them?</b></summary>

Yes. `/checkuser` and the dashboard's **Manage / Look Up Member** picker show status without sending a notification - all member lists suppress mentions.
</details>

<details>
<summary><b>Does the bot save data between restarts?</b></summary>

Yes - everything is saved to `data.json` and reloaded on boot, including auto-unlock timers for timed lockdowns.
</details>

<details>
<summary><b>Can I use it in multiple servers / channels?</b></summary>

Yes. Multiple servers are supported, and within each server you can track multiple channels, each with fully independent settings and stats.
</details>

<details>
<summary><b>Can admins be limited or locked out?</b></summary>

No. Administrators bypass limits, cooldowns, lockdowns, role restrictions and blocks.
</details>

---

## 🤝 Contributing

1. **Fork** the repo
2. **Branch** (`git checkout -b feature/amazing-feature`)
3. **Commit** (`git commit -m 'Add amazing feature'`)
4. **Push** and open a **Pull Request**

### Ideas

- [ ] Per-guild timezone configuration
- [ ] Warning to a member as they approach their limit
- [ ] Moderation log channel
- [ ] Web dashboard

---

## 📄 License

MIT - see [LICENSE](LICENSE).

---

<div align="center">

**Built with ❤️ for Discord communities**

If this helped you, give it a ⭐!

</div>
