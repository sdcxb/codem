/**
 * 脚本化 provider（共享夹具 ✓，第 163 波从 `red-test-at-completion.test.ts` 抽出来 ✓）。
 *
 * ## 为什么要抽 ✗
 *
 * 它原本**写死在那个测试文件里** ✓，于是新写的收尾守卫判据只能：
 * 要么复制一份 ✗（两处迟早分叉 ✓），要么 import 一个测试文件 ✗（坏味道 ✓）。
 * 收尾守卫现在有**三条**（改了没验证 / 族判据没跑齐 / 零产出收工 ✓）⇒
 * 夹具共享是必须的 ✓。
 *
 * 用法：`setScript([...])` 给每一轮 `stream()` 喂一段事件 ✓；
 * `requests.length` 就是"这一轮被要了几次"✓（判据靠它判断"有没有多要一轮"✓）。
 */
export class ScriptedProvider {
  id = "scripted-provider";
  name = "Scripted Mock";
  config: any = { apiKey: "sk-test" };
  requests: any[] = [];
  private queue: any[][] = [];

  setScript(scripts: any[][]) {
    this.queue = scripts;
  }

  isConfigured() {
    return true;
  }

  async *stream(request: any): AsyncGenerator<any> {
    this.requests.push(request);
    const script = this.queue.shift();
    if (!script) throw new Error("脚本耗尽（不该发生的额外调用）");
    for (const item of script) yield item;
  }

  async complete() {
    return { content: "{}", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
  }

  async listModels() {
    return [];
  }
}
