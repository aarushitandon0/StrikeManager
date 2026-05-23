import { clearPendingEscalation, trackPendingEscalation, } from './redis.js';
const ESCALATION_SUBJECT_PREFIX = '[StrikeManager] Action required';
export async function sendUserNotification(context, username, subredditName, warning, strikeCount, config) {
    const banLabel = config.banDuration === 0
        ? 'permanent'
        : `${config.banDuration}-day`;
    const nextAction = strikeCount >= config.threshold
        ? `You are now subject to a ban (${banLabel}). A moderator will review shortly.`
        : `You have ${strikeCount}/${config.threshold} active strikes. Reaching ${config.threshold} will result in a ban.`;
    // NEW: Build modmail appeal link for users to contest the warning
    const appealLink = `https://reddit.com/message/compose?to=/r/${subredditName}&subject=Appeal:%20Warning%20for%20${encodeURIComponent(warning.rule)}`;
    const body = `
Hi u/${username},

You have received a **warning** in r/${subredditName}.

**Rule violated:** ${warning.rule}
**Severity:** ${warning.severity}
**Related post:** ${warning.postUrl}

${nextAction}

---

**Want to appeal or discuss this warning?**
[Click here to message the mod team](${appealLink})

This is your opportunity to provide context or explain your side of the story.

— The r/${subredditName} moderation team
`.trim();
    await context.reddit.sendPrivateMessageAsSubreddit({
        fromSubredditName: subredditName,
        to: username,
        subject: `Warning issued in r/${subredditName}`,
        text: body,
    });
}
export async function sendEscalationPrompt(context, username, subreddit, strikeCount, config) {
    const banText = config.banDuration === 0
        ? 'permanently'
        : `for ${config.banDuration} days`;
    const body = `
**[StrikeManager] Escalation Alert**

User u/${username} has reached **${strikeCount} active strikes** (threshold: ${config.threshold}).

**Action options:**
- Reply **APPROVE** to ban ${banText} (as configured)
- Reply **TEMP 7** to temporarily ban for 7 days (replace 7 with any number)
- Reply **DISMISS** to take no action and clear this escalation

**To review their history first:** Check the Strike Manager dashboard or use the "View Strike History" context menu on any of their recent posts.

*This action requires explicit moderator approval and will not execute automatically.*
`.trim();
    const subject = `${ESCALATION_SUBJECT_PREFIX}: u/${username} hit ${strikeCount} strikes`;
    const conversationId = await context.reddit.modMail.createModDiscussionConversation({
        subredditId: subreddit.id,
        subject,
        bodyMarkdown: body,
    });
    await trackPendingEscalation(context.redis, subreddit.id, username, conversationId);
}
export function isEscalationSubject(subject) {
    return (subject ?? '').includes(ESCALATION_SUBJECT_PREFIX);
}
export function parseUsernameFromEscalationSubject(subject) {
    const match = subject.match(/u\/([\w-]+) hit/);
    return match?.[1];
}
export async function dismissEscalation(context, subredditId, username) {
    await clearPendingEscalation(context.redis, subredditId, username);
}
