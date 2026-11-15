/** Glossary of the words the interface uses, shown on the Help page. */
export const TERMS = {
  suspect: { themed: "Suspect", technical: "A commit that might have caused the problem, ranked by risk" },
  firstBad: { themed: "First bad commit", technical: "The earliest commit where the tests fail; everything before it passes" },
  riskScore: { themed: "Risk score", technical: "0 to 100, from what a commit changed. An estimate, not a probability" },
  evidence: { themed: "Evidence", technical: "The commit, file, line and code behind every claim" },
  impactMap: { themed: "Impact map", technical: "Which functions and files depend on the changed code" },
  goodBad: { themed: "Good and bad commit", technical: "The last version you know worked, and one you know is broken" },
  verifiedFix: { themed: "Verified fix", technical: "A proposed change that passed the checks; unverified until then" },
  report: { themed: "Report", technical: "A shareable write-up built only from what was found" },
} as const;

export const MODE_LABELS = {
  "quick-scan": { title: "Recent commits", description: "Check the latest commits on a branch." },
  "regression-hunt": { title: "Between good and bad", description: "Search between a version that worked and one that’s broken." },
  "single-commit": { title: "One commit", description: "Look closely at a single commit." },
  exploration: { title: "Browse history", description: "Look through history without assuming anything broke." },
  "ai-guided": { title: "Describe the bug", description: "Tell us the symptoms; they decide which commits come first." },
} as const;

export const FINDING_STATUS_LABELS = {
  suspected: "Likely cause",
  "test-confirmed": "Confirmed by tests",
  "unverified-hypothesis": "Possible cause",
  "insufficient-evidence": "Not enough evidence",
} as const;
