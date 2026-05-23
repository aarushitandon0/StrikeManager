# StrikeManager

A native warning and strike system for subreddit moderators, built on [Devvit](https://developers.reddit.com/docs/devvit).

StrikeManager gives mod teams a structured, transparent enforcement pipeline with automatic user notifications, escalation prompts, and a real-time dashboard — all within Reddit's native interface. No external bots, no Discord coordination, no institutional memory required.

---

## Table of Contents

- [Why StrikeManager](#why-strikemanager)
- [Features](#features)
- [Architecture](#architecture)
- [Installation & Quick Start](#installation--quick-start)
- [Configuration](#configuration)
- [How It Works](#how-it-works)
  - [Issuing a Warning](#issuing-a-warning)
  - [Escalation Workflow](#escalation-workflow)
  - [Strike Decay](#strike-decay)
  - [AutoMod Bridge](#automod-bridge)
  - [Dashboard](#dashboard)
- [Testing Guide](#testing-guide)
  - [Warning Flow](#warning-flow)
  - [Escalation Flow](#escalation-flow)
  - [AutoMod Bridge Testing](#automod-bridge-testing)
  - [Edge Cases](#edge-cases)
- [Redis Key Schema](#redis-key-schema)
- [Event Triggers](#event-triggers)
- [Technical Specifications](#technical-specifications)
- [Production Considerations](#production-considerations)
- [Contributing](#contributing)
- [License](#license)

---

## Why StrikeManager

Most subreddits handle warnings manually. A mod notices a violation, leaves a Toolbox note, maybe pings someone in Discord, and hopes the next mod on duty remembers to check before acting. When they don't, enforcement becomes inconsistent — users who should be escalated slip through, and users who have improved get treated like first-time offenders.

StrikeManager replaces that entire workflow with a single, persistent, automated system that lives inside Reddit:

| Problem | StrikeManager Solution |
|---|---|
| Warnings lost in Toolbox notes | Persistent Redis storage, visible to all mods |
| Inconsistent enforcement across mod team | Configurable threshold with automatic escalation |
| No user transparency | Automatic modmail explains every warning |
| Bans issued without review | Explicit mod approval required for every ban |
| No way to reward good behavior | Automatic strike decay after configurable quiet period |
| AutoMod removals not tracked | AutoMod Bridge auto-issues strikes on removals |

---

## Features

### Core Enforcement

- **Issue Warning** — Right-click any post or comment to open a warning form. Select the rule violated (pulled from your configured rules list), set severity (minor, major, or severe), and add an optional internal note visible only to mods.
- **Strike Tracking** — Every warning is stored persistently in Redis, scoped per subreddit, with an active strike count cached separately for fast lookup.
- **Native Mod Notes** — A Reddit mod note is written automatically on every warning, visible in Reddit's own moderation interface alongside StrikeManager's data.
- **Strike History** — Right-click any post or comment and select **View Strike History** to see a user's complete warning record: date, rule, severity, issuing mod, and whether each strike is still active or expired.

### Notifications & Escalation

- **User Notification** — Every warning triggers a modmail to the warned user explaining the rule broken, the severity, their current strike count vs. the threshold, what happens if they reach it, and a direct link to appeal. Configurable off per subreddit.
- **Escalation Prompt** — When a user's active strike count reaches the configured threshold, the mod team receives an escalation modmail with the user's full record.
- **Three-Tier Response** — Mods reply directly to the escalation modmail:
  - `APPROVE` — executes a permanent ban immediately
  - `TEMP <days>` — executes a temporary ban for 1–365 days (e.g. `TEMP 7`)
  - `DISMISS` — clears the escalation without any ban, useful when context warrants leniency
- **Appeal Links** — Every user notification includes a direct modmail link to the mod team, making enforcement two-way and auditable.

### Advanced Features

- **AutoMod Bridge** — When AutoModerator removes a post or comment, StrikeManager automatically issues a strike with no mod clicks required. Includes a 60-second per-user cooldown to prevent API throttling during raids. Configurable on/off per subreddit.
- **Strike Decay** — After a configurable number of days without a new violation, a user's oldest active strike is automatically removed and the user is notified by modmail.

### Dashboard

- **Real-Time Dashboard** — Created as a custom post on your subreddit. Shows total recent warnings, pending escalation count, and at-risk user count (users within one strike of the threshold).
- **Searchable Warning Table** — Full table of recent warnings with columns for username, rule violated, severity, date, and issuing mod. Search filters in real time without requiring exact case.
- **Severity Badges** — Color-coded: yellow for minor, orange for major, red for severe.

---

## Architecture

```
src/main.tsx          (673 lines) — Context menus, forms, triggers, dashboard
src/redis.ts          (191 lines) — 14 Redis operations, per-subreddit scoped
src/notifications.ts  (130 lines) — User and mod notification templates
src/settings.ts       (100 lines) — 7 configurable settings with defaults
src/types.ts           (30 lines) — TypeScript interfaces
webroot/index.html    (150 lines) — Dashboard WebView UI
```

### Data Flow

```
Mod right-clicks post/comment
        │
        ▼
  Warning Form (rule, severity, note)
        │
        ▼
  handleWarningSubmit()
    ├── addWarning()         → Redis: stores Warning object, increments count
    ├── addModNote()         → Reddit API: writes native mod note (graceful fail)
    ├── sendUserNotification → ModMail API: warns user with appeal link
    ├── checkStrikeDecay()   → Redis: removes old strikes if decay period passed
    └── sendEscalationPrompt → ModMail API: alerts mod team if threshold hit
                                    │
                                    ▼
                           Mod replies APPROVE / TEMP N / DISMISS
                                    │
                                    ▼
                           ModMail Trigger handles command
                             ├── APPROVE  → banUser() (permanent or config duration)
                             ├── TEMP N   → banUser(duration: N days, validated 1–365)
                             └── DISMISS  → clearPendingEscalation()
```

### AutoMod Bridge Flow

```
AutoModerator removes post/comment
        │
        ▼
  ModAction Trigger fires
    ├── Checks: moderator.name === 'AutoModerator'
    ├── Checks: config.autoModEnabled === true
    ├── Checks: 60-second per-user cooldown (anti-throttle)
    └── addWarning() with rule: 'AutoModerator Removal'
          ├── Mod note written
          ├── User notified (if enabled)
          └── Escalation sent if threshold reached
```

---

## Installation & Quick Start

### Prerequisites

- Node.js 18+
- A Reddit account with moderator access
- Devvit CLI

### 1. Install Devvit CLI

```bash
npm install -g devvit
devvit login
```

### 2. Clone and Set Up

```bash
git clone https://github.com/your-username/strike-manager
cd strike-manager
npm install
npm run type-check   # Verify TypeScript compiles with 0 errors
```

### 3. Create a Test Subreddit

1. Go to [reddit.com/subreddits/create](https://reddit.com/subreddits/create)
2. Create a **private** subreddit (e.g. `r/strikemanager_test`)
3. Keep it under 200 subscribers (required for playtest mode)
4. Make yourself a moderator with full permissions

### 4. Upload and Playtest

```bash
devvit upload
devvit playtest r/strikemanager_test
```

Keep this terminal running — it streams live logs and auto-reinstalls on every file save.

### 5. Create the Dashboard

1. Go to your test subreddit
2. Open the subreddit menu (`···`)
3. Select **📊 Create Strike Dashboard**
4. Pin the created post for your mod team

### 6. Publish

Once tested and ready:

```bash
devvit publish
```

---

## Configuration

Seven settings are configurable per subreddit via **Mod Tools → Apps → StrikeManager → Configure**:

| Setting | Default | Description |
|---|---|---|
| **Strike Threshold** | `3` | Active strikes before an escalation prompt is sent to the mod team |
| **Ban Duration** | `7` days | Suggested ban duration in days when APPROVE is used. Set to `0` for permanent. |
| **Strike Expiry** | `180` days | Warnings older than this many days do not count toward the threshold |
| **Decay Period** | *(off)* | Days of no violations before the user's oldest active strike is automatically removed |
| **AutoMod Bridge** | `off` | Toggle automatic strikes on AutoModerator removals |
| **Notify Users** | `on` | Toggle whether warned users receive a modmail notification |
| **Subreddit Rules** | Default set | Custom rules list (one per line) shown in the warning form dropdown |

> **Tip:** Set Decay Period to a value like `90` (90 days) to reward users who stay clean. It runs automatically — no mod action required.

---

## How It Works

### Issuing a Warning

1. Right-click any post or comment as a moderator
2. Select **⚠ Issue Warning**
3. The form shows the user's current strike count and threshold
4. Select a rule from your configured list, set severity, and add an optional internal note
5. Submit — a toast confirms the warning, a mod note is written to Reddit, and the user is notified by modmail (if enabled)

### Escalation Workflow

When a user's active strike count hits the configured threshold:

1. The mod team receives an escalation modmail with the subject `[StrikeManager] Action required: u/<username>`
2. The modmail includes the user's full warning history and three response options
3. Any mod on the team replies to the modmail:

| Reply | Effect |
|---|---|
| `APPROVE` | Permanent ban (or duration set in config) |
| `TEMP 7` | 7-day temporary ban (any value 1–365) |
| `DISMISS` | Clears the escalation — no ban applied |

The command parser is case-insensitive and strips trailing punctuation, so `approve.`, `APPROVE!`, and `Approve` all work.

### Strike Decay

If the Decay Period setting is configured:

- Every time a warning is issued, the app checks all warned users in the background (throttled to once per hour)
- If a user's **oldest active strike** is older than the decay period and they have had no new violations, it is automatically removed
- The user receives a modmail: *"Your oldest warning has expired. You now have a fresh start."*
- The dashboard reflects the updated count immediately

### AutoMod Bridge

When enabled, StrikeManager listens to all `ModAction` events in your subreddit. When AutoModerator removes a post or comment:

1. A strike is issued automatically with the rule `AutoModerator Removal` and severity `minor`
2. A mod note is written
3. The user is notified (if notifications are enabled)
4. If the strike pushes them to the threshold, an escalation is sent to the mod team

A **60-second per-user cooldown** prevents duplicate strikes when AutoMod removes multiple items in rapid succession (e.g. during spam raids).

### Dashboard

Create the dashboard once with the subreddit context menu. The dashboard post shows:

- **Recent warnings** — count of all warnings in the last 50 recorded events
- **Pending approvals** — open escalations awaiting mod reply
- **Escalations open** — same value, displayed for clarity

The warning table shows all recent warnings and supports real-time username search (case-insensitive).

---

## Testing Guide

### Warning Flow

| Step | Action | Expected Result |
|---|---|---|
| 1 | Right-click a post, select **Issue Warning** | Warning form opens with current strike count displayed |
| 2 | Submit with rule, severity, and note | Toast confirms warning issued |
| 3 | Check the warned user's modmail | Notification received with rule, count, and appeal link |
| 4 | Right-click same post, select **View Strike History** | Full record shown with date, rule, severity |

### Escalation Flow

| Step | Action | Expected Result |
|---|---|---|
| 1 | Issue warnings up to configured threshold | Escalation modmail sent to mod team |
| 2a | Reply `APPROVE` | Permanent ban executed, escalation cleared |
| 2b | Reply `TEMP 7` | 7-day ban executed, escalation cleared |
| 2c | Reply `DISMISS` | Escalation cleared, no ban applied |

### AutoMod Bridge Testing

| Step | Action | Expected Result |
|---|---|---|
| 1 | Enable AutoMod Bridge in settings | Toggle confirmed saved |
| 2 | Post content that triggers an AutoMod removal | Strike automatically issued to post author |
| 3 | Check strike history for that user | AutoMod strike appears with rule "AutoModerator Removal" |

### Edge Cases

| Scenario | Expected Behavior |
|---|---|
| Warning on a post with a deleted author | Fails gracefully with a toast error, no crash |
| `TEMP 0` or `TEMP 400` reply | Returns a validation error modmail to the mod, no ban issued |
| App installed without mod note permissions | Warning flow completes normally; mod note failure logged silently |
| Username with different cases (`UserA` vs `usera`) | Both resolve to the same strike record (keys normalized to lowercase) |
| AutoMod removes 5 posts from same user in 10 seconds | Only 1 strike issued; cooldown prevents the other 4 |
| Decay check with no configured decay period | Decay is skipped silently; no performance impact |

---

## Redis Key Schema

All keys are namespaced by `subredditId` — no data is shared or accessible across subreddits.

| Key | Type | Description |
|---|---|---|
| `strikes:{subredditId}:{username}` | JSON array | All `Warning` objects for a user |
| `strikescount:{subredditId}:{username}` | String (int) | Cached active strike count for fast lookup |
| `recentwarnings:{subredditId}` | Sorted set | Last 100 warnings ordered by timestamp |
| `config:{subredditId}` | JSON object | Subreddit configuration |
| `pendingescalations:{subredditId}` | Hash | Open escalation records by username |
| `atrisk:{subredditId}` | Hash | Users at or above `threshold - 1` strikes |
| `lastdecaycheck:{subredditId}` | String (timestamp) | Throttle key for decay check (hourly) |
| `lastautostrike:{subredditId}:{username}` | String (timestamp) | AutoMod Bridge 60s cooldown per user |
| `dashboard:{subredditId}` | String | Post ID of the created dashboard post |

---

## Event Triggers

| Trigger | Event | Handler |
|---|---|---|
| `ModMail` | Incoming modmail to subreddit | Parses `APPROVE`, `TEMP N`, `DISMISS` from escalation threads |
| `ModAction` | Any mod action in subreddit | Detects AutoModerator removals for the AutoMod Bridge |

---

## Technical Specifications

| Property | Value |
|---|---|
| Language | TypeScript 5.8.3 (strict mode) |
| Compilation | 0 errors |
| Framework | Devvit v0.12.2 (public-api) |
| Storage | Redis (built-in Devvit storage — no external database) |
| Reddit APIs used | Ban, ModMail, ModAction, ModNotes, Settings, ContextMenus |
| External dependencies | None |
| Infrastructure | Fully serverless, runs on Reddit infrastructure |
| Cross-subreddit data isolation | Yes — all Redis keys namespaced by subreddit ID |

---

## Production Considerations

**Rate limiting**
The AutoMod Bridge enforces a 60-second per-user cooldown to prevent API throttling during high-volume removal events such as spam raids. The strike decay checker is also throttled to once per hour per subreddit.

**Graceful degradation**
If the app lacks mod note permissions, the warning flow completes normally and the failure is logged silently. No feature crashes on missing permissions.

**Input validation**
TEMP ban duration is validated to the 1–365 day range. Out-of-range values return a descriptive error modmail to the issuing mod before any ban is attempted.

**Case normalization**
All Redis keys use lowercased usernames to prevent duplicate records from case variation in Reddit usernames (e.g. `UserA` and `usera` map to the same record).

**Modmail command parsing**
The escalation reply parser normalizes input before matching: it lowercases the body, strips trailing punctuation, and splits on whitespace. This means `approve.`, `APPROVE!`, `Temp 7 days`, and `TEMP 7` all parse correctly.

**Ban policy compliance**
All bans require explicit moderator approval via modmail reply. The app never bans automatically without a human decision. `APPROVE` or `TEMP N` must be sent deliberately by a mod.

---

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Make changes and verify compilation: `npm run type-check`
4. Test on a private subreddit using `devvit playtest`
5. Submit a pull request with a description of the change

### Development Tips

- Run `devvit playtest r/your_test_sub` to get live log streaming — all `console.log` calls appear in the terminal
- The playtest reinstalls the app on every file save, so you can iterate quickly
- Use the `[AutoMod Bridge]` and `[StrikeDecay]` log prefixes to filter relevant output
- TypeScript strict mode is enforced — no `any` types except in specific safe contexts

---

## License

MIT — see [LICENSE](LICENSE) for details.
