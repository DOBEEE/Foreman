---
name: hire-employee
description: "Use when the user asks to hire, add, or configure a persistent employee agent. Design a simple or SOP role, confirm risky tool access, validate the profile, and save it with save_employee."
---

# Hire Employee

Create a configuration-driven employee; do not write code or config files directly. A successfully saved profile is hot-loaded and immediately routable.

Two employee shapes:

1. **simple** — one prompt-driven responsibility with one main output.
2. **sop** — a fixed multi-step workflow whose lead may delegate and review bounded retries. Nesting depth is capped at 2.

## Steps

1. **Decide the shape** (`simple` or `sop`). Ask only if the distinction materially affects the requested role.

2. **Draft the profile**, inferring safe defaults and asking only for decisions that matter.
   - `id`, `displayName`, `description` — unique slug, display name, and one-line responsibility.
   - `routeHint` — required routing card with both `【选我当】` and `【别选我当】`; compare adjacent existing roles and name the handoff target where useful.
   - `systemPrompt` — draft a complete usable version. For sop, this is the lead's main context (identity, acceptance tone, reporting voice); step-level instructions live in `steps`.
   - `type` — `simple` or `sop`.
   - `tools`, `mcpServers`, `model`, `maxThinkingTokens` (default **5000**), `maxTurns`, `workspacePolicy`, and `skills` — optional. The save tool always assigns `workspace: "auto"`; do not ask for or submit a custom workspace. Use `shared` by default and recommend `per-chat` for roles that edit files or run commands.

3. **Confirm privileged access (mandatory)**. Default to read-only tools. Before granting any high-privilege tool or MCP write capability, obtain explicit user confirmation with a plain-language explanation of what it can change. Do not ask again when the user already granted that exact access in the current request.

4. **If sop — design `steps[]`**:
   - Each step: `id`, `title`, `mode` (`self` | `delegate`), and `prompt` (supports `{{input}}`, `{{param.xxx}}`, `{{step:<earlier id>}}`). Delegate steps also require an existing employee `delegate`; use `accept` where quality can be evaluated. `reviewer`, `maxRetries` (default 2), and `maxTurns` are optional.
   - Order = dependency; pass earlier conclusions explicitly via `{{step:<id>}}`.
   - Prefer observable acceptance criteria on quality-critical delegate steps.
   - Nesting depth is limited to 2 — don't design deeper chains.

5. **Validate** id uniqueness/legality, required fields including `routeHint`, and non-empty SOP steps. Every `delegate` and `reviewer` must name an existing non-HR employee. Never persist a half-formed config.

6. **Persist** by calling the `save_employee` tool (hr has no file-write ability — this is the only way to land a config; pass `overwrite: true` only when deliberately replacing an existing employee). Then briefly report the new hire (id, type, responsibilities, granted tools, workspacePolicy, and for sop the step outline + roster) and note that it's effective now.

## Boundaries

- Only create/configure employees. Do not run business tasks or modify existing builtin roles.
- Never put secrets or private data in a config.
- Keep it concise; think before writing to avoid rework.
