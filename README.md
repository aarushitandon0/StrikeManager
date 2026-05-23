# StrikeManager

A native warning and strike system for subreddit moderators, built on Devvit.

StrikeManager gives mod teams a structured, transparent enforcement pipeline
with automatic user notifications, escalation prompts, and a real-time dashboard,
all within Reddit's native interface. No external bots, no Discord coordination,
no institutional memory required.

---

## How It Works

Most subreddits handle warnings manually. A mod notices a violation, leaves a
Toolbox note, maybe pings someone in Discord, and hopes the next mod on duty
remembers to check before acting. When they do not, enforcement becomes
inconsistent. Users who should be escalated slip through. Users who have improved
get treated like first-time offenders.

StrikeManager replaces that entire workflow with a single, persistent, automated
system that lives inside Reddit.

When a mod issues a warning, StrikeManager stores it in Redis under that user's
record, writes a native Reddit mod note, and sends the user a modmail explaining
exactly what rule they broke, their current strike count, and how to appeal. When
the user hits the configured threshold, the mod team receives an escalation prompt
via modmail and can respond with a single reply. When a user goes long enough
without a new violation, their oldest strike decays automatically and they are
notified. Everything is logged, searchable, and visible to every mod on the team
at any time.

---

## Features

### Core Enforcement

- **Issue Warning** — Right-click any post or comment to open a warning form
  with rule selection (pulled from your configured rules list), severity level
  (minor, major, or severe), and an optional internal note visible only to mods
- **Strike Tracking** — Every warning is stored persistently in Redis, scoped
  per subreddit, with an active strike count cached separately for fast lookup
- **Native Mod Notes** — A Reddit mod note is written automatically on every
  warning, visible in Reddit's own moderation interface alongside StrikeManager's
  data
- **Strike History** — Right-click any post or comment and select View Strike
  History to see a user's complete warning record including date, rule, severity,
  mod who issued it, and whether each strike is still active or expired

### Notifications and Escalation

- **User Notification** — Every warning triggers a modmail to the warned user
  explaining the rule broken, the severity, their current strike count vs the
  threshold, what happens if they reach it, and a direct link to message the
  mod team to appeal. Configurable off per subreddit
- **Escalation Prompt** — When a user's active strike count reaches the
  configured threshold, the mod team receives an escalation modmail with the
  user's full record and three response options
- **Three-Tier Response** — Mods reply directly to the escalation modmail:
  - `APPROVE` — executes a permanent ban immediately
  - `TEMP 7` — executes a temporary ban for the specified number of days
    (any value from 1 to 365)
  - `DISMISS` — clears the escalation without any ban, useful when context
    warrants leniency

### Advanced Features

- **AutoMod Bridge** — When AutoModerator removes a post or comment,
  StrikeManager automatically issues a strike to that user with no mod clicks
  required. Supports a 60-second per-user cooldown to prevent API throttling
  during high-volume events like raids. Configurable on or off per subreddit
- **Strike Decay** — After a configurable number of days without a new
  violation, a user's oldest active strike is automatically removed and the
  user is notified by modmail. The decay period is fully configurable per
  subreddit
- **Appeal Links** — Every user notification includes a direct modmail link to
  the mod team, making the enforcement pipeline two-way and auditable

### Dashboard

- **Real-Time Dashboard** — Created as a custom post on your subreddit via the
  subreddit context menu. Shows total recent warnings, pending escalation count,
  and at-risk user count (users within one strike of the threshold)
- **Searchable Warning Table** — A full table of recent warnings with columns
  for username, rule violated, severity, date, and issuing mod. Search filters
  results in real time by username with no exact case required
- **Severity Badges** — Color-coded by severity level: yellow for minor, orange
  for major, red for severe

---

## Configuration

Seven settings configurable per subreddit via Mod Tools:

| Setting | Default | Description |
|---|---|---|
| Strike Threshold | 3 | Active strikes before escalation prompt is sent |
| Ban Duration | 7 days | Suggested ban duration in days (0 for permanent) |
| Strike Expiry | 180 days | Warnings older than this do not count toward threshold |
| Decay Period | Configurable | Days of good behavior before oldest strike is removed |
| AutoMod Bridge | Off | Toggle automatic strikes on AutoMod removals |
| Notify Users | On | Toggle whether warned users receive a modmail |
| Subreddit Rules | Default set | Custom rules list shown in warning form dropdown |

---

## Quick Start

### 1. Install Devvit CLI

```bash
npm install -g devvit
devvit login
```

### 2. Clone and Set Up

```bash
cd strike-manager
npm install
npm run type-check   # Verify TypeScript compiles with 0 errors
```

### 3. Create a Test Subreddit

- Go to https://reddit.com/subreddits/create
- Create a private subreddit (e.g. `r/strikemanager_test`)
- Keep it under 200 subscribers (required for playtest mode)
- Make yourself a moderator with full permissions

### 4. Upload and Playtest

```bash
devvit upload
devvit playtest r/strikemanager_test
```

Keep this terminal running. It streams live logs and auto-reinstalls the app
on every file save.

### 5. Test the App

1. Go to your test subreddit and create a post
2. Click the post menu (···) and select **Issue Warning**
3. Fill in the warning form: select a rule, set severity, add a note
4. Check the warned user's modmail to verify the notification arrived
5. Open the subreddit menu and select **Create Strike Dashboard**
6. Navigate to the dashboard post and verify warnings appear in the table
7. Issue enough warnings on one user to hit the threshold and verify the
   escalation modmail arrives in the mod team inbox
8. Reply `TEMP 3` to the escalation and verify the ban appears in Banned Users

---

## Testing Guide

### Warning Flow

| Step | Action | Expected Result |
|---|---|---|
| 1 | Right-click post, select Issue Warning | Warning form opens with current strike count displayed |
| 2 | Submit with rule, severity, and note | Toast confirms warning issued |
| 3 | Check warned user modmail | Notification received with rule, count, and appeal link |
| 4 | Right-click same post, select View Strike History | Full record shown with date, rule, severity |

### Escalation Flow

| Step | Action | Expected Result |
|---|---|---|
| 1 | Issue warnings up to configured threshold | Escalation modmail sent to mod team |
| 2 | Reply `APPROVE` | Permanent ban executed, escalation cleared |
| 2 | Reply `TEMP 7` | 7-day ban executed, escalation cleared |
| 2 | Reply `DISMISS` | Escalation cleared, no ban applied |

### AutoMod Bridge

| Step | Action | Expected Result |
|---|---|---|
| 1 | Enable AutoMod Bridge in settings | Toggle confirmed saved |
| 2 | Post content that triggers an AutoMod removal | Strike automatically issued to post author |
| 3 | Check strike history for that user | AutoMod strike appears in record |

### Edge Cases to Verify

- Issuing a warning on a post with a deleted author — should fail gracefully
  with a toast, not a crash
- Replying `TEMP 0` or `TEMP 400` to an escalation — should return a validation
  error (valid range is 1 to 365)
- App installed without mod note permissions — warning flow should complete
  normally, mod note failure logged silently
- Username with different cases (`UserA` vs `usera`) — both should resolve to
  the same strike record

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

### Redis Key Schema

```
strikes:{subredditId}:{username}      # JSON array of Warning objects
strikescount:{subredditId}:{username} # cached active strike count
recentwarnings:{subredditId}          # sorted set, last 100 warnings by timestamp
config:{subredditId}                  # subreddit configuration object
pendingescalations:{subredditId}      # hash of open escalation records
atrisk:{subredditId}                  # hash of users near threshold
```

### Event Triggers

- `ModMail` trigger — handles APPROVE, TEMP, and DISMISS commands from
  escalation threads
- `ModAction` trigger — detects AutoModerator removals for the AutoMod Bridge

---

## Technical Specifications

| Property | Value |
|---|---|
| Language | TypeScript 5.8.3 (strict mode) |
| Compilation | 0 errors |
| Framework | Devvit v0.12.2 (public-api) |
| Storage | Redis (built-in Devvit storage, no external database) |
| Reddit APIs | Ban, ModMail, ModAction, ModNotes, Settings, ContextMenus |
| External dependencies | None |
| Infrastructure | Fully serverless, runs on Reddit infrastructure |

---

## Production Considerations

**Rate limiting**
The AutoMod Bridge enforces a 60-second per-user cooldown to prevent API
throttling during high-volume removal events such as raids.

**Graceful degradation**
If the app lacks mod note permissions, the warning flow completes normally and
the failure is logged silently. No feature crashes on missing permissions.

**Input validation**
TEMP ban duration is validated to the 1 to 365 day range. Out-of-range values
return a descriptive error to the issuing mod.

**Case normalization**
All Redis keys use lowercased usernames to prevent duplicate records from
case variation in Reddit usernames.

**Cross-subreddit isolation**
All Redis keys are namespaced by subreddit ID. No data is shared or accessible
across communities under any circumstances.

---

## License

MIT