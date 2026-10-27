---
status: open
created: 2026-10-27
tags: [tooling]
---

# What runs before each commit?

## Question
With no CI, what checks run automatically before a commit?

## Context
Your standing rule: hooks finish in under a minute and run only fast checks on staged files; tests and slow type
checks run by hand before merging or pushing. Today the Python checks (ruff, pyright, pytest) run by hand.

## Options
- **A. A pre-commit hook** with secret scan, format and lint on staged files of the touched part (agents or web).
- **B. No hooks;** checks run by hand before each commit.

## Recommendation
A, matching your standing rule.

## Answer

