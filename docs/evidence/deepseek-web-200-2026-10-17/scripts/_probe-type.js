(() => {
  const TEXT =
    "请真的调用工具，不要凭记忆回答。第一步：调用 web_search，query = 「DeepSeek 官方文档 网页搜索与抓取」，把返回的前 3 条结果标题和 URL 原样列出，并说明结果里是否带 summary。第二步：调用 web_fetch，url = https://api-docs.deepseek.com/zh-cn/guides/search/ ，把 Length 那一行原样抄下来，再给出正文开头 40 个字。";
  const ta = document.querySelector("textarea.message-input");
  if (!ta) return "no-textarea";
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
  setter.call(ta, TEXT);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  ta.focus();
  return "set:" + ta.value.length;
})()
