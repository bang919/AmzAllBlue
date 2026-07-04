import { createServer } from "node:http";
import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT || 4317);
const ROOT = resolve(".");
const PUBLIC_DIR = join(ROOT, "public");
const DATA_DIR = join(ROOT, "data");
const DB_PATH = join(DATA_DIR, "db.json");
const NETWORK_DEBUG_PATH = join(DATA_DIR, "network-debug.jsonl");
const GMAIL_TOKEN_PATH = join(DATA_DIR, "gmail-token.json");
const ENV_PATH = join(ROOT, ".env");
const fbaInventoryCache = new Map();

function loadEnvFile() {
  if (!existsSync(ENV_PATH)) return;
  const raw = readFileSync(ENV_PATH, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    process.env[key] = rawValue.trim().replace(/^['"]|['"]$/g, "");
  }
}

loadEnvFile();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

const statusLabels = {
  no_email: "未配置邮箱",
  new_creator: "新的红人",
  contacted: "已联系",
  unread_email: "未读邮件",
  read_email: "已读邮件",
  ignored: "忽略"
};

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type"
  };
}

async function ensureDb() {
  await mkdir(DATA_DIR, { recursive: true });
  if (!existsSync(DB_PATH)) {
    await writeFile(DB_PATH, JSON.stringify({ requests: [] }, null, 2), "utf8");
  }
}

async function readDb() {
  await ensureDb();
  const raw = await readFile(DB_PATH, "utf8");
  return JSON.parse(raw || "{\"requests\":[]}");
}

async function writeDb(db) {
  await ensureDb();
  await writeFile(DB_PATH, JSON.stringify(db, null, 2), "utf8");
}

async function appendNetworkDebug(events) {
  await ensureDb();
  const lines = events.map(event => JSON.stringify(event)).join("\n") + "\n";
  await appendFile(NETWORK_DEBUG_PATH, lines, "utf8");
}

async function readNetworkDebug() {
  await ensureDb();
  const events = [];
  if (!existsSync(NETWORK_DEBUG_PATH)) return [];
  const raw = await readFile(NETWORK_DEBUG_PATH, "utf8");
  events.push(...raw
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean));

  try {
    const dbRaw = await readFile(DB_PATH, "utf8");
    const db = JSON.parse(dbRaw || "{}");
    if (Array.isArray(db.networkDebug)) events.push(...db.networkDebug);
  } catch {
    // Ignore legacy debug records if db.json is temporarily invalid.
  }

  return events;
}

function parseChatThreads(events) {
  const byToken = new Map();
  const decodeJsonString = value => {
    try {
      return JSON.parse(`"${value}"`);
    } catch {
      return value;
    }
  };
  const rememberThread = thread => {
    const token = thread.contextValidatorToken || `${thread.actorName}:${thread.lastMsgTimeStamp}`;
    const existing = byToken.get(token);
    if (!existing || Number(thread.lastMsgTimeStamp) > Number(existing.lastMsgTimeStamp)) {
      byToken.set(token, thread);
    }
  };

  for (const event of events) {
    if (!/\/bi\/api\/chat\/get\b/i.test(event.url || "")) continue;
    if (Array.isArray(event.chatThreads)) {
      for (const thread of event.chatThreads) rememberThread(thread);
    }

    let payload;
    try {
      payload = JSON.parse(event.responseText || "{}");
    } catch {
      const raw = event.responseText || "";
      const pattern = /"actorName":"((?:\\.|[^"\\])*)","actorType":"((?:\\.|[^"\\])*)","contextValidatorToken":"((?:\\.|[^"\\])*)","lastReadMsgTimeStamp":(\d+),"lastMsgTimeStamp":(\d+),"actorLogoURL":"((?:\\.|[^"\\])*)","communicationStatus":"((?:\\.|[^"\\])*)","membershipType":"((?:\\.|[^"\\])*)","chatContext":"((?:\\.|[^"\\])*)"/g;
      for (const match of raw.matchAll(pattern)) {
        rememberThread({
          actorName: decodeJsonString(match[1]),
          actorType: decodeJsonString(match[2]),
          contextValidatorToken: decodeJsonString(match[3]),
          lastReadMsgTimeStamp: Number(match[4]),
          lastMsgTimeStamp: Number(match[5]),
          actorLogoURL: decodeJsonString(match[6]),
          communicationStatus: decodeJsonString(match[7]),
          membershipType: decodeJsonString(match[8]),
          chatContext: decodeJsonString(match[9]),
          capturedAt: event.capturedAt || "",
          sourceUrl: event.sourceUrl || "",
          apiUrl: event.url || ""
        });
      }
      continue;
    }

    const responses = Array.isArray(payload.responses) ? payload.responses : [];
    for (const response of responses) {
      const addressGroups = Array.isArray(response.addresses) ? response.addresses : [];
      for (const group of addressGroups) {
        const addressBook = Array.isArray(group.addressBook) ? group.addressBook : [];
        for (const entry of addressBook) {
          rememberThread({
            actorName: entry.actorName || "",
            actorType: entry.actorType || "",
            actorId: group.actorId || "",
            contextValidatorToken: entry.contextValidatorToken || "",
            lastReadMsgTimeStamp: entry.lastReadMsgTimeStamp || 0,
            lastMsgTimeStamp: entry.lastMsgTimeStamp || 0,
            actorLogoURL: entry.actorLogoURL || "",
            communicationStatus: entry.communicationStatus || "",
            membershipType: entry.membershipType || "",
            chatContext: entry.chatContext || "",
            capturedAt: event.capturedAt || "",
            sourceUrl: event.sourceUrl || "",
            apiUrl: event.url || ""
          });
        }
      }
    }
  }

  return [...byToken.values()]
    .sort((a, b) => Number(b.lastMsgTimeStamp || 0) - Number(a.lastMsgTimeStamp || 0));
}

function parseChatConversations(events) {
  const byToken = new Map();

  for (const event of events) {
    if (!/\/bi\/api\/chat\/messages\/list\b/i.test(event.url || "")) continue;
    let payload;
    try {
      payload = JSON.parse(event.responseText || "{}");
    } catch {
      continue;
    }

    const parsedUrl = (() => {
      try {
        return new URL(event.url);
      } catch {
        return null;
      }
    })();
    const contextToken = parsedUrl?.searchParams.get("contextToken") || "";
    const actorName = parsedUrl?.searchParams.get("actorName") || "";
    const responses = Array.isArray(payload.responses) ? payload.responses : [];
    const messages = [];
    let lastReadTimestamp = 0;
    let nextToken = null;

    for (const response of responses) {
      if (Number(response.lastReadTimestamp || 0) > lastReadTimestamp) {
        lastReadTimestamp = Number(response.lastReadTimestamp || 0);
      }
      if (response.nextToken) nextToken = response.nextToken;
      const chatMessages = Array.isArray(response.chatMessages) ? response.chatMessages : [];
      for (const message of chatMessages) {
        messages.push({
          messageId: message.messageId || "",
          content: message.content || "",
          createdTimestamp: message.createdTimestamp || 0,
          lastUpdatedTimestamp: message.lastUpdatedTimestamp || 0,
          senderName: message.sender?.name || "",
          senderId: message.sender?.id || "",
          senderType: message.sender?.type || "",
          status: message.status || ""
        });
      }
    }

    if (!messages.length) continue;
    const existing = byToken.get(contextToken) || {
      contextToken,
      actorName,
      sourceUrl: event.sourceUrl || "",
      apiUrl: event.url || "",
      capturedAt: event.capturedAt || "",
      lastReadTimestamp: 0,
      nextToken: null,
      messages: []
    };

    existing.lastReadTimestamp = Math.max(existing.lastReadTimestamp || 0, lastReadTimestamp);
    existing.nextToken = nextToken || existing.nextToken;
    existing.capturedAt = event.capturedAt || existing.capturedAt;
    existing.apiUrl = event.url || existing.apiUrl;
    const seenIds = new Set(existing.messages.map(message => message.messageId));
    for (const message of messages) {
      if (!seenIds.has(message.messageId)) {
        existing.messages.push(message);
        seenIds.add(message.messageId);
      }
    }
    existing.messages.sort((a, b) => Number(a.createdTimestamp || 0) - Number(b.createdTimestamp || 0));
    byToken.set(contextToken, existing);
  }

  return [...byToken.values()]
    .sort((a, b) => {
      const aLast = a.messages[a.messages.length - 1]?.createdTimestamp || 0;
      const bLast = b.messages[b.messages.length - 1]?.createdTimestamp || 0;
      return Number(bLast) - Number(aLast);
    });
}

function sendJson(res, value, status = 200) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...corsHeaders() });
  res.end(JSON.stringify(value));
}

function parseBody(req) {
  return new Promise((resolveBody, reject) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > 20_000_000) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      if (!raw) return resolveBody({});
      try {
        resolveBody(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
  });
}

function getFirstMatch(text, regex) {
  const match = text.match(regex);
  return match ? match[1].trim() : "";
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map(value => value.trim()))];
}

function cleanUrl(url) {
  return (url || "").replace(/[.,;!?]+$/g, "").trim();
}

function extractUrls(text) {
  return unique(text.match(/https?:\/\/[^\s)]+/gi) || []).map(cleanUrl);
}

function normalizeWebsites(input) {
  const entries = Array.isArray(input.websites)
    ? input.websites.map(site => ({
      key: String(site?.key || "").trim(),
      value: String(site?.value || "").trim()
    }))
    : [];
  const legacyEntries = [
    ["Amazon Storefront", input.storefrontUrl],
    ["YouTube", input.youtubeUrl],
    ["网站", input.websiteUrl],
    ...(Array.isArray(input.socialLinks) ? input.socialLinks.map((url, index) => [`社交链接 ${index + 1}`, url]) : [])
  ].filter(([, value]) => value);

  const seen = new Set(entries.map(site => `${site.key}\n${site.value}`));
  for (const [key, value] of legacyEntries) {
    const site = { key, value: String(value || "").trim() };
    const id = `${site.key}\n${site.value}`;
    if (site.value && !seen.has(id)) {
      entries.push(site);
      seen.add(id);
    }
  }
  return entries.filter(site => site.key || site.value);
}

function parseNumberLike(value) {
  if (!value) return "";
  return value.replace(/\s+/g, " ").trim();
}

function extractAddress(text) {
  const patterns = [
    /(?:Please\s+ship\s+to|Ship\s+to|ship\s+to):?\s*([\s\S]{1,350}?)(?:\n\s*---|\n\s*[^\n]{1,80}\(\d{4}[/-]\d{1,2}[/-]\d{1,2}|\n\s*(?:Because|Feel free|YouTube|Storefront|Thank you|Thanks|Looking forward)\b|$)/i,
    /(?:please\s+send\s+to|send\s+to)\s+([\s\S]{1,300}?)(?:\n\s*---|\n\s*[^\n]{1,80}\(\d{4}[/-]\d{1,2}[/-]\d{1,2}|\n\s*(?:Here is|Thank you|Thanks|Looking forward)\b|$)/i,
    /(?:my address is|my address|shipping address|address):?\s*([\s\S]{1,300}?)(?:\n\s*---|\n\s*[^\n]{1,80}\(\d{4}[/-]\d{1,2}[/-]\d{1,2}|\n\s*(?:Thank you|Thanks|Looking forward)\b|$)/i
  ];
  for (const pattern of patterns) {
    const value = getFirstMatch(text, pattern)
      .replace(/\s+/g, " ")
      .split(/\b(?:Because|Feel free|YouTube|Storefront|Thank you|Thanks|Looking forward)\b/i)[0]
      .replace(/\.$/, "")
      .trim();
    if (value) return value;
  }
  return "";
}

function extractMessageInsights(text) {
  const chunks = text.split(/\n\s*---\s*\n/g).map(chunk => chunk.trim()).filter(Boolean);
  const lastChunk = chunks[chunks.length - 1] || text;
  const lastMessageFrom = /Kanrichu\s*(?:（您）|\(You\))|Kanrichu\s+\(You\)|\bKanrichu\b/i.test(lastChunk) ? "us" : "creator";
  const requestedAsins = unique(text.match(/\bB0[A-Z0-9]{8}\b/gi) || []).map(asin => asin.toUpperCase());
  const publishedUrls = unique((text.match(/https:\/\/www\.amazon\.com\/(?:vdp|live\/video)\/[^\s,，）)]+/gi) || []).map(cleanUrl));
  const wantsMoreProducts = /future collaborations|future collaboration|more products|next Creator Connections|stay on your radar|work together again|promote more products/i.test(text);
  const hasFollowup = /follow(?:ing)? up|just checking|checking in|any update|wanted to see/i.test(text);
  const hasShipmentByUs = /processed the shipment|sent out|shipped|tracking number|sample sent/i.test(text);
  const askedVariant = getFirstMatch(text, /(?:go with|prefer|like|choose|larger size in|larger model)\s+([^\.\n]{1,120})/i);
  const wantsSample = /sample|demo product|send(?:ing)? (?:a )?sample|ship to|please send to|please ship to/i.test(text);

  let autoStage = "new_request";
  let actionSuggestion = "先评估红人质量和产品匹配度，再决定是否寄样。";
  let recommendedStatus = "reviewing";

  if (publishedUrls.length) {
    autoStage = wantsMoreProducts ? "published_wants_more" : "published";
    recommendedStatus = "published";
    actionSuggestion = wantsMoreProducts
      ? "已发布内容并表示愿意继续合作。建议标记为优质红人，选择下一款产品继续合作。"
      : "已发布内容。建议记录视频链接，并检查是否覆盖目标 ASIN。";
  } else if (hasShipmentByUs) {
    autoStage = "waiting_video";
    recommendedStatus = "waiting_video";
    actionSuggestion = lastMessageFrom === "creator"
      ? "样品已处理且对方有回复。建议确认是否需要补充物流，或继续等待发布。"
      : "样品已处理。建议设置 14-21 天后的跟进提醒，等待视频发布。";
  } else if (wantsSample && extractAddress(text)) {
    autoStage = "ready_to_ship";
    recommendedStatus = "ready_to_ship";
    actionSuggestion = "对方已提供收货信息。建议确认产品和颜色后安排寄样。";
  } else if (hasFollowup) {
    autoStage = "needs_reply";
    recommendedStatus = "reviewing";
    actionSuggestion = "对方在催回复。建议尽快决定是否合作，并发送接受或婉拒邮件。";
  }

  return {
    requestedAsins,
    requestedVariant: askedVariant,
    publishedUrls,
    autoStage,
    recommendedStatus,
    actionSuggestion,
    lastMessageFrom
  };
}

function localExtract(rawText) {
  const text = rawText || "";
  const urls = extractUrls(text);
  const insights = extractMessageInsights(text);
  const firstLineName = (text.split("\n").map(line => line.trim()).find(Boolean) || "")
    .replace(/\s+\d{1,2}:\d{2}\s*(?:AM|PM)?$/i, "")
    .trim();
  const asin = getFirstMatch(text, /\b(?:ASIN\s*)?(B0[A-Z0-9]{8})\b/i);
  const productUrl = urls.find(url => /amazon\.[^/]+\/(?:dp|gp\/product)\//i.test(url)) || "";
  const youtubeUrl = urls.find(url => /youtube\.com|youtu\.be/i.test(url)) || "";
  const storefrontUrl = urls.find(url => /amazon\.[^/]+\/(?:shop|store)\//i.test(url) || /amzn\.to\//i.test(url)) || "";
  const websiteUrl = urls.find(url => !/amazon\.|youtube\.|youtu\.be/i.test(url)) || "";
  const email = getFirstMatch(text, /([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i);
  const name = getFirstMatch(text, /my name is\s+([^,.!\n]+)/i)
    || getFirstMatch(text, /(?:Attn|Attention):\s*([^,\n]+)/i)
    || (/^(?:K|Kanrichu|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/i.test(firstLineName) ? "" : firstLineName);
  const rawBrand = getFirstMatch(text, /\bat\s+([^\.\n]+?)\s*(?:\.|I run|,)/i);
  const brand = /^(items|products|the larger size|the larger model)$/i.test(rawBrand) ? "" : rawBrand;
  const address = extractAddress(text);
  const subscriberCount = parseNumberLike(
    getFirstMatch(text, /([\d,.]+\s*(?:k|m)?(?:\+)?[-\s]*(?:subscriber|subscribers|followers|订阅者|粉丝))/i)
  );
  const audience = getFirstMatch(text, /(?:audience|viewers|community)\s+(?:are|is)\s+([^\.\n]+)/i);
  const contentPromise = getFirstMatch(text, /(create\s+(?:a\s+)?(?:shoppable\s+)?video[^\.\n]*|feature it[^\.\n]*|film and promote[^\.\n]*)/i);

  const scoreParts = [
    youtubeUrl ? 20 : 0,
    storefrontUrl ? 15 : 0,
    address ? 20 : 0,
    asin || productUrl ? 15 : 0,
    subscriberCount ? 10 : 0,
    audience ? 10 : 0,
    contentPromise ? 10 : 0
  ];
  const score = scoreParts.reduce((sum, part) => sum + part, 0);
  const reasons = [];
  if (youtubeUrl) reasons.push("提供了 YouTube 渠道");
  if (storefrontUrl) reasons.push("提供了 Amazon Storefront");
  if (address) reasons.push("提供了完整或近似完整的寄样地址");
  if (asin || productUrl) reasons.push("明确了目标产品");
  if (subscriberCount) reasons.push(`提到规模：${subscriberCount}`);
  if (!email) reasons.push("邮箱暂未提取，可能需要手动展开后补入");

  return {
    influencerName: name,
    brandName: brand,
    email,
    phone: "",
    shippingAddress: address,
    country: /United States|USA|\bWV\b|\bCA\b|\bNY\b|\bTX\b/i.test(text) ? "United States" : "",
    asin,
    productUrl,
    storefrontUrl,
    youtubeUrl,
    websiteUrl,
    websites: normalizeWebsites({ storefrontUrl, youtubeUrl, websiteUrl }),
    socialLinks: urls.filter(url => url !== productUrl && url !== storefrontUrl && url !== youtubeUrl && url !== websiteUrl),
    audience,
    contentPromise,
    followerCount: subscriberCount,
    aiScore: score,
    aiReason: reasons.join("；") || "已用本地规则完成基础提取",
    requestedAsins: insights.requestedAsins,
    requestedVariant: insights.requestedVariant,
    autoStage: insights.autoStage,
    actionSuggestion: insights.actionSuggestion,
    lastMessageFrom: insights.lastMessageFrom,
    publishedUrl: insights.publishedUrls.join("\n")
  };
}

function normalizeRequest(input) {
  const now = new Date().toISOString();
  const websites = normalizeWebsites(input);
  const status = normalizeWorkflowStatus(input);
  return {
    id: input.id || randomUUID(),
    createdAt: input.createdAt || now,
    updatedAt: now,
    status,
    rawText: input.rawText || "",
    sourceUrl: input.sourceUrl || "",
    influencerName: input.influencerName || "",
    brandName: input.brandName || "",
    email: input.email || "",
    phone: input.phone || "",
    shippingAddress: input.shippingAddress || "",
    country: input.country || "",
    asin: input.asin || "",
    productUrl: input.productUrl || "",
    storefrontUrl: input.storefrontUrl || "",
    youtubeUrl: input.youtubeUrl || "",
    websiteUrl: input.websiteUrl || "",
    websites,
    socialLinks: Array.isArray(input.socialLinks) ? input.socialLinks : [],
    audience: input.audience || "",
    contentPromise: input.contentPromise || "",
    followerCount: input.followerCount || "",
    aiScore: Number(input.aiScore || 0),
    aiReason: input.aiReason || "",
    notes: input.notes || "",
    trackingNumber: input.trackingNumber || "",
    shippedAt: input.shippedAt || "",
    followupAt: input.followupAt || "",
    publishedUrl: input.publishedUrl || "",
    requestedAsins: Array.isArray(input.requestedAsins) ? input.requestedAsins : [],
    requestedVariant: input.requestedVariant || "",
    autoStage: input.autoStage || "",
    actionSuggestion: input.actionSuggestion || "",
    lastMessageFrom: input.lastMessageFrom || "",
    sourceType: input.sourceType || "",
    conversationName: input.conversationName || "",
    conversationDate: input.conversationDate || "",
    conversationRaw: input.conversationRaw || "",
    rawTextChinese: input.rawTextChinese || "",
    emailStatus: input.emailStatus || "",
    emailThreadId: input.emailThreadId || "",
    lastEmailAt: input.lastEmailAt || "",
    emailLastReadAt: input.emailLastReadAt || "",
    emailMessages: Array.isArray(input.emailMessages) ? input.emailMessages : [],
    emailLastError: input.emailLastError || "",
    emailLastErrorAt: input.emailLastErrorAt || "",
    important: Boolean(input.important)
  };
}

function normalizeProduct(input) {
  const asin = String(input.asin || "").trim().toUpperCase();
  return {
    id: input.id || asin || randomUUID(),
    asin,
    sku: String(input.sku || "").trim(),
    title: String(input.title || input.itemName || "").trim(),
    brand: String(input.brand || "").trim(),
    imageUrl: String(input.imageUrl || "").trim(),
    price: input.price === "" || input.price === undefined ? "" : Number(input.price),
    currency: String(input.currency || "USD").trim(),
    status: String(input.status || "active").trim(),
    inventory: input.inventory === "" || input.inventory === undefined ? "" : Number(input.inventory),
    source: String(input.source || "local").trim(),
    marketplaceId: String(input.marketplaceId || "").trim(),
    updatedAt: input.updatedAt || new Date().toISOString(),
    raw: input.raw || null
  };
}

function requestAsins(item) {
  return unique([
    item.asin,
    ...(Array.isArray(item.requestedAsins) ? item.requestedAsins : [])
  ].map(value => String(value || "").toUpperCase()).filter(value => /^B[A-Z0-9]{9}$/.test(value)));
}

function inferProductTitle(asin, requests) {
  const pattern = new RegExp(`([^\\n.。]{8,120})\\s*\\(?${asin}\\)?`, "i");
  const generic = /\b(?:your product|product page|creator connections|interested in|came across|shoppable review|shoppable video|promote your product|these products|sending two|different versions|guarantee|collaborate)\b/i;
  for (const item of requests) {
    const raw = String(item.rawText || item.conversationRaw || "");
    const match = raw.match(pattern);
    if (match?.[1]) {
      const title = match[1]
        .replace(/(?:your product|product page|ASIN|for|saw|interested in|products?:)$/ig, "")
        .replace(/^[\s:：,，.-]+|[\s:：,，.-]+$/g, "")
        .slice(-90)
        .trim();
      if (
        title
        && !generic.test(title)
        && /^[A-Z0-9]/.test(title)
        && !/\b(?:ASIN|product|page|with the)$/i.test(title)
        && /\b[A-Z][A-Za-z0-9-]{2,}\b/.test(title)
      ) return title;
    }
  }
  return "";
}

function buildProductsFromDb(db) {
  const requests = Array.isArray(db.requests) ? db.requests.map(item => normalizeRequest(item)) : [];
  const manualProducts = Array.isArray(db.products) ? db.products.map(item => normalizeProduct(item)) : [];
  const byAsin = new Map(manualProducts.filter(item => item.asin).map(item => [item.asin, item]));

  for (const requestItem of requests) {
    for (const asin of requestAsins(requestItem)) {
      if (!byAsin.has(asin)) {
        byAsin.set(asin, normalizeProduct({
          asin,
          title: `Amazon 商品 ${asin}`,
          source: "local",
          updatedAt: requestItem.createdAt || new Date().toISOString()
        }));
      }
    }
  }

  return [...byAsin.values()]
    .map(product => {
      const relatedRequests = requests.filter(item => requestAsins(item).includes(product.asin));
      const shipped = relatedRequests.filter(item => item.trackingNumber || item.shippedAt || ["waiting_video", "published", "published_wants_more"].includes(item.autoStage)).length;
      const published = relatedRequests.filter(item => ["published", "published_wants_more"].includes(item.autoStage) || item.publishedUrl).length;
      const waiting = relatedRequests.filter(item => item.autoStage === "waiting_video").length;
      const important = relatedRequests.filter(item => item.important).length;
      return {
        ...product,
        title: product.title || `Amazon 商品 ${product.asin}`,
        metrics: {
          influencerCount: relatedRequests.length,
          shipped,
          waiting,
          published,
          important
        },
        creators: relatedRequests.map(item => ({
          id: item.id,
          name: item.conversationName || item.influencerName || item.brandName || "未命名红人",
          email: item.email || "",
          status: item.status || "",
          stage: item.autoStage || "",
          aiScore: item.aiScore || 0,
          trackingNumber: item.trackingNumber || "",
          publishedUrl: item.publishedUrl || "",
          createdAt: item.createdAt || ""
        }))
      };
    })
    .sort((a, b) => Number(b.metrics.influencerCount || 0) - Number(a.metrics.influencerCount || 0) || a.asin.localeCompare(b.asin));
}

function parseAmazonSandboxCredentials() {
  const rawCredentials = process.env.AMZ_SANDBOX_CREDENTIALS || "";
  const refreshToken = process.env.AMZ_SANDBOX_TOKEN || "";
  const result = {
    configured: Boolean(rawCredentials && refreshToken),
    clientId: "",
    clientSecret: "",
    refreshToken
  };
  if (!rawCredentials) return result;
  try {
    const parsed = JSON.parse(rawCredentials);
    result.clientId = parsed.clientId || parsed.client_id || parsed.lwaClientId || "";
    result.clientSecret = parsed.clientSecret || parsed.client_secret || parsed.lwaClientSecret || "";
    return result;
  } catch {
    const [clientId, clientSecret = ""] = rawCredentials.split(":");
    result.clientId = clientId || rawCredentials;
    result.clientSecret = clientSecret;
    return result;
  }
}

async function getAmazonSandboxAccessToken() {
  const credentials = parseAmazonSandboxCredentials();
  if (!credentials.configured) {
    return { ok: false, configured: false, error: "AMZ_SANDBOX_CREDENTIALS / AMZ_SANDBOX_TOKEN 未配置完整" };
  }
  if (!credentials.clientId || !credentials.clientSecret) {
    return {
      ok: false,
      configured: true,
      error: "AMZ_SANDBOX_CREDENTIALS 需要包含 clientId 和 clientSecret，支持 JSON 或 clientId:clientSecret"
    };
  }

  const response = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credentials.refreshToken,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    return { ok: false, configured: true, error: data.error_description || data.error || `Amazon LWA ${response.status}` };
  }
  return { ok: true, configured: true, accessToken: data.access_token };
}

async function syncAmazonSandboxProducts(db) {
  const token = await getAmazonSandboxAccessToken();
  if (!token.ok) return { ...token, imported: 0, products: buildProductsFromDb(db) };

  const marketplaceId = process.env.AMZ_SANDBOX_MARKETPLACE_ID || "ATVPDKIKX0DER";
  const endpoint = process.env.AMZ_SANDBOX_ENDPOINT || "https://sandbox.sellingpartnerapi-na.amazon.com";
  const response = await fetch(`${endpoint}/catalog/2022-04-01/items?marketplaceIds=${encodeURIComponent(marketplaceId)}&keywords=sample&pageSize=10`, {
    headers: {
      "x-amz-access-token": token.accessToken,
      "accept": "application/json"
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { ok: false, configured: true, error: data.errors?.[0]?.message || `Amazon sandbox ${response.status}`, imported: 0, products: buildProductsFromDb(db) };
  }

  const incoming = (data.items || []).map(item => normalizeProduct({
    asin: item.asin,
    title: item.summaries?.[0]?.itemName || item.attributes?.item_name?.[0]?.value || "",
    brand: item.summaries?.[0]?.brand || "",
    imageUrl: item.images?.[0]?.images?.[0]?.link || "",
    marketplaceId,
    source: "sandbox",
    raw: item
  })).filter(item => item.asin);

  const byAsin = new Map((Array.isArray(db.products) ? db.products : []).map(item => {
    const normalized = normalizeProduct(item);
    return [normalized.asin, normalized];
  }));
  for (const product of incoming) byAsin.set(product.asin, product);
  db.products = [...byAsin.values()];
  await writeDb(db);
  return { ok: true, configured: true, imported: incoming.length, products: buildProductsFromDb(db) };
}

function getSpApiConfig() {
  const config = {
    clientId: process.env.AMZ_LWA_CLIENT_ID || "",
    clientSecret: process.env.AMZ_LWA_CLIENT_SECRET || "",
    refreshToken: process.env.AMZ_REFRESH_TOKEN || "",
    endpoint: (process.env.AMZ_SP_API_ENDPOINT || "https://sellingpartnerapi-na.amazon.com").replace(/\/+$/, ""),
    region: process.env.AMZ_SP_API_REGION || "us-east-1",
    marketplaceId: process.env.AMZ_MARKETPLACE_ID || "ATVPDKIKX0DER",
    sellerId: process.env.AMZ_SELLER_ID || ""
  };
  const missing = [];
  if (!config.clientId) missing.push("AMZ_LWA_CLIENT_ID");
  if (!config.clientSecret) missing.push("AMZ_LWA_CLIENT_SECRET");
  if (!config.refreshToken) missing.push("AMZ_REFRESH_TOKEN");
  if (!config.endpoint) missing.push("AMZ_SP_API_ENDPOINT");
  if (!config.region) missing.push("AMZ_SP_API_REGION");
  if (!config.marketplaceId) missing.push("AMZ_MARKETPLACE_ID");
  return { ...config, missing };
}

async function requestSpApiAccessToken() {
  const config = getSpApiConfig();
  if (config.missing.length) {
    return { ok: false, configured: false, config, error: `缺少配置：${config.missing.join(", ")}` };
  }

  const response = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: config.refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    return {
      ok: false,
      configured: true,
      config,
      status: response.status,
      error: data.error_description || data.error || `LWA token request failed: ${response.status}`
    };
  }
  return {
    ok: true,
    configured: true,
    config,
    accessToken: data.access_token,
    tokenType: data.token_type || "bearer",
    expiresIn: data.expires_in || 0
  };
}

async function checkSpApiStatus() {
  const token = await requestSpApiAccessToken();
  const publicConfig = {
    endpoint: token.config?.endpoint || "",
    region: token.config?.region || "",
    marketplaceId: token.config?.marketplaceId || "",
    sellerIdConfigured: Boolean(token.config?.sellerId),
    missing: token.config?.missing || []
  };
  if (!token.ok) {
    return {
      ok: false,
      configured: token.configured,
      config: publicConfig,
      lwa: { ok: false, status: token.status || 0, error: token.error }
    };
  }

  const sellersUrl = `${token.config.endpoint}/sellers/v1/marketplaceParticipations`;
  const response = await fetch(sellersUrl, {
    headers: {
      "accept": "application/json",
      "host": new URL(token.config.endpoint).host,
      "user-agent": "AmzAllBlue/0.1 (Language=JavaScript)",
      "x-amz-access-token": token.accessToken,
      "x-amz-date": new Date().toISOString().replace(/[:-]|\.\d{3}/g, "")
    }
  });
  const data = await response.json().catch(() => ({}));
  const marketplaces = Array.isArray(data.payload)
    ? data.payload.map(entry => ({
      marketplaceId: entry.marketplace?.id || "",
      countryCode: entry.marketplace?.countryCode || "",
      name: entry.marketplace?.name || "",
      participating: Boolean(entry.participation?.isParticipating),
      suspended: Boolean(entry.participation?.hasSuspendedListings)
    }))
    : [];

  return {
    ok: response.ok,
    configured: true,
    config: publicConfig,
    lwa: { ok: true, expiresIn: token.expiresIn, tokenType: token.tokenType },
    sellers: {
      ok: response.ok,
      status: response.status,
      marketplaces,
      error: response.ok ? "" : (data.errors?.[0]?.message || data.message || JSON.stringify(data).slice(0, 500))
    }
  };
}

function toIsoDateStart(value) {
  const input = value || new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  return `${input.slice(0, 10)}T00:00:00Z`;
}

function toIsoDateEnd(value) {
  const input = value || new Date().toISOString().slice(0, 10);
  return `${input.slice(0, 10)}T23:59:59Z`;
}

function daysBetweenInclusive(startDate, endDate) {
  const start = new Date(`${startDate.slice(0, 10)}T00:00:00Z`);
  const end = new Date(`${endDate.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 1;
  return Math.max(1, Math.round((end - start) / 86400000) + 1);
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function spApiFetch(pathname, params = {}, options = {}) {
  const token = await requestSpApiAccessToken();
  if (!token.ok) throw new Error(token.error || "SP-API LWA token failed");
  const url = new URL(pathname, token.config.endpoint);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  });
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      "accept": "application/json",
      "content-type": "application/json",
      "host": url.host,
      "user-agent": "AmzAllBlue/0.1 (Language=JavaScript)",
      "x-amz-access-token": token.accessToken,
      "x-amz-date": new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""),
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = data.errors?.[0]
      ? `${data.errors[0].code || ""} ${data.errors[0].message || ""} ${data.errors[0].details || ""}`.trim()
      : (data.message || JSON.stringify(data).slice(0, 800) || `SP-API ${response.status}`);
    throw new Error(`${response.status} ${error}`);
  }
  return data;
}

async function spApiFetchWithRetry(pathname, params = {}, options = {}) {
  const retries = Number(options.retries ?? 2);
  const retryDelayMs = Number(options.retryDelayMs ?? 1200);
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await spApiFetch(pathname, params, options);
    } catch (error) {
      const retryable = /\b(429|500|502|503|504)\b|QuotaExceeded|throttl/i.test(error.message || "");
      if (!retryable || attempt === retries) throw error;
      await wait(retryDelayMs * (attempt + 1));
    }
  }
  throw new Error("SP-API request failed");
}

async function fetchFbaInventorySummaries() {
  const config = getSpApiConfig();
  const summaries = [];
  let nextToken = "";
  for (let page = 0; page < 20; page += 1) {
    const params = nextToken
      ? {
        nextToken,
        details: "true",
        granularityType: "Marketplace",
        granularityId: config.marketplaceId,
        marketplaceIds: config.marketplaceId
      }
      : {
        details: "true",
        granularityType: "Marketplace",
        granularityId: config.marketplaceId,
        marketplaceIds: config.marketplaceId
      };
    const data = await spApiFetchWithRetry("/fba/inventory/v1/summaries", params);
    const payload = data.payload || data;
    summaries.push(...(payload.inventorySummaries || []));
    nextToken = payload.nextToken || data.pagination?.nextToken || "";
    if (!nextToken) break;
  }
  return summaries;
}

function findCatalogImageLink(value) {
  if (!value) return "";
  if (Array.isArray(value)) {
    const main = value.find(item => item?.variant === "MAIN" && item?.link);
    if (main?.link) return main.link;
    for (const item of value) {
      const link = findCatalogImageLink(item);
      if (link) return link;
    }
    return "";
  }
  if (typeof value === "object") {
    if (value.variant === "MAIN" && value.link) return value.link;
    if (value.link) return value.link;
    return findCatalogImageLink(value.images);
  }
  return "";
}

async function fetchCatalogDetails(asins) {
  const config = getSpApiConfig();
  const enrichLimit = Number(process.env.AMZ_CATALOG_ENRICH_LIMIT || 300);
  const uniqueAsins = unique(asins).slice(0, Math.max(20, enrichLimit));
  const chunkSize = Math.max(1, Math.min(20, Number(process.env.AMZ_CATALOG_CHUNK_SIZE || 10)));
  const delayMs = Number(process.env.AMZ_CATALOG_DELAY_MS || 250);
  const byAsin = new Map();
  for (let index = 0; index < uniqueAsins.length; index += chunkSize) {
    const identifiers = uniqueAsins.slice(index, index + chunkSize);
    try {
      const data = await spApiFetchWithRetry("/catalog/2022-04-01/items", {
        marketplaceIds: config.marketplaceId,
        identifiers: identifiers.join(","),
        identifiersType: "ASIN",
        includedData: "images,summaries"
      });
      for (const item of data.items || []) {
        const summary = Array.isArray(item.summaries) ? item.summaries[0] : null;
        byAsin.set(item.asin, {
          title: summary?.itemName || "",
          brand: summary?.brand || "",
          imageUrl: findCatalogImageLink(item.images)
        });
      }
    } catch {
      for (const asin of identifiers) {
        try {
          const data = await spApiFetchWithRetry("/catalog/2022-04-01/items", {
            marketplaceIds: config.marketplaceId,
            identifiers: asin,
            identifiersType: "ASIN",
            includedData: "images,summaries"
          }, { retries: 1, retryDelayMs: 1600 });
          const item = (data.items || [])[0];
          if (!item) continue;
          const summary = Array.isArray(item.summaries) ? item.summaries[0] : null;
          byAsin.set(item.asin, {
            title: summary?.itemName || "",
            brand: summary?.brand || "",
            imageUrl: findCatalogImageLink(item.images)
          });
        } catch {
          // Catalog enrichment is useful but should not block inventory.
        }
      }
    }
    if (delayMs > 0 && index + chunkSize < uniqueAsins.length) await wait(delayMs);
  }
  return byAsin;
}

async function fetchOrderItems(orderId) {
  const items = [];
  let nextToken = "";
  for (let page = 0; page < 10; page += 1) {
    const data = await spApiFetchWithRetry(
      `/orders/v0/orders/${encodeURIComponent(orderId)}/orderItems`,
      nextToken ? { NextToken: nextToken } : {},
      { retries: 4, retryDelayMs: 2500 }
    );
    const payload = data.payload || data;
    items.push(...(payload.OrderItems || payload.orderItems || []));
    nextToken = payload.NextToken || payload.nextToken || "";
    if (!nextToken) break;
  }
  return items;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await worker(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

async function fetchSalesBySku(startDate, endDate) {
  const config = getSpApiConfig();
  const bySku = new Map();
  const orders = [];
  const warnings = [];
  let nextToken = "";
  for (let page = 0; page < 20; page += 1) {
    const params = nextToken
      ? { NextToken: nextToken }
      : {
        MarketplaceIds: config.marketplaceId,
        CreatedAfter: toIsoDateStart(startDate),
        CreatedBefore: toIsoDateEnd(endDate),
        OrderStatuses: "Shipped,Unshipped,PartiallyShipped"
      };
    const data = await spApiFetchWithRetry("/orders/v0/orders", params);
    const payload = data.payload || data;
    orders.push(...(payload.Orders || payload.orders || []));
    nextToken = payload.NextToken || payload.nextToken || "";
    if (!nextToken) break;
  }

  const orderItemGroups = await mapWithConcurrency(orders, Number(process.env.AMZ_ORDER_ITEMS_CONCURRENCY || 2), async order => {
    const orderId = order.AmazonOrderId || order.amazonOrderId;
    if (!orderId) return { orderId: "", items: [] };
    try {
      return { orderId, items: await fetchOrderItems(orderId) };
    } catch (error) {
      return { orderId, items: [], error: error.message };
    }
  });

  for (const group of orderItemGroups) {
    const orderId = group.orderId;
    const orderItems = group.items || [];
    if (group.error) {
      warnings.push(`订单 ${orderId} 的明细拉取失败：${group.error}`);
    }
    if (!orderId || !orderItems.length) continue;
    const skusInOrder = new Set();
    for (const item of orderItems) {
      const sku = item.SellerSKU || item.sellerSKU || item.SellerSku || "";
      if (!sku) continue;
      const asin = item.ASIN || item.asin || "";
      const quantity = Number(item.QuantityOrdered || item.quantityOrdered || 0);
      const existing = bySku.get(sku) || { sku, asin, units: 0, orderIds: new Set() };
      existing.units += quantity;
      if (asin && !existing.asin) existing.asin = asin;
      if (!skusInOrder.has(sku)) {
        existing.orderIds.add(orderId);
        skusInOrder.add(sku);
      }
      bySku.set(sku, existing);
    }
  }

  return {
    orderCount: orders.length,
    orderItemErrorCount: warnings.length,
    warnings: warnings.slice(0, 10),
    bySku: new Map([...bySku.entries()].map(([sku, value]) => [sku, {
      sku,
      asin: value.asin,
      units: value.units,
      orders: value.orderIds.size
    }]))
  };
}

function normalizeInventoryRow(summary, sales, catalog, dayCount) {
  const details = summary.inventoryDetails || {};
  const reserved = details.reservedQuantity || {};
  const researching = details.researchingQuantity || {};
  const asin = summary.asin || "";
  const sku = summary.sellerSku || summary.sellerSKU || "";
  const catalogInfo = catalog.get(asin) || {};
  const fulfillable = Number(details.fulfillableQuantity || 0);
  const inboundWorking = Number(details.inboundWorkingQuantity || 0);
  const inboundShipped = Number(details.inboundShippedQuantity || 0);
  const inboundReceiving = Number(details.inboundReceivingQuantity || 0);
  const reservedTotal = Number(reserved.totalReservedQuantity || 0);
  const total = Number(summary.totalQuantity || 0);
  const soldUnits = Number(sales?.units || 0);
  const dailySales = soldUnits / dayCount;
  const coverDays = dailySales > 0 ? Math.floor(fulfillable / dailySales) : null;
  return {
    asin,
    sellerSku: sku,
    fnSku: summary.fnSku || summary.fnSKU || "",
    title: catalogInfo.title || summary.productName || "",
    brand: catalogInfo.brand || "",
    imageUrl: catalogInfo.imageUrl || "",
    condition: summary.condition || "",
    totalQuantity: total,
    inTransitQuantity: inboundShipped + inboundReceiving,
    inboundWorkingQuantity: inboundWorking,
    inboundShippedQuantity: inboundShipped,
    inboundReceivingQuantity: inboundReceiving,
    fulfillableQuantity: fulfillable,
    reservedQuantity: reservedTotal,
    unfulfillableQuantity: Number(details.unfulfillableQuantity || 0),
    researchingQuantity: Number(researching.totalResearchingQuantity || 0),
    salesOrders: Number(sales?.orders || 0),
    salesUnits: soldUnits,
    dailySales: Number(dailySales.toFixed(2)),
    coverDays,
    stockLevel: coverDays === null ? "unknown" : coverDays < 14 ? "low" : coverDays < 30 ? "medium" : "healthy",
    lastUpdatedTime: summary.lastUpdatedTime || ""
  };
}

async function buildFbaInventoryView(startDate, endDate) {
  const config = getSpApiConfig();
  const safeStart = (startDate || new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10)).slice(0, 10);
  const safeEnd = (endDate || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const dayCount = daysBetweenInclusive(safeStart, safeEnd);
  let inventory = [];
  let sales = { orderCount: 0, bySku: new Map() };
  let catalog = new Map();
  const warnings = [];
  try {
    inventory = await fetchFbaInventorySummaries();
  } catch (error) {
    throw new Error(`FBA Inventory 拉取失败：${error.message}`);
  }
  try {
    sales = await fetchSalesBySku(safeStart, safeEnd);
  } catch (error) {
    warnings.push(`Orders 销量拉取失败：${error.message}`);
    sales = { orderCount: 0, bySku: new Map(), orderItemErrorCount: 0, warnings: [] };
  }
  try {
    catalog = await fetchCatalogDetails(inventory.map(item => item.asin).filter(Boolean));
  } catch (error) {
    warnings.push(`Catalog 图片和品名富集失败：${error.message}`);
    catalog = new Map();
  }
  warnings.push(...(sales.warnings || []));
  const rows = inventory.map(summary => {
    const sale = sales.bySku.get(summary.sellerSku || summary.sellerSKU || "") || null;
    return normalizeInventoryRow(summary, sale, catalog, dayCount);
  }).sort((a, b) => b.totalQuantity - a.totalQuantity);

  const totals = rows.reduce((acc, row) => {
    acc.totalQuantity += row.totalQuantity;
    acc.inTransitQuantity += row.inTransitQuantity;
    acc.inboundWorkingQuantity += row.inboundWorkingQuantity;
    acc.fulfillableQuantity += row.fulfillableQuantity;
    acc.reservedQuantity += row.reservedQuantity;
    acc.salesOrders += row.salesOrders;
    acc.salesUnits += row.salesUnits;
    return acc;
  }, {
    totalQuantity: 0,
    inTransitQuantity: 0,
    inboundWorkingQuantity: 0,
    fulfillableQuantity: 0,
    reservedQuantity: 0,
    salesOrders: 0,
    salesUnits: 0
  });

  return {
    range: { startDate: safeStart, endDate: safeEnd, dayCount },
    config: {
      marketplaceId: config.marketplaceId,
      sellerId: config.sellerId,
      endpoint: config.endpoint
    },
    totals,
    warnings,
    sales: {
      orderCount: sales.orderCount || 0,
      orderItemErrorCount: sales.orderItemErrorCount || 0
    },
    rows
  };
}

function normalizeWorkflowStatus(input) {
  const email = String(input.email || "").trim();
  const status = input.status || "";
  if (status === "ignored") return status;
  if (!email) return "no_email";
  if (["new_creator", "contacted", "unread_email", "read_email", "ignored"].includes(status)) return status;
  if (input.lastEmailAt || input.emailThreadId || (Array.isArray(input.emailMessages) && input.emailMessages.length)) {
    return "contacted";
  }
  return "new_creator";
}

function hasNewConversationActivity(existing, candidate) {
  const existingText = String(existing?.conversationRaw || existing?.rawText || "").trim();
  const candidateText = String(candidate?.conversationRaw || candidate?.rawText || "").trim();
  if (candidateText && candidateText !== existingText) return true;

  const existingDate = String(existing?.conversationDate || "").trim();
  const candidateDate = String(candidate?.conversationDate || "").trim();
  return Boolean(candidateDate && candidateDate !== existingDate);
}

function mergeNonEmpty(base, incoming) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(incoming || {})) {
    const isEmptyArray = Array.isArray(value) && value.length === 0;
    if (value === "" || value === null || value === undefined || isEmptyArray) continue;
    merged[key] = value;
  }
  return merged;
}

function conversationToImportMessage(conversation) {
  const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
  const rawText = messages
    .map(message => {
      const time = message.createdTimestamp
        ? new Date(Number(message.createdTimestamp)).toLocaleString("zh-CN", { hour12: false })
        : "";
      return `${message.senderName || "Unknown"}${time ? ` (${time})` : ""}:\n${message.content || ""}`;
    })
    .join("\n\n");
  return {
    conversationName: messages.find(message => message.senderType === "CREATOR")?.senderName || conversation.actorName || "",
    conversationDate: conversation.capturedAt || "",
    sourceUrl: conversation.sourceUrl || conversation.apiUrl || "",
    conversationRaw: rawText,
    rawText,
    notes: `Imported from Amazon chat contextToken=${conversation.contextToken || ""}`
  };
}

async function importMessagePayloads(messages) {
  const db = await readDb();
  const imported = [];

  for (const message of messages) {
    const rawText = message.rawText || message.conversationRaw || "";
    if (!rawText.trim()) continue;
    const extracted = localExtract(rawText);
    const candidate = normalizeRequest({
      ...extracted,
      influencerName: extracted.influencerName || message.conversationName || "",
      rawText,
      rawTextChinese: message.rawTextChinese || "",
      sourceUrl: message.sourceUrl || "",
      sourceType: "amazon_message",
      conversationName: message.conversationName || extracted.influencerName || extracted.brandName || "",
      conversationDate: message.conversationDate || "",
      conversationRaw: message.conversationRaw || rawText,
      notes: message.notes || "",
      publishedUrl: extracted.publishedUrl || unique(rawText.match(/https:\/\/www\.amazon\.com\/(?:vdp|live\/video)\/[^\s,，）)]+/gi) || []).join("\n"),
      status: extracted.autoStage ? extractMessageInsights(rawText).recommendedStatus : "new"
    });
    const existingIndex = db.requests.findIndex(item => {
      const sameConversation = candidate.conversationName && item.conversationName === candidate.conversationName;
      const sameEmail = candidate.email && item.email === candidate.email;
      const sameAddress = candidate.shippingAddress && item.shippingAddress === candidate.shippingAddress;
      return sameConversation || sameEmail || sameAddress;
    });

    if (existingIndex >= 0) {
      const existing = db.requests[existingIndex];
      const shouldWakeIgnored = existing.status === "ignored" && hasNewConversationActivity(existing, candidate);
      db.requests[existingIndex] = normalizeRequest(mergeNonEmpty(db.requests[existingIndex], {
        ...candidate,
        id: existing.id,
        createdAt: existing.createdAt,
        status: shouldWakeIgnored
          ? "unread_email"
          : (["new", "reviewing", ""].includes(existing.status) ? candidate.status : existing.status)
      }));
      imported.push(db.requests[existingIndex]);
    } else {
      db.requests.unshift(candidate);
      imported.push(candidate);
    }
  }

  await writeDb(db);
  return imported;
}

async function callOpenAI(messages, jsonMode = false) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const baseUrl = (process.env.OPENAI_BASE_URL || "https://cc-ai.xyz").replace(/\/+$/, "").replace(/\/v1$/i, "");
  const model = process.env.OPENAI_MODEL || "gpt-5.4";
  const wireApi = (process.env.OPENAI_WIRE_API || "responses").toLowerCase();
  const reasoningEffort = process.env.OPENAI_REASONING_EFFORT || "xhigh";
  const storeResponses = process.env.OPENAI_STORE_RESPONSES === "true";
  const timeoutMs = Number(process.env.OPENAI_TIMEOUT_MS || 120000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    if (wireApi === "responses") {
      const input = messages.map(message => ({
        role: message.role,
        content: [{ type: "input_text", text: message.content }]
      }));
      const body = {
        model,
        input,
        store: storeResponses,
        reasoning: reasoningEffort ? { effort: reasoningEffort } : undefined,
        text: jsonMode ? { format: { type: "json_object" } } : undefined
      };
      const response = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`OpenAI error ${response.status}: ${text.slice(0, 300)}`);
      }
      const data = await response.json();
      return data.output_text
        || data.output?.flatMap(item => item.content || []).map(item => item.text || "").join("")
        || "";
    }

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.2,
        response_format: jsonMode ? { type: "json_object" } : undefined
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI error ${response.status}: ${text.slice(0, 300)}`);
    }
    const data = await response.json();
    return data.choices?.[0]?.message?.content || "";
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`OpenAI request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function callOpenAIChat(messages, jsonMode = false) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const baseUrl = (process.env.OPENAI_BASE_URL || "https://cc-ai.xyz").replace(/\/+$/, "").replace(/\/v1$/i, "");
  const model = process.env.OPENAI_MODEL || "gpt-5.4";
  const timeoutMs = Number(process.env.OPENAI_TIMEOUT_MS || 120000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.1,
        response_format: jsonMode ? { type: "json_object" } : undefined
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI chat error ${response.status}: ${text.slice(0, 300)}`);
    }
    const data = await response.json();
    return data.choices?.[0]?.message?.content || "";
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`OpenAI chat request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function aiExtract(rawText) {
  const fallback = localExtract(rawText);
  const content = await callOpenAI([
    {
      role: "system",
      content: "You extract Amazon influencer sample collaboration requests. Return compact JSON only. Use empty strings for unknown values. Score 0-100 for collaboration quality."
    },
    {
      role: "user",
      content: `Extract fields: influencerName, brandName, email, phone, shippingAddress, country, asin, productUrl, storefrontUrl, youtubeUrl, websiteUrl, socialLinks array, audience, contentPromise, followerCount, aiScore, aiReason.\n\nRequest:\n${rawText}`
    }
  ], true);

  if (!content) return { ...fallback, extractionMode: "local" };
  try {
    return { ...fallback, ...JSON.parse(content), extractionMode: "ai" };
  } catch {
    return { ...fallback, extractionMode: "local", aiReason: `${fallback.aiReason}；AI 返回格式无法解析，已使用本地结果` };
  }
}

function basicStatsAnswer(question, requests) {
  const today = new Date().toISOString().slice(0, 10);
  const todayCount = requests.filter(item => item.createdAt?.slice(0, 10) === today).length;
  const byStatus = requests.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, {});
  const asinMatch = question.match(/B0[A-Z0-9]{8}/i)?.[0]?.toUpperCase();
  const asinItems = asinMatch ? requests.filter(item => item.asin?.toUpperCase() === asinMatch) : [];

  if (/今天|today/i.test(question)) {
    return `今天新增 ${todayCount} 条红人请求。`;
  }
  if (asinMatch) {
    return `${asinMatch} 共有 ${asinItems.length} 条请求。${asinItems.map(item => item.influencerName || item.brandName || "未命名").join("、")}`;
  }
  const statusText = Object.entries(byStatus)
    .map(([status, count]) => `${statusLabels[status] || status}: ${count}`)
    .join("；");
  return `当前共有 ${requests.length} 条请求。${statusText || "暂无状态统计"}。配置 OPENAI_API_KEY 后可以进行更复杂的自然语言分析。`;
}

function preciseLocalAnswer(question, requests) {
  const text = String(question || "").toLowerCase();
  const asksEmail = /email|e-mail|emil|邮箱|邮件/.test(text);
  const asksCount = /多少|几个|几人|count|how many|number/.test(text);
  if (asksEmail && asksCount) {
    const withEmail = requests.filter(item => String(item.email || "").trim());
    const names = withEmail
      .map(item => item.conversationName || item.influencerName || item.email)
      .filter(Boolean);
    return `有 ${withEmail.length} 人有 email。${names.length ? `分别是：${names.join("、")}。` : ""}`;
  }
  return "";
}

async function answerQuestion(question, requests) {
  const localAnswer = preciseLocalAnswer(question, requests);
  if (localAnswer) return localAnswer;

  const compact = requests.map(item => ({
    id: item.id,
    createdAt: item.createdAt,
    status: item.status,
    influencerName: item.influencerName,
    conversationName: item.conversationName,
    email: item.email,
    hasEmail: Boolean(item.email),
    asin: item.asin,
    requestedAsins: item.requestedAsins || [],
    aiScore: item.aiScore,
    hasShippingAddress: Boolean(item.shippingAddress),
    trackingNumber: item.trackingNumber,
    hasTrackingNumber: Boolean(item.trackingNumber),
    followupAt: item.followupAt,
    hasPublishedUrl: Boolean(item.publishedUrl),
    websiteCount: Array.isArray(item.websites) ? item.websites.length : [item.storefrontUrl, item.youtubeUrl, item.websiteUrl].filter(Boolean).length
  }));

  const content = await callOpenAI([
    {
      role: "system",
      content: "You are a local Amazon Creator Connections assistant. Answer in Chinese. Use only the provided compact JSON data. If counting, calculate from the JSON exactly. Be concise."
    },
    {
      role: "user",
      content: `Question: ${question}\n\nRequests JSON:\n${JSON.stringify(compact).slice(0, 60000)}`
    }
  ]);

  return content || basicStatsAnswer(question, requests);
}

async function translateRawText(rawText) {
  if (!rawText.trim()) return "";
  const content = await callOpenAI([
    {
      role: "system",
      content: "Translate Amazon Creator Connections chat messages into natural Simplified Chinese. Preserve speaker names, timestamps, URLs, ASINs, order numbers, and line breaks. Return only the translation."
    },
    {
      role: "user",
      content: rawText
    }
  ]);
  if (!content) {
    throw new Error("未配置 OPENAI_API_KEY，暂时无法自动翻译。");
  }
  return content.trim();
}

async function translateRequestRawText(requestItem) {
  const rawText = requestItem.rawText || requestItem.conversationRaw || "";
  return translateRawText(rawText);
}

function parseJsonPayload(text) {
  const cleaned = String(text || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.search(/[\[{]/);
    const end = Math.max(cleaned.lastIndexOf("]"), cleaned.lastIndexOf("}"));
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }
    throw new Error("AI 返回的翻译 JSON 无法解析");
  }
}

function buildTranslationBatches(items) {
  const batchSize = Math.max(1, Number(process.env.TRANSLATE_BATCH_SIZE || 30));
  const maxChars = Math.max(1000, Number(process.env.TRANSLATE_BATCH_MAX_CHARS || 50000));
  const batches = [];
  let batch = [];
  let chars = 0;

  for (const item of items) {
    const entry = { id: item.id, message: item.message || "" };
    const size = JSON.stringify(entry).length;
    if (batch.length && (batch.length >= batchSize || chars + size > maxChars)) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(entry);
    chars += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

async function translateBatch(batch) {
  const content = await callOpenAIChat([
    {
      role: "system",
      content: "You are a translation engine. Translate each object's message into natural Simplified Chinese. Preserve speaker names, timestamps, URLs, ASINs, order numbers, and line breaks. Return JSON only, shaped exactly as {\"translations\":[{\"id\":\"same id\",\"translation\":\"中文译文\"}]}."
    },
    {
      role: "user",
      content: JSON.stringify(batch)
    }
  ], true);
  if (!content) {
    throw new Error("未配置 OPENAI_API_KEY，暂时无法自动翻译。");
  }
  const parsed = parseJsonPayload(content);
  const rows = Array.isArray(parsed) ? parsed : parsed.translations;
  if (!Array.isArray(rows)) throw new Error("AI 返回的翻译结果不是数组");
  return rows
    .filter(row => row && row.id && typeof row.translation === "string")
    .map(row => ({ id: String(row.id), translation: row.translation.trim() }));
}

async function translateMissingRequestRawTexts(db) {
  let translated = 0;
  const errors = [];
  const translations = [];
  const requests = Array.isArray(db.requests) ? db.requests : [];
  const missing = requests.filter(item => {
    const rawText = item.rawText || item.conversationRaw || "";
    return rawText.trim() && !String(item.rawTextChinese || "").trim();
  }).map(item => ({
    id: item.id,
    message: item.rawText || item.conversationRaw || ""
  }));
  const byId = new Map(requests.map((item, index) => [item.id, { item, index }]));

  for (const batch of buildTranslationBatches(missing)) {
    try {
      const rows = await translateBatch(batch);
      for (const row of rows) {
        const target = byId.get(row.id);
        if (!target || !row.translation) continue;
        requests[target.index] = normalizeRequest({
          ...target.item,
          rawTextChinese: row.translation,
          id: target.item.id,
          createdAt: target.item.createdAt
        });
        target.item = requests[target.index];
        translations.push(row);
        translated += 1;
      }
      const returnedIds = new Set(rows.map(row => row.id));
      for (const entry of batch) {
        if (!returnedIds.has(entry.id)) {
          errors.push({ id: entry.id, name: byId.get(entry.id)?.item.conversationName || "", error: "AI 未返回这条记录的翻译" });
        }
      }
    } catch (error) {
      for (const entry of batch) {
        errors.push({
          id: entry.id,
          name: byId.get(entry.id)?.item.conversationName || "",
          error: error.message || "Translate failed"
        });
      }
    }
  }

  db.requests = requests;
  return { translated, errors, translations };
}

async function translateProvidedRequestRawTexts(db, items) {
  let translated = 0;
  const errors = [];
  const translations = [];
  const requests = Array.isArray(db.requests) ? db.requests : [];
  const byId = new Map(requests.map((item, index) => [item.id, { item, index }]));
  const cleanItems = (Array.isArray(items) ? items : [])
    .map(item => ({
      id: String(item?.id || ""),
      message: String(item?.message || "")
    }))
    .filter(item => item.id && item.message.trim());

  for (const batch of buildTranslationBatches(cleanItems)) {
    try {
      const rows = await translateBatch(batch);
      for (const row of rows) {
        const target = byId.get(row.id);
        if (!target || !row.translation) continue;
        requests[target.index] = normalizeRequest({
          ...target.item,
          rawTextChinese: row.translation,
          id: target.item.id,
          createdAt: target.item.createdAt
        });
        target.item = requests[target.index];
        translations.push(row);
        translated += 1;
      }
      const returnedIds = new Set(rows.map(row => row.id));
      for (const entry of batch) {
        if (!returnedIds.has(entry.id)) {
          errors.push({ id: entry.id, name: byId.get(entry.id)?.item.conversationName || "", error: "AI 未返回这条记录的翻译" });
        }
      }
    } catch (error) {
      for (const entry of batch) {
        errors.push({
          id: entry.id,
          name: byId.get(entry.id)?.item.conversationName || "",
          error: error.message || "Translate failed"
        });
      }
    }
  }

  db.requests = requests;
  return { translated, errors, translations };
}

async function generateEmail(requestItem, intent) {
  const content = await callOpenAI([
    {
      role: "system",
      content: "Write concise professional English emails for Amazon influencer sample collaboration. Include clear next steps. Do not invent tracking numbers or facts."
    },
    {
      role: "user",
      content: `Intent: ${intent}\nRequest data:\n${JSON.stringify(requestItem, null, 2)}`
    }
  ]);

  if (content) return content;
  const name = requestItem.influencerName || requestItem.brandName || "there";
  if (intent === "reject") {
    return `Hi ${name},\n\nThank you for reaching out and for your interest in our product. We appreciate the details you shared about your audience and content.\n\nAt this time, we are not moving forward with additional sample collaborations for this item, but we will keep your information on file for future opportunities.\n\nBest regards,`;
  }
  if (intent === "followup") {
    return `Hi ${name},\n\nI hope you are doing well. I wanted to follow up on the sample we sent for ${requestItem.asin || "our product"} and check whether you have an estimated timeline for the video or storefront content.\n\nPlease feel free to send the published link when it is available.\n\nBest regards,`;
  }
  return `Hi ${name},\n\nThank you for reaching out and sharing details about your audience and content. We would be happy to review this sample collaboration for ${requestItem.asin || "our product"}.\n\nCould you please confirm your best shipping address and email address so we can prepare the next step?\n\nBest regards,`;
}

function gmailConfig() {
  return {
    clientId: process.env.GMAIL_CLIENT_ID || "",
    clientSecret: process.env.GMAIL_CLIENT_SECRET || "",
    redirectUri: process.env.GMAIL_REDIRECT_URI || `http://localhost:${PORT}/api/gmail/callback`
  };
}

function assertGmailConfig() {
  const config = gmailConfig();
  if (!config.clientId || !config.clientSecret || !config.redirectUri) {
    throw new Error("请先在 .env 配置 GMAIL_CLIENT_ID、GMAIL_CLIENT_SECRET、GMAIL_REDIRECT_URI");
  }
  return config;
}

async function readGmailToken() {
  if (!existsSync(GMAIL_TOKEN_PATH)) return null;
  try {
    return JSON.parse(await readFile(GMAIL_TOKEN_PATH, "utf8"));
  } catch {
    return null;
  }
}

async function writeGmailToken(token) {
  await ensureDb();
  await writeFile(GMAIL_TOKEN_PATH, JSON.stringify(token, null, 2), "utf8");
}

function gmailAuthUrl() {
  const config = assertGmailConfig();
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    scope: [
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.modify"
    ].join(" ")
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function exchangeGmailCode(code) {
  const config = assertGmailConfig();
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code"
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error_description || data.error || "Gmail 授权失败");
  await writeGmailToken({
    ...data,
    expires_at: Date.now() + Number(data.expires_in || 3600) * 1000
  });
}

async function getGmailAccessToken() {
  const config = assertGmailConfig();
  const token = await readGmailToken();
  if (!token?.access_token) throw new Error("Gmail 尚未授权");
  if (token.expires_at && token.expires_at > Date.now() + 60_000) return token.access_token;
  if (!token.refresh_token) throw new Error("Gmail 授权已过期，请重新授权");

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: token.refresh_token,
      grant_type: "refresh_token"
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error_description || data.error || "Gmail 刷新授权失败");
  const next = {
    ...token,
    ...data,
    refresh_token: data.refresh_token || token.refresh_token,
    expires_at: Date.now() + Number(data.expires_in || 3600) * 1000
  };
  await writeGmailToken(next);
  return next.access_token;
}

async function gmailFetch(path, options = {}) {
  const accessToken = await getGmailAccessToken();
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(data.error?.message || `Gmail API error ${response.status}`);
  return data;
}

async function markGmailMessagesRead(messageIds = []) {
  const ids = messageIds.filter(Boolean);
  if (!ids.length) return null;
  return gmailFetch("/messages/batchModify", {
    method: "POST",
    body: JSON.stringify({
      ids,
      removeLabelIds: ["UNREAD"]
    })
  });
}

function decodeBase64Url(value = "") {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

function extractGmailText(payload) {
  if (!payload) return "";
  if (payload.body?.data && /^text\/plain/i.test(payload.mimeType || "")) {
    return decodeBase64Url(payload.body.data);
  }
  const parts = Array.isArray(payload.parts) ? payload.parts : [];
  for (const part of parts) {
    const text = extractGmailText(part);
    if (text) return text;
  }
  if (payload.body?.data) return decodeBase64Url(payload.body.data);
  return "";
}

function gmailHeaders(payload) {
  const headers = payload?.headers || [];
  const get = name => headers.find(header => header.name?.toLowerCase() === name)?.value || "";
  return {
    from: get("from"),
    to: get("to"),
    subject: get("subject"),
    date: get("date")
  };
}

async function gmailMessagesForRequest(requestItem) {
  if (!requestItem?.email) return [];
  const query = encodeURIComponent(`from:${requestItem.email} OR to:${requestItem.email}`);
  const listed = await gmailFetch(`/messages?q=${query}&maxResults=10`);
  const messages = [];
  for (const message of listed.messages || []) {
    const full = await gmailFetch(`/messages/${message.id}?format=full`);
    messages.push({
      id: full.id,
      threadId: full.threadId,
      unread: Array.isArray(full.labelIds) && full.labelIds.includes("UNREAD"),
      snippet: full.snippet || "",
      body: extractGmailText(full.payload).slice(0, 5000),
      internalDate: full.internalDate || "",
      ...gmailHeaders(full.payload)
    });
  }
  return messages.sort((a, b) => Number(b.internalDate || 0) - Number(a.internalDate || 0));
}

async function gmailLatestUnreadFrom(email) {
  if (!email) return null;
  const query = encodeURIComponent(`from:${email} is:unread`);
  const listed = await gmailFetch(`/messages?q=${query}&maxResults=1`);
  const message = listed.messages?.[0];
  if (!message) return null;
  const full = await gmailFetch(`/messages/${message.id}?format=metadata`);
  return {
    id: full.id,
    threadId: full.threadId,
    internalDate: Number(full.internalDate || 0)
  };
}

async function syncGmailUnreadStatuses(db) {
  const requests = Array.isArray(db.requests) ? db.requests : [];
  let updated = 0;
  for (let index = 0; index < requests.length; index += 1) {
    const item = requests[index];
    if (!item.email) {
      const normalized = normalizeRequest(item);
      if (normalized.status !== item.status) {
        requests[index] = normalized;
        updated += 1;
      }
      continue;
    }
    const latestUnread = await gmailLatestUnreadFrom(item.email);
    const lastReadTime = item.emailLastReadAt ? new Date(item.emailLastReadAt).getTime() : 0;
    const hasNewUnread = Boolean(latestUnread && Number(latestUnread.internalDate || 0) > lastReadTime);
    const nextStatus = hasNewUnread
      ? "unread_email"
      : (["unread_email", "read_email", "contacted", "ignored"].includes(item.status) ? item.status : "new_creator");
    if (nextStatus !== item.status) {
      requests[index] = normalizeRequest({ ...item, status: nextStatus });
      updated += 1;
    }
  }
  db.requests = requests;
  return updated;
}

function base64Url(value) {
  return Buffer.from(value, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sendGmailMessage({ to, subject, body, threadId }) {
  if (!to) throw new Error("缺少收件人邮箱");
  const raw = [
    `To: ${to}`,
    `Subject: ${subject || ""}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    body || ""
  ].join("\r\n");
  return gmailFetch("/messages/send", {
    method: "POST",
    body: JSON.stringify({
      raw: base64Url(raw),
      threadId: threadId || undefined
    })
  });
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/gmail/auth-url") {
    return sendJson(res, { url: gmailAuthUrl() });
  }

  if (req.method === "GET" && url.pathname === "/api/gmail/callback") {
    const code = url.searchParams.get("code");
    if (!code) return sendJson(res, { error: "Missing Gmail authorization code" }, 400);
    await exchangeGmailCode(code);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<p>Gmail 授权成功，可以关闭此页面并回到工作台。</p>");
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/gmail/status") {
    const configured = Boolean(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET);
    const token = await readGmailToken();
    if (!configured) return sendJson(res, { configured, authorized: false });
    if (!token?.access_token) return sendJson(res, { configured, authorized: false });
    try {
      const profile = await gmailFetch("/profile");
      return sendJson(res, { configured, authorized: true, emailAddress: profile.emailAddress || "" });
    } catch (error) {
      return sendJson(res, { configured, authorized: false, error: error.message });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/gmail/messages") {
    const requestId = url.searchParams.get("requestId") || "";
    const db = await readDb();
    const index = (db.requests || []).findIndex(item => item.id === requestId);
    const requestItem = (db.requests || [])[index];
    if (!requestItem) return sendJson(res, { error: "Not found" }, 404);
    const messages = await gmailMessagesForRequest(requestItem);
    const unreadIds = messages.filter(message => message.unread).map(message => message.id);
    if (unreadIds.length) await markGmailMessagesRead(unreadIds);
    if (messages.length && (requestItem.status === "unread_email" || unreadIds.length)) {
      db.requests[index] = normalizeRequest({
        ...requestItem,
        status: "read_email",
        emailLastReadAt: new Date().toISOString()
      });
      await writeDb(db);
      return sendJson(res, { messages, request: db.requests[index] });
    }
    return sendJson(res, { messages, request: requestItem });
  }

  if (req.method === "POST" && url.pathname === "/api/gmail/sync-status") {
    const db = await readDb();
    const updated = await syncGmailUnreadStatuses(db);
    await writeDb(db);
    return sendJson(res, { updated, requests: db.requests || [] });
  }

  if (req.method === "POST" && url.pathname === "/api/gmail/send") {
    const body = await parseBody(req);
    const db = await readDb();
    const index = (db.requests || []).findIndex(item => item.id === body.requestId);
    if (index === -1) return sendJson(res, { error: "Not found" }, 404);
    const requestItem = db.requests[index];
    const sent = await sendGmailMessage({
      to: body.to || requestItem.email,
      subject: body.subject || "",
      body: body.body || "",
      threadId: body.threadId || requestItem.emailThreadId || ""
    });
    db.requests[index] = normalizeRequest({
      ...requestItem,
      status: "contacted",
      emailStatus: "sent",
      emailThreadId: sent.threadId || requestItem.emailThreadId || "",
      lastEmailAt: new Date().toISOString(),
      emailLastError: "",
      emailLastErrorAt: "",
      emailMessages: [
        ...(requestItem.emailMessages || []),
        {
          id: sent.id || "",
          threadId: sent.threadId || "",
          direction: "outbound",
          to: body.to || requestItem.email,
          subject: body.subject || "",
          body: body.body || "",
          sentAt: new Date().toISOString()
        }
      ]
    });
    await writeDb(db);
    return sendJson(res, { sent, request: db.requests[index] });
  }

  if (req.method === "GET" && url.pathname === "/api/requests") {
    const db = await readDb();
    db.requests = (db.requests || []).map(item => normalizeRequest(item));
    await writeDb(db);
    return sendJson(res, { requests: db.requests || [] });
  }

  if (req.method === "GET" && url.pathname === "/api/products") {
    const db = await readDb();
    return sendJson(res, { products: buildProductsFromDb(db) });
  }

  if (req.method === "GET" && url.pathname === "/api/products/sandbox-status") {
    const credentials = parseAmazonSandboxCredentials();
    return sendJson(res, {
      configured: credentials.configured,
      hasClientId: Boolean(credentials.clientId),
      hasClientSecret: Boolean(credentials.clientSecret),
      hasRefreshToken: Boolean(credentials.refreshToken),
      ready: Boolean(credentials.configured && credentials.clientId && credentials.clientSecret && credentials.refreshToken)
    });
  }

  if (req.method === "GET" && url.pathname === "/api/spapi/status") {
    const result = await checkSpApiStatus();
    return sendJson(res, result, result.lwa?.ok ? 200 : 400);
  }

  if (req.method === "GET" && url.pathname === "/api/fba/inventory") {
    const startDate = url.searchParams.get("startDate") || "";
    const endDate = url.searchParams.get("endDate") || "";
    const refresh = url.searchParams.get("refresh") === "1";
    const cacheKey = `${startDate}:${endDate}:${getSpApiConfig().marketplaceId}`;
    const cacheTtlMs = Number(process.env.AMZ_FBA_CACHE_TTL_MS || 300000);
    const cached = fbaInventoryCache.get(cacheKey);
    if (!refresh && cached && Date.now() - cached.cachedAt < cacheTtlMs) {
      return sendJson(res, { ...cached.data, cached: true, cachedAt: cached.cachedAt });
    }
    const result = await buildFbaInventoryView(startDate, endDate);
    fbaInventoryCache.set(cacheKey, { cachedAt: Date.now(), data: result });
    return sendJson(res, result);
  }

  if (req.method === "POST" && url.pathname === "/api/products/sync-sandbox") {
    const db = await readDb();
    const result = await syncAmazonSandboxProducts(db);
    return sendJson(res, result, result.ok ? 200 : 400);
  }

  if (req.method === "POST" && url.pathname === "/api/extract") {
    const body = await parseBody(req);
    const extracted = await aiExtract(body.rawText || "");
    return sendJson(res, { extracted });
  }

  if (req.method === "POST" && url.pathname === "/api/requests") {
    const body = await parseBody(req);
    const db = await readDb();
    const item = normalizeRequest(body);
    db.requests.unshift(item);
    await writeDb(db);
    return sendJson(res, { request: item }, 201);
  }

  if (req.method === "POST" && url.pathname === "/api/import/messages") {
    const body = await parseBody(req);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const imported = await importMessagePayloads(messages);
    return sendJson(res, { imported });
  }

  if (req.method === "POST" && url.pathname === "/api/debug/network") {
    const body = await parseBody(req);
    const events = Array.isArray(body.events) ? body.events : [body];
    const safeEvents = events.slice(-200).map(event => ({
      capturedAt: new Date().toISOString(),
      sourceUrl: String(event.sourceUrl || "").slice(0, 1000),
      frameUrl: String(event.frameUrl || "").slice(0, 1000),
      type: String(event.type || "").slice(0, 30),
      method: String(event.method || "").slice(0, 20),
      url: String(event.url || "").slice(0, 2000),
      status: Number(event.status || 0),
      requestBody: String(event.requestBody || "").slice(0, 5000),
      responseText: String(event.responseText || "").slice(0, /\/bi\/api\/chat\/(?:get|messages\/list)\b/i.test(event.url || "") ? 1_000_000 : 20_000),
      chatThreads: Array.isArray(event.chatThreads) ? event.chatThreads.slice(0, 500) : undefined
    }));
    await appendNetworkDebug(safeEvents);
    const conversations = parseChatConversations(safeEvents);
    const imported = conversations.length
      ? await importMessagePayloads(conversations.map(conversationToImportMessage))
      : [];
    return sendJson(res, { saved: safeEvents.length, imported: imported.length });
  }

  if (req.method === "GET" && url.pathname === "/api/debug/network") {
    return sendJson(res, { events: await readNetworkDebug() });
  }

  if (req.method === "GET" && url.pathname === "/api/debug/network/summary") {
    const events = await readNetworkDebug();
    const summary = events.reduce((acc, event) => {
      const host = (() => {
        try {
          return event.url ? new URL(event.url).host : "unknown";
        } catch {
          return "unknown";
        }
      })();
      const key = `${event.method || ""} ${host}`;
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    const byType = events.reduce((acc, event) => {
      const key = event.type || "unknown";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    const chat = {
      threadList: events.filter(event => /\/bi\/api\/chat\/get\b/i.test(event.url || "")).length,
      messageListOk: events.filter(event => /\/bi\/api\/chat\/messages\/list\b/i.test(event.url || "") && Number(event.status) === 200).length,
      messageListBadRequest: events.filter(event => /\/bi\/api\/chat\/messages\/list\b/i.test(event.url || "") && Number(event.status) === 400).length,
      bulkStatus: events.filter(event => event.type === "bulk-api-status").slice(-5).map(event => ({
        capturedAt: event.capturedAt,
        responseText: event.responseText
      }))
    };
    return sendJson(res, { summary, byType, chat, count: events.length });
  }

  if (req.method === "GET" && url.pathname === "/api/chat/threads") {
    const events = await readNetworkDebug();
    return sendJson(res, { threads: parseChatThreads(events) });
  }

  if (req.method === "GET" && url.pathname === "/api/chat/conversations") {
    const events = await readNetworkDebug();
    return sendJson(res, { conversations: parseChatConversations(events) });
  }

  if (req.method === "POST" && url.pathname === "/api/requests/translate-missing") {
    const body = await parseBody(req);
    const items = Array.isArray(body) ? body : (Array.isArray(body.items) ? body.items : []);
    const db = await readDb();
    if (!items.length) return sendJson(res, { translated: 0, errors: [], translations: [] });
    const result = await translateProvidedRequestRawTexts(db, items);
    await writeDb(db);
    const status = result.translated ? 200 : 500;
    return sendJson(res, {
      ...result,
      error: result.errors[0]?.error
    }, status);
  }

  const requestMatch = url.pathname.match(/^\/api\/requests\/([^/]+)$/);
  if (requestMatch && req.method === "PUT") {
    const body = await parseBody(req);
    const db = await readDb();
    const index = db.requests.findIndex(item => item.id === requestMatch[1]);
    if (index === -1) return sendJson(res, { error: "Not found" }, 404);
    db.requests[index] = normalizeRequest({ ...db.requests[index], ...body, id: db.requests[index].id, createdAt: db.requests[index].createdAt });
    await writeDb(db);
    return sendJson(res, { request: db.requests[index] });
  }

  const translateMatch = url.pathname.match(/^\/api\/requests\/([^/]+)\/translate$/);
  if (translateMatch && req.method === "POST") {
    const db = await readDb();
    const index = db.requests.findIndex(item => item.id === translateMatch[1]);
    if (index === -1) return sendJson(res, { error: "Not found" }, 404);
    try {
      const rawTextChinese = await translateRequestRawText(db.requests[index]);
      db.requests[index] = normalizeRequest({
        ...db.requests[index],
        rawTextChinese,
        id: db.requests[index].id,
        createdAt: db.requests[index].createdAt
      });
      await writeDb(db);
      return sendJson(res, { request: db.requests[index] });
    } catch (error) {
      return sendJson(res, { error: error.message || "Translate failed" }, 500);
    }
  }

  if (requestMatch && req.method === "DELETE") {
    const db = await readDb();
    const before = db.requests.length;
    db.requests = db.requests.filter(item => item.id !== requestMatch[1]);
    if (db.requests.length === before) return sendJson(res, { error: "Not found" }, 404);
    await writeDb(db);
    return sendJson(res, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/reprocess") {
    const db = await readDb();
    db.requests = (db.requests || []).map(item => {
      const rawText = item.rawText || item.conversationRaw || "";
      if (!rawText) return normalizeRequest(item);
      const extracted = localExtract(rawText);
      const nextStatus = ["new", "reviewing", ""].includes(item.status) && extracted.autoStage
        ? extractMessageInsights(rawText).recommendedStatus
        : item.status;
      return normalizeRequest(mergeNonEmpty(item, {
        ...extracted,
        id: item.id,
        createdAt: item.createdAt,
        status: nextStatus,
        sourceUrl: item.sourceUrl,
        sourceType: item.sourceType,
        conversationName: item.conversationName,
        conversationDate: item.conversationDate,
        conversationRaw: item.conversationRaw || rawText,
        notes: item.notes
      }));
    });
    await writeDb(db);
    return sendJson(res, { requests: db.requests });
  }

  if (req.method === "POST" && url.pathname === "/api/ask") {
    const body = await parseBody(req);
    const db = await readDb();
    const answer = await answerQuestion(body.question || "", db.requests || []);
    return sendJson(res, { answer });
  }

  if (req.method === "POST" && url.pathname === "/api/email") {
    const body = await parseBody(req);
    const email = await generateEmail(body.request || {}, body.intent || "accept");
    return sendJson(res, { email });
  }

  return sendJson(res, { error: "Not found" }, 404);
}

async function serveStatic(req, res, url) {
  const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const target = resolve(PUBLIC_DIR, `.${pathname}`);
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const data = await readFile(target);
    res.writeHead(200, { "content-type": mimeTypes[extname(target)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
    } else {
      await serveStatic(req, res, url);
    }
  } catch (error) {
    sendJson(res, { error: error.message || "Server error" }, 500);
  }
});

await ensureDb();
server.listen(PORT, () => {
  console.log(`Amazon Aggregator running at http://localhost:${PORT}`);
});
