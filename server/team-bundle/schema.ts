import { z } from "zod";
import { TEAM_BUNDLE_FORMAT, TEAM_BUNDLE_VERSION } from "./types.js";

const stringArray = z.array(z.string()).max(256);
const sopStep = z
  .object({
    id: z.string(),
    title: z.string(),
    mode: z.enum(["self", "delegate"]).optional(),
    prompt: z.string(),
    delegate: z.string().optional(),
    reviewer: z.string().optional(),
    accept: z.string().optional(),
    maxRetries: z.number().int().min(0).max(20).optional(),
    maxTurns: z.number().int().min(1).max(500).optional(),
    produces: z
      .object({
        files: stringArray.optional(),
        data: z.record(z.string(), z.string()).optional(),
      })
      .strict()
      .optional(),
    needs: stringArray.optional(),
  })
  .strict();

export const portableAgentSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{1,39}$/),
    displayName: z.string().max(100).optional(),
    avatar: z.string().max(2048).optional(),
    description: z.string().max(4000).optional(),
    routeHint: z.string().max(8000).optional(),
    type: z.enum(["simple", "sop"]).optional(),
    systemPrompt: z.string().max(200_000).optional(),
    steps: z.array(sopStep).max(100).optional(),
    tools: stringArray.optional(),
    mcpServers: stringArray.optional(),
    skills: stringArray.optional(),
    workspacePolicy: z.enum(["shared", "per-chat", "per-task", "per-run"]).optional(),
    // 上限这里只做粗筛（bundle 可能来自别人的机器，全局闸值不同）；
    // 真正按本机 config.maxConcurrentRuns 复核的是 validateAgentProfile
    maxParallel: z.number().int().min(1).max(64).optional(),
    reviewer: z.string().regex(/^[a-z][a-z0-9_-]{1,39}$/).optional(),
    retro: z
      .object({ enabled: z.boolean(), distill: stringArray.optional(), exclude: stringArray.optional() })
      .strict()
      .optional(),
    routeFallback: z.boolean().optional(),
    manualOnly: z.boolean().optional(),
    stream: z.boolean().optional(),
    paramsSchema: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const portableSkill = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    description: z.string().max(4000),
    raw: z.string().max(500_000),
  })
  .strict();

const binding = z
  .object({
    placeholder: z.string().regex(/^[A-Z][A-Z0-9_]{1,127}$/),
    kind: z.enum(["secret", "path"]),
    target: z.enum(["env", "header", "command", "arg", "url"]),
    key: z.string().max(200).optional(),
    index: z.number().int().min(0).max(1000).optional(),
  })
  .strict();

const portableMcp = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
    scope: z.enum(["global", "optional"]),
    decl: z
      .object({
        type: z.enum(["stdio", "sse", "http"]),
        command: z.string().max(4096).optional(),
        args: z.array(z.string().max(16_384)).max(256).optional(),
        env: z.record(z.string(), z.string()).optional(),
        url: z.string().max(16_384).optional(),
        headers: z.record(z.string(), z.string()).optional(),
      })
      .strict(),
    requiredBindings: z.array(binding).max(512),
  })
  .strict();

export const teamBundlePayloadSchema = z
  .object({
    meta: z
      .object({
        id: z.string().min(8).max(100),
        name: z.string().min(1).max(200),
        description: z.string().max(4000).optional(),
        createdAt: z.string(),
        sourceVersion: z.string().max(100).optional(),
      })
      .strict(),
    scope: z
      .object({
        kind: z.enum(["full", "employees", "custom"]),
        includeBoss: z.boolean(),
        requestedAgents: stringArray.optional(),
      })
      .strict(),
    boss: z
      .object({
        name: z.string().max(100),
        role: z.string().max(1000),
        personality: z.string().max(10_000),
        style: z.string().max(10_000),
        team: z.string().max(10_000).optional(),
        avatar: z.string().max(2048).optional(),
        employees: z.record(z.string(), z.string()).optional(),
      })
      .strict()
      .optional(),
    agents: z.array(portableAgentSchema).max(256),
    skills: z.array(portableSkill).max(512),
    mcps: z.array(portableMcp).max(256),
    dependencies: z
      .object({ builtinAgents: stringArray, builtinSkills: stringArray, builtinMcps: stringArray })
      .strict(),
    security: z.object({ excluded: stringArray, warnings: stringArray }).strict(),
  })
  .strict();

export const teamBundleEnvelopeSchema = z
  .object({
    format: z.literal(TEAM_BUNDLE_FORMAT),
    version: z.literal(TEAM_BUNDLE_VERSION),
    payload: teamBundlePayloadSchema,
    integrity: z
      .object({ algorithm: z.literal("sha256"), digest: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict(),
  })
  .strict();
