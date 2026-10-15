# Cr8or Studio

Cr8or Studio is a private, single-owner, parallel multi-agent AI software engineering workspace.

Instead of one assistant, Cr8or Studio runs a team of specialized agents coordinated by a Master Orchestrator. The user submits one request and receives one unified output.

## Stack

- Next.js 15 (App Router)
- React 19
- TypeScript
- Tailwind CSS
- shadcn/ui
- PostgreSQL + Prisma ORM
- Supabase (auth/data integration)
- Vercel-ready deployment model

## Current Architecture

### 1) Master Orchestrator

The orchestrator receives each user prompt, decomposes it into agent tasks, schedules work, and synthesizes one response.

- File: `src/lib/agents/orchestrator.ts`
- API endpoint: `src/app/api/orchestrate/route.ts`

### 2) Parallel Agent Runtime

Agents are modeled as independent specialists with explicit dependencies.

- Agent catalog: `src/lib/agents/catalog.ts`
- Scheduler (DAG, parallel batches): `src/lib/agents/scheduler.ts`
- Executor runtime: `src/lib/agents/executor.ts`
- Contracts/types: `src/lib/agents/types.ts`

This enables parallel-by-default execution while preserving dependency correctness.

### 3) Memory Model

Two memory scopes are implemented in the runtime:

- Global memory (shared by all agents)
- Local memory (per-agent notes and decisions)

- File: `src/lib/agents/memory.ts`

### 4) Workspace UI

The UI includes:

- Left sidebar: projects, explorer, tasks, docs, memory
- Center: command input, dashboard, timeline, synthesis cards
- Right sidebar: assistant feed
- Bottom panel: terminal/console/log/debug strip

- Page: `src/app/page.tsx`
- Shell: `src/components/workspace/workspace-shell.tsx`

## Database and Env

- Prisma schema: `prisma/schema.prisma`
- Env template: `.env.example`
- Prisma client helper: `src/lib/db/prisma.ts`
- Supabase helper: `src/lib/supabase/server.ts`

Database migrations are an explicit release step. Run `npm run db:migrate` with
the intended database connection in a controlled environment before deploying
code that requires new tables. Importing the Prisma helper and running the
application do not execute migrations. `prisma/manual-schema.sql` is an empty
database bootstrap snapshot, not an incremental migration for an existing
database.

Task 1A-1 adds the singleton owner, revocable session, and distributed
authentication-attempt persistence foundation. It does not provision an owner,
activate authentication, or change the existing routes and authentication flag.
See [the authentication foundation guide](docs/private-authentication-foundation.md)
for the schema, session interfaces, release procedure, isolated database tests,
and remaining activation work.

## Getting Started

1. Install dependencies:

```bash
npm install
```

2. Copy env template and set real values:

```bash
cp .env.example .env
```

3. Run development server:

```bash
npm run dev
```

4. Open http://localhost:3000

## Next Build Phases

1. Persist orchestration runs and memory in PostgreSQL via Prisma.
2. Replace simulated executor with real LLM/tool adapters per agent.
3. Add real-time streaming over Server-Sent Events or WebSockets.
4. Complete private single-owner access-code authentication and protected project
   access, then add owner-enrolled passkeys. No public registration or multi-user
   onboarding is planned.
5. Add Git integration, deployment recipes, and autonomous long-running task mode.

## Delivery Roadmap

- Milestone program: docs/workspace-milestones.md
- Execution tracker: docs/milestone-tracker.md
