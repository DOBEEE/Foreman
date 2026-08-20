/**
 * 跨渠道身份归一校验（零 LLM，纯断言）。
 *
 * 守的不变式：
 * 1. mode=off 时本模块完全透明（多租户不得启用）
 * 2. 未声明身份时恒等返回——所以入站处可以无条件接这个函数
 * 3. principal id 沿用主渠道原生私聊 id → 该渠道 chatId 纹丝不动（存量零迁移）
 * 4. 非法配置只跳过该项并告警，不静默丢整份配置
 * 5. 同一渠道身份绑给两个 principal 时只认前者（绑错会把两个人的会话混在一起）
 *
 * 用法：npx tsx server/core/__fixtures__/check-identity.ts
 */

import { config } from "../../config/index.js";
import {
  identityMode,
  listPrincipals,
  principalOf,
  resolvePrivateChatId,
} from "../identity.js";

let pass = 0;
const fails: string[] = [];

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    pass++;
    process.stdout.write(`  \u2705 ${label}\n`);
  } else {
    fails.push(label);
    process.stdout.write(`  \u274C ${label}${detail ? ` — ${detail}` : ""}\n`);
  }
}

/** config 是带热更的 Proxy，夹具里就地改这两个字段（与 check-channels 同一套做法） */
const identity = config.identity as {
  mode: string;
  principals: Array<{
    id?: string;
    label?: string;
    bindings?: Array<{ channel?: string; senderId?: string }>;
  }>;
};

const STAFF = "10086";
/** CLI 的 senderId 与原生 chatId 刻意不同，用来守回落取的是哪一个 */
const CLI_CHAT = "cli:local";

function setup(
  mode: string,
  principals: typeof identity.principals,
): void {
  identity.mode = mode;
  identity.principals = principals;
}

function main(): void {
  // 环境变量会参与 mode 回落，夹具里清掉以免受运行环境影响
  delete process.env.IDENTITY_MODE;

  process.stdout.write("\n▶ mode 闸门\n");
  setup("off", [
    { id: STAFF, bindings: [{ channel: "dingtalk", senderId: STAFF }, { channel: "cli", senderId: "local" }] },
  ]);
  check("mode=off 时 identityMode 为 off", identityMode() === "off");
  check("mode=off 时不加载任何 principal", listPrincipals().length === 0);
  check(
    "mode=off 时 CLI 不归一（多租户下这是安全底线）",
    resolvePrivateChatId("cli", "local", CLI_CHAT) === CLI_CHAT,
  );

  process.stdout.write("\n▶ 未声明身份 = 原样返回原生 chatId\n");
  setup("single-user", []);
  check("mode=single-user 生效", identityMode() === "single-user");
  check(
    "没有声明时钉钉私聊恒等返回 staffId",
    resolvePrivateChatId("dingtalk", STAFF, STAFF) === STAFF,
  );
  // 这条守一个真出过的 bug：回落必须取原生 chatId，不能取 senderId。
  // CLI 的 senderId 是 local 而原生 chatId 是 cli:local，取错会把没配身份的用户
  // 静默搬到 local 这个新 chatId 上，孤立他全部历史会话与任务。
  check(
    "没有声明时 CLI 回落原生 chatId（不是 senderId）",
    resolvePrivateChatId("cli", "local", CLI_CHAT) === CLI_CHAT,
    resolvePrivateChatId("cli", "local", CLI_CHAT),
  );

  process.stdout.write("\n▶ 归一\n");
  setup("single-user", [
    {
      id: STAFF,
      label: "我",
      bindings: [
        { channel: "dingtalk", senderId: STAFF },
        { channel: "cli", senderId: "local" },
      ],
    },
  ]);
  check(
    "声明后 CLI 归一到 principal id",
    resolvePrivateChatId("cli", "local", CLI_CHAT) === STAFF,
  );
  // 这条是「存量零迁移」的核心：钉钉侧 chatId 必须一个字都不变
  check(
    "钉钉私聊 chatId 保持不变",
    resolvePrivateChatId("dingtalk", STAFF, STAFF) === STAFF,
  );
  check("未绑定的渠道身份仍恒等", resolvePrivateChatId("feishu", "ou_x", "ou_x") === "ou_x");
  check(
    "同渠道其他人不受影响",
    resolvePrivateChatId("dingtalk", "99999", "99999") === "99999",
  );
  check("principalOf 能反查", principalOf("cli", "local")?.id === STAFF);
  check("principalOf 对未绑定返回 undefined", principalOf("feishu", "ou_x") === undefined);
  check("label 被保留", listPrincipals()[0]?.label === "我");

  process.stdout.write("\n▶ 非法配置\n");
  setup("single-user", [
    { bindings: [{ channel: "cli", senderId: "local" }] }, // 缺 id
    { id: "p2", bindings: [] }, // 无 binding
    { id: "p3", bindings: [{ channel: "cli" }] }, // binding 缺 senderId
    { id: STAFF, bindings: [{ channel: "dingtalk", senderId: STAFF }] }, // 合法
  ]);
  const kept = listPrincipals();
  check("非法项被逐个跳过，合法项仍生效", kept.length === 1 && kept[0].id === STAFF, JSON.stringify(kept));
  check(
    "被跳过的项不影响回落",
    resolvePrivateChatId("cli", "local", CLI_CHAT) === CLI_CHAT,
  );

  process.stdout.write("\n▶ 重复绑定\n");
  setup("single-user", [
    { id: "first", bindings: [{ channel: "cli", senderId: "local" }] },
    { id: "second", bindings: [{ channel: "cli", senderId: "local" }] },
  ]);
  check(
    "同一渠道身份只认先声明的 principal",
    resolvePrivateChatId("cli", "local", CLI_CHAT) === "first",
  );
  check("后者因无可用 binding 被丢弃", listPrincipals().length === 1);

  process.stdout.write("\n▶ id 与 binding 不一致（告警但仍生效）\n");
  setup("single-user", [
    { id: "u:custom", bindings: [{ channel: "dingtalk", senderId: STAFF }] },
  ]);
  check(
    "id 不等于任何 senderId 时仍然生效",
    resolvePrivateChatId("dingtalk", STAFF, STAFF) === "u:custom",
  );

  report();
}

function report(): void {
  const total = pass + fails.length;
  process.stdout.write(`\n━━━ ${pass}/${total} 通过 ━━━\n`);
  if (fails.length) process.stdout.write(`未通过：${fails.join(", ")}\n`);
  process.exit(fails.length ? 1 : 0);
}

main();
