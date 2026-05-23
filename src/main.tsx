import { Devvit } from '@devvit/public-api';
import type { FormField } from '@devvit/public-api';
import { ModMail } from '@devvit/protos';
import {
  addWarning,
  countAtRiskUsers,
  getAllWarnedUsers,
  getPendingEscalationCount,
  getRecentWarnings,
  getStrikeCount,
  getWarnings,
  removeOldestStrike,
} from './redis.js';
import {
  dismissEscalation,
  isEscalationSubject,
  parseUsernameFromEscalationSubject,
  sendEscalationPrompt,
  sendUserNotification,
} from './notifications.js';
import { appSettings, loadConfig } from './settings.js';
import type { Severity, Warning } from './types.js';

Devvit.configure({
  redditAPI: true,
  redis: true,
});

Devvit.addSettings(appSettings);

const warningForm = Devvit.createForm(
  (data) => {
    const rules = JSON.parse((data.rulesJson as string) || '[]') as string[];
    const fields: FormField[] = [
      {
        type: 'select',
        name: 'rule',
        label: 'Rule violated',
        options: rules.map((r) => ({ label: r, value: r })),
        required: true,
      },
      {
        type: 'select',
        name: 'severity',
        label: 'Severity',
        options: [
          { label: 'Minor', value: 'minor' },
          { label: 'Major', value: 'major' },
          { label: 'Severe', value: 'severe' },
        ],
        defaultValue: ['minor'],
        required: true,
      },
      {
        type: 'string',
        name: 'note',
        label: 'Optional note (internal, mods only)',
        required: false,
      },
      {
        type: 'string',
        name: 'username',
        label: 'Username (do not edit)',
        defaultValue: data.username as string,
      },
      {
        type: 'string',
        name: 'postId',
        label: 'Content ID (do not edit)',
        defaultValue: data.postId as string,
      },
      {
        type: 'string',
        name: 'postUrl',
        label: 'Permalink (do not edit)',
        defaultValue: data.postUrl as string,
      },
    ];
    return {
      title: data.title as string,
      description: data.description as string,
      fields,
      acceptLabel: 'Issue Warning',
      cancelLabel: 'Cancel',
    };
  },
  async ({ values }, context) => {
    const username = values.username as string | undefined;
    const postId = values.postId as string | undefined;
    const postUrl = values.postUrl as string | undefined;

    if (!username || !postId || !postUrl) {
      context.ui.showToast('Missing warning target. Please try again.');
      return;
    }

    await handleWarningSubmit(
      context,
      username,
      postId,
      postUrl,
      values.rule as string,
      values.severity as string,
      (values.note as string) || ''
    );
  }
);

const historyForm = Devvit.createForm(
  (data) => ({
    title: data.title as string,
    description: data.description as string,
    fields: [],
    acceptLabel: 'Close',
  }),
  async () => {}
);

async function openWarningForm(
  context: Devvit.Context,
  username: string,
  postId: string,
  postUrl: string
): Promise<void> {
  const subreddit = await context.reddit.getCurrentSubreddit();
  const config = await loadConfig(context);
  const currentStrikes = await getStrikeCount(
    context.redis,
    subreddit.id,
    username
  );

  context.ui.showForm(warningForm, {
    title: `Issue Warning to u/${username}`,
    description: `Current active strikes: ${currentStrikes} / ${config.threshold}`,
    rulesJson: JSON.stringify(config.rules),
    username,
    postId,
    postUrl,
  });
}

async function handleWarningSubmit(
  context: Devvit.Context,
  username: string,
  postId: string,
  postUrl: string,
  rule: string,
  severity: string,
  note: string
): Promise<void> {
  // CRITICAL: Normalize username to lowercase for consistent Redis keys
  const normalizedUsername = username.toLowerCase();
  
  const subreddit = await context.reddit.getCurrentSubreddit();
  const currentUser = await context.reddit.getCurrentUser();
  const config = await loadConfig(context);

  const warning: Warning = {
    id: crypto.randomUUID(),
    username: normalizedUsername,
    rule,
    severity: severity as Severity,
    note,
    modName: currentUser?.username ?? 'unknown',
    postId,
    postUrl,
    timestamp: Date.now(),
    expired: false,
  };

  const newCount = await addWarning(
    context.redis,
    subreddit.id,
    warning,
    config.expiryDays
  );

  // Check if any strikes have decayed (good behavior rewards)
  try {
    await checkAndApplyStrikeDecay(context, subreddit.id);
  } catch (e) {
    console.error('Strike decay check failed:', e);
  }

  // Try to add mod note, but don't fail the warning if permissions are missing
  try {
    await context.reddit.addModNote({
      subreddit: subreddit.name,
      user: normalizedUsername,
      note: `[StrikeManager] Strike ${newCount}: ${rule} (${severity})`,
      label: severity === 'severe' ? 'SPAM_WARNING' : 'ABUSE_WARNING',
      redditId: postId.startsWith('t') ? (postId as `t1_${string}` | `t3_${string}`) : undefined,
    });
  } catch (e) {
    // Non-fatal — warning saved, mod note skipped (insufficient permissions)
    console.warn(`[StrikeManager] Mod note failed (missing permissions?): ${e}`);
  }

  if (config.notifyUsers) {
    try {
      await sendUserNotification(
        context,
        normalizedUsername,
        subreddit.name,
        warning,
        newCount,
        config
      );
    } catch (e) {
      console.error('Failed to notify user:', e);
    }
  }

  if (newCount >= config.threshold) {
    try {
      await sendEscalationPrompt(
        context,
        normalizedUsername,
        subreddit,
        newCount,
        config
      );
    } catch (e) {
      console.error('Failed to send escalation:', e);
    }
  }

  context.ui.showToast(
    `✅ Warning issued to u/${normalizedUsername}. Active strikes: ${newCount}/${config.threshold}`
  );
}

async function showStrikeHistory(
  context: Devvit.Context,
  username: string
): Promise<void> {
  // CRITICAL: Normalize username for consistent lookup
  const normalizedUsername = username.toLowerCase();
  
  const subreddit = await context.reddit.getCurrentSubreddit();
  const warnings = await getWarnings(context.redis, subreddit.id, normalizedUsername);
  const count = await getStrikeCount(context.redis, subreddit.id, normalizedUsername);

  if (warnings.length === 0) {
    context.ui.showToast(`u/${username} has no warnings on record.`);
    return;
  }

  const lines = warnings.map((w, i) => {
    const date = new Date(w.timestamp).toLocaleDateString();
    const status = w.expired ? '[expired]' : '[active]';
    return `${i + 1}. ${date} — ${w.rule} (${w.severity}) ${status}${
      w.note ? ` | Note: ${w.note}` : ''
    }`;
  });

  const body = [
    `Strike history for u/${normalizedUsername}`,
    `Active strikes: ${count}`,
    `Total on record: ${warnings.length}`,
    '',
    ...lines,
  ].join('\n');

  context.ui.showForm(historyForm, {
    title: `Strike History — u/${normalizedUsername}`,
    description: body,
  });
}

Devvit.addMenuItem({
  label: '⚠ Issue Warning',
  location: 'post',
  forUserType: 'moderator',
  onPress: async (event, context) => {
    const post = await context.reddit.getPostById(event.targetId);
    if (!post.authorName) {
      context.ui.showToast('Cannot warn: post has no author.');
      return;
    }
    await openWarningForm(
      context,
      post.authorName,
      event.targetId,
      `https://reddit.com${post.permalink}`
    );
  },
});

Devvit.addMenuItem({
  label: '⚠ Issue Warning',
  location: 'comment',
  forUserType: 'moderator',
  onPress: async (event, context) => {
    const comment = await context.reddit.getCommentById(event.targetId);
    if (!comment.authorName) {
      context.ui.showToast('Cannot warn: comment has no author.');
      return;
    }
    await openWarningForm(
      context,
      comment.authorName,
      event.targetId,
      `https://reddit.com${comment.permalink}`
    );
  },
});

Devvit.addMenuItem({
  label: '📋 View Strike History',
  location: ['post', 'comment'],
  forUserType: 'moderator',
  onPress: async (event, context) => {
    const postOrComment =
      event.location === 'post'
        ? await context.reddit.getPostById(event.targetId)
        : await context.reddit.getCommentById(event.targetId);
    if (!postOrComment.authorName) {
      context.ui.showToast('No author found for this content.');
      return;
    }
    await showStrikeHistory(context, postOrComment.authorName);
  },
});

Devvit.addMenuItem({
  label: '📊 Create Strike Dashboard',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, context) => {
    const subreddit = await context.reddit.getCurrentSubreddit();
    const post = await context.reddit.submitPost({
      subredditName: subreddit.name,
      title: '[Mod Only] StrikeManager Dashboard',
      preview: (
        <vstack alignment="center middle" height="100%">
          <text size="large">Loading StrikeManager...</text>
        </vstack>
      ),
    });
    await context.redis.set(`dashboard:${subreddit.id}`, post.id);
    context.ui.showToast(
      'Dashboard created! Pin this post for your mod team.'
    );
  },
});

Devvit.addCustomPostType({
  name: 'StrikeManager Dashboard',
  height: 'tall',
  render: (context) => {
    return (
      <blocks height="tall">
        <webview
          url="index.html"
          onMessage={async (msg) => {
            if (msg && typeof msg === 'object' && 'type' in msg && msg.type === 'READY') {
              const subreddit = await context.reddit.getCurrentSubreddit();
              const config = await loadConfig(context);
              const recent = await getRecentWarnings(
                context.redis,
                subreddit.id,
                50
              );
              const atRisk = await countAtRiskUsers(context.redis, subreddit.id);
              const pending = await getPendingEscalationCount(
                context.redis,
                subreddit.id
              );
              context.ui.webView.postMessage(
                JSON.parse(
                  JSON.stringify({
                    type: 'INIT',
                    warnings: recent,
                    atRisk,
                    pending,
                    threshold: config.threshold,
                  })
                )
              );
            }
          }}
        />
      </blocks>
    );
  },
});

Devvit.addTrigger({
  event: 'ModMail',
  onEvent: async (event: ModMail, context) => {
    if (!event.messageAuthor?.name || !event.conversationId) {
      return;
    }

    if (event.messageAuthor.name === context.appName) {
      return;
    }

    const conversationResponse = await context.reddit.modMail.getConversation({
      conversationId: event.conversationId,
    });

    const subject = conversationResponse.conversation?.subject ?? '';
    if (!isEscalationSubject(subject)) {
      return;
    }

    const username = parseUsernameFromEscalationSubject(subject);
    if (!username) {
      return;
    }

    const messages = Object.values(
      conversationResponse.conversation?.messages ?? {}
    );
    const currentMessage = messages.find(
      (m) => m.id && event.messageId.includes(m.id)
    );
    const rawBody = currentMessage?.body ?? currentMessage?.bodyMarkdown ?? '';
    
    // CRITICAL: Normalize command parsing - handle punctuation, case variations, whitespace
    const body = rawBody
      .toLowerCase()
      .trim()
      .replace(/[.,!?;:]$/, ''); // Remove trailing punctuation
    
    const command = body.split(/\s+/)[0]; // Get first word

    // Check for APPROVE, TEMP, or DISMISS commands
    const isApprove = command === 'approve';
    const isDismiss = command === 'dismiss';
    const isTemp = command === 'temp' && body.split(/\s+/)[1];

    if (!isApprove && !isDismiss && !isTemp) {
      return;
    }

    const subreddit = await context.reddit.getCurrentSubreddit();
    const config = await loadConfig(context);

    // Handle DISMISS
    if (isDismiss) {
      await dismissEscalation(context, subreddit.id, username);
      console.log(`Escalation dismissed for u/${username}`);
      return;
    }

    // Handle TEMP ban (temporary ban with custom duration)
    if (isTemp) {
      const tempDaysStr = body.split(/\s+/)[1];
      const tempDays = parseInt(tempDaysStr) || 7;
      
      // CRITICAL: Validate TEMP duration is within reasonable bounds
      if (tempDays < 1 || tempDays > 365 || isNaN(tempDays)) {
        try {
          await context.reddit.sendPrivateMessageAsSubreddit({
            fromSubredditName: subreddit.name,
            to: event.messageAuthor.name,
            subject: `Invalid TEMP duration: ${tempDaysStr}`,
            text: `You replied **TEMP ${tempDaysStr}**, but duration must be between 1 and 365 days.\n\nPlease reply with a valid duration, e.g., **TEMP 7** for 7 days.`,
          });
        } catch (e) {
          console.error('Failed to send error modmail:', e);
        }
        return;
      }

      await context.reddit.banUser({
        subredditName: subreddit.name,
        username,
        duration: tempDays,
        reason: `StrikeManager: ${tempDays}-day temporary ban (reached ${config.threshold} strikes)`,
        note: `Approved via StrikeManager TEMP command (${tempDays} days)`,
      });

      // Notify user about temporary ban
      try {
        await context.reddit.sendPrivateMessageAsSubreddit({
          fromSubredditName: subreddit.name,
          to: username,
          subject: `Temporary ban issued in r/${subreddit.name}`,
          text: `You have been temporarily banned from r/${subreddit.name} for ${tempDays} days due to reaching the strike threshold. After the ban period expires, you will be able to participate again.`,
        });
      } catch (e) {
        console.error('Failed to notify user about temp ban:', e);
      }

      await dismissEscalation(context, subreddit.id, username);
      console.log(`u/${username} temporarily banned (${tempDays} days) via StrikeManager.`);
      return;
    }

    // Handle APPROVE (permanent or duration-based ban)
    if (isApprove) {
      const duration =
        config.banDuration > 0 ? config.banDuration : undefined;

      await context.reddit.banUser({
        subredditName: subreddit.name,
        username,
        duration,
        reason: `StrikeManager: reached ${config.threshold} active strikes`,
        note: 'Approved via StrikeManager escalation prompt',
      });

      // Notify user about permanent/long-term ban
      try {
        const banType = duration ? `${duration}-day` : 'permanent';
        await context.reddit.sendPrivateMessageAsSubreddit({
          fromSubredditName: subreddit.name,
          to: username,
          subject: `${banType} ban issued in r/${subreddit.name}`,
          text: `You have been ${banType} banned from r/${subreddit.name} due to reaching the strike threshold.`,
        });
      } catch (e) {
        console.error('Failed to notify user about ban:', e);
      }

      await dismissEscalation(context, subreddit.id, username);
      console.log(`u/${username} banned via StrikeManager approval.`);
    }
  },
});

// Strike Decay: Triggered when any warning is issued, checks for due decays
// (This runs opportunistically when mods are active, ensuring fairness)
async function checkAndApplyStrikeDecay(
  context: Devvit.Context,
  subredditId: string
): Promise<void> {
  const config = await loadConfig(context);

  // Only run if decay is enabled
  if (!config.decayDays || config.decayDays <= 0) {
    return;
  }

  // Check once per subreddit per day (use Redis to throttle)
  const lastDecayKey = `lastdecaycheck:${subredditId}`;
  const lastDecay = await context.redis.get(lastDecayKey);
  const now = Date.now();

  // Only check once per hour (avoid excessive processing)
  if (lastDecay && now - parseInt(lastDecay) < 3600000) {
    return;
  }

  const warnedUsers = await getAllWarnedUsers(context.redis, subredditId);
  const decayMs = config.decayDays * 86400000;
  const subreddit = await context.reddit.getCurrentSubreddit();
  let decayCount = 0;

  for (const username of warnedUsers) {
    const warnings = await getWarnings(context.redis, subredditId, username);
    if (warnings.length === 0) continue;

    // Sort by timestamp
    const sorted = [...warnings].sort((a, b) => a.timestamp - b.timestamp);
    const oldest = sorted[0];

    // Check if oldest warning is old enough for decay
    const ageMs = now - oldest.timestamp;

    if (ageMs >= decayMs) {
      const removed = await removeOldestStrike(
        context.redis,
        subredditId,
        username
      );

      if (removed) {
        decayCount++;
        const daysSinceOldest = (ageMs / 86400000).toFixed(1);
        console.log(
          `[StrikeDecay] Removed oldest strike from u/${username} (${daysSinceOldest} days old)`
        );

        // Notify user of strike decay
        try {
          await context.reddit.sendPrivateMessageAsSubreddit({
            fromSubredditName: subreddit.name,
            to: username,
            subject: `Your oldest warning has expired in r/${subreddit.name}`,
            text: `Great news! Due to good behavior, your oldest warning from ${new Date(oldest.timestamp).toLocaleDateString()} has been removed from your record. You now have a fresh start.`,
          });
        } catch (e) {
          console.error('Failed to notify user of strike decay:', e);
        }
      }
    }
  }

  // Update last decay check time
  await context.redis.set(lastDecayKey, String(now));
}

// AutoMod Bridge: Auto-issue strikes when AutoModerator removes content
Devvit.addTrigger({
  event: 'ModAction',
  onEvent: async (event, context) => {
    // Only process AutoModerator actions
    if (event.moderator?.name !== 'AutoModerator') {
      return;
    }

    // Only process removals
    if (event.action !== 'removelink' && event.action !== 'removecomment') {
      return;
    }

    const subreddit = await context.reddit.getCurrentSubreddit();
    const config = await loadConfig(context);

    // Check if AutoMod bridge is enabled
    if (!config.autoModEnabled) {
      return;
    }

    const targetUsername = event.targetUser?.name;
    if (!targetUsername) {
      return;
    }

    // CRITICAL: Rate limiting - don't re-strike same user within 60 seconds from AutoMod
    // This prevents API throttling when AutoMod removes multiple posts in quick succession
    const cooldownKey = `lastautostrike:${subreddit.id}:${targetUsername.toLowerCase()}`;
    const lastStrike = await context.redis.get(cooldownKey);
    const now = Date.now();
    
    if (lastStrike && now - parseInt(lastStrike) < 60000) {
      console.log(
        `[AutoMod Bridge] Cooldown active for u/${targetUsername}, skipping strike (will retry in ${Math.round((60000 - (now - parseInt(lastStrike))) / 1000)}s)`
      );
      return;
    }

    // Create warning with AutoMod as source
    const warning: Warning = {
      id: crypto.randomUUID(),
      username: targetUsername.toLowerCase(),
      rule: 'AutoModerator Removal',
      severity: 'minor',
      note: `Auto-detected removal by AutoModerator (${event.action === 'removelink' ? 'post' : 'comment'})`,
      modName: 'AutoModerator',
      postId: event.targetPost?.id ?? 'unknown',
      postUrl: event.targetPost?.url ?? 'unknown',
      timestamp: Date.now(),
      expired: false,
    };

    try {
      const newCount = await addWarning(
        context.redis,
        subreddit.id,
        warning,
        config.expiryDays
      );

      // Set cooldown after successful strike
      await context.redis.set(cooldownKey, String(now));

      // Add mod note
      try {
        await context.reddit.addModNote({
          subreddit: subreddit.name,
          user: targetUsername,
          note: `[StrikeManager-AutoMod] Auto-strike ${newCount}: Content removed by AutoModerator`,
          label: 'SPAM_WARNING',
          redditId: event.targetPost?.id?.startsWith('t')
            ? (event.targetPost.id as `t1_${string}` | `t3_${string}`)
            : undefined,
        });
      } catch (e) {
        console.warn('Failed to add AutoMod mod note (permissions?):', e);
      }

      // Notify user if enabled
      if (config.notifyUsers) {
        try {
          await sendUserNotification(
            context,
            targetUsername,
            subreddit.name,
            warning,
            newCount,
            config
          );
        } catch (e) {
          console.error('Failed to notify user of AutoMod strike:', e);
        }
      }

      // Escalate if threshold reached
      if (newCount >= config.threshold) {
        try {
          await sendEscalationPrompt(
            context,
            targetUsername,
            subreddit,
            newCount,
            config
          );
        } catch (e) {
          console.error('Failed to send AutoMod escalation:', e);
        }
      }

      console.log(
        `[AutoMod Bridge] Strike issued to u/${targetUsername} (${newCount}/${config.threshold})`
      );
    } catch (e) {
      console.error('AutoMod bridge error:', e);
    }
  },
});

export default Devvit;
