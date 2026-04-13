@.claude/project-skills.md

# Context

## MANDATORY: this file

Never edit this file.

## MANDATORY: Session Start Protocol

Read @docs/context/session-start-protocol.md

## MANDATORY: Saving Context

Read @docs/context/saving-context.md

### MANDATORY: MEMORY.md

If you need to write anything in a MEMORY.md file, do it in the folder of the coordinator or worker project, not in the
root folder of this project.

## IMPORTANT

If any mismatch/inconsistency between codebase and README.md files, codebase take precedence.

---

# MANDATORY: Before considering the task done

# Project Overview

This folder is the **monorepo container** for a distributed TypeScript/Python scraping pipeline
that collects TypeScript code samples for LLM training data.

## Subprojects

### `llm-scraping-coordinator/` — TypeScript / Node.js

Orchestrates the scraping fleet. Distributes work to workers via Redis queues and exposes an
HTTP API that workers poll.

### `llm-scraping-worker/` — Python

Runs on each worker node. Fetches tasks from the coordinator, scrapes TypeScript files from
HuggingFace and GitHub, deduplicates, formats for FIM training, and posts results back.
