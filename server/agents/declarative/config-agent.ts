import { BaseAgent } from "../base-agent.js";
import { resolveWorkspace } from "../../config/agent-profile.js";

/**
 * 配置驱动的通用 agent：用于 type=simple 的招聘员工，
 * 以及没有配套代码行为、纯靠 server/config/agents/<id>.json 就能跑的内置岗位。
 *
 * 所有设置都由基类的 profile getter 从配置文件读取（mtime 缓存 → 改配置即时生效）；
 * 这里只补一件事：配置驱动的岗位默认有自己独立的工作目录，不落到全局 workingDir。
 */
export class ConfigAgent extends BaseAgent {
  readonly name: string;

  constructor(id: string) {
    super();
    this.name = id;
  }

  protected override resolveCwd(): string {
    return resolveWorkspace(this.profile);
  }
}
