---
name: journal-reflect
description: End-of-session reflection — summarize what was accomplished and save insights to the journal.
allowed-tools: Bash(journal *)
user-invocable: true
---

# Session Reflection

Review what happened in this session and save key insights to the journal.

## Steps

1. Summarize the main tasks accomplished in this session
2. Identify any technical insights worth preserving
3. Note any decisions made and their rationale
4. Record observations about the user's working patterns or preferences
5. Save to journal using appropriate sections:

```bash
journal write \
  --project-notes "what was built/changed" \
  --technical-insights "what was learned" \
  --user-context "preferences or patterns noticed"
```

Keep entries concise. Focus on insights that would be valuable to recall later, not a play-by-play of the session.
