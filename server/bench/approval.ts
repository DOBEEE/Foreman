import {
  approveHarvestedCase,
  discardHarvestedCase,
  pendingCasesBrief,
  resolvePendingCase,
} from "../core/case-harvest.js";
import {
  approveQualityUpgrade,
  discardQualityUpgrade,
  listPendingUpgrades,
  pendingUpgradesBrief,
} from "./upgrade.js";

/**
 * 待审项的统一入口。
 *
 * 有两类待审：**新用例**（一层，采集来的）与**升级草稿**（二层，命题人起草的）。
 * 刻意收在同一个批准动作下——用户只需要记一句「批准用例 xxx」，不必先搞清楚
 * 这条属于哪一层。分成两套动词只会让人记错，然后放着不管。
 *
 * 一条 case 不可能同时是两类待审（升级的前提是它已经晋升进套件），所以按 caseId
 * 定位不会歧义。
 */

export type ApprovalKind = "case" | "upgrade";

export interface ApprovalRef {
  kind: ApprovalKind;
  agentId: string;
  caseId: string;
}

export function resolveApproval(ref: string): ApprovalRef | undefined {
  const wanted = ref.trim();
  const [maybeAgent, maybeCase] = wanted.includes("/") ? wanted.split("/", 2) : [undefined, wanted];

  const pendingCase = resolvePendingCase(ref);
  if (pendingCase) return { kind: "case", agentId: pendingCase.agentId, caseId: pendingCase.caseId };

  const upgrade = listPendingUpgrades(maybeAgent).find((item) => item.caseId === maybeCase);
  if (upgrade) return { kind: "upgrade", agentId: upgrade.agentId, caseId: upgrade.caseId };

  return undefined;
}

export function approveByRef(target: ApprovalRef): { ok: boolean; message: string } {
  return target.kind === "case"
    ? approveHarvestedCase(target.agentId, target.caseId)
    : approveQualityUpgrade(target.agentId, target.caseId);
}

export function discardByRef(target: ApprovalRef): { ok: boolean; message: string } {
  return target.kind === "case"
    ? discardHarvestedCase(target.agentId, target.caseId)
    : discardQualityUpgrade(target.agentId, target.caseId);
}

/** 两类待审合成一段。都没有时返回 undefined，调用方据此决定「不打扰」 */
export function pendingApprovalsBrief(): string | undefined {
  const parts = [pendingCasesBrief(), pendingUpgradesBrief()].filter(
    (item): item is string => item !== undefined,
  );
  return parts.length ? parts.join("\n\n———\n\n") : undefined;
}
