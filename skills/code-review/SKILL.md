---
name: code-review
description: Use when the user asks for a code review, PR review, diff review, bug-risk assessment, or wants feedback focused on correctness, regressions, missing tests, and maintainability.
tags: review, pr, diff, bugs, regression, testing
---

# Code Review

Use this skill when the task is to review code rather than implement it.

## Review Goal

Find the highest-value issues first:

1. correctness bugs
2. behavioral regressions
3. missing validation or error handling
4. security or data-loss risks
5. test coverage gaps
6. performance problems with real impact

Do not lead with style nits unless the user explicitly asks for style feedback.

## Review Workflow

1. Identify the review scope:
   - working tree changes
   - a commit or commit range
   - a branch diff
   - a specific file
2. Read the diff first, then inspect the surrounding implementation when something looks risky.
3. Trace changed code to inputs, side effects, and callers.
4. Look for assumptions that changed but were not updated everywhere.
5. Check whether tests cover the new behavior and the failure paths.

## What To Look For

### Correctness

- off-by-one or wrong-condition logic
- missing null/undefined handling
- async ordering bugs, race conditions, forgotten awaits
- stale state after refactors
- incorrect defaults or fallback behavior

### API and Data Boundaries

- schema mismatch between producer and consumer
- missing validation or normalization
- incompatible changes not reflected in callers
- silent failure paths that hide bad input

### State and Side Effects

- duplicated writes
- partial updates on failure
- resource leaks, unclosed handles, unremoved listeners
- retries that are not idempotent

### Tests

- changed logic without updated assertions
- happy-path only coverage
- missing edge cases and error-path coverage
- snapshots updated without verifying behavioral intent

## Output Format

- List findings first, ordered by severity.
- For each finding, include:
  - severity
  - concise explanation of the risk
  - file reference with line number when available
  - why it matters in real behavior
- Keep summaries brief and secondary.
- If no findings are present, say that explicitly and mention residual risks or untested areas.

## Review Mindset

- Be evidence-based; point to the exact code that supports the concern.
- Prefer a few strong findings over many weak guesses.
- Distinguish confirmed issues from plausible risks.
- If the change looks safe but cannot be fully validated, say what is missing.
