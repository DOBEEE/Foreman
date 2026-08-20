import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { config } from "../config/index.js";
import {
  exportTeamBundle,
  parseTeamBundle,
  type TeamExportOptions,
  type TeamExportResult,
} from "./bundle.js";
import {
  applyTeamImport,
  createTeamSnapshot,
  inspectTeamBundle,
  createDefaultImportPlan,
  listTeamSnapshots,
  restoreTeamSnapshot,
} from "./importer.js";
import type {
  TeamApplyResult,
  TeamImportInspection,
  TeamImportPlan,
} from "./types.js";

const RECORD_TTL_MS = 24 * 60 * 60 * 1000;
const CONFIRM_TTL_MS = 10 * 60 * 1000;

export interface ExportRecord {
  id: string;
  filename: string;
  createdAt: string;
  expiresAt: string;
  /**
   * 直接复用导出内核的 summary 类型，**不要在这里手抄一份形状**：
   * 抄一份的结果就是 bundle.ts 加了 carriedLiterals 而这里没跟上，
   * 字段悄悄消失在落盘记录里（类型报错只是恰好暴露了它）。
   */
  summary: TeamExportResult["summary"];
}

interface ImportRecord {
  id: string;
  filename: string;
  createdAt: string;
  expiresAt: string;
  status: "inspected" | "confirmed" | "applied" | "failed";
  plan: TeamImportPlan;
  confirmationHash?: string;
  confirmationExpiresAt?: string;
  /**
   * 本次确认是否为「整体覆盖」级别。apply 时要校验令牌等级与计划模式相符——
   * 否则可以用一个普通模式换来的令牌去 apply 一个被改成 replace_team 的计划。
   */
  confirmationElevated?: boolean;
  result?: TeamApplyResult;
  error?: string;
}

function root(): string {
  return join(config.runtimeDir, "team-bundles");
}
function exportDir(): string {
  return join(root(), "exports");
}
function importDir(): string {
  return join(root(), "imports");
}
function safeId(id: string): string {
  if (!/^[a-f0-9-]{8,64}$/.test(id)) throw new Error("记录 id 非法");
  return id;
}
function exportMeta(id: string): string {
  return join(exportDir(), `${safeId(id)}.json`);
}
function exportFile(id: string): string {
  return join(exportDir(), `${safeId(id)}.ait-team`);
}
function importMeta(id: string): string {
  return join(importDir(), `${safeId(id)}.json`);
}
function importFile(id: string): string {
  return join(importDir(), `${safeId(id)}.ait-team`);
}

function pendingChatFile(chatId: string): string {
  const hash = createHash("sha256").update(chatId).digest("hex").slice(0, 32);
  return join(root(), "pending-chats", `${hash}.json`);
}

function atomicJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  renameSync(temp, file);
}

function atomicBytes(file: string, bytes: Buffer): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, bytes);
  renameSync(temp, file);
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf-8")) as T;
}

function pruneRecords(dir: string): void {
  if (!existsSync(dir)) return;
  const now = Date.now();
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs > RECORD_TTL_MS) rmSync(path, { force: true });
    } catch {
      // ignore
    }
  }
}

export function createTeamExport(options: TeamExportOptions = {}): ExportRecord {
  pruneRecords(exportDir());
  const generated = exportTeamBundle(options);
  const id = randomUUID();
  const now = Date.now();
  const record: ExportRecord = {
    id,
    filename: generated.filename,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + RECORD_TTL_MS).toISOString(),
    summary: generated.summary,
  };
  atomicBytes(exportFile(id), generated.bytes);
  atomicJson(exportMeta(id), record);
  return record;
}

export function previewTeamExport(options: TeamExportOptions = {}) {
  const generated = exportTeamBundle(options);
  return {
    filename: generated.filename,
    meta: generated.envelope.payload.meta,
    scope: generated.envelope.payload.scope,
    agents: generated.envelope.payload.agents.map((a) => ({ id: a.id, displayName: a.displayName })),
    skills: generated.envelope.payload.skills.map((s) => s.name),
    mcps: generated.envelope.payload.mcps.map((m) => ({ name: m.name, bindings: m.requiredBindings.length })),
    dependencies: generated.envelope.payload.dependencies,
    security: generated.envelope.payload.security,
    /**
     * 会原样写进包里的 MCP 公开常量。**这是必须渲染给用户的**，不是可选信息：
     * 分级判定（bundle.ts classifyMcpValue）放行字面量靠的是启发式，
     * 而「下载前当着用户列出来」是唯一确定性的那道防线。
     */
    carriedLiterals: generated.summary.carriedLiterals,
    compressedBytes: generated.bytes.length,
  };
}

export function getTeamExport(id: string): { record: ExportRecord; path: string } {
  const record = readJson<ExportRecord>(exportMeta(id));
  if (Date.parse(record.expiresAt) <= Date.now()) throw new Error("导出文件已过期，请重新导出");
  const path = exportFile(id);
  if (!existsSync(path)) throw new Error("导出文件不存在");
  return { record, path };
}

function publicInspection(inspection: TeamImportInspection) {
  const { bundle, ...rest } = inspection;
  return {
    ...rest,
    package: {
      meta: bundle.payload.meta,
      scope: bundle.payload.scope,
      boss: bundle.payload.boss
        ? { name: bundle.payload.boss.name, role: bundle.payload.boss.role }
        : undefined,
      agents: bundle.payload.agents.map((a) => ({ id: a.id, displayName: a.displayName, description: a.description })),
      skills: bundle.payload.skills.map((s) => ({ name: s.name, description: s.description })),
      mcps: bundle.payload.mcps.map((m) => ({ name: m.name, scope: m.scope, bindings: m.requiredBindings.length })),
      dependencies: bundle.payload.dependencies,
      security: bundle.payload.security,
    },
  };
}

export function createTeamImport(bytes: Buffer, filename = "team.ait-team") {
  pruneRecords(importDir());
  const bundle = parseTeamBundle(bytes);
  const inspection = inspectTeamBundle(bundle);
  const id = randomUUID();
  const now = Date.now();
  const record: ImportRecord = {
    id,
    filename: filename.slice(0, 200),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + RECORD_TTL_MS).toISOString(),
    status: "inspected",
    plan: inspection.defaultPlans.add_employees,
  };
  atomicBytes(importFile(id), bytes);
  atomicJson(importMeta(id), record);
  return { record, inspection: publicInspection(inspection) };
}

export function setPendingTeamImport(chatId: string, importId: string): void {
  atomicJson(pendingChatFile(chatId), {
    importId: safeId(importId),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + RECORD_TTL_MS).toISOString(),
  });
}

export function getPendingTeamImport(chatId: string): string | undefined {
  const file = pendingChatFile(chatId);
  if (!existsSync(file)) return undefined;
  try {
    const value = readJson<{ importId: string; expiresAt: string }>(file);
    if (Date.parse(value.expiresAt) <= Date.now()) {
      rmSync(file, { force: true });
      return undefined;
    }
    // 同时确认对应导入会话仍存在且未过期。
    getTeamImport(value.importId);
    return value.importId;
  } catch {
    rmSync(file, { force: true });
    return undefined;
  }
}

export function clearPendingTeamImport(chatId: string): void {
  rmSync(pendingChatFile(chatId), { force: true });
}

function loadImport(id: string): { record: ImportRecord; inspection: TeamImportInspection } {
  const record = readJson<ImportRecord>(importMeta(id));
  if (Date.parse(record.expiresAt) <= Date.now()) throw new Error("导入会话已过期，请重新上传");
  const bundle = parseTeamBundle(readFileSync(importFile(id)));
  return { record, inspection: inspectTeamBundle(bundle) };
}

export function getTeamImport(id: string) {
  const { record, inspection } = loadImport(id);
  return { record: { ...record, confirmationHash: undefined }, inspection: publicInspection(inspection) };
}

export function updateTeamImportPlan(id: string, plan: TeamImportPlan) {
  const { record, inspection } = loadImport(id);
  // applyTeamImport 会做最终强校验；这里先检查所有选择都来自包，避免保存明显无效计划。
  const agents = new Set(inspection.bundle.payload.agents.map((a) => a.id));
  const skills = new Set(inspection.bundle.payload.skills.map((s) => s.name));
  const mcps = new Set(inspection.bundle.payload.mcps.map((m) => m.name));
  if (plan.selectedAgents.some((id) => !agents.has(id))) throw new Error("计划包含包外员工");
  if (plan.selectedSkills.some((id) => !skills.has(id))) throw new Error("计划包含包外 Skill");
  if (plan.selectedMcps.some((id) => !mcps.has(id))) throw new Error("计划包含包外 MCP");
  record.plan = plan;
  record.status = "inspected";
  delete record.confirmationHash;
  delete record.confirmationExpiresAt;
  atomicJson(importMeta(id), record);
  return { record: { ...record, confirmationHash: undefined } };
}

export function prepareStoredTeamImportPlan(
  id: string,
  input: {
    mode: TeamImportPlan["mode"];
    agentIds?: string[];
    includeBoss?: boolean;
    onConflict?: "keep" | "replace";
  },
): TeamImportPlan {
  const { inspection } = loadImport(id);
  const agentIds = input.agentIds?.length
    ? input.agentIds
    : inspection.bundle.payload.agents.map((a) => a.id);
  const plan = createDefaultImportPlan(inspection.bundle, input.mode, agentIds);
  if (input.includeBoss != null) plan.includeBoss = input.includeBoss;
  if (input.onConflict) {
    for (const id of Object.keys(plan.agentConflicts)) plan.agentConflicts[id] = { action: input.onConflict };
    for (const id of Object.keys(plan.skillConflicts)) plan.skillConflicts[id] = { action: input.onConflict };
    for (const id of Object.keys(plan.mcpConflicts)) plan.mcpConflicts[id] = { action: input.onConflict };
  }
  updateTeamImportPlan(id, plan);
  return plan;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function confirmTeamImport(
  id: string,
  opts: { acknowledgeReplace?: boolean } = {},
): { token: string; expiresAt: string; elevated: boolean } {
  const { record, inspection } = loadImport(id);
  if (!inspection.compatible) throw new Error(`团队包不可导入：${inspection.errors.join("；")}`);
  /**
   * 整体覆盖是这套流程里唯一会**删除**本地资产的模式（未包含的员工 / Skill / MCP 都会没），
   * 所以它要一次单独的、说得出口的确认，不能与「添加员工」共用同一条路径。
   */
  const elevated = record.plan.mode === "replace_team";
  if (elevated && !opts.acknowledgeReplace) {
    throw new Error(
      "整体覆盖需要更高级别的确认：它会删掉团队包里没有的本地员工、Skill 与 MCP。" +
        "请明确表达覆盖意图后重试（API 传 acknowledgeReplace: true）。",
    );
  }
  const token = randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + CONFIRM_TTL_MS).toISOString();
  record.status = "confirmed";
  record.confirmationHash = tokenHash(token);
  record.confirmationExpiresAt = expiresAt;
  record.confirmationElevated = elevated;
  atomicJson(importMeta(id), record);
  return { token, expiresAt, elevated };
}

function validToken(expected: string | undefined, actual: string): boolean {
  if (!expected) return false;
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(tokenHash(actual), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function applyStoredTeamImport(id: string, token: string): TeamApplyResult {
  const { record, inspection } = loadImport(id);
  if (record.status !== "confirmed") throw new Error("导入尚未确认");
  if (!record.confirmationExpiresAt || Date.parse(record.confirmationExpiresAt) <= Date.now()) {
    throw new Error("导入确认已过期，请重新确认");
  }
  if (!validToken(record.confirmationHash, token)) throw new Error("导入确认令牌无效");
  // 令牌等级必须与计划模式相符：否则可以先按「添加员工」拿一个令牌，
  // 再把计划改成整体覆盖（改计划虽然会清令牌，但这条是不依赖那个行为的独立防线）
  if (record.plan.mode === "replace_team" && !record.confirmationElevated) {
    throw new Error("这个令牌不是整体覆盖级别的确认，不能用来执行整体覆盖，请重新确认");
  }
  try {
    const result = applyTeamImport(inspection.bundle, record.plan);
    record.status = "applied";
    record.result = result;
    delete record.confirmationHash;
    delete record.confirmationElevated;
    atomicJson(importMeta(id), record);
    return result;
  } catch (error) {
    record.status = "failed";
    record.error = error instanceof Error ? error.message : String(error);
    delete record.confirmationHash;
    delete record.confirmationElevated;
    atomicJson(importMeta(id), record);
    throw error;
  }
}

export function teamBundleHistory() {
  const imports: Array<Omit<ImportRecord, "confirmationHash">> = [];
  if (existsSync(importDir())) {
    for (const file of readdirSync(importDir()).filter((f) => f.endsWith(".json"))) {
      try {
        const { confirmationHash: _hidden, ...record } = readJson<ImportRecord>(join(importDir(), file));
        imports.push(record);
      } catch { /* skip */ }
    }
  }
  return {
    imports: imports.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    snapshots: listTeamSnapshots(),
  };
}

export function rollbackTeamImport(snapshotId: string): { safetySnapshotId: string } {
  const safety = createTeamSnapshot(`回滚前安全快照：${snapshotId}`);
  try {
    restoreTeamSnapshot(snapshotId);
    return { safetySnapshotId: safety.id };
  } catch (error) {
    try { restoreTeamSnapshot(safety.id); } catch { /* 保留原错误 */ }
    throw error;
  }
}
