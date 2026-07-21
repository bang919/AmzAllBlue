import { createServer } from "node:http";
import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import mysql from "mysql2/promise";
import ExcelJS from "exceljs";
import { logAmazonRequest, logApiRequest, logFbaSync } from "./lib/logger.mjs";

const PORT = Number(process.env.PORT || 4317);
const ROOT = resolve(".");
const PUBLIC_DIR = join(ROOT, "public");
const TEMPLATE_DIR = join(PUBLIC_DIR, "templates");
const DATA_DIR = join(ROOT, "data");
const NETWORK_DEBUG_PATH = join(DATA_DIR, "network-debug.jsonl");
const SP_API_REPORT_CACHE_PATH = join(DATA_DIR, "sp-api-report-cache.json");
const GMAIL_TOKEN_PATH = join(DATA_DIR, "gmail-token.json");
const ADS_TOKEN_PATH = join(DATA_DIR, "ads-token.json");
const ADS_PROFILE_PATH = join(DATA_DIR, "ads-profile.json");
const ADS_MANAGED_PORTFOLIO_NAME = "AmzAllBlue_ERP";
const ADS_AI_PROMPT_VERSION = "ads-ai-v1";
const ADS_AI_SCHEDULE_TIME_ZONE = "Asia/Shanghai";
const ADS_AI_ACTION_TYPES = new Set([
  "NO_ACTION", "CHANGE_BID", "CHANGE_PLACEMENT_ADJUSTMENT", "CHANGE_DAILY_BUDGET",
  "PAUSE_CAMPAIGN", "RESUME_CAMPAIGN", "MOVE_GROUP", "REQUEST_MORE_DATA"
]);
const ADS_AI_GROUPS = new Set(["NORMAL", "PROMOTED", "STABLE"]);
const ADS_AI_APPROVAL_MODES = new Set(["MANUAL", "RISK_ONLY", "AUTO_ALL"]);
const SYSTEM_SCHEDULE_TIME_ZONE = "Asia/Shanghai";
const SYSTEM_SCHEDULE_TASKS = Object.freeze({
  FBA_TODAY_SALES: { label: "FBA 当日销量", type: "INTERVAL", enabled: true, intervalMinutes: 60, minInterval: 15, description: "请求 SP-API 当日销量，并更新 FBA 日销量事实数据。" },
  FBA_CURRENT_INVENTORY: { label: "FBA 当前库存", type: "INTERVAL", enabled: true, intervalMinutes: 360, minInterval: 60, description: "请求 SP-API 当前库存和商品资料，更新当天库存快照。" },
  FBA_HISTORY_BACKFILL: { label: "FBA 历史数据补齐", type: "DAILY", enabled: true, time: "16:30", description: "补齐最近 30 天库存与销量缺口；已冻结的历史库存不会被覆盖。" },
  ADS_TODAY_PERFORMANCE: { label: "广告当日表现", type: "INTERVAL", enabled: true, intervalMinutes: 60, minInterval: 5, description: "请求 Amazon Ads 当日曝光、点击、花费、订单和销售额，并记录当天最新广告设置。" },
  ADS_ROLLING_PERFORMANCE: { label: "广告近 30 天回补", type: "DAILY", enabled: true, time: "16:45", description: "重新请求最近 30 天广告日报，校正 Amazon 延迟归因的数据。" },
  SIF_KEYWORD_DATA: { label: "关键词排名与建议竞价", type: "DAILY", enabled: true, time: "10:15", description: "请求 SIF 关键词自然位、广告位和建议竞价，保存每日历史。" },
  ADS_AI_ANALYSIS: { label: "广告 AI 批量分析", type: "DAILY", enabled: false, time: "09:00", description: "批量分析所有已设置调整目标的关键词，保存 AI 分析与建议行动。" }
});
const SECRET_KEYS = {
  gmailToken: "gmail_token",
  adsToken: "amazon_ads_token",
  adsProfile: "amazon_ads_profile",
  sifCredentials: "sif_keyword_monitor_credentials"
};
const SIF_ORIGIN = "https://www.sif.com";
const ENV_PATH = join(ROOT, ".env");
const FBA_DATE_MARKER_SKU = "__DATE_MARKER__";
const fbaInventoryCache = new Map();
const salesReportRequests = new Map();
const fbaSyncJobs = new Map();
const fbaSyncLocks = new Map();
const fbaSyncLastRun = new Map();
let fbaSyncQueueTail = Promise.resolve();
let spApiAccessTokenCache = null;
let salesReportRequestsLoaded = false;
let mysqlPool = null;
let fbaDailySchemaReady = false;
let appMysqlSchemaReady = false;
let mysqlDatabaseReady = false;
let fbaScheduledSyncTimer = null;
let adsHourlySyncTimer = null;
let adsRollingSyncTimer = null;
let sifDailySyncTimer = null;
let adsAiDailyScheduleTimer = null;
let systemScheduleTimer = null;
const adsAiAnalysisJobs = new Map();
const sifTrafficAuditJobs = new Map();

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

async function ensureDataDir() {
  await mkdir(DATA_DIR, { recursive: true });
}

async function readDb() {
  await ensureAppMysqlSchema();
  const pool = getMysqlPool();
  const [requestRows] = await pool.query("SELECT payload FROM collaboration_requests ORDER BY position ASC, created_at DESC");
  const [productRows] = await pool.query("SELECT payload FROM manual_products ORDER BY position ASC, updated_at DESC");
  const [factoryProductRows] = await pool.query("SELECT payload FROM factory_inventory_products ORDER BY position ASC, updated_at DESC");
  const [factoryMovementRows] = await pool.query("SELECT payload FROM factory_inventory_movements ORDER BY position ASC, created_at DESC");
  return {
    requests: requestRows.map(row => parseMysqlJson(row.payload)).filter(Boolean),
    products: productRows.map(row => parseMysqlJson(row.payload)).filter(Boolean),
    factoryInventory: {
      products: factoryProductRows.map(row => parseMysqlJson(row.payload)).filter(Boolean),
      movements: factoryMovementRows.map(row => parseMysqlJson(row.payload)).filter(Boolean)
    }
  };
}

async function writeDb(db) {
  await ensureAppMysqlSchema();
  const pool = getMysqlPool();
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await replaceJsonTableRows(connection, "collaboration_requests", (Array.isArray(db.requests) ? db.requests : []).map(item => normalizeRequest(item)));
    await replaceJsonTableRows(connection, "manual_products", (Array.isArray(db.products) ? db.products : []).map(item => normalizeProduct(item)));
    const factoryStore = db.factoryInventory || { products: [], movements: [] };
    await replaceJsonTableRows(connection, "factory_inventory_products", (Array.isArray(factoryStore.products) ? factoryStore.products : []).map(item => normalizeFactoryProduct(item)));
    await replaceJsonTableRows(connection, "factory_inventory_movements", (Array.isArray(factoryStore.movements) ? factoryStore.movements : []).map(item => normalizeFactoryMovement(item)));
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

function getMysqlConfig() {
  return {
    enabled: process.env.DB_DISABLED !== "1" && process.env.DB_DISABLED !== "true",
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
  if (!isMysqlEnabled()) {
    throw new Error("Database storage is required. Remove DB_DISABLED or configure DB_* in .env.");
  }
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

async function ensureAdsMysqlSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sif_keyword_monitors (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      country_code VARCHAR(8) NOT NULL DEFAULT 'US',
      asin VARCHAR(32) NOT NULL,
      keyword_text VARCHAR(255) NOT NULL,
      normalized_keyword VARCHAR(255) NOT NULL,
      monitor_status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
      sort_order INT NOT NULL DEFAULT 0,
      source VARCHAR(16) NOT NULL DEFAULT 'SIF',
      last_seen_at DATETIME NULL,
      last_synced_at DATETIME NULL,
      last_error TEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_sif_keyword_monitor (country_code, asin, normalized_keyword),
      KEY idx_sif_keyword_monitors_sort (country_code, asin, sort_order),
      KEY idx_sif_keyword_monitors_status (monitor_status, asin),
      KEY idx_sif_keyword_monitors_keyword (normalized_keyword)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query("ALTER TABLE sif_keyword_monitors ADD COLUMN sort_order INT NOT NULL DEFAULT 0 AFTER monitor_status").catch(() => {});
  await pool.query("ALTER TABLE sif_keyword_monitors ADD KEY idx_sif_keyword_monitors_sort (country_code, asin, sort_order)").catch(() => {});
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sif_keyword_rank_daily (
      monitor_id BIGINT UNSIGNED NOT NULL,
      date DATE NOT NULL,
      natural_rank INT UNSIGNED NULL,
      natural_rank_str VARCHAR(64) NULL,
      natural_asin VARCHAR(32) NULL,
      sp_rank INT UNSIGNED NULL,
      sp_rank_str VARCHAR(64) NULL,
      sp_asin VARCHAR(32) NULL,
      est_searches_num BIGINT UNSIGNED NULL,
      aba_rank BIGINT UNSIGNED NULL,
      synced_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (monitor_id, date),
      KEY idx_sif_keyword_rank_daily_date (date),
      CONSTRAINT fk_sif_keyword_rank_monitor FOREIGN KEY (monitor_id) REFERENCES sif_keyword_monitors (id) ON UPDATE RESTRICT ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sif_keyword_bid_daily (
      monitor_id BIGINT UNSIGNED NOT NULL,
      date DATE NOT NULL,
      category_id VARCHAR(64) NOT NULL,
      category_name VARCHAR(255) NOT NULL DEFAULT '',
      category_product_count BIGINT UNSIGNED NULL,
      bid_mode VARCHAR(16) NOT NULL DEFAULT 'legacy',
      match_status VARCHAR(32) NOT NULL DEFAULT 'MATCHED',
      category_source VARCHAR(16) NOT NULL DEFAULT 'CHILD',
      exact_start DECIMAL(10,4) NULL,
      exact_median DECIMAL(10,4) NULL,
      exact_end DECIMAL(10,4) NULL,
      phrase_start DECIMAL(10,4) NULL,
      phrase_median DECIMAL(10,4) NULL,
      phrase_end DECIMAL(10,4) NULL,
      broad_start DECIMAL(10,4) NULL,
      broad_median DECIMAL(10,4) NULL,
      broad_end DECIMAL(10,4) NULL,
      synced_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (monitor_id, date),
      KEY idx_sif_keyword_bid_daily_date (date),
      KEY idx_sif_keyword_bid_daily_category (category_id),
      CONSTRAINT fk_sif_keyword_bid_monitor FOREIGN KEY (monitor_id) REFERENCES sif_keyword_monitors (id) ON UPDATE RESTRICT ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query("ALTER TABLE sif_keyword_bid_daily ADD COLUMN match_status VARCHAR(32) NOT NULL DEFAULT 'MATCHED' AFTER bid_mode").catch(() => {});
  await pool.query("ALTER TABLE sif_keyword_bid_daily ADD COLUMN category_source VARCHAR(16) NOT NULL DEFAULT 'CHILD' AFTER match_status").catch(() => {});
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ads_managed_portfolios (
      profile_id VARCHAR(64) NOT NULL,
      portfolio_id VARCHAR(64) NULL,
      portfolio_name VARCHAR(255) NOT NULL DEFAULT '${ADS_MANAGED_PORTFOLIO_NAME}',
      country_code VARCHAR(8) NOT NULL DEFAULT '',
      currency_code VARCHAR(8) NOT NULL DEFAULT '',
      timezone VARCHAR(128) NOT NULL DEFAULT '',
      management_status VARCHAR(32) NOT NULL DEFAULT 'UNVERIFIED',
      conflicting_object_count INT UNSIGNED NOT NULL DEFAULT 0,
      last_error TEXT NULL,
      verified_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (profile_id),
      UNIQUE KEY uq_ads_managed_portfolio_id (profile_id, portfolio_id),
      KEY idx_ads_managed_portfolios_status (management_status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ads_creation_templates (
      profile_id VARCHAR(64) NOT NULL,
      currency_code VARCHAR(8) NOT NULL DEFAULT '',
      daily_budget DECIMAL(14, 2) NOT NULL DEFAULT 8.00,
      bidding_strategy VARCHAR(32) NOT NULL DEFAULT 'FIXED_BIDS',
      default_bid DECIMAL(14, 2) NOT NULL DEFAULT 0.20,
      top_of_search_adjustment INT UNSIGNED NOT NULL DEFAULT 200,
      rest_of_search_adjustment INT UNSIGNED NOT NULL DEFAULT 0,
      product_page_adjustment INT UNSIGNED NOT NULL DEFAULT 0,
      exact_enabled TINYINT(1) NOT NULL DEFAULT 1,
      phrase_enabled TINYINT(1) NOT NULL DEFAULT 0,
      broad_enabled TINYINT(1) NOT NULL DEFAULT 0,
      initial_state VARCHAR(16) NOT NULL DEFAULT 'ENABLED',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (profile_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ads_keywords (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      profile_id VARCHAR(64) NOT NULL,
      parent_asin VARCHAR(32) NOT NULL,
      keyword_text VARCHAR(255) NOT NULL,
      normalized_keyword VARCHAR(255) NOT NULL,
      creation_batch VARCHAR(24) NOT NULL DEFAULT '',
      active_scope_key VARCHAR(512) NULL,
      keyword_group VARCHAR(16) NOT NULL DEFAULT 'NORMAL',
      sort_order INT NOT NULL DEFAULT 0,
      lifecycle_status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
      stopped_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_ads_keywords_active_scope (active_scope_key),
      KEY idx_ads_keywords_parent_group (profile_id, parent_asin, keyword_group),
      KEY idx_ads_keywords_parent_sort (profile_id, parent_asin, sort_order),
      KEY idx_ads_keywords_creation_batch (profile_id, creation_batch),
      KEY idx_ads_keywords_updated_at (updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ads_campaigns (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      keyword_id BIGINT UNSIGNED NOT NULL,
      profile_id VARCHAR(64) NOT NULL,
      portfolio_id VARCHAR(64) NOT NULL,
      ad_type VARCHAR(8) NOT NULL DEFAULT 'SP',
      match_type VARCHAR(16) NOT NULL,
      child_asin VARCHAR(32) NULL,
      seller_sku VARCHAR(128) COLLATE utf8mb4_bin NULL,
      creation_batch VARCHAR(24) NOT NULL DEFAULT '',
      entity_key VARCHAR(255) NULL,
      amazon_campaign_id VARCHAR(64) NULL,
      campaign_name VARCHAR(255) NOT NULL,
      amazon_campaign_name VARCHAR(255) NULL,
      desired_state VARCHAR(16) NOT NULL DEFAULT 'ENABLED',
      lifecycle_status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
      stopped_at DATETIME NULL,
      amazon_state VARCHAR(16) NULL,
      daily_budget DECIMAL(14, 2) NOT NULL,
      bidding_strategy VARCHAR(32) NOT NULL DEFAULT 'FIXED_BIDS',
      top_of_search_adjustment INT UNSIGNED NOT NULL DEFAULT 200,
      rest_of_search_adjustment INT UNSIGNED NOT NULL DEFAULT 0,
      product_page_adjustment INT UNSIGNED NOT NULL DEFAULT 0,
      start_date DATE NOT NULL,
      end_date DATE NULL,
      creation_status VARCHAR(32) NOT NULL DEFAULT 'NOT_CREATED',
      sync_status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
      failed_step VARCHAR(64) NULL,
      last_error TEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_ads_campaign_entity_key (profile_id, entity_key),
      UNIQUE KEY uq_ads_campaign_amazon_id (profile_id, amazon_campaign_id),
      KEY idx_ads_campaigns_portfolio (profile_id, portfolio_id),
      KEY idx_ads_campaigns_creation_status (creation_status),
      CONSTRAINT fk_ads_campaigns_keyword FOREIGN KEY (keyword_id) REFERENCES ads_keywords (id) ON UPDATE RESTRICT ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ads_ad_units (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      campaign_id BIGINT UNSIGNED NOT NULL,
      profile_id VARCHAR(64) NOT NULL,
      child_asin VARCHAR(32) NOT NULL,
      seller_sku VARCHAR(128) COLLATE utf8mb4_bin NOT NULL,
      creation_batch VARCHAR(24) NOT NULL DEFAULT '',
      entity_key VARCHAR(255) NULL,
      ad_group_name VARCHAR(255) NOT NULL,
      amazon_ad_group_name VARCHAR(255) NULL,
      amazon_ad_group_id VARCHAR(64) NULL,
      amazon_product_ad_id VARCHAR(64) NULL,
      amazon_target_id VARCHAR(64) NULL,
      bid DECIMAL(14, 2) NOT NULL,
      desired_state VARCHAR(16) NOT NULL DEFAULT 'ENABLED',
      amazon_state VARCHAR(16) NULL,
      amazon_ad_group_state VARCHAR(16) NULL,
      amazon_product_ad_state VARCHAR(16) NULL,
      amazon_target_state VARCHAR(16) NULL,
      lifecycle_status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
      creation_status VARCHAR(32) NOT NULL DEFAULT 'NOT_CREATED',
      sync_status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
      failed_step VARCHAR(64) NULL,
      last_error TEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_ads_ad_unit_child (campaign_id, child_asin),
      UNIQUE KEY uq_ads_ad_unit_entity_key (profile_id, entity_key),
      UNIQUE KEY uq_ads_ad_group_amazon_id (profile_id, amazon_ad_group_id),
      UNIQUE KEY uq_ads_product_ad_amazon_id (profile_id, amazon_product_ad_id),
      UNIQUE KEY uq_ads_target_amazon_id (profile_id, amazon_target_id),
      KEY idx_ads_ad_units_sku (profile_id, seller_sku),
      KEY idx_ads_ad_units_creation_status (creation_status),
      CONSTRAINT fk_ads_ad_units_campaign FOREIGN KEY (campaign_id) REFERENCES ads_campaigns (id) ON UPDATE RESTRICT ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ads_performance_daily (
      date DATE NOT NULL,
      ad_unit_id BIGINT UNSIGNED NOT NULL,
      impressions BIGINT UNSIGNED NOT NULL DEFAULT 0,
      clicks BIGINT UNSIGNED NOT NULL DEFAULT 0,
      spend DECIMAL(18, 6) NOT NULL DEFAULT 0,
      orders_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
      units_sold BIGINT UNSIGNED NOT NULL DEFAULT 0,
      sales DECIMAL(18, 6) NOT NULL DEFAULT 0,
      synced_at DATETIME NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (ad_unit_id, date),
      KEY idx_ads_performance_daily_date (date),
      CONSTRAINT fk_ads_performance_daily_ad_unit FOREIGN KEY (ad_unit_id) REFERENCES ads_ad_units (id) ON UPDATE RESTRICT ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ads_placement_performance_daily (
      date DATE NOT NULL,
      campaign_id BIGINT UNSIGNED NOT NULL,
      placement VARCHAR(32) NOT NULL,
      impressions BIGINT UNSIGNED NOT NULL DEFAULT 0,
      clicks BIGINT UNSIGNED NOT NULL DEFAULT 0,
      spend DECIMAL(18, 6) NOT NULL DEFAULT 0,
      orders_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
      units_sold BIGINT UNSIGNED NOT NULL DEFAULT 0,
      sales DECIMAL(18, 6) NOT NULL DEFAULT 0,
      synced_at DATETIME NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (campaign_id, date, placement),
      KEY idx_ads_placement_daily_date (date),
      CONSTRAINT fk_ads_placement_daily_campaign FOREIGN KEY (campaign_id) REFERENCES ads_campaigns (id) ON UPDATE RESTRICT ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ads_ad_unit_settings_daily (
      date DATE NOT NULL,
      ad_unit_id BIGINT UNSIGNED NOT NULL,
      bid DECIMAL(14, 2) NOT NULL,
      desired_state VARCHAR(16) NOT NULL,
      amazon_state VARCHAR(16) NULL,
      captured_at DATETIME NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (ad_unit_id, date),
      KEY idx_ads_ad_unit_settings_daily_date (date),
      CONSTRAINT fk_ads_ad_unit_settings_daily_unit FOREIGN KEY (ad_unit_id) REFERENCES ads_ad_units (id) ON UPDATE RESTRICT ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ads_campaign_settings_daily (
      date DATE NOT NULL,
      campaign_id BIGINT UNSIGNED NOT NULL,
      daily_budget DECIMAL(14, 2) NOT NULL,
      top_of_search_adjustment INT UNSIGNED NOT NULL DEFAULT 0,
      rest_of_search_adjustment INT UNSIGNED NOT NULL DEFAULT 0,
      product_page_adjustment INT UNSIGNED NOT NULL DEFAULT 0,
      desired_state VARCHAR(16) NOT NULL,
      amazon_state VARCHAR(16) NULL,
      captured_at DATETIME NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (campaign_id, date),
      KEY idx_ads_campaign_settings_daily_date (date),
      CONSTRAINT fk_ads_campaign_settings_daily_campaign FOREIGN KEY (campaign_id) REFERENCES ads_campaigns (id) ON UPDATE RESTRICT ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ads_sync_jobs (
      id VARCHAR(64) NOT NULL,
      profile_id VARCHAR(64) NOT NULL,
      report_type VARCHAR(64) NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'QUEUED',
      active_dedupe_key VARCHAR(255) NULL,
      amazon_report_id VARCHAR(128) NULL,
      attempts INT UNSIGNED NOT NULL DEFAULT 0,
      next_retry_at DATETIME NULL,
      started_at DATETIME NULL,
      completed_at DATETIME NULL,
      last_error TEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_ads_sync_jobs_active (active_dedupe_key),
      KEY idx_ads_sync_jobs_queue (status, next_retry_at),
      KEY idx_ads_sync_jobs_profile_dates (profile_id, start_date, end_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ads_sync_dates (
      profile_id VARCHAR(64) NOT NULL,
      date DATE NOT NULL,
      report_type VARCHAR(64) NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
      last_job_id VARCHAR(64) NULL,
      synced_at DATETIME NULL,
      last_error TEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (profile_id, date, report_type),
      KEY idx_ads_sync_dates_status (profile_id, status, date),
      CONSTRAINT fk_ads_sync_dates_job FOREIGN KEY (last_job_id) REFERENCES ads_sync_jobs (id) ON UPDATE RESTRICT ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ads_operations (
      id VARCHAR(64) NOT NULL,
      profile_id VARCHAR(64) NOT NULL,
      operation_type VARCHAR(32) NOT NULL,
      entity_type VARCHAR(32) NULL,
      entity_id BIGINT UNSIGNED NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'PREVIEW',
      current_step VARCHAR(64) NULL,
      preview_hash CHAR(64) NULL,
      confirmation_token_hash CHAR(64) NULL,
      confirmation_expires_at DATETIME NULL,
      request_payload JSON NOT NULL,
      preview_payload JSON NULL,
      last_error TEXT NULL,
      confirmed_at DATETIME NULL,
      started_at DATETIME NULL,
      completed_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_ads_operations_profile_status (profile_id, status, created_at),
      KEY idx_ads_operations_entity (entity_type, entity_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ads_operation_steps (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      operation_id VARCHAR(64) NOT NULL,
      step_key VARCHAR(128) NOT NULL,
      step_order INT UNSIGNED NOT NULL,
      entity_type VARCHAR(32) NOT NULL,
      local_entity_id BIGINT UNSIGNED NULL,
      amazon_entity_id VARCHAR(64) NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
      attempts INT UNSIGNED NOT NULL DEFAULT 0,
      request_payload JSON NULL,
      response_payload JSON NULL,
      last_error TEXT NULL,
      started_at DATETIME NULL,
      completed_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_ads_operation_step (operation_id, step_key),
      KEY idx_ads_operation_steps_resume (operation_id, status, step_order),
      CONSTRAINT fk_ads_operation_steps_operation FOREIGN KEY (operation_id) REFERENCES ads_operations (id) ON UPDATE RESTRICT ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ads_ai_strategy_versions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      profile_id VARCHAR(64) NOT NULL,
      version INT UNSIGNED NOT NULL,
      rules_payload JSON NOT NULL,
      created_by VARCHAR(32) NOT NULL DEFAULT 'USER',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_ads_ai_strategy_version (profile_id, version),
      KEY idx_ads_ai_strategy_latest (profile_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ads_ai_keyword_goals (
      keyword_id BIGINT UNSIGNED NOT NULL,
      profile_id VARCHAR(64) NOT NULL,
      goal_text TEXT NOT NULL,
      constraints_payload JSON NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (keyword_id),
      KEY idx_ads_ai_keyword_goals_profile (profile_id, updated_at),
      CONSTRAINT fk_ads_ai_keyword_goal_keyword FOREIGN KEY (keyword_id) REFERENCES ads_keywords (id) ON UPDATE RESTRICT ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ads_ai_analysis_runs (
      id VARCHAR(64) NOT NULL,
      profile_id VARCHAR(64) NOT NULL,
      keyword_id BIGINT UNSIGNED NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'RUNNING',
      model_name VARCHAR(128) NOT NULL DEFAULT '',
      prompt_version VARCHAR(64) NOT NULL,
      strategy_version INT UNSIGNED NOT NULL DEFAULT 1,
      input_payload JSON NOT NULL,
      output_payload JSON NULL,
      validation_error TEXT NULL,
      started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_ads_ai_runs_keyword (keyword_id, created_at),
      KEY idx_ads_ai_runs_profile_status (profile_id, status, created_at),
      CONSTRAINT fk_ads_ai_run_keyword FOREIGN KEY (keyword_id) REFERENCES ads_keywords (id) ON UPDATE RESTRICT ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ads_ai_recommendations (
      id VARCHAR(64) NOT NULL,
      analysis_run_id VARCHAR(64) NOT NULL,
      profile_id VARCHAR(64) NOT NULL,
      keyword_id BIGINT UNSIGNED NOT NULL,
      action_type VARCHAR(48) NOT NULL,
      target_payload JSON NOT NULL,
      before_payload JSON NULL,
      after_payload JSON NULL,
      reason_text TEXT NOT NULL,
      risk_text TEXT NULL,
      evidence_payload JSON NULL,
      confidence DECIMAL(5,4) NOT NULL DEFAULT 0,
      observe_days INT UNSIGNED NOT NULL DEFAULT 3,
      status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
      execution_result JSON NULL,
      last_error TEXT NULL,
      confirmed_at DATETIME NULL,
      executed_at DATETIME NULL,
      review_due_at DATETIME NULL,
      reviewed_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_ads_ai_recommendations_keyword (keyword_id, status, created_at),
      KEY idx_ads_ai_recommendations_run (analysis_run_id),
      CONSTRAINT fk_ads_ai_recommendation_run FOREIGN KEY (analysis_run_id) REFERENCES ads_ai_analysis_runs (id) ON UPDATE RESTRICT ON DELETE CASCADE,
      CONSTRAINT fk_ads_ai_recommendation_keyword FOREIGN KEY (keyword_id) REFERENCES ads_keywords (id) ON UPDATE RESTRICT ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ads_ai_recommendation_events (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      recommendation_id VARCHAR(64) NOT NULL,
      event_type VARCHAR(48) NOT NULL,
      payload JSON NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_ads_ai_recommendation_events (recommendation_id, created_at),
      CONSTRAINT fk_ads_ai_recommendation_event FOREIGN KEY (recommendation_id) REFERENCES ads_ai_recommendations (id) ON UPDATE RESTRICT ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ads_ai_batch_runs (
      id VARCHAR(64) NOT NULL,
      profile_id VARCHAR(64) NOT NULL,
      trigger_source VARCHAR(32) NOT NULL,
      schedule_date DATE NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'RUNNING',
      keyword_count INT UNSIGNED NOT NULL DEFAULT 0,
      input_payload JSON NULL,
      output_payload JSON NULL,
      last_error TEXT NULL,
      started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_ads_ai_batch_daily (profile_id, trigger_source, schedule_date),
      KEY idx_ads_ai_batch_profile_status (profile_id, status, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sif_traffic_audit_runs (
      id VARCHAR(64) NOT NULL,
      profile_id VARCHAR(64) NOT NULL,
      country_code VARCHAR(8) NOT NULL DEFAULT 'US',
      parent_asin VARCHAR(32) NOT NULL DEFAULT '',
      target_asin VARCHAR(32) NOT NULL,
      competitor_asins JSON NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'RUNNING',
      model_name VARCHAR(128) NOT NULL DEFAULT '',
      input_payload JSON NULL,
      output_payload JSON NULL,
      last_error TEXT NULL,
      started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_sif_traffic_audit_target (profile_id, target_asin, created_at),
      KEY idx_sif_traffic_audit_status (profile_id, status, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query("ALTER TABLE ads_campaigns ADD COLUMN amazon_campaign_name VARCHAR(255) NULL AFTER campaign_name").catch(() => {});
  await pool.query("ALTER TABLE ads_campaigns ADD COLUMN lifecycle_status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE' AFTER desired_state").catch(() => {});
  await pool.query("ALTER TABLE ads_campaigns ADD COLUMN stopped_at DATETIME NULL AFTER lifecycle_status").catch(() => {});
  await pool.query("ALTER TABLE ads_keywords ADD COLUMN creation_batch VARCHAR(24) NOT NULL DEFAULT '' AFTER normalized_keyword").catch(() => {});
  await pool.query("ALTER TABLE ads_keywords ADD COLUMN active_scope_key VARCHAR(512) NULL AFTER creation_batch").catch(() => {});
  await pool.query("ALTER TABLE ads_keywords ADD COLUMN sort_order INT NOT NULL DEFAULT 0 AFTER keyword_group").catch(() => {});
  await pool.query("ALTER TABLE ads_keywords ADD COLUMN stopped_at DATETIME NULL AFTER lifecycle_status").catch(() => {});
  await pool.query("UPDATE ads_keywords SET active_scope_key = CONCAT(profile_id, '|', parent_asin, '|', normalized_keyword) WHERE lifecycle_status = 'ACTIVE' AND active_scope_key IS NULL").catch(() => {});
  await pool.query("ALTER TABLE ads_keywords ADD UNIQUE KEY uq_ads_keywords_active_scope (active_scope_key)").catch(() => {});
  await pool.query("ALTER TABLE ads_keywords ADD KEY idx_ads_keywords_parent_sort (profile_id, parent_asin, sort_order)").catch(() => {});
  await pool.query("ALTER TABLE ads_keywords ADD KEY idx_ads_keywords_creation_batch (profile_id, creation_batch)").catch(() => {});
  await pool.query("ALTER TABLE ads_keywords DROP INDEX uq_ads_keywords_scope").catch(() => {});
  await pool.query("ALTER TABLE ads_campaigns ADD COLUMN creation_batch VARCHAR(24) NOT NULL DEFAULT '' AFTER match_type").catch(() => {});
  await pool.query("ALTER TABLE ads_campaigns ADD COLUMN child_asin VARCHAR(32) NULL AFTER match_type").catch(() => {});
  await pool.query("ALTER TABLE ads_campaigns ADD COLUMN seller_sku VARCHAR(128) NULL AFTER child_asin").catch(() => {});
  await pool.query("ALTER TABLE ads_campaigns DROP INDEX uq_ads_campaign_match").catch(() => {});
  await pool.query("ALTER TABLE ads_campaigns ADD KEY idx_ads_campaigns_keyword_match_asin (keyword_id, match_type, child_asin)").catch(() => {});
  await pool.query("ALTER TABLE ads_campaigns ADD COLUMN entity_key VARCHAR(255) NULL AFTER creation_batch").catch(() => {});
  await pool.query("ALTER TABLE ads_creation_templates ADD COLUMN rest_of_search_adjustment INT UNSIGNED NOT NULL DEFAULT 0 AFTER top_of_search_adjustment").catch(() => {});
  await pool.query("ALTER TABLE ads_creation_templates ADD COLUMN product_page_adjustment INT UNSIGNED NOT NULL DEFAULT 0 AFTER rest_of_search_adjustment").catch(() => {});
  await pool.query("ALTER TABLE ads_campaigns ADD COLUMN rest_of_search_adjustment INT UNSIGNED NOT NULL DEFAULT 0 AFTER top_of_search_adjustment").catch(() => {});
  await pool.query("ALTER TABLE ads_campaigns ADD COLUMN product_page_adjustment INT UNSIGNED NOT NULL DEFAULT 0 AFTER rest_of_search_adjustment").catch(() => {});
  await pool.query("ALTER TABLE ads_campaigns ADD UNIQUE KEY uq_ads_campaign_entity_key (profile_id, entity_key)").catch(() => {});
  await pool.query("ALTER TABLE ads_ad_units ADD COLUMN amazon_ad_group_name VARCHAR(255) NULL AFTER ad_group_name").catch(() => {});
  await pool.query("ALTER TABLE ads_ad_units ADD COLUMN creation_batch VARCHAR(24) NOT NULL DEFAULT '' AFTER seller_sku").catch(() => {});
  await pool.query("ALTER TABLE ads_ad_units ADD COLUMN entity_key VARCHAR(255) NULL AFTER creation_batch").catch(() => {});
  await pool.query("ALTER TABLE ads_ad_units ADD UNIQUE KEY uq_ads_ad_unit_entity_key (profile_id, entity_key)").catch(() => {});
  await pool.query("ALTER TABLE ads_ad_units ADD COLUMN amazon_ad_group_state VARCHAR(16) NULL AFTER amazon_state").catch(() => {});
  await pool.query("ALTER TABLE ads_ad_units ADD COLUMN amazon_product_ad_state VARCHAR(16) NULL AFTER amazon_ad_group_state").catch(() => {});
  await pool.query("ALTER TABLE ads_ad_units ADD COLUMN amazon_target_state VARCHAR(16) NULL AFTER amazon_product_ad_state").catch(() => {});
}

async function ensureAppMysqlSchema() {
  if (!isMysqlEnabled()) {
    throw new Error("Database storage is required. Remove DB_DISABLED or configure DB_* in .env.");
  }
  if (appMysqlSchemaReady) return true;
  await ensureMysqlDatabase();
  const pool = getMysqlPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS collaboration_requests (
      id VARCHAR(64) NOT NULL,
      position INT NOT NULL DEFAULT 0,
      payload JSON NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_collaboration_requests_position (position),
      KEY idx_collaboration_requests_created_at (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS manual_products (
      id VARCHAR(64) NOT NULL,
      position INT NOT NULL DEFAULT 0,
      payload JSON NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_manual_products_position (position)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS factory_inventory_products (
      id VARCHAR(64) NOT NULL,
      position INT NOT NULL DEFAULT 0,
      payload JSON NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_factory_inventory_products_position (position)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS factory_inventory_movements (
      id VARCHAR(64) NOT NULL,
      position INT NOT NULL DEFAULT 0,
      payload JSON NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_factory_inventory_movements_position (position),
      KEY idx_factory_inventory_movements_created_at (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS parent_asin_metadata (
      parent_asin VARCHAR(32) NOT NULL,
      internal_name VARCHAR(255) NOT NULL DEFAULT '',
      sort_order INT NOT NULL DEFAULT 0,
      category_id VARCHAR(64) NOT NULL DEFAULT '',
      category_name VARCHAR(255) NOT NULL DEFAULT '',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (parent_asin)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query("ALTER TABLE parent_asin_metadata ADD COLUMN sort_order INT NOT NULL DEFAULT 0 AFTER internal_name").catch(() => {});
  await pool.query("ALTER TABLE parent_asin_metadata ADD COLUMN category_id VARCHAR(64) NOT NULL DEFAULT '' AFTER sort_order").catch(() => {});
  await pool.query("ALTER TABLE parent_asin_metadata ADD COLUMN category_name VARCHAR(255) NOT NULL DEFAULT '' AFTER category_id").catch(() => {});
  await pool.query(`
    CREATE TABLE IF NOT EXISTS amazon_browse_categories (
      category_id VARCHAR(64) NOT NULL,
      category_name VARCHAR(255) NOT NULL DEFAULT '',
      source VARCHAR(32) NOT NULL DEFAULT '',
      last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (category_id),
      KEY idx_amazon_browse_categories_name (category_name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    INSERT INTO amazon_browse_categories (category_id, category_name, source)
    VALUES ('3743931', 'Under-Bed Storage', 'MANUAL')
    ON DUPLICATE KEY UPDATE category_name = VALUES(category_name)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_secrets (
      secret_key VARCHAR(128) NOT NULL,
      encrypted_value JSON NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (secret_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS system_schedule_settings (
      task_key VARCHAR(64) NOT NULL,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      schedule_type VARCHAR(16) NOT NULL,
      time_beijing CHAR(5) NULL,
      interval_minutes INT UNSIGNED NULL,
      last_run_key VARCHAR(32) NULL,
      last_started_at DATETIME NULL,
      last_completed_at DATETIME NULL,
      last_status VARCHAR(16) NULL,
      last_error TEXT NULL,
      retry_count TINYINT UNSIGNED NOT NULL DEFAULT 0,
      next_retry_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (task_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query("ALTER TABLE system_schedule_settings ADD COLUMN retry_count TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER last_error").catch(() => {});
  await pool.query("ALTER TABLE system_schedule_settings ADD COLUMN next_retry_at DATETIME NULL AFTER retry_count").catch(() => {});
  await ensureAdsMysqlSchema(pool);
  appMysqlSchemaReady = true;
  return true;
}

function secretEncryptionKey() {
  const raw = String(process.env.TOKEN_ENCRYPTION_KEY || "").trim();
  if (!raw) throw new Error("请先在 .env 配置 TOKEN_ENCRYPTION_KEY，用于加密数据库中的授权 token");
  return createHash("sha256").update(raw).digest();
}

function encryptSecretValue(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretEncryptionKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(value ?? null), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };
}

function decryptSecretValue(encrypted) {
  const payload = typeof encrypted === "string" ? JSON.parse(encrypted) : encrypted;
  if (payload?.algorithm !== "aes-256-gcm") throw new Error("数据库授权 token 加密格式不支持");
  const decipher = createDecipheriv("aes-256-gcm", secretEncryptionKey(), Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final()
  ]);
  return JSON.parse(plaintext.toString("utf8"));
}

async function readJsonFileIfExists(pathname) {
  if (!existsSync(pathname)) return null;
  try {
    return JSON.parse(await readFile(pathname, "utf8"));
  } catch {
    return null;
  }
}

async function readAppSecret(secretKey, fallbackPath = "") {
  await ensureAppMysqlSchema();
  const pool = getMysqlPool();
  const [rows] = await pool.query("SELECT encrypted_value FROM app_secrets WHERE secret_key = ?", [secretKey]);
  if (rows[0]?.encrypted_value) return decryptSecretValue(rows[0].encrypted_value);

  const fallback = fallbackPath ? await readJsonFileIfExists(fallbackPath) : null;
  if (fallback) await writeAppSecret(secretKey, fallback);
  return fallback;
}

async function writeAppSecret(secretKey, value) {
  await ensureAppMysqlSchema();
  const pool = getMysqlPool();
  const encrypted = encryptSecretValue(value);
  await pool.query(`
    INSERT INTO app_secrets (secret_key, encrypted_value)
    VALUES (?, CAST(? AS JSON))
    ON DUPLICATE KEY UPDATE encrypted_value = VALUES(encrypted_value)
  `, [secretKey, JSON.stringify(encrypted)]);
}

async function deleteAppSecret(secretKey) {
  await ensureAppMysqlSchema();
  await getMysqlPool().query("DELETE FROM app_secrets WHERE secret_key = ?", [secretKey]);
}

async function ensureSystemScheduleDefaults() {
  const pool = getMysqlPool();
  const envEnabled = value => !["0", "false"].includes(String(value || "").toLowerCase());
  for (const [taskKey, task] of Object.entries(SYSTEM_SCHEDULE_TASKS)) {
    let definition = task;
    let enabled = task.enabled;
    if (taskKey.startsWith("FBA_")) enabled = enabled && envEnabled(process.env.AMZ_FBA_SCHEDULE_ENABLED);
    if (taskKey.startsWith("ADS_") && taskKey !== "ADS_AI_ANALYSIS") enabled = enabled && envEnabled(process.env.AMZ_ADS_SYNC_ENABLED);
    if (taskKey === "SIF_KEYWORD_DATA") enabled = enabled && envEnabled(process.env.SIF_SYNC_ENABLED);
    if (taskKey === "ADS_AI_ANALYSIS") {
      const [strategyRows] = await pool.query("SELECT rules_payload FROM ads_ai_strategy_versions ORDER BY created_at DESC LIMIT 1");
      const schedule = sanitizeAdsAiStrategyRules(parseMysqlJson(strategyRows[0]?.rules_payload)).schedule;
      enabled = schedule.dailyBatchEnabled && envEnabled(process.env.ADS_AI_DAILY_ANALYSIS_ENABLED);
      definition = { ...task, time: schedule.dailyBatchTime || task.time };
    }
    await pool.query(`
      INSERT IGNORE INTO system_schedule_settings (task_key, enabled, schedule_type, time_beijing, interval_minutes)
      VALUES (?, ?, ?, ?, ?)
    `, [taskKey, enabled ? 1 : 0, definition.type, definition.time || null, definition.intervalMinutes || null]);
  }
}

function mapSystemSchedule(row) {
  const definition = SYSTEM_SCHEDULE_TASKS[row.task_key];
  return {
    key: row.task_key,
    label: definition?.label || row.task_key,
    description: definition?.description || "",
    scheduleType: row.schedule_type,
    enabled: Boolean(row.enabled),
    timeBeijing: row.time_beijing || "",
    intervalMinutes: Number(row.interval_minutes || 0),
    minIntervalMinutes: Number(definition?.minInterval || 1),
    lastRunKey: row.last_run_key || "",
    lastStartedAt: row.last_started_at,
    lastCompletedAt: row.last_completed_at,
    lastStatus: row.last_status || "",
    lastError: row.last_error || "",
    retryCount: Number(row.retry_count || 0),
    nextRetryAt: row.next_retry_at || null
  };
}

function timeKeyInTimeZone(date, timeZone = SYSTEM_SCHEDULE_TIME_ZONE) {
  const parts = getZonedParts(date, timeZone);
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

function shouldResetDailyRunKeyForNewTime(row, nextTime) {
  if (!row?.last_started_at || row.last_run_key !== formatDateInTimeZone(new Date(), SYSTEM_SCHEDULE_TIME_ZONE)) return false;
  const previousTime = row.time_beijing || "";
  if (!previousTime || previousTime === nextTime) return false;
  return timeKeyInTimeZone(new Date(row.last_started_at), SYSTEM_SCHEDULE_TIME_ZONE) < nextTime;
}

function systemScheduleOutcome(result) {
  if (result?.skipped || result?.started === false) {
    return {
      status: "SKIPPED",
      error: result.reason || result.message || "任务已跳过"
    };
  }
  if (Array.isArray(result?.jobs) && result.jobs.length && result.jobs.every(job => ["FAILED", "CANCELLED"].includes(String(job.status || "").toUpperCase()))) {
    return {
      status: "FAILED",
      error: result.jobs.map(job => job.error || job.status).filter(Boolean).join("; ") || "任务创建失败"
    };
  }
  if (Array.isArray(result?.errors) && result.errors.length) {
    return { status: "FAILED", error: result.errors.join("; ") };
  }
  if (["FAILED", "PARTIAL"].includes(String(result?.status || "").toUpperCase())) {
    return { status: "FAILED", error: result.error || result.lastError || "任务执行失败" };
  }
  return { status: "COMPLETE", error: null };
}

const SYSTEM_SCHEDULE_RETRY_DELAY_MINUTES = 5;
const SYSTEM_SCHEDULE_MAX_RETRIES = 2;

async function finishSystemScheduleTask(pool, taskKey, result, options = {}) {
  const outcome = systemScheduleOutcome(result);
  if (outcome.status === "FAILED" && options.retry !== false) {
    await scheduleSystemScheduleRetry(pool, taskKey, outcome.error);
    return;
  }
  await pool.query(
    "UPDATE system_schedule_settings SET last_completed_at = NOW(), last_status = ?, last_error = ?, retry_count = 0, next_retry_at = NULL WHERE task_key = ?",
    [outcome.status, outcome.error, taskKey]
  );
}

async function scheduleSystemScheduleRetry(pool, taskKey, error) {
  const [rows] = await pool.query("SELECT retry_count FROM system_schedule_settings WHERE task_key = ?", [taskKey]);
  const retryCount = Number(rows[0]?.retry_count || 0);
  const nextRetryCount = retryCount + 1;
  const nonRetryable = /未配置|尚未就绪|请先授权|不存在|不合法|校验|不是合法 JSON|缺少|无效|权限不足/i.test(String(error || ""));
  if (!nonRetryable && nextRetryCount <= SYSTEM_SCHEDULE_MAX_RETRIES) {
    await pool.query(
      "UPDATE system_schedule_settings SET last_status = 'RETRY_WAIT', last_error = ?, retry_count = ?, next_retry_at = DATE_ADD(NOW(), INTERVAL ? MINUTE) WHERE task_key = ?",
      [`${error}（将在 ${SYSTEM_SCHEDULE_RETRY_DELAY_MINUTES} 分钟后进行第 ${nextRetryCount} 次重试）`, nextRetryCount, SYSTEM_SCHEDULE_RETRY_DELAY_MINUTES, taskKey]
    );
    return;
  }
  await pool.query(
    "UPDATE system_schedule_settings SET last_completed_at = NOW(), last_status = 'FAILED', last_error = ?, next_retry_at = NULL WHERE task_key = ?",
    [nonRetryable ? error : `${error}（已完成 ${SYSTEM_SCHEDULE_MAX_RETRIES} 次自动重试）`, taskKey]
  );
}

async function readSystemSchedules() {
  await ensureSystemScheduleDefaults();
  const [rows] = await getMysqlPool().query("SELECT * FROM system_schedule_settings ORDER BY FIELD(task_key, 'FBA_TODAY_SALES','FBA_CURRENT_INVENTORY','FBA_HISTORY_BACKFILL','ADS_TODAY_PERFORMANCE','ADS_ROLLING_PERFORMANCE','SIF_KEYWORD_DATA','ADS_AI_ANALYSIS')");
  return { timeZone: SYSTEM_SCHEDULE_TIME_ZONE, tasks: rows.filter(row => SYSTEM_SCHEDULE_TASKS[row.task_key]).map(mapSystemSchedule) };
}

async function updateSystemSchedules(input = {}) {
  await ensureSystemScheduleDefaults();
  const pool = getMysqlPool();
  const tasks = Array.isArray(input.tasks) ? input.tasks : [];
  for (const item of tasks) {
    const taskKey = String(item.key || "");
    const definition = SYSTEM_SCHEDULE_TASKS[taskKey];
    if (!definition) continue;
    if (definition.type === "DAILY") {
      const time = String(item.timeBeijing || definition.time || "");
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error(`${definition.label}的执行时间不合法`);
      const [currentRows] = await pool.query("SELECT time_beijing, last_run_key, last_started_at FROM system_schedule_settings WHERE task_key = ?", [taskKey]);
      const resetRunKey = shouldResetDailyRunKeyForNewTime(currentRows[0], time);
      await pool.query(
        `UPDATE system_schedule_settings
         SET enabled = ?, time_beijing = ?, schedule_type = 'DAILY', last_run_key = IF(?, NULL, last_run_key)
         WHERE task_key = ?`,
        [item.enabled ? 1 : 0, time, resetRunKey ? 1 : 0, taskKey]
      );
    } else {
      const interval = Math.max(Number(definition.minInterval || 1), Math.round(Number(item.intervalMinutes || definition.intervalMinutes)));
      if (!Number.isFinite(interval)) throw new Error(`${definition.label}的执行间隔不合法`);
      await pool.query("UPDATE system_schedule_settings SET enabled = ?, interval_minutes = ?, schedule_type = 'INTERVAL' WHERE task_key = ?", [item.enabled ? 1 : 0, interval, taskKey]);
    }
  }
  return readSystemSchedules();
}

async function runSystemScheduleTaskNow(taskKey) {
  await ensureSystemScheduleDefaults();
  const definition = SYSTEM_SCHEDULE_TASKS[taskKey];
  if (!definition) throw new Error("未知定时任务");
  const pool = getMysqlPool();
  const runKey = `manual:${new Date().toISOString()}`;
  await pool.query("UPDATE system_schedule_settings SET last_run_key = ?, last_started_at = NOW(), last_status = 'RUNNING', last_error = NULL, retry_count = 0, next_retry_at = NULL WHERE task_key = ?", [runKey, taskKey]);
  Promise.resolve(executeSystemScheduledTask(taskKey)).then(async result => {
    await finishSystemScheduleTask(pool, taskKey, result, { retry: false });
  }).catch(async error => {
    await pool.query("UPDATE system_schedule_settings SET last_completed_at = NOW(), last_status = 'FAILED', last_error = ?, next_retry_at = NULL WHERE task_key = ?", [error.message, taskKey]);
    console.error(`Manual system schedule ${taskKey} failed: ${error.message}`);
  });
  return readSystemSchedules();
}

function parseSifCurl(curlText) {
  const source = String(curlText || "").trim();
  if (!source) throw new Error("请粘贴从 SIF 复制的 cURL 请求");
  const urlMatch = source.match(/https:\/\/www\.sif\.com\/api\/[^\s'\"]*/i);
  if (!urlMatch) throw new Error("未找到有效的 SIF API 请求地址");
  const requestUrl = new URL(urlMatch[0]);
  const headers = {};
  const headerPattern = /(?:--header|-H)\s+(?:'([^']*)'|"([^"]*)")/gi;
  let headerMatch;
  while ((headerMatch = headerPattern.exec(source))) {
    const line = headerMatch[1] ?? headerMatch[2] ?? "";
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }
  const authorization = String(headers.authorization || "").trim();
  if (!authorization) throw new Error("cURL 中没有找到 authorization 请求头");
  const refererCountry = String(headers.referer || "").match(/[?&]country=([A-Za-z]{2})/i)?.[1] || "";
  return {
    authorization,
    cookie: String(headers.cookie || "").trim(),
    userAgent: String(headers["user-agent"] || "Mozilla/5.0").trim(),
    marker: String(requestUrl.searchParams.get("_m") || "").trim(),
    country: String(requestUrl.searchParams.get("country") || refererCountry || "US").trim().toUpperCase()
  };
}

function sifRequestUrl(pathname, credentials) {
  const url = new URL(pathname, SIF_ORIGIN);
  url.searchParams.set("country", credentials.country || "US");
  url.searchParams.set("_t", String(Date.now()));
  if (credentials.marker) url.searchParams.set("_m", credentials.marker);
  return url;
}

async function sifRequest(pathname, body, credentials) {
  const response = await fetch(sifRequestUrl(pathname, credentials), {
    method: "POST",
    headers: {
      accept: "application/json, text/plain, */*",
      "content-type": "application/json;charset=UTF-8",
      origin: SIF_ORIGIN,
      referer: `${SIF_ORIGIN}/dailyrank?country=${encodeURIComponent(credentials.country || "US")}`,
      "user-agent": credentials.userAgent || "Mozilla/5.0",
      authorization: credentials.authorization,
      ...(credentials.cookie ? { cookie: credentials.cookie } : {})
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Number(process.env.SIF_REQUEST_TIMEOUT_MS || 20_000))
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`SIF 返回了无法解析的响应（HTTP ${response.status}）`);
  }
  if (!response.ok || Number(payload?.code) !== 1) {
    const remoteMessage = String(payload?.message || payload?.msg || payload?.error || "授权可能已过期").slice(0, 180);
    throw new Error(`SIF 请求失败：${remoteMessage}`);
  }
  return payload;
}

async function checkSifCredentials(credentials) {
  const response = await fetch(sifRequestUrl("/api/user/sys/info", credentials), {
    method: "GET",
    headers: {
      accept: "application/json, text/plain, */*",
      origin: SIF_ORIGIN,
      referer: `${SIF_ORIGIN}/dailyrank?country=${encodeURIComponent(credentials.country || "US")}`,
      "user-agent": credentials.userAgent || "Mozilla/5.0",
      authorization: credentials.authorization,
      ...(credentials.cookie ? { cookie: credentials.cookie } : {})
    },
    signal: AbortSignal.timeout(Number(process.env.SIF_REQUEST_TIMEOUT_MS || 20_000))
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`SIF 返回了无法解析的响应（HTTP ${response.status}）`);
  }
  if (!response.ok || Number(payload?.code) !== 1) {
    const remoteMessage = String(payload?.message || payload?.msg || payload?.error || "authorization 可能已过期").slice(0, 180);
    throw new Error(`SIF 身份验证失败：${remoteMessage}`);
  }
  return true;
}

function normalizeSifAsin(value) {
  const asin = String(value || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(asin)) throw new Error("请输入有效的 10 位子 ASIN");
  return asin;
}

function normalizeSifKeyword(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

async function setSifMonitorStatuses(country, asin, keywords, status, { source = "SIF", error = null } = {}) {
  const safeCountry = String(country || "US").trim().toUpperCase();
  const safeAsin = normalizeSifAsin(asin);
  const rows = [...new Map((keywords || []).map(keyword => {
    const text = String(keyword || "").trim().replace(/\s+/g, " ");
    return [normalizeSifKeyword(text), text];
  }).filter(([normalized]) => normalized)).entries()];
  if (!rows.length) return [];
  const now = new Date();
  await getMysqlPool().query(`
    INSERT INTO sif_keyword_monitors (
      country_code, asin, keyword_text, normalized_keyword, monitor_status, sort_order, source,
      last_seen_at, last_synced_at, last_error
    ) VALUES ?
    ON DUPLICATE KEY UPDATE
      keyword_text = VALUES(keyword_text), monitor_status = VALUES(monitor_status),
      source = IF(source = 'ADS', source, VALUES(source)),
      last_seen_at = IF(VALUES(monitor_status) = 'ACTIVE', VALUES(last_seen_at), last_seen_at),
      last_synced_at = VALUES(last_synced_at), last_error = VALUES(last_error)
  `, [rows.map(([normalized, text]) => [
    safeCountry, safeAsin, text, normalized, status, 0, source,
    status === "ACTIVE" ? now : null, now, error
  ])]);
  if (status === "ACTIVE") {
    const normalizedOrder = rows.map(([normalized]) => normalized);
    const [unordered] = await getMysqlPool().query(`
      SELECT id, normalized_keyword FROM sif_keyword_monitors
      WHERE country_code = ? AND asin = ? AND monitor_status = 'ACTIVE' AND sort_order = 0 AND normalized_keyword IN (?)
    `, [safeCountry, safeAsin, normalizedOrder]);
    const unorderedByKeyword = new Map(unordered.map(row => [row.normalized_keyword, row.id]));
    if (unorderedByKeyword.size) {
      const [maxRows] = await getMysqlPool().query(`
        SELECT COALESCE(MAX(sort_order), 0) max_sort_order
        FROM sif_keyword_monitors
        WHERE country_code = ? AND asin = ? AND monitor_status = 'ACTIVE' AND sort_order > 0
      `, [safeCountry, safeAsin]);
      let order = Number(maxRows[0]?.max_sort_order || 0);
      for (const normalized of normalizedOrder) {
        const id = unorderedByKeyword.get(normalized);
        if (!id) continue;
        order += 10;
        await getMysqlPool().query("UPDATE sif_keyword_monitors SET sort_order = ? WHERE id = ?", [order, id]);
      }
    }
  }
  return rows.map(([normalized]) => normalized);
}

async function syncSifKeywordSnapshot(asin, payload, country = "US") {
  const data = payload?.data || {};
  const keywords = Array.isArray(data.keywords) ? data.keywords.filter(item => item?.keyword) : [];
  const safeAsin = normalizeSifAsin(asin);
  const safeCountry = String(country || "US").trim().toUpperCase();
  const normalized = await setSifMonitorStatuses(safeCountry, safeAsin, keywords.map(item => item.keyword), "ACTIVE", { source: "SIF" });
  const pool = getMysqlPool();
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const completeSnapshot = Number(data.total || 0) <= keywords.length;
    if (completeSnapshot) {
      if (normalized.length) {
        await connection.query(`
          UPDATE sif_keyword_monitors
          SET monitor_status = 'INACTIVE', last_synced_at = NOW()
          WHERE country_code = ? AND asin = ? AND monitor_status = 'ACTIVE'
            AND normalized_keyword NOT IN (?)
        `, [safeCountry, safeAsin, normalized]);
      } else {
        await connection.query(`
          UPDATE sif_keyword_monitors SET monitor_status = 'INACTIVE', last_synced_at = NOW()
          WHERE country_code = ? AND asin = ? AND monitor_status = 'ACTIVE'
        `, [safeCountry, safeAsin]);
      }
    }
    const [monitorRows] = await connection.query(`
      SELECT id, normalized_keyword FROM sif_keyword_monitors
      WHERE country_code = ? AND asin = ?
    `, [safeCountry, safeAsin]);
    const monitorIds = new Map(monitorRows.map(row => [row.normalized_keyword, Number(row.id)]));
    const daily = new Map();
    for (const keyword of keywords) {
      const monitorId = monitorIds.get(normalizeSifKeyword(keyword.keyword));
      if (!monitorId) continue;
      for (const rankItem of Array.isArray(keyword.rankInfo) ? keyword.rankInfo : []) {
        const nf = rankItem?.nf || {};
        const sp = rankItem?.sp || {};
        const date = String(nf.updateTime || sp.updateTime || "").slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        daily.set(`${monitorId}|${date}`, {
          monitorId, date,
          naturalRank: nf.rank === null || nf.rank === undefined ? null : Number(nf.rank),
          naturalRankStr: nf.rankStr || null, naturalAsin: nf.asin || safeAsin,
          spRank: sp.rank === null || sp.rank === undefined ? null : Number(sp.rank),
          spRankStr: sp.rankStr || null, spAsin: sp.asin || safeAsin,
          searches: null, abaRank: null
        });
      }
      const history = keyword.estSearchesNumHistory || {};
      const historyDates = Array.isArray(history.date) ? history.date : [];
      for (let index = 0; index < historyDates.length; index += 1) {
        const date = String(historyDates[index] || "").slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        const key = `${monitorId}|${date}`;
        const item = daily.get(key) || {
          monitorId, date, naturalRank: null, naturalRankStr: null, naturalAsin: null,
          spRank: null, spRankStr: null, spAsin: null, searches: null, abaRank: null
        };
        item.searches = history.estSearchesNum?.[index] === null || history.estSearchesNum?.[index] === undefined ? null : Number(history.estSearchesNum[index]);
        item.abaRank = history.searchesRank?.[index] === null || history.searchesRank?.[index] === undefined ? null : Number(history.searchesRank[index]);
        daily.set(key, item);
      }
    }
    const rows = [...daily.values()];
    if (rows.length) {
      await connection.query(`
        INSERT INTO sif_keyword_rank_daily (
          monitor_id, date, natural_rank, natural_rank_str, natural_asin,
          sp_rank, sp_rank_str, sp_asin, est_searches_num, aba_rank, synced_at
        ) VALUES ?
        ON DUPLICATE KEY UPDATE
          natural_rank = VALUES(natural_rank), natural_rank_str = VALUES(natural_rank_str), natural_asin = VALUES(natural_asin),
          sp_rank = VALUES(sp_rank), sp_rank_str = VALUES(sp_rank_str), sp_asin = VALUES(sp_asin),
          est_searches_num = COALESCE(VALUES(est_searches_num), est_searches_num),
          aba_rank = COALESCE(VALUES(aba_rank), aba_rank), synced_at = VALUES(synced_at)
      `, [rows.map(item => [
        item.monitorId, item.date, item.naturalRank, item.naturalRankStr, item.naturalAsin,
        item.spRank, item.spRankStr, item.spAsin, item.searches, item.abaRank, new Date()
      ])]);
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

async function listSifKeywords(credentials, asin = "") {
  const selectedAsin = normalizeSifAsin(asin);
  const payload = await sifRequest("/api/search/subscribe/v2", {
    filterAsin: "",
    granularity: "week",
    asin: selectedAsin,
    endDay: null,
    pageNum: 1,
    pageSize: 200,
    interval: 7,
    sortBy: "estSearchesNum",
    desc: true,
    isListingSearch: true,
    isExample: false
  }, credentials);
  await syncSifKeywordSnapshot(selectedAsin, payload, credentials.country || "US");
  return { selectedAsin, payload };
}

async function ensureSifAsinClassification(asin, forceRefresh = false) {
  const selectedAsin = normalizeSifAsin(asin);
  const config = getSpApiConfig();
  const metadataRows = (await readFbaSkuMetadataRows()).filter(row =>
    row.marketplaceId === config.marketplaceId && normalizeAsin(row.asin) === selectedAsin
  );
  if (!forceRefresh) {
    for (const row of metadataRows) {
      const classification = catalogClassification(row);
      if (classification.categoryIds.length) return classification;
    }
  }
  const fetched = await fetchCatalogDetails([selectedAsin]);
  const item = fetched.get(selectedAsin);
  if (!item?.categoryIds?.length) return { categoryId: "", categoryName: "", categoryIds: [], categoryNodes: [] };
  await upsertBrowseCategories(item.categoryNodes || [], "AMAZON_CATALOG");
  const fetchedAt = new Date().toISOString();
  if (metadataRows.length) {
    await upsertFbaSkuMetadata(metadataRows.map(row => ({
      ...row,
      parentAsin: item.parentAsin || row.parentAsin || "",
      title: item.title || row.title || "",
      brand: item.brand || row.brand || "",
      imageUrl: item.imageUrl || row.imageUrl || "",
      lastSeenAt: fetchedAt,
      rawJson: {
        source: "catalog",
        catalogFetchedAt: fetchedAt,
        browseClassification: {
          categoryId: item.categoryId || "",
          categoryName: item.categoryName || "",
          categoryIds: item.categoryIds || [],
          categoryNodes: item.categoryNodes || []
        }
      }
    })), "catalog").catch(() => {});
  }
  return {
    categoryId: item.categoryId || "",
    categoryName: item.categoryName || "",
    categoryIds: item.categoryIds || [],
    categoryNodes: item.categoryNodes || []
  };
}

async function readParentCategoryForChildAsin(asin) {
  const selectedAsin = normalizeSifAsin(asin);
  const config = getSpApiConfig();
  const metadataRows = (await readFbaSkuMetadataRows()).filter(row =>
    row.marketplaceId === config.marketplaceId && normalizeAsin(row.asin) === selectedAsin
  );
  const parentAsin = normalizeAsin(metadataRows.find(row => normalizeAsin(row.parentAsin))?.parentAsin);
  if (!parentAsin) return { parentAsin: "", categoryId: "", categoryName: "" };
  const parent = (await readParentAsinMetadataRows()).find(row => row.parentAsin === parentAsin);
  return {
    parentAsin,
    categoryId: String(parent?.categoryId || ""),
    categoryName: String(parent?.categoryName || "")
  };
}

function sifFixedBidValues(category, matchType) {
  const values = category?.matchTypes?.[matchType]?.legacy || {};
  const number = value => value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
  return { start: number(values.start), median: number(values.median), end: number(values.end) };
}

async function syncSifKeywordBids(credentials, asin, keywordTexts) {
  const selectedAsin = normalizeSifAsin(asin);
  const keywords = [...new Map((keywordTexts || []).map(value => {
    const text = String(value || "").trim().replace(/\s+/g, " ");
    return [normalizeSifKeyword(text), text];
  }).filter(([normalized]) => normalized)).values()];
  if (!keywords.length) return { saved: 0, skipped: true };
  const country = String(credentials.country || "US").toUpperCase();
  const normalizedKeywords = keywords.map(normalizeSifKeyword);
  const [monitorRows] = await getMysqlPool().query(`
    SELECT id, normalized_keyword FROM sif_keyword_monitors
    WHERE country_code = ? AND asin = ? AND normalized_keyword IN (?)
  `, [country, selectedAsin, normalizedKeywords]);
  const monitorIds = new Map(monitorRows.map(row => [row.normalized_keyword, Number(row.id)]));
  if (monitorRows.length) {
    const [todayRows] = await getMysqlPool().query(`
      SELECT COUNT(DISTINCT monitor_id) saved_count FROM sif_keyword_bid_daily
      WHERE monitor_id IN (?) AND date = ?
    `, [monitorRows.map(row => Number(row.id)), formatDateInTimeZone()]);
    if (Number(todayRows[0]?.saved_count || 0) >= monitorRows.length) {
      return { saved: 0, skipped: true, reason: "already_synced_today" };
    }
  }
  let classification = await ensureSifAsinClassification(selectedAsin);
  if (!classification.categoryIds.length) throw new Error(`${selectedAsin} 的 Amazon Catalog 类目节点暂时无法获取`);
  const parentCategory = await readParentCategoryForChildAsin(selectedAsin);
  let categoryPriority = [...new Set([classification.categoryId, ...classification.categoryIds].filter(Boolean))];
  const responseKeywords = [];
  for (const batch of chunkArray(keywords, 30)) {
    const payload = await sifRequest("/api/search/cpc/category", {
      isExpand: true,
      keywords: batch,
      pageNum: 1,
      pageSize: 30,
      granularity: "week",
      desc: true,
      sortBy: "estSearchesNum"
    }, credentials);
    responseKeywords.push(...(Array.isArray(payload?.data?.keywords) ? payload.data.keywords : []));
  }
  await upsertBrowseCategories(responseKeywords.flatMap(item => Array.isArray(item.categorys) ? item.categorys : []), "SIF_CPC");
  const availableCategoryIds = new Set(responseKeywords.flatMap(item =>
    (Array.isArray(item.categorys) ? item.categorys : []).map(category => String(category?.categoryId || "")).filter(Boolean)
  ));
  if (!categoryPriority.some(categoryId => availableCategoryIds.has(String(categoryId))) &&
      !availableCategoryIds.has(String(parentCategory.categoryId || ""))) {
    classification = await ensureSifAsinClassification(selectedAsin, true);
    categoryPriority = [...new Set([classification.categoryId, ...classification.categoryIds].filter(Boolean))];
  }
  const normalized = responseKeywords.map(item => normalizeSifKeyword(item.keyword)).filter(Boolean);
  if (!normalized.length) return { saved: 0, category: classification };
  const rows = [];
  for (const keyword of responseKeywords) {
    const monitorId = monitorIds.get(normalizeSifKeyword(keyword.keyword));
    if (!monitorId) continue;
    const categories = Array.isArray(keyword.categorys) ? keyword.categorys : [];
    let selectedCategory = null;
    let categorySource = "CHILD";
    for (const categoryId of categoryPriority) {
      selectedCategory = categories.find(category => String(category?.categoryId || "") === String(categoryId)) || null;
      if (selectedCategory) break;
    }
    if (!selectedCategory && parentCategory.categoryId) {
      selectedCategory = categories.find(category => String(category?.categoryId || "") === parentCategory.categoryId) || null;
      if (selectedCategory) categorySource = "PARENT";
    }
    rows.push({
      monitorId,
      category: selectedCategory || {
        categoryId: classification.categoryId || categoryPriority[0] || "UNKNOWN",
        categoryName: classification.categoryName || "Amazon Catalog 类目",
        saleNum: null,
        matchTypes: {}
      },
      matchStatus: selectedCategory ? "MATCHED" : "NO_CATEGORY_MATCH",
      categorySource,
      exact: sifFixedBidValues(selectedCategory, "exact"),
      phrase: sifFixedBidValues(selectedCategory, "phrase"),
      broad: sifFixedBidValues(selectedCategory, "broad")
    });
  }
  if (rows.length) {
    await getMysqlPool().query(`
      INSERT INTO sif_keyword_bid_daily (
        monitor_id, date, category_id, category_name, category_product_count, bid_mode, match_status, category_source,
        exact_start, exact_median, exact_end, phrase_start, phrase_median, phrase_end,
        broad_start, broad_median, broad_end, synced_at
      ) VALUES ?
      ON DUPLICATE KEY UPDATE
        category_id = VALUES(category_id), category_name = VALUES(category_name),
        category_product_count = VALUES(category_product_count), bid_mode = VALUES(bid_mode), match_status = VALUES(match_status), category_source = VALUES(category_source),
        exact_start = VALUES(exact_start), exact_median = VALUES(exact_median), exact_end = VALUES(exact_end),
        phrase_start = VALUES(phrase_start), phrase_median = VALUES(phrase_median), phrase_end = VALUES(phrase_end),
        broad_start = VALUES(broad_start), broad_median = VALUES(broad_median), broad_end = VALUES(broad_end),
        synced_at = VALUES(synced_at)
    `, [rows.map(row => [
      row.monitorId, formatDateInTimeZone(), String(row.category.categoryId || ""), String(row.category.categoryName || ""),
      row.category.saleNum === null || row.category.saleNum === undefined ? null : Number(row.category.saleNum), "legacy",
      row.matchStatus,
      row.categorySource,
      row.exact.start, row.exact.median, row.exact.end,
      row.phrase.start, row.phrase.median, row.phrase.end,
      row.broad.start, row.broad.median, row.broad.end,
      new Date()
    ])]);
  }
  return { saved: rows.length, requested: keywords.length, category: classification };
}

async function readSifLatestBids(asin, keywordTexts) {
  const normalized = [...new Set((keywordTexts || []).map(normalizeSifKeyword).filter(Boolean))];
  if (!normalized.length) return new Map();
  const [rows] = await getMysqlPool().query(`
    SELECT m.normalized_keyword, b.*
    FROM sif_keyword_monitors m
    JOIN sif_keyword_bid_daily b ON b.monitor_id = m.id
    JOIN (
      SELECT monitor_id, MAX(date) max_date FROM sif_keyword_bid_daily GROUP BY monitor_id
    ) latest ON latest.monitor_id = b.monitor_id AND latest.max_date = b.date
    WHERE m.asin = ? AND m.normalized_keyword IN (?)
  `, [normalizeSifAsin(asin), normalized]);
  const price = value => value === null || value === undefined ? null : Number(value);
  return new Map(rows.map(row => [row.normalized_keyword, {
    date: adsDateValue(row.date), mode: row.bid_mode || "legacy", matchStatus: row.match_status || "MATCHED", categorySource: row.category_source || "CHILD",
    categoryId: row.category_id || "", categoryName: row.category_name || "",
    productCount: row.category_product_count === null ? null : Number(row.category_product_count),
    exact: { start: price(row.exact_start), median: price(row.exact_median), end: price(row.exact_end) },
    phrase: { start: price(row.phrase_start), median: price(row.phrase_median), end: price(row.phrase_end) },
    broad: { start: price(row.broad_start), median: price(row.broad_median), end: price(row.broad_end) }
  }]));
}

async function readAdsKeywordChildProducts() {
  await ensureAppMysqlSchema();
  const profile = await readAdsProfileSelection();
  if (!profile?.profileId) return [];
  const [rows] = await getMysqlPool().query(`
    SELECT u.child_asin, k.parent_asin, MAX(k.updated_at) last_keyword_at
    FROM ads_ad_units u
    JOIN ads_campaigns c ON c.id = u.campaign_id
    JOIN ads_keywords k ON k.id = c.keyword_id
    WHERE u.profile_id = ?
      AND u.child_asin IS NOT NULL AND u.child_asin <> ''
      AND k.lifecycle_status IN ('ACTIVE', 'CREATING', 'STOPPING')
      AND c.lifecycle_status <> 'STOPPED'
      AND u.lifecycle_status <> 'STOPPED'
    GROUP BY u.child_asin, k.parent_asin
    ORDER BY last_keyword_at DESC, u.child_asin ASC
  `, [String(profile.profileId)]);
  const catalog = await readAdsProductCatalog();
  const parentByAsin = new Map(catalog.map(item => [item.parentAsin, item]));
  return rows.map(row => {
    const asin = String(row.child_asin || "").trim().toUpperCase();
    const parentAsin = String(row.parent_asin || "").trim().toUpperCase();
    const parent = parentByAsin.get(parentAsin);
    const child = parent?.children?.find(item => item.asin === asin) || null;
    return {
      asin,
      parentAsin,
      parentName: parent?.internalName || parentAsin,
      childName: child?.internalName || child?.title || asin,
      imageUrl: child?.imageUrl || ""
    };
  }).filter(item => /^[A-Z0-9]{10}$/.test(item.asin));
}

async function readAdsKeywordChildAsins() {
  return (await readAdsKeywordChildProducts()).map(item => item.asin);
}

async function readSifRankMatrix(asin, keywordTexts, maxDays = 60) {
  const normalized = [...new Set((keywordTexts || []).map(normalizeSifKeyword).filter(Boolean))];
  if (!normalized.length) return { dates: [], byKeyword: new Map() };
  const pool = getMysqlPool();
  const [maxRows] = await pool.query(`
    SELECT MAX(d.date) max_date
    FROM sif_keyword_rank_daily d JOIN sif_keyword_monitors m ON m.id = d.monitor_id
    WHERE m.asin = ? AND m.normalized_keyword IN (?)
      AND (d.natural_asin IS NOT NULL OR d.sp_asin IS NOT NULL)
  `, [asin, normalized]);
  const maxDate = adsDateValue(maxRows[0]?.max_date);
  if (!maxDate) return { dates: [], byKeyword: new Map() };
  const startDate = addDays(maxDate, -(Math.max(1, Math.min(60, Number(maxDays) || 60)) - 1));
  const [rows] = await pool.query(`
    SELECT m.normalized_keyword, d.date, d.natural_rank, d.natural_rank_str, d.natural_asin,
      d.sp_rank, d.sp_rank_str, d.sp_asin
    FROM sif_keyword_rank_daily d JOIN sif_keyword_monitors m ON m.id = d.monitor_id
    WHERE m.asin = ? AND m.normalized_keyword IN (?) AND d.date BETWEEN ? AND ?
      AND (d.natural_asin IS NOT NULL OR d.sp_asin IS NOT NULL)
    ORDER BY d.date DESC
  `, [asin, normalized, startDate, maxDate]);
  const dates = [...new Set(rows.map(row => adsDateValue(row.date)))];
  const byKeyword = new Map();
  for (const row of rows) {
    const list = byKeyword.get(row.normalized_keyword) || [];
    const date = adsDateValue(row.date);
    list.push({
      nf: { asin: row.natural_asin || asin, rank: row.natural_rank === null ? null : Number(row.natural_rank), rankStr: row.natural_rank_str || null, updateTime: date, changeType: "noChange", isSubscribe: true },
      sp: { asin: row.sp_asin || asin, rank: row.sp_rank === null ? null : Number(row.sp_rank), rankStr: row.sp_rank_str || null, updateTime: date, changeType: "noChange", isSubscribe: true }
    });
    byKeyword.set(row.normalized_keyword, list);
  }
  for (const list of byKeyword.values()) {
    for (let index = 0; index < list.length; index += 1) {
      for (const type of ["nf", "sp"]) {
        const current = list[index]?.[type];
        const previous = list[index + 1]?.[type];
        const currentRank = current?.rank;
        const previousRank = previous?.rank;
        const hasCurrentRank = currentRank !== null && currentRank !== "" && Number.isFinite(Number(currentRank));
        const hasPreviousRank = previousRank !== null && previousRank !== "" && Number.isFinite(Number(previousRank));
        if (!current || !hasCurrentRank || !hasPreviousRank) continue;
        current.changeType = Number(currentRank) < Number(previousRank) ? "up" : Number(currentRank) > Number(previousRank) ? "down" : "noChange";
      }
    }
  }
  return { dates, byKeyword };
}

async function readSifMonitorOrder(country, asin) {
  const [rows] = await getMysqlPool().query(`
    SELECT normalized_keyword, sort_order
    FROM sif_keyword_monitors
    WHERE country_code = ? AND asin = ? AND monitor_status = 'ACTIVE'
  `, [String(country || "US").toUpperCase(), normalizeSifAsin(asin)]);
  return new Map(rows.map(row => [row.normalized_keyword, Number(row.sort_order || 0)]));
}

function sifWorkspaceData(payloadData, adsProducts, matrix = { dates: [], byKeyword: new Map() }, bids = new Map(), order = new Map()) {
  const keywords = (payloadData?.keywords || []).map((keyword, index) => ({
    ...keyword,
    sortOrder: order.get(normalizeSifKeyword(keyword.keyword)) || 0,
    sourceIndex: index,
    rankInfo: matrix.byKeyword.get(normalizeSifKeyword(keyword.keyword)) || [],
    fixedBid: bids.get(normalizeSifKeyword(keyword.keyword)) || null
  })).sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0) || Number(a.sourceIndex || 0) - Number(b.sourceIndex || 0));
  return {
    ...(payloadData || {}),
    dates: matrix.dates,
    keywords,
    asins: adsProducts.map(item => item.asin),
    asinProducts: adsProducts,
    asinNum: adsProducts.length
  };
}

async function readSifKeywordWorkspace(asin = "") {
  const credentials = await readAppSecret(SECRET_KEYS.sifCredentials);
  if (!credentials?.authorization) return { authorized: false, configured: false };
  try {
    const adsProducts = await readAdsKeywordChildProducts();
    const adsAsins = adsProducts.map(item => item.asin);
    const requestedAsin = String(asin || "").trim().toUpperCase();
    const selectedAsin = adsAsins.includes(requestedAsin) ? requestedAsin : adsAsins[0] || "";
    if (!selectedAsin) {
      await checkSifCredentials(credentials);
      return {
        authorized: true,
        configured: true,
        requiresAdsAsin: true,
        country: credentials.country || "US",
        selectedAsin: "",
        data: { dates: [], keywords: [], asins: [], asinProducts: [], asinNum: 0, keywordNum: 0 }
      };
    }
    const result = await listSifKeywords(credentials, selectedAsin);
    const keywordTexts = result.payload.data?.keywords?.map(item => item.keyword) || [];
    const [matrix, bids, order] = await Promise.all([
      readSifRankMatrix(selectedAsin, keywordTexts, 60),
      readSifLatestBids(selectedAsin, keywordTexts),
      readSifMonitorOrder(credentials.country || "US", selectedAsin)
    ]);
    return {
      authorized: true,
      configured: true,
      country: credentials.country || "US",
      selectedAsin: result.selectedAsin,
      data: sifWorkspaceData(result.payload.data, adsProducts, matrix, bids, order)
    };
  } catch (error) {
    return { authorized: false, configured: true, error: error.message };
  }
}

async function syncAllSifKeywordRanks() {
  const credentials = await readAppSecret(SECRET_KEYS.sifCredentials);
  if (!credentials?.authorization) return { synced: 0, skipped: true };
  const adsAsins = await readAdsKeywordChildAsins();
  const [monitorRows] = await getMysqlPool().query(`
    SELECT DISTINCT asin FROM sif_keyword_monitors
    WHERE country_code = ? AND monitor_status = 'ACTIVE'
  `, [String(credentials.country || "US").toUpperCase()]);
  const asins = [...new Set([...adsAsins, ...monitorRows.map(row => String(row.asin || "").toUpperCase())])]
    .filter(asin => /^[A-Z0-9]{10}$/.test(asin));
  let synced = 0;
  const errors = [];
  for (const asin of asins) {
    try {
      const result = await listSifKeywords(credentials, asin);
      await syncSifKeywordBids(credentials, asin, result.payload.data?.keywords?.map(item => item.keyword) || []);
      synced += 1;
    } catch (error) {
      errors.push(`${asin}: ${error.message}`);
    }
  }
  return { synced, errors };
}

async function syncSifKeywordAsinNow(asin) {
  const credentials = await readAppSecret(SECRET_KEYS.sifCredentials);
  if (!credentials?.authorization) throw new Error("请先授权 SIF 账户");
  const selectedAsin = normalizeSifAsin(asin);
  const result = await listSifKeywords(credentials, selectedAsin);
  const bids = await syncSifKeywordBids(credentials, selectedAsin, result.payload.data?.keywords?.map(item => item.keyword) || []);
  return { asin: selectedAsin, ranksSynced: true, bids };
}

function startSifKeywordSchedule() {
  if (sifDailySyncTimer) return;
  const run = () => syncAllSifKeywordRanks().then(result => {
    if (result.errors?.length) console.error(`SIF keyword sync partial failure: ${result.errors.join("；")}`);
  }).catch(error => console.error(`SIF keyword sync failed: ${error.message}`));
  const scheduleNext = () => {
    const now = new Date();
    const hour = Math.max(0, Math.min(23, Number(process.env.SIF_SYNC_HOUR || 10)));
    const minute = Math.max(0, Math.min(59, Number(process.env.SIF_SYNC_MINUTE || 15)));
    const marketplaceDate = formatDateInTimeZone(now, US_MARKETPLACE_TIME_ZONE);
    let next = zonedDateTimeToUtc(marketplaceDate, hour, minute, 0, US_MARKETPLACE_TIME_ZONE);
    if (next <= now) next = zonedDateTimeToUtc(addDays(marketplaceDate, 1), hour, minute, 0, US_MARKETPLACE_TIME_ZONE);
    sifDailySyncTimer = setTimeout(async () => {
      await run();
      scheduleNext();
    }, next.getTime() - now.getTime());
  };
  scheduleNext();
  setTimeout(run, Math.max(10_000, Number(process.env.SIF_STARTUP_SYNC_DELAY_MS || 120_000)));
}

async function saveSifCredentialsFromCurl(curlText) {
  const credentials = parseSifCurl(curlText);
  const adsProducts = await readAdsKeywordChildProducts();
  const adsAsins = adsProducts.map(item => item.asin);
  const selectedAsin = adsAsins[0] || "";
  const result = selectedAsin ? await listSifKeywords(credentials, selectedAsin) : null;
  if (!result) await checkSifCredentials(credentials);
  const keywordTexts = result?.payload.data?.keywords?.map(item => item.keyword) || [];
  const [matrix, bids, order] = result ? await Promise.all([
    readSifRankMatrix(selectedAsin, keywordTexts, 60),
    readSifLatestBids(selectedAsin, keywordTexts),
    readSifMonitorOrder(credentials.country || "US", selectedAsin)
  ]) : [null, new Map(), new Map()];
  await writeAppSecret(SECRET_KEYS.sifCredentials, credentials);
  return {
    authorized: true,
    configured: true,
    requiresAdsAsin: !selectedAsin,
    country: credentials.country,
    selectedAsin: result?.selectedAsin || "",
    data: result ? sifWorkspaceData(result.payload.data, adsProducts, matrix, bids, order) : { dates: [], keywords: [], asins: [], asinProducts: [], asinNum: 0, keywordNum: 0 }
  };
}

async function readSifKeywordHistory({ asin, keyword, startDate, endDate }) {
  const selectedAsin = normalizeSifAsin(asin);
  const normalizedKeyword = normalizeSifKeyword(keyword);
  if (!normalizedKeyword) throw new Error("缺少关键词");
  const safeEnd = /^\d{4}-\d{2}-\d{2}$/.test(String(endDate || "")) ? String(endDate) : formatDateInTimeZone();
  const safeStart = /^\d{4}-\d{2}-\d{2}$/.test(String(startDate || "")) ? String(startDate) : addDays(safeEnd, -59);
  if (safeStart > safeEnd) throw new Error("开始日期不能晚于结束日期");
  if (dateRangeInclusive(safeStart, safeEnd).length > 366) throw new Error("单次最多查询 366 天");
  const [rows] = await getMysqlPool().query(`
    SELECT d.date, d.natural_rank, d.natural_rank_str, d.natural_asin,
      d.sp_rank, d.sp_rank_str, d.sp_asin, d.est_searches_num, d.aba_rank
    FROM sif_keyword_rank_daily d JOIN sif_keyword_monitors m ON m.id = d.monitor_id
    WHERE m.asin = ? AND m.normalized_keyword = ? AND d.date BETWEEN ? AND ?
    ORDER BY d.date
  `, [selectedAsin, normalizedKeyword, safeStart, safeEnd]);
  return {
    asin: selectedAsin,
    keyword: String(keyword),
    range: { startDate: safeStart, endDate: safeEnd },
    points: rows.map(row => ({
      date: adsDateValue(row.date),
      naturalRank: row.natural_rank === null ? null : Number(row.natural_rank), naturalRankStr: row.natural_rank_str || "", naturalAsin: row.natural_asin || selectedAsin,
      spRank: row.sp_rank === null ? null : Number(row.sp_rank), spRankStr: row.sp_rank_str || "", spAsin: row.sp_asin || selectedAsin,
      searches: row.est_searches_num === null ? null : Number(row.est_searches_num), abaRank: row.aba_rank === null ? null : Number(row.aba_rank)
    }))
  };
}

async function updateSifKeywordSubscription({ asin, keywords, type }) {
  const credentials = await readAppSecret(SECRET_KEYS.sifCredentials);
  if (!credentials?.authorization) throw new Error("请先授权 SIF 账户");
  const selectedAsin = normalizeSifAsin(asin);
  const safeKeywords = [...new Set((Array.isArray(keywords) ? keywords : [keywords])
    .map(keyword => String(keyword || "").trim())
    .filter(Boolean))].slice(0, 100);
  if (!safeKeywords.length) throw new Error("请输入至少一个关键词");
  const actionType = Number(type);
  if (![1, 2].includes(actionType)) throw new Error("关键词操作类型无效");
  const payload = await sifRequest("/api/user/subs/handle", { asin: selectedAsin, keywords: safeKeywords, type: actionType }, credentials);
  if (payload?.data?.isSuccess !== true) throw new Error("SIF 未确认关键词操作成功");
  const invalidKeywords = Array.isArray(payload?.data?.invalidKeywords) ? payload.data.invalidKeywords.map(String) : [];
  const invalidSet = new Set(invalidKeywords.map(normalizeSifKeyword));
  if (actionType === 1) {
    const validKeywords = safeKeywords.filter(keyword => !invalidSet.has(normalizeSifKeyword(keyword)));
    await setSifMonitorStatuses(credentials.country || "US", selectedAsin, validKeywords, "ACTIVE", { source: "ADS" });
    if (invalidKeywords.length) {
      await setSifMonitorStatuses(credentials.country || "US", selectedAsin, invalidKeywords, "ERROR", { source: "ADS", error: "SIF 判定关键词无效" });
    }
  } else {
    await setSifMonitorStatuses(credentials.country || "US", selectedAsin, safeKeywords, "INACTIVE", { source: "ADS" });
  }
  return {
    success: true,
    invalidKeywords
  };
}

async function saveSifKeywordOrder({ asin, keywords }) {
  const credentials = await readAppSecret(SECRET_KEYS.sifCredentials);
  if (!credentials?.authorization) throw new Error("请先授权 SIF 账户");
  const selectedAsin = normalizeSifAsin(asin);
  const normalizedKeywords = [...new Set((Array.isArray(keywords) ? keywords : [])
    .map(normalizeSifKeyword)
    .filter(Boolean))];
  if (!selectedAsin) throw new Error("缺少子 ASIN");
  if (!normalizedKeywords.length) throw new Error("关键词顺序不能为空");
  const country = String(credentials.country || "US").toUpperCase();
  const pool = getMysqlPool();
  const [rows] = await pool.query(`
    SELECT normalized_keyword FROM sif_keyword_monitors
    WHERE country_code = ? AND asin = ? AND monitor_status = 'ACTIVE' AND normalized_keyword IN (?)
  `, [country, selectedAsin, normalizedKeywords]);
  const found = new Set(rows.map(row => row.normalized_keyword));
  if (found.size !== normalizedKeywords.length) throw new Error("关键词监控列表已变化，请刷新后重试");
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    for (let index = 0; index < normalizedKeywords.length; index += 1) {
      await connection.query(`
        UPDATE sif_keyword_monitors
        SET sort_order = ?
        WHERE country_code = ? AND asin = ? AND normalized_keyword = ?
      `, [(index + 1) * 10, country, selectedAsin, normalizedKeywords[index]]);
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  return { ok: true };
}

async function ensureSifKeywordPairsMonitored(pairs = []) {
  const credentials = await readAppSecret(SECRET_KEYS.sifCredentials);
  if (!credentials?.authorization) throw new Error("请先在关键词监控中授权 SIF 账户，再添加广告关键词");
  const country = credentials.country || "US";
  const byAsin = new Map();
  for (const pair of pairs) {
    const asin = normalizeSifAsin(pair.asin || pair.childAsin);
    const keyword = String(pair.keyword || "").trim();
    if (!keyword) continue;
    const list = byAsin.get(asin) || [];
    list.push(keyword);
    byAsin.set(asin, list);
  }
  for (const [asin, keywords] of byAsin) {
    const normalized = [...new Set(keywords.map(normalizeSifKeyword))];
    const [rows] = await getMysqlPool().query(`
      SELECT normalized_keyword FROM sif_keyword_monitors
      WHERE country_code = ? AND asin = ? AND monitor_status = 'ACTIVE'
        AND normalized_keyword IN (?)
    `, [country, asin, normalized]);
    const active = new Set(rows.map(row => row.normalized_keyword));
    const missing = [...new Map(keywords.map(keyword => [normalizeSifKeyword(keyword), keyword]))]
      .filter(([key]) => !active.has(key)).map(([, keyword]) => keyword);
    if (!missing.length) continue;
    const result = await updateSifKeywordSubscription({ asin, keywords: missing, type: 1 });
    if (result.invalidKeywords.length) throw new Error(`SIF 无法监控关键词：${result.invalidKeywords.join("、")}`);
  }
}

async function setAdsKeywordSifMonitoring(keywordId, active) {
  const profile = await requireSelectedAdsProfile();
  const [rows] = await getMysqlPool().query(`
    SELECT DISTINCT k.keyword_text, u.child_asin
    FROM ads_keywords k
    JOIN ads_campaigns c ON c.keyword_id = k.id
    JOIN ads_ad_units u ON u.campaign_id = c.id
    WHERE k.id = ? AND k.profile_id = ? AND u.child_asin <> ''
  `, [keywordId, String(profile.profileId)]);
  if (!rows.length) throw new Error("该广告关键词还没有可监控的子 ASIN");
  if (active) {
    await ensureSifKeywordPairsMonitored(rows.map(row => ({ asin: row.child_asin, keyword: row.keyword_text })));
  } else {
    for (const row of rows) {
      await updateSifKeywordSubscription({ asin: row.child_asin, keywords: [row.keyword_text], type: 2 });
    }
  }
  return { active, asins: [...new Set(rows.map(row => row.child_asin))] };
}

function jsonRowId(row, index) {
  return String(row?.id || row?.asin || row?.sellerSku || `row-${index + 1}`).slice(0, 64);
}

async function replaceJsonTableRows(connection, tableName, rows) {
  await connection.query(`DELETE FROM ${tableName}`);
  if (!rows.length) return;
  const batchSize = Math.max(1, Number(process.env.DB_BULK_INSERT_BATCH_SIZE || 100));
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    await connection.query(
      `INSERT INTO ${tableName} (id, position, payload) VALUES ?`,
      [batch.map((row, index) => [jsonRowId(row, offset + index), offset + index, JSON.stringify(row)])]
    );
  }
}

async function ensureMysqlDatabase() {
  if (!isMysqlEnabled()) {
    throw new Error("Database storage is required. Remove DB_DISABLED or configure DB_* in .env.");
  }
  if (mysqlDatabaseReady) return false;
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
  if (!isMysqlEnabled()) {
    throw new Error("Database storage is required. Remove DB_DISABLED or configure DB_* in .env.");
  }
  if (fbaDailySchemaReady) return false;
  await ensureMysqlDatabase();
  const pool = getMysqlPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fba_inventory_daily (
      date DATE NOT NULL,
      marketplace_id VARCHAR(32) NOT NULL,
      seller_sku VARCHAR(128) COLLATE utf8mb4_bin NOT NULL,
      asin VARCHAR(32) DEFAULT '',
      parent_asin VARCHAR(32) DEFAULT '',
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
      KEY idx_fba_inventory_daily_asin (asin),
      KEY idx_fba_inventory_daily_parent_asin (parent_asin)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fba_sku_metadata (
      marketplace_id VARCHAR(32) NOT NULL,
      seller_sku VARCHAR(128) COLLATE utf8mb4_bin NOT NULL,
      asin VARCHAR(32) DEFAULT '',
      parent_asin VARCHAR(32) DEFAULT '',
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
      KEY idx_fba_sku_metadata_asin (asin),
      KEY idx_fba_sku_metadata_parent_asin (parent_asin)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fba_product_metadata (
      marketplace_id VARCHAR(32) NOT NULL,
      asin VARCHAR(32) NOT NULL,
      replenishment_grade VARCHAR(32) DEFAULT '',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (marketplace_id, asin),
      KEY idx_fba_product_metadata_grade (replenishment_grade)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query("ALTER TABLE fba_inventory_daily MODIFY seller_sku VARCHAR(128) COLLATE utf8mb4_bin NOT NULL").catch(() => {});
  await pool.query("ALTER TABLE fba_sku_metadata MODIFY seller_sku VARCHAR(128) COLLATE utf8mb4_bin NOT NULL").catch(() => {});
  await pool.query("ALTER TABLE fba_inventory_daily ADD COLUMN parent_asin VARCHAR(32) DEFAULT '' AFTER asin").catch(() => {});
  await pool.query("ALTER TABLE fba_sku_metadata ADD COLUMN parent_asin VARCHAR(32) DEFAULT '' AFTER asin").catch(() => {});
  await pool.query("ALTER TABLE fba_inventory_daily ADD KEY idx_fba_inventory_daily_parent_asin (parent_asin)").catch(() => {});
  await pool.query("ALTER TABLE fba_sku_metadata ADD KEY idx_fba_sku_metadata_parent_asin (parent_asin)").catch(() => {});
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

function defaultAdsAiStrategyRules() {
  return {
    generalText: "只针对 AmzAllBlue_ERP 内的广告对象提出建议。优先保护账户安全、利润和库存；数据不足时返回 REQUEST_MORE_DATA。任何建议必须说明证据、风险和观察期；真实广告调整是否需要逐条确认，由下方处理建议行动模式决定。",
    globalLimits: {
      analysisWindowDays: 30,
      recentAiHistoryDays: 7,
      minObservationDays: 3,
      maxBid: 5,
      maxBidChangeAmount: 0.2,
      maxBidChangePercent: 0.25,
      maxDailyBudget: 200,
      maxDailyBudgetChangePercent: 0.25,
      maxPlacementAdjustment: 300,
      inventorySafetyDays: 21
    },
    schedule: {
      dailyBatchEnabled: false,
      dailyBatchTime: "09:00",
      approvalMode: "MANUAL"
    },
    groups: {
      NORMAL: {
        title: "普通",
        objective: "测试关键词价值，并通过较低成本获取有利润的订单。",
        rulesText: "使用相对保守的出价积累数据；词组和广泛匹配用于发现有效搜索词，精准匹配验证关键词本身的转化能力；有稳定转化且值得提升自然排名时可建议转为主推；流量不大但稳定盈利的长尾词继续保留；长期只有点击没有订单时建议降低出价或暂停。重点关注曝光、点击、CTR、CPC、订单、转化率、ACOS 和广告利润。"
      },
      PROMOTED: {
        title: "主推",
        objective: "增加关键词广告成交并提升自然排名，最终增加自然流量和自然订单。",
        rulesText: "以精准匹配为主要投放方式；根据表现评估提高精准出价和顶部搜索加价；在可控范围内允许比利润型广告更高的 ACOS；观察广告订单增长是否带来自然排名、自然订单和总订单增长；关注库存安全，避免排名提升后断货；自然排名和订单持续稳定后可建议转为已稳定。重点关注自然排名、广告订单、顶部曝光、ACOS、库存与建议竞价。"
      },
      STABLE: {
        title: "已稳定",
        objective: "保持已有自然排名和销量，同时减少不必要的广告花费并提高整体利润。",
        rulesText: "保留必要的精准广告维持曝光和成交；逐步测试降低出价或顶部搜索加价；减少词组和广泛匹配中的无效流量；观察降低广告投入后自然排名是否仍稳定；自然排名明显下降时可建议重新转为主推。重点关注排名稳定性、ACOS、广告利润、总销量和异常波动。"
      }
    }
  };
}

function adsAiNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function sanitizeAdsAiStrategyRules(value) {
  const defaults = defaultAdsAiStrategyRules();
  const source = value && typeof value === "object" ? value : {};
  const sourceLimits = source.globalLimits && typeof source.globalLimits === "object" ? source.globalLimits : {};
  const sourceSchedule = source.schedule && typeof source.schedule === "object" ? source.schedule : {};
  const limits = defaults.globalLimits;
  const groups = {};
  for (const group of ADS_AI_GROUPS) {
    const sourceGroup = source.groups?.[group] && typeof source.groups[group] === "object" ? source.groups[group] : {};
    groups[group] = {
      ...defaults.groups[group],
      objective: String(sourceGroup.objective || defaults.groups[group].objective).trim().slice(0, 2000),
      rulesText: String(sourceGroup.rulesText || defaults.groups[group].rulesText).trim().slice(0, 12000)
    };
  }
  return {
    generalText: String(source.generalText || defaults.generalText).trim().slice(0, 12000),
    globalLimits: {
      analysisWindowDays: Math.round(adsAiNumber(sourceLimits.analysisWindowDays, limits.analysisWindowDays, 7, 90)),
      recentAiHistoryDays: Math.round(adsAiNumber(sourceLimits.recentAiHistoryDays, limits.recentAiHistoryDays, 0, 30)),
      minObservationDays: Math.round(adsAiNumber(sourceLimits.minObservationDays, limits.minObservationDays, 1, 30)),
      maxBid: adsAiNumber(sourceLimits.maxBid, limits.maxBid, 0.02, 100),
      maxBidChangeAmount: adsAiNumber(sourceLimits.maxBidChangeAmount, limits.maxBidChangeAmount, 0.01, 20),
      maxBidChangePercent: adsAiNumber(sourceLimits.maxBidChangePercent, limits.maxBidChangePercent, 0.01, 2),
      maxDailyBudget: adsAiNumber(sourceLimits.maxDailyBudget, limits.maxDailyBudget, 1, 100000),
      maxDailyBudgetChangePercent: adsAiNumber(sourceLimits.maxDailyBudgetChangePercent, limits.maxDailyBudgetChangePercent, 0.01, 5),
      maxPlacementAdjustment: Math.round(adsAiNumber(sourceLimits.maxPlacementAdjustment, limits.maxPlacementAdjustment, 0, 900)),
      inventorySafetyDays: Math.round(adsAiNumber(sourceLimits.inventorySafetyDays, limits.inventorySafetyDays, 0, 365))
    },
    schedule: {
      dailyBatchEnabled: sourceSchedule.dailyBatchEnabled === true,
      dailyBatchTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(sourceSchedule.dailyBatchTime || ""))
        ? String(sourceSchedule.dailyBatchTime)
        : defaults.schedule.dailyBatchTime,
      approvalMode: ADS_AI_APPROVAL_MODES.has(String(sourceSchedule.approvalMode || "").toUpperCase())
        ? String(sourceSchedule.approvalMode).toUpperCase()
        : defaults.schedule.approvalMode
    },
    groups
  };
}

function calculateTotalGoodsQuantity(row) {
  const values = [
    row.fulfillableQuantity,
    row.reservedQuantity,
    row.inboundWorkingQuantity,
    row.inboundShippedQuantity,
    row.inboundReceivingQuantity
  ];
  if (values.every(value => value === null || value === undefined || value === "")) return null;
  return values.reduce((sum, value) => sum + Number(value || 0), 0);
}

function calculateInboundQuantity(row) {
  const values = [
    row.inboundWorkingQuantity,
    row.inboundShippedQuantity,
    row.inboundReceivingQuantity
  ];
  if (values.every(value => value === null || value === undefined || value === "")) return null;
  return values.reduce((sum, value) => sum + Number(value || 0), 0);
}

function buildInventoryQuantitySnapshot(row) {
  if (!row) return null;
  const totalGoodsQuantity = calculateTotalGoodsQuantity(row);
  return {
    date: row.date || "",
    source: inventorySnapshotSource(row),
    totalGoodsQuantity,
    inboundQuantity: calculateInboundQuantity(row),
    fulfillableQuantity: Number(row.fulfillableQuantity || 0),
    reservedQuantity: Number(row.reservedQuantity || 0),
    unfulfillableQuantity: Number(row.unfulfillableQuantity || 0),
    inboundWorkingQuantity: Number(row.inboundWorkingQuantity || 0),
    inboundShippedQuantity: Number(row.inboundShippedQuantity || 0),
    inboundReceivingQuantity: Number(row.inboundReceivingQuantity || 0)
  };
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
    parentAsin: row.parent_asin || "",
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
    parentAsin: row.parent_asin || "",
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
  await ensureFbaDailyMysqlSchema();
  const pool = getMysqlPool();
  const [rows] = await pool.query("SELECT * FROM fba_sku_metadata");
  return rows.map(mysqlRowToFbaSkuMetadata);
}

async function readFbaProductMetadataRows() {
  await ensureFbaDailyMysqlSchema();
  const pool = getMysqlPool();
  const [rows] = await pool.query("SELECT * FROM fba_product_metadata");
  return rows.map(row => ({
    marketplaceId: row.marketplace_id,
    asin: row.asin || "",
    replenishmentGrade: normalizeFbaReplenishmentGrade(row.replenishment_grade)
  }));
}

async function upsertFbaProductGrades(gradesByAsin, marketplaceId = getSpApiConfig().marketplaceId) {
  const entries = Object.entries(gradesByAsin || {})
    .map(([asin, grade]) => [String(asin || "").trim().toUpperCase(), normalizeFbaReplenishmentGrade(grade)])
    .filter(([asin, grade]) => /^B[A-Z0-9]{9}$/.test(asin) && grade);
  if (!entries.length) return { saved: {}, changed: false };
  await ensureFbaDailyMysqlSchema();
  const pool = getMysqlPool();
  await pool.query(`
    INSERT INTO fba_product_metadata (
      marketplace_id, asin, replenishment_grade
    ) VALUES ?
    ON DUPLICATE KEY UPDATE
      replenishment_grade = VALUES(replenishment_grade)
  `, [entries.map(([asin, grade]) => [marketplaceId, asin, grade])]);
  return { saved: Object.fromEntries(entries), changed: true };
}

function rowHasFbaMetadata(row) {
  return Boolean(row?.marketplaceId && row?.sellerSku && (row.asin || row.parentAsin || row.fnSku || row.title || row.imageUrl));
}

function mergeSkuDisplayMetadata(primary = {}, fallback = {}) {
  const primarySource = primary && typeof primary === "object" ? primary : {};
  const fallbackSource = fallback && typeof fallback === "object" ? fallback : {};
  const result = {};
  for (const field of ["asin", "parentAsin", "fnSku", "title", "brand", "imageUrl", "condition"]) {
    result[field] = primarySource[field] || fallbackSource[field] || "";
  }
  return result;
}

function catalogFetchedAt(row = {}) {
  const raw = row.rawJson || row.rawInventoryJson || {};
  return raw.catalogFetchedAt || raw.catalog?.fetchedAt || "";
}

function catalogClassification(row = {}) {
  const raw = row.rawJson || row.rawInventoryJson || {};
  const source = raw.browseClassification || raw.catalog?.browseClassification || {};
  const categoryIds = [...new Set([
    source.categoryId,
    ...(Array.isArray(source.categoryIds) ? source.categoryIds : [])
  ].map(value => String(value || "").trim()).filter(Boolean))];
  return {
    categoryId: String(source.categoryId || categoryIds[0] || "").trim(),
    categoryName: String(source.categoryName || "").trim(),
    categoryIds,
    categoryNodes: Array.isArray(source.categoryNodes) ? source.categoryNodes : []
  };
}

function isCatalogMetadataFresh(row = {}, now = Date.now()) {
  if (!row.title && !row.imageUrl && !row.parentAsin && !row.brand) return false;
  if (!catalogClassification(row).categoryIds.length) return false;
  const fetchedAt = catalogFetchedAt(row);
  const fetchedTime = fetchedAt ? new Date(fetchedAt).getTime() : 0;
  if (!Number.isFinite(fetchedTime) || fetchedTime <= 0) return false;
  const ttlMs = Math.max(1, Number(process.env.AMZ_CATALOG_TTL_HOURS || 24)) * 60 * 60 * 1000;
  return now - fetchedTime < ttlMs;
}

async function catalogForInventorySummaries(summaries, options = {}) {
  if (!options.syncCatalog) return new Map();
  const config = getSpApiConfig();
  const metadataRows = (await readFbaSkuMetadataRows()).filter(row => row.marketplaceId === config.marketplaceId);
  const metadataByAsin = new Map();
  for (const row of metadataRows) {
    const asin = normalizeAsin(row.asin);
    if (!asin) continue;
    const existing = metadataByAsin.get(asin);
    if (!existing || String(row.lastSeenAt || "") > String(existing.lastSeenAt || "")) metadataByAsin.set(asin, row);
  }
  const now = Date.now();
  const asinSet = new Set();
  const catalog = new Map();
  for (const summary of summaries) {
    const asin = normalizeAsin(summary.asin);
    if (!asin) continue;
    asinSet.add(asin);
    const cached = metadataByAsin.get(asin);
    if (isCatalogMetadataFresh(cached, now)) {
      const classification = catalogClassification(cached);
      catalog.set(asin, {
        parentAsin: cached.parentAsin || "",
        title: cached.title || "",
        brand: cached.brand || "",
        imageUrl: cached.imageUrl || "",
        catalogFetchedAt: catalogFetchedAt(cached),
        ...classification
      });
    }
  }
  await upsertBrowseCategories([...catalog.values()].flatMap(item => item.categoryNodes || []), "AMAZON_CATALOG");
  const staleAsins = [...asinSet].filter(asin => !catalog.has(asin));
  if (!staleAsins.length) return catalog;
  const fetched = await fetchCatalogDetails(staleAsins);
  await upsertBrowseCategories([...fetched.values()].flatMap(item => item.categoryNodes || []), "AMAZON_CATALOG");
  const fetchedAt = new Date().toISOString();
  const metadataUpdates = [];
  for (const [asin, item] of fetched.entries()) {
    const normalizedAsin = normalizeAsin(asin);
    catalog.set(normalizedAsin, { ...item, catalogFetchedAt: fetchedAt });
  }
  for (const summary of summaries) {
    const asin = normalizeAsin(summary.asin);
    if (!asin || !fetched.has(asin)) continue;
    const item = fetched.get(asin);
    metadataUpdates.push({
      marketplaceId: config.marketplaceId,
      sellerSku: summary.sellerSku || summary.sellerSKU || "",
      asin,
      parentAsin: item.parentAsin || "",
      fnSku: summary.fnSku || summary.fnSKU || "",
      title: item.title || summary.productName || "",
      brand: item.brand || "",
      imageUrl: item.imageUrl || "",
      condition: summary.condition || "",
      lastSeenAt: fetchedAt,
      rawJson: {
        source: "catalog",
        catalogFetchedAt: fetchedAt,
        browseClassification: {
          categoryId: item.categoryId || "",
          categoryName: item.categoryName || "",
          categoryIds: item.categoryIds || [],
          categoryNodes: item.categoryNodes || []
        }
      }
    });
  }
  await upsertFbaSkuMetadata(metadataUpdates, "catalog").catch(() => {});
  return catalog;
}

async function upsertFbaSkuMetadata(rows, source = "inventory") {
  const metadataRows = [...new Map(rows
    .filter(row => row.sellerSku !== FBA_DATE_MARKER_SKU && rowHasFbaMetadata(row))
    .map(row => [`${row.marketplaceId}|${row.sellerSku}`, row])
  ).values()];
  if (!metadataRows.length) return { inserted: 0, updated: 0 };
  await ensureFbaDailyMysqlSchema();
  const pool = getMysqlPool();
  const batchSize = Math.max(1, Number(process.env.DB_BULK_INSERT_BATCH_SIZE || 100));
  for (const batch of chunkArray(metadataRows, batchSize)) {
    await pool.query(`
      INSERT INTO fba_sku_metadata (
        marketplace_id, seller_sku, asin, parent_asin, fn_sku, title, brand, image_url, item_condition, source, last_seen_at, raw_json
      ) VALUES ?
      ON DUPLICATE KEY UPDATE
        asin = IF(VALUES(asin) <> '', VALUES(asin), asin),
        parent_asin = IF(VALUES(parent_asin) <> '', VALUES(parent_asin), parent_asin),
        fn_sku = IF(VALUES(fn_sku) <> '', VALUES(fn_sku), fn_sku),
        title = IF(VALUES(title) <> '', VALUES(title), title),
        brand = IF(VALUES(brand) <> '', VALUES(brand), brand),
        image_url = IF(VALUES(image_url) <> '', VALUES(image_url), image_url),
        item_condition = IF(VALUES(item_condition) <> '', VALUES(item_condition), item_condition),
        source = VALUES(source),
        last_seen_at = VALUES(last_seen_at),
        raw_json = CASE
          WHEN VALUES(source) = 'catalog' THEN VALUES(raw_json)
          WHEN raw_json IS NULL THEN VALUES(raw_json)
          ELSE raw_json
        END
    `, [batch.map(row => [
      row.marketplaceId,
      row.sellerSku,
      row.asin || "",
      row.parentAsin || "",
      row.fnSku || "",
      row.title || "",
      row.brand || "",
      row.imageUrl || "",
      row.condition || "",
      source,
      toMysqlDateTime(row.inventoryFetchedAt || row.lastSeenAt || new Date().toISOString()),
      row.rawInventoryJson ? JSON.stringify(row.rawInventoryJson) : (row.rawJson ? JSON.stringify(row.rawJson) : null)
    ])]);
  }
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
    const batchSize = Math.max(1, Number(process.env.DB_BULK_INSERT_BATCH_SIZE || 100));
    for (const batch of chunkArray(uniqueRows, batchSize)) {
      await connection.query(`
        INSERT INTO fba_inventory_daily (
          date, marketplace_id, seller_sku, asin, parent_asin, fn_sku, title, brand, image_url, item_condition,
          amazon_total_quantity, total_goods_quantity, fulfillable_quantity, reserved_quantity,
          unfulfillable_quantity, inbound_working_quantity, inbound_shipped_quantity, inbound_receiving_quantity,
          researching_quantity, sales_units, sales_orders, is_sufficient, inventory_fetched_at, sales_fetched_at,
          frozen_at, last_updated_time, raw_inventory_json, raw_sales_json
        ) VALUES ?
        ON DUPLICATE KEY UPDATE
          asin = VALUES(asin),
          parent_asin = VALUES(parent_asin),
          fn_sku = VALUES(fn_sku),
          title = VALUES(title),
          brand = VALUES(brand),
          image_url = VALUES(image_url),
          item_condition = VALUES(item_condition),
          amazon_total_quantity = VALUES(amazon_total_quantity),
          total_goods_quantity = VALUES(total_goods_quantity),
          fulfillable_quantity = VALUES(fulfillable_quantity),
          reserved_quantity = VALUES(reserved_quantity),
          unfulfillable_quantity = VALUES(unfulfillable_quantity),
          inbound_working_quantity = VALUES(inbound_working_quantity),
          inbound_shipped_quantity = VALUES(inbound_shipped_quantity),
          inbound_receiving_quantity = VALUES(inbound_receiving_quantity),
          researching_quantity = VALUES(researching_quantity),
          sales_units = VALUES(sales_units),
          sales_orders = VALUES(sales_orders),
          is_sufficient = VALUES(is_sufficient),
          inventory_fetched_at = VALUES(inventory_fetched_at),
          sales_fetched_at = VALUES(sales_fetched_at),
          frozen_at = VALUES(frozen_at),
          last_updated_time = VALUES(last_updated_time),
          raw_inventory_json = VALUES(raw_inventory_json),
          raw_sales_json = VALUES(raw_sales_json)
      `, [batch.map(row => [
        row.date,
        row.marketplaceId,
        row.sellerSku,
        row.asin || "",
        row.parentAsin || "",
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
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
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
  return readFbaDailyRowsFromMysql();
}

async function writeFbaDailyRows(rows) {
  return writeFbaDailyRowsToMysql(rows);
}

async function appendNetworkDebug(events) {
  await ensureDataDir();
  const lines = events.map(event => JSON.stringify(event)).join("\n") + "\n";
  await appendFile(NETWORK_DEBUG_PATH, lines, "utf8");
}

async function readNetworkDebug() {
  await ensureDataDir();
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

  return events;
}

async function ensureSalesReportRequestsLoaded() {
  if (salesReportRequestsLoaded) return;
  salesReportRequestsLoaded = true;
  await ensureDataDir();
  if (!existsSync(SP_API_REPORT_CACHE_PATH)) return;
  const raw = await readFile(SP_API_REPORT_CACHE_PATH, "utf8").catch(() => "");
  if (!raw.trim()) return;
  const rows = JSON.parse(raw);
  if (!Array.isArray(rows)) return;
  for (const row of rows) {
    if (!row?.key || !row?.reportId) continue;
    salesReportRequests.set(row.key, {
      reportId: row.reportId,
      reportType: row.reportType || "",
      createdAt: Number(row.createdAt || 0) || Date.now()
    });
  }
}

async function writeSalesReportRequestsCache() {
  await ensureDataDir();
  const today = formatDateInTimeZone();
  const rows = [...salesReportRequests.entries()]
    .filter(([, item]) => item?.reportId && isReportFromToday(item, today))
    .map(([key, item]) => ({
      key,
      reportId: item.reportId,
      reportType: item.reportType || "",
      createdAt: item.createdAt || Date.now()
    }));
  await writeFile(SP_API_REPORT_CACHE_PATH, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
}

async function rememberSalesReportRequest(key, item) {
  salesReportRequests.set(key, item);
  await writeSalesReportRequestsCache().catch(() => {});
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

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const source = String(text || "");
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }
  row.push(cell);
  if (row.length > 1 || row[0]) rows.push(row);
  return rows;
}

function normalizeHeader(text) {
  return String(text || "").replace(/^"|"$/g, "").trim().toLowerCase();
}

function sendCsv(res, filename, rows) {
  const csv = rows.map(row => row.map(csvEscape).join(",")).join("\r\n");
  res.writeHead(200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    ...corsHeaders()
  });
  res.end(`\uFEFF${csv}`);
}

function sendXlsx(res, filename, buffer) {
  res.writeHead(200, {
    "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    ...corsHeaders()
  });
  res.end(Buffer.from(buffer));
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

function chunkArray(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
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
    parentAsin: String(input.parentAsin || input.parent_asin || "").trim().toUpperCase(),
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

function normalizeFbaReplenishmentGrade(value) {
  const grade = String(value || "").trim();
  return ["normal", "promoted", "featured", "abandoned"].includes(grade) ? grade : "";
}

function normalizeFactoryProduct(input) {
  const source = input && typeof input === "object" ? input : {};
  const asin = String(source.asin || "").trim().toUpperCase();
  const name = String(source.name || source.title || "").trim();
  const replenishmentGrade = normalizeFbaReplenishmentGrade(source.replenishmentGrade || source.grade);
  return {
    id: String(source.id || asin || name || randomUUID()).trim(),
    name,
    asin,
    parentAsin: String(source.parentAsin || source.parent_asin || "").trim().toUpperCase(),
    parentInternalName: String(source.parentInternalName || "").trim(),
    boxSpec: String(source.boxSpec || "").trim(),
    replenishmentGrade,
    unitCost: source.unitCost === "" || source.unitCost === undefined ? "" : Number(source.unitCost || 0),
    currentQuantity: Number(source.currentQuantity || 0),
    inventoryValue: source.inventoryValue === "" || source.inventoryValue === undefined ? "" : Number(source.inventoryValue || 0),
    safetyStock: Number(source.safetyStock || 50),
    note: String(source.note || "").trim(),
    source: String(source.source || "manual").trim(),
    order: Number(source.order || 0),
    createdAt: source.createdAt || new Date().toISOString(),
    updatedAt: source.updatedAt || new Date().toISOString()
  };
}

function getFactoryProductGroupKey(product) {
  return product?.parentAsin || product?.asin || product?.id || "";
}

function getFactoryProductEffectiveGroupKey(product, fbaCatalogByAsin = new Map()) {
  const asin = String(product?.asin || "").trim().toUpperCase();
  const fbaProduct = asin ? fbaCatalogByAsin.get(asin) : null;
  return fbaProduct?.parentAsin || product?.parentAsin || product?.asin || product?.id || "";
}

async function readParentAsinMetadataMap() {
  await ensureAppMysqlSchema();
  const pool = getMysqlPool();
  const [rows] = await pool.query("SELECT parent_asin, internal_name FROM parent_asin_metadata");
  return new Map(rows
    .map(row => [String(row.parent_asin || "").trim().toUpperCase(), String(row.internal_name || "").trim()])
    .filter(([parentAsin]) => parentAsin)
  );
}

async function readParentAsinMetadataRows() {
  await ensureAppMysqlSchema();
  const pool = getMysqlPool();
  const [rows] = await pool.query("SELECT parent_asin, internal_name, sort_order, category_id, category_name FROM parent_asin_metadata");
  return rows.map(row => ({
    parentAsin: String(row.parent_asin || "").trim().toUpperCase(),
    internalName: String(row.internal_name || "").trim(),
    sortOrder: Number(row.sort_order || 0),
    categoryId: String(row.category_id || "").trim(),
    categoryName: String(row.category_name || "").trim()
  })).filter(row => row.parentAsin);
}

async function saveAdsParentAsinOrder(parentAsins) {
  await ensureAppMysqlSchema();
  const normalized = [...new Set((Array.isArray(parentAsins) ? parentAsins : [])
    .map(value => String(value || "").trim().toUpperCase())
    .filter(Boolean))];
  if (!normalized.length) throw new Error("父 ASIN 顺序不能为空");
  const pool = getMysqlPool();
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    for (let index = 0; index < normalized.length; index += 1) {
      await connection.query(
        "UPDATE parent_asin_metadata SET sort_order = ? WHERE parent_asin = ? AND internal_name <> ''",
        [index + 1, normalized[index]]
      );
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function saveAdsKeywordOrder(parentAsin, keywordIds) {
  const profile = await requireSelectedAdsProfile();
  const normalizedParentAsin = String(parentAsin || "").trim().toUpperCase();
  const ids = [...new Set((Array.isArray(keywordIds) ? keywordIds : [])
    .map(value => String(value || "").trim())
    .filter(value => /^\d+$/.test(value)))];
  if (!normalizedParentAsin) throw new Error("父 ASIN 不能为空");
  if (!ids.length) throw new Error("关键词顺序不能为空");
  const pool = getMysqlPool();
  const [rows] = await pool.query(`
    SELECT id FROM ads_keywords
    WHERE profile_id = ? AND parent_asin = ? AND lifecycle_status IN ('ACTIVE', 'CREATING', 'STOPPING', 'STOPPED') AND id IN (?)
  `, [String(profile.profileId), normalizedParentAsin, ids]);
  const found = new Set(rows.map(row => String(row.id)));
  if (found.size !== ids.length) throw new Error("关键词列表已变化，请刷新后重试");
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    for (let index = 0; index < ids.length; index += 1) {
      await connection.query(
        "UPDATE ads_keywords SET sort_order = ? WHERE id = ? AND profile_id = ? AND parent_asin = ?",
        [(index + 1) * 10, ids[index], String(profile.profileId), normalizedParentAsin]
      );
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function upsertParentAsinMetadata(parentAsin, internalName) {
  const normalizedParentAsin = String(parentAsin || "").trim().toUpperCase();
  if (!normalizedParentAsin) throw new Error("Missing parent ASIN");
  await ensureAppMysqlSchema();
  const pool = getMysqlPool();
  await pool.query(`
    INSERT INTO parent_asin_metadata (parent_asin, internal_name)
    VALUES (?, ?)
    ON DUPLICATE KEY UPDATE internal_name = VALUES(internal_name)
  `, [normalizedParentAsin, String(internalName || "").trim()]);
}

async function upsertParentAsinCategory(parentAsin, categoryId, categoryName) {
  const normalizedParentAsin = String(parentAsin || "").trim().toUpperCase();
  const normalizedCategoryId = String(categoryId || "").trim();
  if (!normalizedParentAsin) throw new Error("Missing parent ASIN");
  await ensureAppMysqlSchema();
  await getMysqlPool().query(`
    INSERT INTO parent_asin_metadata (parent_asin, category_id, category_name)
    VALUES (?, ?, ?)
    ON DUPLICATE KEY UPDATE category_id = VALUES(category_id), category_name = VALUES(category_name)
  `, [normalizedParentAsin, normalizedCategoryId, normalizedCategoryId ? String(categoryName || "").trim() : ""]);
  await getMysqlPool().query(`
    DELETE b FROM sif_keyword_bid_daily b
    JOIN sif_keyword_monitors m ON m.id = b.monitor_id
    WHERE b.date = ? AND m.asin IN (
      SELECT DISTINCT asin FROM fba_sku_metadata WHERE parent_asin = ? AND asin <> ''
    )
  `, [formatDateInTimeZone(), normalizedParentAsin]);
}

async function upsertBrowseCategories(categories, source = "") {
  const rows = [...new Map((categories || []).map(category => {
    const id = String(category?.id || category?.categoryId || "").trim();
    const name = String(category?.name || category?.categoryName || "").trim();
    return [id, { id, name }];
  }).filter(([id]) => id)).values()];
  if (!rows.length) return;
  await ensureAppMysqlSchema();
  await getMysqlPool().query(`
    INSERT INTO amazon_browse_categories (category_id, category_name, source, last_seen_at)
    VALUES ?
    ON DUPLICATE KEY UPDATE
      category_name = IF(VALUES(category_name) <> '', VALUES(category_name), category_name),
      source = VALUES(source), last_seen_at = VALUES(last_seen_at)
  `, [rows.map(row => [row.id, row.name, String(source || "").slice(0, 32), new Date()])]);
}

async function readBrowseCategoryOptions() {
  await ensureAppMysqlSchema();
  const [rows] = await getMysqlPool().query(`
    SELECT category_id, category_name FROM amazon_browse_categories
    ORDER BY category_name, category_id
  `);
  return rows.map(row => ({ id: String(row.category_id), name: String(row.category_name || "") }));
}

function calculateFactoryInventoryValue(product) {
  if (product.unitCost === "" || product.unitCost === null || product.unitCost === undefined) return "";
  return Number((Number(product.currentQuantity || 0) * Number(product.unitCost || 0)).toFixed(2));
}

function updateFactoryProduct(input, patch) {
  const next = { ...input };
  if (Object.prototype.hasOwnProperty.call(patch, "name")) {
    next.name = String(patch.name || "").trim();
  }
  if (Object.prototype.hasOwnProperty.call(patch, "asin")) {
    next.asin = String(patch.asin || "").trim().toUpperCase();
  }
  if (Object.prototype.hasOwnProperty.call(patch, "unitCost")) {
    next.unitCost = patch.unitCost === "" || patch.unitCost === null || patch.unitCost === undefined ? "" : Number(patch.unitCost || 0);
    next.inventoryValue = calculateFactoryInventoryValue(next);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "boxSpec")) {
    next.boxSpec = String(patch.boxSpec || "").trim();
  }
  if (Object.prototype.hasOwnProperty.call(patch, "replenishmentGrade")) {
    next.replenishmentGrade = normalizeFbaReplenishmentGrade(patch.replenishmentGrade);
  }
  next.updatedAt = new Date().toISOString();
  return normalizeFactoryProduct(next);
}

function normalizeFactoryMovement(input) {
  const source = input && typeof input === "object" ? input : {};
  return {
    id: String(source.id || randomUUID()).trim(),
    productId: String(source.productId || "").trim(),
    date: String(source.date || new Date().toISOString().slice(0, 10)).slice(0, 10),
    type: String(source.type || "adjustment").trim(),
    quantity: Number(source.quantity || 0),
    note: String(source.note || "").trim(),
    operator: String(source.operator || "").trim(),
    source: String(source.source || "manual").trim(),
    createdAt: source.createdAt || new Date().toISOString()
  };
}

function factoryMovementLabel(type) {
  return {
    inbound: "补货入库",
    outbound: "发货出库",
    adjustment: "库存调整",
    import: "表格导入"
  }[type] || type || "库存调整";
}

function inferFactoryMovementType(operation, quantity) {
  const text = String(operation || "");
  if (Number(quantity || 0) < 0 || /发货|出库|发出/i.test(text)) return "outbound";
  if (/差|调整|盘点/i.test(text)) return "adjustment";
  return "inbound";
}

function applyFactoryQuantity(product, delta) {
  return normalizeFactoryProduct({
    ...product,
    currentQuantity: Number(product.currentQuantity || 0) + Number(delta || 0),
    inventoryValue: calculateFactoryInventoryValue({
      ...product,
      currentQuantity: Number(product.currentQuantity || 0) + Number(delta || 0)
    }),
    updatedAt: new Date().toISOString()
  });
}

function parseFactoryBoxQuantity(boxSpec) {
  const text = String(boxSpec || "");
  const match = text.match(/\/\s*(\d+(?:\.\d+)?)\s*(?:个|pcs?|件|套)?/i)
    || text.match(/(\d+(?:\.\d+)?)\s*(?:个|pcs?|件|套)\s*$/i);
  return match ? Number(match[1]) : 0;
}

function parseFactoryBoxDimensions(boxSpec) {
  const text = String(boxSpec || "");
  const match = text.match(/(\d+(?:\.\d+)?)\s*[*x×]\s*(\d+(?:\.\d+)?)\s*[*x×]\s*(\d+(?:\.\d+)?)/i);
  if (!match) return { lengthCm: 0, widthCm: 0, heightCm: 0 };
  return {
    lengthCm: Number(match[1] || 0),
    widthCm: Number(match[2] || 0),
    heightCm: Number(match[3] || 0)
  };
}

async function buildFactoryMovementTemplateRows(db, { operation, date, kind }) {
  const catalog = await ensureFactoryInventoryProductCatalog(db);
  const products = (Array.isArray(db.factoryInventory?.products) ? db.factoryInventory.products : [])
    .map(item => normalizeFactoryProduct(item));
  const productById = new Map(products.map(product => [product.id, product]));
  const movements = (Array.isArray(db.factoryInventory?.movements) ? db.factoryInventory.movements : [])
    .map(item => normalizeFactoryMovement(item))
    .filter(movement => movement.date === date && movement.note === operation && movement.quantity);
  const items = movements.map(movement => {
    const product = productById.get(movement.productId);
    if (!product) return null;
    const fbaProduct = catalog.fbaCatalogByAsin.get(product.asin) || {};
    const quantity = Math.abs(Number(movement.quantity || 0));
    const unitsPerBox = parseFactoryBoxQuantity(product.boxSpec);
    const boxCount = unitsPerBox > 0 ? Math.ceil(quantity / unitsPerBox) : 0;
    const dimensions = parseFactoryBoxDimensions(product.boxSpec);
    return {
      name: product.name || fbaProduct.title || product.asin,
      asin: product.asin,
      fnSku: fbaProduct.fnSku || "",
      sellerSku: fbaProduct.sellerSku || product.asin,
      quantity,
      unitsPerBox,
      boxCount,
      ...dimensions
    };
  }).filter(Boolean);

  if (kind === "backend") {
    return [
      ["Merchant SKU", "Quantity", "Prep owner", "Labeling owner", "Units per box", "Number of boxes", "Box length (in)", "Box width (in)", "Box height (in)", "Box weight (lb)"],
      ...items.map(item => [
        item.sellerSku,
        item.quantity,
        "",
        "",
        item.unitsPerBox || "",
        item.boxCount || "",
        item.lengthCm ? (item.lengthCm / 2.54).toFixed(2) : "",
        item.widthCm ? (item.widthCm / 2.54).toFixed(2) : "",
        item.heightCm ? (item.heightCm / 2.54).toFixed(2) : "",
        item.lengthCm === 60 ? 45 : 33
      ])
    ];
  }

  const quantityLabel = kind === "replenishment" ? "补货数(套)" : "发货数(套)";
  return [
    ["名称", "FNSKU", "每箱数量", quantityLabel, "共多少箱"],
    ...items.map(item => [item.name, item.fnSku, item.unitsPerBox || "", item.quantity, item.boxCount || ""])
  ];
}

async function buildFactoryMovementTemplateItems(db, { operation, date }) {
  const catalog = await ensureFactoryInventoryProductCatalog(db);
  const products = (Array.isArray(db.factoryInventory?.products) ? db.factoryInventory.products : [])
    .map(item => normalizeFactoryProduct(item));
  const productById = new Map(products.map(product => [product.id, product]));
  const movements = (Array.isArray(db.factoryInventory?.movements) ? db.factoryInventory.movements : [])
    .map(item => normalizeFactoryMovement(item))
    .filter(movement => movement.date === date && movement.note === operation && movement.quantity);
  return movements.map(movement => {
    const product = productById.get(movement.productId);
    if (!product) return null;
    const fbaProduct = catalog.fbaCatalogByAsin.get(product.asin) || {};
    const quantity = Math.abs(Number(movement.quantity || 0));
    const unitsPerBox = parseFactoryBoxQuantity(product.boxSpec);
    const boxCount = unitsPerBox > 0 ? Math.ceil(quantity / unitsPerBox) : 0;
    const dimensions = parseFactoryBoxDimensions(product.boxSpec);
    return {
      name: product.name || fbaProduct.title || product.asin,
      asin: product.asin,
      fnSku: fbaProduct.fnSku || "",
      sellerSku: fbaProduct.sellerSku || product.asin,
      quantity,
      unitsPerBox,
      boxCount,
      currentQuantity: Number(product.currentQuantity || 0),
      ...dimensions
    };
  }).filter(Boolean);
}

async function loadTemplateWorkbook(fileName) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(join(TEMPLATE_DIR, fileName));
  return workbook;
}

async function buildFactoryMovementTemplateWorkbook(db, { operation, date, kind }) {
  const items = await buildFactoryMovementTemplateItems(db, { operation, date });
  const templateName = kind === "backend" ? "后台发货模版.xlsx" : kind === "shipping" ? "发货模版.xlsx" : "补货模版.xlsx";
  const workbook = await loadTemplateWorkbook(templateName);
  const worksheet = kind === "backend"
    ? (workbook.getWorksheet("Create workflow – template") || workbook.worksheets[0])
    : workbook.worksheets[0];
  const startRow = kind === "backend" ? 9 : 2;

  items.forEach((item, index) => {
    const row = worksheet.getRow(startRow + index);
    if (kind === "backend") {
      row.getCell(1).value = item.sellerSku;
      row.getCell(2).value = item.quantity;
      row.getCell(5).value = item.unitsPerBox || "";
      row.getCell(6).value = item.boxCount || "";
      row.getCell(7).value = item.lengthCm ? Number((item.lengthCm / 2.54).toFixed(2)) : "";
      row.getCell(8).value = item.widthCm ? Number((item.widthCm / 2.54).toFixed(2)) : "";
      row.getCell(9).value = item.heightCm ? Number((item.heightCm / 2.54).toFixed(2)) : "";
      row.getCell(10).value = item.lengthCm === 60 ? 45 : 33;
    } else {
      row.getCell(1).value = item.name;
      row.getCell(2).value = item.fnSku;
      row.getCell(3).value = item.unitsPerBox || "";
      row.getCell(4).value = item.quantity;
      row.getCell(5).value = item.boxCount || "";
      if (kind === "replenishment") {
        row.getCell(7).value = Math.max(0, item.currentQuantity - item.quantity);
        row.getCell(8).value = item.currentQuantity;
      }
    }
    row.commit();
  });

  return workbook.xlsx.writeBuffer();
}

function parseShipmentFilename(filename) {
  const stem = String(filename || "").replace(/\.(csv|txt)$/i, "");
  const parts = stem.split("_");
  return {
    fbaNumber: parts[0] || "",
    poNumber: parts[1] || "",
    warehouseCode: parts[2] || ""
  };
}

function findShipmentColumn(headers, matchers) {
  return headers.findIndex(header => matchers.some(matcher => {
    if (matcher instanceof RegExp) return matcher.test(header);
    return header === matcher;
  }));
}

function buildShipmentSkuMap(factoryRows) {
  const map = new Map();
  for (const product of factoryRows) {
    for (const key of [product.sellerSku, product.fnSku, product.asin]) {
      const normalized = String(key || "").trim();
      if (normalized && !map.has(normalized)) map.set(normalized, product);
    }
  }
  return map;
}

function processShipmentCsvContent(content, filename, skuMap) {
  const rows = parseCsvRows(content);
  let headerIndex = -1;
  let skuIndex = -1;
  let quantityIndex = -1;
  let boxNumberIndex = -1;
  for (let index = 0; index < Math.min(30, rows.length); index += 1) {
    const headers = rows[index].map(normalizeHeader);
    const candidateSku = findShipmentColumn(headers, ["sku", "merchant sku", "msku", "seller sku", "seller-sku"]);
    const candidateQuantity = findShipmentColumn(headers, [/箱子总数/, /number of boxes/, /box count/, /^quantity$/]);
    const candidateBoxNumber = findShipmentColumn(headers, [/箱号/, /box number/, /carton/, /box id/]);
    if (candidateSku >= 0 && candidateQuantity >= 0 && candidateBoxNumber >= 0) {
      headerIndex = index;
      skuIndex = candidateSku;
      quantityIndex = candidateQuantity;
      boxNumberIndex = candidateBoxNumber;
      break;
    }
  }
  if (headerIndex === -1) throw new Error(`无法在 ${filename} 中找到 SKU、箱子总数、箱号列`);

  const bySku = new Map();
  for (const row of rows.slice(headerIndex + 1)) {
    const sku = String(row[skuIndex] || "").replace(/^"|"$/g, "").trim();
    const quantity = Number(String(row[quantityIndex] || "").replace(/[^\d.-]/g, "")) || 0;
    const boxNumberText = String(row[boxNumberIndex] || "").replace(/^"|"$/g, "").trim();
    if (!sku || !quantity || !boxNumberText) continue;
    const product = skuMap.get(sku);
    if (!product) continue;
    const item = bySku.get(sku) || {
      sku,
      name: product.name || product.title || sku,
      asin: product.asin || "",
      boxCount: 0,
      boxNumbers: [],
      product
    };
    item.boxCount += quantity;
    for (const boxNumber of boxNumberText.split(/[,，、\s]+/).map(value => value.trim()).filter(Boolean)) {
      if (!item.boxNumbers.includes(boxNumber)) item.boxNumbers.push(boxNumber);
    }
    bySku.set(sku, item);
  }
  return [...bySku.values()];
}

async function buildLabelWorkbook(files) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("贴标");
  worksheet.columns = [
    { header: "文件", key: "file", width: 32 },
    { header: "名称", key: "name", width: 42 },
    { header: "箱子数量", key: "boxCount", width: 12 },
    { header: "编号", key: "boxNumbers", width: 42 }
  ];
  worksheet.getRow(1).font = { bold: true };
  for (const file of files) {
    worksheet.addRow([file.name]);
    const titleRow = worksheet.lastRow;
    titleRow.font = { bold: true };
    titleRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFF99" } };
    for (const item of file.items.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"))) {
      worksheet.addRow([file.name, item.name, item.boxCount, item.boxNumbers.join(", ")]);
    }
    worksheet.addRow([]);
  }
  return workbook.xlsx.writeBuffer();
}

function sortBoxNumbers(boxNumbers) {
  return [...boxNumbers].sort((a, b) => {
    const numA = Number(String(a).match(/(\d+)$/)?.[1] || 0);
    const numB = Number(String(b).match(/(\d+)$/)?.[1] || 0);
    return numA - numB;
  });
}

async function buildInvoiceWorkbook(templateType, shipmentData) {
  const workbook = await loadTemplateWorkbook(templateType === "jinsheng" ? "锦盛天成发票.xlsx" : "喜悦发票.xlsx");
  const worksheet = workbook.worksheets[0];
  const { fbaNumber, poNumber, warehouseCode, items } = shipmentData;
  const totalBoxes = items.reduce((sum, item) => sum + item.boxNumbers.length, 0);
  const defaultProductInfo = {
    weight: 20,
    englishName: "Hanging Organizer",
    chineseName: "悬挂式收纳袋",
    declaredPrice: 3.5,
    material: "Cotton",
    customsCode: "6307900090",
    usage: "Organizer",
    brand: "无",
    model: "无"
  };

  if (templateType === "jinsheng") {
    worksheet.getCell("B1").value = fbaNumber;
    worksheet.getCell("B2").value = "美国准时达";
    const sheet1 = workbook.worksheets.find(ws => ws.name === "Sheet1");
    let addressCode = "";
    const values = {};
    if (sheet1) {
      for (let rowNumber = 1; rowNumber <= sheet1.rowCount; rowNumber += 1) {
        const row = sheet1.getRow(rowNumber);
        if (String(row.getCell(3).value || "") === warehouseCode) {
          addressCode = String(row.getCell(1).value || "");
          values.col4 = row.getCell(4).value || "";
          values.col6 = row.getCell(6).value || "";
          values.col8 = row.getCell(8).value || "";
          values.col11 = row.getCell(11).value || "";
          values.col12 = row.getCell(12).value || "";
          values.col13 = row.getCell(13).value || "";
          values.col14 = row.getCell(14).value || "";
          break;
        }
      }
    }
    worksheet.getCell("B3").value = addressCode;
    worksheet.getCell("B4").value = values.col4 || "";
    worksheet.getCell("B6").value = values.col8 || "";
    worksheet.getCell("B9").value = values.col11 || "";
    worksheet.getCell("B10").value = values.col12 || "";
    worksheet.getCell("B11").value = values.col14 || "";
    worksheet.getCell("B12").value = values.col13 || "";
    worksheet.getCell("B13").value = values.col6 || "";
    worksheet.getCell("B15").value = poNumber;
    worksheet.getCell("B23").value = totalBoxes;
    worksheet.getCell("B24").value = warehouseCode;
  } else {
    worksheet.getCell("B1").value = fbaNumber;
    worksheet.getCell("B3").value = warehouseCode;
    worksheet.getCell("B4").value = warehouseCode;
    worksheet.getCell("B15").value = poNumber;
    worksheet.getCell("B16").value = totalBoxes;
  }

  let currentRow = templateType === "jinsheng" ? 26 : 18;
  for (const item of [...items].sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"))) {
    const boxNumbers = sortBoxNumbers(item.boxNumbers.length ? item.boxNumbers : [""]);
    const boxQuantity = parseFactoryBoxQuantity(item.product?.boxSpec || "") || 1;
    const dimensions = parseFactoryBoxDimensions(item.product?.boxSpec || "");
    for (const boxNumber of boxNumbers) {
      const row = worksheet.getRow(currentRow);
      if (templateType === "jinsheng") {
        row.getCell(1).value = boxNumber;
        row.getCell(2).value = poNumber;
        row.getCell(3).value = defaultProductInfo.weight;
        row.getCell(4).value = dimensions.lengthCm || "";
        row.getCell(5).value = dimensions.widthCm || "";
        row.getCell(6).value = dimensions.heightCm || "";
        row.getCell(7).value = defaultProductInfo.chineseName;
        row.getCell(8).value = defaultProductInfo.englishName;
        row.getCell(9).value = defaultProductInfo.declaredPrice;
        row.getCell(10).value = "USD";
        row.getCell(11).value = boxQuantity;
        row.getCell(12).value = defaultProductInfo.material;
        row.getCell(13).value = defaultProductInfo.usage;
        row.getCell(14).value = defaultProductInfo.customsCode;
        row.getCell(15).value = "否";
        row.getCell(16).value = "/";
        row.getCell(17).value = "/";
        row.getCell(18).value = "/";
        row.getCell(19).value = "/";
        row.getCell(20).value = "/";
      } else {
        row.getCell(1).value = fbaNumber;
        row.getCell(2).value = poNumber;
        row.getCell(3).value = defaultProductInfo.weight;
        row.getCell(4).value = dimensions.lengthCm || "";
        row.getCell(5).value = dimensions.widthCm || "";
        row.getCell(6).value = dimensions.heightCm || "";
        row.getCell(7).value = defaultProductInfo.englishName;
        row.getCell(8).value = defaultProductInfo.chineseName;
        row.getCell(9).value = defaultProductInfo.declaredPrice;
        row.getCell(10).value = boxQuantity;
        row.getCell(11).value = defaultProductInfo.material;
        row.getCell(12).value = defaultProductInfo.customsCode;
        row.getCell(13).value = defaultProductInfo.usage;
        row.getCell(14).value = defaultProductInfo.brand;
        row.getCell(15).value = defaultProductInfo.model;
      }
      row.commit();
      currentRow += 1;
    }
  }
  return workbook.xlsx.writeBuffer();
}

async function buildShipmentDocumentFiles(db, body) {
  const catalog = await ensureFactoryInventoryProductCatalog(db);
  const factoryView = await buildFactoryInventoryView(db, { fbaCatalogByAsin: catalog.fbaCatalogByAsin });
  const skuMap = buildShipmentSkuMap(factoryView.products || []);
  const templateType = String(body.templateType || "jinsheng");
  const inputFiles = Array.isArray(body.files) ? body.files : [];
  const processedFiles = [];
  const warehouseShipments = new Map();
  for (const file of inputFiles) {
    const name = String(file.name || "");
    if (!/^fba/i.test(name)) continue;
    const filenameInfo = parseShipmentFilename(name);
    const items = processShipmentCsvContent(file.content || "", name, skuMap);
    processedFiles.push({ name, items });
    if (!filenameInfo.warehouseCode) continue;
    const existing = warehouseShipments.get(filenameInfo.warehouseCode) || { ...filenameInfo, items: [] };
    existing.items.push(...items);
    warehouseShipments.set(filenameInfo.warehouseCode, existing);
  }
  const today = new Date().toISOString().slice(0, 10);
  const files = [];
  files.push({
    filename: `贴标_${today}.xlsx`,
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    base64: Buffer.from(await buildLabelWorkbook(processedFiles)).toString("base64")
  });
  for (const shipment of warehouseShipments.values()) {
    if (!shipment.items.length) continue;
    const templateName = templateType === "jinsheng" ? "锦盛天成发票" : "赤道发票";
    files.push({
      filename: `${templateName}_${shipment.warehouseCode}_${shipment.fbaNumber}_${today}.xlsx`,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      base64: Buffer.from(await buildInvoiceWorkbook(templateType, shipment)).toString("base64")
    });
  }
  return { files };
}

async function buildFbaProductCatalog(db) {
  const byAsin = new Map();
  const remember = item => {
    const asin = String(item?.asin || "").trim().toUpperCase();
    if (!asin) return;
    const existing = byAsin.get(asin) || {};
    byAsin.set(asin, {
      asin,
      parentAsin: existing.parentAsin || item.parentAsin || item.parent_asin || "",
      sellerSku: existing.sellerSku || item.sellerSku || item.sku || "",
      fnSku: existing.fnSku || item.fnSku || "",
      title: existing.title || item.title || item.itemName || "",
      brand: existing.brand || item.brand || "",
      imageUrl: existing.imageUrl || item.imageUrl || "",
      marketplaceId: existing.marketplaceId || item.marketplaceId || "",
      source: existing.source || item.source || "fba"
    });
  };

  for (const product of buildProductsFromDb(db)) remember(product);

  try {
    const metadataRows = await readFbaSkuMetadataRows();
    for (const row of metadataRows) remember(row);
  } catch {
    // Factory inventory should still work when FBA metadata storage is unavailable.
  }

  try {
    const dailyRows = await readFbaDailyRows();
    for (const row of dailyRows) {
      if (row.sellerSku === FBA_DATE_MARKER_SKU) continue;
      remember(row);
    }
  } catch {
    // Ignore FBA daily storage failures for this independent module.
  }

  return byAsin;
}

async function ensureFactoryInventoryProductCatalog(db) {
  const fbaCatalogByAsin = await buildFbaProductCatalog(db);
  const store = db.factoryInventory || { products: [], movements: [] };
  store.products = Array.isArray(store.products) ? store.products.map(item => normalizeFactoryProduct(item)) : [];
  store.movements = Array.isArray(store.movements) ? store.movements.map(item => normalizeFactoryMovement(item)) : [];
  let changed = false;
  const byId = new Map(store.products.map(product => [product.id, product]));
  for (const product of store.products) {
    if (!product.asin) continue;
    const fbaProduct = fbaCatalogByAsin.get(product.asin);
    if (!fbaProduct) continue;
    const nextSource = product.source.includes("fba") ? product.source : `${product.source}_fba_enriched`;
    if (product.source !== nextSource) {
      byId.set(product.id, normalizeFactoryProduct({
        ...product,
        source: nextSource,
        updatedAt: new Date().toISOString()
      }));
      changed = true;
    }
  }
  for (const fbaProduct of fbaCatalogByAsin.values()) {
    const id = `factory-${fbaProduct.asin}`;
    if (byId.has(id)) continue;
    // Factory inventory should only show products that exist in the factory sheet.
    // FBA catalog enriches matching ASINs with title/images, but does not create empty factory columns.
  }
  if (changed) {
    store.products = [...byId.values()];
    db.factoryInventory = store;
  }
  return { changed, fbaCatalogByAsin };
}

async function buildFactoryInventoryView(db, options = {}) {
  const fbaCatalogByAsin = options.fbaCatalogByAsin || await buildFbaProductCatalog(db);
  const storedProducts = (Array.isArray(db.factoryInventory?.products) ? db.factoryInventory.products : [])
    .map(item => normalizeFactoryProduct(item));
  let fbaMetadataRows = [];
  try {
    fbaMetadataRows = await readFbaSkuMetadataRows();
  } catch {
    fbaMetadataRows = [];
  }
  const fbaMetadataByAsin = new Map(fbaMetadataRows.map(row => [normalizeAsin(row.asin), row]));
  const parentCategoryDefaults = new Map();
  for (const product of storedProducts) {
    const fbaProduct = fbaCatalogByAsin.get(product.asin) || {};
    const parentAsin = normalizeAsin(fbaProduct.parentAsin || product.parentAsin);
    if (!parentAsin) continue;
    const childMetadata = fbaMetadataByAsin.get(normalizeAsin(product.asin));
    const classification = catalogClassification(childMetadata);
    const group = parentCategoryDefaults.get(parentAsin) || { first: null, options: new Map() };
    if (!group.first && classification.categoryId) group.first = { id: classification.categoryId, name: classification.categoryName || classification.categoryId };
    if (classification.categoryId) group.options.set(classification.categoryId, classification.categoryName || classification.categoryId);
    parentCategoryDefaults.set(parentAsin, group);
  }
  const existingParentMetadataRows = await readParentAsinMetadataRows();
  for (const [parentAsin, group] of parentCategoryDefaults) {
    const existing = existingParentMetadataRows.find(row => row.parentAsin === parentAsin);
    if (!existing?.categoryId && group.first?.id) {
      await upsertParentAsinCategory(parentAsin, group.first.id, group.first.name);
    }
  }
  const parentMetadataRows = await readParentAsinMetadataRows();
  const parentAsinMetadata = new Map(parentMetadataRows.map(row => [row.parentAsin, row]));
  const productsById = new Map();
  const rememberProduct = product => {
    const existing = productsById.get(product.id);
    productsById.set(product.id, normalizeFactoryProduct({ ...(existing || {}), ...product }));
  };

  for (const item of storedProducts) {
    const fbaProduct = fbaCatalogByAsin.get(item.asin) || null;
    rememberProduct({
      ...item,
      name: item.name,
      asin: item.asin,
      source: fbaProduct && !item.source.includes("fba") ? `${item.source}_fba_enriched` : item.source
    });
  }

  for (const fbaProduct of fbaCatalogByAsin.values()) {
    const id = `factory-${fbaProduct.asin}`;
    if (productsById.has(id)) continue;
    // Do not add FBA-only products here; otherwise the matrix gets many empty columns.
  }

  const products = [...productsById.values()];
  const movements = (Array.isArray(db.factoryInventory?.movements) ? db.factoryInventory.movements : [])
    .map(item => normalizeFactoryMovement(item))
    .filter(item => item.productId && item.quantity);
  const productById = new Map(products.map(product => [product.id, product]));
  const movementsByProduct = new Map();
  for (const movement of movements) {
    if (!movementsByProduct.has(movement.productId)) movementsByProduct.set(movement.productId, []);
    movementsByProduct.get(movement.productId).push(movement);
  }
  const rows = products.map(product => {
    const productMovements = (movementsByProduct.get(product.id) || [])
      .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.createdAt).localeCompare(String(a.createdAt)));
    const fbaProduct = fbaCatalogByAsin.get(product.asin) || {};
    const parentAsin = String(fbaProduct.parentAsin || product.parentAsin || "").trim().toUpperCase();
    const parentMetadata = parentAsinMetadata.get(parentAsin) || {};
    const categoryGroup = parentCategoryDefaults.get(parentAsin) || { options: new Map() };
    const currentQuantity = Number(product.currentQuantity || 0);
    const inventoryValue = calculateFactoryInventoryValue(product);
    return {
      ...product,
      imageUrl: fbaProduct.imageUrl || "",
      parentAsin,
      parentInternalName: parentMetadata.internalName || product.parentInternalName || "",
      parentCategoryId: parentMetadata.categoryId || "",
      parentCategoryName: parentMetadata.categoryName || "",
      parentCategoryOptions: [...categoryGroup.options].map(([id, name]) => ({ id, name })),
      sellerSku: fbaProduct.sellerSku || "",
      fnSku: fbaProduct.fnSku || "",
      title: fbaProduct.title || product.name || "",
      currentQuantity,
      inventoryValue,
      movementCount: productMovements.length,
      lastMovementAt: productMovements[0]?.date || "",
      stockLevel: currentQuantity <= 0 ? "out" : currentQuantity <= Number(product.safetyStock || 0) ? "low" : "ok"
    };
  }).sort((a, b) => Number(a.order || 0) - Number(b.order || 0) || String(a.name).localeCompare(String(b.name), "zh-Hans-CN"));
  const movementRows = movements
    .map(movement => ({
      ...movement,
      typeLabel: factoryMovementLabel(movement.type),
      productName: productById.get(movement.productId)?.name || "",
      asin: productById.get(movement.productId)?.asin || ""
    }))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.createdAt).localeCompare(String(a.createdAt)));
  const totals = rows.reduce((acc, product) => {
    acc.productCount += 1;
    acc.currentQuantity += Number(product.currentQuantity || 0);
    if (product.inventoryValue !== "") acc.inventoryValue += Number(product.inventoryValue || 0);
    if (product.stockLevel === "low") acc.lowStockCount += 1;
    if (product.stockLevel === "out") acc.outOfStockCount += 1;
    return acc;
  }, { productCount: 0, currentQuantity: 0, inventoryValue: 0, lowStockCount: 0, outOfStockCount: 0 });
  totals.inventoryValue = Number(totals.inventoryValue.toFixed(2));
  return { products: rows, movements: movementRows, totals };
}

function buildFactoryQuantityByAsin(db) {
  const quantities = new Map();
  const products = Array.isArray(db.factoryInventory?.products) ? db.factoryInventory.products : [];
  for (const item of products) {
    const product = normalizeFactoryProduct(item);
    const asin = String(product.asin || "").trim().toUpperCase();
    if (!asin) continue;
    quantities.set(asin, Number(quantities.get(asin) || 0) + Number(product.currentQuantity || 0));
  }
  return quantities;
}

function buildFactoryInfoByAsin(db) {
  const info = new Map();
  const products = Array.isArray(db.factoryInventory?.products) ? db.factoryInventory.products : [];
  for (const item of products) {
    const product = normalizeFactoryProduct(item);
    const asin = String(product.asin || "").trim().toUpperCase();
    if (!asin) continue;
    const existing = info.get(asin) || {
      quantity: 0,
      productId: "",
      boxSpec: "",
      name: "",
      replenishmentGrade: ""
    };
    info.set(asin, {
      quantity: Number(existing.quantity || 0) + Number(product.currentQuantity || 0),
      productId: existing.productId || product.id,
      boxSpec: existing.boxSpec || product.boxSpec || "",
      name: existing.name || product.name || "",
      replenishmentGrade: existing.replenishmentGrade || product.replenishmentGrade || ""
    });
  }
  return info;
}

async function buildFbaGradeByAsin(db) {
  const grades = new Map();
  const productMetadataRows = await readFbaProductMetadataRows();
  for (const row of productMetadataRows) {
    const asin = normalizeAsin(row.asin);
    const grade = normalizeFbaReplenishmentGrade(row.replenishmentGrade);
    if (asin && grade) grades.set(asin, grade);
  }
  return grades;
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
  const cacheKey = [
    config.clientId,
    config.refreshToken,
    config.endpoint,
    config.marketplaceId
  ].join("|");
  if (spApiAccessTokenCache?.cacheKey === cacheKey && spApiAccessTokenCache.expiresAt > Date.now() + 60000) {
    return {
      ok: true,
      configured: true,
      config,
      accessToken: spApiAccessTokenCache.accessToken,
      tokenType: spApiAccessTokenCache.tokenType,
      expiresIn: Math.max(0, Math.floor((spApiAccessTokenCache.expiresAt - Date.now()) / 1000))
    };
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
  spApiAccessTokenCache = {
    cacheKey,
    accessToken: data.access_token,
    tokenType: data.token_type || "bearer",
    expiresAt: Date.now() + Math.max(0, Number(data.expires_in || 0) * 1000)
  };
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
const SALES_COMPLETE_BUFFER_HOURS = Number(process.env.AMZ_SALES_COMPLETE_BUFFER_HOURS || 12);

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

function isDateReadyForSavedSales(dateValue, fetchedAt = new Date()) {
  const date = String(dateValue || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  if (date <= addDays(formatDateInTimeZone(), -3)) return true;
  const fetchedTime = fetchedAt instanceof Date ? fetchedAt.getTime() : new Date(fetchedAt).getTime();
  if (!Number.isFinite(fetchedTime)) return false;
  const bufferMs = Number.isFinite(SALES_COMPLETE_BUFFER_HOURS)
    ? Math.max(0, SALES_COMPLETE_BUFFER_HOURS) * 60 * 60 * 1000
    : 12 * 60 * 60 * 1000;
  return fetchedTime > zonedDateTimeToUtc(date, 23, 59, 59).getTime() + bufferMs;
}

function isCompleteSalesDateMarker(row) {
  return row?.sellerSku === FBA_DATE_MARKER_SKU && row.salesFetchedAt && isDateReadyForSavedSales(row.date, row.salesFetchedAt);
}

function summarizeFbaDateCoverage(rows, marketplaceId, dates) {
  const inventoryDates = new Set();
  const salesDates = new Set();
  for (const row of rows) {
    if (row.marketplaceId !== marketplaceId) continue;
    const date = String(row.date || "").slice(0, 10);
    if (!dates.includes(date)) continue;
    if (row.inventoryFetchedAt && row.sellerSku !== FBA_DATE_MARKER_SKU) inventoryDates.add(date);
    if (isCompleteSalesDateMarker(row)) salesDates.add(date);
  }
  return {
    missingInventoryDates: dates.filter(date => !inventoryDates.has(date)),
    missingSalesDates: dates.filter(date => !salesDates.has(date))
  };
}

function summarizeDateList(dates, limit = 8) {
  const values = [...new Set(dates)].sort();
  if (!values.length) return "";
  const shown = values.slice(0, limit).join("、");
  return values.length > limit ? `${shown} 等 ${values.length} 天` : shown;
}

function fbaJobPublicView(job) {
  if (!job) return null;
  return {
    id: job.id,
    key: job.key,
    status: job.status,
    reason: job.reason,
    startDate: job.startDate,
    endDate: job.endDate,
    dates: job.dates || [],
    createdAt: job.createdAt,
    startedAt: job.startedAt || "",
    finishedAt: job.finishedAt || "",
    error: job.error || "",
    warnings: job.warnings || [],
    result: job.result || null
  };
}

function latestFbaSyncJob() {
  return [...fbaSyncJobs.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] || null;
}

function pruneFbaSyncJobs() {
  const jobs = [...fbaSyncJobs.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  for (const job of jobs.slice(Number(process.env.AMZ_FBA_SYNC_JOB_HISTORY || 20))) {
    fbaSyncJobs.delete(job.id);
  }
}

async function runFbaSyncJob(job) {
  job.status = "running";
  job.startedAt = new Date().toISOString();
  logFbaSync({
    time: job.startedAt,
    status: "running",
    reason: job.reason,
    startDate: job.startDate,
    endDate: job.endDate,
    days: job.dates?.length || 0,
  });
  try {
    const result = await syncFbaDailyRange(job.startDate, job.endDate, {
      dates: job.dates,
      inventoryDates: job.inventoryDates || [],
      allowFrozenInventoryUpdate: Boolean(job.allowFrozenInventoryUpdate),
      forceNewReport: Boolean(job.forceNewReport),
      reuseSameDayReport: Boolean(job.reuseSameDayReport),
      syncCurrentInventory: job.syncCurrentInventory !== false,
      syncHistoricalInventory: job.syncHistoricalInventory !== false,
      syncSales: job.syncSales !== false,
      syncCatalog: Boolean(job.syncCatalog)
    });
    job.status = result.warnings?.length ? "partial" : "done";
    job.result = result;
    job.warnings = result.warnings || [];
    job.finishedAt = new Date().toISOString();
    logFbaSync({
      time: job.finishedAt,
      status: job.status,
      reason: job.reason,
      warnings: job.warnings.length,
    });
    fbaInventoryCache.clear();
  } catch (error) {
    job.status = "failed";
    job.error = error.message || "FBA 同步失败";
    job.finishedAt = new Date().toISOString();
    logFbaSync({
      time: job.finishedAt,
      status: "failed",
      reason: job.reason,
      error: job.error,
    });
  } finally {
    fbaSyncLocks.delete(job.key);
    pruneFbaSyncJobs();
  }
}

function scheduleFbaSyncJob(job) {
  const run = () => runFbaSyncJob(job);
  job.completion = fbaSyncQueueTail = fbaSyncQueueTail.then(run, run).then(() => job);
}

function enqueueFbaSyncJob(input = {}) {
  const today = formatDateInTimeZone();
  const requestedDates = input.dates?.length
    ? [...new Set(input.dates.map(date => String(date).slice(0, 10)).filter(Boolean))].sort()
    : dateRangeInclusive(input.startDate || addDays(today, -29), input.endDate || today);
  const dates = requestedDates.length ? requestedDates : [today];
  const startDate = dates[0];
  const endDate = dates[dates.length - 1];
  const syncFlags = [
    input.syncCurrentInventory !== false ? "current" : "",
    input.syncHistoricalInventory !== false ? "historical" : "",
    input.syncSales !== false ? "sales" : "",
    input.syncCatalog ? "catalog" : ""
  ].filter(Boolean).join("+");
  const key = `${getSpApiConfig().marketplaceId}|${input.reason || "manual"}|${syncFlags}|${startDate}|${endDate}|${dates.join(",")}`;
  const existingId = fbaSyncLocks.get(key);
  if (existingId) {
    const existing = fbaSyncJobs.get(existingId);
    if (existing && ["queued", "running"].includes(existing.status)) return existing;
  }
  const job = {
    id: randomUUID(),
    key,
    status: "queued",
    reason: input.reason || "manual",
    startDate,
    endDate,
    dates,
    inventoryDates: input.inventoryDates || dates.filter(date => date <= today),
    allowFrozenInventoryUpdate: Boolean(input.allowFrozenInventoryUpdate),
    forceNewReport: Boolean(input.forceNewReport),
    reuseSameDayReport: Boolean(input.reuseSameDayReport),
    syncCurrentInventory: input.syncCurrentInventory !== false,
    syncHistoricalInventory: input.syncHistoricalInventory !== false,
    syncSales: input.syncSales !== false,
    syncCatalog: Boolean(input.syncCatalog),
    createdAt: new Date().toISOString(),
    warnings: []
  };
  fbaSyncJobs.set(job.id, job);
  fbaSyncLocks.set(key, job.id);
  scheduleFbaSyncJob(job);
  return job;
}

function shouldRunIntervalJob(key, intervalMs) {
  const lastRun = fbaSyncLastRun.get(key) || 0;
  return Date.now() - lastRun >= intervalMs;
}

function markIntervalJobRun(key) {
  fbaSyncLastRun.set(key, Date.now());
}

function enqueueIntervalJob(key, intervalMs, buildJob) {
  if (!shouldRunIntervalJob(key, intervalMs)) return null;
  markIntervalJobRun(key);
  return enqueueFbaSyncJob(buildJob());
}

function dateSegments(dates) {
  const sorted = [...new Set(dates)].sort();
  const segments = [];
  let current = [];
  for (const date of sorted) {
    if (!current.length || addDays(current[current.length - 1], 1) === date) {
      current.push(date);
    } else {
      segments.push(current);
      current = [date];
    }
  }
  if (current.length) segments.push(current);
  return segments;
}

async function enqueueStartupFbaSyncJobs() {
  const today = formatDateInTimeZone();
  const stableEnd = addDays(today, -1);
  const historyDates = dateRangeInclusive(addDays(stableEnd, -29), stableEnd);
  markIntervalJobRun("sales_sku_today_hourly");
  markIntervalJobRun("inventory_current_6h");
  markIntervalJobRun(`daily_history_backfill:${stableEnd}`);
  const rows = await readFbaDailyRows();
  const coverage = summarizeFbaDateCoverage(rows, getSpApiConfig().marketplaceId, historyDates);
  const missingDates = [...new Set([...coverage.missingInventoryDates, ...coverage.missingSalesDates])].sort();
  if (missingDates.length) {
    logFbaSync({
      status: "queued",
      reason: "startup_history_gap",
      startDate: missingDates[0],
      endDate: missingDates[missingDates.length - 1],
      days: missingDates.length,
      detail: `inventory:${summarizeDateList(coverage.missingInventoryDates)};sales:${summarizeDateList(coverage.missingSalesDates)}`
    });
  }
  const missingInventoryDateSet = new Set(coverage.missingInventoryDates);
  const missingSalesDateSet = new Set(coverage.missingSalesDates);

  enqueueFbaSyncJob({
    reason: "startup_today_sales",
    dates: [today],
    inventoryDates: [],
    allowFrozenInventoryUpdate: false,
    forceNewReport: true,
    syncCurrentInventory: false,
    syncHistoricalInventory: false,
    syncSales: true,
    syncCatalog: false
  });

  enqueueFbaSyncJob({
    reason: "startup_current_inventory",
    dates: [today],
    inventoryDates: [today],
    allowFrozenInventoryUpdate: false,
    forceNewReport: true,
    syncCurrentInventory: true,
    syncHistoricalInventory: false,
    syncSales: false,
    syncCatalog: true
  });

  for (const segment of dateSegments(missingDates)) {
    const segmentInventoryDates = segment.filter(date => missingInventoryDateSet.has(date));
    const segmentSalesDates = segment.filter(date => missingSalesDateSet.has(date));
    if (!segmentInventoryDates.length && !segmentSalesDates.length) continue;
    enqueueFbaSyncJob({
      reason: "startup_history_gap",
      dates: segmentSalesDates.length ? segmentSalesDates : segment,
      inventoryDates: segmentInventoryDates,
      allowFrozenInventoryUpdate: false,
      forceNewReport: true,
      syncCurrentInventory: false,
      syncHistoricalInventory: segmentInventoryDates.length > 0,
      syncSales: segmentSalesDates.length > 0,
      syncCatalog: false
    });
  }
}

function enqueueDueFbaSyncJobs() {
  const today = formatDateInTimeZone();
  const stableEnd = addDays(today, -1);
  const historyDates = dateRangeInclusive(addDays(stableEnd, -29), stableEnd);
  const oneHourMs = Math.max(15, Number(process.env.AMZ_FBA_TODAY_SALES_INTERVAL_MINUTES || 60)) * 60 * 1000;
  const sixHourMs = Math.max(1, Number(process.env.AMZ_FBA_CURRENT_INVENTORY_INTERVAL_HOURS || 6)) * 60 * 60 * 1000;

  enqueueIntervalJob("sales_sku_today_hourly", oneHourMs, () => ({
    reason: "sales_sku_today_hourly",
    dates: [today],
    inventoryDates: [],
    allowFrozenInventoryUpdate: false,
    forceNewReport: true,
    syncCurrentInventory: false,
    syncHistoricalInventory: false,
    syncSales: true,
    syncCatalog: false
  }));

  enqueueIntervalJob("inventory_current_6h", sixHourMs, () => ({
    reason: "inventory_current_6h",
    dates: [today],
    inventoryDates: [today],
    allowFrozenInventoryUpdate: false,
    forceNewReport: false,
    syncCurrentInventory: true,
    syncHistoricalInventory: false,
    syncSales: false,
    syncCatalog: true
  }));

  const dailyKey = `daily_history_backfill:${stableEnd}`;
  enqueueIntervalJob(dailyKey, 24 * 60 * 60 * 1000, () => ({
    reason: "daily_history_backfill",
    dates: historyDates,
    inventoryDates: historyDates,
    allowFrozenInventoryUpdate: false,
    forceNewReport: true,
    syncCurrentInventory: false,
    syncHistoricalInventory: true,
    syncSales: true,
    syncCatalog: false
  }));
}

function scheduleNextFbaSync({ runNow = false } = {}) {
  if (process.env.AMZ_FBA_SCHEDULE_ENABLED === "0" || process.env.AMZ_FBA_SCHEDULE_ENABLED === "false") return;
  if (fbaScheduledSyncTimer) clearTimeout(fbaScheduledSyncTimer);
  if (runNow) enqueueDueFbaSyncJobs();
  fbaScheduledSyncTimer = setTimeout(() => {
    scheduleNextFbaSync({ runNow: true });
  }, Math.max(60_000, Number(process.env.AMZ_FBA_SCHEDULE_CHECK_MS || 60_000)));
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

function isRetryableAmazonError(error) {
  const message = String(error?.message || error || "");
  return /\b(429|500|502|503|504)\b|QuotaExceeded|throttl|UND_ERR_SOCKET|other_side_closed|socket|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|请求超时/i.test(message);
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
  const method = options.method || "GET";
  const startedAt = Date.now();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  });
  let response;
  try {
    response = await fetchAmazonWithTimeout(url, {
      method,
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
    logAmazonRequest({ method, path: pathname, status: "ERR", durationMs: Date.now() - startedAt, context: options.logContext, error: detail || "fetch_failed" });
    throw new Error(`${pathname} 请求失败：${detail || "fetch failed"}`);
  }
  const data = await response.json().catch(() => ({}));
  logAmazonRequest({ method, path: pathname, status: response.status, durationMs: Date.now() - startedAt, context: options.logContext });
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
      const retryable = isRetryableAmazonError(error);
      if (!retryable || attempt === retries) throw error;
      await wait(retryDelayMs * (attempt + 1) + Math.floor(Math.random() * 250));
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
    const data = await spApiFetchWithRetry("/fba/inventory/v1/summaries", params, {
      logContext: `fbaInventoryPage:${page + 1}`
    });
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

function normalizeAsin(value) {
  return String(value || "").trim().toUpperCase();
}

function extractParentAsinFromCatalogItem(item) {
  const selfAsin = normalizeAsin(item?.asin);
  const seen = new Set();
  const walk = value => {
    if (!value || typeof value !== "object" || seen.has(value)) return "";
    seen.add(value);
    for (const key of ["parentAsin", "parentASIN", "parent_asin"]) {
      const asin = normalizeAsin(value[key]);
      if (asin && asin !== selfAsin) return asin;
    }
    for (const key of ["parentAsins", "parentASINs", "parent_asins"]) {
      const values = Array.isArray(value[key]) ? value[key] : [value[key]];
      for (const candidate of values) {
        const asin = normalizeAsin(candidate?.asin || candidate);
        if (asin && asin !== selfAsin) return asin;
      }
    }
    for (const child of Object.values(value)) {
      if (child && typeof child === "object") {
        const asin = walk(child);
        if (asin) return asin;
      }
    }
    return "";
  };
  return walk(item?.relationships) || "";
}

function extractCatalogBrowseClassification(item, summary = null) {
  const primary = summary?.browseClassification || null;
  const nodes = [];
  const seenObjects = new Set();
  const seenIds = new Set();
  const addNode = value => {
    if (!value || typeof value !== "object") return;
    const id = String(value.classificationId || value.browseNodeId || value.nodeId || "").trim();
    if (!id || seenIds.has(id)) return;
    seenIds.add(id);
    nodes.push({ id, name: String(value.displayName || value.classificationName || value.name || "").trim() });
  };
  const walk = value => {
    if (!value || typeof value !== "object" || seenObjects.has(value)) return;
    seenObjects.add(value);
    addNode(value);
    for (const child of Object.values(value)) {
      if (child && typeof child === "object") {
        if (Array.isArray(child)) child.forEach(walk);
        else walk(child);
      }
    }
  };
  walk(primary);
  walk(item?.classifications);
  walk(item?.salesRanks);
  return {
    categoryId: String(primary?.classificationId || nodes[0]?.id || "").trim(),
    categoryName: String(primary?.displayName || nodes[0]?.name || "").trim(),
    categoryIds: nodes.map(node => node.id),
    categoryNodes: nodes
  };
}

async function fetchCatalogDetails(asins) {
  const config = getSpApiConfig();
  const enrichLimit = Number(process.env.AMZ_CATALOG_ENRICH_LIMIT || 300);
  const uniqueAsins = unique(asins).slice(0, Math.max(20, enrichLimit));
  const chunkSize = Math.max(1, Math.min(20, Number(process.env.AMZ_CATALOG_CHUNK_SIZE || 20)));
  const delayMs = Number(process.env.AMZ_CATALOG_DELAY_MS || 1200);
  const byAsin = new Map();
  for (let index = 0; index < uniqueAsins.length; index += chunkSize) {
    const identifiers = uniqueAsins.slice(index, index + chunkSize);
    const batchNumber = Math.floor(index / chunkSize) + 1;
    try {
      const data = await spApiFetchWithRetry("/catalog/2022-04-01/items", {
        marketplaceIds: config.marketplaceId,
        identifiers: identifiers.join(","),
        identifiersType: "ASIN",
        includedData: "images,summaries,relationships,classifications,salesRanks"
      }, {
        logContext: `catalogBatch:${batchNumber}:asinCount:${identifiers.length}`
      });
      for (const item of data.items || []) {
        const summary = Array.isArray(item.summaries) ? item.summaries[0] : null;
        const classification = extractCatalogBrowseClassification(item, summary);
        byAsin.set(item.asin, {
          parentAsin: extractParentAsinFromCatalogItem(item),
          title: summary?.itemName || "",
          brand: summary?.brand || "",
          imageUrl: findCatalogImageLink(item.images),
          ...classification
        });
      }
    } catch (error) {
      if (isRetryableAmazonError(error)) {
        if (delayMs > 0 && index + chunkSize < uniqueAsins.length) await wait(delayMs * 2);
        continue;
      }
      for (const asin of identifiers) {
        try {
          const data = await spApiFetchWithRetry("/catalog/2022-04-01/items", {
            marketplaceIds: config.marketplaceId,
            identifiers: asin,
            identifiersType: "ASIN",
            includedData: "images,summaries,relationships,classifications,salesRanks"
          }, { retries: 1, retryDelayMs: 1600, logContext: `catalogSingleRetry:${batchNumber}:asinCount:1` });
          const item = (data.items || [])[0];
          if (!item) continue;
          const summary = Array.isArray(item.summaries) ? item.summaries[0] : null;
          const classification = extractCatalogBrowseClassification(item, summary);
          byAsin.set(item.asin, {
            parentAsin: extractParentAsinFromCatalogItem(item),
            title: summary?.itemName || "",
            brand: summary?.brand || "",
            imageUrl: findCatalogImageLink(item.images),
            ...classification
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

function reportLogContext(kind, startDate, endDate, reportId = "", documentId = "") {
  return [
    kind,
    `${startDate}..${endDate}`,
    reportId ? `reportId:${reportId}` : "",
    documentId ? `documentId:${documentId}` : ""
  ].filter(Boolean).join(":");
}

async function downloadReportDocument(documentId, options = {}) {
  const context = options.logContext || "";
  const document = await spApiFetchWithRetry(`/reports/2021-06-30/documents/${encodeURIComponent(documentId)}`, {}, {
    retries: 2,
    logContext: context
  });
  const payload = document.payload || document;
  if (!payload.url) throw new Error("订单报表文档缺少下载 URL");
  let response;
  let lastFetchError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const startedAt = Date.now();
    try {
      response = await fetchAmazonWithTimeout(payload.url, { headers: { "user-agent": "AmzAllBlue/0.1" } });
      logAmazonRequest({ method: "GET", path: "reportDocumentDownload", status: response.status, durationMs: Date.now() - startedAt, attempt, context });
      if (response.ok) break;
      if (![429, 500, 502, 503, 504].includes(response.status)) break;
    } catch (error) {
      lastFetchError = error;
      const cause = error.cause || {};
      const detail = [cause.code, cause.message || error.message].filter(Boolean).join(" ");
      logAmazonRequest({ method: "GET", path: "reportDocumentDownload", status: "ERR", durationMs: Date.now() - startedAt, attempt, context, error: detail || "fetch_failed" });
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

async function getOrCreateSalesReport(startDate, endDate, options = {}) {
  await ensureSalesReportRequestsLoaded();
  const config = getSpApiConfig();
  const reportType = process.env.AMZ_ORDER_REPORT_TYPE || "GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL";
  const context = reportLogContext("salesReport", startDate, endDate);
  const key = `${config.marketplaceId}|${reportType}|${startDate}|${endDate}`;
  const existing = salesReportRequests.get(key);
  if (shouldReuseReport(existing, options)) {
    return { ...existing, startDate, endDate, reportKind: "salesReport" };
  }
  const created = await spApiFetchWithRetry("/reports/2021-06-30/reports", {}, {
    method: "POST",
    body: {
      reportType,
      marketplaceIds: [config.marketplaceId],
      dataStartTime: toIsoDateStart(startDate),
      dataEndTime: toOrdersCreatedBefore(endDate)
    },
    retries: 2,
    retryDelayMs: 30000,
    logContext: context
  });
  const payload = created.payload || created;
  const reportId = payload.reportId || payload.ReportId;
  if (!reportId) throw new Error("订单报表创建失败：缺少 reportId");
  const item = { reportId, reportType, startDate, endDate, reportKind: "salesReport", createdAt: Date.now() };
  await rememberSalesReportRequest(key, item);
  return item;
}

async function waitForReportDocument(report, label) {
  const waitMs = Math.max(5000, Number(process.env.AMZ_REPORT_WAIT_MS || process.env.AMZ_ORDER_REPORT_WAIT_MS || 90000));
  const pollMs = Math.max(15000, Number(process.env.AMZ_REPORT_POLL_MS || process.env.AMZ_ORDER_REPORT_POLL_MS || 15000));
  const deadline = Date.now() + waitMs;
  let latestStatus = "";
  let reportDocumentId = "";
  const context = reportLogContext(report.reportKind || label, report.startDate || "unknown", report.endDate || "unknown", report.reportId);
  while (Date.now() <= deadline) {
    const statusData = await spApiFetchWithRetry(`/reports/2021-06-30/reports/${encodeURIComponent(report.reportId)}`, {}, {
      retries: 1,
      logContext: context
    });
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

async function fetchSalesByDateSkuFromReport(startDate, endDate, options = {}) {
  const report = await getOrCreateSalesReport(startDate, endDate, options);
  const reportDocumentId = await waitForReportDocument(report, "订单报表");
  const text = await downloadReportDocument(reportDocumentId, {
    logContext: reportLogContext(report.reportKind || "salesReport", startDate, endDate, report.reportId, reportDocumentId)
  });
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

function toLedgerIsoDateStart(dateValue) {
  return `${String(dateValue).slice(0, 10)}T00:00:00Z`;
}

function toLedgerIsoDateEnd(dateValue) {
  return `${String(dateValue).slice(0, 10)}T23:59:59Z`;
}

function isReportFromToday(report) {
  if (!report?.createdAt) return false;
  return formatDateInTimeZone(new Date(report.createdAt)) === formatDateInTimeZone();
}

function shouldReuseReport(existing, options = {}) {
  if (!existing?.reportId || options.forceNewReport) return false;
  return options.reuseSameDayReport ? isReportFromToday(existing) : true;
}

async function getOrCreateLedgerReport(startDate, endDate, options = {}) {
  await ensureSalesReportRequestsLoaded();
  const config = getSpApiConfig();
  const reportType = "GET_LEDGER_SUMMARY_VIEW_DATA";
  const context = reportLogContext("ledgerReport", startDate, endDate);
  const key = `${config.marketplaceId}|${reportType}|${startDate}|${endDate}|DAILY|COUNTRY`;
  const existing = salesReportRequests.get(key);
  if (shouldReuseReport(existing, options)) {
    return { ...existing, startDate, endDate, reportKind: "ledgerReport" };
  }
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
    retries: 2,
    retryDelayMs: 30000,
    logContext: context
  });
  const payload = created.payload || created;
  const reportId = payload.reportId || payload.ReportId;
  if (!reportId) throw new Error("库存账本报表创建失败：缺少 reportId");
  const item = { reportId, reportType, startDate, endDate, reportKind: "ledgerReport", createdAt: Date.now() };
  await rememberSalesReportRequest(key, item);
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

async function fetchLedgerInventoryRecords(startDate, endDate, options = {}) {
  const config = getSpApiConfig();
  const report = await getOrCreateLedgerReport(startDate, endDate, options);
  const reportDocumentId = await waitForReportDocument(report, "库存账本报表");
  const text = await downloadReportDocument(reportDocumentId, {
    logContext: reportLogContext(report.reportKind || "ledgerReport", startDate, endDate, report.reportId, reportDocumentId)
  });
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
    parentAsin: catalogInfo.parentAsin || "",
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
    parentAsin: catalogInfo.parentAsin || "",
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
  if (isRealtimeInventorySnapshot(existing) && incoming?.inventoryFetchedAt && String(date || "").slice(0, 10) !== formatDateInTimeZone()) {
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
  for (const field of ["asin", "parentAsin", "fnSku", "title", "brand", "imageUrl", "condition"]) {
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

async function upsertFbaDailyRecords(records, options = {}) {
  const rows = await readFbaDailyRows();
  const byKey = new Map(rows.map(row => [makeFbaDailyKey(row), row]));
  const allowFrozenInventoryUpdate = Boolean(options.allowFrozenInventoryUpdate);
  let inserted = 0;
  let updated = 0;
  let skippedFrozen = 0;

  for (const record of records) {
    if (!record?.sellerSku || !record?.marketplaceId || !record?.date) continue;
    const key = makeFbaDailyKey(record);
    const existing = byKey.get(key);
    const isSalesUpdate = Boolean(record.salesFetchedAt);
    if ((existing?.frozenAt || (existing && isFbaDailyFrozen(record.date))) && !isSalesUpdate && !allowFrozenInventoryUpdate) {
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

async function syncFbaDailyRange(startDate, endDate, options = {}) {
  const config = getSpApiConfig();
  const today = formatDateInTimeZone();
  const rangeDates = dateRangeInclusive(startDate, endDate);
  const dates = options.dates || rangeDates;
  const inventoryDates = options.inventoryDates || [];
  const forceNewReport = Boolean(options.forceNewReport);
  const reuseSameDayReport = Boolean(options.reuseSameDayReport);
  const syncCurrentInventory = options.syncCurrentInventory !== false;
  const syncHistoricalInventory = options.syncHistoricalInventory !== false;
  const syncSales = options.syncSales !== false;
  const syncCatalog = Boolean(options.syncCatalog);
  const inventoryRecords = [];
  const warnings = [];
  let inventorySynced = false;

  if (syncCurrentInventory && rangeDates.includes(today)) {
    try {
      const inventory = await fetchFbaInventorySummaries();
      const catalog = await catalogForInventorySummaries(inventory, { syncCatalog });
      inventoryRecords.push(...inventory.map(summary => buildInventoryDailyRecord(summary, catalog, today, config)));
      inventorySynced = true;
    } catch (error) {
      warnings.push(`当天 FBA 库存快照保存失败：${error.message}`);
    }
  }

  const historicalInventoryDates = inventoryDates.filter(date => date < today);
  if (syncHistoricalInventory && historicalInventoryDates.length) {
    try {
      const ledgerRecords = await fetchLedgerInventoryRecords(historicalInventoryDates[0], historicalInventoryDates[historicalInventoryDates.length - 1], { forceNewReport, reuseSameDayReport });
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
  if (syncSales && dates.length) {
    try {
      salesByDate = await fetchSalesByDateSkuFromReport(dates[0], dates[dates.length - 1], { forceNewReport, reuseSameDayReport });
    } catch (error) {
      warnings.push(`${dates[0]} 至 ${dates[dates.length - 1]} Orders 销量报表拉取失败：${error.message}`);
    }
  }
  if (salesByDate) {
    for (const date of dates) {
      const sales = salesByDate.get(date);
      if (!sales) continue;
      orderCount += sales.orderCount || 0;
      orderItemErrorCount += sales.orderItemErrorCount || 0;
      warnings.push(...(sales.warnings || []));
      salesRecords.push(buildSalesDateMarkerRecord(date, config, sales));
      for (const sale of sales.bySku.values()) {
        salesRecords.push(buildSalesDailyRecord(sale, date, config));
      }
    }
  }

  const storage = await upsertFbaDailyRecords([...inventoryRecords, ...salesRecords], {
    allowFrozenInventoryUpdate: Boolean(options.allowFrozenInventoryUpdate)
  });
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
  const byDate = new Map();
  for (const row of rows) {
    if (row.marketplaceId !== config.marketplaceId) continue;
    const date = String(row.date || "").slice(0, 10);
    if (!date) continue;
    const item = byDate.get(date) || {
      date,
      rowCount: 0,
      inventoryCount: 0,
      salesCount: 0,
      salesMarkerCount: 0,
      pendingSalesMarkerCount: 0,
      complete: false,
      frozenCount: 0
    };
    item.rowCount += 1;
    if (row.inventoryFetchedAt) item.inventoryCount += 1;
    if (row.salesFetchedAt) item.salesCount += 1;
    if (isCompleteSalesDateMarker(row)) item.salesMarkerCount += 1;
    else if (row.sellerSku === FBA_DATE_MARKER_SKU && row.salesFetchedAt) item.pendingSalesMarkerCount += 1;
    if (row.frozenAt) item.frozenCount += 1;
    item.complete = item.inventoryCount > 0 && item.salesMarkerCount > 0;
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
  const suggestionEndDate = addDays(today, -2);
  const suggestion7Dates = dateRangeInclusive(addDays(suggestionEndDate, -6), suggestionEndDate);
  const suggestion30Dates = dateRangeInclusive(addDays(suggestionEndDate, -29), suggestionEndDate);
  const suggestionDates = [...new Set([...suggestion7Dates, ...suggestion30Dates])].sort();
  const coverageDates = [...new Set([...requestedDates, ...suggestionDates])].sort();
  const coverage = summarizeFbaDateCoverage(dailyRows, config.marketplaceId, coverageDates);
  if (coverage.missingSalesDates.length) {
    warnings.push(`有 ${coverage.missingSalesDates.length} 天销量未同步：${summarizeDateList(coverage.missingSalesDates)}；页面先展示本地已有数据，可点击“后台刷新数据”补齐。`);
  }
  const requestedInventoryCoverage = summarizeFbaDateCoverage(dailyRows, config.marketplaceId, requestedDates);
  const missingHistoricalInventoryDates = requestedInventoryCoverage.missingInventoryDates.filter(date => date < today);
  if (missingHistoricalInventoryDates.length) {
    warnings.push(`所选范围有 ${missingHistoricalInventoryDates.length} 天历史库存快照缺失；库存字段会优先显示结束日期已有快照。`);
  }
  const rangeRows = dailyRows.filter(row => row.date >= safeStart && row.date <= safeEnd && row.marketplaceId === config.marketplaceId);
  const suggestionRows = dailyRows.filter(row => suggestionDates.includes(row.date) && row.marketplaceId === config.marketplaceId);
  const allInventoryRows = dailyRows.filter(row => row.marketplaceId === config.marketplaceId && row.inventoryFetchedAt && row.sellerSku !== FBA_DATE_MARKER_SKU);
  const metadataRows = (await readFbaSkuMetadataRows()).filter(row => row.marketplaceId === config.marketplaceId);
  let inventoryRows = allInventoryRows.filter(row => row.date === safeEnd);

  if (!inventoryRows.length) {
    warnings.push(`结束日期 ${safeEnd} 没有本地 FBA 库存快照；库存字段显示为空，销量仍按所选日期范围统计。`);
  }
  const currentDateColumnsAvailable = inventoryRows.some(row => row.sellerSku !== FBA_DATE_MARKER_SKU && isRealtimeInventorySnapshot(row));
  const localDb = await readDb();
  const factoryInfoByAsin = buildFactoryInfoByAsin(localDb);
  const fbaGradeByAsin = await buildFbaGradeByAsin(localDb);

  const latestInventoryBySku = new Map();
  for (const row of inventoryRows) {
    if (row.sellerSku === FBA_DATE_MARKER_SKU) continue;
    const existing = latestInventoryBySku.get(row.sellerSku);
    if (!existing || String(row.date || "") > String(existing.date || "")) {
      latestInventoryBySku.set(row.sellerSku, row);
    }
  }

  const latestRealtimeInventoryBySku = new Map();
  for (const row of allInventoryRows) {
    if (row.sellerSku === FBA_DATE_MARKER_SKU || !isRealtimeInventorySnapshot(row)) continue;
    const existing = latestRealtimeInventoryBySku.get(row.sellerSku);
    if (!existing || String(row.date || "") > String(existing.date || "")) {
      latestRealtimeInventoryBySku.set(row.sellerSku, row);
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
  const suggestionSalesBySku = new Map();
  const inventoryBySkuDate = new Map();
  for (const row of allInventoryRows) {
    if (!row.sellerSku || !row.date) continue;
    inventoryBySkuDate.set(`${row.sellerSku}|${row.date}`, row);
  }
  const collectSuggestionSales = (dates, key) => {
    const dateSet = new Set(dates);
    for (const row of suggestionRows) {
      if (row.sellerSku === FBA_DATE_MARKER_SKU || !row.sellerSku || !dateSet.has(row.date)) continue;
      const sameDayInventory = inventoryBySkuDate.get(`${row.sellerSku}|${row.date}`);
      const isStockoutDay = !sameDayInventory || Number(sameDayInventory.fulfillableQuantity || 0) <= 0;
      const item = suggestionSalesBySku.get(row.sellerSku) || {
        sevenUnits: 0,
        sevenDays: 0,
        sevenStockoutUnits: 0,
        sevenStockoutDays: 0,
        thirtyUnits: 0,
        thirtyDays: 0,
        thirtyStockoutUnits: 0,
        thirtyStockoutDays: 0
      };
      const units = Number(row.salesUnits || 0);
      if (key === "seven") {
        if (isStockoutDay) {
          item.sevenStockoutUnits += units;
          item.sevenStockoutDays += 1;
        } else {
          item.sevenUnits += units;
          item.sevenDays += 1;
        }
      } else {
        if (isStockoutDay) {
          item.thirtyStockoutUnits += units;
          item.thirtyStockoutDays += 1;
        } else {
          item.thirtyUnits += units;
          item.thirtyDays += 1;
        }
      }
      suggestionSalesBySku.set(row.sellerSku, item);
    }
  };
  collectSuggestionSales(suggestion7Dates, "seven");
  collectSuggestionSales(suggestion30Dates, "thirty");
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
    const latestRealtimeInventory = latestRealtimeInventoryBySku.get(sku) || null;
    const metadata = mergeSkuDisplayMetadata(latestMetadataBySku.get(sku), inventory);
    const sale = salesBySku.get(sku) || { units: 0, orders: 0, sufficientUnits: 0, sufficientDays: 0 };
    const dailySales = sale.units / dayCount;
    const inventorySource = inventorySnapshotSource(inventory);
    const isWarehouseOnlyInventory = inventorySource === "ledger_summary";
    const hasRealtimeEndInventory = inventory && isRealtimeInventorySnapshot(inventory);
    const fulfillableQuantity = inventory ? Number(inventory.fulfillableQuantity || 0) : 0;
    const warehouseQuantity = inventory ? Number(inventory.fulfillableQuantity || 0) + Number(inventory.unfulfillableQuantity || 0) : 0;
    const totalGoodsQuantity = hasRealtimeEndInventory
      ? calculateTotalGoodsQuantity(inventory)
      : (inventory ? fulfillableQuantity : null);
    const inboundQuantity = hasRealtimeEndInventory ? calculateInboundQuantity(inventory) : null;
    const asin = String(metadata.asin || "").trim().toUpperCase();
    const factoryInfo = asin ? factoryInfoByAsin.get(asin) : null;
    const factoryQuantity = hasRealtimeEndInventory && currentDateColumnsAvailable && asin ? Number(factoryInfo?.quantity || 0) : null;
    const suggestionSales = suggestionSalesBySku.get(sku) || {};
    const sevenEffectiveDays = Number(suggestionSales.sevenDays || 0);
    const thirtyEffectiveDays = Number(suggestionSales.thirtyDays || 0);
    const sevenEffectiveDailySales = sevenEffectiveDays > 0 ? Number((Number(suggestionSales.sevenUnits || 0) / sevenEffectiveDays).toFixed(2)) : 0;
    const thirtyEffectiveDailySales = thirtyEffectiveDays > 0 ? Number((Number(suggestionSales.thirtyUnits || 0) / thirtyEffectiveDays).toFixed(2)) : 0;
    const replenishmentBaseDailySales = Math.max(sevenEffectiveDailySales, thirtyEffectiveDailySales);
    const factoryFbaTotalQuantity = totalGoodsQuantity !== null && factoryQuantity !== null
      ? Number(totalGoodsQuantity || 0) + Number(factoryQuantity || 0)
      : null;
    const sellableDays = dailySales > 0 && totalGoodsQuantity !== null ? Math.floor(Number(totalGoodsQuantity || 0) / dailySales) : null;
    const factoryFbaSellableDays = dailySales > 0 && factoryFbaTotalQuantity !== null
      ? Math.floor(Number(factoryFbaTotalQuantity || 0) / dailySales)
      : null;
    const stockoutDays = requestedDates.reduce((count, date) => {
      const dayInventory = inventoryBySkuDate.get(`${sku}|${date}`);
      return count + (!dayInventory || Number(dayInventory.fulfillableQuantity || 0) <= 0 ? 1 : 0);
    }, 0);
    return {
      asin,
      parentAsin: metadata.parentAsin || "",
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
      inboundQuantity,
      factoryQuantity,
      factoryFbaTotalUsesFactory: factoryQuantity !== null,
      latestRealtimeInventory: buildInventoryQuantitySnapshot(latestRealtimeInventory),
      factoryProductId: factoryInfo?.productId || "",
      factoryBoxSpec: factoryInfo?.boxSpec || "",
      factoryName: factoryInfo?.name || "",
      replenishmentGrade: fbaGradeByAsin.get(asin) || (!isMysqlEnabled() ? factoryInfo?.replenishmentGrade : "") || "",
      factoryFbaTotalQuantity,
      replenishmentSales: {
        sevenStartDate: suggestion7Dates[0],
        sevenEndDate: suggestion7Dates[suggestion7Dates.length - 1],
        thirtyStartDate: suggestion30Dates[0],
        thirtyEndDate: suggestion30Dates[suggestion30Dates.length - 1],
        sevenUnits: Number(suggestionSales.sevenUnits || 0),
        sevenEffectiveDays,
        sevenStockoutUnits: Number(suggestionSales.sevenStockoutUnits || 0),
        sevenStockoutDays: Number(suggestionSales.sevenStockoutDays || 0),
        sevenDailySales: sevenEffectiveDailySales,
        thirtyUnits: Number(suggestionSales.thirtyUnits || 0),
        thirtyEffectiveDays,
        thirtyStockoutUnits: Number(suggestionSales.thirtyStockoutUnits || 0),
        thirtyStockoutDays: Number(suggestionSales.thirtyStockoutDays || 0),
        thirtyDailySales: thirtyEffectiveDailySales,
        baseDailySales: replenishmentBaseDailySales
      },
      fulfillableQuantity,
      reservedQuantity: hasRealtimeEndInventory ? Number(inventory.reservedQuantity || 0) : null,
      unfulfillableQuantity: inventory ? Number(inventory.unfulfillableQuantity || 0) : 0,
      inboundWorkingQuantity: hasRealtimeEndInventory ? Number(inventory.inboundWorkingQuantity || 0) : null,
      inboundShippedQuantity: hasRealtimeEndInventory ? Number(inventory.inboundShippedQuantity || 0) : null,
      inboundReceivingQuantity: hasRealtimeEndInventory ? Number(inventory.inboundReceivingQuantity || 0) : null,
      salesOrders: Number(sale.orders || 0),
      salesUnits: Number(sale.units || 0),
      sufficientSalesDays: Number(sale.sufficientDays || 0),
      dailySales: Number(dailySales.toFixed(2)),
      sellableDays,
      factoryFbaSellableDays,
      stockoutDays,
      stockLevel: sellableDays === null ? "unknown" : sellableDays < 14 ? "low" : sellableDays < 30 ? "medium" : "healthy",
      factoryFbaStockLevel: factoryFbaSellableDays === null ? "unknown" : factoryFbaSellableDays < 14 ? "low" : factoryFbaSellableDays < 30 ? "medium" : "healthy",
      currentDateColumnsAvailable,
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
    if (row.inboundQuantity !== null && row.inboundQuantity !== undefined) acc.inboundQuantity += Number(row.inboundQuantity || 0);
    if (row.factoryQuantity !== null && row.factoryQuantity !== undefined && row.asin && !acc.factoryAsins.has(row.asin)) {
      acc.factoryAsins.add(row.asin);
      acc.factoryQuantity += Number(row.factoryQuantity || 0);
    }
    if (row.inventoryCompleteness === "warehouse_only") acc.warehouseOnlyRows += 1;
    if (row.inventoryCompleteness === "missing") acc.missingInventoryRows += 1;
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
    inboundQuantity: 0,
    factoryQuantity: 0,
    completeInventoryRows: 0,
    factoryAsins: new Set(),
    warehouseOnlyRows: 0,
    missingInventoryRows: 0,
    inboundWorkingQuantity: 0,
    inboundShippedQuantity: 0,
    inboundReceivingQuantity: 0,
    fulfillableQuantity: 0,
    unfulfillableQuantity: 0,
    reservedQuantity: 0,
    salesOrders: 0,
    salesUnits: 0
  });
  delete totals.factoryAsins;
  if (!currentDateColumnsAvailable) {
    totals.factoryQuantity = null;
  }
  totals.factoryFbaTotalQuantity = totals.completeInventoryRows > 0 && totals.factoryQuantity !== null
    ? totals.totalGoodsQuantity + totals.factoryQuantity
    : null;
  totals.inventoryCompleteness = totals.missingInventoryRows > 0 ? "missing" : (totals.warehouseOnlyRows > 0 ? "warehouse_only" : "complete");
  const salesMarkerSummary = rangeRows.reduce((acc, row) => {
    if (row.sellerSku !== FBA_DATE_MARKER_SKU) return acc;
    acc.orderCount += Number(row.rawSalesJson?.orderCount || 0);
    acc.orderItemErrorCount += Number(row.rawSalesJson?.orderItemErrorCount || 0);
    return acc;
  }, { orderCount: 0, orderItemErrorCount: 0 });

  return {
    range: { startDate: safeStart, endDate: safeEnd, dayCount, currentDateColumnsAvailable },
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

function sifTrafficAuditAsin(value) {
  const asin = String(value || "").trim().toUpperCase();
  return /^B[A-Z0-9]{9}$/.test(asin) ? asin : "";
}

function sifTrafficAuditNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sifTrafficAuditAsinMetrics(item = {}) {
  return {
    asin: sifTrafficAuditAsin(item.asin),
    naturalRank: sifTrafficAuditNumber(item.lastRank),
    sponsoredRank: sifTrafficAuditNumber(item.adLastRank),
    totalShare: sifTrafficAuditNumber(item.totalScoreRatio),
    naturalShare: sifTrafficAuditNumber(item.nfScoreRatio),
    adShare: sifTrafficAuditNumber(item.adScoreRatio),
    totalShareChange: sifTrafficAuditNumber(item.totalScoreDifferRatio),
    naturalShareChange: sifTrafficAuditNumber(item.nfScoreDifferRatio),
    adShareChange: sifTrafficAuditNumber(item.adScoreDifferRatio),
    keywordTags: Array.isArray(item.kwCharacters) ? item.kwCharacters.slice(0, 8) : []
  };
}

function sifTrafficAuditCpc(cpc = {}) {
  const output = {};
  for (const [key, entries] of Object.entries(cpc && typeof cpc === "object" ? cpc : {})) {
    const first = Array.isArray(entries) ? entries[0] : null;
    if (!first) continue;
    output[key] = { start: sifTrafficAuditNumber(first.start), median: sifTrafficAuditNumber(first.median), end: sifTrafficAuditNumber(first.end) };
  }
  return output;
}

async function listSifTrafficAuditKeywords(credentials, asins) {
  const collected = [];
  const pageSize = 50;
  let pageNum = 1;
  let total = null;
  do {
    const payload = await sifRequest("/api/compare/multiAsinKeywords", {
      vipModule: false, asins, searchKeyword: "", condition: "", effectCondition: "",
      compareField: "shareScore", sortBy: null, desc: true, granularity: "week",
      pageNum, pageSize, timePieceType: "latelyDay", timePieceValue: "7", indicatorType: "2"
    }, credentials);
    const data = payload?.data || {};
    const items = Array.isArray(data.keywords) ? data.keywords : [];
    collected.push(...items);
    total = Number.isFinite(Number(data.total)) ? Number(data.total) : collected.length;
    if (!items.length) break;
    pageNum += 1;
  } while (collected.length < total && pageNum <= 100);
  return { total: total ?? collected.length, keywords: collected };
}

async function readSifTrafficAuditLocalKeywords(profile, targetAsin, startDate, endDate) {
  const pool = getMysqlPool();
  const [rows] = await pool.query(`
    SELECT k.id, k.keyword_text, k.normalized_keyword, k.keyword_group,
      MAX(CASE WHEN c.lifecycle_status = 'ACTIVE' AND u.lifecycle_status = 'ACTIVE' AND c.desired_state = 'ENABLED' AND u.desired_state = 'ENABLED' THEN 1 ELSE 0 END) active,
      GROUP_CONCAT(DISTINCT c.match_type ORDER BY c.match_type SEPARATOR ',') match_types,
      AVG(CASE WHEN c.lifecycle_status = 'ACTIVE' AND u.lifecycle_status = 'ACTIVE' THEN u.bid END) current_bid,
      AVG(CASE WHEN c.lifecycle_status = 'ACTIVE' THEN c.daily_budget END) daily_budget,
      COALESCE(SUM(p.impressions), 0) impressions, COALESCE(SUM(p.clicks), 0) clicks,
      COALESCE(SUM(p.spend), 0) spend, COALESCE(SUM(p.orders_count), 0) orders_count, COALESCE(SUM(p.sales), 0) sales
    FROM ads_keywords k
    JOIN ads_campaigns c ON c.keyword_id = k.id AND c.profile_id = k.profile_id
    JOIN ads_ad_units u ON u.campaign_id = c.id AND u.child_asin = ?
    LEFT JOIN ads_performance_daily p ON p.ad_unit_id = u.id AND p.date BETWEEN ? AND ?
    WHERE k.profile_id = ? AND k.lifecycle_status = 'ACTIVE'
    GROUP BY k.id, k.keyword_text, k.normalized_keyword, k.keyword_group
  `, [targetAsin, startDate, endDate, String(profile.profileId)]);
  const output = new Map();
  for (const row of rows) {
    const impressions = Number(row.impressions || 0);
    const clicks = Number(row.clicks || 0);
    const spend = Number(row.spend || 0);
    const sales = Number(row.sales || 0);
    output.set(String(row.normalized_keyword || ""), {
      keywordId: String(row.id), active: Boolean(row.active), group: row.keyword_group || "",
      matchTypes: String(row.match_types || "").split(",").filter(Boolean), bid: sifTrafficAuditNumber(row.current_bid), dailyBudget: sifTrafficAuditNumber(row.daily_budget),
      last7Days: { impressions, clicks, spend, orders: Number(row.orders_count || 0), sales,
        ctr: impressions ? clicks / impressions : null, cpc: clicks ? spend / clicks : null,
        conversionRate: clicks ? Number(row.orders_count || 0) / clicks : null, acos: sales ? spend / sales : null }
    });
  }
  return output;
}

async function readSifTrafficAuditProductContext(targetAsin) {
  const catalog = await readAdsProductCatalog().catch(() => []);
  for (const parent of catalog) {
    const child = (parent.children || []).find(item => String(item.asin || "").toUpperCase() === targetAsin);
    if (child) return { parentAsin: parent.parentAsin || "", asin: targetAsin, internalName: child.internalName || "", title: child.title || "", category: "" };
  }
  return { parentAsin: "", asin: targetAsin, internalName: "", title: "", category: "" };
}

async function buildSifTrafficAuditInput(targetAsin, competitorAsins) {
  const profile = await requireSelectedAdsProfile();
  const credentials = await readAppSecret(SECRET_KEYS.sifCredentials);
  if (!credentials?.authorization) throw new Error("请先在关键词监控中授权 SIF 账户");
  const asins = [targetAsin, ...competitorAsins];
  const endDate = formatDateInTimeZone(new Date(), profile.timezone || US_MARKETPLACE_TIME_ZONE);
  const startDate = addDays(endDate, -6);
  const [sifResult, asinSummary, localKeywords, product] = await Promise.all([
    listSifTrafficAuditKeywords(credentials, asins),
    sifRequest("/api/search/compare/asinSummary", { searchValue: asins.join(","), sortBy: "", desc: true, showType: 1 }, credentials).catch(() => null),
    readSifTrafficAuditLocalKeywords(profile, targetAsin, startDate, endDate),
    readSifTrafficAuditProductContext(targetAsin)
  ]);
  const keywordUniverse = sifResult.keywords.map(item => {
    const keyword = String(item.keyword || "").trim();
    const normalizedKeyword = normalizeSifKeyword(keyword);
    const metricsByAsin = new Map((item.asins || []).map(value => [sifTrafficAuditAsin(value.asin), sifTrafficAuditAsinMetrics(value)]));
    const target = metricsByAsin.get(targetAsin) || { asin: targetAsin };
    return {
      keyword, normalizedKeyword, translation: String(item.translateKeyword || "").trim(),
      market: { searches: sifTrafficAuditNumber(item.estSearchesNum), abaRank: sifTrafficAuditNumber(item.searchesRank), estimatedSales: sifTrafficAuditNumber(item.saleNum), clickShare: sifTrafficAuditNumber(item.clickShared), conversionShare: sifTrafficAuditNumber(item.conversionShared), cpc: sifTrafficAuditCpc(item.cpc), competition: item.competition || null },
      target, competitors: competitorAsins.map(asin => metricsByAsin.get(asin) || { asin }),
      localAdvertising: localKeywords.get(normalizedKeyword) || { active: false },
      sourceTags: Array.isArray(target.keywordTags) ? target.keywordTags : []
    };
  }).filter(item => item.keyword);
  const recentStart = addDays(endDate, -6);
  const [recentRows] = await getMysqlPool().query(`
    SELECT id, output_payload, created_at FROM sif_traffic_audit_runs
    WHERE profile_id = ? AND target_asin = ? AND status = 'COMPLETE' AND created_at >= ?
    ORDER BY created_at DESC LIMIT 10
  `, [String(profile.profileId), targetAsin, `${recentStart} 00:00:00`]);
  const recentHistory = recentRows.map(row => {
    const output = parseMysqlJson(row.output_payload) || {};
    return {
      id: row.id,
      createdAt: row.created_at,
      summary: String(output.summary || "").trim().slice(0, 1200),
      recommendations: Array.isArray(output.recommendations) ? output.recommendations.map(item => ({
        keyword: String(item.keyword || "").trim(), action: String(item.action || "").trim(), strength: String(item.strength || "").trim(),
        conclusion: String(item.conclusion || "").trim().slice(0, 500), evidence: Array.isArray(item.evidence) ? item.evidence.map(value => String(value || "").trim()).filter(Boolean).slice(0, 4) : [],
        dataSnapshot: item.dataSnapshot && typeof item.dataSnapshot === "object" ? item.dataSnapshot : {}, risk: String(item.risk || "").trim().slice(0, 240),
        nextStep: String(item.nextStep || "").trim().slice(0, 240), confidence: sifTrafficAuditNumber(item.confidence), reviewDays: sifTrafficAuditNumber(item.reviewDays), status: "PENDING"
      })).slice(0, 10) : []
    };
  });
  return {
    context: { targetAsin, parentAsin: product.parentAsin, competitorAsins, countryCode: profile.countryCode || "US", currency: profile.currencyCode || "USD", generatedAt: new Date().toISOString(), localPerformanceRange: { startDate, endDate } },
    targetProduct: product,
    asinSummary: (asinSummary?.data?.asins || []).map(item => ({ asin: sifTrafficAuditAsin(item.asin), title: String(item.title || "").trim(), price: sifTrafficAuditNumber(item.price), rating: sifTrafficAuditNumber(item.star), ratingCount: sifTrafficAuditNumber(item.ratingNum), currentMonthBought: sifTrafficAuditNumber(item.boughtInCurrentMonth), flowRatios: { total: sifTrafficAuditNumber(item.nfScoreRatio), natural: sifTrafficAuditNumber(item.naturalRatio), ad: sifTrafficAuditNumber(item.adRatio) } })),
    keywordUniverse,
    recentAuditHistory: recentHistory,
    metadata: { totalSifKeywords: sifResult.total, localKeywordCount: localKeywords.size }
  };
}

function normalizeSifTrafficAuditOutput(value) {
  const source = value && typeof value === "object" ? value : {};
  const allowedActions = new Set(["ADD", "DROP", "SCALE"]);
  const allowedStrengths = new Set(["STRONG", "NORMAL"]);
  const recommendations = (Array.isArray(source.recommendations) ? source.recommendations : []).slice(0, 10).map(item => ({
    keyword: String(item?.keyword || "").trim().slice(0, 255), action: String(item?.action || "").toUpperCase(), strength: String(item?.strength || "").toUpperCase(),
    conclusion: String(item?.conclusion || "").trim().slice(0, 800), evidence: Array.isArray(item?.evidence) ? item.evidence.map(value => String(value || "").trim()).filter(Boolean).slice(0, 6) : [],
    dataSnapshot: item?.dataSnapshot && typeof item.dataSnapshot === "object" ? item.dataSnapshot : {}, risk: String(item?.risk || "").trim().slice(0, 500), nextStep: String(item?.nextStep || "").trim().slice(0, 500), confidence: Math.max(0, Math.min(1, Number(item?.confidence || 0))), reviewDays: Math.max(1, Math.min(30, Math.round(Number(item?.reviewDays || 7))))
  })).filter(item => item.keyword && allowedActions.has(item.action) && allowedStrengths.has(item.strength) && item.conclusion && item.evidence.length >= 2);
  if (!recommendations.length) throw new Error("AI 未返回有效的流量词总体检建议");
  return { summary: String(source.summary || "").trim().slice(0, 1600), recommendations };
}

async function runSifTrafficAudit(runId, input) {
  const pool = getMysqlPool();
  try {
    const auditPrompt = `你是 Amazon 流量词总体检分析器。只根据输入 JSON 判断，不得虚构数据。目标是从完整词池中每次选出 3 至 10 个下一阶段最值得处理的关键词，不能为了凑数输出建议。只允许动作 ADD（建议新增投放，必须当前未有效投放）、DROP（建议停止投放，必须当前有效投放）或 SCALE（建议扩大投放，必须当前有效投放）。每条建议标记 STRONG 或 NORMAL。判断必须综合产品匹配度、我方与竞品自然/SP 流量、搜索需求、竞争难度、以及本地近 7 天表现。recentAuditHistory 是过去 7 天的完整压缩诊断记录；必须比较当前数据和历史证据，说明建议为何延续、升级、降级或不再重复，避免机械重复同一建议。不要自动修改广告。

面向运营人员，用自然、通俗的中文写 summary、conclusion、evidence、risk 和 nextStep。任何可见句子都必须是“数据 + 中文含义/判断”，不能只罗列数据。

严禁在可见文本中输出 JSON 字段名、内部标签、数据路径或英文技术键名，例如 isAccurateTailKw、target/source/localAdvertising、market.searches、estimatedSales、clickShare、conversionShare、naturalRank、sponsoredRank、adShare、totalShare。也不要写“当前未有效投放，符合 ADD 条件”这种规则判断；应直接说“我们还没有实际投放这个词，因此可以先用小预算测试”。

所有数字必须翻译成运营表达并附带含义：575 搜索量写成“近期开约 575 次搜索，需求不高但仍有一定基础”；预估销量 1,403 写成“该词带动的市场销量约 1,403，具备转化机会”；点击份额 42.98%、转化份额 28.57% 写成“该词的点击和成交需求较集中”；自然/SP 排名写成“我们自然第 65 位、广告未上榜”；竞品写成“竞品 B0CGLRJFMW 自然和广告都在第 1 位，说明它已占据主要曝光”。份额、点击率、转化率最多保留一位百分比；CPC 写成“约 $0.46”；搜索量和销量用千位分隔。

每条 conclusion 用 1–2 句说清“为什么现在做”；每条 evidence 用 2–4 条完整、易懂的中文事实，并且每一条事实都要说明对该建议的意义。不要仅复述数据，必须解释数据意味着什么。

只返回 JSON：{"summary":"string","recommendations":[{"keyword":"string","action":"ADD|DROP|SCALE","strength":"STRONG|NORMAL","conclusion":"string","evidence":["至少两条、通俗中文且含具体数据事实"],"dataSnapshot":{},"risk":"string","nextStep":"string","confidence":0.0,"reviewDays":7}]}。`;
    const content = await callOpenAI([{ role: "system", content: auditPrompt }, { role: "user", content: JSON.stringify(input) }], true);
    if (!content) throw new Error("未配置 OPENAI_API_KEY，无法调用 AI 分析");
    const output = normalizeSifTrafficAuditOutput(JSON.parse(content));
    await pool.query("UPDATE sif_traffic_audit_runs SET status = 'COMPLETE', model_name = ?, output_payload = CAST(? AS JSON), completed_at = NOW() WHERE id = ?", [process.env.OPENAI_MODEL || "gpt-5.4", JSON.stringify(output), runId]);
  } catch (error) {
    await pool.query("UPDATE sif_traffic_audit_runs SET status = 'FAILED', last_error = ?, completed_at = NOW() WHERE id = ?", [error.message, runId]);
  } finally {
    sifTrafficAuditJobs.delete(runId);
  }
}

async function startSifTrafficAudit(body = {}) {
  const profile = await requireSelectedAdsProfile();
  const targetAsin = sifTrafficAuditAsin(body.asin);
  const competitorAsins = [...new Set((Array.isArray(body.competitorAsins) ? body.competitorAsins : []).map(sifTrafficAuditAsin).filter(Boolean))];
  if (!targetAsin) throw new Error("请选择要总体检的子 ASIN");
  if (!competitorAsins.length) throw new Error("至少添加 1 个对比 ASIN");
  if (competitorAsins.length > 10) throw new Error("最多添加 10 个对比 ASIN");
  if (competitorAsins.includes(targetAsin)) throw new Error("对比 ASIN 不能与当前子 ASIN 相同");
  const pool = getMysqlPool();
  const [runningRows] = await pool.query("SELECT id FROM sif_traffic_audit_runs WHERE profile_id = ? AND target_asin = ? AND status = 'RUNNING' ORDER BY created_at DESC LIMIT 1", [String(profile.profileId), targetAsin]);
  if (runningRows[0]) return { id: runningRows[0].id, status: "RUNNING", reused: true };
  const input = await buildSifTrafficAuditInput(targetAsin, competitorAsins);
  const runId = randomUUID();
  await pool.query(`
    INSERT INTO sif_traffic_audit_runs (id, profile_id, country_code, parent_asin, target_asin, competitor_asins, status, input_payload)
    VALUES (?, ?, ?, ?, ?, CAST(? AS JSON), 'RUNNING', CAST(? AS JSON))
  `, [runId, String(profile.profileId), input.context.countryCode, input.context.parentAsin || "", targetAsin, JSON.stringify(competitorAsins), JSON.stringify(input)]);
  const job = runSifTrafficAudit(runId, input);
  sifTrafficAuditJobs.set(runId, job);
  return { id: runId, status: "RUNNING" };
}

async function readSifTrafficAuditState(asin) {
  const profile = await requireSelectedAdsProfile();
  const targetAsin = sifTrafficAuditAsin(asin);
  if (!targetAsin) return { targetAsin: "", latestRun: null, history: [] };
  const [rows] = await getMysqlPool().query(`
    SELECT * FROM sif_traffic_audit_runs WHERE profile_id = ? AND target_asin = ? ORDER BY created_at DESC LIMIT 20
  `, [String(profile.profileId), targetAsin]);
  const normalize = row => ({ id: row.id, status: row.status, targetAsin: row.target_asin, competitorAsins: parseMysqlJson(row.competitor_asins) || [], output: parseMysqlJson(row.output_payload), error: row.last_error || "", createdAt: row.created_at, completedAt: row.completed_at });
  const runs = rows.map(normalize);
  return { targetAsin, latestRun: runs[0] || null, history: runs.slice(1) };
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
  return readAppSecret(SECRET_KEYS.gmailToken, GMAIL_TOKEN_PATH);
}

async function writeGmailToken(token) {
  await writeAppSecret(SECRET_KEYS.gmailToken, token);
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
  return readAppSecret(SECRET_KEYS.adsToken, ADS_TOKEN_PATH);
}

async function writeAdsToken(token) {
  await writeAppSecret(SECRET_KEYS.adsToken, token);
}

async function readAdsProfileSelection() {
  return readAppSecret(SECRET_KEYS.adsProfile, ADS_PROFILE_PATH);
}

async function writeAdsProfileSelection(profile) {
  await writeAppSecret(SECRET_KEYS.adsProfile, profile);
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

function adsArrayPayload(value, keys = []) {
  if (Array.isArray(value)) return value;
  for (const key of keys) {
    if (Array.isArray(value?.[key])) return value[key];
  }
  return [];
}

function normalizeAdsPortfolio(item = {}) {
  return {
    portfolioId: String(item.portfolioId || item.portfolio?.portfolioId || ""),
    name: String(item.name || item.portfolio?.name || ""),
    state: String(item.state || item.portfolio?.state || ""),
    budget: item.budget || item.portfolio?.budget || null
  };
}

function normalizeAdsCampaignObject(item = {}) {
  return {
    campaignId: String(item.campaignId || item.campaign?.campaignId || ""),
    portfolioId: String(item.portfolioId || item.campaign?.portfolioId || ""),
    name: String(item.name || item.campaign?.name || ""),
    state: String(item.state || item.campaign?.state || ""),
    campaignType: String(item.campaignType || item.campaign?.campaignType || "")
  };
}

async function requireSelectedAdsProfile() {
  const profile = await readAdsProfileSelection();
  if (!profile?.profileId) throw new Error("请先选择 Amazon Ads Profile");
  return profile;
}

async function readManagedAdsPortfolio(profileId) {
  await ensureAppMysqlSchema();
  const pool = getMysqlPool();
  const [rows] = await pool.query("SELECT * FROM ads_managed_portfolios WHERE profile_id = ?", [String(profileId)]);
  const row = rows[0];
  if (!row) return null;
  return {
    profileId: String(row.profile_id),
    portfolioId: String(row.portfolio_id || ""),
    name: String(row.portfolio_name || ADS_MANAGED_PORTFOLIO_NAME),
    countryCode: String(row.country_code || ""),
    currencyCode: String(row.currency_code || ""),
    timezone: String(row.timezone || ""),
    status: String(row.management_status || "UNVERIFIED"),
    conflictingObjectCount: Number(row.conflicting_object_count || 0),
    error: String(row.last_error || ""),
    verifiedAt: row.verified_at || null
  };
}

async function writeManagedAdsPortfolio(profile, portfolio, status, conflictCount = 0, error = "") {
  const pool = getMysqlPool();
  await pool.query(`
    INSERT INTO ads_managed_portfolios (
      profile_id, portfolio_id, portfolio_name, country_code, currency_code, timezone,
      management_status, conflicting_object_count, last_error, verified_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
    ON DUPLICATE KEY UPDATE
      portfolio_id = VALUES(portfolio_id), portfolio_name = VALUES(portfolio_name),
      country_code = VALUES(country_code), currency_code = VALUES(currency_code), timezone = VALUES(timezone),
      management_status = VALUES(management_status), conflicting_object_count = VALUES(conflicting_object_count),
      last_error = VALUES(last_error), verified_at = VALUES(verified_at)
  `, [
    String(profile.profileId), portfolio?.portfolioId || null, ADS_MANAGED_PORTFOLIO_NAME,
    profile.countryCode || "", profile.currencyCode || "", profile.timezone || "",
    status, Number(conflictCount || 0), error || null
  ]);
  return readManagedAdsPortfolio(profile.profileId);
}

async function listAdsPortfoliosForSelectedProfile() {
  const attempts = [
    () => adsFetch("/portfolios/list", {}, {
      requireProfile: true,
      method: "POST",
      headers: {
        accept: "application/vnd.portfolio.v3+json",
        "content-type": "application/vnd.portfolio.v3+json"
      },
      body: { maxResults: 100 }
    }),
    () => adsFetch("/v2/portfolios", {}, { requireProfile: true }),
    () => adsFetch("/portfolios", {}, { requireProfile: true })
  ];
  let lastError = null;
  for (const attempt of attempts) {
    try {
      const data = await attempt();
      return adsArrayPayload(data, ["portfolios", "success"]).map(normalizeAdsPortfolio).filter(item => item.portfolioId);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Amazon Ads Portfolio 读取失败");
}

async function listPortfolioCampaigns(portfolioId) {
  try {
    const data = await adsFetch("/v2/sp/campaigns", {
      portfolioIdFilter: portfolioId,
      stateFilter: "enabled,paused,archived"
    }, { requireProfile: true });
    return adsArrayPayload(data, ["campaigns", "success"]).map(normalizeAdsCampaignObject)
      .filter(item => item.campaignId && item.portfolioId === String(portfolioId));
  } catch (legacyError) {
    const data = await adsFetch("/sp/campaigns/list", {}, {
      requireProfile: true,
      method: "POST",
      headers: {
        accept: "application/vnd.spCampaign.v3+json",
        "content-type": "application/vnd.spCampaign.v3+json"
      },
      body: { portfolioIdFilter: { include: [String(portfolioId)] }, maxResults: 100 }
    });
    const campaigns = adsArrayPayload(data, ["campaigns", "success"]).map(normalizeAdsCampaignObject)
      .filter(item => item.campaignId && item.portfolioId === String(portfolioId));
    if (!campaigns.length && data?.error) throw legacyError;
    return campaigns;
  }
}

async function refreshManagedAdsPortfolio() {
  const profile = await requireSelectedAdsProfile();
  const portfolios = await listAdsPortfoliosForSelectedProfile();
  const exact = portfolios.filter(item => item.name === ADS_MANAGED_PORTFOLIO_NAME);
  if (!exact.length) {
    return writeManagedAdsPortfolio(profile, null, "MISSING", 0, "广告组合不存在，需要预览并确认后创建");
  }
  if (exact.length > 1) {
    return writeManagedAdsPortfolio(profile, null, "CONFLICT", exact.length, `发现 ${exact.length} 个同名广告组合，请先在 Amazon 后台保留唯一的 ${ADS_MANAGED_PORTFOLIO_NAME}`);
  }
  const portfolio = exact[0];
  const remoteCampaigns = await listPortfolioCampaigns(portfolio.portfolioId);
  const pool = getMysqlPool();
  const [knownRows] = await pool.query(
    "SELECT amazon_campaign_id FROM ads_campaigns WHERE profile_id = ? AND portfolio_id = ? AND amazon_campaign_id IS NOT NULL",
    [String(profile.profileId), String(portfolio.portfolioId)]
  );
  const known = new Set(knownRows.map(row => String(row.amazon_campaign_id)));
  const unknown = remoteCampaigns.filter(item => !known.has(item.campaignId));
  if (unknown.length) {
    const preview = unknown.slice(0, 3).map(item => item.name || item.campaignId).join("、");
    return writeManagedAdsPortfolio(
      profile,
      portfolio,
      "MANUAL_OBJECTS_FOUND",
      unknown.length,
      `发现 ${unknown.length} 个非本系统创建的 Campaign：${preview}${unknown.length > 3 ? "…" : ""}。请先在 Amazon 后台删除后再刷新。`
    );
  }
  return writeManagedAdsPortfolio(profile, portfolio, "READY", 0, "");
}

function normalizeAdsKeywordText(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function adsKeywordGroup(value) {
  const group = String(value || "NORMAL").toUpperCase();
  return ["NORMAL", "PROMOTED", "STABLE"].includes(group) ? group : "NORMAL";
}

function safeAdsNamePart(value) {
  return String(value || "").trim().replace(/__+/g, "_").replace(/[\r\n\t]+/g, " ");
}

function adsGroupNameLabel(group) {
  return { NORMAL: "普通", PROMOTED: "主推", STABLE: "已稳定" }[adsKeywordGroup(group)];
}

function newAdsCreationBatch(date = new Date()) {
  return date.toISOString().replace(/[-:.]/g, "").replace("Z", "").replace("T", "T").slice(0, 19) + "Z";
}

function adsActiveKeywordScopeKey(profileId, parentAsin, normalizedKeyword, childAsin = "") {
  return `${String(profileId)}|${String(parentAsin).toUpperCase()}|${String(normalizedKeyword)}|${String(childAsin).toUpperCase()}`;
}

function adsCampaignEntityKey(parentAsin, childAsin, creationBatch, matchType) {
  return `PARENT-${String(parentAsin).toUpperCase()}|ASIN-${String(childAsin).toUpperCase()}|TS-${creationBatch}|SP|${String(matchType).toUpperCase()}`;
}

function adsAdUnitEntityKey(childAsin, creationBatch, matchType) {
  return `ASIN-${String(childAsin).toUpperCase()}|TS-${creationBatch}|SP|${String(matchType).toUpperCase()}`;
}

function buildAdsCampaignName(internalName, parentAsin, childAsin, keyword, group, matchType, creationBatch = "") {
  const identity = creationBatch ? `__PARENT-${String(parentAsin).toUpperCase()}__ASIN-${String(childAsin).toUpperCase()}` : "";
  const timestamp = creationBatch ? `__TS-${creationBatch}` : "";
  const suffix = `__${adsGroupNameLabel(group)}__SP__${String(matchType).toUpperCase()}${timestamp}`;
  const prefix = `ERP__${safeAdsNamePart(internalName) || "Product"}${identity}__`;
  const available = Math.max(12, 255 - prefix.length - suffix.length);
  return `${prefix}${safeAdsNamePart(keyword).slice(0, available)}${suffix}`;
}

function buildAdsAdGroupName(campaignName, childAsin, options = {}) {
  if (options.creationBatch) {
    const prefix = `ERP__${safeAdsNamePart(options.internalName) || "Product"}__PARENT-${String(options.parentAsin).toUpperCase()}__`;
    const suffix = `__${adsGroupNameLabel(options.group)}__SP__${String(options.matchType).toUpperCase()}__ASIN-${String(childAsin || "").toUpperCase()}__TS-${options.creationBatch}`;
    const available = Math.max(12, 255 - prefix.length - suffix.length);
    return `${prefix}${safeAdsNamePart(options.keyword).slice(0, available)}${suffix}`;
  }
  const suffix = `__ASIN-${String(childAsin || "").toUpperCase()}`;
  return `${String(campaignName).slice(0, Math.max(1, 255 - suffix.length))}${suffix}`;
}

async function readAdsProductCatalog() {
  const endDate = formatDateInTimeZone();
  const startDate = addDays(endDate, -29);
  const view = await buildFbaInventoryView(startDate, endDate);
  const parentMetadata = await readParentAsinMetadataRows();
  const metadataByParent = new Map(parentMetadata.map(item => [item.parentAsin, item]));
  const factoryInfoByAsin = buildFactoryInfoByAsin(await readDb());
  const byParent = new Map();
  for (const row of view.rows || []) {
    if (!row.asin || !row.sellerSku) continue;
    const parentAsin = String(row.parentAsin || row.asin).toUpperCase();
    const metadata = metadataByParent.get(parentAsin);
    const parentInternalName = String(metadata?.internalName || "").trim();
    if (!parentInternalName) continue;
    const childAsin = String(row.asin).toUpperCase();
    const factoryInfo = factoryInfoByAsin.get(childAsin);
    const latestInventory = row.latestRealtimeInventory && typeof row.latestRealtimeInventory === "object"
      ? row.latestRealtimeInventory
      : null;
    const totalGoodsQuantity = latestInventory?.totalGoodsQuantity !== null && latestInventory?.totalGoodsQuantity !== undefined
      ? Number(latestInventory.totalGoodsQuantity || 0)
      : (row.totalGoodsQuantity === null || row.totalGoodsQuantity === undefined ? null : Number(row.totalGoodsQuantity || 0));
    const item = byParent.get(parentAsin) || {
      parentAsin,
      internalName: parentInternalName,
      sortOrder: Number(metadata?.sortOrder || 0),
      children: []
    };
    item.children.push({
      asin: childAsin,
      sellerSku: String(row.sellerSku),
      internalName: String(factoryInfo?.name || row.factoryName || "").trim(),
      title: row.title || "",
      imageUrl: row.imageUrl || "",
      totalGoodsQuantity,
      fulfillableQuantity: latestInventory
        ? Number(latestInventory.fulfillableQuantity || 0)
        : (row.inventoryCompleteness === "missing" ? null : Number(row.fulfillableQuantity || 0)),
      inventoryDate: latestInventory?.date || row.inventoryDate || "",
      dailySales: Number(row.dailySales || 0),
      salesUnits: Number(row.salesUnits || 0),
      recommended: false
    });
    byParent.set(parentAsin, item);
  }
  const metricValue = value => {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };
  const topByMetric = (rows, getter) => {
    let maxValue = null;
    const winners = [];
    for (const row of rows) {
      const value = metricValue(getter(row));
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
  };
  const pickSkuRowsForAsin = rows => {
    if (rows.length <= 1) return rows;
    const totalTop = topByMetric(rows, row => row.totalGoodsQuantity);
    if (totalTop.hasMetric) {
      if (totalTop.winners.length === 1) return totalTop.winners;
      const salesTop = topByMetric(totalTop.winners, row => row.dailySales);
      return salesTop.hasMetric && salesTop.winners.length === 1 ? salesTop.winners : totalTop.winners;
    }
    const salesTop = topByMetric(rows, row => row.dailySales);
    return salesTop.hasMetric && salesTop.winners.length === 1 ? salesTop.winners : rows;
  };
  return [...byParent.values()].map(item => {
    const childrenByAsin = new Map();
    for (const child of item.children) {
      if (!childrenByAsin.has(child.asin)) childrenByAsin.set(child.asin, []);
      childrenByAsin.get(child.asin).push(child);
    }
    const children = [...childrenByAsin.values()]
      .flatMap(rows => pickSkuRowsForAsin(rows).map(row => ({ ...row, recommended: true })))
      .sort((a, b) => b.dailySales - a.dailySales || Number(b.totalGoodsQuantity || 0) - Number(a.totalGoodsQuantity || 0) || a.asin.localeCompare(b.asin));
    return { ...item, children };
  }).sort((a, b) => {
    const aOrder = Number(a.sortOrder || 0);
    const bOrder = Number(b.sortOrder || 0);
    if (aOrder > 0 || bOrder > 0) {
      if (aOrder <= 0) return 1;
      if (bOrder <= 0) return -1;
      if (aOrder !== bOrder) return aOrder - bOrder;
    }
    return a.internalName.localeCompare(b.internalName, "zh-Hans-CN");
  });
}

function adsDateValue(value) {
  if (!value) return "";
  if (typeof value === "string") return value.slice(0, 10);
  const date = new Date(value);
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

async function readAdsWorkspace(startDate = "", endDate = "") {
  const profile = await requireSelectedAdsProfile();
  const safeEnd = (endDate || formatDateInTimeZone()).slice(0, 10);
  const safeStart = (startDate || addDays(safeEnd, -29)).slice(0, 10);
  const pool = getMysqlPool();
  const [keywordRows] = await pool.query("SELECT * FROM ads_keywords WHERE profile_id = ? AND lifecycle_status IN ('ACTIVE', 'CREATING', 'STOPPING', 'STOPPED') ORDER BY sort_order ASC, updated_at DESC, id DESC", [String(profile.profileId)]);
  const keywordIds = keywordRows.map(row => row.id);
  let campaignRows = [];
  let adUnitRows = [];
  let performanceRows = [];
  let placementRows = [];
  let aiSuggestionRows = [];
  let aiLatestRecommendationRows = [];
  let aiGoalRows = [];
  let aiRunRows = [];
  if (keywordIds.length) {
    [aiSuggestionRows] = await pool.query(`
      SELECT keyword_id, COUNT(*) suggestion_count
      FROM ads_ai_recommendations
      WHERE keyword_id IN (?) AND profile_id = ? AND status = 'PENDING'
        AND action_type NOT IN ('REQUEST_MORE_DATA', 'NO_ACTION')
      GROUP BY keyword_id
    `, [keywordIds, String(profile.profileId)]);
    [aiLatestRecommendationRows] = await pool.query(`
      SELECT keyword_id, action_type, reason_text, status
      FROM ads_ai_recommendations
      WHERE keyword_id IN (?) AND profile_id = ?
      ORDER BY created_at DESC, id DESC
    `, [keywordIds, String(profile.profileId)]);
    [aiGoalRows] = await pool.query(`
      SELECT keyword_id, goal_text
      FROM ads_ai_keyword_goals
      WHERE keyword_id IN (?) AND profile_id = ?
    `, [keywordIds, String(profile.profileId)]);
    [aiRunRows] = await pool.query(`
      SELECT r.keyword_id, r.status, r.output_payload, r.completed_at, k.parent_asin
      FROM ads_ai_analysis_runs r
      JOIN ads_keywords k ON k.id = r.keyword_id
      WHERE r.keyword_id IN (?) AND r.profile_id = ?
      ORDER BY r.created_at DESC, r.id DESC
    `, [keywordIds, String(profile.profileId)]);
    [campaignRows] = await pool.query("SELECT * FROM ads_campaigns WHERE keyword_id IN (?) ORDER BY match_type", [keywordIds]);
    const campaignIds = campaignRows.map(row => row.id);
    if (campaignIds.length) {
      [adUnitRows] = await pool.query("SELECT * FROM ads_ad_units WHERE campaign_id IN (?) ORDER BY child_asin", [campaignIds]);
      [placementRows] = await pool.query(`
        SELECT campaign_id, placement, SUM(impressions) impressions, SUM(clicks) clicks,
          SUM(spend) spend, SUM(orders_count) orders_count, SUM(units_sold) units_sold, SUM(sales) sales
        FROM ads_placement_performance_daily WHERE campaign_id IN (?) AND date BETWEEN ? AND ?
        GROUP BY campaign_id, placement
      `, [campaignIds, safeStart, safeEnd]);
    }
    const adUnitIds = adUnitRows.map(row => row.id);
    if (adUnitIds.length) {
      [performanceRows] = await pool.query(`
        SELECT ad_unit_id, SUM(impressions) impressions, SUM(clicks) clicks, SUM(spend) spend,
          SUM(orders_count) orders_count, SUM(units_sold) units_sold, SUM(sales) sales
        FROM ads_performance_daily WHERE ad_unit_id IN (?) AND date BETWEEN ? AND ? GROUP BY ad_unit_id
      `, [adUnitIds, safeStart, safeEnd]);
    }
  }
  const aiSuggestionCountByKeyword = new Map(aiSuggestionRows.map(row => [String(row.keyword_id), Number(row.suggestion_count || 0)]));
  const aiLatestRecommendationByKeyword = new Map();
  for (const row of aiLatestRecommendationRows) {
    const key = String(row.keyword_id);
    if (!aiLatestRecommendationByKeyword.has(key)) {
      aiLatestRecommendationByKeyword.set(key, { actionType: row.action_type, reason: row.reason_text || "", status: row.status });
    }
  }
  const aiGoalByKeyword = new Map(aiGoalRows.map(row => [String(row.keyword_id), String(row.goal_text || "").trim()]));
  const aiSummaryByKeyword = new Map();
  const aiLatestStatusByKeyword = new Map();
  for (const row of aiRunRows) {
    const key = String(row.keyword_id);
    if (!aiLatestStatusByKeyword.has(key)) aiLatestStatusByKeyword.set(key, row.status);
    if (row.status !== "COMPLETE" || aiSummaryByKeyword.has(key)) continue;
    const output = parseMysqlJson(row.output_payload) || {};
    const summary = String(output.analysisSummary || "").trim();
    if (summary) aiSummaryByKeyword.set(key, summary.slice(0, 240));
  }
  for (const [key, status] of aiLatestStatusByKeyword) {
    if (status === "RUNNING") aiSummaryByKeyword.set(key, "AI 正在分析中…");
  }
  const aiAsinGuardByParent = new Map();
  const cooldownMinutes = adsAiAsinCooldownMinutes();
  const cooldownStart = Date.now() - cooldownMinutes * 60 * 1000;
  for (const row of aiRunRows) {
    const parentAsin = String(row.parent_asin || "");
    if (!parentAsin || aiAsinGuardByParent.get(parentAsin) === "RUNNING") continue;
    if (row.status === "RUNNING") aiAsinGuardByParent.set(parentAsin, "RUNNING");
    else if (row.status === "COMPLETE" && new Date(row.completed_at).getTime() >= cooldownStart) aiAsinGuardByParent.set(parentAsin, "COOLDOWN");
  }
  const metricsByAdUnit = new Map(performanceRows.map(row => [String(row.ad_unit_id), {
    impressions: Number(row.impressions || 0), clicks: Number(row.clicks || 0), spend: Number(row.spend || 0),
    orders: Number(row.orders_count || 0), units: Number(row.units_sold || 0), sales: Number(row.sales || 0)
  }]));
  const placementsByCampaign = new Map();
  for (const row of placementRows) {
    const key = String(row.campaign_id);
    const list = placementsByCampaign.get(key) || [];
    list.push({ placement: row.placement, impressions: Number(row.impressions || 0), clicks: Number(row.clicks || 0), spend: Number(row.spend || 0), orders: Number(row.orders_count || 0), units: Number(row.units_sold || 0), sales: Number(row.sales || 0) });
    placementsByCampaign.set(key, list);
  }
  const unitsByCampaign = new Map();
  for (const row of adUnitRows) {
    const metrics = metricsByAdUnit.get(String(row.id)) || { impressions: 0, clicks: 0, spend: 0, orders: 0, units: 0, sales: 0 };
    const unit = {
      id: String(row.id), childAsin: row.child_asin, sellerSku: row.seller_sku,
      creationBatch: row.creation_batch || "", entityKey: row.entity_key || "",
      name: row.ad_group_name, amazonName: row.amazon_ad_group_name || "", bid: Number(row.bid || 0),
      desiredState: row.desired_state, amazonState: row.amazon_state || "", lifecycleStatus: row.lifecycle_status,
      creationStatus: row.creation_status, syncStatus: row.sync_status, failedStep: row.failed_step || "", error: row.last_error || "",
      amazonAdGroupId: row.amazon_ad_group_id || "", amazonProductAdId: row.amazon_product_ad_id || "", amazonTargetId: row.amazon_target_id || "",
      metrics: { ...metrics, acos: metrics.sales > 0 ? metrics.spend / metrics.sales : null }
    };
    const list = unitsByCampaign.get(String(row.campaign_id)) || [];
    list.push(unit);
    unitsByCampaign.set(String(row.campaign_id), list);
  }
  const campaignsByKeyword = new Map();
  for (const row of campaignRows) {
    const units = unitsByCampaign.get(String(row.id)) || [];
    const metrics = units.reduce((acc, unit) => {
      for (const key of ["impressions", "clicks", "spend", "orders", "units", "sales"]) acc[key] += Number(unit.metrics[key] || 0);
      return acc;
    }, { impressions: 0, clicks: 0, spend: 0, orders: 0, units: 0, sales: 0 });
    metrics.acos = metrics.sales > 0 ? metrics.spend / metrics.sales : null;
    const campaign = {
      id: String(row.id), adType: row.ad_type, matchType: row.match_type, amazonCampaignId: row.amazon_campaign_id || "",
      childAsin: row.child_asin || units[0]?.childAsin || "", sellerSku: row.seller_sku || units[0]?.sellerSku || "",
      creationBatch: row.creation_batch || "", entityKey: row.entity_key || "",
      name: row.campaign_name, amazonName: row.amazon_campaign_name || "", desiredState: row.desired_state, lifecycleStatus: row.lifecycle_status || "ACTIVE",
      stoppedAt: row.stopped_at || (row.lifecycle_status === "STOPPED" ? row.updated_at : null),
      amazonState: row.amazon_state || "", dailyBudget: Number(row.daily_budget || 0), biddingStrategy: row.bidding_strategy,
      topOfSearchAdjustment: Number(row.top_of_search_adjustment || 0), restOfSearchAdjustment: Number(row.rest_of_search_adjustment || 0), productPageAdjustment: Number(row.product_page_adjustment || 0),
      startDate: adsDateValue(row.start_date), endDate: adsDateValue(row.end_date),
      creationStatus: row.creation_status, syncStatus: row.sync_status, failedStep: row.failed_step || "", error: row.last_error || "",
      metrics, units, placements: placementsByCampaign.get(String(row.id)) || []
    };
    const list = campaignsByKeyword.get(String(row.keyword_id)) || [];
    list.push(campaign);
    campaignsByKeyword.set(String(row.keyword_id), list);
  }
  const monitorAsins = [...new Set(adUnitRows.map(row => String(row.child_asin || "").toUpperCase()).filter(Boolean))];
  let monitorRows = [];
  if (monitorAsins.length) {
    [monitorRows] = await pool.query(`
      SELECT asin, normalized_keyword, monitor_status, last_synced_at, last_error
      FROM sif_keyword_monitors
      WHERE country_code = ? AND asin IN (?)
    `, [String(profile.countryCode || "US").toUpperCase(), monitorAsins]);
  }
  const bidByKey = new Map();
  if (monitorAsins.length) {
    const [bidRows] = await pool.query(`
      SELECT m.asin, m.normalized_keyword, b.*
      FROM sif_keyword_monitors m
      JOIN sif_keyword_bid_daily b ON b.monitor_id = m.id
      JOIN (
        SELECT monitor_id, MAX(date) max_date
        FROM sif_keyword_bid_daily
        GROUP BY monitor_id
      ) latest ON latest.monitor_id = b.monitor_id AND latest.max_date = b.date
      WHERE m.country_code = ? AND m.asin IN (?)
    `, [String(profile.countryCode || "US").toUpperCase(), monitorAsins]);
    const price = value => value === null || value === undefined ? null : Number(value);
    for (const row of bidRows) {
      bidByKey.set(`${String(row.asin).toUpperCase()}|${row.normalized_keyword}`, {
        date: adsDateValue(row.date), mode: row.bid_mode || "legacy", matchStatus: row.match_status || "MATCHED",
        categorySource: row.category_source || "CHILD", categoryId: row.category_id || "", categoryName: row.category_name || "",
        productCount: row.category_product_count === null ? null : Number(row.category_product_count),
        exact: { start: price(row.exact_start), median: price(row.exact_median), end: price(row.exact_end) },
        phrase: { start: price(row.phrase_start), median: price(row.phrase_median), end: price(row.phrase_end) },
        broad: { start: price(row.broad_start), median: price(row.broad_median), end: price(row.broad_end) }
      });
    }
  }
  const monitorByKey = new Map(monitorRows.map(row => [`${String(row.asin).toUpperCase()}|${row.normalized_keyword}`, row]));
  const keywords = keywordRows.map(row => {
    const campaigns = campaignsByKeyword.get(String(row.id)) || [];
    const metrics = campaigns.reduce((acc, campaign) => {
      for (const key of ["impressions", "clicks", "spend", "orders", "units", "sales"]) acc[key] += Number(campaign.metrics[key] || 0);
      return acc;
    }, { impressions: 0, clicks: 0, spend: 0, orders: 0, units: 0, sales: 0 });
    metrics.acos = metrics.sales > 0 ? metrics.spend / metrics.sales : null;
    const childAsins = [...new Set(campaigns.flatMap(campaign => campaign.units.map(unit => unit.childAsin)).filter(Boolean))];
    const monitoring = childAsins.map(asin => {
      const monitor = monitorByKey.get(`${String(asin).toUpperCase()}|${normalizeSifKeyword(row.keyword_text)}`);
      return { asin, status: monitor?.monitor_status || "INACTIVE", lastSyncedAt: monitor?.last_synced_at || null, error: monitor?.last_error || "", fixedBid: bidByKey.get(`${String(asin).toUpperCase()}|${normalizeSifKeyword(row.keyword_text)}`) || null };
    });
    const monitorStatus = monitoring.length && monitoring.every(item => item.status === "ACTIVE")
      ? "ACTIVE" : monitoring.some(item => item.status === "ACTIVE") ? "PARTIAL" : "INACTIVE";
    const keywordKey = String(row.id);
    const latestRecommendation = aiLatestRecommendationByKeyword.get(keywordKey) || null;
    const asinGuard = aiAsinGuardByParent.get(String(row.parent_asin || ""));
    const aiAnalysisSummary = asinGuard === "RUNNING" ? "AI 正在分析中…"
      : asinGuard === "COOLDOWN" ? "AI 分析冷却中…"
      : aiSummaryByKeyword.get(keywordKey) || "";
    return { id: keywordKey, parentAsin: row.parent_asin, keyword: row.keyword_text, group: row.keyword_group, sortOrder: Number(row.sort_order || 0), lifecycleStatus: row.lifecycle_status, stoppedAt: row.stopped_at || (row.lifecycle_status === "STOPPED" ? row.updated_at : null), creationBatch: row.creation_batch || "", metrics, campaigns, monitoring, monitorStatus, aiSuggestionCount: aiSuggestionCountByKeyword.get(keywordKey) || 0, aiGoalSet: Boolean(aiGoalByKeyword.get(keywordKey)), aiAnalysisSummary, aiSuggestionAction: latestRecommendation?.actionType || "", aiSuggestionReason: latestRecommendation?.reason || "" };
  });
  return {
    profile,
    portfolio: await readManagedAdsPortfolio(profile.profileId),
    range: { startDate: safeStart, endDate: safeEnd },
    products: await readAdsProductCatalog(),
    keywords
  };
}

async function readAdsKeywordHistory(keywordId, filters = {}) {
  const profile = await requireSelectedAdsProfile();
  const pool = getMysqlPool();
  const [keywordRows] = await pool.query(`
    SELECT id, parent_asin, keyword_text
    FROM ads_keywords
    WHERE id = ? AND profile_id = ? AND lifecycle_status = 'ACTIVE'
  `, [keywordId, String(profile.profileId)]);
  const keyword = keywordRows[0];
  if (!keyword) throw new Error("关键词不存在");

  const defaultEnd = formatDateInTimeZone(new Date(), profile.timezone || US_MARKETPLACE_TIME_ZONE);
  const endDate = /^\d{4}-\d{2}-\d{2}$/.test(String(filters.endDate || "")) ? String(filters.endDate) : defaultEnd;
  const startDate = /^\d{4}-\d{2}-\d{2}$/.test(String(filters.startDate || "")) ? String(filters.startDate) : addDays(endDate, -29);
  if (startDate > endDate) throw new Error("历史数据开始日期不能晚于结束日期");
  const dates = dateRangeInclusive(startDate, endDate);
  if (dates.length > 366) throw new Error("单次最多查询 366 天历史数据");

  const [optionRows] = await pool.query(`
    SELECT DISTINCT c.match_type, u.child_asin, u.seller_sku
    FROM ads_campaigns c
    JOIN ads_ad_units u ON u.campaign_id = c.id
    WHERE c.keyword_id = ? AND c.profile_id = ?
    ORDER BY u.child_asin, c.match_type
  `, [keywordId, String(profile.profileId)]);
  const availableAsins = [...new Map(optionRows.map(row => [row.child_asin, {
    asin: row.child_asin,
    sellerSku: row.seller_sku
  }])).values()];
  const availableMatchTypes = [...new Set(optionRows.map(row => row.match_type))]
    .sort((a, b) => ["EXACT", "PHRASE", "BROAD"].indexOf(a) - ["EXACT", "PHRASE", "BROAD"].indexOf(b));
  const childAsin = availableAsins.some(item => item.asin === String(filters.childAsin || "").toUpperCase())
    ? String(filters.childAsin).toUpperCase() : "ALL";
  const requestedMatchType = String(filters.matchType || "").toUpperCase();
  const matchType = availableMatchTypes.includes(requestedMatchType) ? requestedMatchType : "ALL";
  const rankAsins = childAsin === "ALL" ? availableAsins.map(item => item.asin) : [childAsin];
  let rankRows = [];
  if (rankAsins.length) {
    [rankRows] = await pool.query(`
      SELECT d.date, MIN(d.natural_rank) natural_rank, MIN(d.sp_rank) sp_rank
      FROM sif_keyword_rank_daily d
      JOIN sif_keyword_monitors m ON m.id = d.monitor_id
      WHERE m.country_code = ? AND m.normalized_keyword = ? AND m.asin IN (?)
        AND d.date BETWEEN ? AND ?
      GROUP BY d.date ORDER BY d.date
    `, [String(profile.countryCode || "US").toUpperCase(), normalizeSifKeyword(keyword.keyword_text), rankAsins, startDate, endDate]);
  }
  const where = ["c.keyword_id = ?", "c.profile_id = ?", "p.date BETWEEN ? AND ?"];
  const params = [keywordId, String(profile.profileId), startDate, endDate];
  if (childAsin !== "ALL") {
    where.push("u.child_asin = ?");
    params.push(childAsin);
  }
  if (matchType !== "ALL") {
    where.push("c.match_type = ?");
    params.push(matchType);
  }
  const [performanceRows] = await pool.query(`
    SELECT p.date, SUM(p.impressions) impressions, SUM(p.clicks) clicks, SUM(p.spend) spend,
      SUM(p.orders_count) orders_count, SUM(p.units_sold) units_sold, SUM(p.sales) sales
    FROM ads_performance_daily p
    JOIN ads_ad_units u ON u.id = p.ad_unit_id
    JOIN ads_campaigns c ON c.id = u.campaign_id
    WHERE ${where.join(" AND ")}
    GROUP BY p.date
    ORDER BY p.date
  `, params);
  // 展示位置是 Campaign 级日报表；按当前子 ASIN / 策略筛出对应 Campaign 后再汇总，
  // 不与 Ad Group 联表，避免一个 Campaign 下多个商品时重复累计。
  const placementWhere = ["c.keyword_id = ?", "c.profile_id = ?", "p.date BETWEEN ? AND ?"];
  const placementParams = [keywordId, String(profile.profileId), startDate, endDate];
  if (childAsin !== "ALL") {
    placementWhere.push("EXISTS (SELECT 1 FROM ads_ad_units u WHERE u.campaign_id = c.id AND u.child_asin = ?)");
    placementParams.push(childAsin);
  }
  if (matchType !== "ALL") {
    placementWhere.push("c.match_type = ?");
    placementParams.push(matchType);
  }
  const [placementPerformanceRows] = await pool.query(`
    SELECT p.date, p.placement, SUM(p.impressions) impressions, SUM(p.clicks) clicks, SUM(p.spend) spend,
      SUM(p.orders_count) orders_count, SUM(p.units_sold) units_sold, SUM(p.sales) sales
    FROM ads_placement_performance_daily p
    JOIN ads_campaigns c ON c.id = p.campaign_id
    WHERE ${placementWhere.join(" AND ")}
    GROUP BY p.date, p.placement
    ORDER BY p.date
  `, placementParams);
  const settingWhere = ["c.keyword_id = ?", "c.profile_id = ?", "s.date BETWEEN ? AND ?"];
  const settingParams = [keywordId, String(profile.profileId), startDate, endDate];
  if (childAsin !== "ALL") {
    settingWhere.push("u.child_asin = ?");
    settingParams.push(childAsin);
  }
  if (matchType !== "ALL") {
    settingWhere.push("c.match_type = ?");
    settingParams.push(matchType);
  }
  const [bidRows] = await pool.query(`
    SELECT s.date, AVG(s.bid) bid
    FROM ads_ad_unit_settings_daily s
    JOIN ads_ad_units u ON u.id = s.ad_unit_id
    JOIN ads_campaigns c ON c.id = u.campaign_id
    WHERE ${settingWhere.join(" AND ")}
    GROUP BY s.date ORDER BY s.date
  `, settingParams);
  const campaignWhere = ["c.keyword_id = ?", "c.profile_id = ?", "s.date BETWEEN ? AND ?"];
  const campaignParams = [keywordId, String(profile.profileId), startDate, endDate];
  if (matchType !== "ALL") {
    campaignWhere.push("c.match_type = ?");
    campaignParams.push(matchType);
  }
  if (childAsin !== "ALL") {
    campaignWhere.push("EXISTS (SELECT 1 FROM ads_ad_units u WHERE u.campaign_id = c.id AND u.child_asin = ?)");
    campaignParams.push(childAsin);
  }
  const [adjustmentRows] = await pool.query(`
    SELECT s.date, AVG(s.daily_budget) daily_budget, AVG(s.top_of_search_adjustment) top_of_search_adjustment,
      AVG(s.rest_of_search_adjustment) rest_of_search_adjustment,
      AVG(s.product_page_adjustment) product_page_adjustment
    FROM ads_campaign_settings_daily s
    JOIN ads_campaigns c ON c.id = s.campaign_id
    WHERE ${campaignWhere.join(" AND ")}
    GROUP BY s.date ORDER BY s.date
  `, campaignParams);
  const bidByDate = new Map(bidRows.map(row => [adsDateValue(row.date), Number(row.bid)]));
  const adjustmentByDate = new Map(adjustmentRows.map(row => [adsDateValue(row.date), {
    dailyBudget: Number(row.daily_budget),
    top: Number(row.top_of_search_adjustment),
    rest: Number(row.rest_of_search_adjustment),
    product: Number(row.product_page_adjustment)
  }]));
  const performanceByDate = new Map(performanceRows.map(row => [adsDateValue(row.date), row]));
  const rankByDate = new Map(rankRows.map(row => [adsDateValue(row.date), row]));
  const placementKey = value => {
    const placement = String(value || "").toUpperCase();
    if (["PLACEMENT_TOP", "TOP_OF_SEARCH", "TOP"].includes(placement)) return "top";
    if (["PLACEMENT_REST_OF_SEARCH", "REST_OF_SEARCH", "OTHER"].includes(placement)) return "rest";
    if (["PLACEMENT_PRODUCT_PAGE", "PRODUCT_PAGE", "DETAIL_PAGE"].includes(placement)) return "product";
    return null;
  };
  const placementByDate = new Map();
  for (const row of placementPerformanceRows) {
    const date = adsDateValue(row.date);
    const key = placementKey(row.placement);
    if (!key) continue;
    const placements = placementByDate.get(date) || {};
    placements[key] = row;
    placementByDate.set(date, placements);
  }
  const points = dates.map(date => {
    const row = performanceByDate.get(date);
    const rank = rankByDate.get(date);
    const adjustments = adjustmentByDate.get(date);
    const placements = placementByDate.get(date) || {};
    const clicks = Number(row?.clicks || 0);
    const spend = Number(row?.spend || 0);
    const placementMetrics = prefix => {
      const placement = placements[prefix];
      if (!placement) return {
        [`${prefix}ActualCpc`]: null, [`${prefix}Impressions`]: null, [`${prefix}Clicks`]: null,
        [`${prefix}Spend`]: null, [`${prefix}Orders`]: null, [`${prefix}Units`]: null, [`${prefix}Sales`]: null
      };
      const placementClicks = Number(placement.clicks || 0);
      const placementSpend = Number(placement.spend || 0);
      return {
        [`${prefix}ActualCpc`]: placementClicks > 0 ? placementSpend / placementClicks : null,
        [`${prefix}Impressions`]: Number(placement.impressions || 0),
        [`${prefix}Clicks`]: placementClicks,
        [`${prefix}Spend`]: placementSpend,
        [`${prefix}Orders`]: Number(placement.orders_count || 0),
        [`${prefix}Units`]: Number(placement.units_sold || 0),
        [`${prefix}Sales`]: Number(placement.sales || 0)
      };
    };
    return {
      date,
      bid: bidByDate.has(date) ? bidByDate.get(date) : null,
      dailyBudget: adjustments ? adjustments.dailyBudget : null,
      topOfSearchAdjustment: adjustments ? adjustments.top : null,
      restOfSearchAdjustment: adjustments ? adjustments.rest : null,
      productPageAdjustment: adjustments ? adjustments.product : null,
      actualCpc: clicks > 0 ? spend / clicks : null,
      impressions: Number(row?.impressions || 0),
      clicks,
      spend,
      orders: Number(row?.orders_count || 0),
      units: Number(row?.units_sold || 0),
      sales: Number(row?.sales || 0),
      ...placementMetrics("top"),
      ...placementMetrics("rest"),
      ...placementMetrics("product"),
      naturalRank: rank?.natural_rank === null || rank?.natural_rank === undefined ? null : Number(rank.natural_rank),
      adRank: rank?.sp_rank === null || rank?.sp_rank === undefined ? null : Number(rank.sp_rank)
    };
  });
  return {
    keyword: { id: String(keyword.id), parentAsin: keyword.parent_asin, text: keyword.keyword_text },
    range: { startDate, endDate },
    filters: { childAsin, matchType },
    options: { childAsins: availableAsins, matchTypes: availableMatchTypes },
    points,
    unavailableMetrics: []
  };
}

async function readLatestAdsAiStrategy(profileId) {
  const pool = getMysqlPool();
  const applySystemSchedule = async rules => {
    const [scheduleRows] = await pool.query("SELECT enabled, time_beijing FROM system_schedule_settings WHERE task_key = 'ADS_AI_ANALYSIS'");
    if (scheduleRows[0]) {
      rules.schedule.dailyBatchEnabled = Boolean(scheduleRows[0].enabled);
      rules.schedule.dailyBatchTime = scheduleRows[0].time_beijing || rules.schedule.dailyBatchTime;
    }
    return rules;
  };
  const [rows] = await pool.query(`
    SELECT version, rules_payload, created_at
    FROM ads_ai_strategy_versions
    WHERE profile_id = ?
    ORDER BY version DESC LIMIT 1
  `, [String(profileId)]);
  if (rows[0]) {
    const rules = await applySystemSchedule(sanitizeAdsAiStrategyRules(parseMysqlJson(rows[0].rules_payload)));
    return {
      version: Number(rows[0].version),
      rules,
      createdAt: rows[0].created_at
    };
  }
  const rules = defaultAdsAiStrategyRules();
  await pool.query(`
    INSERT INTO ads_ai_strategy_versions (profile_id, version, rules_payload, created_by)
    VALUES (?, 1, CAST(? AS JSON), 'SYSTEM')
  `, [String(profileId), JSON.stringify(rules)]);
  return { version: 1, rules: await applySystemSchedule(rules), createdAt: new Date() };
}

async function saveAdsAiStrategy(body = {}) {
  const profile = await requireSelectedAdsProfile();
  const pool = getMysqlPool();
  const rules = sanitizeAdsAiStrategyRules(body.rules);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query("DELETE FROM ads_ai_strategy_versions WHERE profile_id = ?", [String(profile.profileId)]);
    const version = 1;
    await connection.query(`
      INSERT INTO ads_ai_strategy_versions (profile_id, version, rules_payload, created_by)
      VALUES (?, ?, CAST(? AS JSON), 'USER')
    `, [String(profile.profileId), version, JSON.stringify(rules)]);
    await connection.commit();
    await pool.query(`
      INSERT INTO system_schedule_settings (task_key, enabled, schedule_type, time_beijing)
      VALUES ('ADS_AI_ANALYSIS', ?, 'DAILY', ?)
      ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), time_beijing = VALUES(time_beijing)
    `, [rules.schedule.dailyBatchEnabled ? 1 : 0, rules.schedule.dailyBatchTime]);
    return { version, rules };
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

async function requireAdsAiKeyword(keywordId) {
  const profile = await requireSelectedAdsProfile();
  const pool = getMysqlPool();
  const [rows] = await pool.query(`
    SELECT * FROM ads_keywords
    WHERE id = ? AND profile_id = ? AND lifecycle_status = 'ACTIVE'
  `, [keywordId, String(profile.profileId)]);
  if (!rows[0]) throw new Error("关键词不存在或当前不可分析");
  return { profile, keyword: rows[0] };
}

async function readAdsAiKeywordGoal(keywordId, profileId) {
  const pool = getMysqlPool();
  const [rows] = await pool.query(`
    SELECT goal_text, constraints_payload, updated_at
    FROM ads_ai_keyword_goals
    WHERE keyword_id = ? AND profile_id = ?
  `, [keywordId, String(profileId)]);
  const row = rows[0];
  return {
    text: row?.goal_text || "",
    constraints: parseMysqlJson(row?.constraints_payload) || {},
    updatedAt: row?.updated_at || null
  };
}

async function saveAdsAiKeywordGoal(keywordId, body = {}) {
  const { profile, keyword } = await requireAdsAiKeyword(keywordId);
  const goalText = String(body.goalText || "").trim().slice(0, 4000);
  const constraints = body.constraints && typeof body.constraints === "object" ? body.constraints : {};
  const pool = getMysqlPool();
  await pool.query(`
    INSERT INTO ads_ai_keyword_goals (keyword_id, profile_id, goal_text, constraints_payload)
    VALUES (?, ?, ?, CAST(? AS JSON))
    ON DUPLICATE KEY UPDATE goal_text = VALUES(goal_text), constraints_payload = VALUES(constraints_payload)
  `, [keyword.id, String(profile.profileId), goalText, JSON.stringify(constraints)]);
  return { keywordId: String(keyword.id), goal: { text: goalText, constraints } };
}

function adsAiPeriodSummary(points) {
  const totals = points.reduce((acc, point) => {
    for (const key of ["impressions", "clicks", "spend", "orders", "units", "sales"]) acc[key] += Number(point[key] || 0);
    return acc;
  }, { impressions: 0, clicks: 0, spend: 0, orders: 0, units: 0, sales: 0 });
  return {
    ...totals,
    ctr: totals.impressions > 0 ? totals.clicks / totals.impressions : null,
    cpc: totals.clicks > 0 ? totals.spend / totals.clicks : null,
    conversionRate: totals.clicks > 0 ? totals.orders / totals.clicks : null,
    acos: totals.sales > 0 ? totals.spend / totals.sales : null,
    roas: totals.spend > 0 ? totals.sales / totals.spend : null,
    naturalRankStart: points.find(point => point.naturalRank !== null)?.naturalRank ?? null,
    naturalRankEnd: [...points].reverse().find(point => point.naturalRank !== null)?.naturalRank ?? null,
    adRankStart: points.find(point => point.adRank !== null)?.adRank ?? null,
    adRankEnd: [...points].reverse().find(point => point.adRank !== null)?.adRank ?? null
  };
}

function adsAiPercentChange(current, previous) {
  const currentValue = Number(current || 0);
  const previousValue = Number(previous || 0);
  if (!previousValue) return currentValue ? null : 0;
  return (currentValue - previousValue) / Math.abs(previousValue);
}

async function buildAdsAiAnalysisInput(keywordId) {
  const { profile, keyword } = await requireAdsAiKeyword(keywordId);
  const pool = getMysqlPool();
  const strategy = await readLatestAdsAiStrategy(profile.profileId);
  const goal = await readAdsAiKeywordGoal(keyword.id, profile.profileId);
  const analysisWindowDays = Number(strategy.rules.globalLimits.analysisWindowDays || 30);
  const recentAiHistoryDays = Number(strategy.rules.globalLimits.recentAiHistoryDays || 0);
  const historyDays = Math.max(30, analysisWindowDays);
  const analysisEndDate = formatDateInTimeZone(new Date(), profile.timezone || US_MARKETPLACE_TIME_ZONE);
  const history = await readAdsKeywordHistory(keyword.id, {
    startDate: addDays(analysisEndDate, -(historyDays - 1)),
    endDate: analysisEndDate
  });
  const [campaignRows] = await pool.query(`
    SELECT * FROM ads_campaigns
    WHERE keyword_id = ? AND profile_id = ? AND lifecycle_status <> 'STOPPED'
    ORDER BY match_type, id
  `, [keyword.id, String(profile.profileId)]);
  const campaignIds = campaignRows.map(row => row.id);
  let unitRows = [];
  if (campaignIds.length) {
    [unitRows] = await pool.query(`
      SELECT * FROM ads_ad_units WHERE campaign_id IN (?) AND lifecycle_status <> 'STOPPED' ORDER BY campaign_id, id
    `, [campaignIds]);
  }
  const monitorAsins = [...new Set(unitRows.map(row => String(row.child_asin || "").toUpperCase()).filter(Boolean))];
  let inventoryStatus = "NOT_FOUND";
  let inventorySnapshot = [];
  try {
    const productCatalog = await readAdsProductCatalog();
    const wantedUnits = new Set(unitRows.map(row => `${String(row.child_asin || "").toUpperCase()}|${String(row.seller_sku || "")}`));
    inventorySnapshot = productCatalog.flatMap(product => product.children || []).filter(item =>
      wantedUnits.has(`${String(item.asin || "").toUpperCase()}|${String(item.sellerSku || "")}`)
    ).map(item => {
      const totalGoodsQuantity = item.totalGoodsQuantity === null || item.totalGoodsQuantity === undefined ? null : Number(item.totalGoodsQuantity || 0);
      const dailySales = Number(item.dailySales || 0);
      return {
        asin: item.asin,
        sellerSku: item.sellerSku,
        inventoryDate: item.inventoryDate || "",
        totalGoodsQuantity,
        fulfillableQuantity: item.fulfillableQuantity === null || item.fulfillableQuantity === undefined ? null : Number(item.fulfillableQuantity || 0),
        averageDailySales30d: dailySales,
        estimatedCoverDays: dailySales > 0 && totalGoodsQuantity !== null ? totalGoodsQuantity / dailySales : null
      };
    });
    if (inventorySnapshot.length) inventoryStatus = "AVAILABLE";
  } catch {
    inventoryStatus = "UNAVAILABLE";
  }
  let recommendedBidRows = [];
  if (monitorAsins.length) {
    [recommendedBidRows] = await pool.query(`
      SELECT m.asin, b.date, b.exact_start, b.exact_median, b.exact_end,
        b.phrase_start, b.phrase_median, b.phrase_end, b.broad_start, b.broad_median, b.broad_end
      FROM sif_keyword_monitors m
      JOIN sif_keyword_bid_daily b ON b.monitor_id = m.id
      JOIN (SELECT monitor_id, MAX(date) max_date FROM sif_keyword_bid_daily GROUP BY monitor_id) latest
        ON latest.monitor_id = b.monitor_id AND latest.max_date = b.date
      WHERE m.country_code = ? AND m.normalized_keyword = ? AND m.asin IN (?)
    `, [String(profile.countryCode || "US").toUpperCase(), normalizeSifKeyword(keyword.keyword_text), monitorAsins]);
  }
  let recentAiHistory = [];
  if (recentAiHistoryDays > 0) {
    const recentAiHistoryStart = addDays(analysisEndDate, -(recentAiHistoryDays - 1));
    // 批量分析时每个关键词仅保留最近 3 次压缩记录，避免 100 个关键词时把上下文无限放大。
    const [recentRunRows] = await pool.query(`
      SELECT id, status, model_name, output_payload, validation_error, started_at, completed_at
      FROM ads_ai_analysis_runs
      WHERE keyword_id = ? AND profile_id = ? AND started_at >= ? AND status IN ('COMPLETE', 'FAILED')
      ORDER BY started_at DESC LIMIT 3
    `, [keyword.id, String(profile.profileId), `${recentAiHistoryStart} 00:00:00`]);
    const recentRunIds = recentRunRows.map(row => row.id);
    const recommendationsByRun = new Map();
    if (recentRunIds.length) {
      const [recentRecommendationRows] = await pool.query(`
        SELECT * FROM ads_ai_recommendations
        WHERE analysis_run_id IN (?)
        ORDER BY created_at DESC
      `, [recentRunIds]);
      for (const row of recentRecommendationRows) {
        const key = String(row.analysis_run_id);
        const list = recommendationsByRun.get(key) || [];
        if (list.length >= 1) continue;
        list.push({
          actionType: row.action_type,
          after: parseMysqlJson(row.after_payload) || {},
          status: row.status,
          reason: String(row.reason_text || "").trim().slice(0, 240),
          risk: String(row.risk_text || "").trim().slice(0, 120),
          confidence: Number(row.confidence || 0),
          observeDays: Number(row.observe_days || 0),
          error: String(row.last_error || "").trim().slice(0, 160)
        });
        recommendationsByRun.set(key, list);
      }
    }
    recentAiHistory = recentRunRows.map(row => {
      const output = parseMysqlJson(row.output_payload) || {};
      return {
        analyzedAt: row.completed_at || row.started_at,
        status: row.status,
        model: row.model_name || "",
        analysisSummary: String(output.analysisSummary || "").trim().slice(0, 360),
        signals: Array.isArray(output.signals)
          ? output.signals.slice(0, 2).map(signal => ({ severity: signal.severity, summary: String(signal.summary || "").trim().slice(0, 120) }))
          : [],
        recommendations: recommendationsByRun.get(String(row.id)) || [],
        error: String(row.validation_error || "").trim().slice(0, 200)
      };
    });
  }
  const availablePoints = history.points.slice(-historyDays);
  const points = availablePoints.slice(-analysisWindowDays);
  const last7 = availablePoints.slice(-7);
  const previous7 = availablePoints.slice(-14, -7);
  const summary30 = adsAiPeriodSummary(availablePoints.slice(-30));
  const summary7 = adsAiPeriodSummary(last7);
  const summaryPrevious7 = adsAiPeriodSummary(previous7);
  const campaigns = campaignRows.map(row => ({
    id: String(row.id), matchType: row.match_type, childAsin: row.child_asin || "", sellerSku: row.seller_sku || "",
    state: row.desired_state, amazonState: row.amazon_state || "", dailyBudget: Number(row.daily_budget || 0),
    topOfSearchAdjustment: Number(row.top_of_search_adjustment || 0), restOfSearchAdjustment: Number(row.rest_of_search_adjustment || 0),
    productPageAdjustment: Number(row.product_page_adjustment || 0), amazonCampaignId: row.amazon_campaign_id || ""
  }));
  const adUnits = unitRows.map(row => ({
    id: String(row.id), campaignId: String(row.campaign_id), childAsin: row.child_asin, sellerSku: row.seller_sku,
    bid: Number(row.bid || 0), state: row.desired_state, amazonAdGroupId: row.amazon_ad_group_id || "",
    amazonTargetId: row.amazon_target_id || ""
  }));
  const decimal = value => value === null || value === undefined ? null : Number(value);
  return {
    context: {
      profileId: String(profile.profileId), countryCode: profile.countryCode || "US", currency: profile.currencyCode || "USD",
      keywordId: String(keyword.id), parentAsin: keyword.parent_asin, keyword: keyword.keyword_text,
      group: keyword.keyword_group, dataCutoff: history.range.endDate, analysisWindowDays,
      recentAiHistoryDays,
      strategyVersion: strategy.version, promptVersion: ADS_AI_PROMPT_VERSION
    },
    strategy: { ...strategy.rules, keywordGoal: goal },
    currentState: {
      campaigns,
      adUnits,
      inventory: {
        status: inventoryStatus,
        safetyDays: Number(strategy.rules.globalLimits.inventorySafetyDays || 0),
        items: inventorySnapshot
      }
    },
    recommendedBids: recommendedBidRows.map(row => ({
      asin: row.asin, date: adsDateValue(row.date),
      exact: { start: decimal(row.exact_start), median: decimal(row.exact_median), end: decimal(row.exact_end) },
      phrase: { start: decimal(row.phrase_start), median: decimal(row.phrase_median), end: decimal(row.phrase_end) },
      broad: { start: decimal(row.broad_start), median: decimal(row.broad_median), end: decimal(row.broad_end) }
    })),
    performanceSummary: {
      last7Days: summary7,
      previous7Days: summaryPrevious7,
      last30Days: summary30,
      changes: {
        impressions7dVsPrevious7d: adsAiPercentChange(summary7.impressions, summaryPrevious7.impressions),
        clicks7dVsPrevious7d: adsAiPercentChange(summary7.clicks, summaryPrevious7.clicks),
        orders7dVsPrevious7d: adsAiPercentChange(summary7.orders, summaryPrevious7.orders),
        sales7dVsPrevious7d: adsAiPercentChange(summary7.sales, summaryPrevious7.sales),
        acos7dVsPrevious7d: summary7.acos === null || summaryPrevious7.acos === null ? null : adsAiPercentChange(summary7.acos, summaryPrevious7.acos)
      }
    },
    dailyHistory: points,
    recentAiHistory: {
      days: recentAiHistoryDays,
      maxRuns: 3,
      entries: recentAiHistory
    }
  };
}

function adsAiApproxEqual(left, right) {
  return Math.abs(Number(left) - Number(right)) < 0.0001;
}

function buildAdsAiDeterministicPrecheck(input) {
  const campaigns = Array.isArray(input.currentState?.campaigns) ? input.currentState.campaigns : [];
  const adUnits = Array.isArray(input.currentState?.adUnits) ? input.currentState.adUnits : [];
  const summary = input.performanceSummary?.last30Days || {};
  const observeDays = Number(input.strategy?.globalLimits?.minObservationDays || 3);
  if (!campaigns.length || !adUnits.length) {
    return {
      analysisSummary: "规则预判发现当前关键词没有完整的可分析广告对象。需要先完成或修复 Campaign 与投放单元的创建、同步和启用状态，再进行出价、预算或位置加价判断。",
      signals: [{
        code: "MISSING_AD_OBJECTS",
        severity: "critical",
        summary: "缺少有效 Campaign 或投放单元，当前无法形成可靠的广告调整建议。",
        evidence: ["currentState.campaigns", "currentState.adUnits"]
      }],
      recommendations: [{
        actionType: "REQUEST_MORE_DATA",
        target: {}, before: {}, after: {},
        reason: "请先确认 Campaign、Ad Group、Product Ad 和 Keyword Target 已创建成功、同步完成且具备投放资格，然后重新分析。",
        risk: "在广告对象不完整时调整竞价或预算，可能无法生效，也无法根据表现验证结果。",
        evidence: ["currentState.campaigns", "currentState.adUnits"],
        confidence: 1,
        observeDays
      }]
    };
  }
  const hasNoTraffic = ["impressions", "clicks", "spend", "orders", "units", "sales"]
    .every(key => Number(summary[key] || 0) === 0);
  if (!hasNoTraffic) return null;
  const observedConfigurationDays = (Array.isArray(input.dailyHistory) ? input.dailyHistory : []).filter(point =>
    [point.bid, point.topOfSearchAdjustment, point.restOfSearchAdjustment, point.productPageAdjustment]
      .some(value => value !== null && value !== undefined)
  ).length;
  // 零流量但已满足最短观察期时仍交给 AI，让模型结合建议竞价、排名和投放资格判断是否应该调整。
  if (observedConfigurationDays >= observeDays) return null;
  return {
    analysisSummary: `规则预判发现最近 30 天没有广告曝光、点击、花费、订单或销售额，且当前配置只观察到 ${observedConfigurationDays} 天，尚未达到最短 ${observeDays} 天观察期。当前无法评价 CTR、CPC、转化率与 ACOS，应先排查投放资格并继续观察。`,
    signals: [{
      code: "NO_AD_TRAFFIC",
      severity: "warning",
        summary: `最近 30 天全部广告表现指标为 0，当前配置观察 ${observedConfigurationDays}/${observeDays} 天。`,
        evidence: ["performanceSummary.last30Days", "dailyHistory"]
    }],
    recommendations: [{
      actionType: "REQUEST_MORE_DATA",
      target: {}, before: {}, after: {},
        reason: `请确认活动、广告组、商品广告和关键词均具备投放资格，商品可售并拥有 Buy Box，预算未受限，关键词未受审核或相关性限制；至少完成 ${observeDays} 天观察后再判断是否调整竞价和位置加价。`,
      risk: "在零流量原因未排除前直接提高竞价或位置加价，可能无法解决曝光问题，或在恢复投放后放大无效花费。",
      evidence: ["performanceSummary.last30Days", "dailyHistory", "currentState.campaigns", "currentState.adUnits"],
      confidence: 0.99,
      observeDays
    }]
  };
}

async function executeAdsAiDeterministicPrecheckRun(runId, input, rawOutput) {
  await getMysqlPool().query("UPDATE ads_ai_analysis_runs SET model_name = 'RULE_ENGINE' WHERE id = ?", [runId]);
  const output = validateAdsAiOutput(rawOutput, input);
  await persistAdsAiAnalysisOutput(runId, input, output);
  return output;
}

function isAdsAiJsonObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateAdsAiOutput(raw, input) {
  if (!isAdsAiJsonObject(raw)) throw new Error("AI 输出必须是 JSON 对象");
  const output = raw;
  if (typeof output.analysisSummary !== "string") throw new Error("AI 输出的 analysisSummary 必须是字符串");
  const analysisSummary = output.analysisSummary.trim().slice(0, 8000);
  if (!analysisSummary) throw new Error("AI 输出缺少 analysisSummary");
  if (!Array.isArray(output.signals)) throw new Error("AI 输出缺少 signals 数组");
  const signals = output.signals.slice(0, 30).map(signal => {
    if (!isAdsAiJsonObject(signal) || typeof signal.code !== "string" || typeof signal.summary !== "string") {
      throw new Error("AI signals 字段结构不合法");
    }
    const severity = String(signal.severity || "").toLowerCase();
    if (!["info", "warning", "critical"].includes(severity)) throw new Error("AI signal severity 不合法");
    if (!Array.isArray(signal.evidence) || signal.evidence.some(item => typeof item !== "string")) {
      throw new Error("AI signal evidence 必须是字符串数组");
    }
    const summary = signal.summary.trim().slice(0, 2000);
    if (!summary) throw new Error("AI signal 缺少 summary");
    return {
      code: signal.code.trim().slice(0, 64) || "OTHER",
      severity,
      summary,
      evidence: signal.evidence.map(item => item.slice(0, 200)).slice(0, 20)
    };
  });
  if (!Array.isArray(output.recommendations)) throw new Error("AI 输出缺少 recommendations 数组");
  const campaigns = new Map(input.currentState.campaigns.map(item => [String(item.id), item]));
  const adUnits = new Map(input.currentState.adUnits.map(item => [String(item.id), item]));
  const limits = input.strategy.globalLimits;
  const recommendations = [];
  for (const source of output.recommendations.slice(0, 20)) {
    if (!isAdsAiJsonObject(source) || typeof source.actionType !== "string") throw new Error("AI recommendation 字段结构不合法");
    if (!isAdsAiJsonObject(source.target) || !isAdsAiJsonObject(source.before) || !isAdsAiJsonObject(source.after)) {
      throw new Error("AI recommendation 的 target、before、after 必须是 JSON 对象");
    }
    if (typeof source.reason !== "string" || (source.risk !== undefined && typeof source.risk !== "string")) {
      throw new Error("AI recommendation 的 reason 或 risk 不合法");
    }
    if (!Array.isArray(source.evidence) || source.evidence.some(item => typeof item !== "string")) {
      throw new Error("AI recommendation evidence 必须是字符串数组");
    }
    if (typeof source.confidence !== "number" || !Number.isFinite(source.confidence) || source.confidence < 0 || source.confidence > 1) {
      throw new Error("AI recommendation confidence 必须是 0 到 1 的数字");
    }
    if (typeof source.observeDays !== "number" || !Number.isInteger(source.observeDays)) {
      throw new Error("AI recommendation observeDays 必须是整数");
    }
    const actionType = source.actionType.toUpperCase();
    if (!ADS_AI_ACTION_TYPES.has(actionType)) throw new Error(`AI 返回了不支持的动作：${actionType || "空"}`);
    if (actionType === "NO_ACTION") continue;
    const target = { ...source.target };
    const before = { ...source.before };
    const after = { ...source.after };
    if (["CHANGE_BID"].includes(actionType)) {
      if (typeof target.adUnitId !== "string" || typeof before.bid !== "number" || typeof after.bid !== "number"
        || !Number.isFinite(before.bid) || !Number.isFinite(after.bid)) throw new Error("调价建议字段类型不合法");
      const unit = adUnits.get(String(target.adUnitId || ""));
      if (!unit) throw new Error("调价建议缺少有效 adUnitId");
      const nextBid = after.bid;
      if (!adsAiApproxEqual(before.bid, unit.bid)) throw new Error("调价建议的 before.bid 与当前值不一致");
      if (!(nextBid > 0) || nextBid > limits.maxBid) throw new Error("调价建议超出最高竞价限制");
      if (Math.abs(nextBid - unit.bid) > limits.maxBidChangeAmount + 0.0001) throw new Error("调价建议超出单次金额限制");
      if (unit.bid > 0 && Math.abs(nextBid - unit.bid) / unit.bid > limits.maxBidChangePercent + 0.0001) throw new Error("调价建议超出单次比例限制");
      target.adUnitId = String(unit.id);
      target.campaignId = String(unit.campaignId);
      before.bid = Number(unit.bid);
      after.bid = nextBid;
    } else if (["CHANGE_PLACEMENT_ADJUSTMENT", "CHANGE_DAILY_BUDGET"].includes(actionType)) {
      if (typeof target.campaignId !== "string") throw new Error("Campaign 调整建议的 campaignId 必须是字符串");
      const campaign = campaigns.get(String(target.campaignId || ""));
      if (!campaign) throw new Error("Campaign 调整建议缺少有效 campaignId");
      const current = {
        dailyBudget: campaign.dailyBudget,
        topOfSearchAdjustment: campaign.topOfSearchAdjustment,
        restOfSearchAdjustment: campaign.restOfSearchAdjustment,
        productPageAdjustment: campaign.productPageAdjustment
      };
      if (actionType === "CHANGE_DAILY_BUDGET") {
        if (typeof before.dailyBudget !== "number" || typeof after.dailyBudget !== "number"
          || !Number.isFinite(before.dailyBudget) || !Number.isFinite(after.dailyBudget)) throw new Error("预算建议字段类型不合法");
        const nextBudget = after.dailyBudget;
        if (!adsAiApproxEqual(before.dailyBudget, current.dailyBudget)) throw new Error("预算建议的当前值不一致");
        if (!(nextBudget > 0) || nextBudget > limits.maxDailyBudget) throw new Error("预算建议超出最高预算限制");
        if (current.dailyBudget > 0 && Math.abs(nextBudget - current.dailyBudget) / current.dailyBudget > limits.maxDailyBudgetChangePercent + 0.0001) throw new Error("预算建议超出单次比例限制");
        after.dailyBudget = nextBudget;
      } else {
        for (const key of ["topOfSearchAdjustment", "restOfSearchAdjustment", "productPageAdjustment"]) {
          if (after[key] === undefined) after[key] = current[key];
          const value = after[key];
          if (!Number.isInteger(value) || value < 0 || value > limits.maxPlacementAdjustment) throw new Error("位置加价建议超出限制");
          after[key] = value;
        }
      }
      Object.assign(before, current);
      Object.assign(after, { ...current, ...after });
      target.campaignId = String(campaign.id);
    } else if (["PAUSE_CAMPAIGN", "RESUME_CAMPAIGN"].includes(actionType)) {
      if (typeof target.campaignId !== "string") throw new Error("启停建议的 campaignId 必须是字符串");
      const campaign = campaigns.get(String(target.campaignId || ""));
      if (!campaign) throw new Error("启停建议缺少有效 campaignId");
      const expectedAfter = actionType === "PAUSE_CAMPAIGN" ? "PAUSED" : "ENABLED";
      before.state = campaign.state;
      after.state = expectedAfter;
      target.campaignId = String(campaign.id);
    } else if (actionType === "MOVE_GROUP") {
      if (target.keywordId !== undefined && typeof target.keywordId !== "string") throw new Error("分组建议的 keywordId 必须是字符串");
      if (typeof after.group !== "string") throw new Error("分组建议的 group 必须是字符串");
      const nextGroup = String(after.group || "").toUpperCase();
      if (String(target.keywordId || input.context.keywordId) !== input.context.keywordId || !ADS_AI_GROUPS.has(nextGroup)) throw new Error("分组建议不合法");
      target.keywordId = input.context.keywordId;
      before.group = input.context.group;
      after.group = nextGroup;
    } else if (actionType === "REQUEST_MORE_DATA") {
      target.keywordId = input.context.keywordId;
    }
    const reason = source.reason.trim().slice(0, 8000);
    if (!reason) throw new Error("AI 建议缺少 reason");
    recommendations.push({
      actionType, target, before, after, reason,
      risk: String(source.risk || "").trim().slice(0, 4000),
      evidence: source.evidence.map(item => item.slice(0, 300)).slice(0, 30),
      confidence: source.confidence,
      observeDays: Math.round(adsAiNumber(source.observeDays, limits.minObservationDays, limits.minObservationDays, 30))
    });
  }
  return { analysisSummary, signals, recommendations };
}

async function rememberAdsAiRecommendationEvent(recommendationId, eventType, payload = null, connection = null) {
  const executor = connection || getMysqlPool();
  await executor.query(`
    INSERT INTO ads_ai_recommendation_events (recommendation_id, event_type, payload)
    VALUES (?, ?, CAST(? AS JSON))
  `, [recommendationId, eventType, JSON.stringify(payload)]);
}

async function persistAdsAiAnalysisOutput(runId, input, output) {
  const pool = getMysqlPool();
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [supersededRows] = await connection.query(`
      SELECT id FROM ads_ai_recommendations
      WHERE keyword_id = ? AND profile_id = ? AND status = 'PENDING'
      FOR UPDATE
    `, [input.context.keywordId, input.context.profileId]);
    await connection.query(`
      UPDATE ads_ai_recommendations
      SET status = 'SUPERSEDED'
      WHERE keyword_id = ? AND profile_id = ? AND status = 'PENDING'
    `, [input.context.keywordId, input.context.profileId]);
    for (const previous of supersededRows) {
      await rememberAdsAiRecommendationEvent(previous.id, "SUPERSEDED", { supersededByAnalysisRunId: runId }, connection);
    }
    await connection.query(`
      UPDATE ads_ai_analysis_runs
      SET status = 'COMPLETE', output_payload = CAST(? AS JSON), validation_error = NULL, completed_at = NOW()
      WHERE id = ?
    `, [JSON.stringify(output), runId]);
    for (const recommendation of output.recommendations) {
      const recommendationId = randomUUID();
      await connection.query(`
        INSERT INTO ads_ai_recommendations (
          id, analysis_run_id, profile_id, keyword_id, action_type, target_payload, before_payload, after_payload,
          reason_text, risk_text, evidence_payload, confidence, observe_days, status
        ) VALUES (?, ?, ?, ?, ?, CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON), ?, ?, CAST(? AS JSON), ?, ?, 'PENDING')
      `, [
        recommendationId, runId, input.context.profileId, input.context.keywordId, recommendation.actionType,
        JSON.stringify(recommendation.target), JSON.stringify(recommendation.before), JSON.stringify(recommendation.after),
        recommendation.reason, recommendation.risk, JSON.stringify(recommendation.evidence), recommendation.confidence, recommendation.observeDays
      ]);
      await rememberAdsAiRecommendationEvent(recommendationId, "GENERATED", recommendation, connection);
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

function adsAiApprovalAllows(actionType, mode) {
  if (actionType === "REQUEST_MORE_DATA" || actionType === "NO_ACTION") return false;
  if (mode === "AUTO_ALL") return true;
  if (mode === "RISK_ONLY") return actionType === "CHANGE_BID";
  return false;
}

async function autoExecuteAdsAiRecommendations(runId, input) {
  const mode = input.strategy?.schedule?.approvalMode || "MANUAL";
  if (mode === "MANUAL") return [];
  const rows = await getMysqlPool().query(`
    SELECT id, action_type FROM ads_ai_recommendations
    WHERE analysis_run_id = ? AND status = 'PENDING'
  `).then(([result]) => result);
  const executed = [];
  for (const row of rows) {
    if (!adsAiApprovalAllows(row.action_type, mode)) continue;
    try {
      await executeAdsAiRecommendation(row.id, { confirmed: true, source: `AI_APPROVAL_${mode}` });
      executed.push({ id: row.id, status: "EXECUTED" });
    } catch (error) {
      executed.push({ id: row.id, status: "FAILED", error: error.message });
    }
  }
  return executed;
}

async function failAdsAiAnalysisRun(runId, outputForAudit, error) {
  await getMysqlPool().query(`
    UPDATE ads_ai_analysis_runs
    SET status = 'FAILED', output_payload = CAST(? AS JSON), validation_error = ?, completed_at = NOW()
    WHERE id = ?
  `, [JSON.stringify(outputForAudit), error.message, runId]);
}

async function executeAdsAiAnalysisRun(runId, input) {
  let outputForAudit = null;
  try {
    const content = await callOpenAI([
      {
        role: "system",
        content: `你是 Amazon Ads 关键词投放分析器。只能根据输入 JSON 和策略规则判断，不得虚构数据。真实调整是否自动执行由输入策略中的处理建议行动模式决定。若 recentAiHistory.entries 非空，必须结合其中近期分析结论与建议状态，避免重复已执行、已确认、已拒绝或已被取代的行动。只返回一个 JSON 对象，不要 Markdown。\n输出格式必须严格为：\n{\"analysisSummary\":\"string\",\"signals\":[{\"code\":\"string\",\"severity\":\"info|warning|critical\",\"summary\":\"string\",\"evidence\":[\"输入字段路径\"]}],\"recommendations\":[{\"actionType\":\"CHANGE_BID|CHANGE_PLACEMENT_ADJUSTMENT|CHANGE_DAILY_BUDGET|PAUSE_CAMPAIGN|RESUME_CAMPAIGN|MOVE_GROUP|REQUEST_MORE_DATA|NO_ACTION\",\"target\":{\"keywordId\":\"string 可选\",\"campaignId\":\"string 可选\",\"adUnitId\":\"string 可选\"},\"before\":{},\"after\":{},\"reason\":\"string\",\"risk\":\"string\",\"evidence\":[\"输入字段路径\"],\"confidence\":0.0,\"observeDays\":3}]}\n必须使用输入中真实存在的本地 ID。CHANGE_BID 使用 before/after.bid；位置加价使用 topOfSearchAdjustment/restOfSearchAdjustment/productPageAdjustment；预算使用 dailyBudget；启停使用 state；分组使用 group。若证据不足，返回 REQUEST_MORE_DATA 或空 recommendations。`
      },
      { role: "user", content: JSON.stringify(input) }
    ], true);
    if (!content) throw new Error("未配置 OPENAI_API_KEY，无法调用 CCAI 分析");
    outputForAudit = { rawText: String(content).slice(0, 200000) };
    let rawOutput;
    try {
      rawOutput = JSON.parse(content);
      outputForAudit = rawOutput;
    } catch {
      throw new Error("AI 返回内容不是合法 JSON");
    }
    const output = validateAdsAiOutput(rawOutput, input);
    await persistAdsAiAnalysisOutput(runId, input, output);
    await autoExecuteAdsAiRecommendations(runId, input);
    return output;
  } catch (error) {
    await failAdsAiAnalysisRun(runId, outputForAudit, error);
    throw error;
  }
}

async function createAdsAiAnalysisRun(keywordId) {
  const input = await buildAdsAiAnalysisInput(keywordId);
  return createAdsAiAnalysisRunFromInput(input);
}

async function createAdsAiAnalysisRunFromInput(input) {
  const pool = getMysqlPool();
  const runId = randomUUID();
  const modelName = process.env.OPENAI_MODEL || "gpt-5.4";
  await pool.query(`
    INSERT INTO ads_ai_analysis_runs (
      id, profile_id, keyword_id, status, model_name, prompt_version, strategy_version, input_payload
    ) VALUES (?, ?, ?, 'RUNNING', ?, ?, ?, CAST(? AS JSON))
  `, [runId, input.context.profileId, input.context.keywordId, modelName, ADS_AI_PROMPT_VERSION, input.context.strategyVersion, JSON.stringify(input)]);
  return { runId, input };
}

function adsAiAsinCooldownMinutes() {
  return Math.round(adsAiNumber(process.env.ADS_AI_ASIN_COOLDOWN_MINUTES, 60, 5, 1440));
}

async function readAdsAiAsinAnalysisGuard(profileId, parentAsin) {
  const cooldownMinutes = adsAiAsinCooldownMinutes();
  const [rows] = await getMysqlPool().query(`
    SELECT r.id, r.keyword_id, r.status, r.started_at, r.completed_at
    FROM ads_ai_analysis_runs r
    JOIN ads_keywords k ON k.id = r.keyword_id
    WHERE r.profile_id = ? AND k.parent_asin = ?
      AND (
        r.status = 'RUNNING'
        OR (r.status = 'COMPLETE' AND r.completed_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE))
      )
    ORDER BY (r.status = 'RUNNING') DESC, COALESCE(r.completed_at, r.started_at) DESC
    LIMIT 1
  `, [String(profileId), String(parentAsin), cooldownMinutes]);
  const row = rows[0];
  if (!row) return null;
  if (row.status === 'RUNNING') {
    return { state: 'RUNNING', runId: row.id, keywordId: String(row.keyword_id), cooldownMinutes };
  }
  const [remainingRows] = await getMysqlPool().query(`
    SELECT GREATEST(1, CEIL(TIMESTAMPDIFF(SECOND, NOW(), DATE_ADD(?, INTERVAL ? MINUTE)) / 60)) remaining_minutes
  `, [row.completed_at || row.started_at, cooldownMinutes]);
  return {
    state: 'COOLDOWN', runId: row.id, keywordId: String(row.keyword_id), cooldownMinutes,
    remainingMinutes: Number(remainingRows[0]?.remaining_minutes || 1)
  };
}

async function withAdsAiAsinLock(profileId, parentAsin, callback) {
  const pool = getMysqlPool();
  const connection = await pool.getConnection();
  const lockKey = `ads_ai_asin_${createHash('sha256').update(`${profileId}|${parentAsin}`).digest('hex').slice(0, 40)}`;
  let locked = false;
  try {
    const [rows] = await connection.query('SELECT GET_LOCK(?, 5) acquired', [lockKey]);
    locked = Number(rows[0]?.acquired || 0) === 1;
    if (!locked) throw new Error('该 ASIN 正在创建 AI 分析任务，请稍后重试');
    return await callback();
  } finally {
    if (locked) await connection.query('SELECT RELEASE_LOCK(?)', [lockKey]).catch(() => {});
    connection.release();
  }
}

async function reserveAdsAiAnalysisRun(profile, keyword) {
  return withAdsAiAsinLock(profile.profileId, keyword.parent_asin, async () => {
    const guard = await readAdsAiAsinAnalysisGuard(profile.profileId, keyword.parent_asin);
    if (guard) return { guard, run: null };
    return { guard: null, run: await createAdsAiAnalysisRun(keyword.id) };
  });
}

async function startAdsAiAnalysis(keywordId) {
  const { profile, keyword } = await requireAdsAiKeyword(keywordId);
  await expireStaleAdsAiAnalysisRuns(profile.profileId);
  const reservation = await reserveAdsAiAnalysisRun(profile, keyword);
  if (reservation.guard) return readAdsAiKeywordState(keyword.id);
  const run = reservation.run;
  const precheck = buildAdsAiDeterministicPrecheck(run.input);
  const job = (precheck
    ? executeAdsAiDeterministicPrecheckRun(run.runId, run.input, precheck)
    : executeAdsAiAnalysisRun(run.runId, run.input))
    .catch(error => console.error(`AI analysis ${run.runId} failed: ${error.message}`))
    .finally(() => adsAiAnalysisJobs.delete(String(keyword.id)));
  adsAiAnalysisJobs.set(String(keyword.id), job);
  return readAdsAiKeywordState(keyword.id, run.runId);
}

async function expireStaleAdsAiAnalysisRuns(profileId, keywordId = null) {
  const timeoutMinutes = Math.max(5, Number(process.env.ADS_AI_RUNNING_TIMEOUT_MINUTES || 15));
  const where = ["profile_id = ?", "status = 'RUNNING'", "started_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)"];
  const params = [String(profileId), timeoutMinutes];
  const activeKeywordIds = [...adsAiAnalysisJobs.keys()].map(String);
  if (keywordId !== null) {
    if (activeKeywordIds.includes(String(keywordId))) return;
    where.push("keyword_id = ?");
    params.push(keywordId);
  } else if (activeKeywordIds.length) {
    where.push("keyword_id NOT IN (?)");
    params.push(activeKeywordIds);
  }
  await getMysqlPool().query(`
    UPDATE ads_ai_analysis_runs
    SET status = 'FAILED', validation_error = '后台 AI 任务超时或服务重启，请重新分析', completed_at = NOW()
    WHERE ${where.join(" AND ")}
  `, params);
}

async function executeAdsAiBatchAnalysisRuns(runs) {
  let outputForAudit = null;
  try {
    const content = await callOpenAI([
      {
        role: "system",
        content: `你是 Amazon Ads 每日批量关键词投放分析器。只能根据每个关键词各自的输入 JSON 和策略规则判断，不得在关键词之间混用数据。真实调整是否自动执行由输入策略中的处理建议行动模式决定。若某关键词的 recentAiHistory.entries 非空，必须结合其中近期分析结论与建议状态，避免重复已执行、已确认、已拒绝或已被取代的行动。只返回一个 JSON 对象，不要 Markdown。\n输出格式必须严格为：\n{"results":[{"keywordId":"输入中的 keywordId","analysisSummary":"string","signals":[{"code":"string","severity":"info|warning|critical","summary":"string","evidence":["输入字段路径"]}],"recommendations":[{"actionType":"CHANGE_BID|CHANGE_PLACEMENT_ADJUSTMENT|CHANGE_DAILY_BUDGET|PAUSE_CAMPAIGN|RESUME_CAMPAIGN|MOVE_GROUP|REQUEST_MORE_DATA|NO_ACTION","target":{},"before":{},"after":{},"reason":"string","risk":"string","evidence":["输入字段路径"],"confidence":0.0,"observeDays":3}]}]}\n每个输入关键词必须恰好返回一个同 keywordId 的结果。必须使用输入中真实存在的本地 ID。证据不足时返回 REQUEST_MORE_DATA 或空 recommendations。`
      },
      { role: "user", content: JSON.stringify({ analyses: runs.map(run => run.input) }) }
    ], true);
    if (!content) throw new Error("未配置 OPENAI_API_KEY，无法调用 CCAI 分析");
    outputForAudit = { rawText: String(content).slice(0, 500000) };
    let rawOutput;
    try {
      rawOutput = JSON.parse(content);
      outputForAudit = rawOutput;
    } catch {
      throw new Error("AI 批量返回内容不是合法 JSON");
    }
    if (!isAdsAiJsonObject(rawOutput) || !Array.isArray(rawOutput.results)) throw new Error("AI 批量输出缺少 results 数组");
    const resultsByKeywordId = new Map();
    for (const item of rawOutput.results) {
      if (!isAdsAiJsonObject(item) || typeof item.keywordId !== "string") throw new Error("AI 批量结果缺少 keywordId");
      if (resultsByKeywordId.has(item.keywordId)) throw new Error(`AI 批量结果重复 keywordId：${item.keywordId}`);
      resultsByKeywordId.set(item.keywordId, item);
    }
    const completed = [];
    for (const run of runs) {
      const result = resultsByKeywordId.get(run.input.context.keywordId);
      try {
        if (!result) throw new Error("AI 批量结果缺少该关键词");
        const { keywordId, ...rawKeywordOutput } = result;
        const output = validateAdsAiOutput(rawKeywordOutput, run.input);
        await persistAdsAiAnalysisOutput(run.runId, run.input, output);
        await autoExecuteAdsAiRecommendations(run.runId, run.input);
        completed.push({ keywordId, runId: run.runId, status: "COMPLETE" });
      } catch (error) {
        await failAdsAiAnalysisRun(run.runId, result || outputForAudit, error);
        completed.push({ keywordId: run.input.context.keywordId, runId: run.runId, status: "FAILED", error: error.message });
      }
    }
    return { results: completed, rawOutput: outputForAudit };
  } catch (error) {
    await Promise.all(runs.map(run => failAdsAiAnalysisRun(run.runId, outputForAudit, error).catch(() => {})));
    throw error;
  }
}

function splitAdsAiBatchRuns(runs) {
  const maxKeywords = Math.round(adsAiNumber(process.env.ADS_AI_BATCH_MAX_KEYWORDS, 5, 1, 10));
  const maxInputChars = Math.round(adsAiNumber(process.env.ADS_AI_BATCH_MAX_INPUT_CHARS, 90_000, 30_000, 500_000));
  const chunks = [];
  let current = [];
  let currentChars = 32;
  for (const run of runs) {
    const inputChars = JSON.stringify(run.input).length + 2;
    if (current.length && (current.length >= maxKeywords || currentChars + inputChars > maxInputChars)) {
      chunks.push({ runs: current, inputChars: currentChars });
      current = [];
      currentChars = 32;
    }
    current.push(run);
    currentChars += inputChars;
  }
  if (current.length) chunks.push({ runs: current, inputChars: currentChars });
  return { chunks, limits: { maxKeywords, maxInputChars } };
}

async function executeChunkedAdsAiBatchAnalysisRuns(runs) {
  const precheckedRuns = [];
  const modelRuns = [];
  for (const run of runs) {
    const precheck = buildAdsAiDeterministicPrecheck(run.input);
    if (precheck) precheckedRuns.push({ ...run, precheck });
    else modelRuns.push(run);
  }
  const results = [];
  const chunkResults = [];
  for (const run of precheckedRuns) {
    try {
      await executeAdsAiDeterministicPrecheckRun(run.runId, run.input, run.precheck);
      results.push({ keywordId: run.input.context.keywordId, runId: run.runId, status: "COMPLETE", source: "RULE_ENGINE" });
    } catch (error) {
      await failAdsAiAnalysisRun(run.runId, run.precheck, error).catch(() => {});
      results.push({ keywordId: run.input.context.keywordId, runId: run.runId, status: "FAILED", source: "RULE_ENGINE", error: error.message });
    }
  }
  const plan = splitAdsAiBatchRuns(modelRuns);
  for (let index = 0; index < plan.chunks.length; index += 1) {
    const chunk = plan.chunks[index];
    const keywordIds = chunk.runs.map(run => run.input.context.keywordId);
    try {
      const result = await executeAdsAiBatchAnalysisRuns(chunk.runs);
      results.push(...result.results.map(item => ({ ...item, source: "CCAI", chunk: index + 1 })));
      const chunkFailedCount = result.results.filter(item => item.status === "FAILED").length;
      chunkResults.push({
        index: index + 1,
        status: chunkFailedCount ? (chunkFailedCount === result.results.length ? "FAILED" : "PARTIAL") : "COMPLETE",
        keywordIds,
        inputChars: chunk.inputChars,
        failedCount: chunkFailedCount,
        output: result.rawOutput
      });
    } catch (error) {
      const failed = chunk.runs.map(run => ({
        keywordId: run.input.context.keywordId, runId: run.runId, status: "FAILED", source: "CCAI", chunk: index + 1, error: error.message
      }));
      results.push(...failed);
      chunkResults.push({ index: index + 1, status: "FAILED", keywordIds, inputChars: chunk.inputChars, error: error.message });
    }
  }
  const completeCount = results.filter(item => item.status === "COMPLETE").length;
  const failedCount = results.length - completeCount;
  return {
    status: failedCount === 0 ? "COMPLETE" : completeCount > 0 ? "PARTIAL" : "FAILED",
    summary: {
      keywordCount: runs.length,
      ruleEngineCount: precheckedRuns.length,
      ccaiKeywordCount: modelRuns.length,
      ccaiChunkCount: plan.chunks.length,
      completeCount,
      failedCount,
      limits: plan.limits
    },
    results,
    chunks: chunkResults
  };
}

async function startDailyAdsAiBatch(profile, scheduleDate, options = {}) {
  const pool = getMysqlPool();
  const batchId = randomUUID();
  let runs = [];
  // 时区规则切换或部署重启时，避免 20 小时内重复产生一轮付费 DAILY 分析。
  const [recentBatchRows] = await pool.query(`
    SELECT id FROM ads_ai_batch_runs
    WHERE profile_id = ? AND trigger_source = 'DAILY' AND status NOT IN ('FAILED', 'PARTIAL') AND started_at >= DATE_SUB(NOW(), INTERVAL 20 HOUR)
    ORDER BY started_at DESC LIMIT 1
  `, [String(profile.profileId)]);
  if (recentBatchRows[0]) {
    await pool.query(`
      INSERT IGNORE INTO ads_ai_batch_runs (
        id, profile_id, trigger_source, schedule_date, status, output_payload, last_error, completed_at
      ) VALUES (?, ?, 'DAILY', ?, 'SKIPPED', CAST(? AS JSON), ?, NOW())
    `, [batchId, String(profile.profileId), scheduleDate, JSON.stringify({ reason: "RECENTLY_RUN", previousBatchId: recentBatchRows[0].id }), "20 小时内已有每日分析，已避免时区切换造成重复扣费"]);
    return { started: false, reason: "RECENTLY_RUN" };
  }
  const [batchInsert] = await pool.query(`
    INSERT IGNORE INTO ads_ai_batch_runs (id, profile_id, trigger_source, schedule_date, status)
    VALUES (?, ?, 'DAILY', ?, 'RUNNING')
  `, [batchId, String(profile.profileId), scheduleDate]);
  if (!Number(batchInsert.affectedRows || 0)) return { started: false, reason: "ALREADY_RUN" };
  try {
    await expireStaleAdsAiAnalysisRuns(profile.profileId);
    const [goalRows] = await pool.query(`
      SELECT g.keyword_id, k.parent_asin
      FROM ads_ai_keyword_goals g
      JOIN ads_keywords k ON k.id = g.keyword_id
      WHERE g.profile_id = ? AND k.lifecycle_status = 'ACTIVE' AND TRIM(g.goal_text) <> ''
      ORDER BY g.updated_at, g.keyword_id
    `, [String(profile.profileId)]);
    const skipped = [];
    for (const goal of goalRows) {
      const keywordId = String(goal.keyword_id);
      const keyword = { id: keywordId, parent_asin: goal.parent_asin };
      const reservation = await reserveAdsAiAnalysisRun(profile, keyword);
      if (reservation.guard) {
        skipped.push({ keywordId, parentAsin: goal.parent_asin, reason: reservation.guard.state, blockedByRunId: reservation.guard.runId });
        continue;
      }
      runs.push(reservation.run);
    }
    await pool.query(`
      UPDATE ads_ai_batch_runs
      SET keyword_count = ?, input_payload = CAST(? AS JSON)
      WHERE id = ?
    `, [runs.length, JSON.stringify({ runs: runs.map(run => ({ runId: run.runId, input: run.input })), skipped }), batchId]);
    if (!runs.length) {
      await pool.query("UPDATE ads_ai_batch_runs SET status = 'COMPLETE', output_payload = CAST(? AS JSON), completed_at = NOW() WHERE id = ?", [JSON.stringify({ results: [], skipped }), batchId]);
      return { started: false, reason: "NO_ELIGIBLE_KEYWORDS", skippedCount: skipped.length };
    }
    const job = executeChunkedAdsAiBatchAnalysisRuns(runs)
      .then(async result => {
        const lastError = result.status === "COMPLETE" ? null : `${result.summary.failedCount} 个关键词分析失败`;
        await pool.query("UPDATE ads_ai_batch_runs SET status = ?, output_payload = CAST(? AS JSON), last_error = ?, completed_at = NOW() WHERE id = ?", [result.status, JSON.stringify(result), lastError, batchId]);
        return result;
      })
      .catch(async error => {
        await pool.query("UPDATE ads_ai_batch_runs SET status = 'FAILED', last_error = ?, completed_at = NOW() WHERE id = ?", [error.message, batchId]);
        console.error(`Daily AI batch ${batchId} failed: ${error.message}`);
        return { status: "FAILED", error: error.message };
      })
      .finally(() => runs.forEach(run => adsAiAnalysisJobs.delete(run.input.context.keywordId)));
    runs.forEach(run => adsAiAnalysisJobs.set(run.input.context.keywordId, job));
    if (options.waitForCompletion) {
      const result = await job;
      if (result.status !== "COMPLETE") throw new Error(result.error || `${result.summary?.failedCount || 0} 个关键词 AI 分析失败`);
      return { started: true, batchId, keywordCount: runs.length, skippedCount: skipped.length, status: result.status };
    }
    return { started: true, batchId, keywordCount: runs.length, skippedCount: skipped.length };
  } catch (error) {
    await Promise.all(runs.map(run => failAdsAiAnalysisRun(run.runId, null, error).catch(() => {})));
    await pool.query("UPDATE ads_ai_batch_runs SET status = 'FAILED', last_error = ?, completed_at = NOW() WHERE id = ?", [error.message, batchId]);
    throw error;
  }
}

async function runDueDailyAdsAiBatch() {
  if (["0", "false"].includes(String(process.env.ADS_AI_DAILY_ANALYSIS_ENABLED || "").toLowerCase())) return;
  const profile = await readAdsProfileSelection();
  if (!profile?.profileId) return;
  const strategy = await readLatestAdsAiStrategy(profile.profileId);
  if (!strategy.rules.schedule?.dailyBatchEnabled) return;
  const timeZone = ADS_AI_SCHEDULE_TIME_ZONE;
  const now = getZonedParts(new Date(), timeZone);
  const nowTime = `${String(now.hour).padStart(2, "0")}:${String(now.minute).padStart(2, "0")}`;
  if (nowTime < strategy.rules.schedule.dailyBatchTime) return;
  await startDailyAdsAiBatch(profile, formatDateInTimeZone(new Date(), timeZone));
}

function startDailyAdsAiBatchSchedule() {
  if (adsAiDailyScheduleTimer) return;
  const tick = () => runDueDailyAdsAiBatch().catch(error => console.error(`Daily AI schedule failed: ${error.message}`));
  tick();
  adsAiDailyScheduleTimer = setInterval(tick, 60_000);
}

function mapAdsAiRecommendation(row) {
  return {
    id: row.id, analysisRunId: row.analysis_run_id, actionType: row.action_type,
    target: parseMysqlJson(row.target_payload) || {}, before: parseMysqlJson(row.before_payload) || {},
    after: parseMysqlJson(row.after_payload) || {}, reason: row.reason_text, risk: row.risk_text || "",
    evidence: parseMysqlJson(row.evidence_payload) || [], confidence: Number(row.confidence || 0),
    observeDays: Number(row.observe_days || 0), status: row.status,
    executionResult: parseMysqlJson(row.execution_result), error: row.last_error || "",
    confirmedAt: row.confirmed_at, executedAt: row.executed_at, reviewDueAt: row.review_due_at,
    reviewedAt: row.reviewed_at, createdAt: row.created_at, updatedAt: row.updated_at
  };
}

async function readAdsAiKeywordState(keywordId, preferredRunId = "") {
  const { profile, keyword } = await requireAdsAiKeyword(keywordId);
  const pool = getMysqlPool();
  const strategy = await readLatestAdsAiStrategy(profile.profileId);
  const goal = await readAdsAiKeywordGoal(keyword.id, profile.profileId);
  const [runRows] = await pool.query(`
    SELECT id, status, model_name, prompt_version, strategy_version, output_payload, validation_error,
      started_at, completed_at, created_at
    FROM ads_ai_analysis_runs
    WHERE keyword_id = ? AND profile_id = ?
    ORDER BY (id = ?) DESC, created_at DESC LIMIT 1
  `, [keyword.id, String(profile.profileId), preferredRunId || ""]);
  const latestRun = runRows[0] ? {
    id: runRows[0].id, status: runRows[0].status, model: runRows[0].model_name,
    promptVersion: runRows[0].prompt_version, strategyVersion: Number(runRows[0].strategy_version),
    output: parseMysqlJson(runRows[0].output_payload), error: runRows[0].validation_error || "",
    startedAt: runRows[0].started_at, completedAt: runRows[0].completed_at, createdAt: runRows[0].created_at
  } : null;
  const [recommendationRows] = await pool.query(`
    SELECT * FROM ads_ai_recommendations
    WHERE keyword_id = ? AND profile_id = ?
    ORDER BY created_at DESC, id DESC LIMIT 30
  `, [keyword.id, String(profile.profileId)]);
  return {
    configured: Boolean(process.env.OPENAI_API_KEY),
    keyword: { id: String(keyword.id), text: keyword.keyword_text, group: keyword.keyword_group, parentAsin: keyword.parent_asin },
    goal,
    strategy,
    latestRun,
    recommendations: recommendationRows.map(mapAdsAiRecommendation),
    analysisGuard: await readAdsAiAsinAnalysisGuard(profile.profileId, keyword.parent_asin)
  };
}

async function readAdsAiAnalysisHistory(keywordId, requestedLimit = 20) {
  const { profile, keyword } = await requireAdsAiKeyword(keywordId);
  const pool = getMysqlPool();
  const limit = Math.round(adsAiNumber(requestedLimit, 20, 1, 50));
  const [runRows] = await pool.query(`
    SELECT id, status, model_name, prompt_version, strategy_version, input_payload, output_payload,
      validation_error, started_at, completed_at, created_at
    FROM ads_ai_analysis_runs
    WHERE keyword_id = ? AND profile_id = ?
    ORDER BY created_at DESC LIMIT ?
  `, [keyword.id, String(profile.profileId), limit]);
  const runIds = runRows.map(row => row.id);
  let recommendationRows = [];
  if (runIds.length) {
    [recommendationRows] = await pool.query(`
      SELECT * FROM ads_ai_recommendations
      WHERE analysis_run_id IN (?)
      ORDER BY created_at ASC, id ASC
    `, [runIds]);
  }
  const recommendationsByRun = new Map();
  for (const row of recommendationRows) {
    const list = recommendationsByRun.get(row.analysis_run_id) || [];
    list.push(mapAdsAiRecommendation(row));
    recommendationsByRun.set(row.analysis_run_id, list);
  }
  return {
    keyword: { id: String(keyword.id), text: keyword.keyword_text, group: keyword.keyword_group },
    runs: runRows.map(row => {
      const input = parseMysqlJson(row.input_payload) || {};
      const output = parseMysqlJson(row.output_payload) || {};
      return {
        id: row.id,
        status: row.status,
        model: row.model_name || "",
        promptVersion: row.prompt_version || "",
        strategyVersion: Number(row.strategy_version || 1),
        startedAt: row.started_at,
        completedAt: row.completed_at,
        createdAt: row.created_at,
        error: row.validation_error || "",
        goal: input.strategy?.keywordGoal || { text: "", constraints: {} },
        context: input.context || {},
        analysisSummary: String(output.analysisSummary || ""),
        signals: Array.isArray(output.signals) ? output.signals : [],
        recommendations: recommendationsByRun.get(row.id) || [],
        snapshotAvailable: Boolean(row.input_payload)
      };
    })
  };
}

async function readAdsAiAnalysisSnapshot(runId) {
  const profile = await requireSelectedAdsProfile();
  const pool = getMysqlPool();
  const [rows] = await pool.query(`
    SELECT r.id, r.keyword_id, r.status, r.model_name, r.prompt_version, r.strategy_version,
      r.input_payload, r.output_payload, r.validation_error, r.started_at, r.completed_at,
      k.keyword_text
    FROM ads_ai_analysis_runs r
    JOIN ads_keywords k ON k.id = r.keyword_id
    WHERE r.id = ? AND r.profile_id = ?
    LIMIT 1
  `, [runId, String(profile.profileId)]);
  if (!rows[0]) throw new Error("分析历史不存在");
  const [recommendationRows] = await pool.query(`
    SELECT * FROM ads_ai_recommendations
    WHERE analysis_run_id = ? ORDER BY created_at ASC, id ASC
  `, [runId]);
  const row = rows[0];
  return {
    run: {
      id: row.id, keywordId: String(row.keyword_id), keyword: row.keyword_text,
      status: row.status, model: row.model_name || "", promptVersion: row.prompt_version || "",
      strategyVersion: Number(row.strategy_version || 1), error: row.validation_error || "",
      startedAt: row.started_at, completedAt: row.completed_at
    },
    input: parseMysqlJson(row.input_payload) || {},
    output: parseMysqlJson(row.output_payload) || {},
    recommendations: recommendationRows.map(mapAdsAiRecommendation)
  };
}

async function decideAdsAiRecommendation(recommendationId, decision) {
  const profile = await requireSelectedAdsProfile();
  const requested = String(decision || "").toUpperCase();
  const nextStatus = ["REJECTED", "ACKNOWLEDGED"].includes(requested) ? requested : "";
  if (!nextStatus) throw new Error("不支持的建议处理方式");
  const pool = getMysqlPool();
  const [result] = await pool.query(`
    UPDATE ads_ai_recommendations SET status = ?
    WHERE id = ? AND profile_id = ? AND status IN ('PENDING', 'FAILED')
  `, [nextStatus, recommendationId, String(profile.profileId)]);
  if (!Number(result.affectedRows || 0)) throw new Error("建议不存在或状态已经变化");
  await rememberAdsAiRecommendationEvent(recommendationId, nextStatus === "ACKNOWLEDGED" ? "ACKNOWLEDGED" : "REJECTED", { decision: nextStatus });
  return { id: recommendationId, status: nextStatus };
}

async function assertAdsAiRecommendationFresh(row) {
  const pool = getMysqlPool();
  const target = parseMysqlJson(row.target_payload) || {};
  const before = parseMysqlJson(row.before_payload) || {};
  if (row.action_type === "CHANGE_BID") {
    const [rows] = await pool.query("SELECT bid FROM ads_ad_units WHERE id = ? AND profile_id = ?", [target.adUnitId, row.profile_id]);
    if (!rows[0] || !adsAiApproxEqual(rows[0].bid, before.bid)) throw new Error("当前竞价已变化，该建议已过期，请重新分析");
  } else if (["CHANGE_PLACEMENT_ADJUSTMENT", "CHANGE_DAILY_BUDGET"].includes(row.action_type)) {
    const [rows] = await pool.query("SELECT daily_budget, top_of_search_adjustment, rest_of_search_adjustment, product_page_adjustment FROM ads_campaigns WHERE id = ? AND profile_id = ?", [target.campaignId, row.profile_id]);
    const campaign = rows[0];
    if (!campaign || !adsAiApproxEqual(campaign.daily_budget, before.dailyBudget)
      || Number(campaign.top_of_search_adjustment) !== Number(before.topOfSearchAdjustment)
      || Number(campaign.rest_of_search_adjustment) !== Number(before.restOfSearchAdjustment)
      || Number(campaign.product_page_adjustment) !== Number(before.productPageAdjustment)) {
      throw new Error("Campaign 设置已变化，该建议已过期，请重新分析");
    }
  } else if (["PAUSE_CAMPAIGN", "RESUME_CAMPAIGN"].includes(row.action_type)) {
    const [rows] = await pool.query("SELECT desired_state FROM ads_campaigns WHERE id = ? AND profile_id = ?", [target.campaignId, row.profile_id]);
    if (!rows[0] || rows[0].desired_state !== before.state) throw new Error("Campaign 状态已变化，该建议已过期，请重新分析");
  } else if (row.action_type === "MOVE_GROUP") {
    const [rows] = await pool.query("SELECT keyword_group FROM ads_keywords WHERE id = ? AND profile_id = ?", [row.keyword_id, row.profile_id]);
    if (!rows[0] || rows[0].keyword_group !== before.group) throw new Error("关键词分组已变化，该建议已过期，请重新分析");
  }
}

async function executeAdsAiRecommendation(recommendationId, body = {}) {
  if (body.confirmed !== true) throw new Error("必须明确确认后才能执行 AI 建议");
  const profile = await requireSelectedAdsProfile();
  const pool = getMysqlPool();
  const [rows] = await pool.query(`
    SELECT * FROM ads_ai_recommendations WHERE id = ? AND profile_id = ?
  `, [recommendationId, String(profile.profileId)]);
  const row = rows[0];
  if (!row || row.status !== "PENDING") throw new Error("建议不存在或已处理");
  if (["REQUEST_MORE_DATA", "NO_ACTION"].includes(row.action_type)) throw new Error("该建议不包含可执行的广告操作");
  const target = parseMysqlJson(row.target_payload) || {};
  const after = parseMysqlJson(row.after_payload) || {};
  const [claimResult] = await pool.query(`
    UPDATE ads_ai_recommendations
    SET status = 'EXECUTING', confirmed_at = NOW(), last_error = NULL
    WHERE id = ? AND profile_id = ? AND status = 'PENDING'
  `, [recommendationId, String(profile.profileId)]);
  if (!Number(claimResult.affectedRows || 0)) throw new Error("建议已被处理，请刷新后重试");
  try {
    await rememberAdsAiRecommendationEvent(recommendationId, "USER_CONFIRMED", { confirmed: true });
    await assertAdsAiRecommendationFresh(row);
    await rememberAdsAiRecommendationEvent(recommendationId, "EXECUTION_STARTED", { actionType: row.action_type, target, after });
    let result;
    if (row.action_type === "CHANGE_BID") {
      result = await updateAdsAdUnitBid(target.adUnitId, { bid: after.bid });
    } else if (["CHANGE_PLACEMENT_ADJUSTMENT", "CHANGE_DAILY_BUDGET"].includes(row.action_type)) {
      result = await updateAdsCampaignSettings(target.campaignId, after);
    } else if (row.action_type === "PAUSE_CAMPAIGN") {
      result = await setAdsCampaignState(target.campaignId, "PAUSED");
    } else if (row.action_type === "RESUME_CAMPAIGN") {
      result = await setAdsCampaignState(target.campaignId, "ENABLED");
    } else if (row.action_type === "MOVE_GROUP") {
      result = await updateAdsKeywordGroup(row.keyword_id, after.group);
    } else {
      throw new Error("尚不支持执行该建议类型");
    }
    await pool.query(`
      UPDATE ads_ai_recommendations
      SET status = 'EXECUTED', execution_result = CAST(? AS JSON), executed_at = NOW(),
        review_due_at = DATE_ADD(NOW(), INTERVAL ? DAY), last_error = NULL
      WHERE id = ?
    `, [JSON.stringify(result || {}), Number(row.observe_days || 3), recommendationId]);
    await rememberAdsAiRecommendationEvent(recommendationId, "EXECUTED", result || {});
    return { id: recommendationId, status: "EXECUTED", result };
  } catch (error) {
    await pool.query("UPDATE ads_ai_recommendations SET status = 'FAILED', last_error = ? WHERE id = ?", [error.message, recommendationId]);
    await rememberAdsAiRecommendationEvent(recommendationId, "EXECUTION_FAILED", { error: error.message });
    throw error;
  }
}

async function readAdsDateStatus() {
  const profile = await requireSelectedAdsProfile();
  const pool = getMysqlPool();
  const [rows] = await pool.query(`
    SELECT date, report_type, status, synced_at, last_error
    FROM ads_sync_dates
    WHERE profile_id = ?
    ORDER BY date
  `, [String(profile.profileId)]);
  const byDate = new Map();
  for (const row of rows) {
    const date = adsDateValue(row.date);
    const item = byDate.get(date) || { date, reports: {}, errors: [] };
    item.reports[row.report_type] = String(row.status || "").toUpperCase();
    if (row.last_error) item.errors.push(String(row.last_error));
    byDate.set(date, item);
  }
  return {
    dates: [...byDate.values()].map(item => {
      const adGroupComplete = item.reports.AD_GROUP === "COMPLETE";
      const placementComplete = item.reports.PLACEMENT === "COMPLETE";
      return {
        date: item.date,
        // 关键词、子 ASIN 与核心表现指标均由 Ad Group 日报表提供；展示位置为可选补充数据。
        complete: adGroupComplete,
        partial: !adGroupComplete && placementComplete,
        adGroupComplete,
        placementComplete,
        error: item.errors.join("；")
      };
    })
  };
}

async function ensureAdsCreationTemplate(profile) {
  const pool = getMysqlPool();
  await pool.query(`
    INSERT INTO ads_creation_templates (profile_id, currency_code)
    VALUES (?, ?)
    ON DUPLICATE KEY UPDATE currency_code = VALUES(currency_code)
  `, [String(profile.profileId), profile.currencyCode || ""]);
  const [rows] = await pool.query("SELECT * FROM ads_creation_templates WHERE profile_id = ?", [String(profile.profileId)]);
  const row = rows[0];
  return {
    profileId: String(row.profile_id), currencyCode: row.currency_code || profile.currencyCode || "USD",
    dailyBudget: Number(row.daily_budget || 8), biddingStrategy: row.bidding_strategy || "FIXED_BIDS",
    defaultBid: Number(row.default_bid || 0.2), topOfSearchAdjustment: Number(row.top_of_search_adjustment || 200),
    restOfSearchAdjustment: Number(row.rest_of_search_adjustment || 0), productPageAdjustment: Number(row.product_page_adjustment || 0),
    matches: { EXACT: Boolean(row.exact_enabled), PHRASE: Boolean(row.phrase_enabled), BROAD: Boolean(row.broad_enabled) },
    initialState: row.initial_state || "ENABLED"
  };
}

async function createAdsKeywordDraft(body = {}, options = {}) {
  const profile = await requireSelectedAdsProfile();
  const parentAsin = String(body.parentAsin || "").trim().toUpperCase();
  const keywordText = normalizeAdsKeywordText(body.keyword);
  const group = adsKeywordGroup(body.group);
  const lifecycleStatus = body.lifecycleStatus === "CREATING" ? "CREATING" : "ACTIVE";
  if (!/^B[A-Z0-9]{9}$/.test(parentAsin)) throw new Error("请选择有效的父 ASIN");
  if (!keywordText) throw new Error("请输入关键词");
  if (keywordText.length > 255) throw new Error("关键词不能超过 255 个字符");
  const products = await readAdsProductCatalog();
  const product = products.find(item => item.parentAsin === parentAsin);
  if (!product) throw new Error("父 ASIN 不在 FBA 库存产品中");
  const requestedUnits = Array.isArray(body.units) ? body.units : [];
  const units = requestedUnits.map(unit => {
    const childAsin = String(unit.childAsin || "").trim().toUpperCase();
    const sellerSku = String(unit.sellerSku || "").trim();
    const candidate = product.children.find(item => item.asin === childAsin && item.sellerSku === sellerSku);
    if (!candidate) throw new Error(`子 ASIN ${childAsin || "-"} 与 Seller SKU ${sellerSku || "-"} 不属于所选父 ASIN`);
    return { childAsin, sellerSku };
  });
  if (units.length !== 1) throw new Error("一个关键词只能对应一个子 ASIN 和 Seller SKU");
  const template = await ensureAdsCreationTemplate(profile);
  const matches = [...new Set((Array.isArray(body.matches) ? body.matches : ["EXACT"]).map(value => String(value).toUpperCase()))]
    .filter(value => ["EXACT", "PHRASE", "BROAD"].includes(value));
  if (!matches.length) matches.push("EXACT");
  const dailyBudget = Number(body.dailyBudget ?? template.dailyBudget);
  const defaultBid = Number(body.defaultBid ?? template.defaultBid);
  const topAdjustment = Number(body.topOfSearchAdjustment ?? template.topOfSearchAdjustment);
  const restAdjustment = Number(body.restOfSearchAdjustment ?? template.restOfSearchAdjustment);
  const productPageAdjustment = Number(body.productPageAdjustment ?? template.productPageAdjustment);
  const adjustments = [topAdjustment, restAdjustment, productPageAdjustment];
  if (!(dailyBudget > 0) || !(defaultBid > 0) || adjustments.some(value => !Number.isInteger(value) || value > 900 || value < 0)) throw new Error("预算、出价或位置加价不合法");
  const portfolio = await readManagedAdsPortfolio(profile.profileId);
  const internalName = product.internalName || parentAsin;
  const startDate = formatDateInTimeZone(new Date(), profile.timezone || US_MARKETPLACE_TIME_ZONE);
  const normalizedKeyword = keywordText.toLocaleLowerCase("en-US");
  const creationBatch = newAdsCreationBatch();
  const activeScopeKey = adsActiveKeywordScopeKey(profile.profileId, parentAsin, normalizedKeyword, units[0].childAsin);
  const pool = getMysqlPool();
  const [existingActive] = await pool.query("SELECT id FROM ads_keywords WHERE active_scope_key = ? AND lifecycle_status IN ('ACTIVE', 'CREATING', 'STOPPING') LIMIT 1", [activeScopeKey]);
  const [existingUnit] = await pool.query(`
    SELECT k.id FROM ads_keywords k
    JOIN ads_campaigns c ON c.keyword_id = k.id AND c.lifecycle_status <> 'STOPPED'
    JOIN ads_ad_units u ON u.campaign_id = c.id
    WHERE k.profile_id = ? AND k.parent_asin = ? AND k.normalized_keyword = ? AND k.lifecycle_status IN ('ACTIVE', 'CREATING', 'STOPPING')
      AND u.child_asin = ? LIMIT 1
  `, [String(profile.profileId), parentAsin, normalizedKeyword, units[0].childAsin]);
  if (existingActive.length || existingUnit.length) throw new Error(`子 ASIN ${units[0].childAsin} 已存在关键词“${keywordText}”；请选择其他子 ASIN，或停止现有投放后再添加`);
  if (!options.monitoringEnsured) {
    await ensureSifKeywordPairsMonitored([{ asin: units[0].childAsin, keyword: keywordText }]);
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [sortRows] = await connection.query(`
      SELECT COALESCE(MAX(sort_order), 0) + 10 next_sort_order
      FROM ads_keywords
      WHERE profile_id = ? AND parent_asin = ?
    `, [String(profile.profileId), parentAsin]);
    const sortOrder = Number(sortRows[0]?.next_sort_order || 10);
    const [keywordResult] = await connection.query(`
      INSERT INTO ads_keywords (
        profile_id, parent_asin, keyword_text, normalized_keyword, creation_batch, active_scope_key, keyword_group, sort_order, lifecycle_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [String(profile.profileId), parentAsin, keywordText, normalizedKeyword, creationBatch, activeScopeKey, group, sortOrder, lifecycleStatus]);
    const keywordId = keywordResult.insertId;
    for (const matchType of matches) {
      const unit = units[0];
      const campaignName = buildAdsCampaignName(internalName, parentAsin, unit.childAsin, keywordText, group, matchType, creationBatch);
      const campaignEntityKey = adsCampaignEntityKey(parentAsin, unit.childAsin, creationBatch, matchType);
      const [campaignResult] = await connection.query(`
        INSERT INTO ads_campaigns (
          keyword_id, profile_id, portfolio_id, match_type, child_asin, seller_sku, creation_batch, entity_key, campaign_name, desired_state,
          daily_budget, bidding_strategy, top_of_search_adjustment, rest_of_search_adjustment, product_page_adjustment, start_date
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ENABLED', ?, ?, ?, ?, ?, ?)
      `, [keywordId, String(profile.profileId), portfolio?.portfolioId || "", matchType, unit.childAsin, unit.sellerSku, creationBatch, campaignEntityKey, campaignName, dailyBudget, template.biddingStrategy, topAdjustment, restAdjustment, productPageAdjustment, startDate]);
      await connection.query(`
        INSERT INTO ads_ad_units (
          campaign_id, profile_id, child_asin, seller_sku, creation_batch, entity_key, ad_group_name, bid, desired_state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ENABLED')
      `, [
        campaignResult.insertId, String(profile.profileId), unit.childAsin, unit.sellerSku, creationBatch,
        adsAdUnitEntityKey(unit.childAsin, creationBatch, matchType), buildAdsAdGroupName(campaignName, unit.childAsin, {
          internalName, parentAsin, keyword: keywordText, group, matchType, creationBatch
        }), defaultBid
      ]);
    }
    await connection.commit();
    return { keywordId: String(keywordId), creationBatch };
  } catch (error) {
    await connection.rollback().catch(() => {});
    if (error?.code === "ER_DUP_ENTRY") throw new Error(`子 ASIN ${units[0].childAsin} 已存在或正在创建关键词“${keywordText}”`);
    throw error;
  } finally {
    connection.release();
  }
}

async function createAndStartAdsKeywordBatch(body = {}) {
  const keywords = Array.isArray(body.keywords) ? body.keywords : [];
  if (!keywords.length || keywords.length > 20) throw new Error("请添加 1 到 20 个关键词");
  const profile = await requireSelectedAdsProfile();
  const parentAsin = String(body.parentAsin || "").trim().toUpperCase();
  const units = Array.isArray(body.units) ? body.units : [];
  if (!units.length) throw new Error("请至少选择一个投放商品");
  const planned = [];
  const plannedKeys = new Set();
  for (const item of keywords) {
    const keyword = normalizeAdsKeywordText(item?.keyword);
    if (!keyword) throw new Error("请填写每一行关键词");
    for (const unit of units) {
      const childAsin = String(unit?.childAsin || "").trim().toUpperCase();
      const key = `${keyword.toLocaleLowerCase("en-US")}|${childAsin}`;
      if (plannedKeys.has(key)) throw new Error(`添加列表重复：关键词“${keyword}”已选择子 ASIN ${childAsin}`);
      plannedKeys.add(key);
      planned.push({ keyword, childAsin });
    }
  }
  const pool = getMysqlPool();
  const [existing] = await pool.query(`
    SELECT DISTINCT k.keyword_text, k.normalized_keyword, u.child_asin
    FROM ads_keywords k
    JOIN ads_campaigns c ON c.keyword_id = k.id AND c.lifecycle_status <> 'STOPPED'
    JOIN ads_ad_units u ON u.campaign_id = c.id
    WHERE k.profile_id = ? AND k.parent_asin = ? AND k.lifecycle_status IN ('ACTIVE', 'CREATING', 'STOPPING')
  `, [String(profile.profileId), parentAsin]);
  const existingKeys = new Set(existing.map(row => `${String(row.normalized_keyword || "").toLocaleLowerCase("en-US")}|${String(row.child_asin || "").toUpperCase()}`));
  const conflict = planned.find(item => existingKeys.has(`${item.keyword.toLocaleLowerCase("en-US")}|${item.childAsin}`));
  if (conflict) throw new Error(`已存在或正在创建：关键词“${conflict.keyword}”对应子 ASIN ${conflict.childAsin}`);
  await ensureSifKeywordPairsMonitored(planned.map(item => ({ asin: item.childAsin, keyword: item.keyword })));
  const common = {
    parentAsin: body.parentAsin,
    dailyBudget: body.dailyBudget,
    defaultBid: body.defaultBid,
    topOfSearchAdjustment: body.topOfSearchAdjustment,
    restOfSearchAdjustment: body.restOfSearchAdjustment,
    productPageAdjustment: body.productPageAdjustment,
    matches: body.matches,
    lifecycleStatus: "CREATING"
  };
  const created = [];
  for (const item of keywords) {
    for (const unit of units) {
      const result = await createAdsKeywordDraft({ ...common, keyword: item.keyword, group: item.group, units: [unit] }, { monitoringEnsured: true });
      created.push(result);
    }
  }
  const operations = await Promise.all(created.map(async item => {
    const preview = await buildAdsCreationPreview(item.keywordId);
    return { keywordId: item.keywordId, operationId: preview.operationId, confirmationToken: preview.confirmationToken };
  }));
  for (const operation of operations) {
    void confirmAdsCreationOperation(operation.operationId, operation.confirmationToken).catch(() => {});
  }
  return { keywordIds: created.map(item => item.keywordId), operations: operations.map(item => ({ keywordId: item.keywordId, operationId: item.operationId })) };
}

async function updateAdsKeywordGroup(keywordId, nextGroup) {
  const profile = await requireSelectedAdsProfile();
  const group = adsKeywordGroup(nextGroup);
  const pool = getMysqlPool();
  const [rows] = await pool.query("SELECT * FROM ads_keywords WHERE id = ? AND profile_id = ? AND lifecycle_status = 'ACTIVE'", [keywordId, String(profile.profileId)]);
  const keyword = rows[0];
  if (!keyword) throw new Error("关键词不存在");
  const names = await readParentAsinMetadataMap();
  const internalName = names.get(String(keyword.parent_asin).toUpperCase()) || keyword.parent_asin;
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query("UPDATE ads_keywords SET keyword_group = ? WHERE id = ?", [group, keywordId]);
    const [campaigns] = await connection.query("SELECT id, match_type FROM ads_campaigns WHERE keyword_id = ?", [keywordId]);
    for (const campaign of campaigns) {
      const campaignName = buildAdsCampaignName(
        internalName, keyword.parent_asin, campaign.child_asin || "LEGACY", keyword.keyword_text, group, campaign.match_type, keyword.creation_batch || ""
      );
      await connection.query("UPDATE ads_campaigns SET campaign_name = ?, sync_status = IF(amazon_campaign_id IS NULL, 'LOCAL_ONLY', 'PENDING') WHERE id = ?", [campaignName, campaign.id]);
      const [units] = await connection.query("SELECT id, child_asin FROM ads_ad_units WHERE campaign_id = ?", [campaign.id]);
      for (const unit of units) {
        await connection.query("UPDATE ads_ad_units SET ad_group_name = ?, sync_status = IF(amazon_ad_group_id IS NULL, 'LOCAL_ONLY', 'PENDING') WHERE id = ?", [buildAdsAdGroupName(campaignName, unit.child_asin, {
          internalName, parentAsin: keyword.parent_asin, keyword: keyword.keyword_text, group,
          matchType: campaign.match_type, creationBatch: keyword.creation_batch || ""
        }), unit.id]);
      }
    }
    await connection.commit();
    await syncAdsKeywordNames(keywordId);
    return { keywordId: String(keywordId), group };
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

async function createAdsAdditionalMatchDraft(keywordId, rawMatchType) {
  const profile = await requireSelectedAdsProfile();
  const matchType = String(rawMatchType || "").toUpperCase();
  if (!['EXACT', 'PHRASE', 'BROAD'].includes(matchType)) throw new Error("匹配方式不合法");
  const pool = getMysqlPool();
  const [keywordRows] = await pool.query("SELECT * FROM ads_keywords WHERE id = ? AND profile_id = ? AND lifecycle_status = 'ACTIVE'", [keywordId, String(profile.profileId)]);
  const keyword = keywordRows[0];
  if (!keyword) throw new Error("关键词不存在");
  const [existingRows] = await pool.query("SELECT id FROM ads_campaigns WHERE keyword_id = ? AND profile_id = ? AND match_type = ? AND lifecycle_status <> 'STOPPED' LIMIT 1", [keyword.id, String(profile.profileId), matchType]);
  const matchLabel = { EXACT: "精准", PHRASE: "词组", BROAD: "广泛" }[matchType];
  if (existingRows.length) throw new Error(`${matchLabel}已添加，请直接预览并创建或继续处理`);
  const [sourceRows] = await pool.query(`
    SELECT * FROM ads_campaigns
    WHERE keyword_id = ? AND profile_id = ?
    ORDER BY FIELD(match_type, 'EXACT', 'PHRASE', 'BROAD'), id
    LIMIT 1
  `, [keyword.id, String(profile.profileId)]);
  const source = sourceRows[0];
  if (!source) throw new Error("没有可复制的现有投放设置");
  const [sourceUnits] = await pool.query("SELECT * FROM ads_ad_units WHERE campaign_id = ? AND profile_id = ? ORDER BY id LIMIT 1", [source.id, String(profile.profileId)]);
  if (!sourceUnits.length) throw new Error("现有匹配方式没有投放商品");
  const sourceUnit = sourceUnits[0];
  const names = await readParentAsinMetadataMap();
  const internalName = names.get(String(keyword.parent_asin).toUpperCase()) || keyword.parent_asin;
  const creationBatch = newAdsCreationBatch();
  const campaignName = buildAdsCampaignName(internalName, keyword.parent_asin, sourceUnit.child_asin, keyword.keyword_text, keyword.keyword_group, matchType, creationBatch);
  const startDate = formatDateInTimeZone(new Date(), profile.timezone || US_MARKETPLACE_TIME_ZONE);
  const portfolio = await readManagedAdsPortfolio(profile.profileId);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [lockedExisting] = await connection.query("SELECT id FROM ads_campaigns WHERE keyword_id = ? AND profile_id = ? AND match_type = ? AND lifecycle_status <> 'STOPPED' FOR UPDATE", [keyword.id, String(profile.profileId), matchType]);
    if (lockedExisting.length) throw new Error(`${matchLabel}已在创建或已添加，不能重复添加`);
    const [campaignResult] = await connection.query(`
      INSERT INTO ads_campaigns (
        keyword_id, profile_id, portfolio_id, match_type, child_asin, seller_sku, creation_batch, entity_key, campaign_name, desired_state,
        daily_budget, bidding_strategy, top_of_search_adjustment, rest_of_search_adjustment, product_page_adjustment, start_date, creation_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CREATING')
    `, [
      keyword.id, String(profile.profileId), portfolio?.portfolioId || source.portfolio_id || "", matchType, sourceUnit.child_asin, sourceUnit.seller_sku, creationBatch,
      adsCampaignEntityKey(keyword.parent_asin, sourceUnit.child_asin, creationBatch, matchType), campaignName, source.desired_state,
      source.daily_budget, source.bidding_strategy, source.top_of_search_adjustment, source.rest_of_search_adjustment,
      source.product_page_adjustment, startDate
    ]);
    {
      const unit = sourceUnit;
      await connection.query(`
        INSERT INTO ads_ad_units (
          campaign_id, profile_id, child_asin, seller_sku, creation_batch, entity_key, ad_group_name, bid, desired_state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        campaignResult.insertId, String(profile.profileId), unit.child_asin, unit.seller_sku, creationBatch,
        adsAdUnitEntityKey(unit.child_asin, creationBatch, matchType), buildAdsAdGroupName(campaignName, unit.child_asin, {
          internalName, parentAsin: keyword.parent_asin, keyword: keyword.keyword_text, group: keyword.keyword_group,
          matchType, creationBatch
        }), unit.bid, unit.desired_state
      ]);
    }
    await connection.commit();
    return buildAdsCreationPreview(String(keyword.id), { matchTypes: [matchType], preserveExistingKeyword: true });
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

function adsOperationTokenHash(token) {
  return createHash("sha256").update(String(token || "")).digest("hex");
}

function stableJsonStringify(value) {
  if (Array.isArray(value)) return `[${value.map(item => stableJsonStringify(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJsonStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function adsPreviewHash(preview) {
  return createHash("sha256").update(stableJsonStringify(preview)).digest("hex");
}

async function buildAdsCreationPreview(keywordId, options = {}) {
  const profile = await requireSelectedAdsProfile();
  const portfolio = await readManagedAdsPortfolio(profile.profileId);
  if (portfolio?.status && !["READY", "MISSING"].includes(portfolio.status)) throw new Error(portfolio.error || "广告组合隔离检查未通过");
  const pool = getMysqlPool();
  const [keywords] = await pool.query("SELECT * FROM ads_keywords WHERE id = ? AND profile_id = ? AND lifecycle_status IN ('ACTIVE', 'CREATING')", [keywordId, String(profile.profileId)]);
  const keyword = keywords[0];
  if (!keyword) throw new Error("关键词不存在");
  const matchTypes = [...new Set(Array.isArray(options.matchTypes) ? options.matchTypes.map(value => String(value).toUpperCase()) : [])]
    .filter(value => ['EXACT', 'PHRASE', 'BROAD'].includes(value));
  const campaignWhere = ["keyword_id = ?", "profile_id = ?", "lifecycle_status <> 'STOPPED'"];
  const campaignParams = [keywordId, String(profile.profileId)];
  if (matchTypes.length) {
    campaignWhere.push("match_type IN (?)");
    campaignParams.push(matchTypes);
  }
  const [campaigns] = await pool.query(`SELECT * FROM ads_campaigns WHERE ${campaignWhere.join(" AND ")} ORDER BY FIELD(match_type, 'EXACT', 'PHRASE', 'BROAD')`, campaignParams);
  if (!campaigns.length) throw new Error("这个关键词还没有待创建的匹配方式");
  const campaignIds = campaigns.map(item => item.id);
  const [units] = await pool.query("SELECT * FROM ads_ad_units WHERE campaign_id IN (?) ORDER BY child_asin", [campaignIds]);
  const preview = {
    profile: {
      profileId: String(profile.profileId), countryCode: profile.countryCode || "", currencyCode: profile.currencyCode || "",
      timezone: profile.timezone || "", accountName: profile.accountName || ""
    },
    portfolio: {
      action: portfolio?.status === "READY" ? "USE_EXISTING" : "CREATE",
      name: ADS_MANAGED_PORTFOLIO_NAME,
      portfolioId: portfolio?.portfolioId || ""
    },
    keyword: {
      id: String(keyword.id), parentAsin: keyword.parent_asin, text: keyword.keyword_text,
      group: keyword.keyword_group, creationBatch: keyword.creation_batch || ""
    },
    preserveExistingKeyword: Boolean(options.preserveExistingKeyword),
    campaigns: campaigns.map(campaign => ({
      localId: String(campaign.id), action: campaign.amazon_campaign_id ? "REUSE" : "CREATE",
      amazonCampaignId: campaign.amazon_campaign_id || "", name: campaign.campaign_name, adType: campaign.ad_type,
      creationBatch: campaign.creation_batch || "", entityKey: campaign.entity_key || "",
      matchType: campaign.match_type, state: campaign.desired_state, dailyBudget: Number(campaign.daily_budget),
      biddingStrategy: campaign.bidding_strategy, topOfSearchAdjustment: Number(campaign.top_of_search_adjustment),
      restOfSearchAdjustment: Number(campaign.rest_of_search_adjustment || 0), productPageAdjustment: Number(campaign.product_page_adjustment || 0),
      startDate: adsDateValue(campaign.start_date), endDate: adsDateValue(campaign.end_date),
      adGroups: units.filter(unit => String(unit.campaign_id) === String(campaign.id)).map(unit => ({
        localId: String(unit.id), action: unit.amazon_ad_group_id ? "RESUME" : "CREATE",
        name: unit.ad_group_name, childAsin: unit.child_asin, sellerSku: unit.seller_sku,
        creationBatch: unit.creation_batch || "", entityKey: unit.entity_key || "",
        bid: Number(unit.bid), state: unit.desired_state,
        amazonAdGroupId: unit.amazon_ad_group_id || "", amazonProductAdId: unit.amazon_product_ad_id || "", amazonTargetId: unit.amazon_target_id || ""
      }))
    }))
  };
  const operationId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const previewHash = adsPreviewHash(preview);
  const expiresAt = new Date(Date.now() + 15 * 60_000);
  await pool.query(`
    INSERT INTO ads_operations (
      id, profile_id, operation_type, entity_type, entity_id, status, preview_hash,
      confirmation_token_hash, confirmation_expires_at, request_payload, preview_payload
    ) VALUES (?, ?, 'AD_CREATE', 'KEYWORD', ?, 'PREVIEW', ?, ?, ?, CAST(? AS JSON), CAST(? AS JSON))
  `, [operationId, String(profile.profileId), keyword.id, previewHash, adsOperationTokenHash(token), expiresAt, JSON.stringify({ keywordId: String(keyword.id) }), JSON.stringify(preview)]);
  return { operationId, confirmationToken: token, expiresAt: expiresAt.toISOString(), preview };
}

function adsV3ResultId(data, resourceKey, idKey) {
  const container = data?.[resourceKey] || data;
  const success = adsArrayPayload(container, ["success", resourceKey]);
  const item = success[0] || container?.success?.[0] || data?.success?.[0] || null;
  const id = item?.[idKey] || item?.entityId || item?.id || "";
  if (id) return String(id);
  const errors = adsArrayPayload(container, ["error", "errors"]);
  const detail = errors[0]?.errorValue?.message || errors[0]?.message || data?.message || "Amazon Ads 未返回对象 ID";
  throw new Error(detail);
}

async function adsV3Create(pathname, mediaType, resourceKey, idKey, item) {
  const data = await adsFetch(pathname, {}, {
    requireProfile: true,
    method: "POST",
    headers: { accept: `application/vnd.${mediaType}.v3+json`, "content-type": `application/vnd.${mediaType}.v3+json` },
    body: { [resourceKey]: [item] }
  });
  return { id: adsV3ResultId(data, resourceKey, idKey), response: data };
}

async function adsV3Update(pathname, mediaType, resourceKey, item) {
  const data = await adsFetch(pathname, {}, {
    requireProfile: true,
    method: "PUT",
    headers: { accept: `application/vnd.${mediaType}.v3+json`, "content-type": `application/vnd.${mediaType}.v3+json` },
    body: { [resourceKey]: [item] }
  });
  const container = data?.[resourceKey] || data;
  const errors = adsArrayPayload(container, ["error", "errors"]);
  if (errors.length) throw new Error(errors[0]?.errorValue?.message || errors[0]?.message || "Amazon Ads 更新失败");
  return data;
}

function adsPlacementBidding(campaign) {
  return [
    ["PLACEMENT_TOP", campaign.top_of_search_adjustment],
    ["PLACEMENT_REST_OF_SEARCH", campaign.rest_of_search_adjustment],
    ["PLACEMENT_PRODUCT_PAGE", campaign.product_page_adjustment]
  ].map(([placement, percentage]) => ({ placement, percentage: Number(percentage || 0) }));
}

async function assertAdsWriteBoundary(profileId) {
  const profile = await requireSelectedAdsProfile();
  if (String(profile.profileId) !== String(profileId)) throw new Error("对象不属于当前 Profile");
  const portfolio = await refreshManagedAdsPortfolio();
  if (portfolio.status !== "READY" || !portfolio.portfolioId) throw new Error(portfolio.error || "AmzAllBlue_ERP 隔离检查未通过");
  return { profile, portfolio };
}

async function syncAdsKeywordNames(keywordId) {
  const profile = await requireSelectedAdsProfile();
  const pool = getMysqlPool();
  const [campaigns] = await pool.query("SELECT * FROM ads_campaigns WHERE keyword_id = ? AND profile_id = ?", [keywordId, String(profile.profileId)]);
  if (!campaigns.some(item => item.amazon_campaign_id)) return;
  await assertAdsWriteBoundary(profile.profileId);
  for (const campaign of campaigns) {
    if (campaign.amazon_campaign_id && campaign.amazon_campaign_name !== campaign.campaign_name) {
      try {
        await adsV3Update("/sp/campaigns", "spCampaign", "campaigns", { campaignId: String(campaign.amazon_campaign_id), name: campaign.campaign_name });
        await pool.query("UPDATE ads_campaigns SET amazon_campaign_name = ?, sync_status = 'SYNCED', failed_step = NULL, last_error = NULL WHERE id = ?", [campaign.campaign_name, campaign.id]);
      } catch (error) {
        await pool.query("UPDATE ads_campaigns SET sync_status = 'INCOMPLETE', failed_step = 'RENAME_CAMPAIGN', last_error = ? WHERE id = ?", [error.message, campaign.id]);
        throw error;
      }
    }
    const [units] = await pool.query("SELECT * FROM ads_ad_units WHERE campaign_id = ?", [campaign.id]);
    for (const unit of units) {
      if (!unit.amazon_ad_group_id || unit.amazon_ad_group_name === unit.ad_group_name) continue;
      try {
        await adsV3Update("/sp/adGroups", "spAdGroup", "adGroups", { adGroupId: String(unit.amazon_ad_group_id), campaignId: String(campaign.amazon_campaign_id), name: unit.ad_group_name });
        await pool.query("UPDATE ads_ad_units SET amazon_ad_group_name = ?, sync_status = 'SYNCED', failed_step = NULL, last_error = NULL WHERE id = ?", [unit.ad_group_name, unit.id]);
      } catch (error) {
        await pool.query("UPDATE ads_ad_units SET sync_status = 'INCOMPLETE', failed_step = 'RENAME_AD_GROUP', last_error = ? WHERE id = ?", [error.message, unit.id]);
        throw error;
      }
    }
  }
}

async function migrateLegacyAdsAsinNames(parentAsin, childAsin) {
  const profile = await requireSelectedAdsProfile();
  const parent = String(parentAsin || "").toUpperCase();
  const child = String(childAsin || "").toUpperCase();
  if (parent !== "B0GS752SQX" || child !== "B0GS6Y7LDG") throw new Error("本次仅允许修复已确认的 B0GS752SQX / B0GS6Y7LDG 历史命名");
  const pool = getMysqlPool();
  const [rows] = await pool.query(`
    SELECT c.*, k.parent_asin, k.keyword_text, k.keyword_group, u.id unit_id, u.child_asin unit_child_asin,
      u.seller_sku unit_seller_sku, u.ad_group_name, u.amazon_ad_group_id, u.amazon_ad_group_name
    FROM ads_campaigns c
    JOIN ads_keywords k ON k.id = c.keyword_id
    JOIN ads_ad_units u ON u.campaign_id = c.id
    WHERE c.profile_id = ? AND k.parent_asin = ? AND u.child_asin = ?
      AND (c.child_asin IS NULL OR c.child_asin <> ? OR c.campaign_name LIKE '%ASIN-LEGACY%')
    ORDER BY c.id, u.id
  `, [String(profile.profileId), parent, child, child]);
  if (!rows.length) return { updated: 0, objects: [] };
  await assertAdsWriteBoundary(profile.profileId);
  const names = await readParentAsinMetadataMap();
  const internalName = names.get(parent) || parent;
  const objects = [];
  for (const row of rows) {
    const campaignName = buildAdsCampaignName(internalName, parent, child, row.keyword_text, row.keyword_group, row.match_type, row.creation_batch || "");
    const adGroupName = buildAdsAdGroupName(campaignName, child, {
      internalName, parentAsin: parent, keyword: row.keyword_text, group: row.keyword_group,
      matchType: row.match_type, creationBatch: row.creation_batch || ""
    });
    await pool.query(`
      UPDATE ads_campaigns SET child_asin = ?, seller_sku = ?, campaign_name = ?,
        sync_status = IF(amazon_campaign_id IS NULL, 'LOCAL_ONLY', 'PENDING'), failed_step = NULL, last_error = NULL
      WHERE id = ?
    `, [child, row.unit_seller_sku, campaignName, row.id]);
    await pool.query("UPDATE ads_ad_units SET ad_group_name = ?, sync_status = IF(amazon_ad_group_id IS NULL, 'LOCAL_ONLY', 'PENDING'), failed_step = NULL, last_error = NULL WHERE id = ?", [adGroupName, row.unit_id]);
    try {
      if (row.amazon_campaign_id && row.amazon_campaign_name !== campaignName) {
        await adsV3Update("/sp/campaigns", "spCampaign", "campaigns", { campaignId: String(row.amazon_campaign_id), name: campaignName });
        await pool.query("UPDATE ads_campaigns SET amazon_campaign_name = ?, sync_status = 'SYNCED' WHERE id = ?", [campaignName, row.id]);
      }
      if (row.amazon_ad_group_id && row.amazon_ad_group_name !== adGroupName) {
        await adsV3Update("/sp/adGroups", "spAdGroup", "adGroups", { adGroupId: String(row.amazon_ad_group_id), campaignId: String(row.amazon_campaign_id), name: adGroupName });
        await pool.query("UPDATE ads_ad_units SET amazon_ad_group_name = ?, sync_status = 'SYNCED' WHERE id = ?", [adGroupName, row.unit_id]);
      }
      objects.push({ campaignId: String(row.id), amazonCampaignId: row.amazon_campaign_id || "", campaignName, adGroupName, status: "SYNCED" });
    } catch (error) {
      await pool.query("UPDATE ads_campaigns SET sync_status = 'INCOMPLETE', failed_step = 'RENAME_LEGACY_ASIN', last_error = ? WHERE id = ?", [error.message, row.id]);
      await pool.query("UPDATE ads_ad_units SET sync_status = 'INCOMPLETE', failed_step = 'RENAME_LEGACY_ASIN', last_error = ? WHERE id = ?", [error.message, row.unit_id]);
      objects.push({ campaignId: String(row.id), amazonCampaignId: row.amazon_campaign_id || "", campaignName, adGroupName, status: "INCOMPLETE", error: error.message });
    }
  }
  return { updated: objects.filter(item => item.status === "SYNCED").length, objects };
}

async function setAdsCampaignState(campaignLocalId, desiredState) {
  const state = String(desiredState || "").toUpperCase();
  if (!["ENABLED", "PAUSED"].includes(state)) throw new Error("广告状态不合法");
  const profile = await requireSelectedAdsProfile();
  const pool = getMysqlPool();
  const [rows] = await pool.query("SELECT * FROM ads_campaigns WHERE id = ? AND profile_id = ?", [campaignLocalId, String(profile.profileId)]);
  const campaign = rows[0];
  if (!campaign) throw new Error("Campaign 不存在");
  await pool.query("UPDATE ads_campaigns SET desired_state = ?, sync_status = 'PENDING' WHERE id = ?", [state, campaign.id]);
  if (!campaign.amazon_campaign_id) return { state, localOnly: true };
  await assertAdsWriteBoundary(profile.profileId);
  try {
    await adsV3Update("/sp/campaigns", "spCampaign", "campaigns", { campaignId: String(campaign.amazon_campaign_id), state });
    await pool.query("UPDATE ads_campaigns SET desired_state = ?, amazon_state = ?, sync_status = 'SYNCED', failed_step = NULL, last_error = NULL WHERE id = ?", [state, state, campaign.id]);
    return { state };
  } catch (error) {
    await pool.query("UPDATE ads_campaigns SET sync_status = 'INCOMPLETE', failed_step = 'UPDATE_STATE', last_error = ? WHERE id = ?", [error.message, campaign.id]);
    throw error;
  }
}

async function setAdsKeywordState(keywordId, desiredState) {
  const state = String(desiredState || "").toUpperCase();
  if (!["ENABLED", "PAUSED"].includes(state)) throw new Error("关键词状态不合法");
  const profile = await requireSelectedAdsProfile();
  const pool = getMysqlPool();
  const [keywords] = await pool.query("SELECT * FROM ads_keywords WHERE id = ? AND profile_id = ? AND lifecycle_status = 'ACTIVE'", [keywordId, String(profile.profileId)]);
  if (!keywords[0]) throw new Error("关键词不存在或已停止");
  const [campaigns] = await pool.query("SELECT id FROM ads_campaigns WHERE keyword_id = ? AND profile_id = ? AND lifecycle_status = 'ACTIVE' ORDER BY id", [keywordId, String(profile.profileId)]);
  for (const campaign of campaigns) await setAdsCampaignState(campaign.id, state);
  return { state, campaignCount: campaigns.length };
}

async function stopAdsCampaign(campaignLocalId) {
  const profile = await requireSelectedAdsProfile();
  const pool = getMysqlPool();
  const [rows] = await pool.query("SELECT * FROM ads_campaigns WHERE id = ? AND profile_id = ?", [campaignLocalId, String(profile.profileId)]);
  const campaign = rows[0];
  if (!campaign) throw new Error("Campaign 不存在");
  if (campaign.lifecycle_status === "STOPPED") return { status: "STOPPED", alreadyStopped: true };
  await pool.query("UPDATE ads_campaigns SET lifecycle_status = 'STOPPING', sync_status = 'PENDING', failed_step = NULL, last_error = NULL WHERE id = ?", [campaign.id]);
  try {
    await setAdsCampaignState(campaign.id, "PAUSED");
    await pool.query("UPDATE ads_campaigns SET lifecycle_status = 'STOPPED', stopped_at = CURRENT_TIMESTAMP, sync_status = 'SYNCED' WHERE id = ?", [campaign.id]);
    return { status: "STOPPED" };
  } catch (error) {
    await pool.query("UPDATE ads_campaigns SET lifecycle_status = 'ACTIVE', sync_status = 'INCOMPLETE', failed_step = 'STOP_CAMPAIGN', last_error = ? WHERE id = ?", [error.message, campaign.id]);
    throw error;
  }
}

async function stopAdsKeyword(keywordId) {
  const profile = await requireSelectedAdsProfile();
  const pool = getMysqlPool();
  const [keywords] = await pool.query("SELECT * FROM ads_keywords WHERE id = ? AND profile_id = ? AND lifecycle_status = 'ACTIVE'", [keywordId, String(profile.profileId)]);
  const keyword = keywords[0];
  if (!keyword) throw new Error("关键词不存在或已停止");
  await pool.query("UPDATE ads_keywords SET lifecycle_status = 'STOPPING' WHERE id = ?", [keyword.id]);
  try {
    const [campaigns] = await pool.query("SELECT id, lifecycle_status FROM ads_campaigns WHERE keyword_id = ? AND profile_id = ? ORDER BY id", [keyword.id, String(profile.profileId)]);
    for (const campaign of campaigns) {
      if (campaign.lifecycle_status !== 'STOPPED') await stopAdsCampaign(campaign.id);
    }
    await pool.query("UPDATE ads_keywords SET lifecycle_status = 'STOPPED', stopped_at = CURRENT_TIMESTAMP, active_scope_key = NULL WHERE id = ?", [keyword.id]);
    return { status: 'STOPPED', campaignCount: campaigns.length };
  } catch (error) {
    await pool.query("UPDATE ads_keywords SET lifecycle_status = 'ACTIVE' WHERE id = ?", [keyword.id]);
    throw error;
  }
}

async function captureAdsSettingsDaily(profile, dateValue = "") {
  const profileId = String(profile?.profileId || profile || "");
  if (!profileId) return { campaigns: 0, units: 0 };
  const timeZone = profile?.timezone || US_MARKETPLACE_TIME_ZONE;
  const date = String(dateValue || formatDateInTimeZone(new Date(), timeZone)).slice(0, 10);
  const pool = getMysqlPool();
  const [campaignResult] = await pool.query(`
    INSERT INTO ads_campaign_settings_daily (
      date, campaign_id, daily_budget, top_of_search_adjustment, rest_of_search_adjustment,
      product_page_adjustment, desired_state, amazon_state, captured_at
    )
    SELECT ?, id, daily_budget, top_of_search_adjustment, rest_of_search_adjustment,
      product_page_adjustment, desired_state, amazon_state, NOW()
    FROM ads_campaigns
    WHERE profile_id = ? AND amazon_campaign_id IS NOT NULL AND sync_status = 'SYNCED'
    ON DUPLICATE KEY UPDATE
      daily_budget = VALUES(daily_budget),
      top_of_search_adjustment = VALUES(top_of_search_adjustment),
      rest_of_search_adjustment = VALUES(rest_of_search_adjustment),
      product_page_adjustment = VALUES(product_page_adjustment),
      desired_state = VALUES(desired_state),
      amazon_state = VALUES(amazon_state),
      captured_at = VALUES(captured_at)
  `, [date, profileId]);
  const [unitResult] = await pool.query(`
    INSERT INTO ads_ad_unit_settings_daily (date, ad_unit_id, bid, desired_state, amazon_state, captured_at)
    SELECT ?, id, bid, desired_state, amazon_state, NOW()
    FROM ads_ad_units
    WHERE profile_id = ? AND amazon_ad_group_id IS NOT NULL AND sync_status = 'SYNCED'
    ON DUPLICATE KEY UPDATE
      bid = VALUES(bid),
      desired_state = VALUES(desired_state),
      amazon_state = VALUES(amazon_state),
      captured_at = VALUES(captured_at)
  `, [date, profileId]);
  return { date, campaigns: Number(campaignResult.affectedRows || 0), units: Number(unitResult.affectedRows || 0) };
}

async function updateAdsCampaignSettings(campaignLocalId, body = {}) {
  const profile = await requireSelectedAdsProfile();
  const pool = getMysqlPool();
  const [rows] = await pool.query("SELECT * FROM ads_campaigns WHERE id = ? AND profile_id = ?", [campaignLocalId, String(profile.profileId)]);
  const campaign = rows[0];
  if (!campaign) throw new Error("Campaign 不存在");
  const dailyBudget = Number(body.dailyBudget);
  const topAdjustment = Number(body.topOfSearchAdjustment);
  const restAdjustment = Number(body.restOfSearchAdjustment);
  const productPageAdjustment = Number(body.productPageAdjustment);
  const adjustments = [topAdjustment, restAdjustment, productPageAdjustment];
  if (!(dailyBudget > 0) || adjustments.some(value => !Number.isInteger(value) || value < 0 || value > 900)) throw new Error("预算或位置加价不合法");
  await pool.query(`UPDATE ads_campaigns
    SET daily_budget = ?, top_of_search_adjustment = ?, rest_of_search_adjustment = ?, product_page_adjustment = ?, sync_status = 'PENDING'
    WHERE id = ?`, [dailyBudget, topAdjustment, restAdjustment, productPageAdjustment, campaign.id]);
  const updated = { ...campaign, daily_budget: dailyBudget, top_of_search_adjustment: topAdjustment, rest_of_search_adjustment: restAdjustment, product_page_adjustment: productPageAdjustment };
  if (!campaign.amazon_campaign_id) {
    await captureAdsSettingsDaily(profile);
    return { localOnly: true };
  }
  await assertAdsWriteBoundary(profile.profileId);
  try {
    await adsV3Update("/sp/campaigns", "spCampaign", "campaigns", {
      campaignId: String(campaign.amazon_campaign_id),
      budget: { budget: dailyBudget, budgetType: "DAILY" },
      dynamicBidding: { strategy: "LEGACY_FOR_SALES", placementBidding: adsPlacementBidding(updated) }
    });
    await pool.query("UPDATE ads_campaigns SET sync_status = 'SYNCED', failed_step = NULL, last_error = NULL WHERE id = ?", [campaign.id]);
    await captureAdsSettingsDaily(profile);
    return { dailyBudget, topOfSearchAdjustment: topAdjustment, restOfSearchAdjustment: restAdjustment, productPageAdjustment };
  } catch (error) {
    await pool.query("UPDATE ads_campaigns SET sync_status = 'INCOMPLETE', failed_step = 'UPDATE_SETTINGS', last_error = ? WHERE id = ?", [error.message, campaign.id]);
    throw error;
  }
}

async function updateAdsAdUnitBid(unitLocalId, body = {}) {
  const profile = await requireSelectedAdsProfile();
  const pool = getMysqlPool();
  const [rows] = await pool.query(`SELECT u.*, c.amazon_campaign_id
    FROM ads_ad_units u JOIN ads_campaigns c ON c.id = u.campaign_id
    WHERE u.id = ? AND u.profile_id = ?`, [unitLocalId, String(profile.profileId)]);
  const unit = rows[0];
  if (!unit) throw new Error("投放单元不存在");
  const bid = Number(body.bid);
  if (!(bid > 0)) throw new Error("出价必须大于 0");
  await pool.query("UPDATE ads_ad_units SET bid = ?, sync_status = 'PENDING' WHERE id = ?", [bid, unit.id]);
  if (!unit.amazon_ad_group_id || !unit.amazon_target_id) {
    await captureAdsSettingsDaily(profile);
    return { bid, localOnly: true };
  }
  await assertAdsWriteBoundary(profile.profileId);
  try {
    await adsV3Update("/sp/adGroups", "spAdGroup", "adGroups", {
      adGroupId: String(unit.amazon_ad_group_id), campaignId: String(unit.amazon_campaign_id), defaultBid: bid
    });
    await adsV3Update("/sp/keywords", "spKeyword", "keywords", {
      keywordId: String(unit.amazon_target_id), campaignId: String(unit.amazon_campaign_id), adGroupId: String(unit.amazon_ad_group_id), bid
    });
    await pool.query("UPDATE ads_ad_units SET sync_status = 'SYNCED', failed_step = NULL, last_error = NULL WHERE id = ?", [unit.id]);
    await captureAdsSettingsDaily(profile);
    return { bid };
  } catch (error) {
    await pool.query("UPDATE ads_ad_units SET sync_status = 'INCOMPLETE', failed_step = 'UPDATE_BID', last_error = ? WHERE id = ?", [error.message, unit.id]);
    throw error;
  }
}

async function setAdsAdUnitState(unitLocalId, desiredState) {
  const state = String(desiredState || "").toUpperCase();
  if (!["ENABLED", "PAUSED"].includes(state)) throw new Error("广告状态不合法");
  const profile = await requireSelectedAdsProfile();
  const pool = getMysqlPool();
  const [rows] = await pool.query(`
    SELECT u.*, c.amazon_campaign_id FROM ads_ad_units u
    JOIN ads_campaigns c ON c.id = u.campaign_id
    WHERE u.id = ? AND u.profile_id = ?
  `, [unitLocalId, String(profile.profileId)]);
  const unit = rows[0];
  if (!unit) throw new Error("投放单元不存在");
  await pool.query("UPDATE ads_ad_units SET desired_state = ?, lifecycle_status = ?, sync_status = 'PENDING' WHERE id = ?", [state, state === "PAUSED" ? "PAUSED" : "ACTIVE", unit.id]);
  if (!unit.amazon_ad_group_id) return { state, localOnly: true };
  await assertAdsWriteBoundary(profile.profileId);
  const steps = [
    ["AD_GROUP", "/sp/adGroups", "spAdGroup", "adGroups", { adGroupId: String(unit.amazon_ad_group_id), campaignId: String(unit.amazon_campaign_id), state }, "amazon_ad_group_state"],
    ["PRODUCT_AD", "/sp/productAds", "spProductAd", "productAds", { adId: String(unit.amazon_product_ad_id), campaignId: String(unit.amazon_campaign_id), adGroupId: String(unit.amazon_ad_group_id), state }, "amazon_product_ad_state"],
    ["KEYWORD_TARGET", "/sp/keywords", "spKeyword", "keywords", { keywordId: String(unit.amazon_target_id), campaignId: String(unit.amazon_campaign_id), adGroupId: String(unit.amazon_ad_group_id), state }, "amazon_target_state"]
  ];
  for (const [step, path, media, key, payload, stateColumn] of steps) {
    if (Object.values(payload).some(value => !value)) continue;
    try {
      await adsV3Update(path, media, key, payload);
      await pool.query(`UPDATE ads_ad_units SET ${stateColumn} = ?, amazon_state = ?, sync_status = 'SYNCED', failed_step = NULL, last_error = NULL WHERE id = ?`, [state, state, unit.id]);
    } catch (error) {
      await pool.query("UPDATE ads_ad_units SET sync_status = 'INCOMPLETE', failed_step = ?, last_error = ? WHERE id = ?", [`PAUSE_${step}`, error.message, unit.id]);
      throw error;
    }
  }
  return { state };
}

async function rememberAdsOperationStep(operationId, stepKey, stepOrder, entityType, localEntityId, status, values = {}) {
  const pool = getMysqlPool();
  await pool.query(`
    INSERT INTO ads_operation_steps (
      operation_id, step_key, step_order, entity_type, local_entity_id, amazon_entity_id,
      status, attempts, request_payload, response_payload, last_error, started_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, CAST(? AS JSON), CAST(? AS JSON), ?, NOW(), ?)
    ON DUPLICATE KEY UPDATE amazon_entity_id = VALUES(amazon_entity_id), status = VALUES(status),
      attempts = attempts + 1, request_payload = VALUES(request_payload), response_payload = VALUES(response_payload),
      last_error = VALUES(last_error), started_at = COALESCE(started_at, NOW()), completed_at = VALUES(completed_at)
  `, [
    operationId, stepKey, stepOrder, entityType, localEntityId || null, values.amazonEntityId || null, status,
    JSON.stringify(values.request || null), JSON.stringify(values.response || null), values.error || null,
    status === "COMPLETE" ? new Date() : null
  ]);
}

async function executeAdsCreationOperation(operationId, preview) {
  const profile = await requireSelectedAdsProfile();
  if (String(profile.profileId) !== String(preview.profile.profileId)) throw new Error("当前 Profile 已变化，请重新预览");
  let portfolio = await refreshManagedAdsPortfolio();
  const pool = getMysqlPool();
  let stepOrder = 0;
  if (portfolio.status === "MISSING") {
    const request = { name: ADS_MANAGED_PORTFOLIO_NAME, state: "enabled" };
    try {
      const created = await adsV3Create("/portfolios", "portfolio", "portfolios", "portfolioId", request);
      await writeManagedAdsPortfolio(profile, { portfolioId: created.id }, "READY", 0, "");
      await rememberAdsOperationStep(operationId, "portfolio:create", ++stepOrder, "PORTFOLIO", null, "COMPLETE", { amazonEntityId: created.id, request, response: created.response });
      portfolio = await readManagedAdsPortfolio(profile.profileId);
    } catch (error) {
      await rememberAdsOperationStep(operationId, "portfolio:create", ++stepOrder, "PORTFOLIO", null, "FAILED", { request, error: error.message });
      throw error;
    }
  }
  if (portfolio.status !== "READY" || !portfolio.portfolioId) throw new Error(portfolio.error || "AmzAllBlue_ERP 尚未就绪");
  for (const campaignPreview of preview.campaigns) {
    const [campaignRows] = await pool.query("SELECT * FROM ads_campaigns WHERE id = ? AND profile_id = ?", [campaignPreview.localId, String(profile.profileId)]);
    const campaign = campaignRows[0];
    if (!campaign) throw new Error("本地 Campaign 不存在");
    let campaignId = campaign.amazon_campaign_id ? String(campaign.amazon_campaign_id) : "";
    if (!campaignId) {
      const request = {
        name: campaign.campaign_name, state: String(campaign.desired_state).toUpperCase(), targetingType: "MANUAL",
        budget: { budget: Number(campaign.daily_budget), budgetType: "DAILY" },
        startDate: adsDateValue(campaign.start_date),
        dynamicBidding: {
          strategy: "LEGACY_FOR_SALES",
          placementBidding: adsPlacementBidding(campaign)
        },
        portfolioId: portfolio.portfolioId
      };
      try {
        const created = await adsV3Create("/sp/campaigns", "spCampaign", "campaigns", "campaignId", request);
        campaignId = created.id;
        await pool.query(`UPDATE ads_campaigns SET portfolio_id = ?, amazon_campaign_id = ?, amazon_campaign_name = ?, amazon_state = ?, creation_status = 'CAMPAIGN_CREATED', sync_status = 'SYNCED', failed_step = NULL, last_error = NULL WHERE id = ?`, [portfolio.portfolioId, campaignId, campaign.campaign_name, campaign.desired_state, campaign.id]);
        await rememberAdsOperationStep(operationId, `campaign:${campaign.id}`, ++stepOrder, "CAMPAIGN", campaign.id, "COMPLETE", { amazonEntityId: campaignId, request, response: created.response });
      } catch (error) {
        await pool.query("UPDATE ads_campaigns SET creation_status = 'INCOMPLETE', failed_step = 'CAMPAIGN', last_error = ? WHERE id = ?", [error.message, campaign.id]);
        await rememberAdsOperationStep(operationId, `campaign:${campaign.id}`, ++stepOrder, "CAMPAIGN", campaign.id, "FAILED", { request, error: error.message });
        throw error;
      }
    }
    const [units] = await pool.query("SELECT * FROM ads_ad_units WHERE campaign_id = ? ORDER BY id", [campaign.id]);
    for (const unit of units) {
      let adGroupId = unit.amazon_ad_group_id ? String(unit.amazon_ad_group_id) : "";
      if (!adGroupId) {
        const request = { campaignId, name: unit.ad_group_name, state: unit.desired_state, defaultBid: Number(unit.bid) };
        try {
          const created = await adsV3Create("/sp/adGroups", "spAdGroup", "adGroups", "adGroupId", request);
          adGroupId = created.id;
          await pool.query("UPDATE ads_ad_units SET amazon_ad_group_id = ?, amazon_ad_group_name = ?, amazon_ad_group_state = ?, creation_status = 'AD_GROUP_CREATED', failed_step = NULL, last_error = NULL WHERE id = ?", [adGroupId, unit.ad_group_name, unit.desired_state, unit.id]);
          await rememberAdsOperationStep(operationId, `ad-group:${unit.id}`, ++stepOrder, "AD_GROUP", unit.id, "COMPLETE", { amazonEntityId: adGroupId, request, response: created.response });
        } catch (error) {
          await pool.query("UPDATE ads_ad_units SET creation_status = 'INCOMPLETE', failed_step = 'AD_GROUP', last_error = ? WHERE id = ?", [error.message, unit.id]);
          await rememberAdsOperationStep(operationId, `ad-group:${unit.id}`, ++stepOrder, "AD_GROUP", unit.id, "FAILED", { request, error: error.message });
          throw error;
        }
      }
      let productAdId = unit.amazon_product_ad_id ? String(unit.amazon_product_ad_id) : "";
      if (!productAdId) {
        const request = { campaignId, adGroupId, sku: unit.seller_sku, state: unit.desired_state };
        try {
          const created = await adsV3Create("/sp/productAds", "spProductAd", "productAds", "adId", request);
          productAdId = created.id;
          await pool.query("UPDATE ads_ad_units SET amazon_product_ad_id = ?, amazon_product_ad_state = ?, creation_status = 'PRODUCT_AD_CREATED', failed_step = NULL, last_error = NULL WHERE id = ?", [productAdId, unit.desired_state, unit.id]);
          await rememberAdsOperationStep(operationId, `product-ad:${unit.id}`, ++stepOrder, "PRODUCT_AD", unit.id, "COMPLETE", { amazonEntityId: productAdId, request, response: created.response });
        } catch (error) {
          await pool.query("UPDATE ads_ad_units SET creation_status = 'INCOMPLETE', failed_step = 'PRODUCT_AD', last_error = ? WHERE id = ?", [error.message, unit.id]);
          await rememberAdsOperationStep(operationId, `product-ad:${unit.id}`, ++stepOrder, "PRODUCT_AD", unit.id, "FAILED", { request, error: error.message });
          throw error;
        }
      }
      if (!unit.amazon_target_id) {
        const request = { campaignId, adGroupId, keywordText: preview.keyword.text, matchType: campaign.match_type, bid: Number(unit.bid), state: unit.desired_state };
        try {
          const created = await adsV3Create("/sp/keywords", "spKeyword", "keywords", "keywordId", request);
          await pool.query("UPDATE ads_ad_units SET amazon_target_id = ?, amazon_target_state = ?, amazon_state = ?, creation_status = 'COMPLETE', sync_status = 'SYNCED', failed_step = NULL, last_error = NULL WHERE id = ?", [created.id, unit.desired_state, unit.desired_state, unit.id]);
          await rememberAdsOperationStep(operationId, `keyword-target:${unit.id}`, ++stepOrder, "KEYWORD_TARGET", unit.id, "COMPLETE", { amazonEntityId: created.id, request, response: created.response });
        } catch (error) {
          await pool.query("UPDATE ads_ad_units SET creation_status = 'INCOMPLETE', failed_step = 'KEYWORD_TARGET', last_error = ? WHERE id = ?", [error.message, unit.id]);
          await rememberAdsOperationStep(operationId, `keyword-target:${unit.id}`, ++stepOrder, "KEYWORD_TARGET", unit.id, "FAILED", { request, error: error.message });
          throw error;
        }
      }
    }
    await pool.query("UPDATE ads_campaigns SET creation_status = 'COMPLETE', sync_status = 'SYNCED', failed_step = NULL, last_error = NULL WHERE id = ?", [campaign.id]);
  }
  return { status: "COMPLETE" };
}

async function confirmAdsCreationOperation(operationId, token, options = {}) {
  const profile = await requireSelectedAdsProfile();
  const pool = getMysqlPool();
  const [rows] = await pool.query("SELECT * FROM ads_operations WHERE id = ? AND profile_id = ?", [operationId, String(profile.profileId)]);
  const operation = rows[0];
  if (!operation) throw new Error("创建预览不存在");
  if (!["PREVIEW", "FAILED"].includes(operation.status)) throw new Error(`该操作当前状态为 ${operation.status}`);
  if (!operation.confirmation_expires_at || new Date(operation.confirmation_expires_at).getTime() < Date.now()) throw new Error("确认预览已过期，请重新生成");
  if (operation.confirmation_token_hash !== adsOperationTokenHash(token)) throw new Error("确认凭证无效");
  const preview = parseMysqlJson(operation.preview_payload);
  const previewHash = adsPreviewHash(preview);
  if (previewHash !== operation.preview_hash) throw new Error("预览参数已变化，请重新生成");
  await pool.query("UPDATE ads_operations SET status = 'RUNNING', confirmed_at = NOW(), started_at = NOW(), last_error = NULL WHERE id = ?", [operationId]);
  const run = async () => {
    try {
    const result = await executeAdsCreationOperation(operationId, preview);
    await pool.query("UPDATE ads_operations SET status = 'COMPLETE', completed_at = NOW(), current_step = NULL WHERE id = ?", [operationId]);
    await pool.query("UPDATE ads_keywords SET lifecycle_status = 'ACTIVE' WHERE id = ? AND profile_id = ? AND lifecycle_status = 'CREATING'", [preview.keyword.id, String(profile.profileId)]);
    await pool.query(`
      UPDATE ads_creation_templates t
      JOIN ads_campaigns c ON c.profile_id = t.profile_id
      JOIN ads_ad_units u ON u.campaign_id = c.id
      SET t.daily_budget = c.daily_budget, t.default_bid = u.bid, t.top_of_search_adjustment = c.top_of_search_adjustment,
        t.rest_of_search_adjustment = c.rest_of_search_adjustment, t.product_page_adjustment = c.product_page_adjustment
      WHERE t.profile_id = ? AND c.keyword_id = ?
    `, [String(profile.profileId), preview.keyword.id]);
      return result;
    } catch (error) {
    await pool.query("UPDATE ads_operations SET status = 'FAILED', last_error = ?, completed_at = NOW() WHERE id = ?", [error.message, operationId]);
    await pool.query("UPDATE ads_keywords SET lifecycle_status = 'ACTIVE' WHERE id = ? AND profile_id = ? AND lifecycle_status = 'CREATING'", [preview.keyword.id, String(profile.profileId)]);
      throw error;
    }
  };
  if (options.background) {
    void run().catch(() => {});
    return { status: "RUNNING" };
  }
  return run();
}

async function readAdsCreationOperationStatus(operationId) {
  const profile = await requireSelectedAdsProfile();
  const pool = getMysqlPool();
  const [rows] = await pool.query(`
    SELECT id, entity_id, status, current_step, last_error, confirmation_expires_at,
      confirmed_at, started_at, completed_at, created_at, updated_at
    FROM ads_operations
    WHERE id = ? AND profile_id = ? AND operation_type = 'AD_CREATE'
  `, [operationId, String(profile.profileId)]);
  const operation = rows[0];
  if (!operation) throw new Error("创建操作不存在");
  const [steps] = await pool.query(`
    SELECT step_key, step_order, entity_type, local_entity_id, amazon_entity_id,
      status, attempts, last_error, started_at, completed_at
    FROM ads_operation_steps
    WHERE operation_id = ?
    ORDER BY step_order, id
  `, [operationId]);
  return {
    operationId: operation.id,
    keywordId: String(operation.entity_id || ""),
    status: operation.status,
    currentStep: operation.current_step || "",
    error: operation.last_error || "",
    confirmationExpiresAt: operation.confirmation_expires_at,
    confirmedAt: operation.confirmed_at,
    startedAt: operation.started_at,
    completedAt: operation.completed_at,
    createdAt: operation.created_at,
    updatedAt: operation.updated_at,
    steps: steps.map(step => ({
      key: step.step_key,
      order: Number(step.step_order),
      entityType: step.entity_type,
      localEntityId: step.local_entity_id ? String(step.local_entity_id) : "",
      amazonEntityId: step.amazon_entity_id || "",
      status: step.status,
      attempts: Number(step.attempts || 0),
      error: step.last_error || "",
      startedAt: step.started_at,
      completedAt: step.completed_at
    }))
  };
}

function adsReportMetric(row, keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== "") return Number(row[key]) || 0;
  }
  return 0;
}

function adsReportConfiguration(kind) {
  if (kind === "PLACEMENT") {
    return {
      adProduct: "SPONSORED_PRODUCTS",
      groupBy: ["campaignPlacement"],
      columns: ["date", "campaignId", "impressions", "clicks", "cost", "purchases7d", "unitsSoldClicks7d", "sales7d"],
      reportTypeId: "spCampaigns",
      timeUnit: "DAILY",
      format: "GZIP_JSON"
    };
  }
  return {
    adProduct: "SPONSORED_PRODUCTS",
    groupBy: ["adGroup"],
    columns: ["date", "adGroupId", "impressions", "clicks", "cost", "purchases7d", "unitsSoldClicks7d", "sales7d"],
    reportTypeId: "spCampaigns",
    timeUnit: "DAILY",
    format: "GZIP_JSON"
  };
}

async function downloadAdsReportRows(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`广告报表下载失败 ${response.status}`);
  let buffer = Buffer.from(await response.arrayBuffer());
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) buffer = gunzipSync(buffer);
  const parsed = JSON.parse(buffer.toString("utf8") || "[]");
  return Array.isArray(parsed) ? parsed : adsArrayPayload(parsed, ["rows", "data"]);
}

async function saveAdsReportRows(profileId, kind, rows) {
  const pool = getMysqlPool();
  if (kind === "PLACEMENT") {
    const [campaignRows] = await pool.query("SELECT id, amazon_campaign_id FROM ads_campaigns WHERE profile_id = ? AND amazon_campaign_id IS NOT NULL", [String(profileId)]);
    const campaignByAmazonId = new Map(campaignRows.map(row => [String(row.amazon_campaign_id), row.id]));
    for (const row of rows) {
      const campaignId = campaignByAmazonId.get(String(row.campaignId || ""));
      const date = String(row.date || "").slice(0, 10);
      const placement = String(row.placementClassification || row.placement || "OTHER");
      if (!campaignId || !date) continue;
      await pool.query(`
        INSERT INTO ads_placement_performance_daily (
          date, campaign_id, placement, impressions, clicks, spend, orders_count, units_sold, sales, synced_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
        ON DUPLICATE KEY UPDATE impressions = VALUES(impressions), clicks = VALUES(clicks), spend = VALUES(spend),
          orders_count = VALUES(orders_count), units_sold = VALUES(units_sold), sales = VALUES(sales), synced_at = VALUES(synced_at)
      `, [date, campaignId, placement, adsReportMetric(row, ["impressions"]), adsReportMetric(row, ["clicks"]), adsReportMetric(row, ["cost", "spend"]), adsReportMetric(row, ["purchases7d", "orders7d"]), adsReportMetric(row, ["unitsSoldClicks7d", "unitsSold7d"]), adsReportMetric(row, ["sales7d", "sales"])]);
    }
    return;
  }
  const [unitRows] = await pool.query("SELECT id, amazon_ad_group_id FROM ads_ad_units WHERE profile_id = ? AND amazon_ad_group_id IS NOT NULL", [String(profileId)]);
  const unitByAdGroup = new Map(unitRows.map(row => [String(row.amazon_ad_group_id), row.id]));
  for (const row of rows) {
    const unitId = unitByAdGroup.get(String(row.adGroupId || ""));
    const date = String(row.date || "").slice(0, 10);
    if (!unitId || !date) continue;
    await pool.query(`
      INSERT INTO ads_performance_daily (
        date, ad_unit_id, impressions, clicks, spend, orders_count, units_sold, sales, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
      ON DUPLICATE KEY UPDATE impressions = VALUES(impressions), clicks = VALUES(clicks), spend = VALUES(spend),
        orders_count = VALUES(orders_count), units_sold = VALUES(units_sold), sales = VALUES(sales), synced_at = VALUES(synced_at)
    `, [date, unitId, adsReportMetric(row, ["impressions"]), adsReportMetric(row, ["clicks"]), adsReportMetric(row, ["cost", "spend"]), adsReportMetric(row, ["purchases7d", "orders7d"]), adsReportMetric(row, ["unitsSoldClicks7d", "unitsSold7d"]), adsReportMetric(row, ["sales7d", "sales"])]);
  }
}

async function runAdsSyncJob(jobId) {
  const pool = getMysqlPool();
  const [rows] = await pool.query("SELECT * FROM ads_sync_jobs WHERE id = ?", [jobId]);
  const job = rows[0];
  if (!job) return;
  await pool.query("UPDATE ads_sync_jobs SET status = 'RUNNING', started_at = NOW(), attempts = attempts + 1 WHERE id = ?", [jobId]);
  try {
    const configuration = adsReportConfiguration(job.report_type);
    const created = await adsFetch("/reporting/reports", {}, {
      requireProfile: true,
      profileId: job.profile_id,
      method: "POST",
      headers: {
        accept: "application/vnd.createasyncreportrequest.v3+json",
        "content-type": "application/vnd.createasyncreportrequest.v3+json"
      },
      body: {
        name: `AmzAllBlue ERP ${job.report_type} ${adsDateValue(job.start_date)} ${adsDateValue(job.end_date)}`,
        startDate: adsDateValue(job.start_date), endDate: adsDateValue(job.end_date), configuration
      }
    });
    const reportId = String(created.reportId || created.report?.reportId || "");
    if (!reportId) throw new Error("Amazon Ads 未返回 reportId");
    await pool.query("UPDATE ads_sync_jobs SET amazon_report_id = ? WHERE id = ?", [reportId, jobId]);
    let report = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      report = await adsFetch(`/reporting/reports/${encodeURIComponent(reportId)}`, {}, { requireProfile: true, profileId: job.profile_id });
      const status = String(report.status || "").toUpperCase();
      if (["COMPLETED", "SUCCESS"].includes(status) && report.url) break;
      if (["FAILURE", "FAILED", "CANCELLED"].includes(status)) throw new Error(report.failureReason || `广告报表状态 ${status}`);
      await wait(Math.min(30_000, 3000 + attempt * 1000));
    }
    if (!report?.url) throw new Error("等待广告报表完成超时");
    const reportRows = await downloadAdsReportRows(report.url);
    await saveAdsReportRows(job.profile_id, job.report_type, reportRows);
    const dates = dateRangeInclusive(adsDateValue(job.start_date), adsDateValue(job.end_date));
    for (const date of dates) {
      await pool.query(`
        INSERT INTO ads_sync_dates (profile_id, date, report_type, status, last_job_id, synced_at)
        VALUES (?, ?, ?, 'COMPLETE', ?, NOW())
        ON DUPLICATE KEY UPDATE status = 'COMPLETE', last_job_id = VALUES(last_job_id), synced_at = NOW(), last_error = NULL
      `, [String(job.profile_id), date, job.report_type, jobId]);
    }
    await pool.query("UPDATE ads_sync_jobs SET status = 'COMPLETE', active_dedupe_key = NULL, completed_at = NOW(), last_error = NULL WHERE id = ?", [jobId]);
  } catch (error) {
    await pool.query("UPDATE ads_sync_jobs SET status = 'FAILED', active_dedupe_key = NULL, completed_at = NOW(), last_error = ? WHERE id = ?", [error.message, jobId]);
  }
}

async function enqueueAdsSync(startDate, endDate) {
  const profile = await requireSelectedAdsProfile();
  const portfolio = await readManagedAdsPortfolio(profile.profileId);
  if (portfolio?.status !== "READY") throw new Error(portfolio?.error || "AmzAllBlue_ERP 尚未就绪");
  const pool = getMysqlPool();
  const [managedRows] = await pool.query("SELECT COUNT(*) count FROM ads_ad_units WHERE profile_id = ? AND amazon_ad_group_id IS NOT NULL", [String(profile.profileId)]);
  if (!Number(managedRows[0]?.count || 0)) return { jobs: [], message: "还没有已创建的受管广告，无需同步" };
  const safeEnd = String(endDate || formatDateInTimeZone(new Date(), profile.timezone || US_MARKETPLACE_TIME_ZONE)).slice(0, 10);
  const safeStart = String(startDate || addDays(safeEnd, -29)).slice(0, 10);
  const profileToday = formatDateInTimeZone(new Date(), profile.timezone || US_MARKETPLACE_TIME_ZONE);
  if (profileToday >= safeStart && profileToday <= safeEnd) await captureAdsSettingsDaily(profile, profileToday);
  const jobs = [];
  // 关键词历史图只依赖 Ad Group 的每日表现；一个报表覆盖当前 Profile 内所有受管 Ad Group，
  // 再由本地 ID 映射汇总到子 ASIN 和关键词。展示位置数据改为后续单独同步，避免每次同步多等一份报表。
  for (const kind of ["AD_GROUP"]) {
    const id = randomUUID();
    const dedupeKey = `${profile.profileId}|${kind}|${safeStart}|${safeEnd}`;
    try {
      await pool.query(`
        INSERT INTO ads_sync_jobs (id, profile_id, report_type, start_date, end_date, active_dedupe_key)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [id, String(profile.profileId), kind, safeStart, safeEnd, dedupeKey]);
      jobs.push({ id, kind, status: "QUEUED" });
      runAdsSyncJob(id).catch(() => {});
    } catch (error) {
      if (error?.code !== "ER_DUP_ENTRY") throw error;
      const [existing] = await pool.query("SELECT id, report_type, status FROM ads_sync_jobs WHERE active_dedupe_key = ?", [dedupeKey]);
      if (existing[0]) jobs.push({ id: existing[0].id, kind: existing[0].report_type, status: existing[0].status });
    }
  }
  return { jobs, range: { startDate: safeStart, endDate: safeEnd } };
}

async function waitForAdsSyncJobs(jobs, timeoutMs = 35 * 60_000) {
  const ids = jobs.map(job => String(job.id)).filter(Boolean);
  if (!ids.length) return { jobs: [] };
  const deadline = Date.now() + timeoutMs;
  const pool = getMysqlPool();
  while (Date.now() < deadline) {
    const [rows] = await pool.query("SELECT id, status, last_error FROM ads_sync_jobs WHERE id IN (?)", [ids]);
    const byId = new Map(rows.map(row => [String(row.id), row]));
    if (ids.every(id => ["COMPLETE", "FAILED", "CANCELLED"].includes(String(byId.get(id)?.status || "").toUpperCase()))) {
      const failed = ids.map(id => byId.get(id)).filter(row => !row || ["FAILED", "CANCELLED"].includes(String(row.status || "").toUpperCase()));
      if (failed.length) throw new Error(failed.map(row => row?.last_error || "广告报表同步失败").join("; "));
      return { jobs: ids.map(id => ({ id, status: byId.get(id).status })) };
    }
    await wait(3000);
  }
  throw new Error("等待广告报表同步完成超时");
}

async function adsSyncStatus() {
  const profile = await requireSelectedAdsProfile();
  const pool = getMysqlPool();
  const [jobs] = await pool.query("SELECT id, report_type, start_date, end_date, status, attempts, last_error, created_at, completed_at FROM ads_sync_jobs WHERE profile_id = ? ORDER BY created_at DESC LIMIT 20", [String(profile.profileId)]);
  const [dates] = await pool.query("SELECT date, report_type, status, synced_at FROM ads_sync_dates WHERE profile_id = ? ORDER BY date DESC LIMIT 180", [String(profile.profileId)]);
  return {
    jobs: jobs.map(row => ({ id: row.id, kind: row.report_type, startDate: adsDateValue(row.start_date), endDate: adsDateValue(row.end_date), status: row.status, attempts: Number(row.attempts || 0), error: row.last_error || "", createdAt: row.created_at, completedAt: row.completed_at })),
    dates: dates.map(row => ({ date: adsDateValue(row.date), kind: row.report_type, status: row.status, syncedAt: row.synced_at }))
  };
}

function startAdsPerformanceSchedule() {
  if (adsHourlySyncTimer || adsRollingSyncTimer) return;
  const hourlyMs = Math.max(5 * 60_000, Number(process.env.AMZ_ADS_HOURLY_SYNC_MS || 60 * 60_000));
  const dailyMs = Math.max(60 * 60_000, Number(process.env.AMZ_ADS_ROLLING_SYNC_MS || 24 * 60 * 60_000));
  const runToday = async () => {
    try {
      const profile = await readAdsProfileSelection();
      if (!profile?.profileId) return;
      const today = formatDateInTimeZone(new Date(), profile.timezone || US_MARKETPLACE_TIME_ZONE);
      await enqueueAdsSync(today, today);
    } catch (error) {
      console.error(`Amazon Ads hourly sync failed: ${error.message}`);
    }
  };
  const runRolling = async () => {
    try {
      const profile = await readAdsProfileSelection();
      if (!profile?.profileId) return;
      const endDate = formatDateInTimeZone(new Date(), profile.timezone || US_MARKETPLACE_TIME_ZONE);
      await enqueueAdsSync(addDays(endDate, -29), endDate);
    } catch (error) {
      console.error(`Amazon Ads rolling sync failed: ${error.message}`);
    }
  };
  adsHourlySyncTimer = setInterval(runToday, hourlyMs);
  adsRollingSyncTimer = setInterval(runRolling, dailyMs);
  setTimeout(runToday, Number(process.env.AMZ_ADS_STARTUP_SYNC_DELAY_MS || 90_000));
  setTimeout(runRolling, Number(process.env.AMZ_ADS_STARTUP_ROLLING_DELAY_MS || 180_000));
}

async function executeSystemScheduledTask(taskKey) {
  if (taskKey === "FBA_TODAY_SALES") {
    const today = formatDateInTimeZone();
    const job = enqueueFbaSyncJob({ reason: "scheduled_today_sales", dates: [today], inventoryDates: [], forceNewReport: true, syncCurrentInventory: false, syncHistoricalInventory: false, syncSales: true, syncCatalog: false });
    const completed = await job.completion;
    if (completed.status === "failed") throw new Error(completed.error || "FBA 当日销量同步失败");
    return completed;
  }
  if (taskKey === "FBA_CURRENT_INVENTORY") {
    const today = formatDateInTimeZone();
    const job = enqueueFbaSyncJob({ reason: "scheduled_current_inventory", dates: [today], inventoryDates: [today], syncCurrentInventory: true, syncHistoricalInventory: false, syncSales: false, syncCatalog: true });
    const completed = await job.completion;
    if (completed.status === "failed") throw new Error(completed.error || "FBA 当前库存同步失败");
    return completed;
  }
  if (taskKey === "FBA_HISTORY_BACKFILL") {
    const endDate = addDays(formatDateInTimeZone(), -1);
    const dates = dateRangeInclusive(addDays(endDate, -29), endDate);
    const job = enqueueFbaSyncJob({ reason: "scheduled_history_backfill", dates, inventoryDates: dates, forceNewReport: true, syncCurrentInventory: false, syncHistoricalInventory: true, syncSales: true, syncCatalog: false });
    const completed = await job.completion;
    if (completed.status === "failed") throw new Error(completed.error || "FBA 历史数据补齐失败");
    return completed;
  }
  if (taskKey === "ADS_TODAY_PERFORMANCE") {
    const profile = await readAdsProfileSelection();
    if (!profile?.profileId) return { skipped: true, reason: "NO_ADS_PROFILE" };
    const today = formatDateInTimeZone(new Date(), profile.timezone || US_MARKETPLACE_TIME_ZONE);
    await captureAdsSettingsDaily(profile, today);
    return waitForAdsSyncJobs((await enqueueAdsSync(today, today)).jobs);
  }
  if (taskKey === "ADS_ROLLING_PERFORMANCE") {
    const profile = await readAdsProfileSelection();
    if (!profile?.profileId) return { skipped: true, reason: "NO_ADS_PROFILE" };
    const endDate = formatDateInTimeZone(new Date(), profile.timezone || US_MARKETPLACE_TIME_ZONE);
    await captureAdsSettingsDaily(profile, endDate);
    return waitForAdsSyncJobs((await enqueueAdsSync(addDays(endDate, -29), endDate)).jobs);
  }
  if (taskKey === "SIF_KEYWORD_DATA") return syncAllSifKeywordRanks();
  if (taskKey === "ADS_AI_ANALYSIS") {
    const profile = await readAdsProfileSelection();
    if (!profile?.profileId) return { skipped: true, reason: "NO_ADS_PROFILE" };
    return startDailyAdsAiBatch(profile, formatDateInTimeZone(new Date(), SYSTEM_SCHEDULE_TIME_ZONE), { waitForCompletion: true });
  }
  return { skipped: true, reason: "UNKNOWN_TASK" };
}

async function runSystemScheduleTick() {
  const pool = getMysqlPool();
  const settings = await readSystemSchedules();
  const now = new Date();
  const dateKey = formatDateInTimeZone(now, SYSTEM_SCHEDULE_TIME_ZONE);
  const timeKey = timeKeyInTimeZone(now, SYSTEM_SCHEDULE_TIME_ZONE);
  for (const task of settings.tasks) {
    if (!task.enabled) continue;
    if (task.lastStatus === "RUNNING") continue;
    const lastStartedMs = task.lastStartedAt ? new Date(task.lastStartedAt).getTime() : 0;
    const retryDue = task.lastStatus === "RETRY_WAIT" && task.nextRetryAt && new Date(task.nextRetryAt).getTime() <= now.getTime();
    const due = retryDue || (task.lastStatus !== "RETRY_WAIT" && (task.scheduleType === "DAILY"
      ? timeKey >= task.timeBeijing && task.lastRunKey !== dateKey
      : !lastStartedMs || now.getTime() - lastStartedMs >= task.intervalMinutes * 60_000));
    if (!due) continue;
    const runKey = retryDue ? task.lastRunKey : task.scheduleType === "DAILY" ? dateKey : now.toISOString();
    await pool.query(
      "UPDATE system_schedule_settings SET last_run_key = ?, last_started_at = NOW(), last_status = 'RUNNING', last_error = NULL, next_retry_at = NULL WHERE task_key = ?",
      [runKey, task.key]
    );
    Promise.resolve(executeSystemScheduledTask(task.key)).then(async result => {
      await finishSystemScheduleTask(pool, task.key, result);
    }).catch(async error => {
      await scheduleSystemScheduleRetry(pool, task.key, error.message);
      console.error(`System schedule ${task.key} failed: ${error.message}`);
    });
  }
}

function startSystemSchedule() {
  if (["0", "false"].includes(String(process.env.SYSTEM_SCHEDULE_ENABLED || "").toLowerCase())) return;
  if (systemScheduleTimer) return;
  const tick = () => runSystemScheduleTick().catch(error => console.error(`System schedule tick failed: ${error.message}`));
  tick();
  systemScheduleTimer = setInterval(tick, 60_000);
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
  if (req.method === "GET" && url.pathname === "/api/system/schedules") {
    return sendJson(res, await readSystemSchedules());
  }

  if (req.method === "PUT" && url.pathname === "/api/system/schedules") {
    return sendJson(res, await updateSystemSchedules(await parseBody(req)));
  }

  const systemScheduleRunMatch = url.pathname.match(/^\/api\/system\/schedules\/([^/]+)\/run$/);
  if (req.method === "POST" && systemScheduleRunMatch) {
    return sendJson(res, await runSystemScheduleTaskNow(decodeURIComponent(systemScheduleRunMatch[1])));
  }

  if (req.method === "GET" && url.pathname === "/api/sif-keywords/history") {
    return sendJson(res, await readSifKeywordHistory({
      asin: url.searchParams.get("asin") || "",
      keyword: url.searchParams.get("keyword") || "",
      startDate: url.searchParams.get("startDate") || "",
      endDate: url.searchParams.get("endDate") || ""
    }));
  }

  if (req.method === "GET" && url.pathname === "/api/sif-keywords/workspace") {
    return sendJson(res, await readSifKeywordWorkspace(url.searchParams.get("asin") || ""));
  }

  if (req.method === "POST" && url.pathname === "/api/sif-keywords/sync") {
    const body = await parseBody(req);
    return sendJson(res, await syncSifKeywordAsinNow(body.asin));
  }

  if (req.method === "POST" && url.pathname === "/api/sif-keywords/credentials") {
    const body = await parseBody(req);
    return sendJson(res, await saveSifCredentialsFromCurl(body.curl));
  }

  if (req.method === "DELETE" && url.pathname === "/api/sif-keywords/credentials") {
    await deleteAppSecret(SECRET_KEYS.sifCredentials);
    return sendJson(res, { authorized: false, configured: false, deleted: true });
  }

  if (req.method === "POST" && url.pathname === "/api/sif-keywords/subscriptions") {
    return sendJson(res, await updateSifKeywordSubscription(await parseBody(req)));
  }

  if (req.method === "POST" && url.pathname === "/api/sif-keywords/reorder") {
    return sendJson(res, await saveSifKeywordOrder(await parseBody(req)));
  }

  if (req.method === "GET" && url.pathname === "/api/sif-traffic-audit") {
    return sendJson(res, await readSifTrafficAuditState(url.searchParams.get("asin") || ""));
  }

  if (req.method === "POST" && url.pathname === "/api/sif-traffic-audit") {
    return sendJson(res, await startSifTrafficAudit(await parseBody(req)), 202);
  }

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

  if (req.method === "GET" && url.pathname === "/api/ads/managed-portfolio") {
    const profile = await requireSelectedAdsProfile();
    const refresh = url.searchParams.get("refresh") === "1";
    const portfolio = refresh ? await refreshManagedAdsPortfolio() : await readManagedAdsPortfolio(profile.profileId);
    return sendJson(res, { portfolio });
  }

  if (req.method === "GET" && url.pathname === "/api/ads/workspace") {
    return sendJson(res, await readAdsWorkspace(url.searchParams.get("startDate") || "", url.searchParams.get("endDate") || ""));
  }

  if (req.method === "GET" && url.pathname === "/api/ads/dates") {
    return sendJson(res, await readAdsDateStatus());
  }

  if (req.method === "POST" && url.pathname === "/api/ads/products/reorder") {
    await requireSelectedAdsProfile();
    const body = await parseBody(req);
    await saveAdsParentAsinOrder(body.parentAsins);
    return sendJson(res, { products: await readAdsProductCatalog() });
  }

  if (req.method === "POST" && url.pathname === "/api/ads/keywords/reorder") {
    const body = await parseBody(req);
    await saveAdsKeywordOrder(body.parentAsin, body.keywordIds);
    return sendJson(res, { ok: true });
  }

  if (req.method === "GET" && url.pathname === "/api/ads/template") {
    const profile = await requireSelectedAdsProfile();
    return sendJson(res, { template: await ensureAdsCreationTemplate(profile) });
  }

  if (req.method === "GET" && url.pathname === "/api/ads/ai/strategy") {
    const profile = await requireSelectedAdsProfile();
    return sendJson(res, { strategy: await readLatestAdsAiStrategy(profile.profileId) });
  }

  if (req.method === "PUT" && url.pathname === "/api/ads/ai/strategy") {
    return sendJson(res, { strategy: await saveAdsAiStrategy(await parseBody(req)) });
  }

  if (req.method === "POST" && url.pathname === "/api/ads/keywords") {
    const result = await createAdsKeywordDraft(await parseBody(req));
    return sendJson(res, result, 201);
  }

  if (req.method === "POST" && url.pathname === "/api/ads/keywords/create-now") {
    return sendJson(res, await createAndStartAdsKeywordBatch(await parseBody(req)), 202);
  }

  const adsKeywordHistoryMatch = url.pathname.match(/^\/api\/ads\/keywords\/(\d+)\/history$/);
  if (req.method === "GET" && adsKeywordHistoryMatch) {
    return sendJson(res, await readAdsKeywordHistory(adsKeywordHistoryMatch[1], {
      startDate: url.searchParams.get("startDate") || "",
      endDate: url.searchParams.get("endDate") || "",
      childAsin: url.searchParams.get("childAsin") || "",
      matchType: url.searchParams.get("matchType") || ""
    }));
  }

  const adsKeywordAiMatch = url.pathname.match(/^\/api\/ads\/keywords\/(\d+)\/ai$/);
  if (req.method === "GET" && adsKeywordAiMatch) {
    return sendJson(res, await readAdsAiKeywordState(adsKeywordAiMatch[1]));
  }
  if (req.method === "PUT" && adsKeywordAiMatch) {
    return sendJson(res, await saveAdsAiKeywordGoal(adsKeywordAiMatch[1], await parseBody(req)));
  }

  const adsKeywordAiHistoryMatch = url.pathname.match(/^\/api\/ads\/keywords\/(\d+)\/ai\/history$/);
  if (req.method === "GET" && adsKeywordAiHistoryMatch) {
    return sendJson(res, await readAdsAiAnalysisHistory(adsKeywordAiHistoryMatch[1], url.searchParams.get("limit") || 20));
  }

  const adsAiRunSnapshotMatch = url.pathname.match(/^\/api\/ads\/ai\/runs\/([^/]+)$/);
  if (req.method === "GET" && adsAiRunSnapshotMatch) {
    return sendJson(res, await readAdsAiAnalysisSnapshot(adsAiRunSnapshotMatch[1]));
  }

  const adsKeywordAiAnalyzeMatch = url.pathname.match(/^\/api\/ads\/keywords\/(\d+)\/ai\/analyze$/);
  if (req.method === "POST" && adsKeywordAiAnalyzeMatch) {
    return sendJson(res, await startAdsAiAnalysis(adsKeywordAiAnalyzeMatch[1]), 202);
  }

  const adsAiRecommendationExecuteMatch = url.pathname.match(/^\/api\/ads\/ai\/recommendations\/([^/]+)\/execute$/);
  if (req.method === "POST" && adsAiRecommendationExecuteMatch) {
    return sendJson(res, await executeAdsAiRecommendation(adsAiRecommendationExecuteMatch[1], await parseBody(req)));
  }

  const adsAiRecommendationDecisionMatch = url.pathname.match(/^\/api\/ads\/ai\/recommendations\/([^/]+)\/decision$/);
  if (req.method === "POST" && adsAiRecommendationDecisionMatch) {
    const body = await parseBody(req);
    return sendJson(res, await decideAdsAiRecommendation(adsAiRecommendationDecisionMatch[1], body.decision));
  }

  const adsKeywordMonitoringMatch = url.pathname.match(/^\/api\/ads\/keywords\/(\d+)\/monitoring$/);
  if (req.method === "POST" && adsKeywordMonitoringMatch) {
    return sendJson(res, await setAdsKeywordSifMonitoring(adsKeywordMonitoringMatch[1], true));
  }
  if (req.method === "DELETE" && adsKeywordMonitoringMatch) {
    return sendJson(res, await setAdsKeywordSifMonitoring(adsKeywordMonitoringMatch[1], false));
  }

  const adsKeywordGroupMatch = url.pathname.match(/^\/api\/ads\/keywords\/(\d+)\/group$/);
  if (req.method === "PUT" && adsKeywordGroupMatch) {
    const body = await parseBody(req);
    return sendJson(res, await updateAdsKeywordGroup(adsKeywordGroupMatch[1], body.group));
  }

  const adsKeywordStateMatch = url.pathname.match(/^\/api\/ads\/keywords\/(\d+)\/state$/);
  if (req.method === "PUT" && adsKeywordStateMatch) {
    const body = await parseBody(req);
    return sendJson(res, await setAdsKeywordState(adsKeywordStateMatch[1], body.state));
  }

  const adsKeywordStopMatch = url.pathname.match(/^\/api\/ads\/keywords\/(\d+)\/stop$/);
  if (req.method === "POST" && adsKeywordStopMatch) {
    return sendJson(res, await stopAdsKeyword(adsKeywordStopMatch[1]));
  }

  const adsKeywordMatchAdd = url.pathname.match(/^\/api\/ads\/keywords\/(\d+)\/matches$/);
  if (req.method === "POST" && adsKeywordMatchAdd) {
    const body = await parseBody(req);
    return sendJson(res, await createAdsAdditionalMatchDraft(adsKeywordMatchAdd[1], body.matchType), 201);
  }

  const adsKeywordDraftMatch = url.pathname.match(/^\/api\/ads\/keywords\/(\d+)$/);
  if (req.method === "DELETE" && adsKeywordDraftMatch) {
    const profile = await requireSelectedAdsProfile();
    const pool = getMysqlPool();
    const [remoteRows] = await pool.query(`
      SELECT COUNT(*) count FROM ads_campaigns c LEFT JOIN ads_ad_units u ON u.campaign_id = c.id
      WHERE c.keyword_id = ? AND c.profile_id = ? AND (c.amazon_campaign_id IS NOT NULL OR u.amazon_ad_group_id IS NOT NULL OR u.amazon_product_ad_id IS NOT NULL OR u.amazon_target_id IS NOT NULL)
    `, [adsKeywordDraftMatch[1], String(profile.profileId)]);
    if (Number(remoteRows[0]?.count || 0)) return sendJson(res, { error: "已创建 Amazon 对象的关键词不能删除，只能暂停" }, 409);
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query("DELETE s FROM ads_operation_steps s JOIN ads_operations o ON o.id = s.operation_id WHERE o.entity_type = 'KEYWORD' AND o.entity_id = ? AND o.profile_id = ?", [adsKeywordDraftMatch[1], String(profile.profileId)]);
      await connection.query("DELETE FROM ads_operations WHERE entity_type = 'KEYWORD' AND entity_id = ? AND profile_id = ?", [adsKeywordDraftMatch[1], String(profile.profileId)]);
      await connection.query("DELETE u FROM ads_ad_units u JOIN ads_campaigns c ON c.id = u.campaign_id WHERE c.keyword_id = ? AND c.profile_id = ?", [adsKeywordDraftMatch[1], String(profile.profileId)]);
      await connection.query("DELETE FROM ads_campaigns WHERE keyword_id = ? AND profile_id = ?", [adsKeywordDraftMatch[1], String(profile.profileId)]);
      const [result] = await connection.query("DELETE FROM ads_keywords WHERE id = ? AND profile_id = ?", [adsKeywordDraftMatch[1], String(profile.profileId)]);
      await connection.commit();
      return sendJson(res, { deleted: Number(result.affectedRows || 0) });
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  }

  if (req.method === "POST" && url.pathname === "/api/ads/operations/preview") {
    const body = await parseBody(req);
    return sendJson(res, await buildAdsCreationPreview(String(body.keywordId || "")), 201);
  }

  const adsOperationStatusMatch = url.pathname.match(/^\/api\/ads\/operations\/([^/]+)$/);
  if (req.method === "GET" && adsOperationStatusMatch) {
    return sendJson(res, await readAdsCreationOperationStatus(adsOperationStatusMatch[1]));
  }

  const adsOperationConfirmMatch = url.pathname.match(/^\/api\/ads\/operations\/([^/]+)\/confirm$/);
  if (req.method === "POST" && adsOperationConfirmMatch) {
    const body = await parseBody(req);
    return sendJson(res, await confirmAdsCreationOperation(adsOperationConfirmMatch[1], body.confirmationToken));
  }

  const adsOperationStartMatch = url.pathname.match(/^\/api\/ads\/operations\/([^/]+)\/start$/);
  if (req.method === "POST" && adsOperationStartMatch) {
    const body = await parseBody(req);
    return sendJson(res, await confirmAdsCreationOperation(adsOperationStartMatch[1], body.confirmationToken, { background: true }), 202);
  }

  if (req.method === "POST" && url.pathname === "/api/ads/sync") {
    const body = await parseBody(req);
    return sendJson(res, await enqueueAdsSync(body.startDate, body.endDate), 202);
  }

  if (req.method === "POST" && url.pathname === "/api/ads/maintenance/legacy-asin-names") {
    const body = await parseBody(req);
    return sendJson(res, await migrateLegacyAdsAsinNames(body.parentAsin, body.childAsin));
  }

  if (req.method === "GET" && url.pathname === "/api/ads/sync") {
    return sendJson(res, await adsSyncStatus());
  }

  const adsCampaignStateMatch = url.pathname.match(/^\/api\/ads\/campaigns\/(\d+)\/state$/);
  if (req.method === "PUT" && adsCampaignStateMatch) {
    const body = await parseBody(req);
    return sendJson(res, await setAdsCampaignState(adsCampaignStateMatch[1], body.state));
  }

  const adsCampaignStopMatch = url.pathname.match(/^\/api\/ads\/campaigns\/(\d+)\/stop$/);
  if (req.method === "POST" && adsCampaignStopMatch) {
    return sendJson(res, await stopAdsCampaign(adsCampaignStopMatch[1]));
  }

  const adsCampaignSettingsMatch = url.pathname.match(/^\/api\/ads\/campaigns\/(\d+)\/settings$/);
  if (req.method === "PUT" && adsCampaignSettingsMatch) {
    return sendJson(res, await updateAdsCampaignSettings(adsCampaignSettingsMatch[1], await parseBody(req)));
  }

  const adsUnitStateMatch = url.pathname.match(/^\/api\/ads\/ad-units\/(\d+)\/state$/);
  if (req.method === "PUT" && adsUnitStateMatch) {
    const body = await parseBody(req);
    return sendJson(res, await setAdsAdUnitState(adsUnitStateMatch[1], body.state));
  }

  const adsUnitBidMatch = url.pathname.match(/^\/api\/ads\/ad-units\/(\d+)\/bid$/);
  if (req.method === "PUT" && adsUnitBidMatch) {
    return sendJson(res, await updateAdsAdUnitBid(adsUnitBidMatch[1], await parseBody(req)));
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

  if (req.method === "GET" && url.pathname === "/api/factory-inventory") {
    const db = await readDb();
    const catalog = await ensureFactoryInventoryProductCatalog(db);
    if (catalog.changed) await writeDb(db);
    return sendJson(res, await buildFactoryInventoryView(db, { fbaCatalogByAsin: catalog.fbaCatalogByAsin }));
  }

  if (req.method === "GET" && url.pathname === "/api/factory-inventory/movement-template.csv") {
    const operation = String(url.searchParams.get("operation") || "").trim();
    const date = String(url.searchParams.get("date") || "").slice(0, 10);
    const kind = String(url.searchParams.get("kind") || "").trim();
    if (!operation || !date) return sendJson(res, { error: "Missing movement row identity" }, 400);
    if (!["shipping", "replenishment", "backend"].includes(kind)) return sendJson(res, { error: "Invalid template kind" }, 400);
    const db = await readDb();
    const rows = await buildFactoryMovementTemplateRows(db, { operation, date, kind });
    const label = kind === "backend" ? "后台发货模版" : kind === "shipping" ? "发货模版" : "补货模版";
    return sendCsv(res, `${label}_${date}.csv`, rows);
  }

  if (req.method === "GET" && url.pathname === "/api/factory-inventory/movement-template.xlsx") {
    const operation = String(url.searchParams.get("operation") || "").trim();
    const date = String(url.searchParams.get("date") || "").slice(0, 10);
    const kind = String(url.searchParams.get("kind") || "").trim();
    if (!operation || !date) return sendJson(res, { error: "Missing movement row identity" }, 400);
    if (!["shipping", "replenishment", "backend"].includes(kind)) return sendJson(res, { error: "Invalid template kind" }, 400);
    const db = await readDb();
    const buffer = await buildFactoryMovementTemplateWorkbook(db, { operation, date, kind });
    const label = kind === "backend" ? "后台发货模版" : kind === "shipping" ? "工厂发货模版" : "工厂补货模版";
    return sendXlsx(res, `${label}_${date}.xlsx`, buffer);
  }

  if (req.method === "POST" && url.pathname === "/api/factory-inventory/shipment-documents") {
    const body = await parseBody(req);
    const db = await readDb();
    return sendJson(res, await buildShipmentDocumentFiles(db, body));
  }

  if (req.method === "POST" && url.pathname === "/api/factory-inventory/movements") {
    const body = await parseBody(req);
    const db = await readDb();
    const store = db.factoryInventory || { products: [], movements: [] };
    store.products = Array.isArray(store.products) ? store.products.map(item => normalizeFactoryProduct(item)) : [];
    store.movements = Array.isArray(store.movements) ? store.movements.map(item => normalizeFactoryMovement(item)) : [];
    const productIndex = store.products.findIndex(item => item.id === String(body.productId || ""));
    if (productIndex === -1) return sendJson(res, { error: "Factory product not found" }, 404);
    const rawQuantity = Number(body.quantity || 0);
    if (!rawQuantity) return sendJson(res, { error: "Quantity must not be 0" }, 400);
    const type = String(body.type || inferFactoryMovementType(body.note, rawQuantity));
    const signedQuantity = type === "outbound" ? -Math.abs(rawQuantity) : type === "inbound" ? Math.abs(rawQuantity) : rawQuantity;
    const movement = normalizeFactoryMovement({
      productId: store.products[productIndex].id,
      date: body.date,
      type,
      quantity: signedQuantity,
      note: body.note,
      operator: body.operator,
      source: "manual"
    });
    store.movements.unshift(movement);
    store.products[productIndex] = applyFactoryQuantity(store.products[productIndex], signedQuantity);
    db.factoryInventory = store;
    await writeDb(db);
    const catalog = await ensureFactoryInventoryProductCatalog(db);
    if (catalog.changed) await writeDb(db);
    return sendJson(res, { movement, ...(await buildFactoryInventoryView(db, { fbaCatalogByAsin: catalog.fbaCatalogByAsin })) }, 201);
  }

  if (req.method === "POST" && url.pathname === "/api/factory-inventory/movement-rows") {
    const body = await parseBody(req);
    const operation = String(body.operation || "").trim();
    const date = String(body.date || "").slice(0, 10);
    const quantities = body.quantities && typeof body.quantities === "object" ? body.quantities : {};
    if (!operation) return sendJson(res, { error: "Missing operation" }, 400);
    if (!date) return sendJson(res, { error: "Missing date" }, 400);
    const db = await readDb();
    const store = db.factoryInventory || { products: [], movements: [] };
    store.products = Array.isArray(store.products) ? store.products.map(item => normalizeFactoryProduct(item)) : [];
    store.movements = Array.isArray(store.movements) ? store.movements.map(item => normalizeFactoryMovement(item)) : [];
    const productById = new Map(store.products.map((product, index) => [product.id, { product, index }]));
    const created = [];
    for (const [productId, rawQuantity] of Object.entries(quantities)) {
      const quantity = Number(rawQuantity || 0);
      if (!quantity) continue;
      const entry = productById.get(String(productId));
      if (!entry) continue;
      const movement = normalizeFactoryMovement({
        productId,
        date,
        type: inferFactoryMovementType(operation, quantity),
        quantity,
        note: operation,
        source: "manual"
      });
      created.push(movement);
      store.movements.unshift(movement);
      store.products[entry.index] = applyFactoryQuantity(entry.product, quantity);
      productById.set(productId, { product: store.products[entry.index], index: entry.index });
    }
    if (!created.length) return sendJson(res, { error: "No quantity entered" }, 400);
    db.factoryInventory = store;
    await writeDb(db);
    const catalog = await ensureFactoryInventoryProductCatalog(db);
    if (catalog.changed) await writeDb(db);
    return sendJson(res, { created, ...(await buildFactoryInventoryView(db, { fbaCatalogByAsin: catalog.fbaCatalogByAsin })) }, 201);
  }

  if (req.method === "DELETE" && url.pathname === "/api/factory-inventory/movement-rows") {
    const body = await parseBody(req);
    const operation = String(body.operation || "").trim();
    const date = String(body.date || "").slice(0, 10);
    if (!operation || !date) return sendJson(res, { error: "Missing movement row identity" }, 400);
    const db = await readDb();
    const store = db.factoryInventory || { products: [], movements: [] };
    store.products = Array.isArray(store.products) ? store.products.map(item => normalizeFactoryProduct(item)) : [];
    store.movements = Array.isArray(store.movements) ? store.movements.map(item => normalizeFactoryMovement(item)) : [];
    const productIndexById = new Map(store.products.map((product, index) => [product.id, index]));
    const remaining = [];
    let deleted = 0;
    for (const movement of store.movements) {
      const movementOperation = movement.note || movement.typeLabel || movement.type || "库存变动";
      if (movement.date === date && movementOperation === operation) {
        const index = productIndexById.get(movement.productId);
        if (index !== undefined) store.products[index] = applyFactoryQuantity(store.products[index], -Number(movement.quantity || 0));
        deleted += 1;
      } else {
        remaining.push(movement);
      }
    }
    if (!deleted) return sendJson(res, { error: "Movement row not found" }, 404);
    store.movements = remaining;
    db.factoryInventory = store;
    await writeDb(db);
    const catalog = await ensureFactoryInventoryProductCatalog(db);
    if (catalog.changed) await writeDb(db);
    return sendJson(res, { deleted, ...(await buildFactoryInventoryView(db, { fbaCatalogByAsin: catalog.fbaCatalogByAsin })) });
  }

  if (req.method === "POST" && url.pathname === "/api/factory-inventory/products") {
    const body = await parseBody(req);
    const asin = String(body.asin || "").trim().toUpperCase();
    if (!asin) return sendJson(res, { error: "Missing ASIN" }, 400);
    const db = await readDb();
    const catalog = await ensureFactoryInventoryProductCatalog(db);
    const fbaProduct = catalog.fbaCatalogByAsin.get(asin);
    if (!fbaProduct) return sendJson(res, { error: "ASIN not found in product database" }, 404);
    const store = db.factoryInventory || { products: [], movements: [] };
    store.products = Array.isArray(store.products) ? store.products.map(item => normalizeFactoryProduct(item)) : [];
    if (store.products.some(product => product.asin === asin)) return sendJson(res, { error: "ASIN already exists in factory inventory" }, 409);
    const nextOrder = Math.max(0, ...store.products.map(product => Number(product.order || 0))) + 1;
    store.products.push(normalizeFactoryProduct({
      id: `factory-${asin}`,
      name: fbaProduct.title || `Amazon 商品 ${asin}`,
      asin,
      currentQuantity: 0,
      unitCost: "",
      inventoryValue: "",
      boxSpec: "",
      source: "fba_catalog_manual",
      order: nextOrder
    }));
    db.factoryInventory = store;
    await writeDb(db);
    return sendJson(res, await buildFactoryInventoryView(db, { fbaCatalogByAsin: catalog.fbaCatalogByAsin }), 201);
  }

  if (req.method === "POST" && url.pathname === "/api/factory-inventory/products/reorder") {
    const body = await parseBody(req);
    const productIds = Array.isArray(body.productIds) ? body.productIds.map(id => String(id || "").trim()).filter(Boolean) : [];
    if (!productIds.length) return sendJson(res, { error: "Missing productIds" }, 400);
    const db = await readDb();
    const catalog = await ensureFactoryInventoryProductCatalog(db);
    const store = db.factoryInventory || { products: [], movements: [] };
    store.products = Array.isArray(store.products) ? store.products.map(item => normalizeFactoryProduct(item)) : [];
    const orderById = new Map(productIds.map((id, index) => [id, index + 1]));
    let nextOrder = productIds.length + 1;
    store.products = store.products.map(product => normalizeFactoryProduct({
      ...product,
      order: orderById.get(product.id) || nextOrder++,
      updatedAt: new Date().toISOString()
    }));
    db.factoryInventory = store;
    await writeDb(db);
    return sendJson(res, await buildFactoryInventoryView(db, { fbaCatalogByAsin: catalog.fbaCatalogByAsin }));
  }

  const factoryParentGroupMatch = url.pathname.match(/^\/api\/factory-inventory\/parent-groups\/([^/]+)$/);
  if (req.method === "PUT" && factoryParentGroupMatch) {
    const parentKey = decodeURIComponent(factoryParentGroupMatch[1]).trim().toUpperCase();
    const body = await parseBody(req);
    const db = await readDb();
    const catalog = await ensureFactoryInventoryProductCatalog(db);
    if (Object.prototype.hasOwnProperty.call(body, "parentInternalName")) {
      await upsertParentAsinMetadata(parentKey, String(body.parentInternalName || "").trim());
    }
    if (Object.prototype.hasOwnProperty.call(body, "categoryId")) {
      await upsertParentAsinCategory(parentKey, body.categoryId, body.categoryName);
    }
    return sendJson(res, await buildFactoryInventoryView(db, { fbaCatalogByAsin: catalog.fbaCatalogByAsin }));
  }

  const factoryProductMatch = url.pathname.match(/^\/api\/factory-inventory\/products\/([^/]+)$/);
  if (req.method === "DELETE" && factoryProductMatch) {
    const productId = decodeURIComponent(factoryProductMatch[1]);
    const db = await readDb();
    const catalog = await ensureFactoryInventoryProductCatalog(db);
    const store = db.factoryInventory || { products: [], movements: [] };
    store.products = Array.isArray(store.products) ? store.products.map(item => normalizeFactoryProduct(item)) : [];
    store.movements = Array.isArray(store.movements) ? store.movements.map(item => normalizeFactoryMovement(item)) : [];
    const product = store.products.find(item => item.id === productId);
    if (!product) return sendJson(res, { error: "Factory product not found" }, 404);
    store.products = store.products
      .filter(item => item.id !== productId)
      .map((item, index) => normalizeFactoryProduct({ ...item, order: index + 1, updatedAt: new Date().toISOString() }));
    const before = store.movements.length;
    store.movements = store.movements.filter(movement => movement.productId !== productId);
    db.factoryInventory = store;
    await writeDb(db);
    return sendJson(res, {
      deletedProduct: product,
      deletedMovements: before - store.movements.length,
      ...(await buildFactoryInventoryView(db, { fbaCatalogByAsin: catalog.fbaCatalogByAsin }))
    });
  }

  if (req.method === "PUT" && factoryProductMatch) {
    const productId = decodeURIComponent(factoryProductMatch[1]);
    const body = await parseBody(req);
    const db = await readDb();
    const catalog = await ensureFactoryInventoryProductCatalog(db);
    const store = db.factoryInventory || { products: [], movements: [] };
    store.products = Array.isArray(store.products) ? store.products.map(item => normalizeFactoryProduct(item)) : [];
    const index = store.products.findIndex(item => item.id === productId);
    if (index === -1) return sendJson(res, { error: "Factory product not found" }, 404);
    store.products[index] = updateFactoryProduct(store.products[index], body);
    db.factoryInventory = store;
    await writeDb(db);
    return sendJson(res, await buildFactoryInventoryView(db, { fbaCatalogByAsin: catalog.fbaCatalogByAsin }));
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
    const cacheKey = `fba-view-v3:${startDate}:${endDate}:${getSpApiConfig().marketplaceId}`;
    const cacheTtlMs = Number(process.env.AMZ_FBA_CACHE_TTL_MS || 300000);
    const cached = fbaInventoryCache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < cacheTtlMs) {
      return sendJson(res, { ...cached.data, syncJob: fbaJobPublicView(latestFbaSyncJob()), cached: true, cachedAt: cached.cachedAt });
    }
    const result = await buildFbaInventoryView(startDate, endDate);
    fbaInventoryCache.set(cacheKey, { cachedAt: Date.now(), data: result });
    return sendJson(res, { ...result, syncJob: fbaJobPublicView(latestFbaSyncJob()) });
  }

  if (req.method === "POST" && url.pathname === "/api/fba/grades") {
    const body = await parseBody(req);
    const rawGrades = body && typeof body.grades === "object" && body.grades ? body.grades : {};
    const normalizedGrades = {};
    for (const [rawAsin, rawGrade] of Object.entries(rawGrades)) {
      const asin = String(rawAsin || "").trim().toUpperCase();
      const grade = normalizeFbaReplenishmentGrade(rawGrade);
      if (/^B[A-Z0-9]{9}$/.test(asin) && grade) normalizedGrades[asin] = grade;
    }
    const mysqlResult = await upsertFbaProductGrades(normalizedGrades);
    const db = await readDb();
    const store = db.factoryInventory || { products: [], movements: [] };
    store.products = Array.isArray(store.products) ? store.products.map(item => normalizeFactoryProduct(item)) : [];
    let changed = Boolean(mysqlResult.changed);
    for (const [asin, grade] of Object.entries(normalizedGrades)) {
      store.products = store.products.map(product => {
        if (product.asin !== asin || product.replenishmentGrade === grade) return product;
        changed = true;
        return normalizeFactoryProduct({ ...product, replenishmentGrade: grade, updatedAt: new Date().toISOString() });
      });
    }
    if (changed) {
      db.factoryInventory = store;
      await writeDb(db);
      fbaInventoryCache.clear();
    }
    return sendJson(res, { saved: normalizedGrades, changed });
  }

  if (req.method === "GET" && url.pathname === "/api/fba/sync") {
    return sendJson(res, { job: fbaJobPublicView(latestFbaSyncJob()) });
  }

  if (req.method === "POST" && url.pathname === "/api/fba/sync") {
    const body = await parseBody(req);
    const today = formatDateInTimeZone();
    const startDate = String(body.startDate || addDays(today, -29)).slice(0, 10);
    const endDate = String(body.endDate || today).slice(0, 10);
    const dates = body.dates?.length ? body.dates : dateRangeInclusive(startDate, endDate);
    const job = enqueueFbaSyncJob({
      reason: body.reason || "manual",
      dates,
      inventoryDates: body.inventoryDates || dates.filter(date => date <= today),
      allowFrozenInventoryUpdate: body.allowFrozenInventoryUpdate !== false,
      forceNewReport: Boolean(body.forceNewReport),
      syncCurrentInventory: body.syncCurrentInventory !== false,
      syncHistoricalInventory: body.syncHistoricalInventory !== false,
      syncSales: body.syncSales !== false,
      syncCatalog: body.syncCatalog !== false
    });
    return sendJson(res, { job: fbaJobPublicView(job) }, 202);
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
  const startedAt = Date.now();
  let url;
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }
    url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      res.on("finish", () => {
        logApiRequest({ method: req.method, path: url.pathname, status: res.statusCode, durationMs: Date.now() - startedAt });
      });
    }
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
    } else {
      await serveStatic(req, res, url);
    }
  } catch (error) {
    sendJson(res, { error: error.message || "Server error" }, 500);
  }
});

await ensureDataDir();
await ensureAppMysqlSchema();
server.listen(PORT, () => {
  console.log(`Amazon Aggregator running at http://localhost:${PORT}`);
  if (process.env.AMZ_FBA_SYNC_ON_START !== "0" && process.env.AMZ_FBA_SYNC_ON_START !== "false") {
    setTimeout(async () => {
      try {
        await enqueueStartupFbaSyncJobs();
        await ensureSystemScheduleDefaults();
        await getMysqlPool().query("UPDATE system_schedule_settings SET last_started_at = NOW(), last_status = 'COMPLETE' WHERE task_key IN ('FBA_TODAY_SALES','FBA_CURRENT_INVENTORY')");
      } catch (error) {
        console.error(`FBA startup sync failed: ${error.message}`);
      } finally {
        startSystemSchedule();
      }
    }, Number(process.env.AMZ_FBA_STARTUP_SYNC_DELAY_MS || 15000));
  } else {
    startSystemSchedule();
  }
});
