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
let selectedId = "";
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

function formatDate(value) {
  if (!value) return "";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function displayName(item) {
  return item.conversationName || item.influencerName || item.brandName || "未命名红人";
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
}

async function refreshWorkspace({ syncMail = true } = {}) {
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

renderStatusOptions();
refreshWorkspace().catch(error => alert(error.message));
setInterval(syncGmailStatuses, 120000);
