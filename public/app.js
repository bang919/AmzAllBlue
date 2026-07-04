const statusLabels = {
  no_email: "未配置邮箱",
  new_creator: "新的红人",
  contacted: "已联系",
  unread_email: "未读邮件",
  read_email: "已读邮件",
  ignored: "忽略"
};

const stageLabels = {
  new_request: "新申请",
  needs_reply: "待回复",
  ready_to_ship: "可寄样",
  waiting_video: "等视频",
  published: "已发布",
  published_wants_more: "可复投"
};

const fields = [
  ["status", "状态", "select"],
  ["influencerName", "红人姓名", "input"],
  ["email", "邮箱", "input"],
  ["phone", "电话", "input"],
  ["shippingAddress", "收货地址", "textarea", "full"],
  ["websites", "网站", "websites", "full"],
  ["requestedAsins", "涉及 ASIN", "textarea", "full"],
  ["actionSuggestion", "行动建议", "textarea", "full"],
  ["lastMessageFrom", "最后发言方", "input"],
  ["aiScore", "AI 评分", "input"],
  ["aiReason", "评分理由", "textarea", "full"],
  ["emailLastError", "邮件发送错误", "textarea", "full"],
  ["trackingNumber", "物流单号", "input"],
  ["shippedAt", "寄出日期", "input"],
  ["followupAt", "跟进日期", "input"],
  ["conversationName", "会话名称", "input"],
  ["conversationDate", "会话抓取时间", "input"],
  ["rawText", "原始消息", "textarea", "full"],
  ["rawTextChinese", "原始消息（中文）", "translation", "full"]
];

let requests = [];
let products = [];
let adsProfiles = [];
let selectedId = "";
let selectedProductAsin = "";
let selectedAdsProfileId = "";
let activeModule = "dashboard";
let productsLoaded = false;
let adsLoaded = false;
const MAIL_TEMPLATE_KEY = "amazonAggregator.mailTemplate.v1";

const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\"": "&quot;",
  "'": "&#039;"
}[char]));

function setBusy(button, busy, text) {
  if (!button) return;
  button.disabled = busy;
  if (text) button.textContent = busy ? "处理中..." : text;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

function getSelected() {
  return requests.find(item => item.id === selectedId) || null;
}

function getSelectedProduct() {
  return products.find(item => item.asin === selectedProductAsin) || products[0] || null;
}

function formatDate(value) {
  if (!value) return "";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function displayName(item) {
  return item.conversationName || item.influencerName || item.brandName || "未命名红人";
}

function switchModule(module) {
  activeModule = module;
  document.querySelectorAll(".module-tab").forEach(tab => {
    tab.classList.toggle("active", tab.dataset.module === module);
  });
  document.querySelectorAll(".module-page").forEach(page => {
    page.classList.toggle("active", page.id === `${module}Page`);
  });
  if (module === "products") {
    renderProducts();
    if (!productsLoaded) loadProducts().catch(error => {
      $("#sandboxStatus").textContent = `FBA库存同步失败：${error.message}`;
    });
  }
  if (module === "ads") {
    renderAdsProfiles();
    if (!adsLoaded) refreshAds().catch(error => {
      $("#adsStatus").textContent = `Amazon Ads 检查失败：${error.message}`;
    });
  }
  if (module === "dashboard") renderDashboard();
}

function asMoney(value, currency = "USD") {
  if (value === "" || value === null || value === undefined || Number.isNaN(Number(value))) return "未同步";
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency }).format(Number(value));
}

function productTitle(product) {
  return product?.title || `Amazon 商品 ${product?.asin || ""}`.trim();
}

function productSourceLabel(source) {
  return source === "sandbox" ? "Amazon sandbox" : "本地聚合";
}

function defaultDateRange() {
  const end = new Date(Date.now() - 86400000);
  const start = new Date(end);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10)
  };
}

function formatNumber(value, digits = 0) {
  if (value === null || value === undefined || value === "") return "-";
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits
  }).format(Number(value || 0));
}

function stockLevelLabel(level) {
  return {
    low: "低库存",
    medium: "中等",
    healthy: "充足",
    unknown: "无销量"
  }[level] || "未知";
}

function renderStatusOptions() {
  const filter = $("#statusFilter");
  if (!filter) return;
  filter.innerHTML = "";
  [
    { value: "__active__", label: "全部状态（除忽略外）" },
    { value: "", label: "全部状态" }
  ].forEach(({ value, label }) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    filter.append(option);
  });
  Object.entries(statusLabels).forEach(([value, label]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    filter.append(option);
  });
}

function renderStats() {
  const unread = requests.filter(item => item.status === "unread_email").length;
  const newCreators = requests.filter(item => item.status === "new_creator").length;
  const contacted = requests.filter(item => item.status === "contacted").length;
  const important = requests.filter(item => item.important).length;
  $("#stats").innerHTML = `
    <div class="stat"><strong>${requests.length}</strong>红人记录</div>
    <div class="stat"><strong>${unread}</strong>未读邮件</div>
    <div class="stat"><strong>${newCreators}</strong>新的红人</div>
    <div class="stat"><strong>${contacted}</strong>已联系</div>
    <div class="stat"><strong>${important}</strong>重点标记</div>
  `;
  renderDashboard();
}

function dateKey(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(5, 10);
}

function renderTrendChart() {
  const chart = $("#trendChart");
  if (!chart) return;
  const buckets = new Map();
  const recent = [...requests]
    .filter(item => item.createdAt)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    .slice(-40);
  recent.forEach(item => {
    const key = dateKey(item.createdAt);
    if (key) buckets.set(key, (buckets.get(key) || 0) + 1);
  });
  const rows = [...buckets.entries()].slice(-7);
  if (!rows.length) {
    chart.innerHTML = `<div class="empty">暂无趋势数据</div>`;
    return;
  }
  const max = Math.max(...rows.map(([, count]) => count), 1);
  const points = rows.map(([label, count], index) => ({
    label,
    count,
    x: rows.length === 1 ? 50 : (index / (rows.length - 1)) * 100,
    y: 100 - (count / max) * 82 - 8
  }));
  const segments = points.slice(1).map((point, index) => {
    const previous = points[index];
    const dx = point.x - previous.x;
    const dy = point.y - previous.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    const angle = Math.atan2(dy, dx) * 180 / Math.PI;
    return `<span class="trend-segment" style="left:${previous.x}%;top:${previous.y}%;width:${length}%;transform:rotate(${angle}deg)"></span>`;
  }).join("");
  chart.innerHTML = `
    <div class="trend-line">
      ${segments}
      ${points.map(point => `<span class="trend-point" title="${escapeHtml(point.label)}: ${point.count}" style="left:${point.x}%;top:${point.y}%"></span>`).join("")}
    </div>
  `;
  const first = points[0]?.count || 0;
  const last = points[points.length - 1]?.count || 0;
  const delta = first ? Math.round(((last - first) / first) * 100) : (last ? 100 : 0);
  const deltaNode = $("#trendDelta");
  if (deltaNode) deltaNode.textContent = `${delta >= 0 ? "+" : ""}${delta}%`;
}

function renderProductBars() {
  const container = $("#productBars");
  if (!container) return;
  const rows = products.slice(0, 6).map(product => ({
    label: product.asin || "无 ASIN",
    count: product.totalQuantity || 0
  }));
  if (!rows.length) {
    container.innerHTML = `<div class="empty">暂无商品数据</div>`;
    return;
  }
  const max = Math.max(...rows.map(row => row.count), 1);
  container.innerHTML = rows.map(row => `
    <div class="bar-row">
      <span>${escapeHtml(row.label)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${Math.max(6, row.count / max * 100)}%"></span></span>
      <strong>${row.count}</strong>
    </div>
  `).join("");
}

function renderDashboard() {
  const metrics = $("#dashboardMetrics");
  if (!metrics) return;
  const unread = requests.filter(item => item.status === "unread_email").length;
  const activeCreators = requests.filter(item => item.status !== "ignored").length;
  const waiting = requests.filter(item => item.autoStage === "waiting_video").length;
  const published = requests.filter(item => ["published", "published_wants_more"].includes(item.autoStage) || item.publishedUrl).length;
  metrics.innerHTML = `
    <article class="metric-card"><span>FBA SKU</span><strong>${products.length}</strong><small>${formatNumber(window.fbaInventoryMeta?.totals?.fulfillableQuantity || 0)} 件可售</small></article>
    <article class="metric-card"><span>红人记录</span><strong>${activeCreators}</strong><small>${unread} 条未读邮件</small></article>
    <article class="metric-card"><span>待跟进视频</span><strong>${waiting}</strong><small>寄样后需追踪</small></article>
    <article class="metric-card"><span>已发布内容</span><strong>${published}</strong><small>可复盘转化</small></article>
  `;
  const productQuick = $("#productQuickText");
  if (productQuick) productQuick.textContent = `查看 ${products.length} 个 FBA SKU`;
  const influencerQuick = $("#influencerQuickText");
  if (influencerQuick) influencerQuick.textContent = `管理 ${activeCreators} 条合作`;
  renderTrendChart();
  renderProductBars();
}

function requestMatches(item) {
  const keyword = $("#search").value.trim().toLowerCase();
  const status = $("#statusFilter").value;
  if (status === "__active__" && item.status === "ignored") return false;
  if (status && status !== "__active__" && item.status !== status) return false;
  if (!keyword) return true;
  return [
    item.influencerName,
    item.brandName,
    item.conversationName,
    item.email,
    item.asin,
    ...(item.requestedAsins || []),
    item.shippingAddress,
    item.youtubeUrl,
    item.websiteUrl,
    ...(item.websites || []).flatMap(site => [site.key, site.value]),
    item.autoStage,
    item.actionSuggestion
  ].join(" ").toLowerCase().includes(keyword);
}

function renderList() {
  renderStats();
  const list = $("#requestList");
  list.innerHTML = "";
  const visible = requests.filter(requestMatches);
  if (!visible.length) {
    list.append($("#emptyTemplate").content.cloneNode(true));
    return;
  }

  visible.forEach(item => {
    const card = document.createElement("article");
    card.className = `request-card ${item.id === selectedId ? "active" : ""}`;
    card.innerHTML = `
      <div class="request-title">
        <span>${escapeHtml(displayName(item))}</span>
        <span class="request-tools">
          <button type="button" class="star-button ${item.important ? "active" : ""}" title="重点标记">★</button>
          <span class="status-badge status-${escapeHtml(item.status || "new_creator")}">${escapeHtml(statusLabels[item.status] || item.status || "新的红人")}</span>
        </span>
      </div>
      <div class="request-meta">
        <span>${escapeHtml(stageLabels[item.autoStage] || item.autoStage || "未分类")}</span>
        <span>${escapeHtml((item.requestedAsins?.length ? item.requestedAsins.join(", ") : item.asin) || "未提及 ASIN")}</span>
        <span>${escapeHtml(formatDate(item.createdAt))}</span>
      </div>
      <div class="request-meta">
        <span>${item.shippingAddress ? "有地址" : "地址待补充"}</span>
        <span>${getWebsiteEntries(item).length ? "有网站" : "网站待补充"}</span>
      </div>
      <div class="request-action">${escapeHtml(item.actionSuggestion || "暂无行动建议")}</div>
    `;
    card.addEventListener("click", () => {
      selectedId = item.id;
      renderList();
      renderDetail();
      renderMailPanel();
    });
    card.querySelector(".star-button").addEventListener("click", event => {
      event.stopPropagation();
      toggleImportant(item);
    });
    list.append(card);
  });
}

async function toggleImportant(item) {
  const updated = await api(`/api/requests/${item.id}`, {
    method: "PUT",
    body: { important: !item.important }
  });
  requests = requests.map(entry => entry.id === updated.request.id ? updated.request : entry);
  renderList();
  if (item.id === selectedId) renderDetail();
}

function makeControl(key, value, type) {
  if (type === "select") {
    const select = document.createElement("select");
    Object.entries(statusLabels).forEach(([status, label]) => {
      const option = document.createElement("option");
      option.value = status;
      option.textContent = label;
      select.append(option);
    });
    select.value = value || "new_creator";
    return select;
  }
  const control = document.createElement(["textarea", "translation"].includes(type) ? "textarea" : "input");
  control.value = Array.isArray(value) ? value.join("\n") : value || "";
  return control;
}

function getWebsiteEntries(item) {
  const entries = Array.isArray(item.websites)
    ? item.websites.map(site => ({ key: site.key || "", value: site.value || "" }))
    : [];
  const legacyEntries = [
    ["Amazon Storefront", item.storefrontUrl],
    ["YouTube", item.youtubeUrl],
    ["网站", item.websiteUrl],
    ...(item.socialLinks || []).map((url, index) => [`社交链接 ${index + 1}`, url])
  ].filter(([, value]) => value);

  const seen = new Set(entries.map(site => `${site.key}\n${site.value}`));
  for (const [key, value] of legacyEntries) {
    const id = `${key}\n${value}`;
    if (!seen.has(id)) {
      entries.push({ key, value });
      seen.add(id);
    }
  }
  return entries.length ? entries : [{ key: "", value: "" }];
}

function isUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function renderWebsiteValuePreview(value) {
  if (!isUrl(value)) return "";
  const href = escapeHtml(value.trim());
  return `<a href="${href}" target="_blank" rel="noopener noreferrer">打开网址</a>`;
}

function buildWebsitesControl(item) {
  const wrapper = document.createElement("div");
  wrapper.className = "kv-list";

  const save = async () => {
    const websites = [...wrapper.querySelectorAll(".kv-row")]
      .map(row => ({
        key: row.querySelector("[data-kv-key]").value.trim(),
        value: row.querySelector("[data-kv-value]").value.trim()
      }))
      .filter(site => site.key || site.value);
    const updated = await api(`/api/requests/${item.id}`, {
      method: "PUT",
      body: { websites }
    });
    requests = requests.map(entry => entry.id === updated.request.id ? updated.request : entry);
    renderList();
    renderDetail();
  };

  const addRow = (site = { key: "", value: "" }) => {
    const row = document.createElement("div");
    row.className = "kv-row";
    row.innerHTML = `
      <input data-kv-key placeholder="名称" value="${escapeHtml(site.key)}">
      <div class="kv-value">
        <input data-kv-value placeholder="网址" value="${escapeHtml(site.value)}">
        <span class="kv-preview">${renderWebsiteValuePreview(site.value)}</span>
      </div>
      <button type="button" class="icon-button" title="添加">+</button>
      <button type="button" class="icon-button" title="删除">-</button>
    `;
    const keyInput = row.querySelector("[data-kv-key]");
    const valueInput = row.querySelector("[data-kv-value]");
    const preview = row.querySelector(".kv-preview");
    keyInput.addEventListener("change", save);
    valueInput.addEventListener("input", () => {
      preview.innerHTML = renderWebsiteValuePreview(valueInput.value);
    });
    valueInput.addEventListener("change", save);
    row.querySelector("[title='添加']").addEventListener("click", () => {
      addRow();
    });
    row.querySelector("[title='删除']").addEventListener("click", () => {
      row.remove();
      if (!wrapper.querySelector(".kv-row")) addRow();
      save();
    });
    wrapper.append(row);
  };

  getWebsiteEntries(item).forEach(addRow);
  return wrapper;
}

function renderDetail() {
  const form = $("#detailForm");
  const item = getSelected();
  $("#emailDraft").textContent = "";
  form.innerHTML = "";
  if (!item) {
    form.append($("#emptyTemplate").content.cloneNode(true));
    return;
  }

  fields.forEach(([key, labelText, type, size]) => {
    const label = document.createElement("label");
    if (size) label.className = size;
    label.textContent = labelText;

    if (type === "websites") {
      label.append(buildWebsitesControl(item));
      form.append(label);
      return;
    }

    const control = makeControl(key, item[key], type);
    if (type === "translation") {
      const tools = document.createElement("div");
      tools.className = "field-tools";
      const translateButton = document.createElement("button");
      translateButton.type = "button";
      translateButton.textContent = "翻译原始消息";
      tools.append(control, translateButton);
      translateButton.addEventListener("click", async () => {
        const items = requests
          .map(entry => ({
            id: entry.id,
            message: entry.rawText || entry.conversationRaw || "",
            rawTextChinese: entry.rawTextChinese || ""
          }))
          .filter(entry => entry.message.trim() && !String(entry.rawTextChinese || "").trim())
          .map(({ id, message }) => ({ id, message }));
        const missingCount = items.length;
        if (!missingCount) {
          $("#answer").textContent = "没有需要翻译的原始消息。";
          return;
        }
        setBusy(translateButton, true, "翻译原始消息");
        try {
          const updated = await api("/api/requests/translate-missing", { method: "POST", body: items });
          const translations = new Map((updated.translations || []).map(row => [row.id, row.translation]));
          requests = requests.map(entry => translations.has(entry.id)
            ? { ...entry, rawTextChinese: translations.get(entry.id) }
            : entry);
          $("#answer").textContent = `已翻译 ${updated.translated || 0} 条原始消息。${updated.errors?.length ? `失败 ${updated.errors.length} 条。` : ""}`;
          renderList();
          renderDetail();
        } catch (error) {
          alert(error.message);
        } finally {
          setBusy(translateButton, false, "翻译原始消息");
        }
      });
      control.addEventListener("change", async () => {
        const updated = await api(`/api/requests/${item.id}`, {
          method: "PUT",
          body: { [key]: control.value }
        });
        requests = requests.map(entry => entry.id === updated.request.id ? updated.request : entry);
      });
      label.append(tools);
      form.append(label);
      return;
    }

    control.addEventListener("change", async () => {
      const value = key === "aiScore"
        ? Number(control.value || 0)
        : key === "requestedAsins"
          ? control.value.split(/\s|,|，/).map(entry => entry.trim()).filter(Boolean)
          : control.value;
      const updated = await api(`/api/requests/${item.id}`, {
        method: "PUT",
        body: { [key]: value }
      });
      requests = requests.map(entry => entry.id === updated.request.id ? updated.request : entry);
      renderList();
    });
    label.append(control);
    form.append(label);
  });
}

function defaultMailSubject(item) {
  return applyMailTemplate(item).subject;
}

function defaultMailBody(item) {
  return applyMailTemplate(item).body;
}

function defaultMailTemplate() {
  return {
    subject: "Invitation to try {asin}",
    body: `Hi {name},

Thank you for reaching out and sharing your content details. We would like to invite you to try {asin} and share your real experience if it is a good fit for your audience.

If you are interested, please reply with your preferred shipping address and any product preference.

Best regards,
Kanrichu`
  };
}

function getMailTemplate() {
  try {
    return { ...defaultMailTemplate(), ...JSON.parse(localStorage.getItem(MAIL_TEMPLATE_KEY) || "{}") };
  } catch {
    return defaultMailTemplate();
  }
}

function saveMailTemplate(template) {
  localStorage.setItem(MAIL_TEMPLATE_KEY, JSON.stringify(template));
}

function templateValues(item) {
  const name = item.influencerName || item.conversationName || "there";
  const asin = item.requestedAsins?.[0] || item.asin || "our product";
  return {
    name,
    asin,
    email: item.email || "",
    conversationName: item.conversationName || item.influencerName || ""
  };
}

function fillTemplate(text, item) {
  const values = templateValues(item);
  return String(text || "").replace(/\{(name|asin|email|conversationName)\}/g, (_, key) => values[key] || "");
}

function applyMailTemplate(item) {
  const template = getMailTemplate();
  return {
    subject: fillTemplate(template.subject, item),
    body: fillTemplate(template.body, item)
  };
}

function closeModal(modal) {
  modal.remove();
}

function createModal(title, bodyHtml) {
  const overlay = document.createElement("div");
  overlay.className = "modal-backdrop";
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-head">
        <h2>${escapeHtml(title)}</h2>
        <button type="button" class="icon-button" data-close-modal title="关闭">×</button>
      </div>
      ${bodyHtml}
    </div>
  `;
  overlay.addEventListener("click", event => {
    if (event.target === overlay || event.target.closest("[data-close-modal]")) closeModal(overlay);
  });
  document.body.append(overlay);
  return overlay;
}

function openTemplateModal() {
  const template = getMailTemplate();
  const modal = createModal("邮件模板", `
    <div class="modal-body">
      <p class="hint">可用变量：{name}、{asin}、{email}、{conversationName}</p>
      <label>
        主题
        <input id="templateSubject" value="${escapeHtml(template.subject)}">
      </label>
      <label>
        正文
        <textarea id="templateBody">${escapeHtml(template.body)}</textarea>
      </label>
      <div class="actions">
        <button id="saveTemplateBtn" class="primary">保存模板</button>
        <button id="resetTemplateBtn">恢复默认</button>
      </div>
    </div>
  `);
  modal.querySelector("#saveTemplateBtn").addEventListener("click", () => {
    saveMailTemplate({
      subject: modal.querySelector("#templateSubject").value,
      body: modal.querySelector("#templateBody").value
    });
    const item = getSelected();
    if (item) renderMailPanel();
    closeModal(modal);
  });
  modal.querySelector("#resetTemplateBtn").addEventListener("click", () => {
    const next = defaultMailTemplate();
    modal.querySelector("#templateSubject").value = next.subject;
    modal.querySelector("#templateBody").value = next.body;
  });
}

function mailCandidates() {
  return requests.filter(item => String(item.email || "").trim());
}

function renderBulkRows(items) {
  return items.map(item => `
    <label class="bulk-row">
      <input type="checkbox" value="${escapeHtml(item.id)}" ${item.status === "new_creator" ? "checked" : ""}>
      <span class="bulk-name">${escapeHtml(displayName(item))}</span>
      <span>${escapeHtml(item.email || "")}</span>
      <span class="status-badge status-${escapeHtml(item.status || "new_creator")}">${escapeHtml(statusLabels[item.status] || item.status || "新的红人")}</span>
      <span>${item.important ? "重点" : ""}</span>
    </label>
  `).join("");
}

function bulkLog(container, text, type = "") {
  const line = document.createElement("div");
  line.className = type ? `bulk-log-line ${type}` : "bulk-log-line";
  line.textContent = text;
  container.append(line);
  container.scrollTop = container.scrollHeight;
}

async function openBulkMail() {
  const candidates = mailCandidates();
  if (!candidates.length) return alert("没有可发送的邮箱，请先在详情里补充邮箱。");
  const template = getMailTemplate();
  const modal = createModal("批量邮件", `
    <div class="modal-body">
      <div class="bulk-toolbar">
        <label>
          间隔秒数
          <input id="bulkInterval" type="number" min="0" value="45">
        </label>
        <label>
          快速筛选
          <select id="bulkFilter">
            <option value="all">全部有邮箱</option>
            <option value="new_creator" selected>新的红人</option>
            <option value="important">重点标记</option>
          </select>
        </label>
      </div>
      <div class="bulk-list">${renderBulkRows(candidates)}</div>
      <label>
        主题模板
        <input id="bulkSubject" value="${escapeHtml(template.subject)}">
      </label>
      <label>
        正文模板
        <textarea id="bulkBody">${escapeHtml(template.body)}</textarea>
      </label>
      <div class="actions">
        <button id="bulkSendBtn" class="primary">开始发送</button>
        <button id="bulkSaveTemplateBtn">保存为默认模板</button>
      </div>
      <div id="bulkLog" class="bulk-log"></div>
    </div>
  `);
  const list = modal.querySelector(".bulk-list");
  const applyFilter = () => {
    const filter = modal.querySelector("#bulkFilter").value;
    list.querySelectorAll(".bulk-row").forEach(row => {
      const item = requests.find(entry => entry.id === row.querySelector("input").value);
      const show = filter === "all"
        || (filter === "important" && item?.important)
        || item?.status === filter;
      row.style.display = show ? "" : "none";
      row.querySelector("input").checked = show && item?.status === "new_creator";
    });
  };
  modal.querySelector("#bulkFilter").addEventListener("change", applyFilter);
  applyFilter();

  modal.querySelector("#bulkSaveTemplateBtn").addEventListener("click", () => {
    saveMailTemplate({
      subject: modal.querySelector("#bulkSubject").value,
      body: modal.querySelector("#bulkBody").value
    });
    bulkLog(modal.querySelector("#bulkLog"), "已保存为默认模板。");
  });

  modal.querySelector("#bulkSendBtn").addEventListener("click", async () => {
    const button = modal.querySelector("#bulkSendBtn");
    const log = modal.querySelector("#bulkLog");
    const selected = [...list.querySelectorAll("input:checked")]
      .map(input => requests.find(item => item.id === input.value))
      .filter(Boolean);
    if (!selected.length) return alert("请至少选择一个红人。");
    if (selected.some(item => item.status !== "new_creator")
      && !confirm("选中包含非“新的红人”的记录，确定也要发送吗？")) {
      return;
    }
    const intervalMs = Math.max(0, Number(modal.querySelector("#bulkInterval").value || 0)) * 1000;
    const subjectTemplate = modal.querySelector("#bulkSubject").value;
    const bodyTemplate = modal.querySelector("#bulkBody").value;
    setBusy(button, true, "开始发送");
    log.innerHTML = "";
    for (let index = 0; index < selected.length; index += 1) {
      const item = selected[index];
      try {
        bulkLog(log, `发送中 ${index + 1}/${selected.length}：${displayName(item)} <${item.email}>`);
        const data = await api("/api/gmail/send", {
          method: "POST",
          body: {
            requestId: item.id,
            subject: fillTemplate(subjectTemplate, item),
            body: fillTemplate(bodyTemplate, item)
          }
        });
        requests = requests.map(entry => entry.id === data.request.id ? data.request : entry);
        bulkLog(log, `成功：${displayName(item)}`, "success");
        renderList();
      } catch (error) {
        try {
          const updated = await api(`/api/requests/${item.id}`, {
            method: "PUT",
            body: {
              emailLastError: error.message,
              emailLastErrorAt: new Date().toISOString()
            }
          });
          requests = requests.map(entry => entry.id === updated.request.id ? updated.request : entry);
        } catch {
          // The visible batch log below is still the primary feedback during sending.
        }
        bulkLog(log, `失败：${displayName(item)} - ${error.message}`, "error");
      }
      if (index < selected.length - 1 && intervalMs > 0) {
        bulkLog(log, `等待 ${intervalMs / 1000} 秒后发送下一封...`);
        await sleep(intervalMs);
      }
    }
    setBusy(button, false, "开始发送");
    renderDetail();
    renderMailPanel();
  });
}

async function loadGmailStatus() {
  const status = $("#gmailStatus");
  try {
    const data = await api("/api/gmail/status");
    if (!data.configured) {
      status.textContent = "Gmail 未配置，请先检查 .env。";
      return data;
    }
    status.textContent = data.authorized
      ? `Gmail 已授权：${data.emailAddress || "当前账号"}`
      : `Gmail 未授权${data.error ? `：${data.error}` : ""}`;
    return data;
  } catch (error) {
    status.textContent = `Gmail 状态检查失败：${error.message}`;
    return { authorized: false };
  }
}

async function syncGmailStatuses() {
  try {
    const data = await api("/api/gmail/sync-status", { method: "POST", body: {} });
    requests = data.requests || requests;
    renderList();
    if (getSelected()) renderDetail();
    return data;
  } catch (error) {
    $("#gmailStatus").textContent = `Gmail 未读同步失败：${error.message}`;
    return null;
  }
}

async function authorizeGmail() {
  try {
    const data = await api("/api/gmail/auth-url");
    window.open(data.url, "_blank", "noopener,noreferrer");
    $("#gmailStatus").textContent = "已打开 Gmail 授权页。授权完成后点击“刷新邮件”。";
  } catch (error) {
    alert(error.message);
  }
}

function renderMailMessages(messages) {
  if (!messages.length) return `<div class="empty">还没有找到与这个邮箱相关的 Gmail 邮件。</div>`;
  return `
    <div class="mail-thread">
      ${messages.map(message => `
        <article class="mail-message">
          <div class="message-meta">
            <strong>${escapeHtml(message.subject || "无主题")}</strong>
            <span>${escapeHtml(message.date || "")}</span>
          </div>
          <div class="request-meta">
            <span>From: ${escapeHtml(message.from || "")}</span>
            <span>To: ${escapeHtml(message.to || "")}</span>
          </div>
          <p>${escapeHtml(message.body || message.snippet || "")}</p>
        </article>
      `).join("")}
    </div>
  `;
}

function productMatches(product) {
  const keyword = ($("#productSearch")?.value || $("#globalSearch")?.value || "").trim().toLowerCase();
  const source = $("#productSourceFilter")?.value || "";
  if (source && product.stockLevel !== source) return false;
  if (!keyword) return true;
  return [
    product.asin,
    product.sellerSku,
    product.fnSku,
    product.title,
    product.brand
  ].join(" ").toLowerCase().includes(keyword);
}

function renderProducts() {
  const list = $("#productList");
  if (!list) return;
  const visible = products.filter(productMatches);
  const summary = $("#fbaSummary");
  if (summary && window.fbaInventoryMeta) {
    const { totals, range, config, warnings, sales } = window.fbaInventoryMeta;
    summary.innerHTML = `
      <div class="fba-summary-card"><strong>${formatNumber(products.length)}</strong><span>SKU 数</span></div>
      <div class="fba-summary-card"><strong>${formatNumber(totals?.totalQuantity || 0)}</strong><span>总库存</span></div>
      <div class="fba-summary-card"><strong>${formatNumber(totals?.fulfillableQuantity || 0)}</strong><span>可售</span></div>
      <div class="fba-summary-card"><strong>${formatNumber(totals?.salesUnits || 0)}</strong><span>${escapeHtml(range?.dayCount || 0)} 天售卖数量</span></div>
      <div class="fba-summary-card"><strong>${formatNumber(sales?.orderCount || 0)}</strong><span>订单数</span></div>
      <div class="fba-summary-card"><strong>${escapeHtml(config?.marketplaceId || "-")}</strong><span>Marketplace</span></div>
      ${warnings?.length ? `<div class="fba-warning">${escapeHtml(warnings[0])}${warnings.length > 1 ? `，另有 ${warnings.length - 1} 条提示` : ""}</div>` : ""}
    `;
  }
  if (!visible.length) {
    list.innerHTML = `<tr><td colspan="13"><div class="empty">暂无 FBA 库存数据。点击“同步库存”从 SP-API 拉取。</div></td></tr>`;
    $("#fbaTotals").innerHTML = "";
    return;
  }
  list.innerHTML = visible.map(product => `
    <tr>
      <td>${product.imageUrl ? `<img class="fba-thumb" src="${escapeHtml(product.imageUrl)}" alt="${escapeHtml(product.title || product.asin)}">` : `<div class="fba-thumb placeholder">无图</div>`}</td>
      <td>
        <a href="https://www.amazon.com/dp/${escapeHtml(product.asin)}" target="_blank" rel="noopener noreferrer">${escapeHtml(product.asin || "-")}</a>
        <span>${escapeHtml(product.sellerSku || "-")}</span>
      </td>
      <td>
        <strong>${escapeHtml(product.fnSku || "-")}</strong>
        <span>${escapeHtml(product.sellerSku || "-")}</span>
      </td>
      <td class="fba-name">${escapeHtml(product.title || "-")}<span>${escapeHtml(product.brand || product.condition || "")}</span></td>
      <td>${formatNumber(product.totalQuantity)}</td>
      <td>${formatNumber(product.inTransitQuantity)}</td>
      <td>${formatNumber(product.fulfillableQuantity)}</td>
      <td>${formatNumber(product.inboundWorkingQuantity)}</td>
      <td>${formatNumber(product.reservedQuantity)}</td>
      <td>${formatNumber(product.salesOrders)}</td>
      <td>${formatNumber(product.salesUnits)}</td>
      <td>${formatNumber(product.dailySales, 2)}</td>
      <td><span class="stock-pill stock-${escapeHtml(product.stockLevel)}">${product.coverDays === null ? "无销量" : `${formatNumber(product.coverDays)} 天`}</span></td>
    </tr>
  `).join("");
  const totals = visible.reduce((acc, row) => {
    acc.totalQuantity += row.totalQuantity || 0;
    acc.inTransitQuantity += row.inTransitQuantity || 0;
    acc.fulfillableQuantity += row.fulfillableQuantity || 0;
    acc.inboundWorkingQuantity += row.inboundWorkingQuantity || 0;
    acc.reservedQuantity += row.reservedQuantity || 0;
    acc.salesOrders += row.salesOrders || 0;
    acc.salesUnits += row.salesUnits || 0;
    return acc;
  }, { totalQuantity: 0, inTransitQuantity: 0, fulfillableQuantity: 0, inboundWorkingQuantity: 0, reservedQuantity: 0, salesOrders: 0, salesUnits: 0 });
  $("#fbaTotals").innerHTML = `
    <tr>
      <td colspan="4">汇总</td>
      <td>${formatNumber(totals.totalQuantity)}</td>
      <td>${formatNumber(totals.inTransitQuantity)}</td>
      <td>${formatNumber(totals.fulfillableQuantity)}</td>
      <td>${formatNumber(totals.inboundWorkingQuantity)}</td>
      <td>${formatNumber(totals.reservedQuantity)}</td>
      <td>${formatNumber(totals.salesOrders)}</td>
      <td>${formatNumber(totals.salesUnits)}</td>
      <td colspan="2"></td>
    </tr>
  `;
  renderDashboard();
}

async function loadProducts({ refresh = false } = {}) {
  const range = defaultDateRange();
  const startDate = $("#salesStartDate")?.value || range.startDate;
  const endDate = $("#salesEndDate")?.value || range.endDate;
  const params = new URLSearchParams({ startDate, endDate });
  if (refresh) params.set("refresh", "1");
  const data = await api(`/api/fba/inventory?${params.toString()}`);
  products = data.rows || [];
  productsLoaded = true;
  window.fbaInventoryMeta = {
    totals: data.totals || {},
    range: data.range || {},
    config: data.config || {},
    sales: data.sales || {},
    warnings: data.warnings || []
  };
  renderProducts();
}

async function loadSandboxStatus() {
  const node = $("#sandboxStatus");
  if (!node) return null;
  try {
    const data = await api("/api/spapi/status");
    if (data.sellers?.ok) {
      const marketplaceCount = data.sellers.marketplaces?.length || 0;
      node.textContent = `SP-API 已连通${marketplaceCount ? `，${marketplaceCount} 个站点` : ""}`;
    } else if (data.lwa?.ok) {
      node.textContent = `LWA 已连通，SP-API 待确认：${data.sellers?.status || ""}`;
    } else {
      node.textContent = data.config?.missing?.length
        ? `SP-API 缺少配置：${data.config.missing.join(", ")}`
        : `SP-API 检查失败`;
    }
    return data;
  } catch (error) {
    node.textContent = `SP-API 检查失败：${error.message}`;
    return null;
  }
}

async function syncSandboxProducts() {
  const button = $("#syncProductsBtn");
  setBusy(button, true, "同步库存");
  try {
    await loadProducts({ refresh: true });
    $("#sandboxStatus").textContent = `FBA库存已同步 ${products.length} 个 SKU`;
  } catch (error) {
    $("#sandboxStatus").textContent = `FBA库存同步失败：${error.message}`;
  } finally {
    setBusy(button, false, "同步库存");
  }
}

function renderAdsStatus(status = window.adsStatusMeta || {}) {
  const statusNode = $("#adsStatus");
  const summary = $("#adsSummary");
  if (!statusNode || !summary) return;

  const configured = Boolean(status.configured);
  const authorized = Boolean(status.authorized);
  const selected = status.selectedProfile || null;
  if (!configured) {
    statusNode.textContent = `缺少配置：${(status.missing || []).join("、") || "Amazon Ads .env"}`;
  } else if (!authorized) {
    statusNode.textContent = "已读取 Ads 配置，等待授权广告账户";
  } else if (!selected?.profileId) {
    statusNode.textContent = "广告账户已授权，请选择一个 Profile";
  } else {
    statusNode.textContent = `已连接 Profile ${selected.profileId}`;
  }

  summary.innerHTML = `
    <div class="fba-summary-card">
      <strong>${configured ? "已配置" : "缺配置"}</strong>
      <span>Client ID / Secret</span>
    </div>
    <div class="fba-summary-card">
      <strong>${authorized ? "已授权" : "未授权"}</strong>
      <span>Refresh token</span>
    </div>
    <div class="fba-summary-card">
      <strong>${escapeHtml(selected?.countryCode || "-")}</strong>
      <span>当前国家</span>
    </div>
    <div class="fba-summary-card">
      <strong>${escapeHtml(selected?.currencyCode || "-")}</strong>
      <span>币种</span>
    </div>
    <div class="fba-summary-card wide-card">
      <strong>${escapeHtml(status.endpoint || "-")}</strong>
      <span>Ads API endpoint</span>
    </div>
    <div class="fba-summary-card wide-card">
      <strong>${escapeHtml(status.redirectUri || "-")}</strong>
      <span>授权回调地址</span>
    </div>
  `;

  const quick = $("#adsQuickText");
  if (quick) {
    quick.textContent = selected?.profileId
      ? `已选择 ${selected.countryCode || selected.profileId}`
      : authorized ? "选择广告 Profile" : "授权 Amazon Ads";
  }
}

function renderAdsProfiles() {
  const container = $("#adsProfiles");
  if (!container) return;
  if (!adsProfiles.length) {
    container.innerHTML = `<div class="empty">暂无广告 Profile。先点击“授权广告账户”，授权后再刷新。</div>`;
    return;
  }
  container.innerHTML = adsProfiles.map(profile => {
    const active = profile.profileId === selectedAdsProfileId;
    return `
      <button class="ads-profile-card${active ? " active" : ""}" data-profile-id="${escapeHtml(profile.profileId)}">
        <strong>${escapeHtml(profile.accountName || profile.profileId)}</strong>
        <span>${escapeHtml([profile.countryCode, profile.currencyCode, profile.type].filter(Boolean).join(" / ") || "Amazon Ads Profile")}</span>
        <small>${escapeHtml(profile.profileId)}${profile.sellerStringId ? ` · ${escapeHtml(profile.sellerStringId)}` : ""}</small>
      </button>
    `;
  }).join("");
  container.querySelectorAll("[data-profile-id]").forEach(button => {
    button.addEventListener("click", () => selectAdsProfile(button.dataset.profileId));
  });
}

async function loadAdsStatus() {
  const data = await api("/api/ads/status");
  window.adsStatusMeta = data;
  selectedAdsProfileId = data.selectedProfile?.profileId || selectedAdsProfileId;
  renderAdsStatus(data);
  return data;
}

async function loadAdsProfiles() {
  const data = await api("/api/ads/profiles");
  adsProfiles = data.profiles || [];
  selectedAdsProfileId = data.selectedProfile?.profileId || selectedAdsProfileId;
  renderAdsProfiles();
  return data;
}

async function refreshAds() {
  const status = await loadAdsStatus();
  adsLoaded = true;
  if (status.authorized) {
    try {
      await loadAdsProfiles();
    } catch (error) {
      $("#adsProfiles").innerHTML = `<div class="empty">读取 Amazon Ads Profile 失败：${escapeHtml(error.message)}</div>`;
    }
  }
}

async function authorizeAds() {
  const button = $("#adsAuthBtn");
  setBusy(button, true, "授权广告账户");
  try {
    const data = await api("/api/ads/auth-url");
    window.open(data.url, "_blank", "noopener,noreferrer");
    $("#adsStatus").textContent = "已打开 Amazon 授权页。授权完成后回到这里点击刷新。";
  } catch (error) {
    alert(error.message);
  } finally {
    setBusy(button, false, "授权广告账户");
  }
}

async function selectAdsProfile(profileId) {
  if (!profileId) return;
  const data = await api("/api/ads/select-profile", {
    method: "POST",
    body: { profileId }
  });
  selectedAdsProfileId = data.profile?.profileId || profileId;
  window.adsStatusMeta = {
    ...(window.adsStatusMeta || {}),
    selectedProfile: data.profile
  };
  renderAdsStatus(window.adsStatusMeta);
  renderAdsProfiles();
}

async function renderMailPanel() {
  const container = $("#mailWorkspace");
  const item = getSelected();
  if (!container) return;
  if (!item) {
    container.innerHTML = `<div class="empty">请选择一位红人。</div>`;
    return;
  }

  container.innerHTML = `
    <div class="mail-composer">
      <div class="pill">${escapeHtml(item.email || "邮箱待补充")}</div>
      <label>
        主题
        <input id="mailSubject" value="${escapeHtml(defaultMailSubject(item))}">
      </label>
      <label>
        内容
        <textarea id="mailBody">${escapeHtml(defaultMailBody(item))}</textarea>
      </label>
      <div class="actions">
        <button id="sendMailBtn" class="primary">发送给当前红人</button>
      </div>
    </div>
    <div id="gmailMessages" class="mail-messages">
      <div class="empty">正在读取 Gmail 邮件...</div>
    </div>
  `;

  $("#sendMailBtn").addEventListener("click", sendCurrentMail);
  if (!item.email) {
    $("#gmailMessages").innerHTML = `<div class="empty">当前红人没有邮箱，先在详情里补邮箱。</div>`;
    return;
  }

  try {
    const data = await api(`/api/gmail/messages?requestId=${encodeURIComponent(item.id)}`);
    if (data.request) {
      requests = requests.map(entry => entry.id === data.request.id ? data.request : entry);
      renderList();
      renderDetail();
    }
    $("#gmailMessages").innerHTML = renderMailMessages(data.messages || []);
  } catch (error) {
    $("#gmailMessages").innerHTML = `<div class="empty">读取 Gmail 失败：${escapeHtml(error.message)}</div>`;
  }
}

async function sendCurrentMail() {
  const item = getSelected();
  if (!item) return alert("请先选择一条记录");
  if (!item.email) return alert("当前红人没有邮箱");
  const button = $("#sendMailBtn");
  setBusy(button, true, "发送给当前红人");
  try {
    const data = await api("/api/gmail/send", {
      method: "POST",
      body: {
        requestId: item.id,
        subject: $("#mailSubject").value,
        body: $("#mailBody").value
      }
    });
    requests = requests.map(entry => entry.id === data.request.id ? data.request : entry);
    $("#answer").textContent = "邮件已发送。";
    renderMailPanel();
    renderDetail();
  } catch (error) {
    try {
      const updated = await api(`/api/requests/${item.id}`, {
        method: "PUT",
        body: {
          emailLastError: error.message,
          emailLastErrorAt: new Date().toISOString()
        }
      });
      requests = requests.map(entry => entry.id === updated.request.id ? updated.request : entry);
      renderDetail();
    } catch {
      // Keep the original send error visible even if recording it fails.
    }
    alert(error.message);
  } finally {
    setBusy(button, false, "发送给当前红人");
  }
}

async function loadRequests() {
  const data = await api("/api/requests");
  requests = data.requests || [];
  if (!selectedId && requests[0]) selectedId = requests[0].id;
  renderList();
  renderDetail();
  renderMailPanel();
  renderDashboard();
}

async function refreshWorkspace({ syncMail = true } = {}) {
  await loadSandboxStatus();
  await loadGmailStatus();
  await loadRequests();
  if (syncMail) {
    await syncGmailStatuses();
    await renderMailPanel();
  }
}

async function reprocessAll() {
  setBusy($("#reprocessBtn"), true, "重新解析");
  try {
    const data = await api("/api/reprocess", { method: "POST", body: {} });
    requests = data.requests;
    $("#answer").textContent = `已重新解析 ${requests.length} 条记录。`;
    renderList();
    renderDetail();
  } catch (error) {
    alert(error.message);
  } finally {
    setBusy($("#reprocessBtn"), false, "重新解析");
  }
}

async function ask() {
  const question = $("#question").value.trim();
  if (!question) return alert("请输入问题");
  setBusy($("#askBtn"), true, "询问");
  try {
    const data = await api("/api/ask", { method: "POST", body: { question } });
    $("#answer").textContent = data.answer;
  } catch (error) {
    alert(error.message);
  } finally {
    setBusy($("#askBtn"), false, "询问");
  }
}

async function deleteSelected() {
  const item = getSelected();
  if (!item) return;
  if (!confirm("确定删除这条记录吗？")) return;
  await api(`/api/requests/${item.id}`, { method: "DELETE" });
  requests = requests.filter(entry => entry.id !== item.id);
  selectedId = requests[0]?.id || "";
  renderList();
  renderDetail();
}

async function generateEmail() {
  const item = getSelected();
  if (!item) return alert("请先选择一条记录");
  const intent = prompt("邮件类型：accept / reject / followup", "accept") || "accept";
  setBusy($("#emailBtn"), true, "生成邮件");
  try {
    const data = await api("/api/email", { method: "POST", body: { request: item, intent } });
    $("#emailDraft").textContent = data.email;
    const mailBody = $("#mailBody");
    if (mailBody) mailBody.value = data.email;
  } catch (error) {
    alert(error.message);
  } finally {
    setBusy($("#emailBtn"), false, "生成邮件");
  }
}

$("#askBtn").addEventListener("click", ask);
$("#refreshBtn").addEventListener("click", () => refreshWorkspace().catch(error => alert(error.message)));
$("#bulkMailBtn").addEventListener("click", openBulkMail);
$("#reprocessBtn").addEventListener("click", reprocessAll);
$("#deleteBtn").addEventListener("click", deleteSelected);
$("#emailBtn").addEventListener("click", generateEmail);
$("#templateBtn").addEventListener("click", openTemplateModal);
$("#gmailAuthBtn").addEventListener("click", authorizeGmail);
$("#gmailRefreshBtn").addEventListener("click", async () => {
  await loadGmailStatus();
  await syncGmailStatuses();
  await renderMailPanel();
});
$("#search").addEventListener("input", renderList);
$("#statusFilter").addEventListener("change", renderList);
$("#dashboardRefreshBtn").addEventListener("click", () => refreshWorkspace().catch(error => alert(error.message)));
$("#refreshProductsBtn").addEventListener("click", () => loadProducts({ refresh: true }).catch(error => alert(error.message)));
$("#syncProductsBtn").addEventListener("click", () => syncSandboxProducts().catch(error => alert(error.message)));
$("#adsAuthBtn").addEventListener("click", authorizeAds);
$("#adsRefreshBtn").addEventListener("click", () => refreshAds().catch(error => alert(error.message)));
$("#productSearch").addEventListener("input", renderProducts);
$("#productSourceFilter").addEventListener("change", renderProducts);
$("#salesStartDate").addEventListener("change", () => loadProducts({ refresh: true }).catch(error => alert(error.message)));
$("#salesEndDate").addEventListener("change", () => loadProducts({ refresh: true }).catch(error => alert(error.message)));
$("#globalSearch").addEventListener("input", () => {
  const value = $("#globalSearch").value;
  if (activeModule === "products") {
    $("#productSearch").value = value;
    renderProducts();
  } else if (activeModule === "influencers") {
    $("#search").value = value;
    renderList();
  } else if (activeModule === "ads") {
    const needle = value.trim().toLowerCase();
    document.querySelectorAll(".ads-profile-card").forEach(card => {
      card.hidden = needle && !card.textContent.toLowerCase().includes(needle);
    });
  }
});
document.querySelectorAll(".module-tab").forEach(tab => {
  tab.addEventListener("click", () => switchModule(tab.dataset.module));
});
document.querySelectorAll("[data-module-jump]").forEach(button => {
  button.addEventListener("click", () => switchModule(button.dataset.moduleJump));
});

const initialRange = defaultDateRange();
if ($("#salesStartDate")) $("#salesStartDate").value = initialRange.startDate;
if ($("#salesEndDate")) $("#salesEndDate").value = initialRange.endDate;
renderStatusOptions();
refreshWorkspace().catch(error => alert(error.message));
setInterval(syncGmailStatuses, 120000);
