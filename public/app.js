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
let factoryProducts = [];
let factoryMovements = [];
let factoryTotals = {};
let factoryCategoryOptions = [];
let adsProfiles = [];
let selectedId = "";
let selectedProductAsin = "";
let selectedAdsProfileId = "";
let adsWorkspace = { products: [], keywords: [], portfolio: null, range: null };
let adsCreationTemplate = null;
let selectedAdsParentAsin = "";
let selectedAdsKeywordId = "";
let selectedAdsGroup = "ALL";
let pendingAdsOperation = null;
let adsAiState = null;
let adsAiPollTimer = null;
let adsHistoryState = {
  keywordId: "",
  childAsin: "ALL",
  matchType: "ALL",
  startDate: "",
  endDate: "",
  metricA: "impressions",
  metricB: "clicks"
};
let adsHistoryRequestSequence = 0;
let draggedAdsParentAsin = "";
let pointerRowDrag = null;
let activeModule = "dashboard";
let productsLoaded = false;
let factoryLoaded = false;
let adsLoaded = false;
let systemSchedulesLoaded = false;
let systemSchedules = [];
let sifWorkspaceData = { dates: [], keywords: [], asins: [] };
let selectedSifAsin = "";
let sifSearchSortDirection = "";
let sifDetailState = { asin: "", keyword: "", startDate: "", endDate: "" };
let sifDetailDatePickerOpen = false;
let sifDetailDatePickerMonth = "";
const MAIL_TEMPLATE_KEY = "amazonAggregator.mailTemplate.v1";
const FBA_COLUMNS_KEY = "amazonAggregator.fbaColumns.v1";
const FBA_SORT_KEY = "amazonAggregator.fbaSort.v1";
const FBA_FILTERS_KEY = "amazonAggregator.fbaFilters.v1";
const FBA_COLUMN_WIDTHS_KEY = "amazonAggregator.fbaColumnWidths.v1";
const FBA_REPLENISHMENT_OVERRIDES_KEY = "amazonAggregator.fbaReplenishment.overrides.v1";
const FBA_REPLENISHMENT_MULTIPLIER_KEY = "amazonAggregator.fbaReplenishment.multiplier.v1";
const FACTORY_COLUMN_WIDTH_KEY = "amazonAggregator.factoryColumnWidth.v1";
const fbaDateStatus = new Map();
let dateRangePickerOpen = false;
let datePickerMonth = "";
const adsHistoryDateStatus = new Map();
let adsHistoryDatePickerOpen = false;
let adsHistoryDatePickerMonth = "";
const adsDateStatus = new Map();
let adsDatePickerOpen = false;
let adsDatePickerMonth = "";
let fbaVisibleColumns = new Set();
let fbaSort = { key: "totalGoodsQuantity", direction: "desc" };
let fbaColumnFilters = {};
let fbaColumnWidths = {};
let fbaColumnResizeState = null;
let fbaReplenishmentOpen = false;
let factoryProductColumnWidth = Number(localStorage.getItem(FACTORY_COLUMN_WIDTH_KEY) || 170);
if (!Number.isFinite(factoryProductColumnWidth) || factoryProductColumnWidth <= 0) factoryProductColumnWidth = 170;
let fbaReplenishmentMultiplier = Number(localStorage.getItem(FBA_REPLENISHMENT_MULTIPLIER_KEY) || 1.2);
if (!Number.isFinite(fbaReplenishmentMultiplier) || fbaReplenishmentMultiplier <= 0) fbaReplenishmentMultiplier = 1.2;
let fbaReplenishmentOverrides = {};
try {
  fbaReplenishmentOverrides = JSON.parse(localStorage.getItem(FBA_REPLENISHMENT_OVERRIDES_KEY) || "{}") || {};
} catch {
  fbaReplenishmentOverrides = {};
}

const fbaReplenishmentTargets = {
  normal: { label: "普通", shippingDays: 70, replenishmentDays: 90 },
  promoted: { label: "主推", shippingDays: 100, replenishmentDays: 120 },
  featured: { label: "特推", shippingDays: 115, replenishmentDays: 135 },
  abandoned: { label: "放弃", abandoned: true }
};

const fbaReplenishmentColumns = [
  { key: "replenishmentDailySales", label: "日销量", type: "number", render: product => renderFbaDailySalesCell(product) },
  { key: "replenishmentBoxQty", label: "每箱数量", type: "number", render: product => renderFbaBoxQuantityCell(product) },
  { key: "replenishmentShippingQty", label: "发货数", type: "number", render: product => renderFbaPlanQuantityCell(product, "shipping") },
  { key: "replenishmentReplenishQty", label: "补货数", type: "number", render: product => renderFbaPlanQuantityCell(product, "replenishment") }
];

const fbaColumns = [
  { key: "replenishmentGrade", label: "商品等级", type: "static", always: true, render: product => renderFbaGradeCell(product) },
  { key: "image", label: "图片", type: "static", always: true, render: product => product.imageUrl ? `<img class="fba-thumb" src="${escapeHtml(product.imageUrl)}" alt="${escapeHtml(product.title || product.asin)}">` : `<div class="fba-thumb placeholder">无图</div>` },
  { key: "factoryName", label: "内部名", type: "text", value: product => getFbaProductFactoryName(product), render: product => renderFbaFactoryNameCell(product) },
  { key: "asinSku", label: "ASIN/MSKU", type: "text", always: true, value: product => `${product.asin || ""} ${product.sellerSku || ""}`, render: product => `<a href="https://www.amazon.com/dp/${escapeHtml(product.asin)}" target="_blank" rel="noopener noreferrer">${escapeHtml(product.asin || "-")}</a><span>${escapeHtml(product.sellerSku || "-")}</span>` },
  { key: "parentAsin", label: "父ASIN", type: "text", value: product => product.parentAsin || "", render: product => product.parentAsin ? `<a href="https://www.amazon.com/dp/${escapeHtml(product.parentAsin)}" target="_blank" rel="noopener noreferrer">${escapeHtml(product.parentAsin)}</a>` : "-" },
  { key: "fnSku", label: "FNSKU/SKU", type: "text", value: product => `${product.fnSku || ""} ${product.sellerSku || ""}`, render: product => `<strong>${escapeHtml(product.fnSku || "-")}</strong><span>${escapeHtml(product.sellerSku || "-")}</span>` },
  { key: "title", label: "标题", type: "text", value: product => `${product.title || ""} ${product.brand || ""} ${product.condition || ""}`, render: product => `${escapeHtml(product.title || "-")}<span>${escapeHtml(product.brand || product.condition || "")}</span>` },
  { key: "factoryFbaTotalQuantity", label: "工厂+FBA\n总库存", type: "number", value: product => getProductFactoryFbaTotalQuantity(product), render: product => formatInventoryNumber(getProductFactoryFbaTotalQuantity(product)) },
  { key: "factoryQuantity", label: "工厂总库存", type: "number", value: product => getProductFactoryQuantity(product), render: product => formatInventoryNumber(getProductFactoryQuantity(product)) },
  { key: "totalGoodsQuantity", label: "FBA总库存", type: "number", value: product => getProductTotalGoods(product), render: product => formatInventoryNumber(getProductTotalGoods(product)) },
  { key: "fulfillableQuantity", label: "可售", type: "number", value: product => Number(getProductInventoryField(product, "fulfillableQuantity") || 0), render: product => formatNumber(getProductInventoryField(product, "fulfillableQuantity")) },
  { key: "inboundQuantity", label: "在路上", type: "number", value: product => getProductInboundQuantity(product), render: product => formatInventoryNumber(getProductInboundQuantity(product)) },
  { key: "inboundWorkingQuantity", label: "入库计划\n（在路上）", type: "number", value: product => getProductInventoryField(product, "inboundWorkingQuantity"), render: product => formatInventoryNumber(getProductInventoryField(product, "inboundWorkingQuantity")) },
  { key: "inboundShippedQuantity", label: "已发货\n（在路上）", type: "number", value: product => getProductInventoryField(product, "inboundShippedQuantity"), render: product => formatInventoryNumber(getProductInventoryField(product, "inboundShippedQuantity")) },
  { key: "inboundReceivingQuantity", label: "接收中\n（在路上）", type: "number", value: product => getProductInventoryField(product, "inboundReceivingQuantity"), render: product => formatInventoryNumber(getProductInventoryField(product, "inboundReceivingQuantity")) },
  { key: "reservedQuantity", label: "预留", type: "number", value: product => getProductInventoryField(product, "reservedQuantity"), render: product => formatInventoryNumber(getProductInventoryField(product, "reservedQuantity")) },
  { key: "unfulfillableQuantity", label: "不可售", type: "number", value: product => Number(getProductInventoryField(product, "unfulfillableQuantity") || 0), render: product => formatNumber(getProductInventoryField(product, "unfulfillableQuantity")) },
  { key: "salesOrders", label: "售卖订单", type: "number", value: product => Number(product.salesOrders || 0), render: product => formatNumber(product.salesOrders) },
  { key: "salesUnits", label: "售卖数量", type: "number", value: product => Number(product.salesUnits || 0), render: product => formatNumber(product.salesUnits) },
  { key: "dailySales", label: "日销量", type: "number", value: product => Number(product.dailySales || 0), render: product => formatNumber(product.dailySales, 2) },
  { key: "stockoutDays", label: "缺货天数", type: "number", value: product => Number(product.stockoutDays || 0), render: product => Number(product.stockoutDays || 0) > 0 ? `<span class="stock-pill stock-low">${formatNumber(product.stockoutDays)} 天</span>` : "0" },
  { key: "sellableDays", label: "FBA\n可售天数", type: "number", value: product => getProductSellableDays(product), render: product => renderProductSellableDays(product) },
  { key: "factoryFbaSellableDays", label: "工厂+FBA\n可售天数", type: "number", value: product => getProductFactoryFbaSellableDays(product), render: product => renderFactoryFbaSellableDays(product) }
];

function getDefaultFbaColumnWidth(column) {
  if (column.key === "replenishmentGrade") return 156;
  if (column.key === "replenishmentDailySales") return 210;
  if (column.key === "replenishmentBoxQty") return 94;
  if (column.key === "replenishmentShippingQty" || column.key === "replenishmentReplenishQty") return 170;
  if (column.key === "image") return 86;
  if (column.key === "asinSku") return 156;
  if (column.key === "parentAsin") return 126;
  if (column.key === "fnSku") return 150;
  if (column.key === "title") return 360;
  if (column.key === "factoryName") return 180;
  if (column.type === "number") return 112;
  return 130;
}

function getFbaColumnWidth(column) {
  const value = Number(fbaColumnWidths[column.key]);
  return Number.isFinite(value) && value > 0 ? Math.max(72, value) : getDefaultFbaColumnWidth(column);
}

function normalizeFbaProductRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter(row => row && typeof row === "object")
    .map(row => ({
      ...row,
      asin: row.asin || "",
      parentAsin: row.parentAsin || "",
      sellerSku: row.sellerSku || "",
      fnSku: row.fnSku || "",
      title: row.title || "",
      brand: row.brand || "",
      factoryName: row.factoryName || "",
      stockLevel: row.stockLevel || "unknown",
      factoryFbaStockLevel: row.factoryFbaStockLevel || "unknown"
    }));
}

function renderFbaColumnWidths(visibleColumns = getVisibleFbaColumns()) {
  const colgroup = $("#fbaTableColumns");
  const table = colgroup?.closest("table");
  if (!colgroup || !table) return;
  const widths = visibleColumns.map(column => getFbaColumnWidth(column));
  colgroup.innerHTML = visibleColumns.map((column, index) =>
    `<col data-fba-col="${escapeHtml(column.key)}" style="width:${widths[index]}px">`
  ).join("");
  table.style.width = `${widths.reduce((sum, width) => sum + width, 0)}px`;
  const stickyKeys = new Set(fbaReplenishmentOpen
    ? ["replenishmentGrade", "replenishmentDailySales", "replenishmentBoxQty", "replenishmentShippingQty", "replenishmentReplenishQty", "image", "factoryName", "asinSku"]
    : ["replenishmentGrade", "image", "factoryName", "asinSku"]);
  let stickyLeft = 0;
  visibleColumns.forEach((column, index) => {
    if (!stickyKeys.has(column.key)) return;
    table.style.setProperty(`--fba-left-${column.key}`, `${stickyLeft}px`);
    stickyLeft += widths[index];
  });
}

function getLatestRealtimeInventory(product) {
  return product?.latestRealtimeInventory && typeof product.latestRealtimeInventory === "object"
    ? product.latestRealtimeInventory
    : null;
}

function getProductFactoryQuantity(product) {
  if (fbaReplenishmentOpen) {
    return Number(getFactoryProductForFbaProduct(product)?.currentQuantity || 0);
  }
  return product.factoryQuantity;
}

function getProductInventoryField(product, field) {
  const latest = fbaReplenishmentOpen ? getLatestRealtimeInventory(product) : null;
  if (latest && latest[field] !== null && latest[field] !== undefined && latest[field] !== "") {
    return latest[field];
  }
  return product[field];
}

function getProductFactoryFbaTotalQuantity(product) {
  const totalGoods = getProductTotalGoods(product);
  if (fbaReplenishmentOpen) {
    const factoryQuantity = getProductFactoryQuantity(product);
    if (totalGoods === null || factoryQuantity === null || factoryQuantity === undefined) return null;
    return Number(totalGoods || 0) + Number(factoryQuantity || 0);
  }
  if (totalGoods === null) return null;
  if (product.factoryFbaTotalUsesFactory === false) return Number(totalGoods || 0);
  const factoryQuantity = getProductFactoryQuantity(product);
  if (factoryQuantity === null || factoryQuantity === undefined) return null;
  return Number(totalGoods || 0) + Number(factoryQuantity || 0);
}

function stockLevelForDays(days) {
  if (days === null || days === undefined) return "unknown";
  return days < 14 ? "low" : days < 30 ? "medium" : "healthy";
}

function getProductSellableDays(product) {
  const totalQuantity = getProductTotalGoods(product);
  if (totalQuantity === null || totalQuantity === undefined) return null;
  const dailySales = Number(product.dailySales || 0);
  if (dailySales <= 0) return null;
  return Math.floor(Number(totalQuantity || 0) / dailySales);
}

function renderProductSellableDays(product) {
  const totalQuantity = getProductTotalGoods(product);
  if (totalQuantity === null || totalQuantity === undefined) return "/";
  const days = getProductSellableDays(product);
  if (days === null) return "无销量";
  return `<span class="stock-pill stock-${escapeHtml(stockLevelForDays(days))}">${formatNumber(days)} 天</span>`;
}

function getProductFactoryFbaSellableDays(product) {
  const totalQuantity = getProductFactoryFbaTotalQuantity(product);
  if (totalQuantity === null || totalQuantity === undefined) return null;
  const dailySales = Number(product.dailySales || 0);
  if (dailySales <= 0) return null;
  return Math.floor(Number(totalQuantity || 0) / dailySales);
}

function renderFactoryFbaSellableDays(product) {
  const totalQuantity = getProductFactoryFbaTotalQuantity(product);
  if (totalQuantity === null || totalQuantity === undefined) return "/";
  const days = getProductFactoryFbaSellableDays(product);
  if (days === null) return "无销量";
  return `<span class="stock-pill stock-${escapeHtml(stockLevelForDays(days))}">${formatNumber(days)} 天</span>`;
}

function getProductTotalGoods(product) {
  const latest = fbaReplenishmentOpen ? getLatestRealtimeInventory(product) : null;
  if (latest) {
    return latest.totalGoodsQuantity === null || latest.totalGoodsQuantity === undefined
      ? null
      : Number(latest.totalGoodsQuantity || 0);
  }
  if (product.totalGoodsQuantity === null || product.totalQuantity === null) return null;
  if (product.totalGoodsQuantity !== undefined && product.totalGoodsQuantity !== "") {
    return Number(product.totalGoodsQuantity || 0);
  }
  const values = [
    product.fulfillableQuantity,
    product.reservedQuantity,
    product.inboundWorkingQuantity,
    product.inboundShippedQuantity,
    product.inboundReceivingQuantity
  ];
  const hasInventoryFields = values.some(value => value !== null && value !== undefined && value !== "");
  if (hasInventoryFields) {
    return values.reduce((sum, value) => sum + Number(value || 0), 0);
  }
  if (product.totalQuantity !== null && product.totalQuantity !== undefined && product.totalQuantity !== "") {
    return Number(product.totalQuantity || 0);
  }
  return null;
}

function getProductInboundQuantity(product) {
  const latest = fbaReplenishmentOpen ? getLatestRealtimeInventory(product) : null;
  if (latest) {
    return latest.inboundQuantity === null || latest.inboundQuantity === undefined
      ? null
      : Number(latest.inboundQuantity || 0);
  }
  if (product.inboundQuantity !== null && product.inboundQuantity !== undefined && product.inboundQuantity !== "") {
    return Number(product.inboundQuantity || 0);
  }
  const values = [
    product.inboundWorkingQuantity,
    product.inboundShippedQuantity,
    product.inboundReceivingQuantity
  ];
  if (values.every(value => value === null || value === undefined || value === "")) return null;
  return values.reduce((sum, value) => sum + Number(value || 0), 0);
}

function getFbaReplenishmentKey(product) {
  return String(product.sellerSku || product.asin || "").trim();
}

function getFbaGradeAsin(product) {
  return String(product?.asin || "").trim().toUpperCase();
}

function saveFbaReplenishmentSettings() {
  localStorage.setItem(FBA_REPLENISHMENT_MULTIPLIER_KEY, String(fbaReplenishmentMultiplier));
  localStorage.setItem(FBA_REPLENISHMENT_OVERRIDES_KEY, JSON.stringify(fbaReplenishmentOverrides));
}

async function saveFbaGradesToServer(grades) {
  const payload = {};
  for (const [asin, grade] of Object.entries(grades || {})) {
    const normalizedAsin = String(asin || "").trim().toUpperCase();
    if (/^B[A-Z0-9]{9}$/.test(normalizedAsin) && fbaReplenishmentTargets[grade]) {
      payload[normalizedAsin] = grade;
    }
  }
  if (!Object.keys(payload).length) return null;
  return api("/api/fba/grades", {
    method: "POST",
    body: { grades: payload }
  });
}

function getFbaGradeOverride(product) {
  return fbaReplenishmentTargets[product?.replenishmentGrade] ? product.replenishmentGrade : "";
}

function getFbaReplenishmentOverride(product) {
  const key = getFbaReplenishmentKey(product);
  const override = key ? (fbaReplenishmentOverrides[key] || {}) : {};
  const grade = getFbaGradeOverride(product);
  return grade ? { ...override, grade } : override;
}

function getFactoryProductForFbaProduct(product) {
  const asin = String(product?.asin || "").trim().toUpperCase();
  if (!asin) return null;
  return factoryProducts.find(item => String(item.asin || "").trim().toUpperCase() === asin) || null;
}

function getFbaProductFactoryName(product) {
  return product?.factoryName || getFactoryProductForFbaProduct(product)?.name || "";
}

function getFbaProductFactoryProductId(product) {
  return product?.factoryProductId || getFactoryProductForFbaProduct(product)?.id || "";
}

function updateFbaReplenishmentOverride(product, patch) {
  const key = getFbaReplenishmentKey(product);
  const { grade, ...rowPatch } = patch || {};
  if (grade !== undefined) {
    product.replenishmentGrade = grade;
    if (key && fbaReplenishmentOverrides[key]?.grade !== undefined) {
      const { grade: _legacyGrade, ...rest } = fbaReplenishmentOverrides[key];
      fbaReplenishmentOverrides[key] = rest;
    }
  }
  if (key && Object.keys(rowPatch).length) {
    fbaReplenishmentOverrides[key] = { ...(fbaReplenishmentOverrides[key] || {}), ...rowPatch };
  }
  saveFbaReplenishmentSettings();
}

function parseBoxQuantity(value) {
  const text = String(value || "").trim();
  const slashMatch = text.match(/\/\s*(\d+(?:\.\d+)?)\s*个/);
  const unitMatches = [...text.matchAll(/(\d+(?:\.\d+)?)\s*个/g)];
  const match = slashMatch || (unitMatches.length ? unitMatches[unitMatches.length - 1] : null) || text.match(/\d+(?:\.\d+)?/);
  const parsed = match ? Number(match[1] || match[0]) : Number(value || 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function roundUpToBox(quantity, boxQuantity) {
  const box = Number(boxQuantity || 0);
  if (!box || box <= 0) return Math.ceil(Number(quantity || 0));
  return Math.ceil(Math.max(0, Number(quantity || 0)) / box) * box;
}

function formatPlanInputValue(value, digits = 2) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return "";
  return String(Number(number.toFixed(digits)));
}

function calculateFbaReplenishmentPlan(product) {
  const override = getFbaReplenishmentOverride(product);
  const grade = fbaReplenishmentTargets[override.grade] ? override.grade : "normal";
  const target = fbaReplenishmentTargets[grade];
  const baseDailySales = Number(product.replenishmentSales?.baseDailySales || product.dailySales || 0);
  const multiplier = Number(fbaReplenishmentMultiplier || 1.2);
  const calculatedDailySales = Number((baseDailySales * multiplier).toFixed(2));
  const dailySales = Number.isFinite(Number(override.dailySales)) && Number(override.dailySales) >= 0
    ? Number(override.dailySales)
    : calculatedDailySales;
  const boxQuantity = Number.isFinite(Number(override.boxQuantity)) && Number(override.boxQuantity) > 0
    ? Number(override.boxQuantity)
    : parseBoxQuantity(product.factoryBoxSpec || getFactoryProductForFbaProduct(product)?.boxSpec);
  if (fbaReplenishmentOpen && !getLatestRealtimeInventory(product)) {
    return {
      grade,
      target,
      baseDailySales,
      multiplier,
      calculatedDailySales,
      dailySales,
      boxQuantity,
      fbaCoverageDays: 0,
      totalCoverageDays: 0,
      shippingQuantity: 0,
      shippingBoxes: 0,
      replenishmentQuantity: 0,
      replenishmentBoxes: 0,
      inventoryMissing: true
    };
  }
  if (target?.abandoned) {
    return {
      grade,
      target,
      baseDailySales,
      multiplier,
      calculatedDailySales,
      dailySales,
      boxQuantity,
      fbaCoverageDays: 0,
      totalCoverageDays: 0,
      shippingQuantity: 0,
      shippingBoxes: 0,
      replenishmentQuantity: 0,
      replenishmentBoxes: 0
    };
  }
  const fbaTotal = getProductTotalGoods(product);
  const factoryQuantity = Number(getProductFactoryQuantity(product) ?? getFactoryProductForFbaProduct(product)?.currentQuantity ?? 0);
  const fbaCoverageDays = dailySales > 0 && fbaTotal !== null ? Number(fbaTotal || 0) / dailySales : 0;
  const effectiveFbaCoverageDays = Math.max(fbaCoverageDays, 30);
  const shippingRaw = Math.max(0, target.shippingDays - effectiveFbaCoverageDays) * dailySales;
  const calculatedShippingQuantity = Math.min(roundUpToBox(shippingRaw, boxQuantity), factoryQuantity);
  const calculatedShippingBoxes = boxQuantity > 0 ? Math.ceil(Number(calculatedShippingQuantity || 0) / boxQuantity) : 0;
  const hasShippingQuantityOverride = Number.isFinite(Number(override.shippingQuantity)) && Number(override.shippingQuantity) >= 0;
  const shippingQuantityOverride = hasShippingQuantityOverride ? Number(override.shippingQuantity) : null;
  const shippingBoxes = hasShippingQuantityOverride && boxQuantity > 0
    ? shippingQuantityOverride / boxQuantity
    : (Number.isFinite(Number(override.shippingBoxes)) && Number(override.shippingBoxes) >= 0
      ? Number(override.shippingBoxes)
      : calculatedShippingBoxes);
  const shippingQuantity = hasShippingQuantityOverride
    ? Math.min(shippingQuantityOverride, factoryQuantity)
    : Math.min(shippingBoxes * boxQuantity, factoryQuantity);
  const factoryAfterShipping = Math.max(0, factoryQuantity - Number(shippingQuantity || 0));
  const totalCoverageQuantity = Number(fbaTotal || 0) + factoryAfterShipping;
  const totalCoverageDays = dailySales > 0 ? totalCoverageQuantity / dailySales : 0;
  const effectiveTotalCoverageDays = Math.max(totalCoverageDays, 60);
  const replenishmentRaw = Math.max(0, target.replenishmentDays - effectiveTotalCoverageDays) * dailySales;
  const calculatedReplenishmentQuantity = roundUpToBox(replenishmentRaw, boxQuantity);
  const calculatedReplenishmentBoxes = boxQuantity > 0 ? Math.ceil(Number(calculatedReplenishmentQuantity || 0) / boxQuantity) : 0;
  const hasReplenishmentQuantityOverride = Number.isFinite(Number(override.replenishmentQuantity)) && Number(override.replenishmentQuantity) >= 0;
  const replenishmentQuantityOverride = hasReplenishmentQuantityOverride ? Number(override.replenishmentQuantity) : null;
  const replenishmentBoxes = hasReplenishmentQuantityOverride && boxQuantity > 0
    ? replenishmentQuantityOverride / boxQuantity
    : (Number.isFinite(Number(override.replenishmentBoxes)) && Number(override.replenishmentBoxes) >= 0
      ? Number(override.replenishmentBoxes)
      : calculatedReplenishmentBoxes);
  const replenishmentQuantity = hasReplenishmentQuantityOverride
    ? replenishmentQuantityOverride
    : replenishmentBoxes * boxQuantity;
  return {
    grade,
    target,
    baseDailySales,
    multiplier,
    calculatedDailySales,
    dailySales,
    boxQuantity,
    fbaCoverageDays,
    totalCoverageDays,
    shippingQuantity,
    shippingBoxes,
    replenishmentQuantity,
    replenishmentBoxes
  };
}

function renderFbaGradeCell(product) {
  const plan = calculateFbaReplenishmentPlan(product);
  const currentTarget = fbaReplenishmentTargets[plan.grade] || fbaReplenishmentTargets.normal;
  return `
    <div class="fba-grade-picker">
      <button class="fba-grade-select fba-grade-select-${escapeHtml(plan.grade)}" type="button" data-fba-grade-toggle aria-haspopup="listbox" aria-expanded="false">
        ${escapeHtml(currentTarget.label)}
      </button>
      <div class="fba-grade-menu" role="listbox">
        ${Object.entries(fbaReplenishmentTargets).map(([key, target]) =>
          `<button class="fba-grade-option fba-grade-option-${escapeHtml(key)} ${plan.grade === key ? "active" : ""}" type="button" role="option" aria-selected="${plan.grade === key ? "true" : "false"}" data-fba-plan-key="${escapeHtml(getFbaReplenishmentKey(product))}" data-fba-grade-option="${escapeHtml(key)}">${target.abandoned ? escapeHtml(target.label) : `${escapeHtml(target.label)} 发${formatNumber(target.shippingDays)}天 / 补${formatNumber(target.replenishmentDays)}天`}</button>`
        ).join("")}
      </div>
    </div>
  `;
}

function renderFbaFactoryNameCell(product) {
  const factoryProductId = getFbaProductFactoryProductId(product);
  const value = getFbaProductFactoryName(product);
  if (!factoryProductId) {
    return `<span title="这个 ASIN 还没有对应的工厂库存商品">${escapeHtml(value || "-")}</span>`;
  }
  return `
    <input class="fba-factory-name-input" data-fba-factory-name data-product-id="${escapeHtml(factoryProductId)}" type="text" value="${escapeHtml(value)}" placeholder="内部名">
  `;
}

async function saveFactoryProductName(productId, name) {
  const currentProduct = factoryProducts.find(item => item.id === productId);
  const currentFbaProduct = products.find(product => getFbaProductFactoryProductId(product) === productId);
  const current = String(currentProduct?.name ?? currentFbaProduct?.factoryName ?? "");
  const nextName = String(name || "").trim();
  if (nextName === current) return;
  const data = await api(`/api/factory-inventory/products/${encodeURIComponent(productId)}`, {
    method: "PUT",
    body: { name: nextName }
  });
  factoryProducts = data.products || [];
  factoryMovements = data.movements || [];
  factoryTotals = data.totals || {};
  factoryProducts = factoryProducts.map(item => item.id === productId ? { ...item, name: nextName } : item);
  const updated = factoryProducts.find(item => item.id === productId);
  const updatedAsin = String(updated?.asin || currentProduct?.asin || "").trim().toUpperCase();
  products = products.map(product => {
    const productFactoryId = getFbaProductFactoryProductId(product);
    const productAsin = String(product.asin || "").trim().toUpperCase();
    if (productFactoryId !== productId && (!updatedAsin || productAsin !== updatedAsin)) return product;
    return { ...product, factoryProductId: productId, factoryName: updated?.name || nextName };
  });
}

function renderFbaDailySalesCell(product) {
  const plan = calculateFbaReplenishmentPlan(product);
  const sales = product.replenishmentSales || {};
  return `
    <div class="fba-plan-formula" title="7天 ${formatNumber(sales.sevenDailySales || 0, 2)}；30天 ${formatNumber(sales.thirtyDailySales || 0, 2)}；已排除断货日和最近2天">
      <span>日均 ${formatNumber(plan.baseDailySales, 2)} x ${formatNumber(plan.multiplier, 2)} =</span>
      <input class="fba-plan-mini-input" data-fba-plan-field="dailySales" data-fba-plan-key="${escapeHtml(getFbaReplenishmentKey(product))}" type="number" step="0.01" min="0" value="${escapeHtml(plan.dailySales)}">
    </div>
  `;
}

function renderFbaBoxQuantityCell(product) {
  const plan = calculateFbaReplenishmentPlan(product);
  return `<input class="fba-plan-input" data-fba-plan-field="boxQuantity" data-fba-plan-key="${escapeHtml(getFbaReplenishmentKey(product))}" type="number" step="1" min="1" value="${escapeHtml(plan.boxQuantity)}">`;
}

function renderFbaPlanQuantityCell(product, type) {
  const plan = calculateFbaReplenishmentPlan(product);
  if (plan.inventoryMissing) {
    return `<span title="缺少最新实时库存，不能生成发补货建议">/</span>`;
  }
  const isShipping = type === "shipping";
  const boxes = isShipping ? plan.shippingBoxes : plan.replenishmentBoxes;
  const quantity = isShipping ? plan.shippingQuantity : plan.replenishmentQuantity;
  const boxesField = isShipping ? "shippingBoxes" : "replenishmentBoxes";
  const quantityField = isShipping ? "shippingQuantity" : "replenishmentQuantity";
  const factoryQuantity = Number(getProductFactoryQuantity(product) ?? getFactoryProductForFbaProduct(product)?.currentQuantity ?? 0);
  const factoryBoxesAfterReplenishment = plan.boxQuantity > 0
    ? (factoryQuantity + Number(plan.replenishmentQuantity || 0)) / plan.boxQuantity
    : 0;
  const warning = isShipping
    ? (boxes > 0 && boxes < 5 ? "发货不满5箱" : "")
    : (factoryBoxesAfterReplenishment > 0 && factoryBoxesAfterReplenishment < 5 ? "补货后工厂库存不满5箱" : "");
  return `
    <div class="fba-plan-cell ${warning ? "has-warning" : ""}">
      <div class="fba-plan-formula">
        <input class="fba-plan-mini-input ${warning ? "fba-plan-input-warning" : ""}" data-fba-plan-field="${boxesField}" data-fba-plan-key="${escapeHtml(getFbaReplenishmentKey(product))}" type="number" step="0.01" min="0" value="${escapeHtml(formatPlanInputValue(boxes, 2))}">
        <span>箱 x ${formatNumber(plan.boxQuantity)} =</span>
        <input class="fba-plan-quantity-input" data-fba-plan-field="${quantityField}" data-fba-plan-key="${escapeHtml(getFbaReplenishmentKey(product))}" type="number" step="1" min="0" value="${escapeHtml(formatPlanInputValue(quantity, 0))}">
      </div>
      ${warning ? `<div class="fba-plan-warning">${escapeHtml(warning)}</div>` : ""}
    </div>
  `;
}

function loadFbaTablePreferences() {
  const defaultColumns = fbaColumns.map(column => column.key);
  try {
    const savedColumns = JSON.parse(localStorage.getItem(FBA_COLUMNS_KEY) || "null");
    fbaVisibleColumns = new Set(Array.isArray(savedColumns) && savedColumns.length ? savedColumns : defaultColumns);
  } catch {
    fbaVisibleColumns = new Set(defaultColumns);
  }
  fbaVisibleColumns.delete("coverDays");
  fbaVisibleColumns.delete("lastUpdatedTime");
  fbaVisibleColumns.add("factoryFbaTotalQuantity");
  fbaVisibleColumns.add("factoryQuantity");
  fbaVisibleColumns.add("factoryName");
  fbaVisibleColumns.add("totalGoodsQuantity");
  fbaVisibleColumns.add("inboundQuantity");
  fbaVisibleColumns.add("stockoutDays");
  fbaVisibleColumns.add("sellableDays");
  fbaVisibleColumns.add("factoryFbaSellableDays");
  for (const column of fbaColumns) {
    if (column.always) fbaVisibleColumns.add(column.key);
  }
  try {
    fbaSort = { ...fbaSort, ...(JSON.parse(localStorage.getItem(FBA_SORT_KEY) || "{}") || {}) };
  } catch {
    // Keep defaults.
  }
  try {
    fbaColumnFilters = JSON.parse(localStorage.getItem(FBA_FILTERS_KEY) || "{}") || {};
  } catch {
    fbaColumnFilters = {};
  }
  try {
    fbaColumnWidths = JSON.parse(localStorage.getItem(FBA_COLUMN_WIDTHS_KEY) || "{}") || {};
  } catch {
    fbaColumnWidths = {};
  }
}

loadFbaTablePreferences();

const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\"": "&quot;",
  "'": "&#039;"
}[char]));

function clampFactoryColumnWidth(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(100, Math.min(320, Math.round(number))) : 170;
}

function applyFactoryColumnWidth(width = factoryProductColumnWidth) {
  factoryProductColumnWidth = clampFactoryColumnWidth(width);
  document.documentElement.style.setProperty("--factory-product-column-width", `${factoryProductColumnWidth}px`);
  const input = $("#factoryColumnWidth");
  if (input) input.value = String(factoryProductColumnWidth);
}

function saveFactoryColumnWidth(width) {
  applyFactoryColumnWidth(width);
  localStorage.setItem(FACTORY_COLUMN_WIDTH_KEY, String(factoryProductColumnWidth));
}

applyFactoryColumnWidth();

function renderColumnLabel(label) {
  return escapeHtml(label).replace(/\n/g, "<br>");
}

function renderFilterColumnLabel(label) {
  return escapeHtml(String(label || "").replace(/\n/g, ""));
}

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
  if (module === "keywordMonitor") {
    refreshSifWorkspace(selectedSifAsin).catch(error => showSifAuthorization(error.message));
  }
  if (module === "inventory") {
    renderFactoryInventory();
    if (!factoryLoaded) loadFactoryInventory().catch(error => {
      $("#sandboxStatus").textContent = `工厂库存读取失败：${error.message}`;
    });
  }
  if (module === "settings" && !systemSchedulesLoaded) loadSystemSchedules().catch(error => {
    $("#systemScheduleList").innerHTML = `<div class="empty">定时计划读取失败：${escapeHtml(error.message)}</div>`;
  });
  if (module === "dashboard") renderDashboard();
}

function systemScheduleStatus(task) {
  if (!task.lastStartedAt) return "尚未执行";
  if (task.lastStatus === "FAILED") return `上次失败：${task.lastError || "未知错误"}`;
  if (task.lastStatus === "RUNNING") return `正在执行 · ${formatDate(task.lastStartedAt)}`;
  return `上次触发：${formatDate(task.lastStartedAt)}`;
}

function renderSystemSchedules() {
  const list = $("#systemScheduleList");
  if (!list) return;
  list.innerHTML = systemSchedules.map(task => `
    <section class="system-schedule-card ${task.enabled ? "enabled" : ""}" data-system-schedule="${escapeHtml(task.key)}">
      <label class="system-schedule-switch"><input data-system-schedule-enabled type="checkbox" ${task.enabled ? "checked" : ""}><span></span></label>
      <div class="system-schedule-copy"><strong>${escapeHtml(task.label)}</strong><p>${escapeHtml(task.description)}</p><small class="${task.lastStatus === "FAILED" ? "failed" : ""}">${escapeHtml(systemScheduleStatus(task))}</small></div>
      <div class="system-schedule-controls">
        ${task.scheduleType === "DAILY"
          ? `<label class="system-schedule-value">执行时间（北京时间）<input data-system-schedule-time type="time" value="${escapeHtml(task.timeBeijing || "09:00")}"></label>`
          : `<label class="system-schedule-value">执行间隔（分钟）<input data-system-schedule-interval type="number" min="${Number(task.minIntervalMinutes || 1)}" step="1" value="${Number(task.intervalMinutes || 60)}"></label>`}
        <button type="button" class="secondary-button system-schedule-run" data-system-schedule-run ${task.lastStatus === "RUNNING" ? "disabled" : ""}>立即执行</button>
      </div>
    </section>`).join("");
}

async function loadSystemSchedules() {
  const data = await api("/api/system/schedules");
  systemSchedules = data.tasks || [];
  systemSchedulesLoaded = true;
  renderSystemSchedules();
}

async function saveSystemSchedules(button) {
  const tasks = [...document.querySelectorAll("[data-system-schedule]")].map(card => {
    const existing = systemSchedules.find(item => item.key === card.dataset.systemSchedule) || {};
    return {
      key: card.dataset.systemSchedule,
      enabled: Boolean(card.querySelector("[data-system-schedule-enabled]")?.checked),
      timeBeijing: card.querySelector("[data-system-schedule-time]")?.value || existing.timeBeijing,
      intervalMinutes: Number(card.querySelector("[data-system-schedule-interval]")?.value || existing.intervalMinutes || 0)
    };
  });
  setBusy(button, true, "保存中");
  try {
    const data = await api("/api/system/schedules", { method: "PUT", body: { tasks } });
    systemSchedules = data.tasks || [];
    renderSystemSchedules();
  } finally {
    setBusy(button, false, "保存定时计划");
  }
}

async function runSystemScheduleNow(button) {
  const card = button.closest("[data-system-schedule]");
  const taskKey = card?.dataset.systemSchedule || "";
  if (!taskKey) return;
  setBusy(button, true, "执行中");
  try {
    const data = await api(`/api/system/schedules/${encodeURIComponent(taskKey)}/run`, { method: "POST", body: {} });
    systemSchedules = data.tasks || [];
    renderSystemSchedules();
  } finally {
    setBusy(button, false, "立即执行");
  }
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
  const end = new Date(Date.now() - 2 * 86400000);
  const start = new Date(end);
  start.setDate(start.getDate() - 29);
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

function formatInventoryNumber(value, digits = 0) {
  if (value === null || value === undefined || value === "") return "/";
  return formatNumber(value, digits);
}

function numberSortValue(value) {
  return value === null || value === undefined || value === "" ? -1 : Number(value || 0);
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
  const factoryQuick = $("#factoryQuickText");
  if (factoryQuick) factoryQuick.textContent = `查看 ${formatNumber(factoryTotals.currentQuantity || 0)} 件工厂库存`;
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

function downloadBase64File(filename, base64, type = "application/octet-stream") {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  const blob = new Blob([bytes], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
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
  if (!product || typeof product !== "object") return false;
  const keyword = ($("#productSearch")?.value || $("#globalSearch")?.value || "").trim().toLowerCase();
  const source = $("#productSourceFilter")?.value || "";
  if (source && product.stockLevel !== source) return false;
  const gradeFilter = fbaColumnFilters.replenishmentGrade || {};
  const allGradeKeys = Object.keys(fbaReplenishmentTargets);
  const selectedGradeKeys = Array.isArray(gradeFilter.values)
    ? gradeFilter.values
    : (gradeFilter.value ? [gradeFilter.value] : allGradeKeys);
  if (selectedGradeKeys.length < allGradeKeys.length && !selectedGradeKeys.includes(calculateFbaReplenishmentPlan(product).grade)) return false;
  if (keyword && ![
    product.asin,
    product.parentAsin,
    product.sellerSku,
    product.fnSku,
    product.title,
    product.factoryName,
    getFactoryProductForFbaProduct(product)?.name,
    product.brand
  ].join(" ").toLowerCase().includes(keyword)) return false;

  for (const column of fbaColumns) {
    const filter = fbaColumnFilters[column.key] || {};
    if (column.type === "number") {
      const hasMin = filter.min !== "" && filter.min !== undefined;
      const hasMax = filter.max !== "" && filter.max !== undefined;
      const rawValue = column.value?.(product);
      if ((hasMin || hasMax) && (rawValue === null || rawValue === undefined || rawValue === "")) return false;
      const value = Number(rawValue ?? 0);
      if (filter.min !== "" && filter.min !== undefined && value < Number(filter.min)) return false;
      if (filter.max !== "" && filter.max !== undefined && value > Number(filter.max)) return false;
    } else if (column.type === "text") {
      const needle = String(filter.text || "").trim().toLowerCase();
      if (needle && !String(column.value?.(product) ?? "").toLowerCase().includes(needle)) return false;
    }
  }
  return true;
}

function getVisibleFbaColumns() {
  const selectedBaseColumns = fbaColumns.filter(column => column.always || fbaVisibleColumns.has(column.key));
  const pinnedOrder = ["replenishmentGrade", "image", "factoryName", "asinSku"];
  const baseColumns = [
    ...pinnedOrder
      .map(key => selectedBaseColumns.find(column => column.key === key))
      .filter(Boolean),
    ...selectedBaseColumns.filter(column => !pinnedOrder.includes(column.key))
  ];
  return fbaReplenishmentOpen ? [...fbaReplenishmentColumns, ...baseColumns] : baseColumns;
}

function compareFbaProducts(a, b) {
  const column = fbaColumns.find(item => item.key === fbaSort.key) || fbaColumns.find(item => item.key === "totalGoodsQuantity");
  const direction = fbaSort.direction === "asc" ? 1 : -1;
  const av = column?.value ? column.value(a) : a[column?.key];
  const bv = column?.value ? column.value(b) : b[column?.key];
  if (column?.type === "number") {
    return (numberSortValue(av) - numberSortValue(bv)) * direction;
  }
  return String(av || "").localeCompare(String(bv || "")) * direction;
}

function getNumericMetricValue(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function getTopFbaRowsByMetric(rows, metricGetter) {
  let maxValue = null;
  const winners = [];
  for (const row of rows) {
    const value = getNumericMetricValue(metricGetter(row));
    if (value === null) continue;
    if (maxValue === null || value > maxValue) {
      maxValue = value;
      winners.length = 0;
      winners.push(row);
    } else if (value === maxValue) {
      winners.push(row);
    }
  }
  return { hasMetric: maxValue !== null, winners };
}

function pickFbaRowsForAsinGroup(rows) {
  if (rows.length <= 1) return rows;
  const totalTop = getTopFbaRowsByMetric(rows, row => getProductTotalGoods(row));
  if (totalTop.hasMetric) {
    if (totalTop.winners.length === 1) return totalTop.winners;
    const salesTop = getTopFbaRowsByMetric(totalTop.winners, row => row.dailySales);
    return salesTop.hasMetric && salesTop.winners.length === 1 ? salesTop.winners : totalTop.winners;
  }
  const salesTop = getTopFbaRowsByMetric(rows, row => row.dailySales);
  return salesTop.hasMetric && salesTop.winners.length === 1 ? salesTop.winners : rows;
}

function collapseFbaRowsByAsin(rows) {
  const groups = new Map();
  const output = [];
  for (const row of rows) {
    const asin = String(row.asin || "").trim().toUpperCase();
    if (!asin) {
      output.push(row);
      continue;
    }
    if (!groups.has(asin)) groups.set(asin, []);
    groups.get(asin).push(row);
  }
  for (const group of groups.values()) {
    output.push(...pickFbaRowsForAsinGroup(group));
  }
  return output;
}

function saveFbaTablePreferences() {
  localStorage.setItem(FBA_COLUMNS_KEY, JSON.stringify([...fbaVisibleColumns]));
  localStorage.setItem(FBA_SORT_KEY, JSON.stringify(fbaSort));
  localStorage.setItem(FBA_FILTERS_KEY, JSON.stringify(fbaColumnFilters));
  localStorage.setItem(FBA_COLUMN_WIDTHS_KEY, JSON.stringify(fbaColumnWidths));
}

function resizeFbaColumn(key, width) {
  const nextWidth = Math.max(72, Math.min(640, Math.round(width)));
  fbaColumnWidths[key] = nextWidth;
  renderFbaColumnWidths();
}

function startFbaColumnResize(event) {
  const handle = event.target?.closest?.("[data-fba-resize]");
  if (!handle) return;
  const key = handle.dataset.fbaResize;
  const column = [...fbaReplenishmentColumns, ...fbaColumns].find(item => item.key === key);
  if (!column) return;
  event.preventDefault();
  event.stopPropagation();
  fbaColumnResizeState = {
    key,
    startX: event.clientX,
    startWidth: getFbaColumnWidth(column)
  };
  document.body.classList.add("fba-column-resizing");
  window.addEventListener("pointermove", handleFbaColumnResizeMove);
  window.addEventListener("pointerup", stopFbaColumnResize, { once: true });
}

function handleFbaColumnResizeMove(event) {
  if (!fbaColumnResizeState) return;
  resizeFbaColumn(fbaColumnResizeState.key, fbaColumnResizeState.startWidth + event.clientX - fbaColumnResizeState.startX);
}

function stopFbaColumnResize() {
  if (!fbaColumnResizeState) return;
  fbaColumnResizeState = null;
  document.body.classList.remove("fba-column-resizing");
  window.removeEventListener("pointermove", handleFbaColumnResizeMove);
  saveFbaTablePreferences();
}

function getActiveFbaFilterCount() {
  return Object.values(fbaColumnFilters).reduce((count, filter) => {
    if (!filter) return count;
    if (Array.isArray(filter.values)) {
      return count + (filter.values.length < Object.keys(fbaReplenishmentTargets).length ? 1 : 0);
    }
    return count + (Object.values(filter).some(value => String(value ?? "").trim() !== "") ? 1 : 0);
  }, 0);
}

function updateFbaToolButtons() {
  const columnButton = $("#fbaColumnSettingsBtn");
  const filterButton = $("#fbaFilterSettingsBtn");
  if (columnButton) {
    columnButton.textContent = `列 ${getVisibleFbaColumns().length}/${fbaColumns.length}`;
  }
  if (filterButton) {
    const count = getActiveFbaFilterCount();
    filterButton.textContent = count ? `筛选 ${count}` : "筛选";
  }
}

function openFbaColumnSettingsModal() {
  const modal = createModal("显示列与排序", `
    <div class="modal-body">
      <section class="fba-modal-section">
        <strong>显示列</strong>
        <div id="fbaColumnSettings" class="column-settings">
          ${fbaColumns.map(column => `
            <label class="column-option">
              <input type="checkbox" data-fba-column="${escapeHtml(column.key)}" ${fbaVisibleColumns.has(column.key) ? "checked" : ""} ${column.always ? "disabled" : ""}>
              <span>${escapeHtml(column.label)}</span>
            </label>
          `).join("")}
        </div>
      </section>
      <section class="fba-modal-section">
        <strong>默认排序</strong>
        <div class="settings-row">
          <select id="fbaSortColumn">
            ${fbaColumns
              .filter(column => column.value || column.type === "number")
              .map(column => `<option value="${escapeHtml(column.key)}" ${fbaSort.key === column.key ? "selected" : ""}>${escapeHtml(column.label)}</option>`)
              .join("")}
          </select>
          <select id="fbaSortDirection">
            <option value="desc" ${fbaSort.direction === "desc" ? "selected" : ""}>降序</option>
            <option value="asc" ${fbaSort.direction === "asc" ? "selected" : ""}>升序</option>
          </select>
        </div>
        <p class="fba-filter-hint">也可以直接点击表头切换排序。</p>
      </section>
      <div class="fba-modal-actions">
        <button type="button" class="secondary-button" id="fbaColumnDefaultsBtn">恢复默认列</button>
        <button type="button" data-close-modal>完成</button>
      </div>
    </div>
  `);
  modal.querySelector(".modal").classList.add("fba-column-modal");

  modal.querySelector("#fbaColumnSettings").addEventListener("change", event => {
    const key = event.target?.dataset?.fbaColumn;
    if (!key) return;
    if (event.target.checked) fbaVisibleColumns.add(key);
    else fbaVisibleColumns.delete(key);
    for (const column of fbaColumns) {
      if (column.always) fbaVisibleColumns.add(column.key);
    }
    saveFbaTablePreferences();
    updateFbaToolButtons();
    renderProducts();
  });
  modal.querySelector("#fbaSortColumn").addEventListener("change", event => {
    fbaSort.key = event.target.value;
    saveFbaTablePreferences();
    renderProducts();
  });
  modal.querySelector("#fbaSortDirection").addEventListener("change", event => {
    fbaSort.direction = event.target.value;
    saveFbaTablePreferences();
    renderProducts();
  });
  modal.querySelector("#fbaColumnDefaultsBtn").addEventListener("click", () => {
    fbaVisibleColumns = new Set(fbaColumns.map(column => column.key));
    saveFbaTablePreferences();
    updateFbaToolButtons();
    renderProducts();
    closeModal(modal);
  });
}

function openFbaFilterSettingsModal() {
  const gradeFilter = fbaColumnFilters.replenishmentGrade || {};
  const gradeKeys = Object.keys(fbaReplenishmentTargets);
  const selectedGradeKeys = new Set(Array.isArray(gradeFilter.values)
    ? gradeFilter.values
    : (gradeFilter.value ? [gradeFilter.value] : gradeKeys));
  const gradeFilterRow = `
    <div class="filter-row fba-grade-filter-row">
      <span>商品等级</span>
      <div class="fba-grade-filter-options">
        ${Object.entries(fbaReplenishmentTargets).map(([key, target]) => `
          <label>
            <input type="checkbox" data-fba-grade-filter value="${escapeHtml(key)}" ${selectedGradeKeys.has(key) ? "checked" : ""}>
            <span>${escapeHtml(target.label)}</span>
          </label>
        `).join("")}
      </div>
    </div>
  `;
  const filterRows = fbaColumns
    .filter(column => !column.always && column.type !== "static")
    .map(column => {
      const filter = fbaColumnFilters[column.key] || {};
      if (column.type === "number") {
        return `
          <div class="filter-row">
            <span>${renderFilterColumnLabel(column.label)}</span>
            <input type="number" data-fba-filter="${escapeHtml(column.key)}" data-filter-part="min" placeholder="最小" value="${escapeHtml(filter.min ?? "")}">
            <input type="number" data-fba-filter="${escapeHtml(column.key)}" data-filter-part="max" placeholder="最大" value="${escapeHtml(filter.max ?? "")}">
          </div>
        `;
      }
      return `
        <div class="filter-row">
          <span>${renderFilterColumnLabel(column.label)}</span>
          <input type="text" data-fba-filter="${escapeHtml(column.key)}" data-filter-part="text" placeholder="包含" value="${escapeHtml(filter.text ?? "")}">
          <span></span>
        </div>
      `;
    }).join("");

  const modal = createModal("数据筛选", `
    <div class="modal-body">
      <section class="fba-modal-section fba-filter-modal-section">
        <p class="fba-filter-hint">这里的筛选会和顶部搜索、库存水平一起生效。</p>
        <div id="fbaColumnFilters" class="column-filters">${gradeFilterRow}${filterRows}</div>
      </section>
      <div class="fba-modal-actions">
        <button type="button" class="secondary-button" id="fbaClearFiltersBtn">清空筛选</button>
        <button type="button" data-close-modal>完成</button>
      </div>
    </div>
  `);
  modal.querySelector(".modal").classList.add("fba-column-modal", "fba-filter-modal");

  const updateFilter = event => {
    if (event.target?.matches?.("[data-fba-grade-filter]")) {
      const values = [...modal.querySelectorAll("[data-fba-grade-filter]:checked")].map(input => input.value);
      fbaColumnFilters.replenishmentGrade = { values };
      saveFbaTablePreferences();
      updateFbaToolButtons();
      renderProducts();
      return;
    }
    const key = event.target?.dataset?.fbaFilter;
    const part = event.target?.dataset?.filterPart;
    if (!key || !part) return;
    fbaColumnFilters[key] = { ...(fbaColumnFilters[key] || {}), [part]: event.target.value };
    saveFbaTablePreferences();
    updateFbaToolButtons();
    renderProducts();
  };
  modal.querySelector("#fbaColumnFilters").addEventListener("input", updateFilter);
  modal.querySelector("#fbaColumnFilters").addEventListener("change", updateFilter);
  modal.querySelector("#fbaClearFiltersBtn").addEventListener("click", () => {
    fbaColumnFilters = {};
    saveFbaTablePreferences();
    updateFbaToolButtons();
    renderProducts();
    closeModal(modal);
  });
}

function renderProducts() {
  const list = $("#productList");
  if (!list) return;
  const replenishmentButton = $("#fbaReplenishmentToggleBtn");
  if (replenishmentButton) {
    replenishmentButton.textContent = fbaReplenishmentOpen ? "关闭发补货" : "打开发补货";
    replenishmentButton.classList.toggle("active", fbaReplenishmentOpen);
  }
  const visibleColumns = getVisibleFbaColumns();
  renderFbaColumnWidths(visibleColumns);
  const stickyKeys = new Set(fbaReplenishmentOpen
    ? ["replenishmentGrade", "replenishmentDailySales", "replenishmentBoxQty", "replenishmentShippingQty", "replenishmentReplenishQty", "image", "factoryName", "asinSku"]
    : ["replenishmentGrade", "image", "factoryName", "asinSku"]);
  const stickyOffsets = [];
  let stickyLeft = 0;
  for (const column of visibleColumns) {
    if (stickyKeys.has(column.key)) {
      stickyOffsets.push(column.key);
      stickyLeft += getFbaColumnWidth(column);
    } else {
      stickyOffsets.push(null);
    }
  }
  const cellAttrs = (column, index, tag = "td") => {
    const isSticky = stickyOffsets[index] !== null;
    const style = isSticky ? ` style="left:var(--fba-left-${escapeHtml(stickyOffsets[index])}, 0px)"` : "";
    const className = `${isSticky ? "fba-sticky-col " : ""}fba-col-${escapeHtml(column.key)}`;
    return { className, style };
  };
  const head = $("#fbaTableHead");
  if (head) {
    head.innerHTML = `<tr>${visibleColumns.map((column, index) => {
      const sortable = Boolean(column.value);
      const sortMark = fbaSort.key === column.key ? (fbaSort.direction === "asc" ? "↑" : "↓") : "";
      const attrs = cellAttrs(column, index, "th");
      const multiplierControl = column.key === "replenishmentDailySales"
        ? `<label class="fba-plan-head-control">系数 <input class="fba-plan-mini-input" data-fba-global-multiplier type="number" step="0.05" min="0" value="${escapeHtml(fbaReplenishmentMultiplier)}"></label>`
        : "";
      return `
        <th class="${sortable ? "sortable " : ""}${attrs.className}"${attrs.style} ${sortable ? `data-fba-sort="${escapeHtml(column.key)}"` : ""}>
          <span class="fba-th-label"><span class="fba-th-text">${renderColumnLabel(column.label)}</span>${sortMark ? `<span class="fba-sort-mark">${escapeHtml(sortMark)}</span>` : ""}</span>
          ${multiplierControl}
          ${column.key === "replenishmentShippingQty" ? `<button type="button" class="fba-plan-head-button" data-insert-fba-plan="shipping">插入发货计划</button>` : ""}
          ${column.key === "replenishmentReplenishQty" ? `<button type="button" class="fba-plan-head-button" data-insert-fba-plan="replenishment">插入补货计划</button>` : ""}
          <span class="fba-col-resizer" data-fba-resize="${escapeHtml(column.key)}" data-fba-col-index="${index}" title="拖动调整列宽"></span>
        </th>
      `;
    }).join("")}</tr>`;
  }
  const visible = collapseFbaRowsByAsin(products.filter(productMatches)).sort(compareFbaProducts);
  const summary = $("#fbaSummary");
  if (summary && window.fbaInventoryMeta) {
    const { totals, range, config, warnings, sales } = window.fbaInventoryMeta;
    const displayTotals = fbaReplenishmentOpen
      ? visible.reduce((acc, row) => {
        const totalGoods = getProductTotalGoods(row);
        const factoryQuantity = getProductFactoryQuantity(row);
        const inboundQuantity = getProductInboundQuantity(row);
        if (totalGoods === null || totalGoods === undefined) acc.totalGoodsQuantity = null;
        else if (acc.totalGoodsQuantity !== null) acc.totalGoodsQuantity += totalGoods;
        if (factoryQuantity === null || factoryQuantity === undefined) acc.factoryQuantity = null;
        else if (acc.factoryQuantity !== null && row.asin && !acc.factoryAsins.has(row.asin)) {
          acc.factoryAsins.add(row.asin);
          acc.factoryQuantity += factoryQuantity || 0;
        }
        if (inboundQuantity === null || inboundQuantity === undefined) acc.inboundQuantity = null;
        else if (acc.inboundQuantity !== null) acc.inboundQuantity += inboundQuantity || 0;
        acc.fulfillableQuantity += getProductInventoryField(row, "fulfillableQuantity") || 0;
        acc.salesUnits += row.salesUnits || 0;
        return acc;
      }, { totalGoodsQuantity: 0, factoryQuantity: 0, inboundQuantity: 0, fulfillableQuantity: 0, salesUnits: 0, factoryAsins: new Set() })
      : totals;
    const displayFactoryFbaTotal = displayTotals?.totalGoodsQuantity === null
      ? null
      : (displayTotals?.factoryQuantity === null
        ? Number(displayTotals?.totalGoodsQuantity || 0)
        : Number(displayTotals?.totalGoodsQuantity || 0) + Number(displayTotals?.factoryQuantity || 0));
    const inboundTotal = totals?.inventoryCompleteness === "partial"
      ? null
      : (totals?.inboundWorkingQuantity || 0) + (totals?.inboundShippedQuantity || 0) + (totals?.inboundReceivingQuantity || 0);
    summary.innerHTML = `
      <div class="fba-summary-card"><strong>${formatNumber(products.length)}</strong><span>SKU 数</span></div>
      <div class="fba-summary-card"><strong>${formatInventoryNumber(fbaReplenishmentOpen ? displayFactoryFbaTotal : totals?.factoryFbaTotalQuantity)}</strong><span>工厂+FBA<br>总库存</span></div>
      <div class="fba-summary-card"><strong>${formatInventoryNumber(displayTotals?.factoryQuantity)}</strong><span>工厂总库存</span></div>
      <div class="fba-summary-card"><strong>${formatInventoryNumber(fbaReplenishmentOpen ? displayTotals?.totalGoodsQuantity : (totals?.totalGoodsQuantity ?? totals?.totalQuantity))}</strong><span>FBA总库存</span></div>
      <div class="fba-summary-card"><strong>${formatNumber(displayTotals?.fulfillableQuantity || 0)}</strong><span>可售</span></div>
      <div class="fba-summary-card"><strong>${formatInventoryNumber(fbaReplenishmentOpen ? displayTotals?.inboundQuantity : (totals?.inboundQuantity ?? inboundTotal))}</strong><span>在路上</span></div>
      <div class="fba-summary-card"><strong>${formatNumber(displayTotals?.salesUnits || 0)}</strong><span>${escapeHtml(range?.dayCount || 0)} 天售卖数量</span></div>
      <div class="fba-summary-card"><strong>${formatNumber(sales?.orderCount || 0)}</strong><span>订单数</span></div>
      <div class="fba-summary-card compact-card"><strong>${escapeHtml(config?.marketplaceId || "-")}</strong><span>Marketplace</span></div>
      ${warnings?.length ? `<div class="fba-warning">${escapeHtml(warnings[0])}${warnings.length > 1 ? `，另有 ${warnings.length - 1} 条提示` : ""}</div>` : ""}
    `;
  }
  if (!visible.length) {
    list.innerHTML = `<tr><td colspan="${visibleColumns.length}"><div class="empty">暂无 FBA 库存数据。点击“后台刷新数据”提交同步任务，完成后再查询。</div></td></tr>`;
    $("#fbaTotals").innerHTML = "";
    return;
  }
  list.innerHTML = visible.map(product => `
    <tr>
      ${visibleColumns.map((column, index) => {
        const attrs = cellAttrs(column, index);
        return `<td class="${attrs.className} ${column.key === "title" ? "fba-name" : ""}"${attrs.style}>${column.render(product)}</td>`;
      }).join("")}
    </tr>
  `).join("");
  const totals = visible.reduce((acc, row) => {
    const rowTotalGoods = getProductTotalGoods(row);
    if (rowTotalGoods === null || rowTotalGoods === undefined) acc.hasIncompleteTotalGoods = true;
    else acc.totalGoodsQuantity += rowTotalGoods;
    const rowFactoryQuantity = getProductFactoryQuantity(row);
    if (rowFactoryQuantity === null || rowFactoryQuantity === undefined) acc.hasIncompleteFactory = true;
    else if (row.asin && !acc.factoryAsins.has(row.asin)) {
      acc.factoryAsins.add(row.asin);
      acc.factoryQuantity += rowFactoryQuantity || 0;
    }
    const rowInboundQuantity = getProductInboundQuantity(row);
    if (rowInboundQuantity === null || rowInboundQuantity === undefined) acc.hasIncompleteInbound = true;
    else acc.inboundQuantity += rowInboundQuantity || 0;
    acc.fulfillableQuantity += getProductInventoryField(row, "fulfillableQuantity") || 0;
    const rowInboundWorking = getProductInventoryField(row, "inboundWorkingQuantity");
    if (rowInboundWorking === null || rowInboundWorking === undefined) acc.hasIncompleteInboundWorking = true;
    else acc.inboundWorkingQuantity += rowInboundWorking || 0;
    const rowInboundShipped = getProductInventoryField(row, "inboundShippedQuantity");
    if (rowInboundShipped === null || rowInboundShipped === undefined) acc.hasIncompleteInboundShipped = true;
    else acc.inboundShippedQuantity += rowInboundShipped || 0;
    const rowInboundReceiving = getProductInventoryField(row, "inboundReceivingQuantity");
    if (rowInboundReceiving === null || rowInboundReceiving === undefined) acc.hasIncompleteInboundReceiving = true;
    else acc.inboundReceivingQuantity += rowInboundReceiving || 0;
    const rowReserved = getProductInventoryField(row, "reservedQuantity");
    if (rowReserved === null || rowReserved === undefined) acc.hasIncompleteReserved = true;
    else acc.reservedQuantity += rowReserved || 0;
    acc.unfulfillableQuantity += getProductInventoryField(row, "unfulfillableQuantity") || 0;
    acc.salesOrders += row.salesOrders || 0;
    acc.salesUnits += row.salesUnits || 0;
    acc.stockoutDays += row.stockoutDays || 0;
    const replenishmentPlan = calculateFbaReplenishmentPlan(row);
    acc.replenishmentShippingBoxes += replenishmentPlan.shippingBoxes || 0;
    acc.replenishmentShippingQuantity += replenishmentPlan.shippingQuantity || 0;
    acc.replenishmentBoxes += replenishmentPlan.replenishmentBoxes || 0;
    acc.replenishmentQuantity += replenishmentPlan.replenishmentQuantity || 0;
    return acc;
  }, {
    totalGoodsQuantity: 0,
    factoryQuantity: 0,
    inboundQuantity: 0,
    fulfillableQuantity: 0,
    inboundWorkingQuantity: 0,
    inboundShippedQuantity: 0,
    inboundReceivingQuantity: 0,
    reservedQuantity: 0,
    unfulfillableQuantity: 0,
    salesOrders: 0,
    salesUnits: 0,
    stockoutDays: 0,
    replenishmentShippingBoxes: 0,
    replenishmentShippingQuantity: 0,
    replenishmentBoxes: 0,
    replenishmentQuantity: 0,
    factoryAsins: new Set(),
    hasIncompleteTotalGoods: false,
    hasIncompleteFactory: false,
    hasIncompleteInbound: false,
    hasIncompleteInboundWorking: false,
    hasIncompleteInboundShipped: false,
    hasIncompleteInboundReceiving: false,
    hasIncompleteReserved: false
  });
  totals.factoryFbaTotalQuantity = totals.hasIncompleteTotalGoods
    ? null
    : (totals.hasIncompleteFactory ? totals.totalGoodsQuantity : totals.totalGoodsQuantity + totals.factoryQuantity);
  $("#fbaTotals").innerHTML = `
    <tr>
      ${visibleColumns.map((column, index) => {
        const attrs = cellAttrs(column, index);
        const open = `<td class="${attrs.className}"${attrs.style}>`;
        if (index === 0) return `${open}汇总</td>`;
        if (column.key === "factoryFbaTotalQuantity") return `${open}${totals.factoryFbaTotalQuantity === null ? "/" : formatNumber(totals.factoryFbaTotalQuantity)}</td>`;
        if (column.key === "factoryQuantity") return `${open}${totals.hasIncompleteFactory ? "/" : formatNumber(totals.factoryQuantity)}</td>`;
        if (column.key === "totalGoodsQuantity") return `${open}${totals.hasIncompleteTotalGoods ? "/" : formatNumber(totals.totalGoodsQuantity)}</td>`;
        if (column.key === "fulfillableQuantity") return `${open}${formatNumber(totals.fulfillableQuantity)}</td>`;
        if (column.key === "inboundQuantity") return `${open}${totals.hasIncompleteInbound ? "/" : formatNumber(totals.inboundQuantity)}</td>`;
        if (column.key === "inboundWorkingQuantity") return `${open}${totals.hasIncompleteInboundWorking ? "/" : formatNumber(totals.inboundWorkingQuantity)}</td>`;
        if (column.key === "inboundShippedQuantity") return `${open}${totals.hasIncompleteInboundShipped ? "/" : formatNumber(totals.inboundShippedQuantity)}</td>`;
        if (column.key === "inboundReceivingQuantity") return `${open}${totals.hasIncompleteInboundReceiving ? "/" : formatNumber(totals.inboundReceivingQuantity)}</td>`;
        if (column.key === "reservedQuantity") return `${open}${totals.hasIncompleteReserved ? "/" : formatNumber(totals.reservedQuantity)}</td>`;
        if (column.key === "unfulfillableQuantity") return `${open}${formatNumber(totals.unfulfillableQuantity)}</td>`;
        if (column.key === "salesOrders") return `${open}${formatNumber(totals.salesOrders)}</td>`;
        if (column.key === "salesUnits") return `${open}${formatNumber(totals.salesUnits)}</td>`;
        if (column.key === "stockoutDays") return `${open}${formatNumber(totals.stockoutDays)}</td>`;
        if (column.key === "replenishmentShippingQty") return `${open}<span class="fba-plan-total">${formatNumber(totals.replenishmentShippingBoxes)}箱 / ${formatNumber(totals.replenishmentShippingQuantity)}件</span></td>`;
        if (column.key === "replenishmentReplenishQty") return `${open}<span class="fba-plan-total">${formatNumber(totals.replenishmentBoxes)}箱 / ${formatNumber(totals.replenishmentQuantity)}件</span></td>`;
        return `${open}</td>`;
      }).join("")}
    </tr>
  `;
  renderDashboard();
}

function factoryProductMatches(product) {
  const keyword = ($("#factorySearch")?.value || "").trim().toLowerCase();
  const stockFilter = $("#factoryStockFilter")?.value || "";
  if (stockFilter && product.stockLevel !== stockFilter) return false;
  if (!keyword) return true;
  return [
    product.name,
    product.parentAsin,
    product.asin,
    product.boxSpec,
    product.note
  ].join(" ").toLowerCase().includes(keyword);
}

function getFactoryProductGroupKey(product) {
  return product?.parentAsin || product?.asin || product?.id || "";
}

function sortFactoryProductsForMatrix(items) {
  const orderedProducts = [...factoryProducts].sort((a, b) =>
    Number(a.order || 0) - Number(b.order || 0) || String(a.name || "").localeCompare(String(b.name || ""), "zh-Hans-CN")
  );
  const groupOrder = new Map();
  for (const product of orderedProducts) {
    const key = getFactoryProductGroupKey(product);
    if (key && !groupOrder.has(key)) groupOrder.set(key, groupOrder.size);
  }
  return [...items].sort((a, b) => {
    const groupCompare = Number(groupOrder.get(getFactoryProductGroupKey(a)) ?? 999999) - Number(groupOrder.get(getFactoryProductGroupKey(b)) ?? 999999);
    if (groupCompare) return groupCompare;
    return Number(a.order || 0) - Number(b.order || 0) || String(a.name || "").localeCompare(String(b.name || ""), "zh-Hans-CN");
  });
}

function getFactoryMovementTemplateKind(operation) {
  const text = String(operation || "");
  if (/发货|出库|发出/i.test(text)) return "shipping";
  if (/补货|入库|进货/i.test(text)) return "replenishment";
  return "";
}

function factoryMovementTemplateButtons(row) {
  const kind = getFactoryMovementTemplateKind(row.operation);
  if (!kind) return "";
  const baseAttrs = `data-template-operation="${escapeHtml(row.operation)}" data-template-date="${escapeHtml(row.date || "")}"`;
  if (kind === "shipping") {
    return `
      <span class="factory-row-template-tools" aria-label="下载发货模板">
        <button type="button" class="factory-row-shipping-button" data-download-movement-template="shipping" ${baseAttrs}>下载工厂发货模版</button>
        <button type="button" class="factory-row-shipping-button" data-download-movement-template="backend" ${baseAttrs}>下载后台发货模版</button>
        <button type="button" class="factory-row-documents-button" data-open-factory-documents>回填货件资料</button>
      </span>
    `;
  }
  return `
    <span class="factory-row-template-tools" aria-label="下载补货模板">
      <button type="button" class="factory-row-replenishment-button" data-download-movement-template="replenishment" ${baseAttrs}>下载工厂补货模版</button>
    </span>
  `;
}

function downloadFactoryMovementTemplate(button) {
  const kind = button?.dataset?.downloadMovementTemplate || "";
  const operation = button?.dataset?.templateOperation || "";
  const date = button?.dataset?.templateDate || "";
  if (!kind || !operation || !date) return;
  const params = new URLSearchParams({ kind, operation, date });
  window.location.href = `/api/factory-inventory/movement-template.xlsx?${params.toString()}`;
}

function renderFactoryInventory() {
  const matrixBody = $("#factoryMatrixBody");
  if (!matrixBody) return;
  const visibleProducts = sortFactoryProductsForMatrix(factoryProducts.filter(factoryProductMatches));
  const today = new Date().toISOString().slice(0, 10);
  const summary = $("#factorySummary");
  if (summary) {
    summary.innerHTML = `
      <div class="fba-summary-card"><strong>${formatNumber(factoryTotals.productCount || 0)}</strong><span>商品数</span></div>
      <div class="fba-summary-card"><strong>${formatNumber(factoryTotals.currentQuantity || 0)}</strong><span>工厂库存</span></div>
      <div class="fba-summary-card"><strong>¥${formatNumber(factoryTotals.inventoryValue || 0, 2)}</strong><span>库存货值</span></div>
      <div class="fba-summary-card"><strong>${formatNumber(factoryTotals.lowStockCount || 0)}</strong><span>低库存</span></div>
      <div class="fba-summary-card"><strong>${formatNumber(factoryTotals.outOfStockCount || 0)}</strong><span>缺货</span></div>
    `;
  }
  if (!visibleProducts.length) {
    matrixBody.innerHTML = `<tr><td><div class="empty">暂无匹配的工厂库存商品。</div></td></tr>`;
    return;
  }

  const visibleIds = new Set(visibleProducts.map(product => product.id));
  const groupedMovements = new Map();
  for (const movement of factoryMovements) {
    if (!visibleIds.has(movement.productId)) continue;
    const operation = movement.note || movement.typeLabel || movement.type || "库存变动";
    const key = `${movement.date || ""}\n${operation}`;
    const row = groupedMovements.get(key) || {
      date: movement.date || "",
      operation,
      createdAt: movement.createdAt || "",
      quantities: new Map()
    };
    row.quantities.set(movement.productId, Number(row.quantities.get(movement.productId) || 0) + Number(movement.quantity || 0));
    if (String(movement.createdAt || "") > String(row.createdAt || "")) row.createdAt = movement.createdAt || "";
    groupedMovements.set(key, row);
  }
  const movementRows = [...groupedMovements.values()]
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(a.operation).localeCompare(String(b.operation), "zh-Hans-CN"));

  const groupIndexByKey = new Map();
  for (const product of visibleProducts) {
    const key = getFactoryProductGroupKey(product);
    if (!groupIndexByKey.has(key)) groupIndexByKey.set(key, groupIndexByKey.size);
  }
  const productGroupClass = product => Number(groupIndexByKey.get(getFactoryProductGroupKey(product)) || 0) % 2 === 0
    ? "factory-group-even"
    : "factory-group-odd";
  const productCells = (renderer, className = "", draggable = false) => visibleProducts.map((product, index) => `
    <td class="factory-product-cell ${productGroupClass(product)} ${className} ${draggable ? "factory-draggable" : ""}" data-product-id="${escapeHtml(product.id)}" ${draggable ? "draggable=\"true\" title=\"拖动调整列顺序\"" : ""}>${renderer(product, index)}</td>
  `).join("");
  const parentGroupCells = () => {
    const cells = [];
    for (let index = 0; index < visibleProducts.length;) {
      const product = visibleProducts[index];
      const key = getFactoryProductGroupKey(product);
      const parentInternalName = String(product.parentInternalName || "").trim();
      const parentCategoryId = String(product.parentCategoryId || "").trim();
      const availableCategories = [...(product.parentCategoryOptions || [])];
      if (parentCategoryId && !availableCategories.some(item => String(item.id) === parentCategoryId)) {
        availableCategories.push({ id: parentCategoryId, name: product.parentCategoryName || parentCategoryId });
      }
      let span = 1;
      while (index + span < visibleProducts.length) {
        const next = visibleProducts[index + span];
        if (getFactoryProductGroupKey(next) !== key) break;
        span += 1;
      }
      cells.push(`
        <td class="factory-product-cell ${productGroupClass(product)} factory-parent-cell factory-parent-draggable" colspan="${span}" draggable="true" data-parent-key="${escapeHtml(key)}" title="拖动调整父ASIN组顺序">
          <span class="factory-parent-label">
            ${product.parentAsin ? `<a href="https://www.amazon.com/dp/${escapeHtml(product.parentAsin)}" target="_blank" rel="noopener noreferrer">${escapeHtml(product.parentAsin)}</a>` : `<span>${escapeHtml(key || "-")}</span>`}
            <span class="factory-parent-divider">|</span>
            <input class="factory-parent-name-input" data-factory-parent-name data-parent-key="${escapeHtml(key)}" type="text" value="${escapeHtml(parentInternalName)}" placeholder="内部名">
            <span class="factory-parent-divider">|</span>
            <select class="factory-parent-category-select" data-factory-parent-category data-parent-key="${escapeHtml(key)}" title="选择父 ASIN 类目">
              <option value="">清除父 ASIN 类目</option>
              ${availableCategories.map(category => `<option value="${escapeHtml(category.id)}" data-category-name="${escapeHtml(category.name || "")}" ${String(category.id) === parentCategoryId ? "selected" : ""}>${escapeHtml(category.name || "未命名类目")} (${escapeHtml(category.id)})</option>`).join("")}
            </select>
          </span>
        </td>
      `);
      index += span;
    }
    return cells.join("");
  };
  const editableInput = (product, field, value, type = "text") => {
    const isBoxSpec = field === "boxSpec";
    const boxHint = "示例：50*37*40 cm3 / 36个";
    return `
      <input class="factory-edit-input" data-factory-field="${escapeHtml(field)}" data-product-id="${escapeHtml(product.id)}" type="${type}" value="${escapeHtml(value ?? "")}" ${isBoxSpec ? `placeholder="${boxHint}" title="请按格式填写：${boxHint}"` : ""}>
    `;
  };

  matrixBody.innerHTML = `
    <tr class="factory-meta-row factory-parent-row">
      <td class="factory-sticky-col factory-left-1"></td>
      <td class="factory-sticky-col factory-left-2">父ASIN</td>
      ${parentGroupCells()}
    </tr>
    <tr class="factory-meta-row factory-image-row">
      <td class="factory-sticky-col factory-left-1"></td>
      <td class="factory-sticky-col factory-left-2"></td>
      ${productCells(product => `
        <div class="factory-image-cell-inner">
          <button type="button" class="factory-product-delete" data-delete-product-id="${escapeHtml(product.id)}" title="删除这个 ASIN">×</button>
          ${product.imageUrl ? `<img class="factory-product-image" src="${escapeHtml(product.imageUrl)}" alt="${escapeHtml(product.name || product.asin)}">` : `<div class="factory-image-placeholder">无图</div>`}
        </div>
      `, "factory-image-cell", true)}
    </tr>
    <tr class="factory-meta-row factory-title-row">
      <td class="factory-sticky-col factory-left-1"></td>
      <td class="factory-sticky-col factory-left-2">内部名</td>
      ${productCells(product => editableInput(product, "name", product.name), "factory-title-cell", true)}
    </tr>
    <tr class="factory-meta-row factory-asin-row">
      <td class="factory-sticky-col factory-left-1"></td>
      <td class="factory-sticky-col factory-left-2">ASIN</td>
      ${productCells(product => editableInput(product, "asin", product.asin))}
    </tr>
    <tr class="factory-meta-row factory-cost-row">
      <td class="factory-sticky-col factory-left-1">单个成本</td>
      <td class="factory-sticky-col factory-left-2">CNY</td>
      ${productCells(product => editableInput(product, "unitCost", product.unitCost, "number"))}
    </tr>
    <tr class="factory-meta-row factory-box-row">
      <td class="factory-sticky-col factory-left-1"></td>
      <td class="factory-sticky-col factory-left-2">箱子规格</td>
      ${productCells(product => editableInput(product, "boxSpec", product.boxSpec))}
    </tr>
    <tr class="factory-meta-row factory-stock-row">
      <td class="factory-sticky-col factory-left-1">剩余库存</td>
      <td class="factory-sticky-col factory-left-2">${formatNumber(visibleProducts.reduce((sum, product) => sum + Number(product.currentQuantity || 0), 0))}</td>
      ${productCells(product => `<strong>${formatNumber(product.currentQuantity || 0)}</strong>`)}
    </tr>
    <tr class="factory-meta-row factory-value-row">
      <td class="factory-sticky-col factory-left-1">货值</td>
      <td class="factory-sticky-col factory-left-2">¥${formatNumber(visibleProducts.reduce((sum, product) => sum + Number(product.inventoryValue || 0), 0), 2)}</td>
      ${productCells(product => product.inventoryValue === "" ? "-" : `<strong>${formatNumber(product.inventoryValue, 2)}</strong>`)}
    </tr>
    <tr class="factory-draft-row">
      <td class="factory-sticky-col factory-left-1 factory-draft-action-cell">
        <button type="button" class="factory-row-add" data-add-factory-row title="添加这一行">+</button>
        <input class="factory-draft-operation" data-draft-operation value="操作" aria-label="操作">
      </td>
      <td class="factory-sticky-col factory-left-2">
        <input class="factory-draft-date" data-draft-date type="date" value="${escapeHtml(today)}">
      </td>
      ${visibleProducts.map(product => `
        <td class="factory-product-cell ${productGroupClass(product)} factory-draft-qty-cell">
          <input class="factory-draft-qty" data-draft-product-id="${escapeHtml(product.id)}" type="number" step="1" placeholder="">
        </td>
      `).join("")}
    </tr>
    ${movementRows.map(row => `
      <tr class="factory-ledger-row">
        <td class="factory-sticky-col factory-left-1 factory-row-action-cell">
          <button type="button" class="factory-row-delete" data-delete-row-operation="${escapeHtml(row.operation)}" data-delete-row-date="${escapeHtml(row.date || "")}" title="删除这一行">-</button>
          <span>${escapeHtml(row.operation)}</span>
        </td>
        <td class="factory-sticky-col factory-left-2 factory-row-date-cell">
          ${escapeHtml(row.date || "-")}
          ${factoryMovementTemplateButtons(row)}
        </td>
        ${visibleProducts.map((product, index) => {
          const value = Number(row.quantities.get(product.id) || 0);
          return `<td class="factory-product-cell ${productGroupClass(product)} factory-col-${index % 5} ${value < 0 ? "quantity-negative" : value > 0 ? "quantity-positive" : ""}">${value ? `${value > 0 ? "+" : ""}${formatNumber(value)}` : ""}</td>`;
        }).join("")}
      </tr>
    `).join("")}
  `;
}

async function saveFactoryParentInternalName(input) {
  const parentKey = input?.dataset?.parentKey || "";
  if (!parentKey) return;
  const currentProduct = factoryProducts.find(product => getFactoryProductGroupKey(product) === parentKey);
  const current = String(currentProduct?.parentInternalName || "");
  const nextValue = String(input.value || "").trim();
  if (nextValue === current) return;
  input.disabled = true;
  try {
    const data = await api(`/api/factory-inventory/parent-groups/${encodeURIComponent(parentKey)}`, {
      method: "PUT",
      body: { parentInternalName: nextValue }
    });
    factoryProducts = data.products || [];
    factoryMovements = data.movements || [];
    factoryTotals = data.totals || {};
    factoryCategoryOptions = data.categoryOptions || factoryCategoryOptions;
    renderFactoryInventory();
    $("#sandboxStatus").textContent = "父ASIN内部名已保存";
  } catch (error) {
    alert(error.message);
    input.disabled = false;
  }
}

async function saveFactoryParentCategory(select) {
  const parentKey = select?.dataset?.parentKey || "";
  if (!parentKey) return;
  const categoryId = String(select.value || "").trim();
  const categoryName = categoryId ? String(select.selectedOptions?.[0]?.dataset?.categoryName || "").trim() : "";
  select.disabled = true;
  try {
    const data = await api(`/api/factory-inventory/parent-groups/${encodeURIComponent(parentKey)}`, {
      method: "PUT",
      body: { categoryId, categoryName }
    });
    factoryProducts = data.products || [];
    factoryMovements = data.movements || [];
    factoryTotals = data.totals || {};
    factoryCategoryOptions = data.categoryOptions || factoryCategoryOptions;
    renderFactoryInventory();
    $("#sandboxStatus").textContent = categoryId ? `父 ASIN 类目已保存：${categoryName}` : "父 ASIN 类目已清除";
  } catch (error) {
    alert(error.message);
    select.disabled = false;
  }
}

async function saveFactoryProductField(input) {
  const productId = input?.dataset?.productId;
  const field = input?.dataset?.factoryField;
  if (!productId || !field) return;
  const product = factoryProducts.find(item => item.id === productId);
  if (!product) return;
  const current = String(product[field] ?? "");
  const nextValue = field === "unitCost" && input.value !== "" ? Number(input.value || 0) : input.value.trim();
  if (String(nextValue) === current) return;
  input.disabled = true;
  try {
    const data = await api(`/api/factory-inventory/products/${encodeURIComponent(productId)}`, {
      method: "PUT",
      body: { [field]: nextValue }
    });
    factoryProducts = data.products || [];
    factoryMovements = data.movements || [];
    factoryTotals = data.totals || {};
    if (field === "name") {
      factoryProducts = factoryProducts.map(item => item.id === productId ? { ...item, name: String(nextValue || "") } : item);
      const updated = factoryProducts.find(item => item.id === productId);
      const updatedAsin = String(updated?.asin || product.asin || "").trim().toUpperCase();
      products = products.map(item => {
        const itemFactoryId = getFbaProductFactoryProductId(item);
        const itemAsin = String(item.asin || "").trim().toUpperCase();
        if (itemFactoryId !== productId && (!updatedAsin || itemAsin !== updatedAsin)) return item;
        return { ...item, factoryProductId: productId, factoryName: updated?.name || String(nextValue || "") };
      });
    }
    renderFactoryInventory();
    renderDashboard();
    $("#sandboxStatus").textContent = "工厂库存商品信息已保存";
  } catch (error) {
    alert(error.message);
    input.disabled = false;
  }
}

function findFbaProductByPlanKey(key) {
  return products.find(product => getFbaReplenishmentKey(product) === key);
}

async function saveFbaPlanField(input) {
  const key = input?.dataset?.fbaPlanKey || "";
  const field = input?.dataset?.fbaPlanField || "";
  const product = findFbaProductByPlanKey(key);
  if (!product || !field) return;
  if (field === "grade") {
    updateFbaReplenishmentOverride(product, { grade: input.value });
    await saveFbaGradesToServer({ [getFbaGradeAsin(product)]: input.value });
    renderProducts();
    return;
  }
  const value = Number(input.value || 0);
  if (!Number.isFinite(value) || value < 0) return;
  if (field === "boxQuantity") {
    updateFbaReplenishmentOverride(product, { boxQuantity: value || 1 });
    const factoryProductId = product.factoryProductId || getFactoryProductForFbaProduct(product)?.id || "";
    if (factoryProductId) {
      const data = await api(`/api/factory-inventory/products/${encodeURIComponent(factoryProductId)}`, {
        method: "PUT",
        body: { boxSpec: String(value || 1) }
      });
      factoryProducts = data.products || factoryProducts;
      factoryMovements = data.movements || factoryMovements;
      factoryTotals = data.totals || factoryTotals;
      product.factoryProductId = factoryProductId;
      product.factoryBoxSpec = String(value || 1);
    }
    renderProducts();
    return;
  }
  if (field === "shippingBoxes") {
    updateFbaReplenishmentOverride(product, { shippingBoxes: value, shippingQuantity: undefined });
    renderProducts();
    return;
  }
  if (field === "replenishmentBoxes") {
    updateFbaReplenishmentOverride(product, { replenishmentBoxes: value, replenishmentQuantity: undefined });
    renderProducts();
    return;
  }
  if (field === "shippingQuantity") {
    updateFbaReplenishmentOverride(product, { shippingQuantity: value, shippingBoxes: undefined });
    renderProducts();
    return;
  }
  if (field === "replenishmentQuantity") {
    updateFbaReplenishmentOverride(product, { replenishmentQuantity: value, replenishmentBoxes: undefined });
    renderProducts();
    return;
  }
  updateFbaReplenishmentOverride(product, { [field]: value });
  renderProducts();
}

async function insertFbaPlanToFactory(type) {
  if (!fbaReplenishmentOpen) return;
  if (!factoryLoaded) {
    await loadFactoryInventory();
  }
  const quantities = {};
  let rowCount = 0;
  let totalQuantity = 0;
  for (const product of collapseFbaRowsByAsin(products.filter(productMatches))) {
    const plan = calculateFbaReplenishmentPlan(product);
    const quantity = type === "shipping" ? plan.shippingQuantity : plan.replenishmentQuantity;
    const factoryProductId = product.factoryProductId || getFactoryProductForFbaProduct(product)?.id || "";
    if (!quantity || quantity <= 0 || !factoryProductId) continue;
    quantities[factoryProductId] = type === "shipping" ? -Math.abs(quantity) : Math.abs(quantity);
    rowCount += 1;
    totalQuantity += Number(quantity || 0);
  }
  if (!rowCount) {
    alert("当前筛选结果没有可插入的发补货数量，或对应 ASIN 还没有工厂库存商品。");
    return;
  }
  const today = marketplaceToday();
  const operation = type === "shipping" ? "FBA发货计划" : "FBA补货计划";
  const data = await api("/api/factory-inventory/movement-rows", {
    method: "POST",
    body: { operation, date: today, quantities }
  });
  factoryProducts = data.products || [];
  factoryMovements = data.movements || [];
  factoryTotals = data.totals || {};
  factoryLoaded = true;
  alert(`已加入工厂库存：${operation}，共 ${rowCount} 个 ASIN，${formatNumber(totalQuantity)} 件。请到工厂库存页面继续下载模版、回填货件资料等后续操作。`);
}

let factoryDraggedProductId = "";
let factoryDraggedParentKey = "";
let factoryDragMode = "";

async function saveFactoryProductOrder() {
  try {
    const data = await api("/api/factory-inventory/products/reorder", {
      method: "POST",
      body: { productIds: factoryProducts.map(product => product.id) }
    });
    factoryProducts = data.products || [];
    factoryMovements = data.movements || [];
    factoryTotals = data.totals || {};
    renderFactoryInventory();
    $("#sandboxStatus").textContent = "工厂库存列顺序已保存";
  } catch (error) {
    alert(error.message);
    await loadFactoryInventory().catch(() => {});
  }
}

function moveFactoryProductColumn(targetProductId) {
  if (!factoryDraggedProductId || !targetProductId || factoryDraggedProductId === targetProductId) return;
  const orderedProducts = sortFactoryProductsForMatrix(factoryProducts);
  const fromIndex = orderedProducts.findIndex(product => product.id === factoryDraggedProductId);
  const toIndex = orderedProducts.findIndex(product => product.id === targetProductId);
  if (fromIndex === -1 || toIndex === -1) return;
  if (getFactoryProductGroupKey(orderedProducts[fromIndex]) !== getFactoryProductGroupKey(orderedProducts[toIndex])) return;
  const next = [...orderedProducts];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  factoryProducts = next.map((product, index) => ({ ...product, order: index + 1 }));
  renderFactoryInventory();
  saveFactoryProductOrder();
}

function moveFactoryParentGroup(targetParentKey) {
  if (!factoryDraggedParentKey || !targetParentKey || factoryDraggedParentKey === targetParentKey) return;
  const orderedProducts = sortFactoryProductsForMatrix(factoryProducts);
  const draggedGroup = orderedProducts.filter(product => getFactoryProductGroupKey(product) === factoryDraggedParentKey);
  if (!draggedGroup.length) return;
  const remaining = orderedProducts.filter(product => getFactoryProductGroupKey(product) !== factoryDraggedParentKey);
  const targetIndex = remaining.findIndex(product => getFactoryProductGroupKey(product) === targetParentKey);
  if (targetIndex === -1) return;
  const next = [...remaining];
  next.splice(targetIndex, 0, ...draggedGroup);
  factoryProducts = next.map((product, index) => ({ ...product, order: index + 1 }));
  renderFactoryInventory();
  saveFactoryProductOrder();
}

async function loadFactoryInventory() {
  const data = await api("/api/factory-inventory");
  factoryProducts = data.products || [];
  factoryMovements = data.movements || [];
  factoryTotals = data.totals || {};
  factoryCategoryOptions = data.categoryOptions || [];
  factoryLoaded = true;
  renderFactoryInventory();
  renderDashboard();
  return data;
}

function applyFactoryInventoryData(data) {
  factoryProducts = data.products || [];
  factoryMovements = data.movements || [];
  factoryTotals = data.totals || {};
  factoryCategoryOptions = data.categoryOptions || factoryCategoryOptions;
  factoryLoaded = true;
  renderFactoryInventory();
  renderDashboard();
}

async function addFactoryAsin() {
  const asin = prompt("请输入要增加到工厂库存的 ASIN");
  const normalizedAsin = String(asin || "").trim().toUpperCase();
  if (!normalizedAsin) return;
  const data = await api("/api/factory-inventory/products", {
    method: "POST",
    body: { asin: normalizedAsin }
  });
  applyFactoryInventoryData(data);
  $("#sandboxStatus").textContent = `已增加 ASIN ${normalizedAsin}`;
}

async function deleteFactoryProduct(productId) {
  const product = factoryProducts.find(item => item.id === productId);
  if (!product) return;
  const label = product.asin || product.name || "这个 ASIN";
  if (!confirm(`确定删除 ${label} 吗？这个 ASIN 的工厂库存流水也会一起删除。`)) return;
  const data = await api(`/api/factory-inventory/products/${encodeURIComponent(productId)}`, {
    method: "DELETE"
  });
  applyFactoryInventoryData(data);
  $("#sandboxStatus").textContent = `已删除 ${label}`;
}

async function addFactoryDraftRow() {
  const operationInput = $("[data-draft-operation]");
  const dateInput = $("[data-draft-date]");
  const operation = String(operationInput?.value || "").trim();
  const date = String(dateInput?.value || "").trim();
  const quantities = {};
  document.querySelectorAll("[data-draft-product-id]").forEach(input => {
    const value = Number(input.value || 0);
    if (value) quantities[input.dataset.draftProductId] = value;
  });
  if (!operation) {
    alert("请先填写操作，例如：补货、发货、进货 001。");
    operationInput?.focus();
    return;
  }
  if (!date) {
    alert("请先选择日期。");
    dateInput?.focus();
    return;
  }
  if (!Object.keys(quantities).length) {
    alert("请至少填写一个 ASIN 的数量。补货填正数，发货填负数。");
    return;
  }
  const data = await api("/api/factory-inventory/movement-rows", {
    method: "POST",
    body: { operation, date, quantities }
  });
  applyFactoryInventoryData(data);
  $("#sandboxStatus").textContent = `已添加 ${date} ${operation}`;
}

async function deleteFactoryMovementRow(operation, date) {
  const label = `${date || "-"} ${operation || "库存变动"}`;
  if (!confirm(`确定删除 ${label} 这一行吗？库存数量会自动回退。`)) return;
  const data = await api("/api/factory-inventory/movement-rows", {
    method: "DELETE",
    body: { operation, date }
  });
  applyFactoryInventoryData(data);
  $("#sandboxStatus").textContent = `已删除 ${label}`;
}

async function openFactoryMovementModal() {
  if (!factoryLoaded) {
    try {
      await loadFactoryInventory();
    } catch (error) {
      alert(`工厂库存读取失败：${error.message}`);
      return;
    }
  }
  if (!factoryProducts.length) {
    alert("暂无工厂库存商品。请先同步 FBA 库存商品，或确认 CSV 数据已经导入。");
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  const options = factoryProducts
    .map(product => `<option value="${escapeHtml(product.id)}">${escapeHtml(product.name)}${product.asin ? ` / ${escapeHtml(product.asin)}` : ""}</option>`)
    .join("");
  const modal = createModal("补货 / 发货", `
    <div class="modal-body">
      <label>
        商品
        <select id="factoryMovementProduct">${options}</select>
      </label>
      <label>
        类型
        <select id="factoryMovementType">
          <option value="inbound">补货入库</option>
          <option value="outbound">发货出库</option>
          <option value="adjustment">库存调整</option>
        </select>
      </label>
      <label>
        日期
        <input id="factoryMovementDate" type="date" value="${today}">
      </label>
      <label>
        数量
        <input id="factoryMovementQuantity" type="number" step="1" placeholder="正数；调整可填负数">
      </label>
      <label>
        备注
        <textarea id="factoryMovementNote" placeholder="例如：发往 FBA、工厂补货、盘点校准"></textarea>
      </label>
      <div class="fba-modal-actions">
        <button type="button" class="secondary-button" data-close-modal>取消</button>
        <button type="button" id="factoryMovementSaveBtn">保存</button>
      </div>
    </div>
  `);
  modal.querySelector("#factoryMovementSaveBtn").addEventListener("click", async () => {
    const button = modal.querySelector("#factoryMovementSaveBtn");
    setBusy(button, true, "保存");
    try {
      const data = await api("/api/factory-inventory/movements", {
        method: "POST",
        body: {
          productId: modal.querySelector("#factoryMovementProduct").value,
          type: modal.querySelector("#factoryMovementType").value,
          date: modal.querySelector("#factoryMovementDate").value,
          quantity: Number(modal.querySelector("#factoryMovementQuantity").value || 0),
          note: modal.querySelector("#factoryMovementNote").value
        }
      });
      factoryProducts = data.products || [];
      factoryMovements = data.movements || [];
      factoryTotals = data.totals || {};
      renderFactoryInventory();
      $("#sandboxStatus").textContent = "工厂库存已更新";
      closeModal(modal);
    } catch (error) {
      alert(error.message);
    } finally {
      setBusy(button, false, "保存");
    }
  });
}

async function openFactoryDocumentsModal() {
  if (!factoryLoaded) {
    await loadFactoryInventory();
  }
  const modal = createModal("回填货件资料", `
    <div class="modal-body factory-documents-modal">
      <p class="hint">后台创建发货计划后，上传以 FBA 开头的 CSV，生成贴标资料和发票资料。</p>
      <label>
        发票类型
        <select id="factoryInvoiceType">
          <option value="jinsheng">锦盛天成发票</option>
          <option value="xiyue">赤道/喜悦发票</option>
        </select>
      </label>
      <div id="factoryShipmentDropZone" class="factory-shipment-drop-zone" role="button" tabindex="0">
        <strong>拖拽 FBA 发货 CSV 到这里</strong>
        <span>或点击选择文件，支持多个 CSV</span>
        <small id="factoryShipmentFileNames">尚未选择文件</small>
        <input id="factoryShipmentFiles" type="file" accept=".csv,text/csv" multiple hidden>
      </div>
      <div class="fba-modal-actions">
        <button type="button" class="secondary-button" data-close-modal>取消</button>
        <button type="button" id="factoryGenerateDocumentsBtn">生成并下载</button>
      </div>
    </div>
  `);
  const fileInput = modal.querySelector("#factoryShipmentFiles");
  const dropZone = modal.querySelector("#factoryShipmentDropZone");
  const fileNames = modal.querySelector("#factoryShipmentFileNames");
  const updateFileNames = () => {
    const files = [...(fileInput.files || [])];
    fileNames.textContent = files.length ? files.map(file => file.name).join("、") : "尚未选择文件";
  };
  const setFiles = files => {
    const transfer = new DataTransfer();
    [...files].forEach(file => transfer.items.add(file));
    fileInput.files = transfer.files;
    updateFileNames();
  };
  dropZone.addEventListener("click", () => fileInput.click());
  dropZone.addEventListener("keydown", event => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    fileInput.click();
  });
  fileInput.addEventListener("change", updateFileNames);
  ["dragenter", "dragover"].forEach(type => {
    dropZone.addEventListener(type, event => {
      event.preventDefault();
      dropZone.classList.add("drag-over");
    });
  });
  ["dragleave", "drop"].forEach(type => {
    dropZone.addEventListener(type, event => {
      event.preventDefault();
      dropZone.classList.remove("drag-over");
    });
  });
  dropZone.addEventListener("drop", event => {
    const files = [...(event.dataTransfer?.files || [])].filter(file => /\.csv$/i.test(file.name));
    if (!files.length) {
      alert("请拖入 CSV 文件。");
      return;
    }
    setFiles(files);
  });
  modal.querySelector("#factoryGenerateDocumentsBtn").addEventListener("click", async () => {
    const button = modal.querySelector("#factoryGenerateDocumentsBtn");
    const files = [...(modal.querySelector("#factoryShipmentFiles")?.files || [])];
    if (!files.length) {
      alert("请先上传 FBA 发货 CSV。");
      return;
    }
    setBusy(button, true, "生成并下载");
    try {
      const result = await api("/api/factory-inventory/shipment-documents", {
        method: "POST",
        body: {
          templateType: modal.querySelector("#factoryInvoiceType").value,
          files: await Promise.all(files.map(async file => ({ name: file.name, content: await file.text() })))
        }
      });
      for (const file of result.files || []) {
        downloadBase64File(file.filename, file.base64, file.contentType);
      }
      closeModal(modal);
    } catch (error) {
      alert(error.message);
    } finally {
      setBusy(button, false, "生成并下载");
    }
  });
}

function shiftMonth(monthValue, amount) {
  const [year, month] = String(monthValue).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1 + amount, 1)).toISOString().slice(0, 7);
}

function shiftDateValue(dateValue, amount) {
  const [year, month, day] = String(dateValue).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + amount)).toISOString().slice(0, 10);
}

function marketplaceToday() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.filter(part => part.type !== "literal").map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function isValidDateValue(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || "");
}

function quickDateRange(type) {
  const today = marketplaceToday();
  if (type === "today") {
    return { startDate: today, endDate: today };
  }
  if (type === "yesterday") {
    const yesterday = shiftDateValue(today, -1);
    return { startDate: yesterday, endDate: yesterday };
  }
  if (type === "last7") {
    return { startDate: shiftDateValue(today, -6), endDate: today };
  }
  if (type === "last30") {
    return { startDate: shiftDateValue(today, -29), endDate: today };
  }
  if (type === "last30Exclude2") {
    const endDate = shiftDateValue(today, -2);
    return { startDate: shiftDateValue(endDate, -29), endDate };
  }
  return defaultDateRange();
}

function currentPickerDate(inputId) {
  const value = $(`#${inputId}`)?.value;
  return /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value : new Date().toISOString().slice(0, 10);
}

function updateDateRangeInput() {
  const startDate = $("#salesStartDate")?.value || "";
  const endDate = $("#salesEndDate")?.value || "";
  const input = $("#salesDateRange");
  if (!input) return;
  input.value = startDate && endDate ? `${startDate} 至 ${endDate}` : (startDate ? `${startDate} 至 ...` : "");
}

function getSelectedDateRange() {
  return {
    startDate: $("#salesStartDate")?.value || "",
    endDate: $("#salesEndDate")?.value || ""
  };
}

function isDateInSelectedRange(value) {
  const { startDate, endDate } = getSelectedDateRange();
  return isValidDateValue(startDate) && isValidDateValue(endDate) && value >= startDate && value <= endDate;
}

function isDateEndpoint(value) {
  const { startDate, endDate } = getSelectedDateRange();
  return value === startDate || value === endDate;
}

function isDateDisabled(value) {
  return value > marketplaceToday();
}

async function loadFbaDateStatus() {
  try {
    const data = await api("/api/fba/inventory/dates");
    fbaDateStatus.clear();
    for (const item of data.dates || []) {
      fbaDateStatus.set(item.date, item);
    }
  } catch {
    // Date markers are helpful but should not block inventory use.
  }
}

function renderDatePicker() {
  const picker = $("#fbaDatePicker");
  if (!picker || !dateRangePickerOpen) return;
  const { startDate, endDate } = getSelectedDateRange();
  const selectedDate = endDate || startDate || marketplaceToday();
  if (!datePickerMonth) datePickerMonth = selectedDate.slice(0, 7);
  const [year, month] = datePickerMonth.split("-").map(Number);
  const first = new Date(Date.UTC(year, month - 1, 1));
  const firstDay = first.getUTCDay();
  const start = new Date(Date.UTC(year, month - 1, 1 - firstDay));
  const days = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start.getTime() + index * 86400000);
    const value = date.toISOString().slice(0, 10);
    const inMonth = date.getUTCMonth() === month - 1;
    const dateStatus = fbaDateStatus.get(value);
    const hasCompleteData = Boolean(dateStatus?.complete);
    const hasPartialData = Boolean(dateStatus && !dateStatus.complete);
    const inRange = isDateInSelectedRange(value);
    const endpoint = isDateEndpoint(value);
    const disabled = isDateDisabled(value);
    const dataLabel = hasCompleteData
      ? `库存和销量都已成功：库存 ${dateStatus.inventoryCount || 0} 条，销量 ${dateStatus.salesCount || 0} 条`
      : hasPartialData
        ? `数据未完整：库存 ${dateStatus.inventoryCount || 0} 条，销量完成标记 ${dateStatus.salesMarkerCount || 0} 条，待确认标记 ${dateStatus.pendingSalesMarkerCount || 0} 条`
        : "";
    return `<button type="button" class="date-picker-day ${inMonth ? "" : "other-month"} ${hasCompleteData ? "has-data" : ""} ${hasPartialData ? "partial-data" : ""} ${inRange ? "in-range" : ""} ${endpoint ? "selected" : ""}" data-date="${value}" title="${escapeHtml(disabled ? "未来日期不可选" : dataLabel)}" ${disabled ? "disabled" : ""}><span>${date.getUTCDate()}</span></button>`;
  }).join("");
  picker.innerHTML = `
    <div class="date-picker-head">
      <button type="button" data-date-nav="-1">‹</button>
      <div class="date-picker-title">${year}-${String(month).padStart(2, "0")}</div>
      <button type="button" data-date-nav="1">›</button>
    </div>
    <div class="date-picker-week"><span>日</span><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span></div>
    <div class="date-picker-grid">${days}</div>
    <div class="date-picker-quick">
      <button type="button" data-date-quick="today">今天</button>
      <button type="button" data-date-quick="yesterday">昨天</button>
      <button type="button" data-date-quick="last7">最近7天</button>
      <button type="button" data-date-quick="last30">最近30天</button>
      <button type="button" data-date-quick="last30Exclude2">最近30天（不含近2天）</button>
    </div>
    <div class="date-picker-legend"><span class="date-data-dot"></span> 库存和销量都成功 <span class="date-range-swatch"></span> 已选范围</div>
  `;
}

async function openDatePicker() {
  const input = $("#salesDateRange");
  const picker = $("#fbaDatePicker");
  if (!input || !picker) return;
  dateRangePickerOpen = true;
  const { startDate, endDate } = getSelectedDateRange();
  datePickerMonth = (endDate || startDate || marketplaceToday()).slice(0, 7);
  await loadFbaDateStatus();
  const rect = input.getBoundingClientRect();
  picker.hidden = false;
  renderDatePicker();
  const pickerRect = picker.getBoundingClientRect();
  const margin = 8;
  const left = Math.min(
    Math.max(margin, rect.left),
    Math.max(margin, window.innerWidth - pickerRect.width - margin)
  );
  const belowTop = rect.bottom + 6;
  const aboveTop = rect.top - pickerRect.height - 6;
  const top = belowTop + pickerRect.height + margin <= window.innerHeight
    ? belowTop
    : Math.max(margin, aboveTop);
  picker.style.left = `${left}px`;
  picker.style.top = `${top}px`;
}

function closeDatePicker() {
  const picker = $("#fbaDatePicker");
  if (picker) picker.hidden = true;
  dateRangePickerOpen = false;
}

function updateAdsDateRangeInput() {
  const startDate = $("#adsStartDate")?.value || "";
  const endDate = $("#adsEndDate")?.value || "";
  const input = $("#adsDateRange");
  if (!input) return;
  input.value = startDate && endDate ? `${startDate} 至 ${endDate}` : (startDate ? `${startDate} 至 ...` : "");
}

function isAdsDateInSelectedRange(value) {
  const startDate = $("#adsStartDate")?.value || "";
  const endDate = $("#adsEndDate")?.value || "";
  return isValidDateValue(startDate) && isValidDateValue(endDate) && value >= startDate && value <= endDate;
}

async function loadAdsDateStatus() {
  try {
    const data = await api("/api/ads/dates");
    adsDateStatus.clear();
    for (const item of data.dates || []) adsDateStatus.set(item.date, item);
  } catch {
    // Date markers are helpful but should not block range selection.
  }
}

function renderAdsDatePicker() {
  const picker = $("#adsDatePicker");
  if (!picker || !adsDatePickerOpen) return;
  const startDate = $("#adsStartDate")?.value || "";
  const endDate = $("#adsEndDate")?.value || "";
  const selectedDate = endDate || startDate || marketplaceToday();
  if (!adsDatePickerMonth) adsDatePickerMonth = selectedDate.slice(0, 7);
  const [year, month] = adsDatePickerMonth.split("-").map(Number);
  const first = new Date(Date.UTC(year, month - 1, 1));
  const start = new Date(Date.UTC(year, month - 1, 1 - first.getUTCDay()));
  const days = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start.getTime() + index * 86400000);
    const value = date.toISOString().slice(0, 10);
    const inMonth = date.getUTCMonth() === month - 1;
    const dateStatus = adsDateStatus.get(value);
    const hasCompleteData = Boolean(dateStatus?.complete);
    const hasPartialData = Boolean(dateStatus?.partial && !dateStatus.complete);
    const inRange = isAdsDateInSelectedRange(value);
    const endpoint = value === startDate || value === endDate;
    const disabled = isDateDisabled(value);
    const dataLabel = hasCompleteData ? "广告组与广告位表现均已同步" : hasPartialData ? "部分广告表现已同步" : "";
    return `<button type="button" class="date-picker-day ${inMonth ? "" : "other-month"} ${hasCompleteData ? "has-data" : ""} ${hasPartialData ? "partial-data" : ""} ${inRange ? "in-range" : ""} ${endpoint ? "selected" : ""}" data-ads-date="${value}" title="${escapeHtml(disabled ? "未来日期不可选" : dataLabel)}" ${disabled ? "disabled" : ""}><span>${date.getUTCDate()}</span></button>`;
  }).join("");
  picker.innerHTML = `
    <div class="date-picker-head"><button type="button" data-ads-date-nav="-1">‹</button><div class="date-picker-title">${year}-${String(month).padStart(2, "0")}</div><button type="button" data-ads-date-nav="1">›</button></div>
    <div class="date-picker-week"><span>日</span><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span></div>
    <div class="date-picker-grid">${days}</div>
    <div class="date-picker-quick">
      <button type="button" data-ads-date-quick="today">今天</button><button type="button" data-ads-date-quick="yesterday">昨天</button>
      <button type="button" data-ads-date-quick="last7">最近7天</button><button type="button" data-ads-date-quick="last30">最近30天</button>
      <button type="button" data-ads-date-quick="last30Exclude2">最近30天（不含近2天）</button>
    </div>
    <div class="date-picker-legend"><span class="date-data-dot"></span> 广告表现同步成功 <span class="date-range-swatch"></span> 已选范围</div>`;
}

async function openAdsDatePicker() {
  const input = $("#adsDateRange");
  const picker = $("#adsDatePicker");
  if (!input || !picker) return;
  adsDatePickerOpen = true;
  adsDatePickerMonth = ($("#adsEndDate")?.value || $("#adsStartDate")?.value || marketplaceToday()).slice(0, 7);
  await loadAdsDateStatus();
  const rect = input.getBoundingClientRect();
  picker.hidden = false;
  renderAdsDatePicker();
  const pickerRect = picker.getBoundingClientRect();
  const margin = 8;
  picker.style.left = `${Math.min(Math.max(margin, rect.left), Math.max(margin, window.innerWidth - pickerRect.width - margin))}px`;
  const belowTop = rect.bottom + 6;
  const aboveTop = rect.top - pickerRect.height - 6;
  picker.style.top = `${belowTop + pickerRect.height + margin <= window.innerHeight ? belowTop : Math.max(margin, aboveTop)}px`;
}

function closeAdsDatePicker() {
  const picker = $("#adsDatePicker");
  if (picker) picker.hidden = true;
  adsDatePickerOpen = false;
}

function updateAdsHistoryDateRangeInput() {
  const input = $("#adsHistoryDateRange");
  if (!input) return;
  const { startDate, endDate } = adsHistoryState;
  input.value = startDate && endDate ? `${startDate} 至 ${endDate}` : (startDate ? `${startDate} 至 ...` : "");
}

function isAdsHistoryDateInRange(value) {
  return isValidDateValue(adsHistoryState.startDate) && isValidDateValue(adsHistoryState.endDate) &&
    value >= adsHistoryState.startDate && value <= adsHistoryState.endDate;
}

async function loadAdsHistoryDateStatus() {
  try {
    const data = await api("/api/ads/dates");
    adsHistoryDateStatus.clear();
    for (const item of data.dates || []) adsHistoryDateStatus.set(item.date, item);
  } catch {
    // Date markers should not block history browsing.
  }
}

function renderAdsHistoryDatePicker() {
  const picker = $("#adsHistoryDatePicker");
  if (!picker || !adsHistoryDatePickerOpen) return;
  const selectedDate = adsHistoryState.endDate || adsHistoryState.startDate || marketplaceToday();
  if (!adsHistoryDatePickerMonth) adsHistoryDatePickerMonth = selectedDate.slice(0, 7);
  const [year, month] = adsHistoryDatePickerMonth.split("-").map(Number);
  const first = new Date(Date.UTC(year, month - 1, 1));
  const start = new Date(Date.UTC(year, month - 1, 1 - first.getUTCDay()));
  const days = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start.getTime() + index * 86400000);
    const value = date.toISOString().slice(0, 10);
    const inMonth = date.getUTCMonth() === month - 1;
    const dateStatus = adsHistoryDateStatus.get(value);
    const hasCompleteData = Boolean(dateStatus?.complete);
    const hasPartialData = Boolean(dateStatus?.partial && !dateStatus.complete);
    const inRange = isAdsHistoryDateInRange(value);
    const endpoint = value === adsHistoryState.startDate || value === adsHistoryState.endDate;
    const disabled = isDateDisabled(value);
    const dataLabel = hasCompleteData ? "广告组与广告位表现均已同步" : hasPartialData ? "部分广告表现已同步" : "";
    return `<button type="button" class="date-picker-day ${inMonth ? "" : "other-month"} ${hasCompleteData ? "has-data" : ""} ${hasPartialData ? "partial-data" : ""} ${inRange ? "in-range" : ""} ${endpoint ? "selected" : ""}" data-ads-history-date="${value}" title="${escapeHtml(disabled ? "未来日期不可选" : dataLabel)}" ${disabled ? "disabled" : ""}><span>${date.getUTCDate()}</span></button>`;
  }).join("");
  picker.innerHTML = `
    <div class="date-picker-head"><button type="button" data-ads-history-date-nav="-1">‹</button><div class="date-picker-title">${year}-${String(month).padStart(2, "0")}</div><button type="button" data-ads-history-date-nav="1">›</button></div>
    <div class="date-picker-week"><span>日</span><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span></div>
    <div class="date-picker-grid">${days}</div>
    <div class="date-picker-quick">
      <button type="button" data-ads-history-date-quick="today">今天</button><button type="button" data-ads-history-date-quick="yesterday">昨天</button>
      <button type="button" data-ads-history-date-quick="last7">最近7天</button><button type="button" data-ads-history-date-quick="last30">最近30天</button>
      <button type="button" data-ads-history-date-quick="last30Exclude2">最近30天（不含近2天）</button>
    </div>
    <div class="date-picker-legend"><span class="date-data-dot"></span> 广告表现同步成功 <span class="date-range-swatch"></span> 已选范围</div>`;
}

async function openAdsHistoryDatePicker() {
  const input = $("#adsHistoryDateRange");
  const picker = $("#adsHistoryDatePicker");
  if (!input || !picker) return;
  adsHistoryDatePickerOpen = true;
  adsHistoryDatePickerMonth = (adsHistoryState.endDate || adsHistoryState.startDate || marketplaceToday()).slice(0, 7);
  await loadAdsHistoryDateStatus();
  const rect = input.getBoundingClientRect();
  picker.hidden = false;
  renderAdsHistoryDatePicker();
  const pickerRect = picker.getBoundingClientRect();
  const margin = 8;
  picker.style.left = `${Math.min(Math.max(margin, rect.left), Math.max(margin, window.innerWidth - pickerRect.width - margin))}px`;
  const belowTop = rect.bottom + 6;
  const aboveTop = rect.top - pickerRect.height - 6;
  picker.style.top = `${belowTop + pickerRect.height + margin <= window.innerHeight ? belowTop : Math.max(margin, aboveTop)}px`;
}

function closeAdsHistoryDatePicker() {
  const picker = $("#adsHistoryDatePicker");
  if (picker) picker.hidden = true;
  adsHistoryDatePickerOpen = false;
}

async function loadProducts({ mode = "" } = {}) {
  const range = defaultDateRange();
  const startDate = $("#salesStartDate")?.value || range.startDate;
  const endDate = $("#salesEndDate")?.value || startDate || range.endDate;
  const params = new URLSearchParams({ startDate, endDate });
  if (mode) params.set("mode", mode);
  const data = await api(`/api/fba/inventory?${params.toString()}`);
  products = normalizeFbaProductRows(data.rows);
  productsLoaded = true;
  window.fbaInventoryMeta = {
    totals: data.totals || {},
    range: data.range || {},
    config: data.config || {},
    sales: data.sales || {},
    warnings: data.warnings || [],
    syncJob: data.syncJob || null
  };
  renderProducts();
  await loadFbaDateStatus();
  if (!$("#fbaDatePicker")?.hidden) renderDatePicker();
  return data;
}

async function queryProducts() {
  const button = $("#queryProductsBtn");
  setBusy(button, true, "查询");
  try {
    const data = await loadProducts();
    const warnings = data.warnings || [];
    $("#sandboxStatus").textContent = warnings.length
      ? `FBA库存查询完成 ${products.length} 个 SKU；有 ${warnings.length} 条数据提示`
      : `FBA库存查询完成 ${products.length} 个 SKU`;
    return data;
  } catch (error) {
    $("#sandboxStatus").textContent = `FBA库存查询失败：${error.message}`;
    throw error;
  } finally {
    setBusy(button, false, "查询");
  }
}

function fbaSyncJobText(job) {
  if (!job) return "";
  const range = job.startDate && job.endDate ? `${job.startDate} 至 ${job.endDate}` : "所选日期";
  if (job.status === "queued") return `FBA后台同步已排队：${range}`;
  if (job.status === "running") return `FBA后台同步中：${range}`;
  if (job.status === "done") return `FBA后台同步完成：${range}`;
  if (job.status === "partial") return `FBA后台同步部分完成：${job.warnings?.length || 0} 条提示`;
  if (job.status === "failed") return `FBA后台同步失败：${job.error || "未知错误"}`;
  return `FBA后台同步状态：${job.status}`;
}

async function pollFbaSyncJob(jobId, attempt = 0) {
  if (!jobId || attempt > 60) return;
  const data = await api("/api/fba/sync").catch(() => null);
  const job = data?.job;
  if (!job || job.id !== jobId) return;
  const text = fbaSyncJobText(job);
  if (text) $("#sandboxStatus").textContent = text;
  if (["queued", "running"].includes(job.status)) {
    setTimeout(() => pollFbaSyncJob(jobId, attempt + 1), 5000);
  } else if (activeModule === "products") {
    await loadProducts().catch(() => {});
  }
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
  setBusy(button, true, "后台刷新数据");
  try {
    const { startDate, endDate } = getSelectedDateRange();
    const data = await api("/api/fba/sync", {
      method: "POST",
      body: { startDate, endDate, reason: "manual", allowFrozenInventoryUpdate: true, forceNewReport: true }
    });
    $("#sandboxStatus").textContent = fbaSyncJobText(data.job) || "FBA后台同步任务已提交";
    pollFbaSyncJob(data.job?.id).catch(() => {});
  } catch (error) {
    $("#sandboxStatus").textContent = `FBA后台刷新提交失败：${error.message}`;
    alert(error.message);
  } finally {
    setBusy(button, false, "后台刷新数据");
  }
}

function renderAdsStatus(status = window.adsStatusMeta || {}) {
  const statusNode = $("#adsStatus");
  if (!statusNode) return;

  const configured = Boolean(status.configured);
  const authorized = Boolean(status.authorized);
  const selected = status.selectedProfile || null;
  statusNode.classList.toggle("ok", configured && authorized);
  statusNode.classList.toggle("warn", !configured || !authorized);
  if (!configured) {
    statusNode.textContent = "未配置";
    statusNode.title = `缺少配置：${(status.missing || []).join("、") || "Amazon Ads .env"}`;
  } else if (!authorized) {
    statusNode.textContent = "未授权";
    statusNode.title = "已读取 Ads 配置，等待授权广告账户";
  } else if (!selected?.profileId) {
    statusNode.textContent = "已授权";
    statusNode.title = "广告账户已授权，请选择一个 Profile";
  } else {
    statusNode.textContent = "已授权";
    statusNode.title = `已选择 ${selected.countryCode || selected.profileId}`;
  }

  const quick = $("#adsQuickText");
  if (quick) {
    quick.textContent = selected?.profileId
      ? `已选择 ${selected.countryCode || selected.profileId}`
      : authorized ? "选择广告 Profile" : "授权 Amazon Ads";
  }
}

function adsProfileLabel(profile) {
  return [
    profile.countryCode || "",
    profile.currencyCode || "",
    profile.accountName || "",
    profile.type || ""
  ].filter(Boolean).join(" / ") || profile.profileId;
}

function preferredAdsProfileId() {
  return (
    adsProfiles.find(profile => profile.countryCode === "US") ||
    adsProfiles.find(profile => profile.currencyCode === "USD") ||
    adsProfiles[0]
  )?.profileId || "";
}

function renderAdsProfiles() {
  const select = $("#adsProfileSelect");
  if (!select) return;
  if (!adsProfiles.length) {
    select.innerHTML = `<option value="">选择 Profile</option>`;
    select.disabled = true;
    return;
  }
  select.disabled = false;
  select.innerHTML = adsProfiles.map(profile => `
    <option value="${escapeHtml(profile.profileId)}">${escapeHtml(adsProfileLabel(profile))}</option>
  `).join("");
  select.value = selectedAdsProfileId || preferredAdsProfileId();
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
      const profilesData = await loadAdsProfiles();
      if (!profilesData.selectedProfile?.profileId && preferredAdsProfileId()) {
        await selectAdsProfile(preferredAdsProfileId());
      }
    } catch (error) {
      const select = $("#adsProfileSelect");
      if (select) {
        select.innerHTML = `<option value="">Profile 读取失败</option>`;
        select.disabled = true;
        select.title = error.message;
      }
    }
  }
  if (status.authorized && (selectedAdsProfileId || preferredAdsProfileId())) {
    await loadAdsWorkspace({ refreshPortfolio: true });
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
  selectedAdsParentAsin = "";
  selectedAdsKeywordId = "";
  await loadAdsWorkspace({ refreshPortfolio: true });
}

function adsGroupLabel(group) {
  return { NORMAL: "普通", PROMOTED: "主推", STABLE: "已稳定", STOPPED: "停止" }[group] || "普通";
}

const ADS_GROUP_DESCRIPTIONS = {
  NORMAL: "普通用于常规测试和稳定维护。它代表没有明确增长或收缩目标的关键词，系统会保留完整的曝光、点击、转化、ACOS 与出价历史；后续 AI 会以效率、趋势和异常为主提供建议，不会因归入普通而自动调价、启停或改变预算。",
  PROMOTED: "主推用于当前需要获得更多流量和销售的重点关键词。后续 AI 分析会更重视展示份额、顶部搜索加价、排名与增量订单，并把可承受 ACOS 与预算消耗一并评估；它只影响建议优先级，任何调价、加预算或启停仍必须由你确认。",
  STABLE: "稳定用于已验证转化与成本表现、暂不需要频繁调整的关键词。后续 AI 会优先观察 ACOS、销量和曝光是否出现异常波动，并提示是否需要复盘或恢复测试；稳定并不等于永久不动，所有建议仍以数据变化和你的确认作为执行前提。"
};

function renderAdsGroupPicker(keyword) {
  const options = ["NORMAL", "PROMOTED", "STABLE"];
  return `<div class="ads-group-picker" data-ads-group-picker="${keyword.id}">
    <button class="ads-group-picker-toggle" type="button" data-ads-group-toggle="${keyword.id}" aria-expanded="false">${adsGroupLabel(keyword.group)}<span aria-hidden="true">⌄</span></button>
    <div class="ads-group-picker-menu" data-ads-group-menu="${keyword.id}" hidden>
      <div class="ads-group-picker-options" role="listbox" aria-label="运营分组">
        ${options.map(group => `<button type="button" role="option" aria-selected="${group === keyword.group}" data-ads-group-option="${group}" data-ads-keyword-id="${keyword.id}" class="${group === keyword.group ? "selected" : ""}">${adsGroupLabel(group)}</button>`).join("")}
      </div>
      <p data-ads-group-help>${escapeHtml(ADS_GROUP_DESCRIPTIONS[keyword.group])}</p>
    </div>
  </div>`;
}

function adsMatchLabel(matchType) {
  return { EXACT: "精准", PHRASE: "词组", BROAD: "广泛" }[matchType] || matchType;
}

function adsStateLabel(value) {
  return { ENABLED: "已开始", PAUSED: "已暂停", STOPPED: "已停止", NOT_CREATED: "待创建", INCOMPLETE: "创建未完成", SUCCESS: "已同步" }[value] || value || "待创建";
}

function adsCampaignStatusLabel(campaign) {
  if (campaign.lifecycleStatus === "STOPPED") return "已停止";
  if (campaign.creationStatus === "CREATING") return "创建中";
  if (campaign.creationStatus === "COMPLETE") return campaign.desiredState === "ENABLED" ? "已开始" : "已暂停";
  if (campaign.creationStatus === "NOT_CREATED") return "创建中";
  return "创建未完成";
}

function adsPercent(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "-";
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function adsStopTimeLabel(value) {
  if (!value) return "停止时间未记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 19);
  return date.toLocaleString("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  }).replace(/\//g, "-");
}

const ADS_HISTORY_METRICS = {
  bid: { label: "出价", unit: "money", color: "#2563eb" },
  dailyBudget: { label: "日预算", unit: "money", color: "#0f766e" },
  topOfSearchAdjustment: { label: "顶部加价", unit: "percent", color: "#7c3aed" },
  restOfSearchAdjustment: { label: "其余搜索加价", unit: "percent", color: "#0ea5e9" },
  productPageAdjustment: { label: "商品页加价", unit: "percent", color: "#ec4899" },
  actualCpc: { label: "CPC", unit: "money", color: "#0891b2" },
  impressions: { label: "曝光", unit: "integer", color: "#2563eb" },
  clicks: { label: "点击", unit: "integer", color: "#f97316" },
  spend: { label: "花费", unit: "money", color: "#dc2626" },
  orders: { label: "订单数", unit: "integer", color: "#16a34a" },
  units: { label: "销量", unit: "integer", color: "#0f766e" },
  sales: { label: "销售额", unit: "money", color: "#9333ea" },
  naturalRank: { label: "关键词自然位", unit: "rank", color: "#10b981" },
  adRank: { label: "关键词广告位", unit: "rank", color: "#f97316" }
};

const ADS_HISTORY_POSITION_METRICS = [
  ["ActualCpc", "CPC", "money"],
  ["Impressions", "曝光", "integer"],
  ["Clicks", "点击", "integer"],
  ["Spend", "花费", "money"],
  ["Orders", "订单数", "integer"],
  ["Units", "销量", "integer"],
  ["Sales", "销售额", "money"]
];

for (const [prefix, label, color] of [["top", "顶部搜索", "#2563eb"], ["rest", "其余搜索", "#0ea5e9"], ["product", "商品页面", "#ec4899"]]) {
  for (const [suffix, metricLabel, unit] of ADS_HISTORY_POSITION_METRICS) {
    ADS_HISTORY_METRICS[`${prefix}${suffix}`] = { label: `${label} · ${metricLabel}`, unit, color };
  }
}

function isAdsKeywordComplete(keyword) {
  return Boolean(keyword?.campaigns?.length) && keyword.campaigns.every(campaign =>
    campaign.creationStatus === "COMPLETE" && Boolean(campaign.amazonCampaignId) && campaign.units.length > 0 &&
    campaign.units.every(unit => unit.creationStatus === "COMPLETE" && unit.amazonAdGroupId && unit.amazonProductAdId && unit.amazonTargetId)
  );
}

function resetAdsHistoryState(keyword) {
  if (adsHistoryState.keywordId === keyword.id) return;
  adsHistoryState = {
    keywordId: keyword.id,
    childAsin: "ALL",
    matchType: "ALL",
    startDate: adsWorkspace.range?.startDate || "",
    endDate: adsWorkspace.range?.endDate || "",
    metricA: "impressions",
    metricB: "clicks"
  };
}

function adsHistoryMetricOptions(selected) {
  const option = ([key, metric]) => `<option value="${key}" ${key === selected ? "selected" : ""} ${metric.unavailable ? "disabled" : ""}>${escapeHtml(metric.label)}</option>`;
  const overall = ["bid", "dailyBudget", "topOfSearchAdjustment", "restOfSearchAdjustment", "productPageAdjustment", "actualCpc", "impressions", "clicks", "spend", "orders", "units", "sales", "naturalRank", "adRank"]
    .map(key => [key, ADS_HISTORY_METRICS[key]]);
  const positionGroup = (label, prefix) => ADS_HISTORY_POSITION_METRICS.map(([suffix]) => [`${prefix}${suffix}`, ADS_HISTORY_METRICS[`${prefix}${suffix}`]]);
  return `<optgroup label="综合">${overall.map(option).join("")}</optgroup>`
    + `<optgroup label="顶部搜索">${positionGroup("顶部搜索", "top").map(option).join("")}</optgroup>`
    + `<optgroup label="其余搜索">${positionGroup("其余搜索", "rest").map(option).join("")}</optgroup>`
    + `<optgroup label="商品页面">${positionGroup("商品页面", "product").map(option).join("")}</optgroup>`;
}

function formatAdsHistoryValue(value, metricKey, currency = "USD") {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "-";
  const metric = ADS_HISTORY_METRICS[metricKey] || {};
  if (metric.unit === "money") return asMoney(Number(value), currency);
  if (metric.unit === "percent") return `${Number(value).toFixed(0)}%`;
  if (metric.unit === "rank") return Number(value).toFixed(0);
  return formatNumber(Number(value));
}

function currentAdsProduct() {
  return adsWorkspace.products.find(item => item.parentAsin === selectedAdsParentAsin) || adsWorkspace.products[0] || null;
}

function currentAdsKeyword() {
  return adsWorkspace.keywords.find(item => item.id === selectedAdsKeywordId) || null;
}

function renderAdsPortfolioGuard() {
  const node = $("#adsPortfolioGuard");
  if (!node) return;
  const portfolio = adsWorkspace.portfolio;
  node.className = "ads-portfolio-guard";
  if (!portfolio) {
    node.classList.add("missing");
    node.innerHTML = `<strong>尚未检查 ${escapeHtml("AmzAllBlue_ERP")}</strong><span>点击刷新重新验证</span>`;
    return;
  }
  if (portfolio.status === "READY") {
    node.classList.add("ready");
    node.innerHTML = `<strong>仅管理 ${escapeHtml(portfolio.name)}</strong><span>Portfolio ID ${escapeHtml(portfolio.portfolioId)} · 已通过隔离检查</span>`;
    return;
  }
  const label = portfolio.status === "MISSING" ? "广告组合不存在" : "广告组合已锁定";
  node.classList.add(portfolio.status === "MISSING" ? "missing" : "blocked");
  node.innerHTML = `<strong>${escapeHtml(label)}</strong><span>${escapeHtml(portfolio.error || "请刷新检查")}</span>`;
}

function renderAdsProductTabs() {
  const container = $("#adsProductTabs");
  if (!container) return;
  if (!adsWorkspace.products.length) {
    container.innerHTML = `<div class="ads-empty-inline">FBA库存中还没有可用于广告的父 ASIN / SKU</div>`;
    return;
  }
  if (!selectedAdsParentAsin || !adsWorkspace.products.some(item => item.parentAsin === selectedAdsParentAsin)) {
    selectedAdsParentAsin = adsWorkspace.products[0].parentAsin;
  }
  container.innerHTML = adsWorkspace.products.map(product => {
    const count = adsWorkspace.keywords.filter(item => item.parentAsin === product.parentAsin).length;
    return `<button class="ads-product-tab ${product.parentAsin === selectedAdsParentAsin ? "active" : ""}" data-ads-parent="${escapeHtml(product.parentAsin)}" draggable="true" title="拖动调整父 ASIN 顺序">
      <span class="ads-product-drag" aria-hidden="true">⋮⋮</span>
      <span class="ads-product-copy"><strong>${escapeHtml(product.internalName || product.parentAsin)}</strong><small>${escapeHtml(product.parentAsin)} · ${count} 词</small></span>
    </button>`;
  }).join("");
}

async function saveAdsProductOrder() {
  try {
    const result = await api("/api/ads/products/reorder", {
      method: "POST",
      body: { parentAsins: adsWorkspace.products.map(product => product.parentAsin) }
    });
    adsWorkspace.products = result.products || adsWorkspace.products;
    renderAdsProductTabs();
  } catch (error) {
    alert(error.message);
    await loadAdsWorkspace().catch(() => {});
  }
}

function moveAdsParentTab(targetParentAsin) {
  if (!draggedAdsParentAsin || !targetParentAsin || draggedAdsParentAsin === targetParentAsin) return;
  const fromIndex = adsWorkspace.products.findIndex(product => product.parentAsin === draggedAdsParentAsin);
  const toIndex = adsWorkspace.products.findIndex(product => product.parentAsin === targetParentAsin);
  if (fromIndex < 0 || toIndex < 0) return;
  const next = [...adsWorkspace.products];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  adsWorkspace.products = next;
  renderAdsProductTabs();
  saveAdsProductOrder();
}

function adsKeywordIdsForParent(parentAsin) {
  return adsWorkspace.keywords
    .filter(keyword => keyword.parentAsin === parentAsin)
    .map(keyword => keyword.id);
}

async function saveAdsKeywordOrder(parentAsin) {
  try {
    await api("/api/ads/keywords/reorder", {
      method: "POST",
      body: { parentAsin, keywordIds: adsKeywordIdsForParent(parentAsin) }
    });
  } catch (error) {
    alert(error.message);
    await loadAdsWorkspace().catch(() => {});
  }
}

function moveAdsKeywordRow(targetKeywordId, sourceKeywordId) {
  if (!sourceKeywordId || !targetKeywordId || sourceKeywordId === targetKeywordId) return;
  const parentAsin = selectedAdsParentAsin;
  const parentKeywords = adsWorkspace.keywords.filter(keyword => keyword.parentAsin === parentAsin);
  const otherKeywords = adsWorkspace.keywords.filter(keyword => keyword.parentAsin !== parentAsin);
  const fromIndex = parentKeywords.findIndex(keyword => keyword.id === sourceKeywordId);
  const toIndex = parentKeywords.findIndex(keyword => keyword.id === targetKeywordId);
  if (fromIndex < 0 || toIndex < 0) return;
  const nextParentKeywords = [...parentKeywords];
  const [moved] = nextParentKeywords.splice(fromIndex, 1);
  nextParentKeywords.splice(toIndex, 0, moved);
  adsWorkspace.keywords = [...otherKeywords, ...nextParentKeywords.map((keyword, index) => ({ ...keyword, sortOrder: (index + 1) * 10 }))];
  renderAdsKeywordRows();
  saveAdsKeywordOrder(parentAsin);
}

function filteredAdsKeywords() {
  const query = ($("#adsKeywordSearch")?.value || "").trim().toLowerCase();
  return adsWorkspace.keywords.filter(item => {
    if (item.parentAsin !== selectedAdsParentAsin) return false;
    if (selectedAdsGroup === "STOPPED") {
      if (item.lifecycleStatus !== "STOPPED") return false;
    } else {
      if (!["ACTIVE", "CREATING", "STOPPING"].includes(item.lifecycleStatus)) return false;
      if (selectedAdsGroup !== "ALL" && item.group !== selectedAdsGroup) return false;
    }
    if (!query) return true;
    return [item.keyword, ...item.campaigns.flatMap(campaign => campaign.units.flatMap(unit => [unit.childAsin, unit.sellerSku]))]
      .join(" ").toLowerCase().includes(query);
  });
}

function adsCampaignsFor(keyword, matchType, { includeStopped = false } = {}) {
  return keyword.campaigns.filter(item => item.matchType === matchType && (includeStopped || item.lifecycleStatus !== "STOPPED"));
}

function adsCampaignFor(keyword, matchType) {
  return adsCampaignsFor(keyword, matchType)[0] || null;
}

function adsCampaignProduct(keyword, campaign) {
  const product = adsWorkspace.products.find(item => item.parentAsin === keyword.parentAsin);
  return product?.children?.find(item => item.asin === campaign.childAsin && (!campaign.sellerSku || item.sellerSku === campaign.sellerSku)) || null;
}

function renderAdsMatchCell(keyword, matchType) {
  const campaigns = adsCampaignsFor(keyword, matchType);
  if (!campaigns.length) return `<span class="ads-match-pill off">未添加</span>`;
  if (campaigns.some(campaign => campaign.creationStatus === "CREATING")) return `<span class="ads-match-pill draft">创建中</span>`;
  if (campaigns.some(campaign => campaign.creationStatus === "NOT_CREATED")) return `<span class="ads-match-pill draft">创建中</span>`;
  if (campaigns.some(campaign => campaign.creationStatus !== "COMPLETE")) return `<span class="ads-match-pill error">未完成</span>`;
  if (campaigns.some(campaign => campaign.desiredState === "ENABLED")) return `<span class="ads-match-pill on">已开始</span>`;
  return `<span class="ads-match-pill paused">已暂停</span>`;
}

function renderAdsKeywordRows() {
  const product = currentAdsProduct();
  const rows = filteredAdsKeywords();
  const allForProduct = adsWorkspace.keywords.filter(item => item.parentAsin === selectedAdsParentAsin && item.lifecycleStatus !== "STOPPED");
  const archivedForProduct = adsWorkspace.keywords.filter(item => item.parentAsin === selectedAdsParentAsin && item.lifecycleStatus === "STOPPED");
  $("#adsCurrentProductName").textContent = product?.internalName || "选择产品";
  $("#adsCurrentParentAsin").textContent = product?.parentAsin || "";
  $("#adsKeywordCount").textContent = `${allForProduct.length} 个关键词`;
  $("#adsGroupCountAll").textContent = allForProduct.length;
  $("#adsGroupCountStable").textContent = allForProduct.filter(item => item.group === "STABLE").length;
  $("#adsGroupCountPromoted").textContent = allForProduct.filter(item => item.group === "PROMOTED").length;
  $("#adsGroupCountNormal").textContent = allForProduct.filter(item => item.group === "NORMAL").length;
  $("#adsGroupCountArchived").textContent = archivedForProduct.length;
  const tbody = $("#adsKeywordRows");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="9"><div class="ads-table-empty"><strong>还没有关键词</strong><span>点击“添加关键词”创建第一条广告计划</span></div></td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(keyword => {
    const childAsins = [...new Set(keyword.campaigns.flatMap(campaign => campaign.units.map(unit => unit.childAsin)))];
    const keywordSubline = keyword.lifecycleStatus === "STOPPED"
      ? `停止时间：${adsStopTimeLabel(keyword.stoppedAt)}`
      : `${formatNumber(keyword.metrics.impressions)} 曝光 · ${formatNumber(keyword.metrics.clicks)} 点击 · ${formatNumber(keyword.metrics.orders)} 订单量`;
    const aiReminder = Number(keyword.aiSuggestionCount || 0) > 0
      ? `<button type="button" class="ads-ai-reminder" data-ads-ai-reminder="${keyword.id}" title="${keyword.aiSuggestionCount} 条 AI 建议待处理" aria-label="查看 AI 建议">!</button>`
      : "";
    const aiSummaryText = keyword.aiGoalSet
      ? (keyword.aiSuggestionAction ? adsAiActionLabel(keyword.aiSuggestionAction) : (keyword.aiAnalysisSummary === "AI 正在分析中…" ? "AI 正在分析中…" : "已设置调整目标，等待 AI 分析"))
      : "";
    const aiSummary = aiSummaryText
      ? `<span class="ads-keyword-ai-summary"><b>建议行动：</b>${escapeHtml(aiSummaryText)}</span>`
      : "";
    return `<tr class="${keyword.id === selectedAdsKeywordId ? "selected" : ""}" data-ads-keyword-id="${keyword.id}">
      <td><div class="ads-keyword-main"><button type="button" class="ads-keyword-drag" title="拖动调整关键词顺序" aria-label="拖动调整关键词顺序">⋮⋮</button><div><div class="ads-keyword-name"><strong>${escapeHtml(keyword.keyword)}</strong>${aiReminder}</div><span>${escapeHtml(keywordSubline)}</span>${aiSummary}</div></div></td>
      <td>${childAsins.length ? childAsins.map(asin => `<span class="ads-asin-chip">${escapeHtml(asin)}</span>`).join("") : "-"}</td>
      <td><span class="ads-group-badge ${keyword.group.toLowerCase()}">${adsGroupLabel(keyword.group)}</span></td>
      <td>${renderAdsMatchCell(keyword, "EXACT")}</td><td>${renderAdsMatchCell(keyword, "PHRASE")}</td><td>${renderAdsMatchCell(keyword, "BROAD")}</td>
      <td>${asMoney(keyword.metrics.spend, adsWorkspace.profile?.currencyCode || "USD")}</td>
      <td>${asMoney(keyword.metrics.sales, adsWorkspace.profile?.currencyCode || "USD")}</td>
      <td>${adsPercent(keyword.metrics.acos)}</td>
    </tr>`;
  }).join("");
}

function renderAdsAiPanel(keyword, currency) {
  return `<aside class="ads-ai-panel" id="adsAiPanel">
    <div class="ads-ai-panel-head"><div><span class="ads-ai-kicker">AI 广告助手</span><strong>调整目标与建议</strong><p>分析近 30 天全部广告与排名指标；建议按策略规则中的处理建议行动执行。</p></div><span id="adsAiConnectionStatus" class="ads-ai-status">读取中</span></div>
    <section class="ads-ai-section ads-ai-goal-section">
      <div class="ads-ai-section-title"><strong>调整目标</strong><span>手动输入</span></div>
      <textarea id="adsAiGoal" rows="3" placeholder="例如：7 天内冲到首页；或 ACOS 控制在 30% 以下"></textarea>
      <div class="ads-ai-goal-examples"><button type="button" data-ads-ai-goal="到搜索首页">到搜索首页</button><button type="button" data-ads-ai-goal="控制 ACOS 在 30% 以下">ACOS ≤ 30%</button><button type="button" data-ads-ai-goal="优先恢复曝光">恢复曝光</button></div>
      <div class="ads-ai-goal-actions"><button type="button" class="secondary-button" data-ads-ai-save-goal>保存目标</button><button type="button" class="primary" data-ads-ai-analyze>开始 AI 分析</button></div>
    </section>
    <section class="ads-ai-section">
      <div class="ads-ai-section-title"><strong>AI 分析</strong><span id="adsAiAnalysisStatus">读取中</span></div>
      <div id="adsAiAnalysisContent" class="ads-ai-analysis"><i aria-hidden="true">⌁</i><p>正在读取最近一次分析…</p></div>
    </section>
    <section class="ads-ai-section ads-ai-action-section">
      <div class="ads-ai-section-title"><strong>建议行动</strong><span id="adsAiRecommendationCount">读取中</span></div>
      <div id="adsAiRecommendations"><div class="ads-ai-action-empty"><strong>正在读取建议</strong><p>仅实际 AI 建议会出现在这里。</p></div></div>
    </section>
    <div class="ads-ai-panel-footer-actions"><button type="button" class="ads-ai-playbook-button" data-ads-ai-strategy>调整 AI 策略规则</button><button type="button" class="ads-ai-history-button" data-ads-ai-history>查看分析历史</button></div>
  </aside>`;
}

function renderAdsHistoryPanel(keyword) {
  resetAdsHistoryState(keyword);
  const childAsins = [...new Set(keyword.campaigns.flatMap(campaign => campaign.units.map(unit => unit.childAsin)))];
  const matchTypes = keyword.campaigns.map(campaign => campaign.matchType);
  return `<div class="ads-history-ai-stack"><section class="ads-history-panel">
    <div class="ads-history-title"><div><strong>关键词历史数据</strong><span>选择子 ASIN、策略和两个指标进行对比</span></div></div>
    <div class="ads-history-content">
      <div class="ads-history-filters">
        <label class="date-range">日期范围<input id="adsHistoryDateRange" type="text" readonly value="${escapeHtml(adsHistoryState.startDate && adsHistoryState.endDate ? `${adsHistoryState.startDate} 至 ${adsHistoryState.endDate}` : "")}"></label>
        <label class="asin">子 ASIN<select id="adsHistoryAsin"><option value="ALL">全部</option>${childAsins.map(asin => `<option value="${escapeHtml(asin)}" ${adsHistoryState.childAsin === asin ? "selected" : ""}>${escapeHtml(asin)}</option>`).join("")}</select></label>
        <label class="strategy">策略<select id="adsHistoryMatch"><option value="ALL">全部</option>${matchTypes.map(match => `<option value="${match}" ${adsHistoryState.matchType === match ? "selected" : ""}>${adsMatchLabel(match)}</option>`).join("")}</select></label>
        <label class="metric"><span><i class="ads-series-dot primary"></i>指标一</span><select id="adsHistoryMetricA">${adsHistoryMetricOptions(adsHistoryState.metricA)}</select></label>
        <label class="metric"><span><i class="ads-series-dot secondary"></i>指标二</span><select id="adsHistoryMetricB">${adsHistoryMetricOptions(adsHistoryState.metricB)}</select></label>
        <button id="adsHistoryQueryBtn" class="primary" type="button">查询</button>
        <small>最多显示 2 个指标；自然位和广告位来自关键词监控每日历史。</small>
      </div>
      <div id="adsHistoryChart" class="ads-history-chart"><div class="ads-history-loading">正在读取历史数据…</div></div>
    </div>
  </section>${renderAdsAiPanel(keyword, adsWorkspace.profile?.currencyCode || "USD")}</div>`;
}

function adsPlacementLabel(value) {
  const placement = String(value || "").toUpperCase();
  if (["PLACEMENT_TOP", "TOP_OF_SEARCH", "TOP"].includes(placement)) return "顶部搜索";
  if (["PLACEMENT_REST_OF_SEARCH", "REST_OF_SEARCH", "OTHER"].includes(placement)) return "其余搜索";
  if (["PLACEMENT_PRODUCT_PAGE", "PRODUCT_PAGE", "DETAIL_PAGE"].includes(placement)) return "商品页面";
  return value || "未知位置";
}

function adsCampaignPerformanceTable(campaign, currency) {
  const rows = [
    { label: "综合", metrics: campaign.metrics, complete: true },
    ...["顶部搜索", "其余搜索", "商品页面"].map(label => ({
      label,
      metrics: campaign.placements.find(item => adsPlacementLabel(item.placement) === label) || null,
      complete: false
    }))
  ];
  const value = (metrics, field, formatter = formatNumber) => metrics ? formatter(metrics[field] || 0) : "-";
  return `<div class="ads-performance-section"><div class="ads-card-section-title"><strong>所选日期表现</strong><span>${escapeHtml(adsWorkspace.range?.startDate || "-")} 至 ${escapeHtml(adsWorkspace.range?.endDate || "-")}</span></div><div class="ads-performance-table-wrap"><table class="ads-performance-table"><thead><tr><th>位置</th><th>CPC</th><th>曝光</th><th>点击</th><th>花费</th><th>订单</th><th>销量</th><th>销售额</th><th>ACOS</th></tr></thead><tbody>${rows.map(row => { const metrics = row.metrics; const clicks = Number(metrics?.clicks || 0); const spend = Number(metrics?.spend || 0); const sales = Number(metrics?.sales || 0); return `<tr class="${row.complete ? "total" : ""}"><td>${row.label}</td><td>${metrics ? (clicks ? asMoney(spend / clicks, currency) : "-") : "-"}</td><td>${value(metrics, "impressions")}</td><td>${value(metrics, "clicks")}</td><td>${metrics ? asMoney(spend, currency) : "-"}</td><td>${value(metrics, "orders")}</td><td>${value(metrics, "units")}</td><td>${metrics ? asMoney(sales, currency) : "-"}</td><td>${metrics ? adsPercent(sales > 0 ? spend / sales : null) : "-"}</td></tr>`; }).join("")}</tbody></table></div></div>`;
}

function renderAdsCampaignCard(keyword, campaign, currency) {
  return `<article class="ads-campaign-card">
    <header><div><div class="ads-campaign-title-row"><strong>${adsMatchLabel(campaign.matchType)}</strong><span class="ads-object-state ${campaign.creationStatus === "COMPLETE" ? (campaign.desiredState === "ENABLED" ? "ready" : "draft") : "draft"}">${adsCampaignStatusLabel(campaign)}</span></div><span>${escapeHtml(campaign.name)}</span></div><div class="ads-object-actions">${campaign.creationStatus === "COMPLETE" ? `<button type="button" data-ads-campaign-state="${campaign.id}" data-next-state="${campaign.desiredState === "ENABLED" ? "PAUSED" : "ENABLED"}">${campaign.desiredState === "ENABLED" ? "暂停" : "开始"}</button><button class="danger" type="button" data-ads-campaign-stop="${campaign.id}">停止</button>` : ""}</div></header>
    ${adsCampaignPerformanceTable(campaign, currency)}
    <div class="ads-campaign-settings"><div class="ads-card-section-title"><strong>可设置</strong><span>保存后将更新 Amazon Ads</span></div><div class="ads-campaign-settings-fields"><label>日预算<input data-ads-campaign-budget type="number" min="0.01" step="0.01" value="${campaign.dailyBudget}"></label><label>顶部搜索 %<input data-ads-campaign-top type="number" min="0" max="900" step="1" value="${campaign.topOfSearchAdjustment}"></label><label>其余搜索 %<input data-ads-campaign-rest type="number" min="0" max="900" step="1" value="${campaign.restOfSearchAdjustment}"></label><label>商品页面 %<input data-ads-campaign-product type="number" min="0" max="900" step="1" value="${campaign.productPageAdjustment}"></label><button type="button" data-ads-save-campaign-settings="${campaign.id}">保存设置</button></div><div class="ads-unit-list">${campaign.units.map(unitRow => `<div class="ads-unit-row"><div><strong>${escapeHtml(unitRow.childAsin)}</strong><span>${escapeHtml(unitRow.sellerSku)}</span></div><label class="ads-unit-bid">出价 <input data-ads-unit-bid type="number" min="0.01" step="0.01" value="${unitRow.bid}"><button type="button" data-ads-save-unit-bid="${unitRow.id}">保存</button></label></div>`).join("")}</div></div>
    ${campaign.error ? `<div class="ads-inline-error">${escapeHtml(campaign.failedStep)}：${escapeHtml(campaign.error)}</div>` : ""}
  </article>`;
}

function renderAdsDetailProducts(keyword) {
  const identities = [...new Map(keyword.campaigns.map(campaign => {
    const unit = campaign.units[0] || {};
    const childAsin = campaign.childAsin || unit.childAsin || "";
    const sellerSku = campaign.sellerSku || unit.sellerSku || "";
    return [`${childAsin}|${sellerSku}`, { childAsin, sellerSku, product: adsCampaignProduct(keyword, campaign) }];
  })).values()];
  if (!identities.length) return "";
  const money = value => value === null || value === undefined || value === "" ? "—" : `$${Number(value).toFixed(2)}`;
  return `<div class="ads-detail-products">${identities.map(({ childAsin, sellerSku, product }) => {
    const bid = keyword.monitoring?.find(item => String(item.asin || "").toUpperCase() === String(childAsin || "").toUpperCase())?.fixedBid;
    const bidHtml = bid ? `<div class="ads-detail-bid"><span>竞价：</span><b>精准 ${money(bid.exact?.median ?? bid.exact?.start)}</b><b>词组 ${money(bid.phrase?.median ?? bid.phrase?.start)}</b><b>广泛 ${money(bid.broad?.median ?? bid.broad?.start)}</b></div>` : "";
    return `<div class="ads-detail-product"><div class="ads-detail-product-main">${product?.imageUrl ? `<img src="${escapeHtml(product.imageUrl)}" alt="${escapeHtml(product.internalName || childAsin)}" loading="lazy">` : `<span class="ads-detail-product-placeholder">无图</span>`}<div><strong>${escapeHtml(product?.internalName || "未设置内部名")}</strong><span>${escapeHtml(childAsin || "-")} · ${escapeHtml(sellerSku || "-")}</span></div></div>${bidHtml}</div>`;
  }).join("")}</div>`;
}

function renderAdsDetail() {
  const panel = $("#adsDetailPanel");
  const keyword = currentAdsKeyword();
  if (!keyword) {
    panel.innerHTML = `<div class="ads-empty-detail"><strong>选择一个关键词</strong><span>查看匹配方式、子 ASIN、出价和表现明细</span></div>`;
    return;
  }
  if (keyword.lifecycleStatus === "CREATING") {
    panel.innerHTML = `<div class="ads-detail-head"><div class="ads-detail-identity"><span>${escapeHtml(keyword.parentAsin)}</span><div class="ads-detail-title-row"><strong>${escapeHtml(keyword.keyword)}</strong><div class="ads-inline-group"><span>运营分组</span><span class="ads-group-badge ${keyword.group.toLowerCase()}">${adsGroupLabel(keyword.group)}</span></div></div></div><span class="ads-object-state draft">创建中</span></div><div class="ads-creation-progress"><strong>正在创建 Amazon Ads</strong><span>后台正依次创建 Campaign、Ad Group、Product Ad 与 Keyword Target。稍后刷新或重新点击该关键词即可查看进度和结果。</span></div>`;
    return;
  }
  const currency = adsWorkspace.profile?.currencyCode || "USD";
  const canDiscardPlan = keyword.campaigns.every(campaign => !campaign.amazonCampaignId && campaign.units.every(unit =>
    !unit.amazonAdGroupId && !unit.amazonProductAdId && !unit.amazonTargetId
  ));
  const archivedCampaigns = keyword.campaigns.filter(campaign => campaign.lifecycleStatus === "STOPPED");
  const activeCampaigns = keyword.campaigns.filter(campaign => campaign.lifecycleStatus !== "STOPPED");
  const creationComplete = activeCampaigns.length > 0 && activeCampaigns.every(campaign =>
    campaign.creationStatus === "COMPLETE" && Boolean(campaign.amazonCampaignId) && campaign.units.length > 0 &&
    campaign.units.every(unit => unit.creationStatus === "COMPLETE" && unit.amazonAdGroupId && unit.amazonProductAdId && unit.amazonTargetId)
  );
  const keywordCanOperate = keyword.lifecycleStatus === "ACTIVE";
  const keywordStateAction = activeCampaigns.some(campaign => campaign.desiredState === "ENABLED") ? "PAUSED" : "ENABLED";
  const stoppedAt = keyword.stoppedAt || archivedCampaigns.map(campaign => campaign.stoppedAt).filter(Boolean).sort().at(-1) || "";
  const keywordStatus = keyword.lifecycleStatus === "STOPPED"
    ? `<span class="ads-object-state archived">已停止</span>`
    : keyword.lifecycleStatus === "STOPPING"
      ? `<span class="ads-object-state draft">停止中</span>`
      : creationComplete
        ? `<span class="ads-object-state ${keywordStateAction === "PAUSED" ? "ready" : "draft"}">${keywordStateAction === "PAUSED" ? "已开始" : "已暂停"}</span>`
        : "";
  panel.innerHTML = `
    <div class="ads-detail-head">
      <div class="ads-detail-identity"><span>${escapeHtml(keyword.parentAsin)}</span><div class="ads-detail-title-row"><strong>${escapeHtml(keyword.keyword)}</strong><div class="ads-inline-group"><span>运营分组</span>${keyword.lifecycleStatus === "ACTIVE" ? renderAdsGroupPicker(keyword) : `<span class="ads-group-badge ${keyword.group.toLowerCase()}">${adsGroupLabel(keyword.group)}</span>`}</div>${keywordStatus}</div>${renderAdsDetailProducts(keyword)}</div>
      <div class="ads-detail-actions">
        ${keyword.lifecycleStatus === "STOPPED" ? `<span class="ads-stop-time">停止时间：${escapeHtml(adsStopTimeLabel(stoppedAt))}</span>` : ""}
        ${!creationComplete && keyword.lifecycleStatus !== "STOPPED" && keyword.lifecycleStatus !== "STOPPING" ? `${canDiscardPlan ? `<button class="danger" type="button" data-discard-ads-plan="${keyword.id}">关闭创建计划</button>` : ""}<button class="primary" type="button" data-preview-keyword="${keyword.id}">${canDiscardPlan ? "预览并创建" : "预览并续传"}</button>` : ""}
        ${keyword.monitoring?.length ? `<button type="button" class="secondary-button ${keyword.monitorStatus === "ACTIVE" ? "ads-monitor-remove" : "ads-monitor-add"}" data-ads-keyword-monitoring="${keyword.id}" data-monitoring-action="${keyword.monitorStatus === "ACTIVE" ? "remove" : "add"}">${keyword.monitorStatus === "ACTIVE" ? "从关键词监控移除" : "加入关键词监控"}</button>` : ""}
        ${keywordCanOperate && activeCampaigns.length ? `<button type="button" data-ads-keyword-state="${keyword.id}" data-next-state="${keywordStateAction}">${keywordStateAction === "PAUSED" ? "暂停" : "开始"}</button><button class="danger" type="button" data-ads-keyword-stop="${keyword.id}">停止</button>` : ""}
      </div>
    </div>
    <div class="ads-detail-summary">
      <div><span>花费</span><strong>${asMoney(keyword.metrics.spend, currency)}</strong></div>
      <div><span>销售额</span><strong>${asMoney(keyword.metrics.sales, currency)}</strong></div>
      <div><span>订单</span><strong>${formatNumber(keyword.metrics.orders)}</strong></div>
      <div><span>ACOS</span><strong>${adsPercent(keyword.metrics.acos)}</strong></div>
    </div>
    ${creationComplete ? renderAdsHistoryPanel(keyword) : ""}
    ${creationComplete ? `<details class="ads-object-details" open><summary>投放对象与启停管理</summary>` : ""}
    <div class="ads-campaign-stack ${creationComplete ? "compact" : ""}">
      ${["EXACT", "PHRASE", "BROAD"].map(matchType => {
        const campaigns = adsCampaignsFor(keyword, matchType);
        if (!campaigns.length) return `<article class="ads-campaign-card empty"><div><strong>${adsMatchLabel(matchType)}</strong><span>尚未添加</span></div>${keyword.lifecycleStatus === "STOPPED" ? "" : `<button type="button" data-add-ads-match="${matchType}" data-keyword-id="${keyword.id}">添加</button>`}</article>`;
        return campaigns.map(campaign => renderAdsCampaignCard(keyword, campaign, currency)).join("");
      }).join("")}
    </div>${creationComplete ? `</details>` : ""}
    ${archivedCampaigns.length ? `<details class="ads-object-details ads-archived-object-details"><summary>已停止投放对象（${archivedCampaigns.length}）</summary><div class="ads-campaign-stack compact">${archivedCampaigns.map(campaign => `<article class="ads-campaign-card archived"><header><div><strong>${adsMatchLabel(campaign.matchType)}</strong><span>${escapeHtml(campaign.name)}</span></div><span class="ads-object-state archived">已停止</span></header><div class="ads-archived-campaign-note">该 Campaign 已暂停，并从当前投放管理中隐藏。</div></article>`).join("")}</div></details>` : ""}`;
  if (creationComplete) queueMicrotask(() => {
    loadAdsKeywordHistory(keyword.id);
    loadAdsAiKeywordState(keyword.id);
  });
}

function adsHistorySeriesPath(points, metricKey, bounds, maxValue) {
  if (!points.length || !(maxValue >= 0)) return "";
  const denominator = Math.max(1, points.length - 1);
  return points.map((point, index) => {
    const value = point[metricKey];
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
    const x = bounds.left + (index / denominator) * bounds.width;
    const ratio = Number(value) / Math.max(maxValue, 1e-9);
    const y = ADS_HISTORY_METRICS[metricKey]?.unit === "rank"
      ? bounds.top + ratio * bounds.height
      : bounds.top + bounds.height - ratio * bounds.height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).filter(Boolean).join(" ");
}

function renderAdsHistoryChart(data) {
  const chart = $("#adsHistoryChart");
  if (!chart || currentAdsKeyword()?.id !== data.keyword.id) return;
  const points = Array.isArray(data.points) ? data.points : [];
  const metricA = adsHistoryState.metricA;
  const metricB = adsHistoryState.metricB;
  const configA = ADS_HISTORY_METRICS[metricA];
  const configB = ADS_HISTORY_METRICS[metricB];
  const numericA = points.map(point => point[metricA]).filter(value => value !== null && Number.isFinite(Number(value))).map(Number);
  const numericB = points.map(point => point[metricB]).filter(value => value !== null && Number.isFinite(Number(value))).map(Number);
  const maxA = Math.max(0, ...numericA);
  const maxB = Math.max(0, ...numericB);
  const bounds = { left: 66, top: 24, width: 688, height: 226 };
  const pathA = adsHistorySeriesPath(points, metricA, bounds, maxA || 1);
  const pathB = adsHistorySeriesPath(points, metricB, bounds, maxB || 1);
  const currency = adsWorkspace.profile?.currencyCode || "USD";
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const xIndexes = [...new Set([0, Math.round((points.length - 1) * 0.25), Math.round((points.length - 1) * 0.5), Math.round((points.length - 1) * 0.75), points.length - 1])].filter(index => index >= 0);
  chart.innerHTML = `<div class="ads-history-legend"><span><i class="primary"></i>${escapeHtml(configA.label)}</span><span><i class="secondary"></i>${escapeHtml(configB.label)}</span></div>
    <svg class="ads-history-svg" viewBox="0 0 820 290" role="img" aria-label="关键词历史数据折线图">
      ${ticks.map(ratio => {
        const y = bounds.top + bounds.height - ratio * bounds.height;
        return `<line x1="${bounds.left}" y1="${y}" x2="${bounds.left + bounds.width}" y2="${y}" class="ads-chart-grid"></line>
          <text x="${bounds.left - 8}" y="${y + 4}" text-anchor="end" class="ads-chart-axis primary">${escapeHtml(formatAdsHistoryValue(maxA * (configA.unit === "rank" ? 1 - ratio : ratio), metricA, currency))}</text>
          <text x="${bounds.left + bounds.width + 8}" y="${y + 4}" class="ads-chart-axis secondary">${escapeHtml(formatAdsHistoryValue(maxB * (configB.unit === "rank" ? 1 - ratio : ratio), metricB, currency))}</text>`;
      }).join("")}
      ${xIndexes.map(index => {
        const x = bounds.left + (index / Math.max(1, points.length - 1)) * bounds.width;
        return `<text x="${x}" y="${bounds.top + bounds.height + 24}" text-anchor="middle" class="ads-chart-date">${escapeHtml(points[index]?.date?.slice(5) || "")}</text>`;
      }).join("")}
      ${pathA ? `<polyline points="${pathA}" class="ads-chart-line primary"></polyline>` : ""}
      ${pathB ? `<polyline points="${pathB}" class="ads-chart-line secondary"></polyline>` : ""}
      ${points.map((point, index) => {
        const x = bounds.left + (index / Math.max(1, points.length - 1)) * bounds.width;
        const circles = [];
        for (const [key, value, max, className] of [[metricA, point[metricA], maxA || 1, "primary"], [metricB, point[metricB], maxB || 1, "secondary"]]) {
          if (value === null || value === undefined || !Number.isFinite(Number(value))) continue;
          const ratio = Number(value) / Math.max(max, 1e-9);
          const y = ADS_HISTORY_METRICS[key]?.unit === "rank" ? bounds.top + ratio * bounds.height : bounds.top + bounds.height - ratio * bounds.height;
          circles.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.6" class="ads-chart-point ${className}"><title>${escapeHtml(point.date)} · ${escapeHtml(ADS_HISTORY_METRICS[key].label)} ${escapeHtml(formatAdsHistoryValue(value, key, currency))}</title></circle>`);
        }
        return circles.join("");
      }).join("")}
    </svg>
    ${!numericA.length && !numericB.length ? `<div class="ads-history-empty">所选时间范围还没有数据，请先同步广告表现。</div>` : ""}`;
}

async function loadAdsKeywordHistory(keywordId) {
  const chart = $("#adsHistoryChart");
  if (!chart || !keywordId) return;
  if (!isValidDateValue(adsHistoryState.startDate) || !isValidDateValue(adsHistoryState.endDate)) {
    chart.innerHTML = `<div class="ads-inline-error">请选择完整的开始和结束日期</div>`;
    return;
  }
  adsHistoryState = {
    ...adsHistoryState,
    keywordId,
    childAsin: $("#adsHistoryAsin")?.value || "ALL",
    matchType: $("#adsHistoryMatch")?.value || "ALL",
    startDate: adsHistoryState.startDate || adsWorkspace.range?.startDate || "",
    endDate: adsHistoryState.endDate || adsWorkspace.range?.endDate || "",
    metricA: $("#adsHistoryMetricA")?.value || adsHistoryState.metricA,
    metricB: $("#adsHistoryMetricB")?.value || adsHistoryState.metricB
  };
  chart.innerHTML = `<div class="ads-history-loading">正在读取历史数据…</div>`;
  const query = new URLSearchParams({
    startDate: adsHistoryState.startDate,
    endDate: adsHistoryState.endDate,
    childAsin: adsHistoryState.childAsin,
    matchType: adsHistoryState.matchType
  });
  const requestSequence = ++adsHistoryRequestSequence;
  try {
    const data = await api(`/api/ads/keywords/${keywordId}/history?${query}`);
    if (requestSequence !== adsHistoryRequestSequence || currentAdsKeyword()?.id !== keywordId) return;
    renderAdsHistoryChart(data);
  } catch (error) {
    if (requestSequence === adsHistoryRequestSequence && chart.isConnected) chart.innerHTML = `<div class="ads-inline-error">${escapeHtml(error.message)}</div>`;
  }
}

function adsAiActionLabel(actionType) {
  return {
    CHANGE_BID: "调整竞价",
    CHANGE_PLACEMENT_ADJUSTMENT: "调整广告位置加价",
    CHANGE_DAILY_BUDGET: "调整日预算",
    PAUSE_CAMPAIGN: "暂停 Campaign",
    RESUME_CAMPAIGN: "恢复 Campaign",
    MOVE_GROUP: "调整运营分组",
    REQUEST_MORE_DATA: "需要更多数据"
  }[actionType] || actionType;
}

function adsAiStatusLabel(status) {
  return {
    PENDING: "待确认", EXECUTING: "执行中", EXECUTED: "已执行", FAILED: "执行失败",
    REJECTED: "已拒绝", ACKNOWLEDGED: "已确认", SUPERSEDED: "已被新分析取代"
  }[status] || status;
}

function adsAiRunStatusLabel(status) {
  return {
    RUNNING: "分析中", COMPLETE: "分析完成", FAILED: "分析失败"
  }[status] || status;
}

function adsAiSettingSummary(value = {}, currency = "USD") {
  const labels = {
    bid: "竞价", dailyBudget: "日预算", topOfSearchAdjustment: "顶部搜索",
    restOfSearchAdjustment: "其余搜索", productPageAdjustment: "商品页面", state: "状态", group: "分组"
  };
  return Object.entries(value).filter(([, item]) => item !== undefined && item !== null).map(([key, item]) => {
    let shown = item;
    if (["bid", "dailyBudget"].includes(key) && Number.isFinite(Number(item))) shown = asMoney(Number(item), currency);
    if (["topOfSearchAdjustment", "restOfSearchAdjustment", "productPageAdjustment"].includes(key)) shown = `${item}%`;
    if (key === "group") shown = adsGroupLabel(String(item));
    if (key === "state") shown = adsStateLabel(String(item));
    return `${labels[key] || key} ${shown}`;
  }).join(" · ") || "—";
}

function renderAdsAiRecommendation(item, currency) {
  const pending = item.status === "PENDING";
  const executable = item.actionType !== "REQUEST_MORE_DATA";
  const needsAcknowledgement = item.actionType === "REQUEST_MORE_DATA" || item.status === "FAILED";
  return `<article class="ads-ai-recommendation ${item.status.toLowerCase()}">
    <header><strong>${escapeHtml(adsAiActionLabel(item.actionType))}</strong><span>${escapeHtml(adsAiStatusLabel(item.status))}</span></header>
    ${executable ? `<div class="ads-ai-change"><span>${escapeHtml(adsAiSettingSummary(item.before, currency))}</span><b>→</b><strong>${escapeHtml(adsAiSettingSummary(item.after, currency))}</strong></div>` : ""}
    <p>${escapeHtml(item.reason)}</p>
    ${item.risk ? `<small>风险：${escapeHtml(item.risk)}</small>` : ""}
    <div class="ads-ai-recommendation-meta"><span>置信度 ${Math.round(Number(item.confidence || 0) * 100)}%</span><span>观察 ${item.observeDays} 天</span></div>
    ${item.error ? `<div class="ads-inline-error">${escapeHtml(item.error)}</div>` : ""}
    ${(pending || item.status === "FAILED") ? `<div class="ads-ai-recommendation-actions">${needsAcknowledgement ? `<button type="button" class="primary" data-ads-ai-ack="${item.id}">我已知晓</button>` : `<button type="button" class="secondary-button" data-ads-ai-reject="${item.id}">拒绝</button>${executable ? `<button type="button" class="primary" data-ads-ai-execute="${item.id}">确认并执行</button>` : ""}`}</div>` : ""}
  </article>`;
}

function renderAdsAiKeywordState(data) {
  if (!data || currentAdsKeyword()?.id !== data.keyword?.id) return;
  const previousRunStatus = adsAiState?.latestRun?.status;
  adsAiState = data;
  if (adsAiPollTimer) {
    clearTimeout(adsAiPollTimer);
    adsAiPollTimer = null;
  }
  const connectionStatus = $("#adsAiConnectionStatus");
  if (connectionStatus) connectionStatus.textContent = data.configured ? "已连接" : "未配置";
  const goal = $("#adsAiGoal");
  if (goal && document.activeElement !== goal) goal.value = data.goal?.text || "";
  const run = data.latestRun;
  const output = run?.output;
  const analysisStatus = $("#adsAiAnalysisStatus");
  const analysisContent = $("#adsAiAnalysisContent");
  if (analysisStatus) analysisStatus.textContent = run ? (run.status === "COMPLETE" ? `规则 v${run.strategyVersion}` : adsAiRunStatusLabel(run.status)) : "尚未分析";
  if (analysisContent) {
    if (run?.status === "RUNNING") {
      analysisContent.innerHTML = `<i aria-hidden="true">⌁</i><p>后台正在分析中。你可以切换到其他关键词，稍后回来查看结果。</p>`;
    } else if (run?.status === "FAILED") {
      analysisContent.innerHTML = `<i aria-hidden="true">!</i><p>${escapeHtml(run.error || "AI 分析失败")}</p>`;
    } else if (output?.analysisSummary) {
      const signals = (output.signals || []).map(signal => `<li class="${escapeHtml(signal.severity)}">${escapeHtml(signal.summary)}</li>`).join("");
      analysisContent.innerHTML = `<i aria-hidden="true">⌁</i><div><p>${escapeHtml(output.analysisSummary)}</p>${signals ? `<ul>${signals}</ul>` : ""}</div>`;
    } else {
      analysisContent.innerHTML = `<i aria-hidden="true">⌁</i><p>${data.configured ? "设置关键词目标后，点击“开始 AI 分析”。" : "请先在服务端配置 OPENAI_API_KEY 后再运行分析。"}</p>`;
    }
  }
  if (output?.analysisSummary) {
    const listKeyword = adsWorkspace.keywords.find(item => String(item.id) === String(data.keyword.id));
    if (listKeyword) {
      listKeyword.aiGoalSet = true;
      listKeyword.aiAnalysisSummary = String(output.analysisSummary).trim().slice(0, 240);
      const latestAction = (data.recommendations || []).find(item => item.actionType && item.actionType !== "NO_ACTION");
      listKeyword.aiSuggestionAction = latestAction?.actionType || "";
      listKeyword.aiSuggestionReason = latestAction?.reason || "";
      renderAdsKeywordRows();
    }
  }
  const pending = (data.recommendations || []).filter(item => item.status === "PENDING" && item.actionType !== "REQUEST_MORE_DATA");
  const visible = (data.recommendations || []).filter(item => ["PENDING", "EXECUTING", "EXECUTED", "FAILED", "REJECTED", "ACKNOWLEDGED"].includes(item.status)).slice(0, 1);
  const count = $("#adsAiRecommendationCount");
  if (count) count.textContent = pending.length ? `${pending.length} 条待处理` : "暂无待处理";
  const analyzeButton = $("[data-ads-ai-analyze]");
  if (analyzeButton) analyzeButton.disabled = run?.status === "RUNNING";
  const container = $("#adsAiRecommendations");
  if (container) container.innerHTML = visible.length
    ? visible.map(item => renderAdsAiRecommendation(item, adsWorkspace.profile?.currencyCode || "USD")).join("")
    : `<div class="ads-ai-action-empty"><strong>暂无 AI 建议</strong><p>只有通过 JSON 校验并符合安全边界的建议才会显示。</p></div>`;
  if (run?.status === "RUNNING") {
    const watchedKeywordId = data.keyword.id;
    adsAiPollTimer = setTimeout(() => {
      if (currentAdsKeyword()?.id === watchedKeywordId) loadAdsAiKeywordState(watchedKeywordId);
    }, 5000);
  } else if (run?.status === "COMPLETE" && previousRunStatus === "RUNNING") {
    setTimeout(() => loadAdsWorkspace().catch(() => {}), 0);
  }
}

async function loadAdsAiKeywordState(keywordId) {
  const panel = $("#adsAiPanel");
  if (!panel || !keywordId) return;
  try {
    const data = await api(`/api/ads/keywords/${keywordId}/ai`);
    renderAdsAiKeywordState(data);
  } catch (error) {
    if (currentAdsKeyword()?.id !== keywordId) return;
    const status = $("#adsAiAnalysisStatus");
    const content = $("#adsAiAnalysisContent");
    if (status) status.textContent = "读取失败";
    if (content) content.innerHTML = `<i aria-hidden="true">!</i><p>${escapeHtml(error.message)}</p>`;
  }
}

async function saveAdsAiGoal(keywordId, button) {
  const goalText = $("#adsAiGoal")?.value || "";
  setBusy(button, true, "保存中");
  try {
    await api(`/api/ads/keywords/${keywordId}/ai`, { method: "PUT", body: { goalText, constraints: {} } });
    await loadAdsWorkspace();
  } finally {
    setBusy(button, false, "保存目标");
  }
}

async function analyzeAdsKeyword(keywordId, button) {
  const goalText = $("#adsAiGoal")?.value || "";
  setBusy(button, true, "分析中");
  const status = $("#adsAiAnalysisStatus");
  if (status) status.textContent = "分析中";
  try {
    await api(`/api/ads/keywords/${keywordId}/ai`, { method: "PUT", body: { goalText, constraints: {} } });
    const data = await api(`/api/ads/keywords/${keywordId}/ai/analyze`, { method: "POST", body: {} });
    renderAdsAiKeywordState(data);
    await loadAdsWorkspace();
  } finally {
    setBusy(button, false, "开始 AI 分析");
    if (adsAiState?.latestRun?.status === "RUNNING") button.disabled = true;
  }
}

function renderAdsAiStrategyForm(strategy) {
  const rules = strategy.rules;
  const limits = rules.globalLimits;
  const rawSchedule = rules.schedule || {};
  const rawApprovalMode = String(rawSchedule.approvalMode || "").toUpperCase();
  const schedule = {
    dailyBatchEnabled: rawSchedule.dailyBatchEnabled === true,
    dailyBatchTime: rawSchedule.dailyBatchTime || "09:00",
    approvalMode: ["MANUAL", "RISK_ONLY", "AUTO_ALL"].includes(rawApprovalMode) ? rawApprovalMode : "MANUAL"
  };
  const groupSection = group => `<section class="ads-ai-strategy-section"><div><strong>${escapeHtml(rules.groups[group].title)}</strong><span>${escapeHtml(rules.groups[group].objective)}</span></div><label>策略规则<textarea data-ads-ai-group-rules="${group}" rows="5">${escapeHtml(rules.groups[group].rulesText)}</textarea></label></section>`;
  $("#adsAiStrategyBody").innerHTML = `<div class="ads-ai-strategy-form">
    <section class="ads-ai-strategy-section"><div><strong>全局分析规则</strong><span>这些说明会和每次分析数据一起发送给 AI</span></div><label>总规则<textarea id="adsAiGeneralRules" rows="5">${escapeHtml(rules.generalText)}</textarea></label></section>
    <section class="ads-ai-strategy-section"><div><strong>安全边界</strong><span>服务端会再次校验；AI 不能突破这些限制</span></div><div class="ads-ai-limit-grid">
      <label>分析窗口（天）<input data-ads-ai-limit="analysisWindowDays" type="number" min="7" max="90" value="${limits.analysisWindowDays}"></label>
      <label title="仅带入压缩摘要：每个关键词最多 3 次分析、每次最多 1 条建议；填 0 则不带入。">带入近期 AI 记录（天）<small>0 = 不带入；每词最多 3 次压缩分析和 1 条建议</small><input data-ads-ai-limit="recentAiHistoryDays" type="number" min="0" max="30" step="1" value="${limits.recentAiHistoryDays ?? 7}"></label>
      <label>最短观察期（天）<input data-ads-ai-limit="minObservationDays" type="number" min="1" max="30" value="${limits.minObservationDays}"></label>
      <label>最高竞价<input data-ads-ai-limit="maxBid" type="number" min="0.02" step="0.01" value="${limits.maxBid}"></label>
      <label>单次最多调价<input data-ads-ai-limit="maxBidChangeAmount" type="number" min="0.01" step="0.01" value="${limits.maxBidChangeAmount}"></label>
      <label>单次调价比例上限<input data-ads-ai-limit="maxBidChangePercent" type="number" min="0.01" step="0.01" value="${limits.maxBidChangePercent}"></label>
      <label>最高日预算<input data-ads-ai-limit="maxDailyBudget" type="number" min="1" step="1" value="${limits.maxDailyBudget}"></label>
      <label>预算调整比例上限<input data-ads-ai-limit="maxDailyBudgetChangePercent" type="number" min="0.01" step="0.01" value="${limits.maxDailyBudgetChangePercent}"></label>
      <label>最高位置加价 %<input data-ads-ai-limit="maxPlacementAdjustment" type="number" min="0" max="900" step="1" value="${limits.maxPlacementAdjustment}"></label>
      <label>库存安全线（天）<input data-ads-ai-limit="inventorySafetyDays" type="number" min="0" max="365" step="1" value="${limits.inventorySafetyDays}"></label>
    </div></section>
    <section class="ads-ai-strategy-section"><div><strong>每日批量分析</strong><span>统一按北京时间，用一次后台批量任务分析所有填写了调整目标的关键词。</span></div><div class="ads-ai-schedule-fields"><label class="ads-ai-schedule-enabled"><input id="adsAiDailyBatchEnabled" type="checkbox" ${schedule.dailyBatchEnabled ? "checked" : ""}> 每天自动分析</label><label>执行时间（北京时间）<input id="adsAiDailyBatchTime" type="time" value="${escapeHtml(schedule.dailyBatchTime)}"></label></div><div class="ads-ai-approval-setting"><strong>处理建议行动</strong><span>AI 只负责判断；服务端会按此模式决定是否调用 Amazon Ads 执行接口。</span><div class="ads-ai-approval-options"><label class="${schedule.approvalMode === "MANUAL" ? "selected" : ""}"><input type="radio" name="adsAiApprovalMode" value="MANUAL" ${schedule.approvalMode === "MANUAL" ? "checked" : ""}><span class="ads-ai-approval-label"><strong>需要用户批准</strong><small>所有行动都需用户批准</small></span></label><label class="${schedule.approvalMode === "RISK_ONLY" ? "selected" : ""}"><input type="radio" name="adsAiApprovalMode" value="RISK_ONLY" ${schedule.approvalMode === "RISK_ONLY" ? "checked" : ""}><span class="ads-ai-approval-label"><strong>AI替用户审批</strong><small>仅竞价自动执行，风险操作请求批准</small></span></label><label class="${schedule.approvalMode === "AUTO_ALL" ? "selected" : ""}"><input type="radio" name="adsAiApprovalMode" value="AUTO_ALL" ${schedule.approvalMode === "AUTO_ALL" ? "checked" : ""}><span class="ads-ai-approval-label"><strong>自动批准执行</strong><small>自动执行所有通过安全边界的行动</small></span></label></div></div></section>
    ${groupSection("NORMAL")}${groupSection("PROMOTED")}${groupSection("STABLE")}
  </div>`;
  $("#adsAiStrategyVersion").textContent = "";
}

async function openAdsAiStrategyDialog() {
  const dialog = $("#adsAiStrategyDialog");
  $("#adsAiStrategyBody").innerHTML = `<div class="ads-history-loading">正在读取策略规则…</div>`;
  dialog.showModal();
  const data = await api("/api/ads/ai/strategy");
  renderAdsAiStrategyForm(data.strategy);
}

function adsAiHistoryRunStatus(status) {
  return { RUNNING: "分析中", COMPLETE: "分析完成", FAILED: "分析失败" }[status] || status || "未知";
}

function adsAiModelLabel(model) {
  return String(model || "") === "RULE_ENGINE" ? "规则预判" : String(model || "");
}

function renderAdsAiHistory(data) {
  const body = $("#adsAiHistoryBody");
  $("#adsAiHistorySubtitle").textContent = `${data.keyword?.text || "关键词"} · 每次分析均可回看当时输入快照`;
  if (!data.runs?.length) {
    body.innerHTML = `<div class="ads-empty-inline"><strong>暂无分析历史</strong><span>完成第一次 AI 分析后会显示在这里。</span></div>`;
    return;
  }
  const rows = data.runs.map(run => {
    const goalText = run.goal?.text || "当时未设置调整目标";
    const contextMeta = [run.context?.group ? `分组 ${adsGroupLabel(run.context.group)}` : "", run.context?.dataCutoff ? `数据截止 ${run.context.dataCutoff}` : "", run.context?.analysisWindowDays ? `分析 ${run.context.analysisWindowDays} 天` : ""].filter(Boolean).join(" · ");
    const signals = (run.signals || []).slice(0, 5).map(signal => `<li class="${escapeHtml(signal.severity || "info")}">${escapeHtml(signal.summary || "")}</li>`).join("");
    const analysis = run.analysisSummary
      ? `<p>${escapeHtml(run.analysisSummary)}</p>${signals ? `<ul>${signals}</ul>` : ""}`
      : `<p class="ads-ai-history-muted">${escapeHtml(run.error || (run.status === "RUNNING" ? "分析仍在进行中" : "本次分析没有可展示的总结"))}</p>`;
    const recommendations = (run.recommendations || []).length
      ? run.recommendations.map(item => `<div class="ads-ai-history-recommendation"><strong>${escapeHtml(adsAiActionLabel(item.actionType))}</strong><span class="ads-ai-history-action-status">${escapeHtml(adsAiStatusLabel(item.status))}</span><p>${escapeHtml(item.reason || "")}</p>${item.error ? `<small>错误：${escapeHtml(item.error)}</small>` : ""}</div>`).join("")
      : `<p class="ads-ai-history-muted">本次没有建议行动</p>`;
    return `<tbody class="ads-ai-history-run">
      <tr>
        <td rowspan="3" class="ads-ai-history-time"><strong>${escapeHtml(formatDate(run.startedAt || run.createdAt))}</strong><span>${escapeHtml(adsAiModelLabel(run.model))}</span><button type="button" data-ads-ai-snapshot="${escapeHtml(run.id)}" ${run.snapshotAvailable ? "" : "disabled"}>查看当时快照</button></td>
        <td><div class="ads-ai-history-cell"><strong>调整目标与建议</strong><p>${escapeHtml(goalText)}</p>${contextMeta ? `<small>${escapeHtml(contextMeta)}</small>` : ""}</div></td>
        <td rowspan="3" class="ads-ai-history-status"><span class="${String(run.status || "").toLowerCase()}">${escapeHtml(adsAiHistoryRunStatus(run.status))}</span>${run.completedAt ? `<small>${escapeHtml(formatDate(run.completedAt))}</small>` : ""}</td>
      </tr>
      <tr><td><div class="ads-ai-history-cell"><strong>AI 分析</strong>${analysis}</div></td></tr>
      <tr><td><div class="ads-ai-history-cell"><strong>建议行动</strong>${recommendations}</div></td></tr>
    </tbody>`;
  }).join("");
  body.innerHTML = `<div class="ads-ai-history-table-wrap"><table class="ads-ai-history-table"><thead><tr><th>分析时间</th><th>分析内容</th><th>状态</th></tr></thead>${rows}</table></div><section id="adsAiHistorySnapshot" class="ads-ai-history-snapshot" hidden></section>`;
}

async function openAdsAiHistoryDialog(keywordId) {
  const dialog = $("#adsAiHistoryDialog");
  $("#adsAiHistoryBody").innerHTML = `<div class="ads-history-loading">正在读取分析历史…</div>`;
  dialog.showModal();
  const data = await api(`/api/ads/keywords/${keywordId}/ai/history?limit=30`);
  if (!dialog.open || currentAdsKeyword()?.id !== keywordId) return;
  renderAdsAiHistory(data);
}

function renderAdsAiSnapshot(data) {
  const input = data.input || {};
  const context = input.context || {};
  const state = input.currentState || {};
  const currency = context.currency || adsWorkspace.profile?.currencyCode || "USD";
  const summary = input.performanceSummary?.last30Days || {};
  const campaigns = state.campaigns || [];
  const units = state.adUnits || [];
  const inventory = state.inventory || {};
  const snapshot = $("#adsAiHistorySnapshot");
  if (!snapshot) return;
  snapshot.hidden = false;
  snapshot.innerHTML = `<div class="ads-ai-snapshot-head"><div><strong>当时输入快照</strong><span>${escapeHtml(data.run?.keyword || "")} · 数据截止 ${escapeHtml(context.dataCutoff || "-")}</span></div><button type="button" data-close-ads-ai-snapshot>收起</button></div>
    <div class="ads-ai-snapshot-metrics">
      <div><span>曝光</span><strong>${formatNumber(summary.impressions || 0)}</strong></div><div><span>点击</span><strong>${formatNumber(summary.clicks || 0)}</strong></div><div><span>订单</span><strong>${formatNumber(summary.orders || 0)}</strong></div><div><span>花费</span><strong>${asMoney(summary.spend || 0, currency)}</strong></div><div><span>销售额</span><strong>${asMoney(summary.sales || 0, currency)}</strong></div><div><span>ACOS</span><strong>${adsPercent(summary.acos)}</strong></div>
    </div>
    <div class="ads-ai-snapshot-grid"><section><strong>当时 Campaign 设置</strong>${campaigns.length ? `<div class="ads-ai-snapshot-table-wrap"><table><thead><tr><th>匹配</th><th>预算</th><th>顶部</th><th>其余</th><th>商品页</th><th>状态</th></tr></thead><tbody>${campaigns.map(item => `<tr><td>${escapeHtml(adsMatchLabel(item.matchType))}</td><td>${asMoney(item.dailyBudget, currency)}</td><td>${formatNumber(item.topOfSearchAdjustment)}%</td><td>${formatNumber(item.restOfSearchAdjustment)}%</td><td>${formatNumber(item.productPageAdjustment)}%</td><td>${escapeHtml(adsStateLabel(item.state))}</td></tr>`).join("")}</tbody></table></div>` : `<p>无 Campaign 数据</p>`}</section>
      <section><strong>当时出价与库存</strong>${units.length ? `<div class="ads-ai-snapshot-table-wrap"><table><thead><tr><th>子 ASIN</th><th>匹配对象</th><th>出价</th><th>状态</th></tr></thead><tbody>${units.map(item => `<tr><td>${escapeHtml(item.childAsin || "-")}</td><td>${escapeHtml(item.sellerSku || "-")}</td><td>${asMoney(item.bid, currency)}</td><td>${escapeHtml(adsStateLabel(item.state))}</td></tr>`).join("")}</tbody></table></div>` : `<p>无投放单元数据</p>`}<small>库存状态：${escapeHtml(inventory.status || "未知")} · 安全线 ${formatNumber(inventory.safetyDays || 0)} 天</small></section></div>
    <details class="ads-ai-snapshot-raw"><summary>查看完整 JSON 快照</summary><pre>${escapeHtml(JSON.stringify(input, null, 2))}</pre></details>`;
  snapshot.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function loadAdsAiSnapshot(runId, button) {
  setBusy(button, true, "读取中");
  try {
    renderAdsAiSnapshot(await api(`/api/ads/ai/runs/${encodeURIComponent(runId)}`));
  } finally {
    setBusy(button, false, "查看当时快照");
  }
}

async function saveAdsAiStrategy(button) {
  const globalLimits = {};
  document.querySelectorAll("[data-ads-ai-limit]").forEach(input => { globalLimits[input.dataset.adsAiLimit] = Number(input.value); });
  const groups = {};
  document.querySelectorAll("[data-ads-ai-group-rules]").forEach(textarea => {
    const current = adsAiState?.strategy?.rules?.groups?.[textarea.dataset.adsAiGroupRules] || {};
    groups[textarea.dataset.adsAiGroupRules] = { ...current, rulesText: textarea.value };
  });
  setBusy(button, true, "保存中");
  try {
    const approvalMode = $("#adsAiStrategyBody").querySelector("input[name=adsAiApprovalMode]:checked")?.value || "MANUAL";
    const schedule = {
      dailyBatchEnabled: Boolean($("#adsAiDailyBatchEnabled")?.checked),
      dailyBatchTime: $("#adsAiDailyBatchTime")?.value || "09:00",
      approvalMode
    };
    const data = await api("/api/ads/ai/strategy", { method: "PUT", body: { rules: { generalText: $("#adsAiGeneralRules")?.value || "", globalLimits, schedule, groups } } });
    if (adsAiState) adsAiState.strategy = data.strategy;
    $("#adsAiStrategyDialog")?.close();
    if (selectedAdsKeywordId) await loadAdsAiKeywordState(selectedAdsKeywordId);
  } finally {
    setBusy(button, false, "确认");
  }
}

function renderAdsWorkspace() {
  renderAdsPortfolioGuard();
  renderAdsProductTabs();
  document.querySelectorAll(".ads-group-filter").forEach(button => button.classList.toggle("active", button.dataset.adsGroup === selectedAdsGroup));
  renderAdsKeywordRows();
  renderAdsDetail();
}

async function loadAdsWorkspace(options = {}) {
  if (!selectedAdsProfileId) return;
  if (options.refreshPortfolio) {
    const result = await api("/api/ads/managed-portfolio?refresh=1");
    adsWorkspace.portfolio = result.portfolio;
  }
  const startDate = $("#adsStartDate")?.value || "";
  const endDate = $("#adsEndDate")?.value || "";
  const query = new URLSearchParams({ ...(startDate ? { startDate } : {}), ...(endDate ? { endDate } : {}) });
  const [workspaceData, templateData] = await Promise.all([
    api(`/api/ads/workspace${query.toString() ? `?${query}` : ""}`),
    api("/api/ads/template")
  ]);
  adsWorkspace = { ...workspaceData, portfolio: adsWorkspace.portfolio || workspaceData.portfolio };
  adsCreationTemplate = templateData.template;
  if (workspaceData.range) {
    if ($("#adsStartDate") && !$("#adsStartDate").value) $("#adsStartDate").value = workspaceData.range.startDate;
    if ($("#adsEndDate") && !$("#adsEndDate").value) $("#adsEndDate").value = workspaceData.range.endDate;
    updateAdsDateRangeInput();
  }
  renderAdsWorkspace();
}

function adsKeywordFormRow(value = "", group = "NORMAL", removable = false) {
  const labels = removable
    ? { keyword: "", group: "" }
    : { keyword: "关键词", group: "运营分组" };
  return `<div class="ads-keyword-form-row ${removable ? "compact" : ""}"><label aria-label="关键词">${labels.keyword}<input class="ads-form-keyword" required maxlength="255" value="${escapeHtml(value)}" placeholder="例如 wall organizer"></label><label aria-label="运营分组">${labels.group}<select class="ads-form-keyword-group"><option value="NORMAL" ${group === "NORMAL" ? "selected" : ""}>普通</option><option value="PROMOTED" ${group === "PROMOTED" ? "selected" : ""}>主推</option><option value="STABLE" ${group === "STABLE" ? "selected" : ""}>已稳定</option></select></label>${removable ? `<button type="button" class="secondary-button ads-remove-keyword-row" aria-label="移除此关键词">−</button>` : `<span class="ads-keyword-row-spacer"></span>`}</div>`;
}

function renderAdsKeywordForm(parentAsin = selectedAdsParentAsin) {
  const body = $("#adsKeywordFormBody");
  const template = adsCreationTemplate || { dailyBudget: 8, defaultBid: 0.2, topOfSearchAdjustment: 200, restOfSearchAdjustment: 0, productPageAdjustment: 0, matches: { EXACT: true } };
  const selectedProduct = adsWorkspace.products.find(item => item.parentAsin === parentAsin) || adsWorkspace.products[0];
  if (!selectedProduct) {
    body.innerHTML = `<div class="ads-inline-error">FBA库存中没有可选商品</div>`;
    return;
  }
  const selectableChildren = selectedProduct.children;
  const recommended = selectableChildren[0];
  body.innerHTML = `
    <div class="ads-form-grid">
      <label class="full">父 ASIN / 内部名<select id="adsFormParentAsin">${adsWorkspace.products.map(product => `<option value="${escapeHtml(product.parentAsin)}" ${product.parentAsin === selectedProduct.parentAsin ? "selected" : ""}>${escapeHtml(product.internalName)} / ${escapeHtml(product.parentAsin)}</option>`).join("")}</select></label>
      <div class="ads-keyword-batch full"><div class="ads-keyword-batch-head"><span>关键词与运营分组</span><button type="button" class="secondary-button" data-add-ads-keyword-row>＋ 添加关键词</button></div><div id="adsKeywordInputRows">${adsKeywordFormRow()}</div></div>
      <div class="ads-placement-fields full"><label>Campaign 日预算<input id="adsFormBudget" type="number" min="0.01" step="0.01" value="${template.dailyBudget}"></label><label>默认出价<input id="adsFormBid" type="number" min="0.01" step="0.01" value="${template.defaultBid}"></label><label>顶部搜索加价 %<input id="adsFormTopAdjustment" type="number" min="0" max="900" step="1" value="${template.topOfSearchAdjustment}"></label><label>其余搜索加价 %<input id="adsFormRestAdjustment" type="number" min="0" max="900" step="1" value="${template.restOfSearchAdjustment || 0}"></label><label>商品页面加价 %<input id="adsFormProductAdjustment" type="number" min="0" max="900" step="1" value="${template.productPageAdjustment || 0}"></label></div>
    </div>
    <fieldset class="ads-form-section ads-match-section"><legend>匹配方式</legend><div class="ads-match-options">
      ${["EXACT", "PHRASE", "BROAD"].map(match => `<label><input type="checkbox" name="adsMatch" value="${match}" ${template.matches?.[match] ? "checked" : ""}><span class="ads-match-check" aria-hidden="true">✓</span><strong>${adsMatchLabel(match)}</strong></label>`).join("")}
    </div></fieldset>
    <fieldset class="ads-form-section ads-sku-section"><legend>选择投放商品（可多选）</legend><p class="ads-form-hint">每个“关键词 × 子 ASIN × 匹配方式”都会创建独立 Campaign；同一关键词不能重复投放到同一子 ASIN。</p><div class="ads-sku-options">
      ${selectableChildren.map(child => `<label class="ads-sku-card">
        <input class="ads-sku-checkbox" type="checkbox" name="adsSku" data-child-asin="${escapeHtml(child.asin)}" value="${escapeHtml(`${child.asin}|${child.sellerSku}`)}" ${child === recommended ? "checked" : ""}>
        <span class="ads-sku-visual">${child.imageUrl ? `<img src="${escapeHtml(child.imageUrl)}" alt="${escapeHtml(child.internalName || child.asin)}" loading="lazy">` : `<b>无图</b>`}</span>
        <span class="ads-sku-copy">
          <strong title="${escapeHtml(child.internalName || "未设置内部名")}">${escapeHtml(child.internalName || "未设置内部名")}</strong>
          <span class="ads-sku-identifiers"><small><b>ASIN</b>${escapeHtml(child.asin)}</small><small><b>SKU</b>${escapeHtml(child.sellerSku)}</small></span>
        </span>
        <span class="ads-sku-check" aria-hidden="true">✓</span>
      </label>`).join("")}
    </div></fieldset>`;
}

function openAdsKeywordDialog() {
  renderAdsKeywordForm();
  $("#adsKeywordDialog").showModal();
}

async function saveAdsKeywordDraft(event) {
  event.preventDefault();
  const units = [...document.querySelectorAll('input[name="adsSku"]:checked')].map(input => {
    const [childAsin, ...sellerSku] = input.value.split("|");
    return { childAsin, sellerSku: sellerSku.join("|") };
  });
  const matches = [...document.querySelectorAll('input[name="adsMatch"]:checked')].map(input => input.value);
  const keywords = [...document.querySelectorAll(".ads-keyword-form-row")].map(row => ({
    keyword: row.querySelector(".ads-form-keyword")?.value.trim() || "",
    group: row.querySelector(".ads-form-keyword-group")?.value || "NORMAL"
  }));
  if (!keywords.length || keywords.some(item => !item.keyword)) {
    alert("请填写每一行关键词");
    return;
  }
  if (!matches.length || !units.length) {
    alert("请至少选择一种匹配方式和一个投放商品");
    return;
  }
  const duplicateKeyword = keywords
    .map(item => item.keyword.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US"))
    .find((value, index, values) => values.indexOf(value) !== index);
  if (duplicateKeyword) {
    alert(`添加列表中有重复关键词：“${duplicateKeyword}”。请保留一行后再添加。`);
    return;
  }
  const campaignCount = keywords.length * units.length * matches.length;
  if (!confirm(`确认添加 ${keywords.length} 个关键词、${units.length} 个子 ASIN，并创建 ${campaignCount} 个 Campaign？\n\n每个关键词只对应一个子 ASIN；若某个子 ASIN 已有相同关键词，系统会拒绝重复添加。创建期间可在关键词详情查看“创建中”状态。`)) return;
  const button = $("#adsSaveKeywordBtn");
  setBusy(button, true, "添加中");
  try {
    const result = await api("/api/ads/keywords/create-now", { method: "POST", body: {
      parentAsin: $("#adsFormParentAsin").value, keywords,
      dailyBudget: $("#adsFormBudget").value, defaultBid: $("#adsFormBid").value, topOfSearchAdjustment: $("#adsFormTopAdjustment").value,
      restOfSearchAdjustment: $("#adsFormRestAdjustment").value, productPageAdjustment: $("#adsFormProductAdjustment").value,
      matches, units
    }});
    selectedAdsParentAsin = $("#adsFormParentAsin").value;
    selectedAdsKeywordId = result.keywordIds?.[0] || "";
    $("#adsKeywordDialog").close();
    await loadAdsWorkspace();
  } catch (error) {
    alert(error.message);
  } finally {
    setBusy(button, false, "添加");
  }
}

function renderAdsOperationPreview(data) {
  const preview = data.preview;
  const currency = preview.profile.currencyCode || "USD";
  const discardButton = $("#adsDiscardPlanPreviewBtn");
  if (discardButton) {
    discardButton.hidden = Boolean(preview.preserveExistingKeyword) || preview.campaigns.some(campaign => campaign.amazonCampaignId || campaign.adGroups.some(unit =>
      unit.amazonAdGroupId || unit.amazonProductAdId || unit.amazonTargetId
    ));
    discardButton.dataset.keywordId = preview.keyword.id;
  }
  $("#adsPreviewBody").innerHTML = `
    <div id="adsOperationStatus" class="ads-operation-status" data-status="PREVIEW"><strong>等待确认</strong><span>尚未调用 Amazon Ads 创建接口</span></div>
    <div class="ads-preview-warning"><strong>即将执行真实 Amazon Ads 创建</strong><span>请逐项核对；关闭窗口不会创建任何对象。</span></div>
    <div class="ads-preview-context">
      <div><span>Profile</span><strong>${escapeHtml(preview.profile.countryCode)} / ${escapeHtml(currency)} / ${escapeHtml(preview.profile.accountName)}</strong><small>${escapeHtml(preview.profile.profileId)}</small></div>
      <div><span>Portfolio</span><strong>${escapeHtml(preview.portfolio.name)}</strong><small>${preview.portfolio.action === "CREATE" ? "将创建新的 Portfolio" : `使用 ${escapeHtml(preview.portfolio.portfolioId)}`}</small></div>
      <div><span>父 ASIN</span><strong>${escapeHtml(preview.keyword.parentAsin)}</strong><small>${escapeHtml(preview.keyword.text)} · ${adsGroupLabel(preview.keyword.group)}${preview.keyword.creationBatch ? ` · TS ${escapeHtml(preview.keyword.creationBatch)}` : ""}</small></div>
    </div>
    <div class="ads-preview-object-list">
      ${preview.campaigns.map(campaign => `<article>
        <header><div><strong>${adsMatchLabel(campaign.matchType)} Campaign</strong><span>${escapeHtml(campaign.name)}</span></div><b>${campaign.action === "CREATE" ? "新建" : "续传"}</b></header>
        <div class="ads-preview-params"><span>预算 <strong>${asMoney(campaign.dailyBudget, currency)}</strong></span><span>顶部加价 <strong>${campaign.topOfSearchAdjustment}%</strong></span><span>其余搜索 <strong>${campaign.restOfSearchAdjustment || 0}%</strong></span><span>商品页面 <strong>${campaign.productPageAdjustment || 0}%</strong></span><span>状态 <strong>${adsStateLabel(campaign.state)}</strong></span><span>开始日期 <strong>${escapeHtml(campaign.startDate)}</strong></span></div>
        ${campaign.adGroups.map(unit => `<div class="ads-preview-unit"><div><strong>Ad Group</strong><span>${escapeHtml(unit.name)}</span></div><div><span>子 ASIN</span><b>${escapeHtml(unit.childAsin)}</b></div><div><span>Seller SKU</span><b>${escapeHtml(unit.sellerSku)}</b></div><div><span>Keyword Target</span><b>${escapeHtml(preview.keyword.text)} / ${campaign.matchType}</b></div><div><span>出价</span><b>${asMoney(unit.bid, currency)}</b></div></div>`).join("")}
      </article>`).join("")}
    </div>
    <div class="ads-preview-total">将处理 <strong>${preview.campaigns.length}</strong> 个 Campaign、<strong>${preview.campaigns.reduce((sum, item) => sum + item.adGroups.length, 0)}</strong> 个 Ad Group，并为每个投放单元创建或续传 Product Ad 与 Keyword Target。</div>`;
}

function renderAdsOperationStatus(status, message = "") {
  const node = $("#adsOperationStatus");
  if (!node) return;
  const normalized = String(status || "PREVIEW").toUpperCase();
  const labels = {
    PREVIEW: ["等待确认", "尚未调用 Amazon Ads 创建接口"],
    RUNNING: ["正在创建", "请求已经到达服务器，正在调用 Amazon Ads API，请勿重复操作"],
    COMPLETE: ["创建成功", "Amazon Ads 对象已经创建并记录到数据库"],
    FAILED: ["创建失败", "创建过程已停止，可根据错误继续处理"]
  };
  const [title, fallback] = labels[normalized] || [normalized, ""];
  node.dataset.status = normalized;
  node.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(message || fallback)}</span>`;
}

async function settleAdsOperationUi(operationId, fallbackError = "") {
  let statusData = null;
  try {
    statusData = await api(`/api/ads/operations/${operationId}`);
  } catch {
    // Keep the original error when the status endpoint is unavailable too.
  }
  const button = $("#adsConfirmOperationBtn");
  const status = String(statusData?.status || "FAILED").toUpperCase();
  if (status === "COMPLETE") {
    if ($("#adsPreviewDialog")?.open) $("#adsPreviewDialog").close();
    button.disabled = false;
    button.textContent = "我已核对，确认创建";
    pendingAdsOperation = null;
    await loadAdsWorkspace({ refreshPortfolio: true }).catch(() => {});
    return;
  }
  if (status === "RUNNING") {
    renderAdsOperationStatus("RUNNING");
    button.disabled = true;
    button.textContent = "创建中...";
    return;
  }
  const error = statusData?.error || fallbackError || (status === "PREVIEW" ? "确认请求没有到达创建流程，请检查网络后重试" : "创建失败");
  renderAdsOperationStatus("FAILED", error);
  button.disabled = false;
  button.textContent = status === "PREVIEW" ? "重新确认创建" : "重试未完成步骤";
}

async function previewAdsKeywordCreation(keywordId) {
  const data = await api("/api/ads/operations/preview", { method: "POST", body: { keywordId } });
  pendingAdsOperation = data;
  renderAdsOperationPreview(data);
  $("#adsPreviewDialog").showModal();
}

async function addAdsKeywordMatch(keywordId, matchType, button) {
  const label = adsMatchLabel(matchType);
  if (!confirm(`确认直接添加“${label}”匹配方式？\n\n系统会立即在后台创建对应的 Amazon Ads Campaign、Ad Group、Product Ad 与 Keyword Target。`)) return;
  setBusy(button, true, "创建中");
  try {
    const data = await api(`/api/ads/keywords/${keywordId}/matches`, { method: "POST", body: { matchType } });
    await loadAdsWorkspace();
    await api(`/api/ads/operations/${data.operationId}/start`, { method: "POST", body: { confirmationToken: data.confirmationToken } });
    await loadAdsWorkspace();
  } catch (error) {
    await loadAdsWorkspace().catch(() => {});
    throw error;
  } finally {
    setBusy(button, false, "添加");
  }
}

async function setAdsKeywordState(keywordId, nextState, button) {
  const action = nextState === "PAUSED" ? "暂停" : "开始";
  if (!confirm(`确认${action}该关键词下所有未停止的广告活动？`)) return;
  setBusy(button, true, `${action}中`);
  try {
    await api(`/api/ads/keywords/${keywordId}/state`, { method: "PUT", body: { state: nextState } });
    await loadAdsWorkspace();
  } catch (error) {
    alert(error.message);
  } finally {
    setBusy(button, false, action);
  }
}

async function stopAdsKeyword(keywordId, button) {
  if (!confirm("确认停止此关键词？\n\n系统会依次暂停其下所有广告 Campaign。期间状态会显示为“停止中”；仅全部暂停成功后，关键词才会进入左侧“停止”。此操作会更新 Amazon Ads。")) return;
  setBusy(button, true, "停止中");
  try {
    await api(`/api/ads/keywords/${keywordId}/stop`, { method: "POST" });
    selectedAdsGroup = "STOPPED";
    selectedAdsKeywordId = keywordId;
    await loadAdsWorkspace();
  } catch (error) {
    alert(`停止未完成：${error.message}`);
    await loadAdsWorkspace().catch(() => {});
  } finally {
    setBusy(button, false, "停止");
  }
}

async function confirmAdsOperation() {
  if (!pendingAdsOperation) return;
  const operationId = pendingAdsOperation.operationId;
  const button = $("#adsConfirmOperationBtn");
  setBusy(button, true, "我已核对，确认创建");
  renderAdsOperationStatus("RUNNING");
  try {
    await api(`/api/ads/operations/${operationId}/confirm`, {
      method: "POST",
      body: { confirmationToken: pendingAdsOperation.confirmationToken }
    });
    await settleAdsOperationUi(operationId);
  } catch (error) {
    await settleAdsOperationUi(operationId, error.message);
    await loadAdsWorkspace().catch(() => {});
  }
}

async function discardAdsCreationPlan(keywordId, button = null) {
  if (!keywordId) return;
  if (!confirm("确认关闭这个创建计划？\n\n只会删除尚未创建的本地草稿、Campaign、Ad Group 和预览记录，不会操作 Amazon Ads。")) return;
  if (button) setBusy(button, true, "关闭创建计划");
  try {
    await api(`/api/ads/keywords/${keywordId}`, { method: "DELETE" });
    if ($("#adsPreviewDialog")?.open) $("#adsPreviewDialog").close();
    pendingAdsOperation = null;
    selectedAdsKeywordId = "";
    await loadAdsWorkspace();
  } catch (error) {
    alert(error.message);
  } finally {
    if (button?.isConnected) setBusy(button, false, "关闭创建计划");
  }
}

async function syncAdsPerformance() {
  const button = $("#adsSyncBtn");
  setBusy(button, true, "同步广告数据");
  try {
    const result = await api("/api/ads/sync", { method: "POST", body: { startDate: $("#adsStartDate").value, endDate: $("#adsEndDate").value } });
    if (!result.jobs?.length) {
      alert(result.message || "没有需要同步的受管广告");
      return;
    }
    alert(`已提交 ${result.jobs.length} 个广告报表任务。任务会在后台完成并按日期覆盖保存。`);
  } catch (error) {
    alert(error.message);
  } finally {
    setBusy(button, false, "同步广告数据");
  }
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
  await loadFactoryInventory().catch(error => {
    $("#sandboxStatus").textContent = `工厂库存读取失败：${error.message}`;
  });
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
$("#queryProductsBtn").addEventListener("click", () => queryProducts().catch(error => alert(error.message)));
$("#syncProductsBtn").addEventListener("click", () => syncSandboxProducts().catch(error => alert(error.message)));
$("#fbaReplenishmentToggleBtn").addEventListener("click", async () => {
  fbaReplenishmentOpen = !fbaReplenishmentOpen;
  saveFbaReplenishmentSettings();
  if (fbaReplenishmentOpen && !factoryLoaded) {
    await loadFactoryInventory().catch(() => {});
  }
  renderProducts();
});
$("#adsAuthBtn").addEventListener("click", authorizeAds);
$("#adsRefreshBtn").addEventListener("click", () => refreshAds().catch(error => alert(error.message)));
$("#adsProfileSelect").addEventListener("change", event => selectAdsProfile(event.target.value).catch(error => alert(error.message)));
$("#adsDateRange").addEventListener("click", () => openAdsDatePicker());
$("#adsSyncBtn").addEventListener("click", syncAdsPerformance);
$("#adsAddKeywordBtn").addEventListener("click", openAdsKeywordDialog);
$("#saveSystemSchedulesBtn").addEventListener("click", event => saveSystemSchedules(event.currentTarget).catch(error => alert(error.message)));
$("#systemScheduleList").addEventListener("change", event => {
  const card = event.target.closest("[data-system-schedule]");
  if (card && event.target.matches("[data-system-schedule-enabled]")) card.classList.toggle("enabled", event.target.checked);
});
$("#systemScheduleList").addEventListener("click", event => {
  const runButton = event.target.closest("[data-system-schedule-run]");
  if (runButton) runSystemScheduleNow(runButton).catch(error => alert(error.message));
});
$("#adsKeywordSearch").addEventListener("input", renderAdsKeywordRows);
$("#adsKeywordForm").addEventListener("submit", saveAdsKeywordDraft);
$("#adsProductTabs").addEventListener("click", event => {
  const button = event.target.closest("[data-ads-parent]");
  if (!button) return;
  selectedAdsParentAsin = button.dataset.adsParent;
  selectedAdsKeywordId = "";
  renderAdsWorkspace();
});
$("#adsProductTabs").addEventListener("dragstart", event => {
  const button = event.target.closest("[data-ads-parent]");
  if (!button) return;
  draggedAdsParentAsin = button.dataset.adsParent || "";
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", draggedAdsParentAsin);
  button.classList.add("dragging");
});
$("#adsProductTabs").addEventListener("dragover", event => {
  const button = event.target.closest("[data-ads-parent]");
  if (!button || !draggedAdsParentAsin || button.dataset.adsParent === draggedAdsParentAsin) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  document.querySelectorAll(".ads-product-tab.drag-over").forEach(node => node.classList.remove("drag-over"));
  button.classList.add("drag-over");
});
$("#adsProductTabs").addEventListener("drop", event => {
  const button = event.target.closest("[data-ads-parent]");
  document.querySelectorAll(".ads-product-tab.drag-over").forEach(node => node.classList.remove("drag-over"));
  if (!button) return;
  event.preventDefault();
  moveAdsParentTab(button.dataset.adsParent || "");
});
$("#adsProductTabs").addEventListener("dragend", event => {
  event.target.closest("[data-ads-parent]")?.classList.remove("dragging");
  document.querySelectorAll(".ads-product-tab.drag-over").forEach(node => node.classList.remove("drag-over"));
  draggedAdsParentAsin = "";
});
document.querySelectorAll(".ads-group-filter").forEach(button => button.addEventListener("click", () => {
  selectedAdsGroup = button.dataset.adsGroup;
  renderAdsWorkspace();
}));
$("#adsKeywordRows").addEventListener("click", event => {
  if (event.target.closest(".ads-keyword-drag")) return;
  const row = event.target.closest("[data-ads-keyword-id]");
  if (!row) return;
  selectedAdsKeywordId = row.dataset.adsKeywordId;
  renderAdsKeywordRows();
  renderAdsDetail();
  if (event.target.closest("[data-ads-ai-reminder]")) {
    requestAnimationFrame(() => $("#adsAiPanel")?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  }
});
$("#adsKeywordRows").addEventListener("pointerdown", event => startPointerRowDrag(event, {
  rowSelector: "[data-ads-keyword-id]",
  handleSelector: ".ads-keyword-drag",
  idAttr: "adsKeywordId",
  move: moveAdsKeywordRow,
  labelSelector: ".ads-keyword-name strong"
}));
$("#adsKeywordRows").addEventListener("pointermove", updatePointerRowDrag);
$("#adsKeywordRows").addEventListener("pointerup", finishPointerRowDrag);
$("#adsKeywordRows").addEventListener("pointercancel", clearPointerRowDrag);
$("#adsKeywordFormBody").addEventListener("change", event => {
  if (event.target.id === "adsFormParentAsin") {
    renderAdsKeywordForm(event.target.value);
    return;
  }
  if (event.target.matches('input[name="adsSku"]') && event.target.checked) {
    const childAsin = event.target.dataset.childAsin || "";
    document.querySelectorAll('input[name="adsSku"]:checked').forEach(input => {
      if (input !== event.target && input.dataset.childAsin === childAsin) input.checked = false;
    });
  }
});
$("#adsKeywordFormBody").addEventListener("click", event => {
  if (event.target.closest("[data-add-ads-keyword-row]")) {
    $("#adsKeywordInputRows")?.insertAdjacentHTML("beforeend", adsKeywordFormRow("", "NORMAL", true));
    return;
  }
  const removeButton = event.target.closest(".ads-remove-keyword-row");
  if (!removeButton) return;
  const rows = document.querySelectorAll(".ads-keyword-form-row");
  if (rows.length <= 1) return;
  removeButton.closest(".ads-keyword-form-row")?.remove();
});
$("#adsDetailPanel").addEventListener("change", event => {
  if (["adsHistoryAsin", "adsHistoryMatch", "adsHistoryMetricA", "adsHistoryMetricB"].includes(event.target.id)) {
    if (["adsHistoryMetricA", "adsHistoryMetricB"].includes(event.target.id)) {
      const metricA = $("#adsHistoryMetricA");
      const metricB = $("#adsHistoryMetricB");
      if (metricA?.value === metricB?.value) {
        const other = Object.keys(ADS_HISTORY_METRICS).find(key => key !== event.target.value && !ADS_HISTORY_METRICS[key].unavailable);
        if (event.target.id === "adsHistoryMetricA") metricB.value = other;
        else metricA.value = other;
      }
    }
    loadAdsKeywordHistory(selectedAdsKeywordId);
    return;
  }
});
$("#adsDetailPanel").addEventListener("click", event => {
  const goalExample = event.target.closest("[data-ads-ai-goal]");
  if (goalExample) {
    const goalInput = $("#adsAiGoal");
    if (goalInput) goalInput.value = goalInput.value ? `${goalInput.value}；${goalExample.dataset.adsAiGoal}` : goalExample.dataset.adsAiGoal;
    return;
  }
  const strategyButton = event.target.closest("[data-ads-ai-strategy]");
  if (strategyButton) {
    openAdsAiStrategyDialog().catch(error => alert(error.message));
    return;
  }
  const historyButton = event.target.closest("[data-ads-ai-history]");
  if (historyButton) {
    openAdsAiHistoryDialog(selectedAdsKeywordId).catch(error => alert(error.message));
    return;
  }
  const saveGoalButton = event.target.closest("[data-ads-ai-save-goal]");
  if (saveGoalButton) {
    saveAdsAiGoal(selectedAdsKeywordId, saveGoalButton).catch(error => alert(error.message));
    return;
  }
  const analyzeButton = event.target.closest("[data-ads-ai-analyze]");
  if (analyzeButton) {
    analyzeAdsKeyword(selectedAdsKeywordId, analyzeButton).catch(error => {
      alert(error.message);
      loadAdsAiKeywordState(selectedAdsKeywordId);
    });
    return;
  }
  const executeRecommendationButton = event.target.closest("[data-ads-ai-execute]");
  if (executeRecommendationButton) {
    const recommendation = adsAiState?.recommendations?.find(item => item.id === executeRecommendationButton.dataset.adsAiExecute);
    if (!recommendation) return;
    const currency = adsWorkspace.profile?.currencyCode || "USD";
    const change = `${adsAiSettingSummary(recommendation.before, currency)} → ${adsAiSettingSummary(recommendation.after, currency)}`;
    if (!confirm(`确认执行这条 AI 建议？\n\n${adsAiActionLabel(recommendation.actionType)}\n${change}\n\n理由：${recommendation.reason}\n风险：${recommendation.risk || "未注明"}`)) return;
    setBusy(executeRecommendationButton, true, "执行中");
    api(`/api/ads/ai/recommendations/${recommendation.id}/execute`, { method: "POST", body: { confirmed: true } })
      .then(() => loadAdsWorkspace())
      .catch(error => { alert(`执行未完成：${error.message}`); loadAdsAiKeywordState(selectedAdsKeywordId); })
      .finally(() => setBusy(executeRecommendationButton, false, "确认并执行"));
    return;
  }
  const rejectRecommendationButton = event.target.closest("[data-ads-ai-reject]");
  if (rejectRecommendationButton) {
    if (!confirm("确定拒绝这条 AI 建议吗？该决定会记录到历史中。")) return;
    api(`/api/ads/ai/recommendations/${rejectRecommendationButton.dataset.adsAiReject}/decision`, { method: "POST", body: { decision: "REJECTED" } })
      .then(() => loadAdsWorkspace()).catch(error => alert(error.message));
    return;
  }
  const acknowledgeRecommendationButton = event.target.closest("[data-ads-ai-ack]");
  if (acknowledgeRecommendationButton) {
    api(`/api/ads/ai/recommendations/${acknowledgeRecommendationButton.dataset.adsAiAck}/decision`, { method: "POST", body: { decision: "ACKNOWLEDGED" } })
      .then(() => loadAdsWorkspace()).catch(error => alert(error.message));
    return;
  }
  const groupToggle = event.target.closest("[data-ads-group-toggle]");
  if (groupToggle) {
    const menu = groupToggle.closest("[data-ads-group-picker]")?.querySelector("[data-ads-group-menu]");
    if (!menu) return;
    const willOpen = menu.hidden;
    document.querySelectorAll("[data-ads-group-menu]").forEach(item => { item.hidden = true; });
    document.querySelectorAll("[data-ads-group-toggle]").forEach(item => item.setAttribute("aria-expanded", "false"));
    menu.hidden = !willOpen;
    groupToggle.setAttribute("aria-expanded", String(willOpen));
    return;
  }
  const groupOption = event.target.closest("[data-ads-group-option]");
  if (groupOption) {
    const group = groupOption.dataset.adsGroupOption;
    const keywordId = groupOption.dataset.adsKeywordId;
    api(`/api/ads/keywords/${keywordId}/group`, { method: "PUT", body: { group } })
      .then(() => loadAdsWorkspace()).catch(error => alert(error.message));
    return;
  }
  if (event.target.closest("#adsHistoryDateRange")) {
    event.stopPropagation();
    openAdsHistoryDatePicker();
    return;
  }
  if (event.target.closest("#adsHistoryQueryBtn")) {
    loadAdsKeywordHistory(selectedAdsKeywordId);
    return;
  }
  const campaignSettingsButton = event.target.closest("[data-ads-save-campaign-settings]");
  if (campaignSettingsButton) {
    const card = campaignSettingsButton.closest(".ads-campaign-card");
    const settings = {
      dailyBudget: card?.querySelector("[data-ads-campaign-budget]")?.value,
      topOfSearchAdjustment: card?.querySelector("[data-ads-campaign-top]")?.value,
      restOfSearchAdjustment: card?.querySelector("[data-ads-campaign-rest]")?.value,
      productPageAdjustment: card?.querySelector("[data-ads-campaign-product]")?.value
    };
    if (!confirm(`确认更新此 Campaign 的日预算和位置加价？\n\n预算：${settings.dailyBudget}\n顶部搜索：${settings.topOfSearchAdjustment}%\n其余搜索：${settings.restOfSearchAdjustment}%\n商品页面：${settings.productPageAdjustment}%`)) return;
    setBusy(campaignSettingsButton, true, "保存中");
    api(`/api/ads/campaigns/${campaignSettingsButton.dataset.adsSaveCampaignSettings}/settings`, { method: "PUT", body: settings })
      .then(() => loadAdsWorkspace()).catch(error => alert(error.message)).finally(() => setBusy(campaignSettingsButton, false, "保存设置"));
    return;
  }
  const unitBidButton = event.target.closest("[data-ads-save-unit-bid]");
  if (unitBidButton) {
    const row = unitBidButton.closest(".ads-unit-row");
    const bid = row?.querySelector("[data-ads-unit-bid]")?.value;
    if (!confirm(`确认将此子 ASIN 的 Ad Group 默认出价和关键词出价更新为 ${bid}？`)) return;
    setBusy(unitBidButton, true, "保存中");
    api(`/api/ads/ad-units/${unitBidButton.dataset.adsSaveUnitBid}/bid`, { method: "PUT", body: { bid } })
      .then(() => loadAdsWorkspace()).catch(error => alert(error.message)).finally(() => setBusy(unitBidButton, false, "保存"));
    return;
  }
  const discardButton = event.target.closest("[data-discard-ads-plan]");
  if (discardButton) {
    discardAdsCreationPlan(discardButton.dataset.discardAdsPlan, discardButton);
    return;
  }
  const previewButton = event.target.closest("[data-preview-keyword]");
  if (previewButton) {
    previewAdsKeywordCreation(previewButton.dataset.previewKeyword).catch(error => alert(error.message));
    return;
  }
  const addMatchButton = event.target.closest("[data-add-ads-match]");
  if (addMatchButton) {
    addAdsKeywordMatch(addMatchButton.dataset.keywordId, addMatchButton.dataset.addAdsMatch, addMatchButton).catch(error => alert(error.message));
    return;
  }
  const monitoringButton = event.target.closest("[data-ads-keyword-monitoring]");
  if (monitoringButton) {
    const removing = monitoringButton.dataset.monitoringAction === "remove";
    if (removing && !confirm("确定从关键词监控中移除该关键词吗？已有历史排名会保留。")) return;
    setBusy(monitoringButton, true, removing ? "移除中" : "加入中");
    api(`/api/ads/keywords/${monitoringButton.dataset.adsKeywordMonitoring}/monitoring`, { method: removing ? "DELETE" : "POST" })
      .then(() => loadAdsWorkspace())
      .catch(error => alert(error.message))
      .finally(() => setBusy(monitoringButton, false, removing ? "从关键词监控移除" : "加入关键词监控"));
    return;
  }
  const keywordStateButton = event.target.closest("[data-ads-keyword-state]");
  if (keywordStateButton) {
    setAdsKeywordState(keywordStateButton.dataset.adsKeywordState, keywordStateButton.dataset.nextState, keywordStateButton);
    return;
  }
  const keywordStopButton = event.target.closest("[data-ads-keyword-stop]");
  if (keywordStopButton) {
    stopAdsKeyword(keywordStopButton.dataset.adsKeywordStop, keywordStopButton);
    return;
  }
  const campaignButton = event.target.closest("[data-ads-campaign-state]");
  if (campaignButton) {
    const action = campaignButton.dataset.nextState === "PAUSED" ? "暂停" : "开始";
    const asin = campaignButton.closest(".ads-campaign-card")?.querySelector(".ads-campaign-product span")?.textContent?.split(" · ")[0] || "该子 ASIN";
    if (!confirm(`确认${action}子 ASIN ${asin} 的这个 Campaign？`)) return;
    api(`/api/ads/campaigns/${campaignButton.dataset.adsCampaignState}/state`, { method: "PUT", body: { state: campaignButton.dataset.nextState } })
      .then(() => loadAdsWorkspace()).catch(error => alert(error.message));
    return;
  }
  const campaignStopButton = event.target.closest("[data-ads-campaign-stop]");
  if (campaignStopButton) {
    const asin = campaignStopButton.closest(".ads-campaign-card")?.querySelector(".ads-campaign-product span")?.textContent?.split(" · ")[0] || "该子 ASIN";
    if (!confirm(`确认停止子 ASIN ${asin} 的这个 Campaign？\n\n它会暂停该子 ASIN 下的广告，并移入“已停止投放对象”。此操作会更新 Amazon Ads。`)) return;
    setBusy(campaignStopButton, true, "停止中");
    api(`/api/ads/campaigns/${campaignStopButton.dataset.adsCampaignStop}/stop`, { method: "POST" })
      .then(() => loadAdsWorkspace()).catch(error => alert(`停止未完成：${error.message}`)).finally(() => setBusy(campaignStopButton, false, "停止"));
    return;
  }
  const unitButton = event.target.closest("[data-ads-unit-state]");
  if (unitButton) {
    const action = unitButton.dataset.nextState === "PAUSED" ? "暂停" : "开始";
    if (!confirm(`确认${action}这个子 ASIN 的 Ad Group、Product Ad 和 Keyword Target？`)) return;
    api(`/api/ads/ad-units/${unitButton.dataset.adsUnitState}/state`, { method: "PUT", body: { state: unitButton.dataset.nextState } })
      .then(() => loadAdsWorkspace()).catch(error => alert(error.message));
  }
});
function updateAdsGroupHoverHelp(event) {
  const option = event.target.closest("[data-ads-group-option]");
  if (!option) return;
  const picker = option.closest("[data-ads-group-picker]");
  const help = picker?.querySelector("[data-ads-group-help]");
  if (help) help.textContent = ADS_GROUP_DESCRIPTIONS[option.dataset.adsGroupOption] || "";
}
$("#adsDetailPanel").addEventListener("pointerover", updateAdsGroupHoverHelp);
$("#adsDetailPanel").addEventListener("mouseover", updateAdsGroupHoverHelp);
$("#adsConfirmOperationBtn").addEventListener("click", confirmAdsOperation);
$("#adsDiscardPlanPreviewBtn").addEventListener("click", event => discardAdsCreationPlan(event.currentTarget.dataset.keywordId, event.currentTarget));
document.querySelectorAll("[data-close-ads-dialog]").forEach(button => button.addEventListener("click", () => $("#adsKeywordDialog").close()));
document.querySelectorAll("[data-close-ads-preview]").forEach(button => button.addEventListener("click", () => $("#adsPreviewDialog").close()));
document.querySelectorAll("[data-close-ads-ai-strategy]").forEach(button => button.addEventListener("click", () => $("#adsAiStrategyDialog").close()));
document.querySelectorAll("[data-close-ads-ai-history]").forEach(button => button.addEventListener("click", () => $("#adsAiHistoryDialog").close()));
$("#adsAiSaveStrategyBtn").addEventListener("click", event => saveAdsAiStrategy(event.currentTarget).catch(error => alert(error.message)));
$("#adsAiHistoryBody").addEventListener("click", event => {
  const snapshotButton = event.target.closest("[data-ads-ai-snapshot]");
  if (snapshotButton) {
    loadAdsAiSnapshot(snapshotButton.dataset.adsAiSnapshot, snapshotButton).catch(error => alert(error.message));
    return;
  }
  if (event.target.closest("[data-close-ads-ai-snapshot]")) {
    const snapshot = $("#adsAiHistorySnapshot");
    if (snapshot) snapshot.hidden = true;
  }
});
$("#adsAiStrategyBody").addEventListener("change", event => {
  const input = event.target.closest("input[name=adsAiApprovalMode]");
  if (!input) return;
  $("#adsAiStrategyBody").querySelectorAll(".ads-ai-approval-options label").forEach(label => {
    label.classList.toggle("selected", label.querySelector("input")?.checked === true);
  });
});
$("#factoryAddAsinBtn").addEventListener("click", () => addFactoryAsin().catch(error => alert(error.message)));
$("#factoryRefreshBtn").addEventListener("click", () => loadFactoryInventory().catch(error => alert(error.message)));
$("#factorySearch").addEventListener("input", renderFactoryInventory);
$("#factoryStockFilter").addEventListener("change", renderFactoryInventory);
$("#factoryColumnWidth").addEventListener("change", event => saveFactoryColumnWidth(event.target.value));
$("#factoryColumnWidth").addEventListener("keydown", event => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  event.target.blur();
});
$("#factoryMatrixBody").addEventListener("click", event => {
  const documentsButton = event.target?.closest?.("[data-open-factory-documents]");
  if (documentsButton) {
    event.preventDefault();
    event.stopPropagation();
    openFactoryDocumentsModal().catch(error => alert(error.message));
    return;
  }
  const downloadTemplateButton = event.target?.closest?.("[data-download-movement-template]");
  if (downloadTemplateButton) {
    event.preventDefault();
    event.stopPropagation();
    downloadFactoryMovementTemplate(downloadTemplateButton);
    return;
  }
  const deleteProductButton = event.target?.closest?.("[data-delete-product-id]");
  if (deleteProductButton) {
    event.preventDefault();
    event.stopPropagation();
    deleteFactoryProduct(deleteProductButton.dataset.deleteProductId).catch(error => alert(error.message));
    return;
  }
  const addRowButton = event.target?.closest?.("[data-add-factory-row]");
  if (addRowButton) {
    event.preventDefault();
    addFactoryDraftRow().catch(error => alert(error.message));
    return;
  }
  const deleteRowButton = event.target?.closest?.("[data-delete-row-operation]");
  if (deleteRowButton) {
    event.preventDefault();
    deleteFactoryMovementRow(deleteRowButton.dataset.deleteRowOperation, deleteRowButton.dataset.deleteRowDate).catch(error => alert(error.message));
  }
});
$("#factoryMatrixBody").addEventListener("change", event => {
  const parentCategorySelect = event.target?.closest?.("[data-factory-parent-category]");
  if (parentCategorySelect) {
    saveFactoryParentCategory(parentCategorySelect);
    return;
  }
  const parentNameInput = event.target?.closest?.("[data-factory-parent-name]");
  if (parentNameInput) {
    saveFactoryParentInternalName(parentNameInput);
    return;
  }
  const input = event.target?.closest?.("[data-factory-field]");
  if (input) saveFactoryProductField(input);
});
$("#factoryMatrixBody").addEventListener("keydown", event => {
  if (event.key === "Enter" && event.target?.closest?.(".factory-draft-row")) {
    if (event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    addFactoryDraftRow().catch(error => alert(error.message));
    return;
  }
  const input = event.target?.closest?.("[data-factory-field]");
  const parentNameInput = event.target?.closest?.("[data-factory-parent-name]");
  if (parentNameInput && event.key === "Enter") {
    if (event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    parentNameInput.blur();
    return;
  }
  if (!input || event.key !== "Enter") return;
  if (event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  input.blur();
});
$("#factoryMatrixBody").addEventListener("dragstart", event => {
  if (event.target?.closest?.("button, input, select")) {
    event.preventDefault();
    return;
  }
  const parentCell = event.target?.closest?.(".factory-parent-draggable[data-parent-key]");
  if (parentCell) {
    factoryDragMode = "parent";
    factoryDraggedParentKey = parentCell.dataset.parentKey || "";
    factoryDraggedProductId = "";
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", factoryDraggedParentKey);
    parentCell.classList.add("dragging");
    return;
  }
  const cell = event.target?.closest?.(".factory-draggable[data-product-id]");
  if (!cell) return;
  factoryDragMode = "product";
  factoryDraggedProductId = cell.dataset.productId || "";
  factoryDraggedParentKey = "";
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", factoryDraggedProductId);
  cell.classList.add("dragging");
});
$("#factoryMatrixBody").addEventListener("dragend", event => {
  event.target?.closest?.(".factory-draggable, .factory-parent-draggable")?.classList.remove("dragging");
  document.querySelectorAll(".factory-drag-over").forEach(node => node.classList.remove("factory-drag-over"));
  factoryDraggedProductId = "";
  factoryDraggedParentKey = "";
  factoryDragMode = "";
});
$("#factoryMatrixBody").addEventListener("dragover", event => {
  let cell = null;
  if (factoryDragMode === "parent") {
    cell = event.target?.closest?.(".factory-parent-draggable[data-parent-key]");
    if (!cell || !factoryDraggedParentKey || cell.dataset.parentKey === factoryDraggedParentKey) return;
  } else {
    cell = event.target?.closest?.(".factory-draggable[data-product-id]");
    if (!cell || !factoryDraggedProductId) return;
    const dragged = factoryProducts.find(product => product.id === factoryDraggedProductId);
    const target = factoryProducts.find(product => product.id === cell.dataset.productId);
    if (!dragged || !target || getFactoryProductGroupKey(dragged) !== getFactoryProductGroupKey(target)) return;
  }
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  document.querySelectorAll(".factory-drag-over").forEach(node => node.classList.remove("factory-drag-over"));
  cell.classList.add("factory-drag-over");
});
$("#factoryMatrixBody").addEventListener("drop", event => {
  document.querySelectorAll(".factory-drag-over").forEach(node => node.classList.remove("factory-drag-over"));
  if (factoryDragMode === "parent") {
    const cell = event.target?.closest?.(".factory-parent-draggable[data-parent-key]");
    if (!cell) return;
    event.preventDefault();
    moveFactoryParentGroup(cell.dataset.parentKey || "");
    return;
  }
  const cell = event.target?.closest?.(".factory-draggable[data-product-id]");
  if (!cell) return;
  event.preventDefault();
  moveFactoryProductColumn(cell.dataset.productId || "");
});
$("#productSearch").addEventListener("input", renderProducts);
$("#productSourceFilter").addEventListener("change", renderProducts);
$("#salesDateRange").addEventListener("click", () => openDatePicker());
$("#fbaColumnSettingsBtn").addEventListener("click", openFbaColumnSettingsModal);
$("#fbaFilterSettingsBtn").addEventListener("click", openFbaFilterSettingsModal);
$("#fbaTableHead").addEventListener("pointerdown", startFbaColumnResize);
$("#fbaTableHead").addEventListener("click", event => {
  const insertButton = event.target?.closest?.("[data-insert-fba-plan]");
  if (insertButton) {
    event.preventDefault();
    event.stopPropagation();
    insertFbaPlanToFactory(insertButton.dataset.insertFbaPlan).catch(error => alert(error.message));
    return;
  }
  if (event.target?.closest?.("[data-fba-resize]")) return;
  const key = event.target?.closest("[data-fba-sort]")?.dataset?.fbaSort;
  if (!key) return;
  if (fbaSort.key === key) {
    fbaSort.direction = fbaSort.direction === "asc" ? "desc" : "asc";
  } else {
    fbaSort.key = key;
    fbaSort.direction = "desc";
  }
  saveFbaTablePreferences();
  renderProducts();
});
$("#fbaTableHead").addEventListener("change", event => {
  const input = event.target?.closest?.("[data-fba-global-multiplier]");
  if (!input) return;
  const value = Number(input.value || 0);
  if (!Number.isFinite(value) || value <= 0) return;
  fbaReplenishmentMultiplier = value;
  saveFbaReplenishmentSettings();
  renderProducts();
});
$("#fbaTableHead").addEventListener("keydown", event => {
  const input = event.target?.closest?.("[data-fba-global-multiplier]");
  if (!input || event.key !== "Enter") return;
  event.preventDefault();
  input.blur();
});
$("#productList").addEventListener("change", event => {
  const factoryNameInput = event.target?.closest?.("[data-fba-factory-name]");
  if (factoryNameInput) {
    saveFactoryProductName(factoryNameInput.dataset.productId, factoryNameInput.value)
      .then(() => {
        renderProducts();
        renderFactoryInventory();
        renderDashboard();
        $("#sandboxStatus").textContent = "内部名已保存";
      })
      .catch(error => {
        alert(error.message);
        renderProducts();
      });
    return;
  }
  const input = event.target?.closest?.("[data-fba-plan-field]");
  if (!input) return;
  saveFbaPlanField(input).catch(error => alert(error.message));
});
$("#productList").addEventListener("click", event => {
  const toggle = event.target?.closest?.("[data-fba-grade-toggle]");
  if (toggle) {
    event.preventDefault();
    event.stopPropagation();
    const picker = toggle.closest(".fba-grade-picker");
    const wasOpen = picker?.classList.contains("open");
    document.querySelectorAll(".fba-grade-picker.open").forEach(item => {
      item.classList.remove("open");
      item.closest(".fba-col-replenishmentGrade")?.classList.remove("fba-grade-cell-open");
      item.querySelector("[data-fba-grade-toggle]")?.setAttribute("aria-expanded", "false");
    });
    if (picker && !wasOpen) {
      picker.classList.add("open");
      picker.closest(".fba-col-replenishmentGrade")?.classList.add("fba-grade-cell-open");
      toggle.setAttribute("aria-expanded", "true");
    }
    return;
  }
  const option = event.target?.closest?.("[data-fba-grade-option]");
  if (!option) return;
  event.preventDefault();
  event.stopPropagation();
  const product = findFbaProductByPlanKey(option.dataset.fbaPlanKey || "");
  const grade = option.dataset.fbaGradeOption || "";
  if (!product || !fbaReplenishmentTargets[grade]) return;
  updateFbaReplenishmentOverride(product, { grade });
  renderProducts();
  saveFbaGradesToServer({ [getFbaGradeAsin(product)]: grade }).catch(error => {
    console.warn("Failed to save FBA grade", error);
    $("#sandboxStatus").textContent = `商品等级保存失败：${error.message}`;
  });
});
$("#productList").addEventListener("keydown", event => {
  const factoryNameInput = event.target?.closest?.("[data-fba-factory-name]");
  if (factoryNameInput && event.key === "Enter") {
    if (event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    factoryNameInput.blur();
    return;
  }
  const input = event.target?.closest?.("[data-fba-plan-field]");
  if (!input || event.key !== "Enter") return;
  if (event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  input.blur();
});
document.addEventListener("click", () => {
  document.querySelectorAll(".fba-grade-picker.open").forEach(item => {
    item.classList.remove("open");
    item.closest(".fba-col-replenishmentGrade")?.classList.remove("fba-grade-cell-open");
    item.querySelector("[data-fba-grade-toggle]")?.setAttribute("aria-expanded", "false");
  });
});
$("#fbaDatePicker").addEventListener("click", event => {
  event.stopPropagation();
  const navButton = event.target?.closest?.("[data-date-nav]");
  const nav = navButton?.dataset?.dateNav;
  if (nav) {
    datePickerMonth = shiftMonth(datePickerMonth, Number(nav));
    renderDatePicker();
    return;
  }
  const quickButton = event.target?.closest?.("[data-date-quick]");
  const quickType = quickButton?.dataset?.dateQuick;
  if (quickType) {
    const range = quickDateRange(quickType);
    $("#salesStartDate").value = range.startDate;
    $("#salesEndDate").value = range.endDate;
    datePickerMonth = range.endDate.slice(0, 7);
    updateDateRangeInput();
    closeDatePicker();
    return;
  }
  const dayButton = event.target?.closest?.("[data-date]");
  const date = dayButton?.dataset?.date;
  if (!date || !dateRangePickerOpen || dayButton?.disabled || isDateDisabled(date)) return;
  const startInput = $("#salesStartDate");
  const endInput = $("#salesEndDate");
  const startDate = startInput?.value || "";
  const endDate = endInput?.value || "";
  if (!startDate || endDate || date < startDate) {
    startInput.value = date;
    endInput.value = "";
    datePickerMonth = date.slice(0, 7);
    updateDateRangeInput();
    renderDatePicker();
    return;
  }
  endInput.value = date;
  updateDateRangeInput();
  closeDatePicker();
});
$("#fbaDatePicker").addEventListener("pointerdown", event => {
  event.stopPropagation();
});
$("#adsDatePicker").addEventListener("click", event => {
  event.stopPropagation();
  const nav = event.target?.closest?.("[data-ads-date-nav]")?.dataset?.adsDateNav;
  if (nav) {
    adsDatePickerMonth = shiftMonth(adsDatePickerMonth, Number(nav));
    renderAdsDatePicker();
    return;
  }
  const quickType = event.target?.closest?.("[data-ads-date-quick]")?.dataset?.adsDateQuick;
  if (quickType) {
    const range = quickDateRange(quickType);
    $("#adsStartDate").value = range.startDate;
    $("#adsEndDate").value = range.endDate;
    adsDatePickerMonth = range.endDate.slice(0, 7);
    updateAdsDateRangeInput();
    closeAdsDatePicker();
    return;
  }
  const dayButton = event.target?.closest?.("[data-ads-date]");
  const date = dayButton?.dataset?.adsDate;
  if (!date || !adsDatePickerOpen || dayButton?.disabled || isDateDisabled(date)) return;
  const startInput = $("#adsStartDate");
  const endInput = $("#adsEndDate");
  const startDate = startInput?.value || "";
  const endDate = endInput?.value || "";
  if (!startDate || endDate || date < startDate) {
    startInput.value = date;
    endInput.value = "";
    adsDatePickerMonth = date.slice(0, 7);
    updateAdsDateRangeInput();
    renderAdsDatePicker();
    return;
  }
  endInput.value = date;
  updateAdsDateRangeInput();
  closeAdsDatePicker();
});
$("#adsDatePicker").addEventListener("pointerdown", event => event.stopPropagation());
$("#adsHistoryDatePicker").addEventListener("click", event => {
  event.stopPropagation();
  const nav = event.target?.closest?.("[data-ads-history-date-nav]")?.dataset?.adsHistoryDateNav;
  if (nav) {
    adsHistoryDatePickerMonth = shiftMonth(adsHistoryDatePickerMonth, Number(nav));
    renderAdsHistoryDatePicker();
    return;
  }
  const quickType = event.target?.closest?.("[data-ads-history-date-quick]")?.dataset?.adsHistoryDateQuick;
  if (quickType) {
    const range = quickDateRange(quickType);
    adsHistoryState.startDate = range.startDate;
    adsHistoryState.endDate = range.endDate;
    adsHistoryDatePickerMonth = range.endDate.slice(0, 7);
    updateAdsHistoryDateRangeInput();
    closeAdsHistoryDatePicker();
    return;
  }
  const dayButton = event.target?.closest?.("[data-ads-history-date]");
  const date = dayButton?.dataset?.adsHistoryDate;
  if (!date || !adsHistoryDatePickerOpen || dayButton?.disabled || isDateDisabled(date)) return;
  if (!adsHistoryState.startDate || adsHistoryState.endDate || date < adsHistoryState.startDate) {
    adsHistoryState.startDate = date;
    adsHistoryState.endDate = "";
    adsHistoryDatePickerMonth = date.slice(0, 7);
    updateAdsHistoryDateRangeInput();
    renderAdsHistoryDatePicker();
    return;
  }
  adsHistoryState.endDate = date;
  updateAdsHistoryDateRangeInput();
  closeAdsHistoryDatePicker();
});
$("#adsHistoryDatePicker").addEventListener("pointerdown", event => event.stopPropagation());
function showSifAuthorization(message = "") {
  $("#sifCredentialPanel").hidden = false;
  $("#sifWorkspace").hidden = true;
  $("#sifReauthorizeBtn").hidden = true;
  const status = $("#sifAuthStatus");
  status.textContent = message ? "授权不可用" : "尚未授权";
  status.classList.remove("ok");
  status.classList.add("warn");
  const errorNode = $("#sifCredentialError");
  errorNode.hidden = !message;
  errorNode.textContent = message || "";
}

function showSifWorkspace() {
  $("#sifCredentialPanel").hidden = true;
  $("#sifWorkspace").hidden = false;
  $("#sifReauthorizeBtn").hidden = false;
  const status = $("#sifAuthStatus");
  status.textContent = "SIF 已连接";
  status.classList.add("ok");
  status.classList.remove("warn");
  $("#sifCredentialError").hidden = true;
}

function sifRankForDate(keyword, date, type) {
  const items = Array.isArray(keyword?.rankInfo) ? keyword.rankInfo : [];
  const record = items.find(item => String(item?.[type]?.updateTime || "") === String(date));
  return record?.[type] || null;
}

function sifLatestRankForAsin(asin, type = "nf") {
  let best = null;
  for (const keyword of sifWorkspaceData.keywords || []) {
    for (const item of keyword.rankInfo || []) {
      const rank = item?.[type];
      if (rank?.asin === asin && rank.rank !== null && rank.rank !== "" && Number.isFinite(Number(rank.rank))) {
        best = best === null ? Number(rank.rank) : Math.min(best, Number(rank.rank));
      }
    }
  }
  return best;
}

function renderSifAsins() {
  const asins = [...new Set([selectedSifAsin, ...(sifWorkspaceData.asins || [])].filter(Boolean))];
  $("#sifMonitorSummary").textContent = selectedSifAsin
    ? `共监控 ${Number(sifWorkspaceData.asinNum || asins.length)} 个子 ASIN`
    : "广告管理中暂无已添加关键词的子 ASIN";
  $("#sifAddKeywordBtn").disabled = !selectedSifAsin;
  $("#sifAsinTabs").innerHTML = asins.length ? asins.map(asin => {
    const product = (sifWorkspaceData.asinProducts || []).find(item => item.asin === asin) || {};
    return `<button type="button" class="sif-asin-card ${asin === selectedSifAsin ? "active" : ""}" data-sif-asin="${escapeHtml(asin)}">
      ${product.imageUrl ? `<img src="${escapeHtml(product.imageUrl)}" alt="${escapeHtml(product.childName || asin)}" loading="lazy">` : `<span class="sif-asin-image-placeholder">无图</span>`}
      <span class="sif-asin-card-copy"><span class="sif-asin-card-top"><strong>${escapeHtml(asin)}</strong><small>${asin === selectedSifAsin ? "当前" : "查看"}</small></span>
      <span>父：${escapeHtml(product.parentName || product.parentAsin || "-")}</span><span>子：${escapeHtml(product.childName || asin)}</span></span>
    </button>`;
  }).join("") : '<div class="empty">请先在“广告管理”中为子 ASIN 添加关键词，完成后这里会自动出现。</div>';
}

function sifNumericValue(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sifFormatMetric(value) {
  const number = sifNumericValue(value);
  return number === null ? "—" : number.toLocaleString("zh-CN");
}

function sifTrendSvg(dates, series, tooltipItems, chartClass = "") {
  const safeDates = Array.isArray(dates) ? dates : [];
  if (safeDates.length < 2) return '<div class="sif-no-trend">暂无趋势</div>';
  const width = 220;
  const height = 64;
  const paddingX = 6;
  const paddingY = 7;
  const plotWidth = width - paddingX * 2;
  const plotHeight = height - paddingY * 2;
  const xFor = index => paddingX + (index / Math.max(1, safeDates.length - 1)) * plotWidth;
  const lines = series.map(item => {
    const values = safeDates.map((_, index) => sifNumericValue(item.values?.[index]));
    const valid = values.filter(value => value !== null);
    if (!valid.length) return "";
    const min = Math.min(...valid);
    const max = Math.max(...valid);
    const range = max - min || 1;
    const yFor = value => paddingY + (item.lowerIsBetter ? (value - min) / range : (max - value) / range) * plotHeight;
    const points = values.map((value, index) => value === null ? null : `${xFor(index).toFixed(1)},${yFor(value).toFixed(1)}`).filter(Boolean);
    const circles = values.map((value, index) => value === null ? "" : `<circle cx="${xFor(index).toFixed(1)}" cy="${yFor(value).toFixed(1)}" r="1.8" fill="${item.color}"/>`).join("");
    return `<polyline points="${points.join(" ")}" fill="none" stroke="${item.color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>${circles}`;
  }).join("");
  const hitWidth = plotWidth / Math.max(1, safeDates.length - 1);
  const hits = safeDates.map((date, index) => {
    const encoded = encodeURIComponent(JSON.stringify(tooltipItems[index] || { title: date, rows: [] }));
    return `<rect class="sif-chart-hit" x="${Math.max(0, xFor(index) - hitWidth / 2).toFixed(1)}" y="0" width="${Math.min(width, hitWidth).toFixed(1)}" height="${height}" data-sif-chart-tooltip="${encoded}"/>`;
  }).join("");
  return `<svg class="sif-trend-svg ${chartClass}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img">${lines}${hits}</svg>`;
}

function renderSifSearchTrend(keyword) {
  const history = keyword.estSearchesNumHistory || {};
  const dates = Array.isArray(history.date) ? history.date : [];
  const searches = Array.isArray(history.estSearchesNum) ? history.estSearchesNum : [];
  const abaRanks = Array.isArray(history.searchesRank) ? history.searchesRank : [];
  const festivals = Array.isArray(history.festivals) ? history.festivals : [];
  const tooltips = dates.map((date, index) => ({
    title: `${date}（美国时间）`,
    rows: [
      { label: "搜索量", value: sifFormatMetric(searches[index]), color: "#0ea5e9" },
      { label: "ABA", value: sifFormatMetric(abaRanks[index]), color: "#f59e0b" }
    ],
    note: Array.isArray(festivals[index]) ? festivals[index].map(item => item?.name).filter(Boolean).join("、") : ""
  }));
  return `<div class="sif-trend-values"><span class="search">搜索量 ${sifFormatMetric(keyword.estSearchesNum)}</span><span class="aba">ABA ${sifFormatMetric(keyword.searchesRank)}</span></div>
    ${sifTrendSvg(dates, [
      { values: searches, color: "#0ea5e9", lowerIsBetter: false },
      { values: abaRanks, color: "#f59e0b", lowerIsBetter: true }
    ], tooltips, "search-trend")}`;
}

function renderSifRankingTrend(keyword) {
  const history = keyword.listingRankHistory || {};
  const dates = Array.isArray(history.date) ? history.date : [];
  const naturalItems = Array.isArray(history.rank) ? history.rank : [];
  const sponsoredItems = Array.isArray(history.adRank) ? history.adRank : [];
  const natural = dates.map((_, index) => sifNumericValue(naturalItems[index]?.rank));
  const sponsored = dates.map((_, index) => sifNumericValue(sponsoredItems[index]?.rank));
  const latestNatural = [...natural].reverse().find(value => value !== null) ?? null;
  const latestSponsored = [...sponsored].reverse().find(value => value !== null) ?? null;
  const tooltips = dates.map((date, index) => ({
    title: `${date}（美国时间）`,
    rows: [
      { label: "自然排名", value: natural[index] === null ? "未上榜" : `${sifFormatMetric(natural[index])}${naturalItems[index]?.asin ? `（${naturalItems[index].asin}）` : ""}`, color: "#10b981" },
      { label: "SP 排名", value: sponsored[index] === null ? "未上榜" : `${sifFormatMetric(sponsored[index])}${sponsoredItems[index]?.asin ? `（${sponsoredItems[index].asin}）` : ""}`, color: "#f97316" }
    ]
  }));
  return `<div class="sif-trend-values"><span class="natural">自然 ${sifFormatMetric(latestNatural)}</span><span class="sponsored">SP ${sifFormatMetric(latestSponsored)}</span></div>
    ${sifTrendSvg(dates, [
      { values: natural, color: "#10b981", lowerIsBetter: true },
      { values: sponsored, color: "#f97316", lowerIsBetter: true }
    ], tooltips, "ranking-trend")}`;
}

function renderSifRankLine(rank, label, channel) {
  const value = rank && rank.rank !== null && rank.rank !== "" && Number.isFinite(Number(rank.rank)) ? Number(rank.rank) : null;
  const changeClass = rank?.changeType === "up" ? "improved" : rank?.changeType === "down" ? "declined" : "steady";
  return `<div class="sif-rank-line sif-rank-${channel} ${changeClass}"><span>${label}</span><strong>${value ?? "—"}</strong><small>${escapeHtml(rank?.rankStr || "未上榜")}</small></div>`;
}

function renderSifFixedBid(bid) {
  if (!bid) return '<div class="sif-fixed-bid pending">暂无竞价数据</div>';
  if (bid.matchStatus === "NO_CATEGORY_MATCH") {
    return '<div class="sif-fixed-bid unavailable"><b>暂无竞价</b></div>';
  }
  const price = value => value === null || value === undefined || !Number.isFinite(Number(value)) ? "—" : `$${Number(value).toFixed(2)}`;
  const range = value => `${price(value?.start)}–${price(value?.end)}`;
  const sourceLabel = bid.categorySource === "PARENT" ? "父 ASIN 类目" : "子 ASIN 类目";
  const title = `固定模式（legacy）\n匹配来源 ${sourceLabel}\n精准范围 ${range(bid.exact)}\n词组范围 ${range(bid.phrase)}\n广泛范围 ${range(bid.broad)}${bid.categoryName ? `\n类目 ${bid.categoryName}` : ""}${bid.productCount === null || bid.productCount === undefined ? "" : `\n该类目收录商品 ${Number(bid.productCount).toLocaleString("zh-CN")}`}`;
  return `<div class="sif-fixed-bid" title="${escapeHtml(title)}"><small class="sif-bid-category">类目：${escapeHtml(bid.categoryName || bid.categoryId || "未命名")}</small><span class="sif-bid-prices"><em>竞价：</em><b>精准 ${price(bid.exact?.median)}</b><b>词组 ${price(bid.phrase?.median)}</b><b>广泛 ${price(bid.broad?.median)}</b></span></div>`;
}

function sifSearchValue(keyword) {
  const value = sifNumericValue(keyword?.estSearchesNum);
  return value === null ? -1 : value;
}

function sifVisibleKeywords() {
  const query = $("#sifKeywordSearch").value.trim().toLowerCase();
  const keywords = (sifWorkspaceData.keywords || []).filter(item => `${item.keyword || ""} ${item.translateKeyword || ""}`.toLowerCase().includes(query));
  if (!sifSearchSortDirection) return keywords;
  return [...keywords].sort((a, b) => {
    const av = sifSearchValue(a);
    const bv = sifSearchValue(b);
    if (av < 0 && bv < 0) return Number(a.sortOrder || 0) - Number(b.sortOrder || 0);
    if (av < 0) return 1;
    if (bv < 0) return -1;
    return sifSearchSortDirection === "asc" ? av - bv : bv - av;
  });
}

async function saveSifKeywordOrder() {
  try {
    await api("/api/sif-keywords/reorder", {
      method: "POST",
      body: { asin: selectedSifAsin, keywords: (sifWorkspaceData.keywords || []).map(item => item.keyword).filter(Boolean) }
    });
  } catch (error) {
    alert(error.message);
    await refreshSifWorkspace(selectedSifAsin).catch(() => {});
  }
}

function moveSifKeywordRow(targetKeyword, sourceKeyword) {
  if (!sourceKeyword || !targetKeyword || sourceKeyword === targetKeyword) return;
  const visible = sifVisibleKeywords();
  const fromIndex = visible.findIndex(item => item.keyword === sourceKeyword);
  const toIndex = visible.findIndex(item => item.keyword === targetKeyword);
  if (fromIndex < 0 || toIndex < 0) return;
  const movedVisible = [...visible];
  const [moved] = movedVisible.splice(fromIndex, 1);
  movedVisible.splice(toIndex, 0, moved);
  const movedSet = new Set(movedVisible.map(item => item.keyword));
  const hidden = (sifWorkspaceData.keywords || []).filter(item => !movedSet.has(item.keyword));
  sifWorkspaceData.keywords = [...movedVisible, ...hidden]
    .map((item, index) => ({ ...item, sortOrder: (index + 1) * 10 }));
  sifSearchSortDirection = "";
  renderSifRankings();
  saveSifKeywordOrder();
}

function clearPointerRowDrag() {
  document.querySelectorAll("tr.dragging, tr.drag-over").forEach(node => node.classList.remove("dragging", "drag-over"));
  pointerRowDrag?.ghost?.remove();
  pointerRowDrag = null;
}

function startPointerRowDrag(event, { rowSelector, handleSelector, idAttr, move, labelSelector }) {
  const handle = event.target.closest(handleSelector);
  const row = event.target.closest(rowSelector);
  if (!handle || !row) return;
  event.preventDefault();
  const label = row.querySelector(labelSelector)?.textContent?.trim() || "拖动排序";
  const ghost = document.createElement("div");
  ghost.className = "row-drag-ghost";
  ghost.textContent = label;
  document.body.append(ghost);
  pointerRowDrag = {
    rowSelector,
    idAttr,
    move,
    sourceId: row.dataset[idAttr] || "",
    pointerId: event.pointerId,
    ghost
  };
  row.classList.add("dragging");
  movePointerRowGhost(event);
  handle.setPointerCapture?.(event.pointerId);
}

function movePointerRowGhost(event) {
  if (!pointerRowDrag?.ghost) return;
  pointerRowDrag.ghost.style.transform = `translate(${event.clientX + 14}px, ${event.clientY + 12}px)`;
}

function updatePointerRowDrag(event) {
  if (!pointerRowDrag) return;
  movePointerRowGhost(event);
  const row = document.elementFromPoint(event.clientX, event.clientY)?.closest?.(pointerRowDrag.rowSelector);
  document.querySelectorAll(`${pointerRowDrag.rowSelector}.drag-over`).forEach(node => node.classList.remove("drag-over"));
  if (row && row.dataset[pointerRowDrag.idAttr] !== pointerRowDrag.sourceId) row.classList.add("drag-over");
}

function finishPointerRowDrag(event) {
  if (!pointerRowDrag) return;
  const row = document.elementFromPoint(event.clientX, event.clientY)?.closest?.(pointerRowDrag.rowSelector);
  const targetId = row?.dataset?.[pointerRowDrag.idAttr] || "";
  const move = pointerRowDrag.move;
  const sourceId = pointerRowDrag.sourceId;
  clearPointerRowDrag();
  if (targetId && targetId !== sourceId) move(targetId, sourceId);
}

function renderSifRankings() {
  const dates = (sifWorkspaceData.dates || []).slice(0, 60);
  const query = $("#sifKeywordSearch").value.trim().toLowerCase();
  const keywords = sifVisibleKeywords();
  $("#sifKeywordSummary").textContent = `${keywords.length} 个关键词 · ${selectedSifAsin || "未选择 ASIN"}`;
  $("#sifUpdateRange").textContent = dates.length ? `已保存 ${dates.length} 个排名日期 · 最多显示近 60 天` : "暂无数据库排名";
  const searchSortMark = sifSearchSortDirection === "asc" ? "↑" : sifSearchSortDirection === "desc" ? "↓" : "";
  $("#sifRankingHead").innerHTML = `<tr><th class="sif-index-col">#</th><th class="sif-keyword-col">关键词</th><th class="sif-search-trend-col"><button type="button" class="sif-sort-head" data-sif-sort-search title="按搜索量排序">搜索量 / ABA 趋势${searchSortMark ? `<span>${searchSortMark}</span>` : ""}</button></th><th class="sif-ranking-trend-col">排名趋势</th><th class="sif-latest-col"><button type="button" data-sif-scroll-latest title="回到最新日期">⇤<span>最新</span></button></th>${dates.map((date, index) => `<th class="sif-date-col ${index === 0 ? "latest" : ""}">${index === 0 ? "今天 · " : ""}${escapeHtml(date)}<small>美国时间</small></th>`).join("")}<th class="sif-action-col">操作</th></tr>`;
  $("#sifRankingRows").innerHTML = keywords.length ? keywords.map((keyword, index) => {
    const cells = dates.map(date => {
      const natural = sifRankForDate(keyword, date, "nf");
      const sponsored = sifRankForDate(keyword, date, "sp");
      return `<td class="sif-rank-cell">${renderSifRankLine(natural, "自然", "natural")}${renderSifRankLine(sponsored, "SP", "sponsored")}</td>`;
    }).join("");
    return `<tr data-sif-row-keyword="${escapeHtml(keyword.keyword || "")}">
      <td class="sif-index-col"><button type="button" class="sif-keyword-drag" title="拖动调整关键词顺序" aria-label="拖动调整关键词顺序">⋮⋮</button><span>${index + 1}</span></td>
      <td class="sif-keyword-cell"><button type="button" class="sif-keyword-open" data-sif-history-keyword="${escapeHtml(keyword.keyword || "")}"><strong>${escapeHtml(keyword.keyword || "-")}</strong><span>${escapeHtml(keyword.translateKeyword || "")}</span></button>${renderSifFixedBid(keyword.fixedBid)}</td>
      <td class="sif-trend-cell">${renderSifSearchTrend(keyword)}</td>
      <td class="sif-trend-cell">${renderSifRankingTrend(keyword)}</td>
      <td class="sif-latest-col"></td>
      ${cells}
      <td class="sif-action-col"><button type="button" class="sif-delete-keyword" data-sif-keyword="${escapeHtml(keyword.keyword || "")}" title="停止监控">删除</button></td>
    </tr>`;
  }).join("") : `<tr><td colspan="${dates.length + 6}"><div class="empty">${query ? "没有匹配的关键词" : "当前子 ASIN 还没有监控关键词"}</div></td></tr>`;
}

function renderSifWorkspace() {
  renderSifAsins();
  renderSifRankings();
}

function updateSifDetailDateInput() {
  const input = $("#sifDetailDateRange");
  if (!input) return;
  input.value = sifDetailState.startDate && sifDetailState.endDate
    ? `${sifDetailState.startDate} 至 ${sifDetailState.endDate}`
    : sifDetailState.startDate ? `${sifDetailState.startDate} 至 ...` : "";
}

function renderSifDetailDatePicker() {
  const picker = $("#sifDetailDatePicker");
  if (!picker || !sifDetailDatePickerOpen) return;
  if (!sifDetailDatePickerMonth) sifDetailDatePickerMonth = (sifDetailState.endDate || marketplaceToday()).slice(0, 7);
  const [year, month] = sifDetailDatePickerMonth.split("-").map(Number);
  const first = new Date(Date.UTC(year, month - 1, 1));
  const start = new Date(Date.UTC(year, month - 1, 1 - first.getUTCDay()));
  const days = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start.getTime() + index * 86400000);
    const value = date.toISOString().slice(0, 10);
    const inMonth = date.getUTCMonth() === month - 1;
    const inRange = sifDetailState.startDate && sifDetailState.endDate && value >= sifDetailState.startDate && value <= sifDetailState.endDate;
    const endpoint = value === sifDetailState.startDate || value === sifDetailState.endDate;
    const disabled = isDateDisabled(value);
    return `<button type="button" class="date-picker-day ${inMonth ? "" : "other-month"} ${inRange ? "in-range" : ""} ${endpoint ? "selected" : ""}" data-sif-detail-date="${value}" ${disabled ? "disabled" : ""}><span>${date.getUTCDate()}</span></button>`;
  }).join("");
  picker.innerHTML = `<div class="date-picker-head"><button type="button" data-sif-detail-nav="-1">‹</button><div class="date-picker-title">${year}-${String(month).padStart(2, "0")}</div><button type="button" data-sif-detail-nav="1">›</button></div>
    <div class="date-picker-week"><span>日</span><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span></div>
    <div class="date-picker-grid">${days}</div>
    <div class="date-picker-quick"><button type="button" data-sif-detail-quick="last7">最近7天</button><button type="button" data-sif-detail-quick="last30">最近30天</button><button type="button" data-sif-detail-quick="last60">最近60天</button></div>
    <div class="date-picker-legend"><span class="date-range-swatch"></span> 已选范围</div>`;
}

function openSifDetailDatePicker() {
  const input = $("#sifDetailDateRange");
  const picker = $("#sifDetailDatePicker");
  if (!input || !picker) return;
  sifDetailDatePickerOpen = true;
  sifDetailDatePickerMonth = (sifDetailState.endDate || sifDetailState.startDate || marketplaceToday()).slice(0, 7);
  picker.hidden = false;
  renderSifDetailDatePicker();
  const rect = input.getBoundingClientRect();
  const pickerRect = picker.getBoundingClientRect();
  picker.style.left = `${Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - pickerRect.width - 8))}px`;
  picker.style.top = `${Math.min(window.innerHeight - pickerRect.height - 8, rect.bottom + 6)}px`;
}

function closeSifDetailDatePicker() {
  $("#sifDetailDatePicker").hidden = true;
  sifDetailDatePickerOpen = false;
}

function renderSifHistoryChart(data) {
  const chart = $("#sifHistoryChart");
  const points = (data.points || []).filter(point => point.naturalRank !== null || point.spRank !== null);
  if (!points.length) {
    chart.innerHTML = '<div class="ads-history-empty">所选日期范围暂无排名数据</div>';
    return;
  }
  const width = 920;
  const height = 350;
  const bounds = { left: 58, top: 24, width: 820, height: 268 };
  const allRanks = points.flatMap(point => [point.naturalRank, point.spRank]).filter(value => value !== null).map(Number);
  const maxRank = Math.max(10, ...allRanks);
  const startMs = new Date(`${data.range.startDate}T00:00:00Z`).getTime();
  const endMs = new Date(`${data.range.endDate}T00:00:00Z`).getTime();
  const span = Math.max(86400000, endMs - startMs);
  const xFor = date => bounds.left + ((new Date(`${date}T00:00:00Z`).getTime() - startMs) / span) * bounds.width;
  const yFor = rank => bounds.top + ((Number(rank) - 1) / Math.max(1, maxRank - 1)) * bounds.height;
  const line = key => points.filter(point => point[key] !== null).map(point => `${xFor(point.date).toFixed(1)},${yFor(point[key]).toFixed(1)}`).join(" ");
  const ticks = [1, Math.max(2, Math.round(maxRank * 0.25)), Math.max(3, Math.round(maxRank * 0.5)), Math.max(4, Math.round(maxRank * 0.75)), maxRank];
  const xDates = [...new Set([data.range.startDate, ...points.filter((_, index) => index % Math.max(1, Math.floor(points.length / 4)) === 0).map(point => point.date), data.range.endDate])].slice(0, 6);
  chart.innerHTML = `<div class="ads-history-legend"><span><i style="background:#10b981"></i>自然排名</span><span><i style="background:#f97316"></i>SP 排名</span></div>
    <svg class="sif-history-svg" viewBox="0 0 ${width} ${height}" role="img">
      ${ticks.map(rank => `<line x1="${bounds.left}" y1="${yFor(rank)}" x2="${bounds.left + bounds.width}" y2="${yFor(rank)}" class="ads-chart-grid"></line><text x="${bounds.left - 9}" y="${yFor(rank) + 4}" text-anchor="end" class="ads-chart-axis">${rank}</text>`).join("")}
      ${xDates.map(date => `<text x="${xFor(date)}" y="${bounds.top + bounds.height + 28}" text-anchor="middle" class="ads-chart-date">${escapeHtml(date.slice(5))}</text>`).join("")}
      ${line("naturalRank") ? `<polyline points="${line("naturalRank")}" fill="none" stroke="#10b981" stroke-width="2.5"></polyline>` : ""}
      ${line("spRank") ? `<polyline points="${line("spRank")}" fill="none" stroke="#f97316" stroke-width="2.5"></polyline>` : ""}
      ${points.map(point => {
        const payload = encodeURIComponent(JSON.stringify({ title: `${point.date}（美国时间）`, rows: [
          { label: "自然排名", value: point.naturalRank === null ? "未上榜" : `${point.naturalRank}${point.naturalRankStr ? ` · ${point.naturalRankStr}` : ""}`, color: "#10b981" },
          { label: "SP 排名", value: point.spRank === null ? "未上榜" : `${point.spRank}${point.spRankStr ? ` · ${point.spRankStr}` : ""}`, color: "#f97316" }
        ] }));
        return `<rect x="${xFor(point.date) - 6}" y="${bounds.top}" width="12" height="${bounds.height}" fill="transparent" data-sif-chart-tooltip="${payload}"></rect>${point.naturalRank !== null ? `<circle cx="${xFor(point.date)}" cy="${yFor(point.naturalRank)}" r="3" fill="#10b981"></circle>` : ""}${point.spRank !== null ? `<circle cx="${xFor(point.date)}" cy="${yFor(point.spRank)}" r="3" fill="#f97316"></circle>` : ""}`;
      }).join("")}
    </svg>`;
}

async function loadSifKeywordHistory() {
  const chart = $("#sifHistoryChart");
  chart.innerHTML = '<div class="ads-history-loading">正在读取排名历史…</div>';
  const query = new URLSearchParams(sifDetailState);
  try {
    renderSifHistoryChart(await api(`/api/sif-keywords/history?${query}`));
  } catch (error) {
    chart.innerHTML = `<div class="ads-inline-error">${escapeHtml(error.message)}</div>`;
  }
}

function openSifKeywordHistory(keyword) {
  const dates = sifWorkspaceData.dates || [];
  const endDate = dates[0] || marketplaceToday();
  const startDate = dates.at(-1) || shiftDateValue(endDate, -59);
  sifDetailState = { asin: selectedSifAsin, keyword, startDate, endDate };
  $("#sifHistoryTitle").textContent = keyword;
  $("#sifHistorySubtitle").textContent = `${selectedSifAsin} · 数据库排名历史`;
  updateSifDetailDateInput();
  $("#sifHistoryDialog").showModal();
  loadSifKeywordHistory();
}

async function refreshSifWorkspace(asin = "") {
  const status = $("#sifAuthStatus");
  status.textContent = "正在验证 SIF";
  status.classList.remove("ok", "warn");
  const params = asin ? `?asin=${encodeURIComponent(asin)}` : "";
  const result = await api(`/api/sif-keywords/workspace${params}`);
  if (!result.authorized) {
    showSifAuthorization(result.error || "");
    return;
  }
  selectedSifAsin = result.selectedAsin || asin;
  sifWorkspaceData = result.data || { dates: [], keywords: [], asins: [] };
  showSifWorkspace();
  renderSifWorkspace();
}

async function saveSifCredentials() {
  const curl = $("#sifCurlInput").value.trim();
  if (!curl) return showSifAuthorization("请先粘贴 SIF 关键词列表请求的 cURL");
  const button = $("#sifSaveCredentialsBtn");
  setBusy(button, true, "验证并保存");
  $("#sifCredentialError").hidden = true;
  try {
    const result = await api("/api/sif-keywords/credentials", { method: "POST", body: { curl } });
    selectedSifAsin = result.selectedAsin || "";
    sifSearchSortDirection = "";
    sifWorkspaceData = result.data || { dates: [], keywords: [], asins: [] };
    $("#sifCurlInput").value = "";
    showSifWorkspace();
    renderSifWorkspace();
  } catch (error) {
    showSifAuthorization(error.message);
  } finally {
    setBusy(button, false, "验证并保存");
  }
}

async function openSifAsin(asin) {
  const normalized = String(asin || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(normalized)) return;
  if (normalized !== selectedSifAsin) sifSearchSortDirection = "";
  await refreshSifWorkspace(normalized);
}

async function changeSifKeywordSubscription(keywords, type) {
  const button = type === 1 ? $("#sifSubmitKeywordsBtn") : null;
  setBusy(button, true, "添加监控");
  try {
    const result = await api("/api/sif-keywords/subscriptions", {
      method: "POST",
      body: { asin: selectedSifAsin, keywords, type }
    });
    if (type === 1) $("#sifKeywordDialog").close();
    await refreshSifWorkspace(selectedSifAsin);
    if (result.invalidKeywords?.length) alert(`以下关键词未能添加：\n${result.invalidKeywords.join("\n")}`);
  } finally {
    setBusy(button, false, "添加监控");
  }
}

document.addEventListener("click", event => {
  const asinButton = event.target.closest("[data-sif-asin]");
  if (asinButton) openSifAsin(asinButton.dataset.sifAsin).catch(error => alert(error.message));
  if (event.target.closest("[data-sif-sort-search]")) {
    sifSearchSortDirection = sifSearchSortDirection === "desc" ? "asc" : "desc";
    renderSifRankings();
    return;
  }
  const historyButton = event.target.closest("[data-sif-history-keyword]");
  if (historyButton) openSifKeywordHistory(historyButton.dataset.sifHistoryKeyword);
  if (event.target.closest("[data-sif-scroll-latest]")) {
    event.target.closest(".sif-table-wrap")?.scrollTo({ left: 0, behavior: "smooth" });
  }
  const deleteButton = event.target.closest("[data-sif-keyword]");
  if (deleteButton) {
    const keyword = deleteButton.dataset.sifKeyword;
    if (confirm(`确定停止监控关键词“${keyword}”吗？`)) {
      changeSifKeywordSubscription([keyword], 2).catch(error => alert(error.message));
    }
  }
  if (event.target.closest("[data-close-sif-dialog]")) $("#sifKeywordDialog").close();
  if (event.target.closest("[data-close-sif-history]")) {
    closeSifDetailDatePicker();
    $("#sifHistoryDialog").close();
  }
});

document.addEventListener("pointermove", event => {
  const tooltip = $("#sifChartTooltip");
  const hit = event.target.closest?.("[data-sif-chart-tooltip]");
  if (!hit) {
    tooltip.hidden = true;
    tooltip.dataset.current = "";
    return;
  }
  const encoded = hit.dataset.sifChartTooltip || "";
  if (tooltip.dataset.current !== encoded) {
    try {
      const data = JSON.parse(decodeURIComponent(encoded));
      tooltip.innerHTML = `<strong>${escapeHtml(data.title || "")}</strong><div>${(data.rows || []).map(row => `<span><i style="background:${escapeHtml(row.color || "#64748b")}"></i><b>${escapeHtml(row.label || "")}</b><em>${escapeHtml(row.value || "—")}</em></span>`).join("")}</div>${data.note ? `<small>▲ ${escapeHtml(data.note)}</small>` : ""}`;
      tooltip.dataset.current = encoded;
    } catch {
      tooltip.hidden = true;
      return;
    }
  }
  tooltip.hidden = false;
  const gap = 14;
  const rect = tooltip.getBoundingClientRect();
  const left = Math.min(window.innerWidth - rect.width - 8, Math.max(8, event.clientX + gap));
  const top = event.clientY + gap + rect.height <= window.innerHeight
    ? event.clientY + gap
    : Math.max(8, event.clientY - rect.height - gap);
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
});

document.addEventListener("click", event => {
  const picker = $("#fbaDatePicker");
  if (!picker || picker.hidden) return;
  if (picker.contains(event.target) || event.target?.id === "salesDateRange") return;
  closeDatePicker();
});
document.addEventListener("click", event => {
  const picker = $("#adsDatePicker");
  if (!picker || picker.hidden) return;
  if (picker.contains(event.target) || event.target?.id === "adsDateRange") return;
  closeAdsDatePicker();
});
document.addEventListener("click", event => {
  const picker = $("#adsHistoryDatePicker");
  if (!picker || picker.hidden) return;
  if (picker.contains(event.target) || event.target?.id === "adsHistoryDateRange") return;
  closeAdsHistoryDatePicker();
});
document.addEventListener("click", event => {
  const picker = $("#sifDetailDatePicker");
  if (!picker || picker.hidden) return;
  if (picker.contains(event.target) || event.target?.id === "sifDetailDateRange") return;
  closeSifDetailDatePicker();
});
document.addEventListener("click", event => {
  if (event.target.closest("[data-ads-group-picker]")) return;
  document.querySelectorAll("[data-ads-group-menu]").forEach(menu => { menu.hidden = true; });
  document.querySelectorAll("[data-ads-group-toggle]").forEach(toggle => toggle.setAttribute("aria-expanded", "false"));
});
$("#sifRankingRows").addEventListener("pointerdown", event => startPointerRowDrag(event, {
  rowSelector: "[data-sif-row-keyword]",
  handleSelector: ".sif-keyword-drag",
  idAttr: "sifRowKeyword",
  move: moveSifKeywordRow,
  labelSelector: ".sif-keyword-open strong"
}));
$("#sifRankingRows").addEventListener("pointermove", updatePointerRowDrag);
$("#sifRankingRows").addEventListener("pointerup", finishPointerRowDrag);
$("#sifRankingRows").addEventListener("pointercancel", clearPointerRowDrag);
$("#sifRefreshBtn").addEventListener("click", async () => {
  const button = $("#sifRefreshBtn");
  setBusy(button, true, "同步中");
  try {
    await api("/api/sif-keywords/sync", { method: "POST", body: { asin: selectedSifAsin } });
    await refreshSifWorkspace(selectedSifAsin);
  } catch (error) {
    showSifAuthorization(error.message);
  } finally {
    setBusy(button, false, "刷新数据");
  }
});
$("#sifReauthorizeBtn").addEventListener("click", () => {
  showSifAuthorization("");
  $("#sifAuthStatus").textContent = "更新授权";
  $("#sifCurlInput").focus();
});
$("#sifClearCurlBtn").addEventListener("click", () => {
  $("#sifCurlInput").value = "";
  $("#sifCredentialError").hidden = true;
  $("#sifCurlInput").focus();
});
$("#sifSaveCredentialsBtn").addEventListener("click", () => saveSifCredentials().catch(error => showSifAuthorization(error.message)));
$("#sifKeywordSearch").addEventListener("input", renderSifRankings);
$("#sifAddKeywordBtn").addEventListener("click", () => {
  if (!selectedSifAsin) return alert("请先输入要监控的子 ASIN");
  $("#sifKeywordDialogAsin").textContent = `添加到 ${selectedSifAsin}`;
  $("#sifKeywordsInput").value = "";
  $("#sifKeywordDialog").showModal();
  $("#sifKeywordsInput").focus();
});
$("#sifKeywordForm").addEventListener("submit", event => {
  event.preventDefault();
  const keywords = $("#sifKeywordsInput").value.split(/\r?\n|,/).map(value => value.trim()).filter(Boolean);
  if (!keywords.length) return alert("请至少输入一个关键词");
  changeSifKeywordSubscription(keywords, 1).catch(error => alert(error.message));
});
$("#sifDetailDateRange").addEventListener("click", event => {
  event.stopPropagation();
  openSifDetailDatePicker();
});
$("#sifHistoryQueryBtn").addEventListener("click", () => {
  if (!sifDetailState.startDate || !sifDetailState.endDate) return alert("请选择完整的日期范围");
  loadSifKeywordHistory();
});
$("#sifDetailDatePicker").addEventListener("click", event => {
  event.stopPropagation();
  const nav = event.target?.closest?.("[data-sif-detail-nav]")?.dataset?.sifDetailNav;
  if (nav) {
    sifDetailDatePickerMonth = shiftMonth(sifDetailDatePickerMonth, Number(nav));
    renderSifDetailDatePicker();
    return;
  }
  const quick = event.target?.closest?.("[data-sif-detail-quick]")?.dataset?.sifDetailQuick;
  if (quick) {
    const days = quick === "last7" ? 7 : quick === "last30" ? 30 : 60;
    const endDate = marketplaceToday();
    sifDetailState.startDate = shiftDateValue(endDate, -(days - 1));
    sifDetailState.endDate = endDate;
    sifDetailDatePickerMonth = endDate.slice(0, 7);
    updateSifDetailDateInput();
    closeSifDetailDatePicker();
    return;
  }
  const dayButton = event.target?.closest?.("[data-sif-detail-date]");
  const date = dayButton?.dataset?.sifDetailDate;
  if (!date || !sifDetailDatePickerOpen || dayButton?.disabled || isDateDisabled(date)) return;
  if (!sifDetailState.startDate || sifDetailState.endDate || date < sifDetailState.startDate) {
    sifDetailState.startDate = date;
    sifDetailState.endDate = "";
    sifDetailDatePickerMonth = date.slice(0, 7);
    updateSifDetailDateInput();
    renderSifDetailDatePicker();
    return;
  }
  sifDetailState.endDate = date;
  updateSifDetailDateInput();
  closeSifDetailDatePicker();
});
$("#sifDetailDatePicker").addEventListener("pointerdown", event => event.stopPropagation());
$("#sifHistoryDialog").addEventListener("close", closeSifDetailDatePicker);
$("#globalSearch").addEventListener("input", () => {
  const value = $("#globalSearch").value;
  if (activeModule === "products") {
    $("#productSearch").value = value;
    renderProducts();
  } else if (activeModule === "influencers") {
    $("#search").value = value;
    renderList();
  } else if (activeModule === "inventory") {
    $("#factorySearch").value = value;
    renderFactoryInventory();
  } else if (activeModule === "keywordMonitor") {
    $("#sifKeywordSearch").value = value;
    renderSifRankings();
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
updateDateRangeInput();
updateFbaToolButtons();
loadFbaDateStatus().catch(() => {});
renderStatusOptions();
refreshWorkspace().catch(error => alert(error.message));
setInterval(syncGmailStatuses, 120000);
