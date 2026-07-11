import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise";

const ROOT = resolve(".");
const sourcePath = process.argv[2] || "data/db.json";

function loadEnvFile() {
  const envPath = resolve(ROOT, ".env");
  if (!existsSync(envPath)) return;
  const raw = readFileSync(envPath, "utf8");
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

function mysqlConfig() {
  return {
    host: process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "amz_all_blue"
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

function normalizeProduct(input) {
  const source = input && typeof input === "object" ? input : {};
  const asin = String(source.asin || "").trim().toUpperCase();
  return {
    id: source.id || asin || randomUUID(),
    asin,
    parentAsin: String(source.parentAsin || source.parent_asin || "").trim().toUpperCase(),
    sku: String(source.sku || "").trim(),
    title: String(source.title || source.itemName || "").trim(),
    brand: String(source.brand || "").trim(),
    imageUrl: String(source.imageUrl || "").trim(),
    price: source.price === "" || source.price === undefined ? "" : Number(source.price),
    currency: String(source.currency || "USD").trim(),
    status: String(source.status || "active").trim(),
    inventory: source.inventory === "" || source.inventory === undefined ? "" : Number(source.inventory),
    source: String(source.source || "local").trim(),
    marketplaceId: String(source.marketplaceId || "").trim(),
    updatedAt: source.updatedAt || new Date().toISOString(),
    raw: source.raw || null
  };
}

function jsonRowId(row, index) {
  return String(row?.id || row?.asin || row?.sellerSku || `row-${index + 1}`).slice(0, 64);
}

async function ensureSchema(connection, database) {
  await connection.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await connection.changeUser({ database });
  await connection.query(`
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
  await connection.query(`
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
  await connection.query(`
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
  await connection.query(`
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
  await connection.query(`
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
  await connection.query(`
    CREATE TABLE IF NOT EXISTS parent_asin_metadata (
      parent_asin VARCHAR(32) NOT NULL,
      internal_name VARCHAR(255) NOT NULL DEFAULT '',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (parent_asin)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function replaceJsonRows(connection, table, rows) {
  await connection.query(`DELETE FROM ${table}`);
  if (!rows.length) return;
  await connection.query(
    `INSERT INTO ${table} (id, position, payload) VALUES ?`,
    [rows.map((row, index) => [jsonRowId(row, index), index, JSON.stringify(row)])]
  );
}

loadEnvFile();

const raw = readFileSync(resolve(ROOT, sourcePath), "utf8");
const db = JSON.parse(raw);
const requests = Array.isArray(db.requests) ? db.requests : [];
const products = (Array.isArray(db.products) ? db.products : []).map(normalizeProduct);
const factoryProducts = (Array.isArray(db.factoryInventory?.products) ? db.factoryInventory.products : []).map(normalizeFactoryProduct);
const factoryMovements = (Array.isArray(db.factoryInventory?.movements) ? db.factoryInventory.movements : []).map(normalizeFactoryMovement);
const grades = factoryProducts
  .map(product => [product.asin, product.replenishmentGrade])
  .filter(([asin, grade]) => /^B[A-Z0-9]{9}$/.test(asin) && grade);
const parentMetadata = [...new Map(factoryProducts
  .map(product => [String(product.parentAsin || "").trim().toUpperCase(), String(product.parentInternalName || "").trim()])
  .filter(([parentAsin, internalName]) => /^B[A-Z0-9]{9}$/.test(parentAsin) && internalName)
).entries()];

const config = mysqlConfig();
const connection = await mysql.createConnection({
  host: config.host,
  port: config.port,
  user: config.user,
  password: config.password,
  multipleStatements: false
});

try {
  await ensureSchema(connection, config.database);
  await connection.beginTransaction();
  await replaceJsonRows(connection, "collaboration_requests", requests);
  await replaceJsonRows(connection, "manual_products", products);
  await replaceJsonRows(connection, "factory_inventory_products", factoryProducts);
  await replaceJsonRows(connection, "factory_inventory_movements", factoryMovements);
  if (grades.length) {
    await connection.query(`
      INSERT INTO fba_product_metadata (marketplace_id, asin, replenishment_grade)
      VALUES ?
      ON DUPLICATE KEY UPDATE replenishment_grade = VALUES(replenishment_grade)
    `, [grades.map(([asin, grade]) => [process.env.AMZ_MARKETPLACE_ID || "ATVPDKIKX0DER", asin, grade])]);
  }
  if (parentMetadata.length) {
    await connection.query(`
      INSERT INTO parent_asin_metadata (parent_asin, internal_name)
      VALUES ?
      ON DUPLICATE KEY UPDATE internal_name = VALUES(internal_name)
    `, [parentMetadata.map(([parentAsin, internalName]) => [parentAsin, internalName])]);
  }
  await connection.commit();
  console.log(JSON.stringify({
    sourcePath,
    requests: requests.length,
    products: products.length,
    factoryProducts: factoryProducts.length,
    factoryMovements: factoryMovements.length,
    fbaGradesFromFactoryProducts: grades.length,
    parentAsinMetadata: parentMetadata.length
  }, null, 2));
} catch (error) {
  await connection.rollback().catch(() => {});
  throw error;
} finally {
  await connection.end();
}
