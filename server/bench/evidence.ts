import fs from "node:fs";
import path from "node:path";
import { BenchmarkCase, ExecutionRecord, RunPaths } from "./types.js";
import { readJson, writeJson } from "./files.js";

/**
 * 通用质量证据组装。
 *
 * Provenance：逐字照搬 agent-bench 的 `src/evaluation/evidence.ts` 的
 * prepareGenericQualityEvidence（连同 parseJsonLines / productFiles 等私有函数），
 * 只做两处适配：case 形态换成 foreman 的（promptFile 取代 meta.input）、
 * 去掉 AIT 专属的 fe-migrate 事实源分支。
 *
 * **evidence 的字段结构不能动**：四份 rubric 直接按这个结构取证，
 * 改一个键名就等于悄悄改了判据。
 */

interface TraceEvent {
  id: string;
  sequence: number;
  tool: string;
  input: unknown;
  result: unknown;
  source: string;
}

function parseJsonLines(file: string): TraceEvent[] {
  if (!fs.existsSync(file)) return [];
  const events: TraceEvent[] = [];
  for (const [index, line] of fs.readFileSync(file, 'utf8').split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      const message = record.message as Record<string, unknown> | undefined;
      const blocks = message?.content;
      if (Array.isArray(blocks)) {
        for (const block of blocks as Array<Record<string, unknown>>) {
          if (block.type === 'tool_use') events.push({ id: String(block.id || `tool-${events.length + 1}`), sequence: events.length, tool: String(block.name || 'unknown'), input: block.input ?? {}, result: null, source: file });
        }
      }
      const tool = record.tool as Record<string, unknown> | undefined;
      if (tool?.name) events.push({ id: String(record.id || `tool-${events.length + 1}`), sequence: events.length, tool: String(tool.name), input: tool.input ?? {}, result: tool.result ?? null, source: file });
    } catch {
      // A non-JSON display line cannot be reconstructed into a tool event.
    }
  }
  return events;
}

function readText(file: string): string | null {
  return fs.existsSync(file) && fs.statSync(file).isFile() ? fs.readFileSync(file, 'utf8') : null;
}

function productFiles(root: string): string[] {
  const files: string[] = [];
  const ignored = new Set(['node_modules', '.git', '.benchmark', 'dist', 'coverage', 'test-results']);
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && ignored.has(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && /\.(?:ts|tsx|js|jsx|json|md)$/.test(entry.name) && fs.statSync(file).size < 1024 * 1024) files.push(file);
    }
  };
  walk(root);
  return files.slice(0, 200);
}

export function prepareGenericQualityEvidence(params: {
  benchmarkCase: BenchmarkCase;
  paths: RunPaths;
  execution: ExecutionRecord;
  artifact?: string;
  knowledgeRoot?: string;
}): string {
  const { benchmarkCase, paths, execution, artifact, knowledgeRoot } = params;
  const conventions = benchmarkCase.conventionsPath ? readJson<{ items: Array<Record<string, unknown>> }>(benchmarkCase.conventionsPath) : { items: [] };
  const resolvedConventions = conventions.items.map((item) => {
    const document = String(item.document || '');
    const knowledgeFile = knowledgeRoot && document ? path.join(knowledgeRoot, document) : '';
    const ruleText = knowledgeFile ? readText(knowledgeFile) : null;
    return { ...item, resolutionStatus: ruleText ? 'resolved' : 'unresolved', ruleText, sourceFiles: artifact ? [artifact] : [] };
  });
  const traceConfig = readJson<{ assertions?: Array<Record<string, unknown>> }>(path.join(paths.oracle, 'trace.json'));
  const events = parseJsonLines(execution.transcriptFile);
  // 键名 prd 刻意保留：rubric 里引用的就是 truthSources.prd（在 agent-service
  // 这条链路上它的含义是「提问原文」，rubric 已按此表述）。改键名等于改 rubric。
  const truthSources = {
    prd: benchmarkCase.promptFile,
    requirements: path.join(paths.oracle, 'requirements.json'),
  };
  const evidence = {
    schemaVersion: 1,
    caseFingerprint: benchmarkCase.fingerprint,
    execution,
    artifact: artifact ? { file: artifact, content: readText(artifact) } : null,
    truthSources,
    claimSourceFiles: artifact ? [artifact] : productFiles(paths.workspace),
    structuredClaims: [],
    conventions: { items: resolvedConventions },
    trace: {
      integrity: { complete: true, source: execution.transcriptFile },
      events,
      messages: [],
      assertions: traceConfig.assertions ?? [],
      errorCandidates: events.filter((item) => JSON.stringify(item.result).match(/error|fail|exception/i)).map((item) => ({ id: `ERR-${item.id}`, eventId: item.id })),
    },
    runtime: { gates: null, playwright: null, completion: null },
  };
  const output = path.join(paths.root, 'quality-evidence.json');
  writeJson(output, evidence);
  return output;
}
