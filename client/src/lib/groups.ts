/* Activity groups colour the day ledger and time bars. Edit here to regroup activities. */
export interface Group { id: string; name: string; color: string; acts: string[] }

export const GROUPS: Group[] = [
  { id: "sleep", name: "Sleep", color: "var(--g-sleep)", acts: ["Sleep"] },
  { id: "work", name: "Work & study", color: "var(--g-work)", acts: ["Work", "Study", "Code"] },
  { id: "care", name: "Self-care", color: "var(--g-care)", acts: ["Exercise", "Meditate", "Eating", "Read"] },
  { id: "logi", name: "Logistics", color: "var(--g-logi)", acts: ["Commute", "Chores", "Kids"] },
  { id: "social", name: "Social & leisure", color: "var(--g-social)", acts: ["Social", "Leisure"] },
  { id: "other", name: "Other", color: "var(--g-other)", acts: ["Other"] },
];
const ACT_TO_GROUP = new Map(GROUPS.flatMap(g => g.acts.map(a => [a, g] as const)));
export const groupOf = (activity: string): Group => ACT_TO_GROUP.get(activity) ?? GROUPS[GROUPS.length - 1];

/* Feeling-wheel core emotions: +1 positive, -1 negative, 0 neutral */
export const MOOD_VAL: Record<string, number> = { Happy: 1, Surprised: 0, Sad: -1, Bad: -1, Angry: -1, Fearful: -1, Disgusted: -1 };
export const moodValue = (core: string): number => MOOD_VAL[core] ?? 0;
export const moodColor = (core: string): string => { const v = moodValue(core); return v > 0 ? "var(--pos)" : v < 0 ? "var(--neg)" : "var(--neu)"; };

export const OPEN_STATUSES = new Set(["inbox", "next", "waiting", "someday"]);
export const STATUS_LABELS: [string, string][] = [["inbox", "Inbox"], ["next", "Next"], ["waiting", "Waiting"], ["someday", "Someday"]];
