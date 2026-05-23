export type Severity = 'minor' | 'major' | 'severe';

export interface Warning {
  id: string;
  username: string;
  rule: string;
  severity: Severity;
  note: string;
  modName: string;
  postId: string;
  postUrl: string;
  timestamp: number;
  expired: boolean;
}

export interface SubredditConfig {
  threshold: number;
  banDuration: number;
  notifyUsers: boolean;
  expiryDays: number;
  customMessage: string;
  rules: string[];
  autoModEnabled?: boolean;
  decayDays?: number;
}

export interface RecentWarningSummary {
  username: string;
  rule: string;
  severity: Severity;
  modName: string;
  timestamp: number;
}
