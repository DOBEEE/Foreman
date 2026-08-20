import { config } from "../../config/index.js";
import { getCredential } from "../../config/credentials-store.js";

/**
 * 钉钉凭据。
 *
 * 显式解析成一个对象再传给 push / media，而不是让它们各自去读全局配置：
 * 一次消息的整条出站链路（取 token → 上传图片 → 发消息）必须用同一份凭据，
 * 而运行期用户可能刚在后台把 AppKey 换掉。
 */
export interface DingTalkCreds {
  clientId: string;
  clientSecret: string;
  /**
   * 主动推送用 robotCode。
   * 只有「企业内部应用 - 机器人」的 robotCode 才等于 AppKey；在钉钉后台「机器人管理」里
   * 单独创建的机器人有独立 robotCode，拿 AppKey 去推会被拒（400 resource.not.found）。
   */
  robotCode: string;
}

/** 解析钉钉凭据；缺 clientId / clientSecret 返回 undefined（= 该渠道未配置） */
export function resolveDingTalkCreds(): DingTalkCreds | undefined {
  const clientId = config.dingtalk.clientId || process.env.DINGTALK_CLIENT_ID;
  const clientSecret =
    getCredential("dingtalk_client_secret") || process.env.DINGTALK_CLIENT_SECRET;
  if (!clientId || !clientSecret) return undefined;
  const robotCode = config.dingtalk.robotCode || process.env.DINGTALK_ROBOT_CODE || clientId;
  return { clientId, clientSecret, robotCode };
}
