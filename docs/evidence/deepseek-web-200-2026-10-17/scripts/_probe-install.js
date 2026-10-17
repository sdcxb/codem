(() => {
  if (window.__dsProbe) return "already";
  window.__dsProbe = [];
  const origFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : ((input && input.url) || "");
    const isTool = url.indexOf("/v1/tools/") >= 0;
    const t0 = performance.now();
    try {
      const res = await origFetch(input, init);
      const ms = Math.round(performance.now() - t0);
      if (isTool) {
        const entry = { url: url, status: res.status, ms: ms, at: new Date().toISOString() };
        try {
          const text = await res.clone().text();
          entry.bodyChars = text.length;
          try {
            const j = JSON.parse(text);
            if (Array.isArray(j.results)) {
              entry.results = j.results.length;
              entry.first = j.results[0]
                ? {
                    title: String(j.results[0].title || "").slice(0, 60),
                    url: String(j.results[0].url || ""),
                    summaryChars: String(j.results[0].summary || "").length,
                    authority: j.results[0].authority,
                    rerank: j.results[0].rerank_score,
                  }
                : null;
            }
            if (typeof j.content === "string") {
              entry.contentChars = j.content.length;
              entry.title = String(j.title || "").slice(0, 60);
              entry.head = j.content.slice(0, 40);
            }
            if (j.error) entry.errorMessage = String(j.error.message || "").slice(0, 120);
          } catch (e) {
            entry.jsonError = String((e && e.message) || e).slice(0, 80);
          }
        } catch (e) {
          entry.readError = String((e && e.message) || e).slice(0, 80);
        }
        window.__dsProbe.push(entry);
        console.log("[ds-probe] " + JSON.stringify(entry));
      }
      return res;
    } catch (e) {
      if (isTool) {
        const entry = {
          url: url,
          networkError: String((e && e.message) || e).slice(0, 120),
          ms: Math.round(performance.now() - t0),
        };
        window.__dsProbe.push(entry);
        console.log("[ds-probe] " + JSON.stringify(entry));
      }
      throw e;
    }
  };
  return "installed";
})()
