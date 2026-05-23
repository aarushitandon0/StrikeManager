import { saveConfig } from './redis.js';
export var SettingName;
(function (SettingName) {
    SettingName["Threshold"] = "threshold";
    SettingName["BanDuration"] = "banDuration";
    SettingName["ExpiryDays"] = "expiryDays";
    SettingName["NotifyUsers"] = "notifyUsers";
    SettingName["Rules"] = "rules";
    SettingName["AutoModEnabled"] = "autoModEnabled";
    SettingName["DecayDays"] = "decayDays";
})(SettingName || (SettingName = {}));
export const appSettings = [
    {
        type: 'number',
        name: SettingName.Threshold,
        label: 'Strike threshold before escalation',
        helpText: 'How many active strikes triggers a mod escalation prompt',
        defaultValue: 3,
    },
    {
        type: 'number',
        name: SettingName.BanDuration,
        label: 'Suggested ban duration (days, 0 = permanent)',
        defaultValue: 7,
    },
    {
        type: 'number',
        name: SettingName.ExpiryDays,
        label: 'Strike expiry (days)',
        helpText: 'Warnings older than this many days do not count toward the threshold',
        defaultValue: 180,
    },
    {
        type: 'boolean',
        name: SettingName.NotifyUsers,
        label: 'Notify users when warned',
        defaultValue: true,
    },
    {
        type: 'paragraph',
        name: SettingName.Rules,
        label: 'Subreddit rules (one per line)',
        defaultValue: 'Rule 1: No spam\nRule 2: Be respectful\nRule 3: No self-promotion',
        lineHeight: 6,
    },
    {
        type: 'boolean',
        name: SettingName.AutoModEnabled,
        label: 'Enable AutoMod Bridge',
        helpText: 'Automatically issue strikes when AutoModerator removes content',
        defaultValue: false,
    },
    {
        type: 'number',
        name: SettingName.DecayDays,
        label: 'Strike decay period (days, 0 = disabled)',
        helpText: 'After this many days of good behavior, oldest strike is removed (daily check)',
        defaultValue: 0,
    },
];
export async function loadConfig(context) {
    const subreddit = await context.reddit.getCurrentSubreddit();
    const threshold = (await context.settings.get(SettingName.Threshold)) ?? 3;
    const banDuration = (await context.settings.get(SettingName.BanDuration)) ?? 7;
    const expiryDays = (await context.settings.get(SettingName.ExpiryDays)) ?? 180;
    const notifyUsers = (await context.settings.get(SettingName.NotifyUsers)) ?? true;
    const autoModEnabled = (await context.settings.get(SettingName.AutoModEnabled)) ?? false;
    const decayDays = (await context.settings.get(SettingName.DecayDays)) ?? 0;
    const rulesRaw = (await context.settings.get(SettingName.Rules)) ?? '';
    const rules = rulesRaw
        .split('\n')
        .map((r) => r.trim())
        .filter((r) => r.length > 0);
    const config = {
        threshold,
        banDuration,
        notifyUsers,
        expiryDays,
        autoModEnabled,
        decayDays,
        customMessage: `You have received a warning in r/${subreddit.name}.`,
        rules: rules.length > 0 ? rules : ['Rule 1', 'Rule 2', 'Rule 3'],
    };
    await saveConfig(context.redis, subreddit.id, config);
    return config;
}
