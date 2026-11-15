import type { LucideIcon } from "lucide-react";
import { Activity, BookOpen, Bookmark, Bot, FileText, GitCompare, History, LayoutGrid, Network, Plus, Search, Settings, Wrench, HeartPulse } from "lucide-react";

export interface NavItem {
  path: string;
  label: string;
  /** One line on what the page is for; shown as the link's tooltip. */
  tech: string;
  icon: LucideIcon;
  key?: string;
}

export const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: "Start",
    items: [
      { path: "/mission", label: "Overview", tech: "Summary of the current investigation", icon: LayoutGrid, key: "1" },
      { path: "/portal", label: "New investigation", tech: "Pick a repository and the commits to check", icon: Plus, key: "2" },
    ],
  },
  {
    section: "Investigate",
    items: [
      { path: "/breakage", label: "Suspects", tech: "Commits most likely to have caused the problem", icon: Search, key: "3" },
      { path: "/timeline", label: "Commit history", tech: "Every commit in the range, in order", icon: History, key: "4" },
      { path: "/divergence", label: "Compare commits", tech: "See exactly what changed between two commits", icon: GitCompare, key: "5" },
      { path: "/infection", label: "Impact map", tech: "Which code depends on what changed", icon: Network, key: "6" },
      { path: "/gemma", label: "Ask AI", tech: "Explanations and answers from Gemma, with sources", icon: Bot, key: "7" },
    ],
  },
  {
    section: "Resolve",
    items: [
      { path: "/restore", label: "Fix and verify", tech: "Proposed fixes and whether they pass the checks", icon: Wrench, key: "8" },
      { path: "/reports", label: "Reports", tech: "Shareable write-ups of an investigation", icon: FileText, key: "9" },
    ],
  },
  {
    section: "Library",
    items: [
      { path: "/saved", label: "Saved investigations", tech: "Everything you have investigated", icon: Bookmark },
      { path: "/health", label: "Repository health", tech: "Activity, churn and risk over time", icon: HeartPulse },
    ],
  },
  {
    section: "More",
    items: [
      { path: "/settings", label: "Settings", tech: "AI model, GitHub access and defaults", icon: Settings },
      { path: "/docs", label: "Help", tech: "How CausalCI works", icon: BookOpen },
    ],
  },
];

export const ALL_NAV = NAV.flatMap((s) => s.items);
export { Activity };
