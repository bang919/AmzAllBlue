(() => {
  if (window.__kanrichuBookmarkletCollectorLoaded) {
    alert("采集器已经在运行。");
    return;
  }
  window.__kanrichuBookmarkletCollectorLoaded = true;

  const endpoint = "http://localhost:4317/api/import/messages";
  const maxThreads = Number(prompt("要采集多少个会话？建议先输入 10 测试。", "10") || "10");
  const seen = new Set();
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  const panel = document.createElement("div");
  panel.style.cssText = [
    "position:fixed",
    "right:18px",
    "top:18px",
    "z-index:2147483647",
    "width:360px",
    "max-height:50vh",
    "overflow:auto",
    "padding:14px",
    "background:#102322",
    "color:#fff",
    "font:13px/1.45 Arial,sans-serif",
    "border-radius:8px",
    "box-shadow:0 8px 30px rgba(0,0,0,.35)"
  ].join(";");
  document.body.appendChild(panel);

  function log(message) {
    const line = document.createElement("div");
    line.textContent = `${new Date().toLocaleTimeString()} ${message}`;
    panel.prepend(line);
  }

  function isVisible(node) {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }

  function isScrollable(node) {
    if (!node || node === document.documentElement || node === document.body) return false;
    const style = getComputedStyle(node);
    const overflowY = `${style.overflowY} ${style.overflow}`;
    return /(auto|scroll)/i.test(overflowY) && node.scrollHeight > node.clientHeight + 20;
  }

  function getChannelRoot() {
    return document.querySelector('[data-testid="CHANNEL-SCROLL-CONTAINER"]');
  }

  function getMessageListScroller() {
    const root = getChannelRoot();
    if (!root) return null;
    if (isScrollable(root)) return root;
    let parent = root.parentElement;
    while (parent && parent !== document.body) {
      if (isScrollable(parent)) return parent;
      parent = parent.parentElement;
    }
    const descendants = [...root.querySelectorAll("*")].filter(isScrollable);
    return descendants.sort((a, b) => b.clientHeight - a.clientHeight)[0] || root;
  }

  async function ensureListView() {
    if (getChannelRoot()) return true;
    const backIcon = document.querySelector('[data-testid="storm-ui-icon-arrow-left"]');
    const backButton = backIcon?.closest("button,[role='button'],div");
    if (backButton) {
      backButton.click();
      await delay(1200);
    }
    return !!getChannelRoot();
  }

  function getConversationName() {
    return (document.body.innerText.match(/发消息给([^\n]+)/) || [])[1]?.trim() || "";
  }

  function getThreadRows() {
    const root = getChannelRoot();
    if (!root) return [];
    const rootRect = root.getBoundingClientRect();
    const rows = [...root.querySelectorAll("button,[role='button'],[tabindex],div")]
      .filter(node => {
        if (!isVisible(node)) return false;
        const rect = node.getBoundingClientRect();
        const text = (node.innerText || "").trim();
        if (!text || text.length > 600) return false;
        if (rect.bottom < rootRect.top || rect.top > rootRect.bottom) return false;
        if (node.querySelector('[data-testid="CHAT-MESSAGE"]')) return false;
        return true;
      })
      .map(node => {
        const row = node.closest("button,[role='button'],[tabindex]") || node;
        const parts = (row.innerText || "").split("\n").map(part => part.trim()).filter(Boolean);
        const name = parts[0] || row.querySelector("img[alt]")?.getAttribute("alt") || "";
        const time = parts.find(part => /\d{1,2}:\d{2}\s*(AM|PM)?|昨天|今天|天前|\/\d{1,2}\//i.test(part)) || parts[1] || "";
        return { row, name, time };
      })
      .filter(item => item.name && !/列表结尾|Kanrichu$/i.test(item.name));
    const uniqueRows = new Map();
    for (const item of rows) {
      const rect = item.row.getBoundingClientRect();
      const key = `${item.name}::${item.time}::${Math.round(rect.top)}`;
      if (!uniqueRows.has(key)) uniqueRows.set(key, item);
    }
    return [...uniqueRows.values()];
  }

  function getThreadPayload(fallbackName, fallbackTime) {
    const messages = [...document.querySelectorAll('[data-testid="CHAT-MESSAGE"]')]
      .map(node => (node.innerText || node.textContent || "").trim())
      .filter(Boolean);
    const rawText = messages.join("\n\n---\n\n");
    return {
      conversationName: getConversationName() || fallbackName,
      conversationDate: fallbackTime || "",
      sourceUrl: location.href,
      rawText,
      conversationRaw: rawText
    };
  }

  async function importPayload(payload) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [payload] })
    });
    if (!response.ok) {
      throw new Error(`导入失败 ${response.status}: ${await response.text()}`);
    }
    return response.json();
  }

  function visibleRowSignature() {
    return getThreadRows().map(item => `${item.name}::${item.time}`).join("|");
  }

  async function scrollConversationList() {
    const scroller = getMessageListScroller();
    if (!scroller) return false;
    const beforeTop = scroller.scrollTop;
    const beforeSignature = visibleRowSignature();
    const amount = Math.max(420, scroller.clientHeight * 0.85);
    scroller.scrollTop = beforeTop + amount;
    scroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: amount }));
    await delay(1100);
    if (scroller.scrollTop !== beforeTop || visibleRowSignature() !== beforeSignature) return true;
    window.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: amount }));
    await delay(1100);
    return visibleRowSignature() !== beforeSignature;
  }

  async function run() {
    try {
      if (!await ensureListView()) {
        throw new Error("没有找到消息列表。请先在 Amazon 页面右下角打开“消息”。");
      }

      let importedCount = 0;
      let idleScrolls = 0;
      log("开始采集消息会话。");

      while (importedCount < maxThreads && idleScrolls < 10) {
        await ensureListView();
        const rows = getThreadRows();
        let foundNew = false;
        log(`当前可见 ${rows.length} 个会话，已导入 ${importedCount}/${maxThreads}。`);

        for (const item of rows) {
          if (importedCount >= maxThreads) break;
          const key = `${item.name}::${item.time}`;
          if (seen.has(key)) continue;
          seen.add(key);
          foundNew = true;

          log(`打开：${item.name}`);
          item.row.scrollIntoView({ block: "center" });
          item.row.click();
          await delay(1800);

          const payload = getThreadPayload(item.name, item.time);
          if (!payload.rawText || payload.rawText.length < 20) {
            log(`跳过：${item.name} 没有读到聊天内容`);
            await ensureListView();
            continue;
          }

          await importPayload(payload);
          importedCount += 1;
          log(`已导入 ${importedCount}/${maxThreads}：${payload.conversationName}`);
          await ensureListView();
        }

        if (importedCount >= maxThreads) break;
        const moved = await scrollConversationList();
        if (!foundNew && !moved) idleScrolls += 1;
        if (foundNew || moved) idleScrolls = 0;
      }

      log(`完成：导入 ${importedCount} 个会话。回到本地工具刷新即可查看。`);
    } catch (error) {
      console.error(error);
      log(`出错：${error.message}`);
      alert(error.message);
    } finally {
      window.__kanrichuBookmarkletCollectorLoaded = false;
    }
  }

  run();
})();
