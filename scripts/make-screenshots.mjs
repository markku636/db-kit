// 產生 README / 介紹頁用的「介面預覽圖」(docs/screenshots/*.png)。
//
// 注意：這些是依 App 真實主題色（src/styles.css）與版面繪製的「設計預覽 mockup」，
// 非真實截圖。要換成實拍，把同名 PNG 覆蓋掉即可。
//
// 重新產生：  node scripts/make-screenshots.mjs
import sharp from 'sharp'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = resolve(root, 'docs/screenshots')

const W = 1280
const H = 800

// App 深色主題實際色票（src/styles.css）+ 五大資料庫色標（src/api.ts）。
const C = {
  well: '#0b0f16', inset: '#0f141c', app: '#121721', panel: '#19202d',
  bar: '#1f2837', elevated: '#263142', fg: '#e4e9f2', dim: '#8b97ab',
  faint: '#5f6b7e', border: '#2a3445', accent: '#3b82f6', flame: '#f97316',
  mysql: '#3b82f6', pg: '#6366f1', sqlite: '#f59e0b', mongo: '#22c55e', redis: '#ef4444',
}

const SIDEBAR_W = 252
const CX = SIDEBAR_W // content left
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function R(x, y, w, h, o = {}) {
  const { rx = 0, fill = 'none', stroke = 'none', sw = 1, op = 1 } = o
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}"${stroke !== 'none' ? ` stroke="${stroke}" stroke-width="${sw}"` : ''}${op !== 1 ? ` opacity="${op}"` : ''}/>`
}
function L(x1, y1, x2, y2, stroke, sw = 1, o = {}) {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${sw}"${o.dash ? ` stroke-dasharray="${o.dash}"` : ''}/>`
}
function T(x, y, s, o = {}) {
  const { size = 14, weight = 400, fill = C.fg, family = 'ui', anchor = 'start', spacing = 0, italic = false, op = 1 } = o
  const fam = family === 'mono' ? "Consolas, 'Courier New', monospace" : "'Segoe UI', 'Microsoft JhengHei', sans-serif"
  return `<text x="${x}" y="${y}" font-family="${fam}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${spacing ? ` letter-spacing="${spacing}"` : ''}${italic ? ' font-style="italic"' : ''}${op !== 1 ? ` opacity="${op}"` : ''}>${esc(s)}</text>`
}
const tw = (s) => [...String(s)].reduce((w, ch) => w + (/[ -~]/.test(ch) ? 8 : 15), 0)

// ── shared chrome ───────────────────────────────────────────────
function titlebar(label) {
  return (
    R(0, 0, W, 32, { fill: C.well }) +
    `<circle cx="18" cy="16" r="6" fill="${C.redis}"/><circle cx="38" cy="16" r="6" fill="${C.sqlite}"/><circle cx="58" cy="16" r="6" fill="${C.mongo}"/>` +
    T(W / 2, 21, `db-kit — ${label}`, { size: 13, fill: C.dim, anchor: 'middle' })
  )
}
function toolbar(btns) {
  let o = R(0, 32, W, 50, { fill: C.bar }) + L(0, 82, W, 82, C.border)
  let bx = 14
  for (const b of btns) {
    const w = tw(b.label) + 40
    o += R(bx, 42, w, 30, { rx: 7, fill: C.elevated })
    o += `<circle cx="${bx + 15}" cy="57" r="4" fill="${b.dot}"/>`
    o += T(bx + 26, 61, b.label, { size: 13, weight: 500 })
    bx += w + 9
  }
  return o
}
function statusbar(connDot, txt) {
  return (
    R(0, 764, W, 36, { fill: C.panel }) + L(0, 764, W, 764, C.border) +
    `<circle cx="20" cy="782" r="5" fill="${connDot}"/>` +
    T(34, 786, txt, { size: 12, fill: C.dim })
  )
}
// segmented control e.g. 資料 | 結構
function segmented(x, y, items, active) {
  let o = '', sx = x
  items.forEach((it, i) => {
    const w = tw(it) + 26
    o += R(sx, y, w, 26, { rx: 6, fill: i === active ? C.accent : C.elevated, op: i === active ? 1 : 0.9 })
    o += T(sx + w / 2, y + 17, it, { size: 12, weight: 600, fill: i === active ? '#fff' : C.dim, anchor: 'middle' })
    sx += w + 4
  })
  return o
}
function pill(x, y, label, o2 = {}) {
  const w = tw(label) + 22
  return R(x, y, w, 26, { rx: 6, fill: o2.fill || C.elevated, stroke: o2.stroke || 'none', sw: 1 }) +
    T(x + w / 2, y + 17, label, { size: 12, weight: 500, fill: o2.color || C.dim, anchor: 'middle' })
}
function tabstrip(tabs) {
  // tabs at y 82..116
  let o = R(CX, 82, W - CX, 34, { fill: C.app }) + L(CX, 116, W, 116, C.border)
  let tx = CX + 6
  tabs.forEach((t) => {
    const w = tw(t.label) + 46
    o += R(tx, 86, w, 30, { rx: 6, fill: t.active ? C.elevated : 'none' })
    o += `<rect x="${tx + 10}" y="96" width="12" height="11" rx="2" fill="none" stroke="${t.active ? C.accent : C.faint}" stroke-width="1.5"/>`
    o += T(tx + 28, 105, t.label, { size: 12, weight: t.active ? 600 : 400, fill: t.active ? C.fg : C.dim })
    o += T(tx + w - 14, 105, '×', { size: 13, fill: C.faint })
    tx += w + 4
  })
  return o
}
function grid({ x, y, colW, headers, rows, rowH = 32, headerH = 34, highlight = -1, editing = null, sortCol = -1 }) {
  let o = ''
  const total = colW.reduce((a, b) => a + b, 0)
  o += R(x, y, total, headerH, { fill: C.elevated })
  let cx = x
  headers.forEach((h, i) => {
    o += T(cx + 12, y + headerH / 2 + 5, h, { size: 13, weight: 600, fill: '#c7d0e0' })
    if (i === sortCol) o += T(cx + colW[i] - 16, y + headerH / 2 + 5, '▼', { size: 9, fill: C.accent })
    if (i > 0) o += L(cx, y, cx, y + headerH + rows.length * rowH, 'rgba(255,255,255,0.05)')
    cx += colW[i]
  })
  rows.forEach((row, r) => {
    const ry = y + headerH + r * rowH
    if (highlight === r) o += R(x, ry, total, rowH, { fill: 'rgba(59,130,246,0.20)' })
    else if (r % 2 === 1) o += R(x, ry, total, rowH, { fill: 'rgba(255,255,255,0.022)' })
    let cxx = x
    row.forEach((val, c) => {
      if (editing && editing.r === r && editing.c === c) {
        o += R(cxx + 3, ry + 3, colW[c] - 6, rowH - 6, { rx: 3, fill: 'rgba(245,158,11,0.20)', stroke: C.sqlite, sw: 1.5 })
      }
      const isNull = val === 'NULL'
      o += T(cxx + 12, ry + rowH / 2 + 5, val, { size: 13, fill: isNull ? C.faint : C.fg, italic: isNull, family: c === 0 ? 'mono' : 'ui' })
      cxx += colW[c]
    })
    o += L(x, ry + rowH, x + total, ry + rowH, 'rgba(255,255,255,0.04)')
  })
  o += R(x, y, total, headerH + rows.length * rowH, { stroke: 'rgba(255,255,255,0.07)', sw: 1 })
  return o
}
// connection tree sidebar
function sidebar(tree) {
  let o = R(0, 82, SIDEBAR_W, 682, { fill: C.panel }) + L(SIDEBAR_W, 82, SIDEBAR_W, 764, C.border)
  o += R(12, 94, SIDEBAR_W - 24, 28, { rx: 6, fill: C.inset, stroke: C.border, sw: 1 })
  o += T(24, 112, '搜尋連線 / 資料表…', { size: 12, fill: C.faint })
  let ty = 140
  for (const it of tree) {
    const ix = 16 + it.d * 16
    if (it.sel) o += R(8, ty - 14, SIDEBAR_W - 16, 26, { rx: 5, fill: 'rgba(59,130,246,0.20)' })
    if (it.exp !== undefined) o += T(ix - 12, ty + 4, it.exp ? '▾' : '▸', { size: 10, fill: C.dim })
    if (it.dot) o += `<circle cx="${ix + 4}" cy="${ty}" r="4.5" fill="${it.dot}"/>`
    else if (it.icon === 'db') o += `<path d="M${ix} ${ty - 4} a5 2.4 0 0 0 10 0 v8 a5 2.4 0 0 1 -10 0 z" fill="none" stroke="${C.dim}" stroke-width="1.3"/>`
    else if (it.icon === 'tbl') o += R(ix - 1, ty - 5, 11, 10, { rx: 1.5, fill: 'none', stroke: it.sel ? C.accent : C.dim, sw: 1.3 })
    else if (it.icon === 'folder') o += `<path d="M${ix - 1} ${ty - 4} h5 l1.5 2 h5 v7 h-11.5 z" fill="none" stroke="${C.sqlite}" stroke-width="1.2"/>`
    else if (it.icon === 'key') o += `<circle cx="${ix + 1}" cy="${ty - 1}" r="3" fill="none" stroke="${C.redis}" stroke-width="1.3"/><path d="M${ix + 3} ${ty + 1} l4 4" stroke="${C.redis}" stroke-width="1.3"/>`
    o += T(ix + 16, ty + 4, it.t, { size: 13, weight: it.sel ? 600 : 400, fill: it.sel ? C.fg : (it.d === 0 ? C.fg : '#b9c2d4') })
    if (it.sub) o += T(SIDEBAR_W - 14, ty + 4, it.sub, { size: 10, fill: C.faint, anchor: 'end' })
    ty += 28
  }
  return o
}
function wrap(inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    R(0, 0, W, H, { fill: C.app }) + inner +
    R(0.5, 0.5, W - 1, H - 1, { stroke: C.border, sw: 1 }) + `</svg>`
}

const TOOLBAR = [
  { label: '新增連線', dot: C.accent }, { label: '查詢', dot: C.accent }, { label: '匯入', dot: C.mongo },
  { label: '匯出', dot: C.mongo }, { label: '備份', dot: C.sqlite }, { label: 'ER 圖', dot: C.pg }, { label: 'AI 助手', dot: C.flame },
]
const SQL_TREE = [
  { d: 0, t: 'localhost', dot: C.mysql, sub: 'MySQL', exp: true },
  { d: 1, t: 'shop', icon: 'db', exp: true },
  { d: 2, t: 'users', icon: 'tbl', sel: true },
  { d: 2, t: 'orders', icon: 'tbl' },
  { d: 2, t: 'products', icon: 'tbl' },
  { d: 2, t: 'categories', icon: 'tbl' },
  { d: 1, t: 'analytics', icon: 'db', exp: false },
  { d: 0, t: 'prod-pg', dot: C.pg, sub: 'PostgreSQL', exp: false },
  { d: 0, t: 'cache', dot: C.redis, sub: 'Redis', exp: false },
]

// ── Screen 1: 資料表檢視 (data grid) ─────────────────────────────
function screenDataGrid() {
  let o = titlebar('MySQL · shop.users') + toolbar(TOOLBAR) + sidebar(SQL_TREE)
  o += tabstrip([{ label: 'users', active: true }, { label: 'orders' }, { label: '查詢' }])
  // sub-toolbar
  o += segmented(CX + 14, 126, ['資料', '結構'], 0)
  o += pill(CX + 130, 126, '篩選 · 2 條件', { color: C.accent, stroke: C.accent })
  o += pill(CX + 252, 126, '＋ 新增列')
  o += pill(CX + 770, 126, '匯入') + pill(CX + 840, 126, '匯出') + pill(CX + 910, 126, '重新整理')
  const headers = ['id', 'name', 'email', 'age', 'created_at', 'status']
  const colW = [60, 150, 250, 70, 190, 110]
  const rows = [
    ['1', 'Alice Chen', 'alice@example.com', '30', '2024-03-12 09:21', 'active'],
    ['2', 'Bob Lin', 'bob@corp.io', '25', '2024-03-13 14:05', 'active'],
    ['3', 'Carol Wu', 'carol.wu@mail.com', '41', '2024-03-15 08:47', 'inactive'],
    ['4', 'David Hsu', 'd.hsu@example.com', '36', '2024-03-18 11:30', 'active'],
    ['5', 'Emma Kuo', 'emma@startup.tw', '28', 'NULL', 'pending'],
    ['6', 'Frank Yeh', 'frank@example.com', '52', '2024-03-21 16:12', 'active'],
    ['7', 'Grace Lai', 'grace@mail.com', '33', '2024-03-22 10:08', 'active'],
    ['8', 'Henry Ma', 'henry@corp.io', '45', '2024-03-25 19:44', 'inactive'],
    ['9', 'Ivy Chang', 'ivy@example.com', '27', '2024-03-26 07:55', 'active'],
    ['10', 'Jack Wang', 'jack@startup.tw', '39', '2024-03-28 13:20', 'active'],
    ['11', 'Kelly Su', 'kelly@mail.com', '31', '2024-03-29 22:01', 'pending'],
    ['12', 'Leo Tsai', 'leo@example.com', '48', '2024-04-01 09:13', 'active'],
    ['13', 'Mia Hung', 'mia@example.com', '29', '2024-04-02 15:36', 'active'],
    ['14', 'Nina Pan', 'nina@corp.io', '37', '2024-04-04 12:50', 'inactive'],
  ]
  o += grid({ x: CX + 14, y: 168, colW, headers, rows, highlight: 3, editing: { r: 4, c: 3 }, sortCol: 0 })
  // pager
  o += T(CX + 14, 740, '顯示 1–50 · 共 1,240 列', { size: 12, fill: C.dim })
  o += pill(CX + 760, 727, '上一頁') + pill(CX + 840, 727, '下一頁') + pill(CX + 930, 727, '每頁 50')
  o += statusbar(C.mysql, 'localhost · 使用中 2 / 10 · 閒置 3 · 延遲 18 ms · 主鍵 id · 已選 1 列')
  return wrap(o)
}

// ── Screen 2: 查詢編輯器 + 結果 ──────────────────────────────────
function screenQuery() {
  let o = titlebar('MySQL · shop') + toolbar(TOOLBAR) + sidebar(SQL_TREE.map((n) => ({ ...n, sel: false })))
  o += tabstrip([{ label: 'users' }, { label: 'orders' }, { label: '查詢', active: true }])
  // editor pane
  o += R(CX + 14, 128, W - CX - 28, 210, { rx: 8, fill: C.well, stroke: C.border, sw: 1 })
  const kw = (s) => `<tspan fill="${C.accent}" font-weight="600">${esc(s)}</tspan>`
  const str = (s) => `<tspan fill="${C.sqlite}">${esc(s)}</tspan>`
  const fn = (s) => `<tspan fill="${C.mongo}">${esc(s)}</tspan>`
  const cm = (s) => `<tspan fill="${C.faint}" font-style="italic">${esc(s)}</tspan>`
  const lines = [
    `${cm('-- 每位活躍使用者的訂單數')}`,
    `${kw('SELECT')} u.id, u.name, ${fn('count')}(o.id) ${kw('AS')} orders`,
    `${kw('FROM')} users u`,
    `${kw('JOIN')} orders o ${kw('ON')} o.user_id = u.id`,
    `${kw('WHERE')} u.status = ${str("'active'")}`,
    `${kw('GROUP BY')} u.id`,
    `${kw('ORDER BY')} orders ${kw('DESC')}`,
    `${kw('LIMIT')} 20;`,
  ]
  let ly = 158
  lines.forEach((ln, i) => {
    o += T(CX + 30, ly, String(i + 1), { size: 13, fill: '#3d4759', family: 'mono', anchor: 'end' })
    o += `<text x="${CX + 44}" y="${ly}" font-family="Consolas, 'Courier New', monospace" font-size="14">${ln}</text>`
    ly += 24
  })
  // run bar
  o += pill(CX + 14, 350, '執行  F6', { fill: C.accent, color: '#fff' })
  o += pill(CX + 110, 350, '分析')
  o += pill(CX + 175, 350, '歷史') + pill(CX + 245, 350, '收藏') + pill(CX + 315, 350, '匯出')
  o += T(W - 28, 367, '32 ms · 20 列', { size: 12, fill: C.dim, anchor: 'end' })
  // results
  o += T(CX + 14, 404, '結果', { size: 13, weight: 600, fill: C.dim })
  const rows = [
    ['1', 'Alice Chen', '142'], ['8', 'Henry Ma', '119'], ['3', 'Carol Wu', '97'],
    ['12', 'Leo Tsai', '88'], ['6', 'Frank Yeh', '74'], ['10', 'Jack Wang', '63'],
    ['2', 'Bob Lin', '51'], ['9', 'Ivy Chang', '47'],
  ]
  o += grid({ x: CX + 14, y: 418, colW: [80, 220, 140], headers: ['id', 'name', 'orders'], rows, sortCol: 2 })
  o += statusbar(C.mysql, 'localhost · 查詢成功 · 32 ms · 回傳 20 列 · Ctrl+Enter 執行反白段')
  return wrap(o)
}

// ── Screen 3: ER 圖 ──────────────────────────────────────────────
function screenER() {
  let o = titlebar('PostgreSQL · shop · ER 圖') + toolbar(TOOLBAR) + sidebar(SQL_TREE.map((n) => ({ ...n, sel: false })))
  o += R(CX, 82, W - CX, 682, { fill: C.app })
  o += T(CX + 18, 110, 'ER 圖 — shop', { size: 14, weight: 600, fill: C.fg })
  o += pill(W - 250, 96, '－') + pill(W - 210, 96, '100%') + pill(W - 150, 96, '＋') + pill(W - 100, 96, '適配視窗')
  const card = (x, y, name, fields) => {
    const h = 30 + fields.length * 24 + 8
    let c = R(x, y, 200, h, { rx: 9, fill: C.elevated, stroke: C.border, sw: 1 })
    c += R(x, y, 200, 30, { rx: 9, fill: C.pg, op: 0.22 })
    c += R(x, y + 18, 200, 12, { fill: C.elevated })
    c += T(x + 14, y + 20, name, { size: 13, weight: 700, fill: '#c9d2e6' })
    fields.forEach((f, i) => {
      const fy = y + 30 + i * 24 + 16
      const mark = f.pk ? 'PK' : f.fk ? 'FK' : ''
      if (mark) o // noop
      c += T(x + 14, fy, f.n, { size: 12, fill: f.pk ? C.sqlite : C.fg, family: 'mono', weight: f.pk ? 600 : 400 })
      c += T(x + 130, fy, f.t, { size: 11, fill: C.faint, family: 'mono' })
      if (mark) c += T(x + 186, fy, mark, { size: 9, weight: 700, fill: f.pk ? C.sqlite : C.mongo, anchor: 'end' })
      c += L(x + 8, fy + 8, x + 192, fy + 8, 'rgba(255,255,255,0.04)')
    })
    return c
  }
  // FK edges (draw first, behind cards)
  const edge = (x1, y1, x2, y2) => L(x1, y1, x2, y2, C.dim, 1.6, {}) +
    `<circle cx="${x1}" cy="${y1}" r="3.5" fill="none" stroke="${C.dim}" stroke-width="1.6"/>` +
    `<path d="M${x2} ${y2} l-7 -4 M${x2} ${y2} l-7 4" stroke="${C.dim}" stroke-width="1.6" fill="none"/>`
  o += edge(CX + 240, 250, CX + 430, 200)   // orders.user_id -> users.id
  o += edge(CX + 240, 300, CX + 430, 470)   // orders.product_id -> products.id
  o += edge(CX + 630, 520, CX + 800, 470)   // products.category_id -> categories.id
  o += card(CX + 40, 160, 'orders', [
    { n: 'id', t: 'int4', pk: true }, { n: 'user_id', t: 'int4', fk: true },
    { n: 'product_id', t: 'int4', fk: true }, { n: 'total', t: 'numeric' }, { n: 'created_at', t: 'timestamptz' },
  ])
  o += card(CX + 430, 150, 'users', [
    { n: 'id', t: 'int4', pk: true }, { n: 'name', t: 'varchar' }, { n: 'email', t: 'varchar' }, { n: 'status', t: 'varchar' },
  ])
  o += card(CX + 430, 410, 'products', [
    { n: 'id', t: 'int4', pk: true }, { n: 'category_id', t: 'int4', fk: true }, { n: 'name', t: 'varchar' }, { n: 'price', t: 'numeric' },
  ])
  o += card(CX + 800, 410, 'categories', [
    { n: 'id', t: 'int4', pk: true }, { n: 'name', t: 'varchar' }, { n: 'slug', t: 'varchar' },
  ])
  o += statusbar(C.pg, 'prod-pg · 4 張表 · 3 條外鍵關係 · 拖曳表卡可調整佈局（自動記憶）')
  return wrap(o)
}

// ── Screen 4: Redis 鍵值檢視 ─────────────────────────────────────
function screenRedis() {
  const tree = [
    { d: 0, t: 'cache', dot: C.redis, sub: 'Redis', exp: true },
    { d: 1, t: 'db0', icon: 'db', exp: true },
    { d: 2, t: 'user:', icon: 'folder', exp: true },
    { d: 3, t: 'user:1001', icon: 'key', sel: true },
    { d: 3, t: 'user:1002', icon: 'key' },
    { d: 3, t: 'user:1003', icon: 'key' },
    { d: 2, t: 'session:', icon: 'folder', exp: false },
    { d: 2, t: 'cart:42', icon: 'key' },
    { d: 1, t: 'db1', icon: 'db', exp: false },
  ]
  const RTOOL = [
    { label: '＋ 新增鍵', dot: C.redis }, { label: '狀態', dot: C.accent }, { label: 'Pub/Sub', dot: C.mongo },
    { label: '維運', dot: C.sqlite }, { label: '命令列', dot: C.pg }, { label: 'AI 助手', dot: C.flame },
  ]
  let o = titlebar('Redis · cache · db0') + toolbar(RTOOL) + sidebar(tree)
  o += R(CX, 82, W - CX, 682, { fill: C.app })
  // key header
  o += T(CX + 18, 116, 'user:1001', { size: 17, weight: 700, fill: C.fg, family: 'mono' })
  o += pill(CX + 170, 100, 'HASH', { fill: 'rgba(239,68,68,0.20)', color: C.redis, stroke: C.redis })
  o += pill(CX + 240, 100, 'TTL 3600s')
  o += pill(CX + 340, 100, '4 個欄位')
  o += pill(W - 180, 100, '改名') + pill(W - 120, 100, '設 TTL') + pill(W - 60, 100, '刪除', { color: C.redis, stroke: C.redis })
  // hash field/value grid
  o += grid({
    x: CX + 18, y: 150, colW: [220, 480], headers: ['field', 'value'],
    rows: [
      ['name', 'Alice Chen'], ['email', 'alice@example.com'], ['age', '30'],
      ['city', 'Taipei'], ['plan', 'pro'], ['last_login', '2024-04-04T12:50:31Z'],
    ], rowH: 34,
  })
  o += pill(CX + 18, 410, '＋ 新增欄位') + pill(CX + 130, 410, '編輯') + pill(CX + 200, 410, '刪除欄位', { color: C.redis })
  // mini server-status strip
  o += R(CX + 18, 470, W - CX - 36, 230, { rx: 8, fill: C.panel, stroke: C.border, sw: 1 })
  o += T(CX + 34, 500, '伺服器狀態 (INFO)', { size: 13, weight: 600, fill: C.fg })
  const stats = [
    ['版本', '7.2.4'], ['記憶體', '48.2 MB'], ['鍵總數', '12,840'],
    ['連線數', '23'], ['每秒指令', '1,204 ops'], ['命中率', '98.6 %'],
  ]
  stats.forEach((s, i) => {
    const sx = CX + 34 + (i % 3) * 320
    const sy = 540 + Math.floor(i / 3) * 80
    o += R(sx, sy, 290, 64, { rx: 7, fill: C.inset, stroke: C.border, sw: 1 })
    o += T(sx + 16, sy + 26, s[0], { size: 12, fill: C.dim })
    o += T(sx + 16, sy + 50, s[1], { size: 20, weight: 700, fill: C.fg, family: 'mono' })
  })
  o += statusbar(C.redis, 'cache · db0 · 命名空間鍵樹（依 : 分組）· SCAN 游標式列舉 · 延遲 1 ms')
  return wrap(o)
}

async function render(name, svg) {
  await sharp(Buffer.from(svg)).png().toFile(resolve(OUT, name))
  console.log('  ✓', name)
}

await mkdir(OUT, { recursive: true })
console.log('產生介面預覽圖 →', OUT)
await render('01-data-grid.png', screenDataGrid())
await render('02-query-editor.png', screenQuery())
await render('03-er-diagram.png', screenER())
await render('04-redis.png', screenRedis())
console.log('完成。')
