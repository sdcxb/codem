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
  /**
   * ⚠️ **默认值必须与抽取前逐字一致** ✗→✓ ——
   * 第一版我改成了通用的 `scripted-provider` ✗，结果 **12 条判据当场变红** ✓：
   * `dsh-d5-prefix-cache-stability` / `dsh-d1-llm-failure-not-completed` 这些
   * **逐字节比较系统提示** ✓（提示里嵌着 provider 的 `id`/`name` ✓）⇒ 改默认值就破坏了它们 ✓。
   * 抽取共享夹具时，**默认值也是契约的一部分** ✓。
   * （需要别的身份就在用例里改字段 ✓，不要动默认值 ✗。）
   */
  id = "red-test-provider";
  name = "Red Test Mock";
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
