const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { Pool } = require("pg");
const { calc } = require("./public/calc.js");

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const APP_PASSWORD = process.env.APP_PASSWORD || "";

if (!DATABASE_URL) {
  console.error("ต้องตั้งค่า DATABASE_URL ก่อนเริ่มเซิร์ฟเวอร์");
  process.exit(1);
}

// ใช้ SSL เมื่อต่อฐานข้อมูลภายนอก (เช่น Supabase, Neon หรือ External URL ของ Render)
// ส่วน Internal URL ของ Render (ชื่อโฮสต์ไม่มีจุด) และ localhost ไม่ต้องใช้ SSL
function needsSsl(url) {
  if (process.env.DB_SSL) return process.env.DB_SSL === "true";
  try {
    const host = new URL(url).hostname;
    return host.includes(".") && host !== "127.0.0.1";
  } catch (e) { return false; }
}
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: needsSsl(DATABASE_URL) ? { rejectUnauthorized: false } : false
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bills (
      id SERIAL PRIMARY KEY,
      seller_name TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      tree_count INTEGER NOT NULL,
      total_volume NUMERIC(14,4) NOT NULL,
      total_price NUMERIC(14,2) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS bill_items (
      id SERIAL PRIMARY KEY,
      bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
      wood_type TEXT NOT NULL,
      girth NUMERIC(8,2) NOT NULL,
      length NUMERIC(8,2) NOT NULL,
      qty INTEGER NOT NULL,
      volume NUMERIC(14,4) NOT NULL,
      volume_total NUMERIC(14,4) NOT NULL,
      rate INTEGER NOT NULL,
      price NUMERIC(14,2) NOT NULL
    );
    CREATE INDEX IF NOT EXISTS bill_items_bill_id_idx ON bill_items(bill_id);
    CREATE INDEX IF NOT EXISTS bills_created_at_idx ON bills(created_at DESC);
  `);
}

const app = express();
app.use(express.json({ limit: "200kb" }));

// ป้องกันด้วยรหัสผ่าน (ถ้าตั้ง APP_PASSWORD ไว้) ชื่อผู้ใช้อะไรก็ได้
if (APP_PASSWORD) {
  const expected = Buffer.from(APP_PASSWORD);
  app.use((req, res, next) => {
    const h = req.headers.authorization || "";
    if (h.startsWith("Basic ")) {
      const decoded = Buffer.from(h.slice(6), "base64").toString();
      const pass = Buffer.from(decoded.slice(decoded.indexOf(":") + 1));
      if (pass.length === expected.length && crypto.timingSafeEqual(pass, expected)) return next();
    }
    res.set("WWW-Authenticate", 'Basic realm="wood", charset="UTF-8"');
    res.status(401).send("ต้องใส่รหัสผ่าน");
  });
}

app.use(express.static(path.join(__dirname, "public")));

const toNum = v => (v == null ? v : Number(v));
function billRow(r) {
  return {
    id: r.id, seller_name: r.seller_name, phone: r.phone, note: r.note,
    tree_count: r.tree_count, total_volume: toNum(r.total_volume),
    total_price: toNum(r.total_price), created_at: r.created_at
  };
}

// รายการบิล (ค้นหาด้วยชื่อ/เบอร์ และช่วงวันที่ได้)
app.get("/api/bills", async (req, res, next) => {
  try {
    const where = [];
    const params = [];
    const isDate = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
    if ((req.query.from && !isDate(req.query.from)) || (req.query.to && !isDate(req.query.to)))
      return res.status(400).json({ error: "รูปแบบวันที่ไม่ถูกต้อง" });
    if (req.query.q) {
      params.push(`%${req.query.q}%`);
      where.push(`(seller_name ILIKE $${params.length} OR phone ILIKE $${params.length} OR note ILIKE $${params.length})`);
    }
    if (req.query.from) { params.push(req.query.from); where.push(`created_at >= ($${params.length}::date::timestamp AT TIME ZONE 'Asia/Bangkok')`); }
    if (req.query.to) { params.push(req.query.to); where.push(`created_at < (($${params.length}::date + 1)::timestamp AT TIME ZONE 'Asia/Bangkok')`); }
    const w = where.length ? "WHERE " + where.join(" AND ") : "";
    const { rows } = await pool.query(`SELECT * FROM bills ${w} ORDER BY created_at DESC LIMIT 500`, params);
    const sum = await pool.query(
      `SELECT COUNT(*)::int AS bills, COALESCE(SUM(tree_count),0)::int AS trees,
              COALESCE(SUM(total_volume),0) AS volume, COALESCE(SUM(total_price),0) AS price FROM bills ${w}`, params);
    const s = sum.rows[0];
    res.json({
      bills: rows.map(billRow),
      summary: { bills: s.bills, trees: s.trees, volume: Number(s.volume), price: Number(s.price) }
    });
  } catch (e) { next(e); }
});

app.get("/api/bills/:id", async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const b = await pool.query("SELECT * FROM bills WHERE id = $1", [id]);
    if (!b.rows.length) return res.status(404).json({ error: "ไม่พบบิล" });
    const items = await pool.query("SELECT * FROM bill_items WHERE bill_id = $1 ORDER BY id", [id]);
    res.json({
      ...billRow(b.rows[0]),
      items: items.rows.map(it => ({
        wood_type: it.wood_type, girth: toNum(it.girth), length: toNum(it.length), qty: it.qty,
        volume: toNum(it.volume), volume_total: toNum(it.volume_total), rate: it.rate, price: toNum(it.price)
      }))
    });
  } catch (e) { next(e); }
});

// บันทึกบิล: เซิร์ฟเวอร์คำนวณราคาซ้ำเองทุกครั้ง ไม่เชื่อตัวเลขจากหน้าเว็บ
app.post("/api/bills", async (req, res, next) => {
  const body = req.body || {};
  const rawItems = Array.isArray(body.items) ? body.items : [];
  if (!rawItems.length) return res.status(400).json({ error: "ยังไม่มีรายการไม้" });
  if (rawItems.length > 500) return res.status(400).json({ error: "รายการมากเกินไป" });

  const items = [];
  for (const it of rawItems) {
    const r = calc(it.type, Number(it.g), Number(it.len), Number(it.qty));
    if (r.error) return res.status(400).json({ error: r.error });
    items.push(r);
  }
  const str = (v, max) => String(v || "").trim().slice(0, max);
  const seller = str(body.seller_name, 200);
  const phone = str(body.phone, 50);
  const note = str(body.note, 1000);
  const treeCount = items.reduce((s, r) => s + r.qty, 0);
  const totalVolume = items.reduce((s, r) => s + r.volTotal, 0);
  const totalPrice = items.reduce((s, r) => s + r.total, 0);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const b = await client.query(
      `INSERT INTO bills (seller_name, phone, note, tree_count, total_volume, total_price)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [seller, phone, note, treeCount, totalVolume.toFixed(4), totalPrice.toFixed(2)]);
    const billId = b.rows[0].id;
    for (const r of items) {
      await client.query(
        `INSERT INTO bill_items (bill_id, wood_type, girth, length, qty, volume, volume_total, rate, price)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [billId, r.type, r.g, r.len, r.qty, r.vol.toFixed(4), r.volTotal.toFixed(4), r.rate, r.total.toFixed(2)]);
    }
    await client.query("COMMIT");
    res.status(201).json(billRow(b.rows[0]));
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    next(e);
  } finally {
    client.release();
  }
});

app.delete("/api/bills/:id", async (req, res, next) => {
  try {
    const r = await pool.query("DELETE FROM bills WHERE id = $1", [parseInt(req.params.id, 10)]);
    if (!r.rowCount) return res.status(404).json({ error: "ไม่พบบิล" });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "เกิดข้อผิดพลาดที่เซิร์ฟเวอร์" });
});

initDb()
  .then(() => app.listen(PORT, () => console.log(`พร้อมใช้งานที่ http://localhost:${PORT}`)))
  .catch(err => { console.error("เชื่อมต่อฐานข้อมูลไม่ได้:", err.message); process.exit(1); });
