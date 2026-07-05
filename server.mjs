import { createServer } from "node:http";
import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import mysql from "mysql2/promise";

const PORT = Number(process.env.PORT || 4317);
const ROOT = resolve(".");
const PUBLIC_DIR = join(ROOT, "public");
const DATA_DIR = join(ROOT, "data");
const DB_PATH = join(DATA_DIR, "db.json");
const FBA_DAILY_PATH = join(DATA_DIR, "fba-inventory-daily.json");
const NETWORK_DEBUG_PATH = join(DATA_DIR, "network-debug.jsonl");
const GMAIL_TOKEN_PATH = join(DATA_DIR, "gmail-token.json");
const ADS_TOKEN_PATH = join(DATA_DIR, "ads-token.json");
const ADS_PROFILE_PATH = join(DATA_DIR, "ads-profile.json");
const ENV_PATH = join(ROOT, ".env");
const FBA_DATE_MARKER_SKU = "__DATE_MARKER__";
const fbaInventoryCache = new Map();
const salesReportRequests = new Map();
let mysqlPool = null;
let fbaDailySchemaReady = false;
let mysqlDatabaseReady = false;

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

function getMysqlConfig() {
  return {
    enabled: process.env.DB_ENABLED === "1" || process.env.DB_ENABLED === "true",
    host: process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "amz_all_blue"
  };
}

function isMysqlEnabled() {
  return getMysqlConfig().enabled;
}

function getMysqlPool() {
  if (!isMysqlEnabled()) return null;
  if (!mysqlPool) {
    const config = getMysqlConfig();
    mysqlPool = mysql.createPool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      waitForConnections: true,
      connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 5),
      namedPlaceholders: true,
      charset: "utf8mb4"
    });
  }
  return mysqlPool;
}

async function ensureMysqlDatabase() {
  if (!isMysqlEnabled() || mysqlDatabaseReady) return false;
  const config = getMysqlConfig();
  const connection = await mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password
  });
  try {
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${config.database}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    mysqlDatabaseReady = true;
    return true;
  } finally {
    await connection.end();
  }
}

async function ensureFbaDailyMysqlSchema() {
  if (!isMysqlEnabled() || fbaDailySchemaReady) return false;
  await ensureMysqlDatabase();
  const pool = getMysqlPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fba_inventory_daily (
      date DATE NOT NULL,
      marketplace_id VARCHAR(32) NOT NULL,
      seller_sku VARCHAR(128) COLLATE utf8mb4_bin NOT NULL,
      asin VARCHAR(32) DEFAULT '',
      fn_sku VARCHAR(64) DEFAULT '',
      title TEXT,
      brand VARCHAR(255) DEFAULT '',
      image_url TEXT,
      item_condition VARCHAR(64) DEFAULT '',
      amazon_total_quantity INT NOT NULL DEFAULT 0,
      total_goods_quantity INT NOT NULL DEFAULT 0,
      fulfillable_quantity INT NOT NULL DEFAULT 0,
      reserved_quantity INT NOT NULL DEFAULT 0,
      unfulfillable_quantity INT NOT NULL DEFAULT 0,
      inbound_working_quantity INT NOT NULL DEFAULT 0,
      inbound_shipped_quantity INT NOT NULL DEFAULT 0,
      inbound_receiving_quantity INT NOT NULL DEFAULT 0,
      researching_quantity INT NOT NULL DEFAULT 0,
      sales_units INT NOT NULL DEFAULT 0,
      sales_orders INT NOT NULL DEFAULT 0,
      is_sufficient TINYINT(1) NULL,
      inventory_fetched_at DATETIME NULL,
      sales_fetched_at DATETIME NULL,
      frozen_at DATETIME NULL,
      last_updated_time VARCHAR(64) DEFAULT '',
      raw_inventory_json JSON NULL,
      raw_sales_json JSON NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (marketplace_id, seller_sku, date),
      KEY idx_fba_inventory_daily_date (date),
      KEY idx_fba_inventory_daily_asin (asin)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fba_sku_metadata (
      marketplace_id VARCHAR(32) NOT NULL,
      seller_sku VARCHAR(128) COLLATE utf8mb4_bin NOT NULL,
      asin VARCHAR(32) DEFAULT '',
      fn_sku VARCHAR(64) DEFAULT '',
      title TEXT,
      brand VARCHAR(255) DEFAULT '',
      image_url TEXT,
      item_condition VARCHAR(64) DEFAULT '',
      source VARCHAR(32) DEFAULT '',
      last_seen_at DATETIME NULL,
      raw_json JSON NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (marketplace_id, seller_sku),
      KEY idx_fba_sku_metadata_asin (asin)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query("ALTER TABLE fba_inventory_daily MODIFY seller_sku VARCHAR(128) COLLATE utf8mb4_bin NOT NULL").catch(() => {});
  await pool.query("ALTER TABLE fba_sku_metadata MODIFY seller_sku VARCHAR(128) COLLATE utf8mb4_bin NOT NULL").catch(() => {});
  fbaDailySchemaReady = true;
  return true;
}

function toMysqlDateTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function parseMysqlJson(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function calculateTotalGoodsQuantity(row) {
  const values = [
    row.fulfillableQuantity,
    row.reservedQuantity,
    row.unfulfillableQuantity,
    row.inboundWorkingQuantity,
    row.inboundShippedQuantity,
    row.inboundReceivingQuantity
  ];
  if (values.every(value => value === null || value === undefined || value === "")) return null;
  return values.reduce((sum, value) => sum + Number(value || 0), 0);
}

function inventorySnapshotSource(row) {
  if (!row?.inventoryFetchedAt) return "";
  return row.rawInventoryJson?.source || "inventory_summary";
}

function isRealtimeInventorySnapshot(row) {
  const source = inventorySnapshotSource(row);
  return Boolean(source && source !== "ledger_summary");
}

function formatMysqlDate(value) {
  if (value instanceof Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }
  return String(value || "").slice(0, 10);
}

function mysqlRowToFbaDaily(row) {
  const normalized = {
    date: formatMysqlDate(row.date),
    marketplaceId: row.marketplace_id,
    sellerSku: row.seller_sku,
    asin: row.asin || "",
    fnSku: row.fn_sku || "",
    title: row.title || "",
    brand: row.brand || "",
    imageUrl: row.image_url || "",
    condition: row.item_condition || "",
    amazonTotalQuantity: Number(row.amazon_total_quantity || 0),
    totalGoodsQuantity: Number(row.total_goods_quantity || 0),
    fulfillableQuantity: Number(row.fulfillable_quantity || 0),
    reservedQuantity: Number(row.reserved_quantity || 0),
    unfulfillableQuantity: Number(row.unfulfillable_quantity || 0),
    inboundWorkingQuantity: Number(row.inbound_working_quantity || 0),
    inboundShippedQuantity: Number(row.inbound_shipped_quantity || 0),
    inboundReceivingQuantity: Number(row.inbound_receiving_quantity || 0),
    researchingQuantity: Number(row.researching_quantity || 0),
    salesUnits: Number(row.sales_units || 0),
    salesOrders: Number(row.sales_orders || 0),
    isSufficient: row.is_sufficient === null || row.is_sufficient === undefined ? undefined : Boolean(row.is_sufficient),
    inventoryFetchedAt: row.inventory_fetched_at ? new Date(row.inventory_fetched_at).toISOString() : "",
    salesFetchedAt: row.sales_fetched_at ? new Date(row.sales_fetched_at).toISOString() : "",
    frozenAt: row.frozen_at ? new Date(row.frozen_at).toISOString() : "",
    lastUpdatedTime: row.last_updated_time || "",
    rawInventoryJson: parseMysqlJson(row.raw_inventory_json),
    rawSalesJson: parseMysqlJson(row.raw_sales_json)
  };
  const calculatedTotal = calculateTotalGoodsQuantity(normalized);
  if (calculatedTotal !== null && (calculatedTotal > 0 || normalized.totalGoodsQuantity === 0)) {
    normalized.totalGoodsQuantity = calculatedTotal;
  }
  return normalized;
}

function mysqlRowToFbaSkuMetadata(row) {
  return {
    marketplaceId: row.marketplace_id,
    sellerSku: row.seller_sku,
    asin: row.asin || "",
    fnSku: row.fn_sku || "",
    title: row.title || "",
    brand: row.brand || "",
    imageUrl: row.image_url || "",
    condition: row.item_condition || "",
    source: row.source || "",
    lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : "",
    rawJson: parseMysqlJson(row.raw_json)
  };
}

async function readFbaSkuMetadataRows() {
  if (!isMysqlEnabled()) return [];
  await ensureFbaDailyMysqlSchema();
  const pool = getMysqlPool();
  const [rows] = await pool.query("SELECT * FROM fba_sku_metadata");
  return rows.map(mysqlRowToFbaSkuMetadata);
}

function rowHasFbaMetadata(row) {
  return Boolean(row?.marketplaceId && row?.sellerSku && (row.asin || row.fnSku || row.title || row.imageUrl));
}

function mergeSkuDisplayMetadata(primary = {}, fallback = {}) {
  const result = {};
  for (const field of ["asin", "fnSku", "title", "brand", "imageUrl", "condition"]) {
    result[field] = primary[field] || fallback[field] || "";
  }
  return result;
}

async function upsertFbaSkuMetadata(rows, source = "inventory") {
  const metadataRows = [...new Map(rows
    .filter(row => row.sellerSku !== FBA_DATE_MARKER_SKU && rowHasFbaMetadata(row))
    .map(row => [`${row.marketplaceId}|${row.sellerSku}`, row])
  ).values()];
  if (!metadataRows.length) return { inserted: 0, updated: 0 };
  if (!isMysqlEnabled()) return { inserted: 0, updated: 0 };
  await ensureFbaDailyMysqlSchema();
  const pool = getMysqlPool();
  await pool.query(`
    INSERT INTO fba_sku_metadata (
      marketplace_id, seller_sku, asin, fn_sku, title, brand, image_url, item_condition, source, last_seen_at, raw_json
    ) VALUES ?
    ON DUPLICATE KEY UPDATE
      asin = IF(VALUES(asin) <> '', VALUES(asin), asin),
      fn_sku = IF(VALUES(fn_sku) <> '', VALUES(fn_sku), fn_sku),
      title = IF(VALUES(title) <> '', VALUES(title), title),
      brand = IF(VALUES(brand) <> '', VALUES(brand), brand),
      image_url = IF(VALUES(image_url) <> '', VALUES(image_url), image_url),
      item_condition = IF(VALUES(item_condition) <> '', VALUES(item_condition), item_condition),
      source = VALUES(source),
      last_seen_at = VALUES(last_seen_at),
      raw_json = IF(VALUES(raw_json) IS NOT NULL, VALUES(raw_json), raw_json)
  `, [metadataRows.map(row => [
    row.marketplaceId,
    row.sellerSku,
    row.asin || "",
    row.fnSku || "",
    row.title || "",
    row.brand || "",
    row.imageUrl || "",
    row.condition || "",
    source,
    toMysqlDateTime(row.inventoryFetchedAt || row.lastSeenAt || new Date().toISOString()),
    row.rawInventoryJson ? JSON.stringify(row.rawInventoryJson) : (row.rawJson ? JSON.stringify(row.rawJson) : null)
  ])]);
  return { inserted: metadataRows.length, updated: 0 };
}

async function readFbaDailyRowsFromMysql() {
  await ensureFbaDailyMysqlSchema();
  const pool = getMysqlPool();
  const [rows] = await pool.query("SELECT * FROM fba_inventory_daily");
  return rows.map(mysqlRowToFbaDaily);
}

async function writeFbaDailyRowsToMysql(rows) {
  await ensureFbaDailyMysqlSchema();
  const pool = getMysqlPool();
  const uniqueRows = [...new Map(rows.map(row => [makeFbaDailyKey(row), row])).values()];
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query("DELETE FROM fba_inventory_daily");
    if (uniqueRows.length) {
      await connection.query(`
        INSERT INTO fba_inventory_daily (
          date, marketplace_id, seller_sku, asin, fn_sku, title, brand, image_url, item_condition,
          amazon_total_quantity, total_goods_quantity, fulfillable_quantity, reserved_quantity,
          unfulfillable_quantity, inbound_working_quantity, inbound_shipped_quantity, inbound_receiving_quantity,
          researching_quantity, sales_units, sales_orders, is_sufficient, inventory_fetched_at, sales_fetched_at,
          frozen_at, last_updated_time, raw_inventory_json, raw_sales_json
        ) VALUES ?
      `, [uniqueRows.map(row => [
        row.date,
        row.marketplaceId,
        row.sellerSku,
        row.asin || "",
        row.fnSku || "",
        row.title || "",
        row.brand || "",
        row.imageUrl || "",
        row.condition || "",
        Number(row.amazonTotalQuantity || 0),
        calculateTotalGoodsQuantity(row) ?? 0,
        Number(row.fulfillableQuantity || 0),
        Number(row.reservedQuantity || 0),
        Number(row.unfulfillableQuantity || 0),
        Number(row.inboundWorkingQuantity || 0),
        Number(row.inboundShippedQuantity || 0),
        Number(row.inboundReceivingQuantity || 0),
        Number(row.researchingQuantity || 0),
        Number(row.salesUnits || 0),
        Number(row.salesOrders || 0),
        row.isSufficient === undefined ? null : (row.isSufficient ? 1 : 0),
        toMysqlDateTime(row.inventoryFetchedAt),
        toMysqlDateTime(row.salesFetchedAt),
        toMysqlDateTime(row.frozenAt),
        row.lastUpdatedTime || "",
        row.rawInventoryJson ? JSON.stringify(row.rawInventoryJson) : null,
        row.rawSalesJson ? JSON.stringify(row.rawSalesJson) : null
      ])]);
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function ensureFbaDailyStore() {
  await mkdir(DATA_DIR, { recursive: true });
  if (!existsSync(FBA_DAILY_PATH)) {
    await writeFile(FBA_DAILY_PATH, JSON.stringify({ rows: [] }, null, 2), "utf8");
  }
}

function makeFbaDailyKey(row) {
  return [
    String(row.marketplaceId || "").trim(),
    String(row.sellerSku || "").trim(),
    String(row.date || "").slice(0, 10)
  ].join("|");
}

async function readFbaDailyRows() {
  if (isMysqlEnabled()) {
    return readFbaDailyRowsFromMysql();
  }
  await ensureFbaDailyStore();
  const raw = await readFile(FBA_DAILY_PATH, "utf8");
  const data = JSON.parse(raw || "{\"rows\":[]}");
  return Array.isArray(data.rows) ? data.rows : [];
}

async function writeFbaDailyRows(rows) {
  if (isMysqlEnabled()) {
    return writeFbaDailyRowsToMysql(rows);
  }
  await ensureFbaDailyStore();
  rows.sort((a, b) => {
    const dateCompare = String(b.date || "").localeCompare(String(a.date || ""));
    if (dateCompare) return dateCompare;
    return String(a.sellerSku || "").localeCompare(String(b.sellerSku || ""));
  });
  await writeFile(FBA_DAILY_PATH, JSON.stringify({ rows }, null, 2), "utf8");
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

  let response;
  let lastFetchError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      response = await fetchAmazonWithTimeout("https://api.amazon.com/auth/o2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: config.refreshToken,
          client_id: config.clientId,
          client_secret: config.clientSecret
        })
      });
      break;
    } catch (error) {
      lastFetchError = error;
      if (attempt < 3) await wait(700 * attempt);
    }
  }
  if (!response) {
    const cause = lastFetchError?.cause || {};
    const detail = [cause.code, cause.message || lastFetchError?.message].filter(Boolean).join(" ");
    return {
      ok: false,
      configured: true,
      config,
      error: `LWA token 请求失败：${detail || "fetch failed"}`
    };
  }
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

const US_MARKETPLACE_TIME_ZONE = process.env.AMZ_US_MARKETPLACE_TIME_ZONE || "America/Los_Angeles";

function getZonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = {};
  for (const part of parts) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return values;
}

function zonedDateTimeToUtc(dateValue, hour, minute, second, timeZone = US_MARKETPLACE_TIME_ZONE) {
  const [year, month, day] = String(dateValue).slice(0, 10).split("-").map(Number);
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  const zoned = getZonedParts(new Date(utcGuess), timeZone);
  const zonedAsUtc = Date.UTC(zoned.year, zoned.month - 1, zoned.day, zoned.hour, zoned.minute, zoned.second);
  return new Date(utcGuess - (zonedAsUtc - utcGuess));
}

function formatDateInTimeZone(date = new Date(), timeZone = US_MARKETPLACE_TIME_ZONE) {
  const parts = getZonedParts(date, timeZone);
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function addDays(dateValue, amount) {
  const [year, month, day] = String(dateValue).slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + amount)).toISOString().slice(0, 10);
}

function dateRangeInclusive(startDate, endDate) {
  const dates = [];
  let current = startDate.slice(0, 10);
  const end = endDate.slice(0, 10);
  for (let guard = 0; current <= end && guard < 370; guard += 1) {
    dates.push(current);
    current = addDays(current, 1);
  }
  return dates;
}

function isFbaDailyFrozen(dateValue) {
  const today = formatDateInTimeZone();
  return daysBetweenInclusive(dateValue, today) - 1 > 7;
}

function toIsoDateStart(value) {
  const input = value || addDays(formatDateInTimeZone(), -29);
  return zonedDateTimeToUtc(input, 0, 0, 0).toISOString();
}

function toIsoDateEnd(value) {
  const input = value || formatDateInTimeZone();
  return zonedDateTimeToUtc(input, 23, 59, 59).toISOString();
}

function toOrdersCreatedBefore(value) {
  const endOfDay = zonedDateTimeToUtc(value || formatDateInTimeZone(), 23, 59, 59);
  const latestAllowed = new Date(Date.now() - 180000);
  return new Date(Math.min(endOfDay.getTime(), latestAllowed.getTime())).toISOString();
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

function amazonFetchTimeoutMs() {
  return Math.max(3000, Number(process.env.AMZ_SP_API_TIMEOUT_MS || 20000));
}

async function fetchAmazonWithTimeout(resource, init = {}) {
  const controller = new AbortController();
  const timeoutMs = amazonFetchTimeoutMs();
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error(`请求超时（${timeoutMs}ms）`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      fetch(resource, { ...init, signal: init.signal || controller.signal }),
      timeout
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function spApiFetch(pathname, params = {}, options = {}) {
  const token = await requestSpApiAccessToken();
  if (!token.ok) throw new Error(token.error || "SP-API LWA token failed");
  const url = new URL(pathname, token.config.endpoint);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  });
  let response;
  try {
    response = await fetchAmazonWithTimeout(url, {
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
  } catch (error) {
    const cause = error.cause || {};
    const detail = [cause.code, cause.message || error.message].filter(Boolean).join(" ");
    throw new Error(`${pathname} 请求失败：${detail || "fetch failed"}`);
  }
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

function parseFlatReport(text) {
  const lines = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const delimiter = lines[0].includes("\t") ? "\t" : ",";
  const clean = value => String(value ?? "").replace(/^"|"$/g, "").trim();
  const headers = lines[0].split(delimiter).map(header => clean(header).toLowerCase());
  return lines.slice(1).map(line => {
    const values = line.split(delimiter);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = clean(values[index] ?? "");
    });
    return row;
  });
}

function firstReportValue(row, keys) {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return "";
}

async function downloadReportDocument(documentId) {
  const document = await spApiFetchWithRetry(`/reports/2021-06-30/documents/${encodeURIComponent(documentId)}`, {}, { retries: 2 });
  const payload = document.payload || document;
  if (!payload.url) throw new Error("订单报表文档缺少下载 URL");
  let response;
  let lastFetchError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      response = await fetchAmazonWithTimeout(payload.url, { headers: { "user-agent": "AmzAllBlue/0.1" } });
      if (response.ok) break;
      if (![429, 500, 502, 503, 504].includes(response.status)) break;
    } catch (error) {
      lastFetchError = error;
    }
    if (attempt < 3) await wait(700 * attempt);
  }
  if (!response) {
    const cause = lastFetchError?.cause || {};
    const detail = [cause.code, cause.message || lastFetchError?.message].filter(Boolean).join(" ");
    throw new Error(`订单报表文档下载失败：${detail || "fetch failed"}`);
  }
  if (!response.ok) throw new Error(`订单报表文档下载失败：${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (payload.compressionAlgorithm === "GZIP") {
    return gunzipSync(buffer).toString("utf8");
  }
  return buffer.toString("utf8");
}

async function getOrCreateSalesReport(startDate, endDate) {
  const config = getSpApiConfig();
  const reportType = process.env.AMZ_ORDER_REPORT_TYPE || "GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL";
  const key = `${config.marketplaceId}|${reportType}|${startDate}|${endDate}`;
  const existing = salesReportRequests.get(key);
  if (existing?.reportId) return existing;
  const created = await spApiFetchWithRetry("/reports/2021-06-30/reports", {}, {
    method: "POST",
    body: {
      reportType,
      marketplaceIds: [config.marketplaceId],
      dataStartTime: toIsoDateStart(startDate),
      dataEndTime: toOrdersCreatedBefore(endDate)
    },
    retries: 1
  });
  const payload = created.payload || created;
  const reportId = payload.reportId || payload.ReportId;
  if (!reportId) throw new Error("订单报表创建失败：缺少 reportId");
  const item = { reportId, reportType, createdAt: Date.now() };
  salesReportRequests.set(key, item);
  return item;
}

async function waitForReportDocument(report, label) {
  const waitMs = Math.max(5000, Number(process.env.AMZ_REPORT_WAIT_MS || process.env.AMZ_ORDER_REPORT_WAIT_MS || 90000));
  const pollMs = Math.max(3000, Number(process.env.AMZ_REPORT_POLL_MS || process.env.AMZ_ORDER_REPORT_POLL_MS || 6000));
  const deadline = Date.now() + waitMs;
  let latestStatus = "";
  let reportDocumentId = "";
  while (Date.now() <= deadline) {
    const statusData = await spApiFetchWithRetry(`/reports/2021-06-30/reports/${encodeURIComponent(report.reportId)}`, {}, { retries: 1 });
    const payload = statusData.payload || statusData;
    latestStatus = payload.processingStatus || payload.ProcessingStatus || "";
    reportDocumentId = payload.reportDocumentId || payload.ReportDocumentId || "";
    if (latestStatus === "DONE" && reportDocumentId) break;
    if (["CANCELLED", "FATAL"].includes(latestStatus)) {
      throw new Error(`${label}生成失败：${latestStatus}`);
    }
    await wait(pollMs);
  }
  if (!reportDocumentId) {
    throw new Error(`${label}仍在生成（reportId: ${report.reportId}，状态：${latestStatus || "未知"}），稍后再点“查询”会继续复用这个报表。`);
  }
  return reportDocumentId;
}

async function fetchSalesBySkuFromReport(startDate, endDate) {
  const report = await getOrCreateSalesReport(startDate, endDate);
  const reportDocumentId = await waitForReportDocument(report, "订单报表");
  const text = await downloadReportDocument(reportDocumentId);
  const rows = parseFlatReport(text);
  const bySku = new Map();
  const orderIds = new Set();
  for (const row of rows) {
    const sku = firstReportValue(row, ["sku", "seller-sku", "merchant-sku"]);
    if (!sku) continue;
    const orderId = firstReportValue(row, ["amazon-order-id", "order-id"]);
    const asin = firstReportValue(row, ["asin"]);
    const quantity = Number(firstReportValue(row, ["quantity", "quantity-purchased", "qty"]) || 0);
    const existing = bySku.get(sku) || { sku, asin, units: 0, orderIds: new Set() };
    existing.units += Number.isFinite(quantity) ? quantity : 0;
    if (asin && !existing.asin) existing.asin = asin;
    if (orderId) {
      existing.orderIds.add(orderId);
      orderIds.add(orderId);
    }
    bySku.set(sku, existing);
  }
  return {
    source: "reports",
    reportId: report.reportId,
    reportType: report.reportType,
    orderCount: orderIds.size,
    orderItemErrorCount: 0,
    warnings: [],
    bySku: new Map([...bySku.entries()].map(([sku, value]) => [sku, {
      sku,
      asin: value.asin,
      units: value.units,
      orders: value.orderIds.size
    }]))
  };
}

function reportRowMarketplaceDate(row, fallbackDate) {
  const value = firstReportValue(row, [
    "purchase-date",
    "purchase date",
    "payments-date",
    "order-date",
    "order date"
  ]);
  if (!value) return fallbackDate;
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return formatDateInTimeZone(parsed);
  const dateMatch = String(value).match(/^\d{4}-\d{2}-\d{2}/);
  return dateMatch ? dateMatch[0] : fallbackDate;
}

async function fetchSalesByDateSkuFromReport(startDate, endDate) {
  const report = await getOrCreateSalesReport(startDate, endDate);
  const reportDocumentId = await waitForReportDocument(report, "订单报表");
  const text = await downloadReportDocument(reportDocumentId);
  const rows = parseFlatReport(text);
  const dates = dateRangeInclusive(startDate, endDate);
  const requestedDates = new Set(dates);
  const byDate = new Map(dates.map(date => [date, {
    source: "reports",
    reportId: report.reportId,
    reportType: report.reportType,
    orderCount: 0,
    orderItemErrorCount: 0,
    warnings: [],
    bySku: new Map(),
    orderIds: new Set()
  }]));

  for (const row of rows) {
    const date = reportRowMarketplaceDate(row, startDate);
    if (!requestedDates.has(date)) continue;
    const sku = firstReportValue(row, ["sku", "seller-sku", "merchant-sku"]);
    if (!sku) continue;
    const orderId = firstReportValue(row, ["amazon-order-id", "order-id"]);
    const asin = firstReportValue(row, ["asin"]);
    const quantity = Number(firstReportValue(row, ["quantity", "quantity-purchased", "qty"]) || 0);
    const dateItem = byDate.get(date);
    const existing = dateItem.bySku.get(sku) || { sku, asin, units: 0, orderIds: new Set() };
    existing.units += Number.isFinite(quantity) ? quantity : 0;
    if (asin && !existing.asin) existing.asin = asin;
    if (orderId) {
      existing.orderIds.add(orderId);
      dateItem.orderIds.add(orderId);
    }
    dateItem.bySku.set(sku, existing);
  }

  for (const item of byDate.values()) {
    item.orderCount = item.orderIds.size;
    item.bySku = new Map([...item.bySku.entries()].map(([sku, value]) => [sku, {
      sku,
      asin: value.asin,
      units: value.units,
      orders: value.orderIds.size
    }]));
    delete item.orderIds;
  }
  return byDate;
}

async function fetchSalesBySku(startDate, endDate) {
  if ((process.env.AMZ_SALES_SOURCE || "reports").toLowerCase() !== "orders") {
    return fetchSalesBySkuFromReport(startDate, endDate);
  }
  const config = getSpApiConfig();
  const bySku = new Map();
  const orders = [];
  const warnings = [];
  const orderStatuses = process.env.AMZ_ORDER_STATUSES || "Pending,Unshipped,PartiallyShipped,Shipped";
  let nextToken = "";
  for (let page = 0; page < 20; page += 1) {
    const params = nextToken
      ? { NextToken: nextToken }
      : {
        MarketplaceIds: config.marketplaceId,
        CreatedAfter: toIsoDateStart(startDate),
        CreatedBefore: toOrdersCreatedBefore(endDate),
        OrderStatuses: orderStatuses
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
    orderStatuses,
    warnings: warnings.slice(0, 10),
    bySku: new Map([...bySku.entries()].map(([sku, value]) => [sku, {
      sku,
      asin: value.asin,
      units: value.units,
      orders: value.orderIds.size
    }]))
  };
}

function toLedgerIsoDateStart(dateValue) {
  return `${String(dateValue).slice(0, 10)}T00:00:00Z`;
}

function toLedgerIsoDateEnd(dateValue) {
  return `${String(dateValue).slice(0, 10)}T23:59:59Z`;
}

async function getOrCreateLedgerReport(startDate, endDate) {
  const config = getSpApiConfig();
  const reportType = "GET_LEDGER_SUMMARY_VIEW_DATA";
  const key = `${config.marketplaceId}|${reportType}|${startDate}|${endDate}|DAILY|COUNTRY`;
  const existing = salesReportRequests.get(key);
  if (existing?.reportId) return existing;
  const created = await spApiFetchWithRetry("/reports/2021-06-30/reports", {}, {
    method: "POST",
    body: {
      reportType,
      marketplaceIds: [config.marketplaceId],
      dataStartTime: toLedgerIsoDateStart(startDate),
      dataEndTime: toLedgerIsoDateEnd(endDate),
      reportOptions: {
        aggregateByLocation: "COUNTRY",
        aggregatedByTimePeriod: "DAILY"
      }
    },
    retries: 1
  });
  const payload = created.payload || created;
  const reportId = payload.reportId || payload.ReportId;
  if (!reportId) throw new Error("库存账本报表创建失败：缺少 reportId");
  const item = { reportId, reportType, createdAt: Date.now() };
  salesReportRequests.set(key, item);
  return item;
}

function normalizeLedgerDate(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) {
    return `${match[3]}-${String(match[1]).padStart(2, "0")}-${String(match[2]).padStart(2, "0")}`;
  }
  return text.slice(0, 10);
}

function numberFromReport(value) {
  return Number(String(value || "0").replace(/,/g, "")) || 0;
}

async function fetchLedgerInventoryRecords(startDate, endDate) {
  const config = getSpApiConfig();
  const report = await getOrCreateLedgerReport(startDate, endDate);
  const reportDocumentId = await waitForReportDocument(report, "库存账本报表");
  const text = await downloadReportDocument(reportDocumentId);
  const rows = parseFlatReport(text);
  const grouped = new Map();

  for (const row of rows) {
    const date = normalizeLedgerDate(firstReportValue(row, ["date"]));
    const sellerSku = firstReportValue(row, ["msku", "sku", "seller-sku"]);
    if (!date || !sellerSku) continue;
    const key = `${date}|${sellerSku}`;
    const item = grouped.get(key) || {
      date,
      marketplaceId: config.marketplaceId,
      sellerSku,
      asin: firstReportValue(row, ["asin"]),
      fnSku: firstReportValue(row, ["fnsku"]),
      title: firstReportValue(row, ["title", "product-name"]),
      fulfillableQuantity: 0,
      unfulfillableQuantity: 0,
      rawRows: []
    };
    const disposition = firstReportValue(row, ["disposition"]).toUpperCase();
    const ending = numberFromReport(firstReportValue(row, ["ending warehouse balance", "endingwarehousebalance"]));
    if (disposition === "SELLABLE") {
      item.fulfillableQuantity += ending;
    } else {
      item.unfulfillableQuantity += ending;
    }
    if (!item.asin) item.asin = firstReportValue(row, ["asin"]);
    if (!item.fnSku) item.fnSku = firstReportValue(row, ["fnsku"]);
    if (!item.title) item.title = firstReportValue(row, ["title", "product-name"]);
    item.rawRows.push(row);
    grouped.set(key, item);
  }

  return [...grouped.values()].map(item => {
    const fulfillable = Number(item.fulfillableQuantity || 0);
    const unfulfillable = Number(item.unfulfillableQuantity || 0);
    const totalGoods = fulfillable + unfulfillable;
    return {
      date: item.date,
      marketplaceId: item.marketplaceId,
      sellerSku: item.sellerSku,
      asin: item.asin || "",
      fnSku: item.fnSku || "",
      title: item.title || "",
      brand: "",
      imageUrl: "",
      condition: "",
      amazonTotalQuantity: totalGoods,
      totalGoodsQuantity: totalGoods,
      fulfillableQuantity: fulfillable,
      reservedQuantity: 0,
      unfulfillableQuantity: unfulfillable,
      inboundWorkingQuantity: 0,
      inboundShippedQuantity: 0,
      inboundReceivingQuantity: 0,
      researchingQuantity: 0,
      inventoryFetchedAt: new Date().toISOString(),
      lastUpdatedTime: "",
      rawInventoryJson: {
        source: "ledger_summary",
        reportId: report.reportId,
        reportDocumentId,
        rows: item.rawRows
      }
    };
  });
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
  const unfulfillable = Number(details.unfulfillableQuantity || 0);
  const totalGoods = fulfillable + reservedTotal + unfulfillable + inboundWorking + inboundShipped + inboundReceiving;
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
    amazonTotalQuantity: total,
    totalQuantity: totalGoods,
    totalGoodsQuantity: totalGoods,
    inboundWorkingQuantity: inboundWorking,
    inboundShippedQuantity: inboundShipped,
    inboundReceivingQuantity: inboundReceiving,
    fulfillableQuantity: fulfillable,
    reservedQuantity: reservedTotal,
    unfulfillableQuantity: unfulfillable,
    researchingQuantity: Number(researching.totalResearchingQuantity || 0),
    salesOrders: Number(sales?.orders || 0),
    salesUnits: soldUnits,
    dailySales: Number(dailySales.toFixed(2)),
    coverDays,
    stockLevel: coverDays === null ? "unknown" : coverDays < 14 ? "low" : coverDays < 30 ? "medium" : "healthy",
    lastUpdatedTime: summary.lastUpdatedTime || ""
  };
}

function buildInventoryDailyRecord(summary, catalog, date, config) {
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
  const unfulfillable = Number(details.unfulfillableQuantity || 0);
  const totalGoods = fulfillable + reservedTotal + unfulfillable + inboundWorking + inboundShipped + inboundReceiving;
  return {
    date,
    marketplaceId: config.marketplaceId,
    sellerSku: sku,
    asin,
    fnSku: summary.fnSku || summary.fnSKU || "",
    title: catalogInfo.title || summary.productName || "",
    brand: catalogInfo.brand || "",
    imageUrl: catalogInfo.imageUrl || "",
    condition: summary.condition || "",
    amazonTotalQuantity: Number(summary.totalQuantity || 0),
    totalGoodsQuantity: totalGoods,
    fulfillableQuantity: fulfillable,
    reservedQuantity: reservedTotal,
    unfulfillableQuantity: unfulfillable,
    inboundWorkingQuantity: inboundWorking,
    inboundShippedQuantity: inboundShipped,
    inboundReceivingQuantity: inboundReceiving,
    researchingQuantity: Number(researching.totalResearchingQuantity || 0),
    inventoryFetchedAt: new Date().toISOString(),
    lastUpdatedTime: summary.lastUpdatedTime || "",
    rawInventoryJson: summary
  };
}

function buildSalesDailyRecord(sale, date, config) {
  return {
    date,
    marketplaceId: config.marketplaceId,
    sellerSku: sale.sku,
    asin: sale.asin || "",
    salesUnits: Number(sale.units || 0),
    salesOrders: Number(sale.orders || 0),
    salesFetchedAt: new Date().toISOString(),
    rawSalesJson: {
      sku: sale.sku,
      asin: sale.asin || "",
      units: Number(sale.units || 0),
      orders: Number(sale.orders || 0)
    }
  };
}

function buildSalesDateMarkerRecord(date, config, sales) {
  return {
    date,
    marketplaceId: config.marketplaceId,
    sellerSku: FBA_DATE_MARKER_SKU,
    asin: "",
    salesUnits: 0,
    salesOrders: 0,
    salesFetchedAt: new Date().toISOString(),
    rawSalesJson: {
      date,
      orderCount: sales.orderCount || 0,
      orderItemErrorCount: sales.orderItemErrorCount || 0,
      orderStatuses: sales.orderStatuses || "",
      source: sales.source || "orders",
      reportId: sales.reportId || "",
      reportType: sales.reportType || "",
      marker: true
    }
  };
}

function mergeFbaDailyRecord(existing, incoming, date) {
  const frozenAt = isFbaDailyFrozen(date) ? (existing?.frozenAt || new Date().toISOString()) : "";
  const cleanedIncoming = { ...incoming };
  if (isRealtimeInventorySnapshot(existing) && incoming?.inventoryFetchedAt) {
    for (const field of [
      "amazonTotalQuantity",
      "totalGoodsQuantity",
      "fulfillableQuantity",
      "reservedQuantity",
      "unfulfillableQuantity",
      "inboundWorkingQuantity",
      "inboundShippedQuantity",
      "inboundReceivingQuantity",
      "researchingQuantity",
      "inventoryFetchedAt",
      "lastUpdatedTime",
      "rawInventoryJson"
    ]) {
      delete cleanedIncoming[field];
    }
  }
  for (const field of ["asin", "fnSku", "title", "brand", "imageUrl", "condition"]) {
    if (existing?.[field] && cleanedIncoming[field] === "") {
      delete cleanedIncoming[field];
    }
  }
  return {
    ...(existing || {}),
    ...cleanedIncoming,
    date,
    frozenAt
  };
}

async function upsertFbaDailyRecords(records) {
  const rows = await readFbaDailyRows();
  const byKey = new Map(rows.map(row => [makeFbaDailyKey(row), row]));
  let inserted = 0;
  let updated = 0;
  let skippedFrozen = 0;

  for (const record of records) {
    if (!record?.sellerSku || !record?.marketplaceId || !record?.date) continue;
    const key = makeFbaDailyKey(record);
    const existing = byKey.get(key);
    if (existing?.frozenAt || (existing && isFbaDailyFrozen(record.date))) {
      skippedFrozen += 1;
      continue;
    }
    byKey.set(key, mergeFbaDailyRecord(existing, record, record.date));
    if (existing) updated += 1;
    else inserted += 1;
  }

  const nextRows = [...byKey.values()];
  const rowMap = new Map(nextRows.map(row => [makeFbaDailyKey(row), row]));
  for (const row of nextRows) {
    const previous = rowMap.get(`${row.marketplaceId}|${row.sellerSku}|${addDays(row.date, -1)}`);
    if (Number.isFinite(Number(row.salesUnits)) && previous && Number.isFinite(Number(previous.fulfillableQuantity))) {
      row.isSufficient = Number(row.salesUnits || 0) < Number(previous.fulfillableQuantity || 0);
    }
    if (!row.frozenAt && isFbaDailyFrozen(row.date)) {
      row.frozenAt = new Date().toISOString();
    }
  }

  await writeFbaDailyRows(nextRows);
  await upsertFbaSkuMetadata(nextRows.filter(row => row.inventoryFetchedAt), "inventory");
  return { inserted, updated, skippedFrozen };
}

function fbaDatesWithSalesRecords(rows, marketplaceId) {
  const today = formatDateInTimeZone();
  const dates = new Set();
  for (const row of rows) {
    if (row.marketplaceId !== marketplaceId) continue;
    if (!row.salesFetchedAt) continue;
    const date = String(row.date || "").slice(0, 10);
    if (date === today) continue;
    dates.add(date);
  }
  return dates;
}

async function syncFbaDailyRange(startDate, endDate, options = {}) {
  const config = getSpApiConfig();
  const today = formatDateInTimeZone();
  const rangeDates = dateRangeInclusive(startDate, endDate);
  const dates = options.dates || rangeDates;
  const inventoryDates = options.inventoryDates || [];
  const inventoryRecords = [];
  const warnings = [];
  let inventorySynced = false;

  if (rangeDates.includes(today)) {
    try {
      const inventory = await fetchFbaInventorySummaries();
      const catalog = await fetchCatalogDetails(inventory.map(item => item.asin).filter(Boolean));
      inventoryRecords.push(...inventory.map(summary => buildInventoryDailyRecord(summary, catalog, today, config)));
      inventorySynced = true;
    } catch (error) {
      warnings.push(`当天 FBA 库存快照保存失败：${error.message}`);
    }
  }

  const historicalInventoryDates = inventoryDates.filter(date => date < today);
  if (historicalInventoryDates.length) {
    try {
      const ledgerRecords = await fetchLedgerInventoryRecords(historicalInventoryDates[0], historicalInventoryDates[historicalInventoryDates.length - 1]);
      const requestedSet = new Set(historicalInventoryDates);
      inventoryRecords.push(...ledgerRecords.filter(record => requestedSet.has(record.date)));
    } catch (error) {
      warnings.push(`历史 FBA 库存账本拉取失败：${error.message}`);
    }
  }

  const salesRecords = [];
  let orderCount = 0;
  let orderItemErrorCount = 0;
  let salesByDate = null;
  if ((process.env.AMZ_SALES_SOURCE || "reports").toLowerCase() !== "orders" && dates.length) {
    try {
      salesByDate = await fetchSalesByDateSkuFromReport(dates[0], dates[dates.length - 1]);
    } catch (error) {
      warnings.push(`${dates[0]} 至 ${dates[dates.length - 1]} Orders 销量报表拉取失败：${error.message}`);
    }
  }
  for (const date of dates) {
    try {
      const sales = salesByDate?.get(date) || await fetchSalesBySku(date, date);
      orderCount += sales.orderCount || 0;
      orderItemErrorCount += sales.orderItemErrorCount || 0;
      warnings.push(...(sales.warnings || []));
      salesRecords.push(buildSalesDateMarkerRecord(date, config, sales));
      for (const sale of sales.bySku.values()) {
        salesRecords.push(buildSalesDailyRecord(sale, date, config));
      }
    } catch (error) {
      warnings.push(`${date} Orders 销量拉取失败：${error.message}`);
    }
  }

  const storage = await upsertFbaDailyRecords([...inventoryRecords, ...salesRecords]);
  return {
    dates,
    inventorySynced,
    orderCount,
    orderItemErrorCount,
    storage,
    warnings
  };
}

async function getFbaDailyDateStatus() {
  const rows = await readFbaDailyRows();
  const config = getSpApiConfig();
  const today = formatDateInTimeZone();
  const byDate = new Map();
  for (const row of rows) {
    if (row.marketplaceId !== config.marketplaceId) continue;
    const date = String(row.date || "").slice(0, 10);
    if (!date) continue;
    if (date === today) continue;
    const item = byDate.get(date) || {
      date,
      rowCount: 0,
      inventoryCount: 0,
      salesCount: 0,
      frozenCount: 0
    };
    item.rowCount += 1;
    if (row.inventoryFetchedAt) item.inventoryCount += 1;
    if (row.salesFetchedAt) item.salesCount += 1;
    if (row.frozenAt) item.frozenCount += 1;
    byDate.set(date, item);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

async function buildFbaInventoryView(startDate, endDate, options = {}) {
  const config = getSpApiConfig();
  const today = formatDateInTimeZone();
  const safeStart = (startDate || addDays(formatDateInTimeZone(), -29)).slice(0, 10);
  const safeEnd = (endDate || formatDateInTimeZone()).slice(0, 10);
  const dayCount = daysBetweenInclusive(safeStart, safeEnd);
  const warnings = [];
  let sync = null;
  let dailyRows = await readFbaDailyRows();
  const requestedDates = dateRangeInclusive(safeStart, safeEnd);
  if (options.mode === "sync") {
    sync = await syncFbaDailyRange(safeStart, safeEnd, {
      dates: requestedDates,
      inventoryDates: requestedDates.filter(date => date < today)
    });
    warnings.push(...(sync.warnings || []));
    dailyRows = await readFbaDailyRows();
  } else if (options.mode === "query") {
    const existingSalesDates = fbaDatesWithSalesRecords(dailyRows, config.marketplaceId);
    const missingDates = requestedDates.filter(date => date === today || !existingSalesDates.has(date));
    const existingInventoryDates = new Set(dailyRows
      .filter(row => row.marketplaceId === config.marketplaceId && row.inventoryFetchedAt && row.sellerSku !== FBA_DATE_MARKER_SKU)
      .map(row => row.date)
    );
    const missingHistoricalInventoryDates = requestedDates.filter(date => date < today && !existingInventoryDates.has(date));
    const hasEndDateInventory = dailyRows.some(row =>
      row.marketplaceId === config.marketplaceId &&
      row.date === safeEnd &&
      row.inventoryFetchedAt &&
      row.sellerSku !== FBA_DATE_MARKER_SKU
    );
    const shouldFetchTodayInventory = requestedDates.includes(today);
    if (missingDates.length || shouldFetchTodayInventory || missingHistoricalInventoryDates.length) {
      sync = await syncFbaDailyRange(safeStart, safeEnd, {
        dates: missingDates,
        inventoryDates: missingHistoricalInventoryDates
      });
      warnings.push(...(sync.warnings || []));
      dailyRows = await readFbaDailyRows();
    }
  }
  const rangeRows = dailyRows.filter(row => row.date >= safeStart && row.date <= safeEnd && row.marketplaceId === config.marketplaceId);
  const allInventoryRows = dailyRows.filter(row => row.marketplaceId === config.marketplaceId && row.inventoryFetchedAt && row.sellerSku !== FBA_DATE_MARKER_SKU);
  const metadataRows = (await readFbaSkuMetadataRows()).filter(row => row.marketplaceId === config.marketplaceId);
  let inventoryRows = allInventoryRows.filter(row => row.date === safeEnd);

  if (!inventoryRows.length && safeEnd === today) {
    try {
      const inventory = await fetchFbaInventorySummaries();
      const catalog = await fetchCatalogDetails(inventory.map(item => item.asin).filter(Boolean));
      inventoryRows = inventory.map(summary => buildInventoryDailyRecord(summary, catalog, today, config));
      await upsertFbaSkuMetadata(inventoryRows, "inventory");
      warnings.push("当前展示使用实时 FBA 库存兜底；点击同步后会保存当天库存快照。");
    } catch (error) {
      throw new Error(`FBA Inventory 拉取失败：${error.message}`);
    }
  } else if (!inventoryRows.length) {
    warnings.push(`结束日期 ${safeEnd} 没有本地 FBA 库存快照；库存字段显示为空，销量仍按所选日期范围统计。`);
  }

  const latestInventoryBySku = new Map();
  for (const row of inventoryRows) {
    if (row.sellerSku === FBA_DATE_MARKER_SKU) continue;
    const existing = latestInventoryBySku.get(row.sellerSku);
    if (!existing || String(row.date || "") > String(existing.date || "")) {
      latestInventoryBySku.set(row.sellerSku, row);
    }
  }

  const latestMetadataBySku = new Map();
  for (const row of metadataRows) {
    if (!row.sellerSku) continue;
    latestMetadataBySku.set(row.sellerSku, row);
  }
  for (const row of allInventoryRows) {
    if (row.sellerSku === FBA_DATE_MARKER_SKU) continue;
    const existing = latestMetadataBySku.get(row.sellerSku);
    if (!existing || !existing.lastSeenAt || String(row.date || "") > String(existing.date || existing.lastSeenAt || "")) {
      latestMetadataBySku.set(row.sellerSku, row);
    }
  }

  const salesBySku = new Map();
  const inventoryBySkuDate = new Map();
  for (const row of allInventoryRows) {
    if (!row.sellerSku || !row.date) continue;
    inventoryBySkuDate.set(`${row.sellerSku}|${row.date}`, row);
  }
  for (const row of rangeRows) {
    if (row.sellerSku === FBA_DATE_MARKER_SKU) continue;
    if (!row.sellerSku) continue;
    const item = salesBySku.get(row.sellerSku) || {
      units: 0,
      orders: 0,
      sufficientUnits: 0,
      sufficientDays: 0
    };
    const units = Number(row.salesUnits || 0);
    item.units += units;
    item.orders += Number(row.salesOrders || 0);
    const sameDayInventory = inventoryBySkuDate.get(`${row.sellerSku}|${row.date}`);
    const previousInventory = inventoryBySkuDate.get(`${row.sellerSku}|${addDays(row.date, -1)}`);
    const inventoryForSufficientCheck = sameDayInventory ? (previousInventory || sameDayInventory) : null;
    if (inventoryForSufficientCheck && Number(sameDayInventory.fulfillableQuantity || 0) > 0 && units < Number(inventoryForSufficientCheck.fulfillableQuantity || 0)) {
      item.sufficientUnits += units;
      item.sufficientDays += 1;
    }
    salesBySku.set(row.sellerSku, item);
  }

  const rowSkus = new Set([...latestInventoryBySku.keys(), ...salesBySku.keys()]);
  const rows = [...rowSkus].map(sku => {
    const inventory = latestInventoryBySku.get(sku) || null;
    const metadata = mergeSkuDisplayMetadata(latestMetadataBySku.get(sku), inventory);
    const sale = salesBySku.get(sku) || { units: 0, orders: 0, sufficientUnits: 0, sufficientDays: 0 };
    const dailySales = sale.sufficientDays > 0 ? sale.sufficientUnits / sale.sufficientDays : sale.units / dayCount;
    const inventorySource = inventorySnapshotSource(inventory);
    const isWarehouseOnlyInventory = inventorySource === "ledger_summary";
    const fulfillableQuantity = inventory ? Number(inventory.fulfillableQuantity || 0) : 0;
    const warehouseQuantity = inventory ? Number(inventory.fulfillableQuantity || 0) + Number(inventory.unfulfillableQuantity || 0) : 0;
    const totalGoodsQuantity = inventory && !isWarehouseOnlyInventory ? calculateTotalGoodsQuantity(inventory) : null;
    const sellableDays = dailySales > 0 && totalGoodsQuantity !== null ? Math.floor(Number(totalGoodsQuantity || 0) / dailySales) : null;
    const stockoutDays = requestedDates.reduce((count, date) => {
      const dayInventory = inventoryBySkuDate.get(`${sku}|${date}`);
      return count + (!dayInventory || Number(dayInventory.fulfillableQuantity || 0) <= 0 ? 1 : 0);
    }, 0);
    return {
      asin: metadata.asin || "",
      sellerSku: sku,
      fnSku: metadata.fnSku || "",
      title: metadata.title || "",
      brand: metadata.brand || "",
      imageUrl: metadata.imageUrl || "",
      condition: metadata.condition || "",
      inventorySource,
      inventoryCompleteness: isWarehouseOnlyInventory ? "warehouse_only" : (inventory ? "complete" : "missing"),
      warehouseQuantity,
      amazonTotalQuantity: inventory ? Number(inventory.amazonTotalQuantity || 0) : 0,
      totalQuantity: totalGoodsQuantity,
      totalGoodsQuantity,
      fulfillableQuantity,
      reservedQuantity: inventory && !isWarehouseOnlyInventory ? Number(inventory.reservedQuantity || 0) : null,
      unfulfillableQuantity: inventory ? Number(inventory.unfulfillableQuantity || 0) : 0,
      inboundWorkingQuantity: inventory && !isWarehouseOnlyInventory ? Number(inventory.inboundWorkingQuantity || 0) : null,
      inboundShippedQuantity: inventory && !isWarehouseOnlyInventory ? Number(inventory.inboundShippedQuantity || 0) : null,
      inboundReceivingQuantity: inventory && !isWarehouseOnlyInventory ? Number(inventory.inboundReceivingQuantity || 0) : null,
      salesOrders: Number(sale.orders || 0),
      salesUnits: Number(sale.units || 0),
      sufficientSalesDays: Number(sale.sufficientDays || 0),
      dailySales: Number(dailySales.toFixed(2)),
      sellableDays,
      stockoutDays,
      stockLevel: sellableDays === null ? "unknown" : sellableDays < 14 ? "low" : sellableDays < 30 ? "medium" : "healthy",
      lastUpdatedTime: "",
      inventoryDate: inventory?.date || ""
    };
  }).sort((a, b) => Number(b.totalGoodsQuantity || 0) - Number(a.totalGoodsQuantity || 0));

  const totals = rows.reduce((acc, row) => {
    acc.amazonTotalQuantity += Number(row.amazonTotalQuantity || 0);
    acc.warehouseQuantity += Number(row.warehouseQuantity || 0);
    if (row.totalGoodsQuantity !== null && row.totalGoodsQuantity !== undefined) {
      acc.completeInventoryRows += 1;
      acc.totalQuantity += Number(row.totalGoodsQuantity || 0);
      acc.totalGoodsQuantity += Number(row.totalGoodsQuantity || 0);
    }
    if (row.inventoryCompleteness === "warehouse_only") acc.warehouseOnlyRows += 1;
    if (row.inboundWorkingQuantity !== null && row.inboundWorkingQuantity !== undefined) acc.inboundWorkingQuantity += Number(row.inboundWorkingQuantity || 0);
    if (row.inboundShippedQuantity !== null && row.inboundShippedQuantity !== undefined) acc.inboundShippedQuantity += Number(row.inboundShippedQuantity || 0);
    if (row.inboundReceivingQuantity !== null && row.inboundReceivingQuantity !== undefined) acc.inboundReceivingQuantity += Number(row.inboundReceivingQuantity || 0);
    acc.fulfillableQuantity += Number(row.fulfillableQuantity || 0);
    if (row.reservedQuantity !== null && row.reservedQuantity !== undefined) acc.reservedQuantity += Number(row.reservedQuantity || 0);
    acc.unfulfillableQuantity += Number(row.unfulfillableQuantity || 0);
    acc.salesOrders += row.salesOrders;
    acc.salesUnits += row.salesUnits;
    return acc;
  }, {
    amazonTotalQuantity: 0,
    warehouseQuantity: 0,
    totalQuantity: 0,
    totalGoodsQuantity: 0,
    completeInventoryRows: 0,
    warehouseOnlyRows: 0,
    inboundWorkingQuantity: 0,
    inboundShippedQuantity: 0,
    inboundReceivingQuantity: 0,
    fulfillableQuantity: 0,
    unfulfillableQuantity: 0,
    reservedQuantity: 0,
    salesOrders: 0,
    salesUnits: 0
  });
  totals.inventoryCompleteness = totals.warehouseOnlyRows > 0 ? "partial" : "complete";
  if (totals.inventoryCompleteness !== "complete") {
    totals.totalQuantity = null;
    totals.totalGoodsQuantity = null;
    totals.inboundWorkingQuantity = null;
    totals.inboundShippedQuantity = null;
    totals.inboundReceivingQuantity = null;
    totals.reservedQuantity = null;
  }
  const salesMarkerSummary = rangeRows.reduce((acc, row) => {
    if (row.sellerSku !== FBA_DATE_MARKER_SKU) return acc;
    acc.orderCount += Number(row.rawSalesJson?.orderCount || 0);
    acc.orderItemErrorCount += Number(row.rawSalesJson?.orderItemErrorCount || 0);
    return acc;
  }, { orderCount: 0, orderItemErrorCount: 0 });

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
      orderCount: (sync?.orderCount ?? salesMarkerSummary.orderCount) || totals.salesOrders || 0,
      orderItemErrorCount: (sync?.orderItemErrorCount ?? salesMarkerSummary.orderItemErrorCount) || 0,
      sufficientSalesDays: rows.reduce((sum, row) => sum + Number(row.sufficientSalesDays || 0), 0)
    },
    sync,
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

function adsConfig() {
  const endpoint = (process.env.AMZ_ADS_API_ENDPOINT || "https://advertising-api.amazon.com").replace(/\/+$/, "");
  return {
    clientId: process.env.AMZ_ADS_CLIENT_ID || "",
    clientSecret: process.env.AMZ_ADS_CLIENT_SECRET || "",
    redirectUri: process.env.AMZ_ADS_REDIRECT_URI || `http://localhost:${PORT}/api/ads/callback`,
    scope: process.env.AMZ_ADS_SCOPE || "advertising::campaign_management",
    endpoint
  };
}

function adsPublicConfig() {
  const config = adsConfig();
  const missing = [];
  if (!config.clientId) missing.push("AMZ_ADS_CLIENT_ID");
  if (!config.clientSecret) missing.push("AMZ_ADS_CLIENT_SECRET");
  return {
    configured: missing.length === 0,
    missing,
    endpoint: config.endpoint,
    redirectUri: config.redirectUri,
    scope: config.scope
  };
}

function assertAdsConfig() {
  const config = adsConfig();
  const missing = adsPublicConfig().missing;
  if (missing.length) throw new Error(`请先在 .env 配置 ${missing.join("、")}`);
  return config;
}

async function readAdsToken() {
  if (!existsSync(ADS_TOKEN_PATH)) return null;
  try {
    return JSON.parse(await readFile(ADS_TOKEN_PATH, "utf8"));
  } catch {
    return null;
  }
}

async function writeAdsToken(token) {
  await ensureDb();
  await writeFile(ADS_TOKEN_PATH, JSON.stringify(token, null, 2), "utf8");
}

async function readAdsProfileSelection() {
  if (!existsSync(ADS_PROFILE_PATH)) return null;
  try {
    return JSON.parse(await readFile(ADS_PROFILE_PATH, "utf8"));
  } catch {
    return null;
  }
}

async function writeAdsProfileSelection(profile) {
  await ensureDb();
  await writeFile(ADS_PROFILE_PATH, JSON.stringify(profile, null, 2), "utf8");
}

function adsAuthUrl() {
  const config = assertAdsConfig();
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: config.scope
  });
  return `https://www.amazon.com/ap/oa?${params}`;
}

async function exchangeAdsCode(code) {
  const config = assertAdsConfig();
  const response = await fetch("https://api.amazon.com/auth/o2/token", {
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
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error_description || data.error || "Amazon Ads 授权失败");
  await writeAdsToken({
    ...data,
    expires_at: Date.now() + Number(data.expires_in || 3600) * 1000
  });
}

async function getAdsAccessToken() {
  const config = assertAdsConfig();
  const token = await readAdsToken();
  if (!token?.access_token && !token?.refresh_token) throw new Error("Amazon Ads 尚未授权");
  if (token.access_token && token.expires_at && token.expires_at > Date.now() + 60_000) {
    return token.access_token;
  }
  if (!token.refresh_token) throw new Error("Amazon Ads 授权已过期，请重新授权");

  const response = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: token.refresh_token,
      grant_type: "refresh_token"
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error_description || data.error || "Amazon Ads 刷新授权失败");
  const next = {
    ...token,
    ...data,
    refresh_token: data.refresh_token || token.refresh_token,
    expires_at: Date.now() + Number(data.expires_in || 3600) * 1000
  };
  await writeAdsToken(next);
  return next.access_token;
}

async function adsFetch(pathname, params = {}, options = {}) {
  const accessToken = await getAdsAccessToken();
  const config = assertAdsConfig();
  const url = new URL(pathname, config.endpoint);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  });

  const headers = {
    "accept": "application/json",
    "content-type": "application/json",
    "authorization": `Bearer ${accessToken}`,
    "amazon-advertising-api-clientid": config.clientId,
    ...(options.headers || {})
  };
  if (options.requireProfile || options.profileId) {
    const selected = options.profileId ? { profileId: options.profileId } : await readAdsProfileSelection();
    if (!selected?.profileId) throw new Error("请先选择 Amazon Ads Profile");
    headers["amazon-advertising-api-scope"] = String(selected.profileId);
  }

  const response = await fetch(url, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  if (!response.ok) {
    const detail = data?.details || data?.message || data?.error_description || data?.error || text || `Ads API ${response.status}`;
    throw new Error(`${response.status} ${detail}`);
  }
  return data;
}

function normalizeAdsProfile(profile) {
  const accountInfo = profile.accountInfo || {};
  return {
    profileId: String(profile.profileId || ""),
    countryCode: profile.countryCode || "",
    currencyCode: profile.currencyCode || "",
    timezone: profile.timezone || "",
    dailyBudget: profile.dailyBudget ?? "",
    accountName: accountInfo.name || accountInfo.sellerStringId || accountInfo.vendorGroupName || "",
    marketplaceStringId: accountInfo.marketplaceStringId || "",
    sellerStringId: accountInfo.sellerStringId || "",
    type: accountInfo.type || ""
  };
}

async function fetchAdsProfiles() {
  const profiles = await adsFetch("/v2/profiles", {}, { requireProfile: false });
  return (Array.isArray(profiles) ? profiles : []).map(normalizeAdsProfile).filter(profile => profile.profileId);
}

async function adsStatus() {
  const publicConfig = adsPublicConfig();
  const token = await readAdsToken();
  const selectedProfile = await readAdsProfileSelection();
  return {
    ...publicConfig,
    authorized: Boolean(token?.refresh_token),
    hasAccessToken: Boolean(token?.access_token),
    selectedProfile: selectedProfile || null
  };
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

  if (req.method === "GET" && url.pathname === "/api/ads/auth-url") {
    return sendJson(res, { url: adsAuthUrl() });
  }

  if (req.method === "GET" && url.pathname === "/api/ads/callback") {
    const code = url.searchParams.get("code");
    if (!code) return sendJson(res, { error: "Missing Amazon Ads authorization code" }, 400);
    await exchangeAdsCode(code);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<p>Amazon Ads 授权成功，可以关闭此页面并回到工作台刷新广告管理。</p>");
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/ads/status") {
    return sendJson(res, await adsStatus());
  }

  if (req.method === "GET" && url.pathname === "/api/ads/profiles") {
    const profiles = await fetchAdsProfiles();
    const selectedProfile = await readAdsProfileSelection();
    return sendJson(res, { profiles, selectedProfile });
  }

  if (req.method === "POST" && url.pathname === "/api/ads/select-profile") {
    const body = await parseBody(req);
    const profileId = String(body.profileId || "");
    if (!profileId) return sendJson(res, { error: "Missing profileId" }, 400);
    const profiles = await fetchAdsProfiles();
    const profile = profiles.find(item => item.profileId === profileId);
    if (!profile) return sendJson(res, { error: "Profile not found" }, 404);
    await writeAdsProfileSelection(profile);
    return sendJson(res, { profile });
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
    const mode = url.searchParams.get("mode") || "";
    const refresh = url.searchParams.get("refresh") === "1" || mode === "sync" || mode === "query";
    const cacheKey = `${startDate}:${endDate}:${mode}:${getSpApiConfig().marketplaceId}`;
    const cacheTtlMs = Number(process.env.AMZ_FBA_CACHE_TTL_MS || 300000);
    const cached = fbaInventoryCache.get(cacheKey);
    if (!refresh && cached && Date.now() - cached.cachedAt < cacheTtlMs) {
      return sendJson(res, { ...cached.data, cached: true, cachedAt: cached.cachedAt });
    }
    const result = await buildFbaInventoryView(startDate, endDate, { mode: mode || (refresh ? "sync" : "") });
    fbaInventoryCache.set(cacheKey, { cachedAt: Date.now(), data: result });
    return sendJson(res, result);
  }

  if (req.method === "GET" && url.pathname === "/api/fba/inventory/dates") {
    const dates = await getFbaDailyDateStatus();
    return sendJson(res, { dates });
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
    res.writeHead(200, {
      "content-type": mimeTypes[extname(target)] || "application/octet-stream",
      "cache-control": "no-store, max-age=0"
    });
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
