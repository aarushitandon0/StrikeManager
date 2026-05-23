const warningsKey = (subId, user) => `strikes:${subId}:${user}`;
const countKey = (subId, user) => `strikescount:${subId}:${user}`;
const recentKey = (subId) => `recentwarnings:${subId}`;
const configKey = (subId) => `config:${subId}`;
const pendingKey = (subId) => `pendingescalations:${subId}`;
const atRiskKey = (subId) => `atrisk:${subId}`;
export async function addWarning(redis, subId, warning, expiryDays) {
    const key = warningsKey(subId, warning.username);
    const existing = await getWarnings(redis, subId, warning.username);
    const now = Date.now();
    const expiryMs = expiryDays * 86400000;
    const updated = existing.map((w) => ({
        ...w,
        expired: w.expired || now - w.timestamp > expiryMs,
    }));
    updated.push(warning);
    await redis.set(key, JSON.stringify(updated));
    const activeCount = updated.filter((w) => !w.expired).length;
    await redis.set(countKey(subId, warning.username), String(activeCount));
    await redis.zAdd(recentKey(subId), {
        score: warning.timestamp,
        member: JSON.stringify({
            username: warning.username,
            rule: warning.rule,
            severity: warning.severity,
            modName: warning.modName,
            timestamp: warning.timestamp,
        }),
    });
    await redis.zRemRangeByRank(recentKey(subId), 0, -101);
    const config = await getConfig(redis, subId);
    if (activeCount >= config.threshold - 1) {
        await redis.hSet(atRiskKey(subId), {
            [warning.username]: String(activeCount),
        });
    }
    else {
        await redis.hDel(atRiskKey(subId), [warning.username]);
    }
    return activeCount;
}
export async function getWarnings(redis, subId, username) {
    const raw = await redis.get(warningsKey(subId, username));
    if (!raw)
        return [];
    return JSON.parse(raw);
}
export async function getStrikeCount(redis, subId, username) {
    const raw = await redis.get(countKey(subId, username));
    return raw ? parseInt(raw, 10) : 0;
}
export async function getRecentWarnings(redis, subId, limit = 20) {
    const results = await redis.zRange(recentKey(subId), 0, limit - 1, {
        reverse: true,
        by: 'rank',
    });
    return results.map((r) => JSON.parse(r.member));
}
export async function getConfig(redis, subId) {
    const raw = await redis.get(configKey(subId));
    if (raw)
        return JSON.parse(raw);
    return {
        threshold: 3,
        banDuration: 7,
        notifyUsers: true,
        expiryDays: 180,
        customMessage: 'You have received a warning in r/{{subreddit}}.',
        rules: ['Rule 1', 'Rule 2', 'Rule 3'],
    };
}
export async function saveConfig(redis, subId, config) {
    await redis.set(configKey(subId), JSON.stringify(config));
}
export async function trackPendingEscalation(redis, subId, username, conversationId) {
    await redis.hSet(pendingKey(subId), { [username]: conversationId });
}
export async function clearPendingEscalation(redis, subId, username) {
    await redis.hDel(pendingKey(subId), [username]);
}
export async function getPendingEscalationCount(redis, subId) {
    const all = await redis.hGetAll(pendingKey(subId));
    return Object.keys(all).length;
}
export async function countAtRiskUsers(redis, subId) {
    const atRisk = await redis.hGetAll(atRiskKey(subId));
    return Object.keys(atRisk).length;
}
export async function getAllWarnedUsers(redis, subId) {
    // Get all at-risk users (those with active warnings)
    const atRisk = await redis.hGetAll(atRiskKey(subId));
    return Object.keys(atRisk);
}
export async function removeOldestStrike(redis, subId, username) {
    const warnings = await getWarnings(redis, subId, username);
    if (warnings.length === 0)
        return false;
    // Sort by timestamp to find oldest
    const sorted = [...warnings].sort((a, b) => a.timestamp - b.timestamp);
    const oldest = sorted[0];
    // Remove oldest and mark as expired
    const updated = warnings
        .filter((w) => w.id !== oldest.id)
        .map((w) => ({
        ...w,
        expired: w.expired || w.timestamp === oldest.timestamp,
    }));
    await redis.set(warningsKey(subId, username), JSON.stringify(updated));
    // Recalculate active count
    const activeCount = updated.filter((w) => !w.expired).length;
    await redis.set(countKey(subId, username), String(activeCount));
    // Update at-risk status
    const config = await getConfig(redis, subId);
    if (activeCount >= config.threshold - 1) {
        await redis.hSet(atRiskKey(subId), { [username]: String(activeCount) });
    }
    else {
        await redis.hDel(atRiskKey(subId), [username]);
    }
    return true;
}
