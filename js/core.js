// レシート家計簿 Web版：画面やFirebaseに依存しない計算ロジック（Android版と同じ結果になるように移植）

export const DEFAULT_CATEGORIES = [
  ["FOOD", "食費", "🥬", 0xFF43A047, false],
  ["DINING", "外食", "🍜", 0xFFF4511E, false],
  ["DAILY", "日用品", "🧻", 0xFF1E88E5, false],
  ["HEALTH", "医療・健康", "💊", 0xFFE53935, false],
  ["CLOTHING", "衣服・美容", "👕", 0xFF8E24AA, false],
  ["TRANSPORT", "交通・車", "🚃", 0xFF00897B, false],
  ["HOBBY", "趣味・娯楽", "🎮", 0xFFFDD835, false],
  ["EDUCATION", "教育・書籍", "📚", 0xFF6D4C41, false],
  ["HOUSING", "住居・光熱", "🏠", 0xFF546E7A, false],
  ["COMM", "通信", "📱", 0xFF3949AB, false],
  ["SOCIAL", "交際費", "🎁", 0xFFD81B60, false],
  ["OTHER", "その他", "📦", 0xFF9E9E9E, false],
  ["SALARY", "給与", "💴", 0xFF2E7D32, true],
  ["BONUS", "賞与", "🎉", 0xFF00838F, true],
  ["SIDE_INCOME", "副収入", "💼", 0xFF6A1B9A, true],
  ["INCOME_OTHER", "その他収入", "💰", 0xFF827717, true],
].map(([id, label, emoji, color, income], order) => ({ id, label, emoji, color, order, hidden: false, builtin: true, income }));

export const OTHER_ID = "OTHER";
export const INCOME_OTHER_ID = "INCOME_OTHER";
export const PAYMENT_METHODS = ["現金", "クレジットカード", "QRコード決済", "交通系・電子マネー", "デビット・口座振替", "その他"];
export const DEFAULT_AI_MODEL = "gemini-3.5-flash";

/** Androidの 0xFFRRGGBB を CSS の色に */
export function cssColor(argb) {
  const n = Number(argb) >>> 0;
  return "#" + (n & 0xffffff).toString(16).padStart(6, "0");
}

/** 家計簿のカテゴリ一覧（保存済みの設定＋標準） */
export class Categories {
  constructor(stored = []) {
    const ids = new Set(stored.map((c) => c.id));
    const defIncome = Object.fromEntries(DEFAULT_CATEGORIES.map((c) => [c.id, c.income]));
    const merged = [
      ...stored.map((c) => ({ ...c, income: c.income ?? defIncome[c.id] ?? false })),
      ...DEFAULT_CATEGORIES.filter((c) => !ids.has(c.id)),
    ];
    this.all = merged.sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || a.label.localeCompare(b.label));
    this.byId = Object.fromEntries(this.all.map((c) => [c.id, c]));
  }
  get(id) { return this.byId[id] ?? this.byId[OTHER_ID]; }
  has(id) { return id in this.byId; }
  get visible() { return this.all.filter((c) => !c.income && (!c.hidden || c.id === OTHER_ID)); }
  get incomeVisible() { return this.all.filter((c) => c.income && (!c.hidden || c.id === INCOME_OTHER_ID)); }
}

/** 全角英数字・記号を半角に */
export function normalize(s) {
  let out = "";
  for (const c of String(s ?? "")) {
    const code = c.codePointAt(0);
    if (code >= 0xff10 && code <= 0xff19) out += String.fromCharCode(code - 0xff10 + 48);
    else if (code >= 0xff21 && code <= 0xff3a) out += String.fromCharCode(code - 0xff21 + 65);
    else if (code >= 0xff41 && code <= 0xff5a) out += String.fromCharCode(code - 0xff41 + 97);
    else out += ({ "￥": "¥", "，": ",", "、": ",", "．": ".", "－": "-", "−": "-", "‐": "-", "―": "-", "　": " ", "＠": "@", "＊": "*", "×": "x", "ｘ": "x", "Ｘ": "x", "（": "(", "）": ")", "％": "%", "：": ":", "／": "/" })[c] ?? c;
  }
  return out;
}

/** 照合用キー（Android の CategoryClassifier.key と同じ） */
export function key(s) {
  let out = "";
  for (const c of normalize(s).toUpperCase()) {
    const code = c.codePointAt(0);
    if (code >= 0x3041 && code <= 0x3096) out += String.fromCharCode(code + 0x60);
    else if (/\s/.test(c) || "*※・/".includes(c)) continue;
    else out += c;
  }
  return out;
}

/** 品名の掃除（軽減税率マークや末尾の数量を除く） */
export function cleanName(s) {
  return String(s ?? "")
    .replace(/^[0-9]{3,}\s+/, "")
    .replace(/^[\s◎○〇●◇◆□■☆★*※©®•・#>＞]+/, "")
    .replace(/[*※]+/g, "")
    .replace(/\s*[x×]\s*[0-9]{1,3}$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ---------------- 日付 ----------------

export const pad2 = (n) => String(n).padStart(2, "0");
export const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
export const ym = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
export const slashDate = (d) => `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
export const dayOnly = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
export const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);
/** 明細の date（端末の現地時刻での0時のミリ秒。Android と同じ） */
export const millisOf = (d) => dayOnly(d).getTime();
export const dateOf = (millis) => dayOnly(new Date(millis));

export function parseDateInput(s) {
  const m = String(s ?? "").trim().match(/^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})$/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return d.getMonth() === +m[2] - 1 ? d : null;
}

const WEEK = ["日", "月", "火", "水", "木", "金", "土"];

export class Period {
  constructor(type, start, end, weekStartsMonday = true) {
    Object.assign(this, { type, start, end, weekStartsMonday });
  }
  static of(type, anchor, weekStartsMonday = true) {
    const a = dayOnly(anchor);
    if (type === "week") {
      const first = weekStartsMonday ? 1 : 0;
      const back = (a.getDay() - first + 7) % 7;
      const s = addDays(a, -back);
      return new Period(type, s, addDays(s, 7), weekStartsMonday);
    }
    if (type === "month") {
      const s = new Date(a.getFullYear(), a.getMonth(), 1);
      return new Period(type, s, addMonths(s, 1), weekStartsMonday);
    }
    const s = new Date(a.getFullYear(), 0, 1);
    return new Period(type, s, new Date(a.getFullYear() + 1, 0, 1), weekStartsMonday);
  }
  get days() { return Math.round((this.end - this.start) / 86400000); }
  get label() {
    const md = (d) => `${d.getMonth() + 1}/${d.getDate()}`;
    if (this.type === "week") return `${md(this.start)}〜${md(addDays(this.end, -1))}`;
    if (this.type === "month") return `${this.start.getFullYear()}年${this.start.getMonth() + 1}月`;
    return `${this.start.getFullYear()}年`;
  }
  shift(n) {
    if (this.type === "week") return Period.of("week", addDays(this.start, 7 * n), this.weekStartsMonday);
    if (this.type === "month") return Period.of("month", addMonths(this.start, n), this.weekStartsMonday);
    return Period.of("year", new Date(this.start.getFullYear() + n, 0, 1), this.weekStartsMonday);
  }
  contains(d) { return d >= this.start && d < this.end; }
  buckets() {
    if (this.type === "year") {
      return Array.from({ length: 12 }, (_, m) => {
        const s = new Date(this.start.getFullYear(), m, 1);
        return { label: `${m + 1}月`, start: s, end: addMonths(s, 1) };
      });
    }
    return Array.from({ length: this.days }, (_, i) => {
      const d = addDays(this.start, i);
      return { label: this.type === "week" ? WEEK[d.getDay()] : String(d.getDate()), start: d, end: addDays(d, 1) };
    });
  }
}

export function aggregate(txns, period) {
  const inRange = txns.filter((t) => period.contains(dateOf(t.date)));
  const map = new Map();
  for (const t of inRange) {
    const c = map.get(t.category) ?? { id: t.category, amount: 0, count: 0 };
    c.amount += t.amount; c.count += 1; map.set(t.category, c);
  }
  const buckets = period.buckets().map((b) => {
    const m = {};
    for (const t of inRange) {
      const d = dateOf(t.date);
      if (d >= b.start && d < b.end) m[t.category] = (m[t.category] ?? 0) + t.amount;
    }
    return m;
  });
  return {
    total: inRange.reduce((s, t) => s + t.amount, 0),
    count: inRange.length,
    byCategory: [...map.values()].sort((a, b) => b.amount - a.amount),
    buckets,
  };
}

/** その月に適用される予算（適用開始月がその月以前で最も新しいもの）。budgets = [{month:'yyyy-MM', total, categories}] */
export function resolveBudget(month, budgets) {
  return budgets.filter((b) => b.month <= month).sort((a, b) => b.month.localeCompare(a.month))[0] ?? null;
}

export function budgetFor(period, budgets) {
  if (period.type === "week") return null;
  if (period.type === "month") return resolveBudget(ym(period.start), budgets);
  const months = Array.from({ length: 12 }, (_, m) => resolveBudget(`${period.start.getFullYear()}-${pad2(m + 1)}`, budgets)).filter(Boolean);
  if (!months.length) return null;
  const totals = months.map((b) => b.total).filter((v) => v != null);
  const categories = {};
  for (const b of months) for (const [k, v] of Object.entries(b.categories ?? {})) categories[k] = (categories[k] ?? 0) + v;
  return { month: ym(period.start), total: totals.length ? totals.reduce((a, b) => a + b, 0) : null, categories };
}

export function perDayLeft(spent, budget, period, today) {
  if (period.type !== "month" || !period.contains(dayOnly(today))) return null;
  const left = Math.round((period.end - dayOnly(today)) / 86400000);
  return left <= 0 ? null : Math.max(0, Math.floor((budget - spent) / left));
}

export function isOverPace(spent, budget, period, today) {
  if (period.type !== "month" || budget <= 0 || !period.contains(dayOnly(today))) return false;
  const elapsed = Math.round((dayOnly(today) - period.start) / 86400000) + 1;
  return spent / budget > elapsed / period.days + 0.05;
}

// ---------------- 立替・精算 ----------------

export const payerOf = (t) => t.paidBy || t.createdBy;

export function settlement(expenses, members, weights = {}, records = []) {
  const shared = expenses.filter((t) => t.shared !== false);
  const people = [...new Set([...members, ...shared.map(payerOf)])].filter(Boolean);
  if (!people.length) return { total: 0, members: [], transfers: [] };
  const total = shared.reduce((s, t) => s + t.amount, 0);
  const w = Object.fromEntries(people.map((p) => [p, Math.max(0, weights[p] ?? 1)]));
  const wSum = Object.values(w).reduce((a, b) => a + b, 0) || null;
  const raw = Object.fromEntries(people.map((p) => [p, wSum == null ? total / people.length : (total * w[p]) / wSum]));
  const share = Object.fromEntries(people.map((p) => [p, Math.floor(raw[p])]));
  let rest = total - Object.values(share).reduce((a, b) => a + b, 0);
  for (const p of [...people].sort((a, b) => (raw[b] - Math.floor(raw[b])) - (raw[a] - Math.floor(raw[a])))) {
    if (rest <= 0) break;
    share[p] += 1; rest -= 1;
  }
  const balances = people.map((p) => {
    const paid = shared.filter((t) => payerOf(t) === p).reduce((s, t) => s + t.amount, 0);
    const sent = records.filter((r) => r.from === p).reduce((s, r) => s + r.amount, 0);
    const received = records.filter((r) => r.to === p).reduce((s, r) => s + r.amount, 0);
    return { uid: p, paid, share: share[p], sent, received, balance: paid - share[p] + sent - received };
  });
  const debtors = balances.filter((b) => b.balance < 0).map((b) => [b.uid, -b.balance]).sort((a, b) => b[1] - a[1]);
  const creditors = balances.filter((b) => b.balance > 0).map((b) => [b.uid, b.balance]).sort((a, b) => b[1] - a[1]);
  const transfers = [];
  while (debtors.length && creditors.length) {
    const [d, dv] = debtors[0]; const [c, cv] = creditors[0];
    const x = Math.min(dv, cv);
    if (x > 0) transfers.push({ from: d, to: c, amount: x });
    if (dv === x) debtors.shift(); else debtors[0] = [d, dv - x];
    if (cv === x) creditors.shift(); else creditors[0] = [c, cv - x];
  }
  return { total, members: balances, transfers };
}

// ---------------- 貯金目標 ----------------

export function goalSaved(g) { return (g.deposits ?? []).reduce((s, d) => s + (d.amount ?? 0), 0); }

export function monthlyNeeded(g, today) {
  const m = String(g.deadline ?? "").match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const left = g.target - goalSaved(g);
  if (left <= 0) return null;
  const months = (+m[1] - today.getFullYear()) * 12 + (+m[2] - (today.getMonth() + 1)) + 1;
  return months <= 0 ? left : Math.ceil(left / months);
}

// ---------------- レシート（AIの結果 → 確認画面 → 保存） ----------------

/** 家族の学習ルール（品名キー → カテゴリ）を最長一致で引く */
export function learnedFor(name, rules, cats) {
  const k = key(name);
  if (!k) return null;
  const ok = (id) => (id && (!cats || cats.has(id)) ? id : null);
  if (rules[k]) return ok(rules[k]);
  let best = null;
  for (const [kw, id] of Object.entries(rules)) if (kw.length >= 2 && k.includes(kw) && (!best || kw.length > best[0].length)) best = [kw, id];
  return best ? ok(best[1]) : null;
}

export function aiPrompt(cats) {
  const list = cats.visible.map((c) => `- ${c.id}: ${c.label}`).join("\n");
  return `あなたは日本のレシートを読み取るアシスタントです。画像のレシート（複数枚なら上から順につながった1枚）を読み、
次の形のJSONだけを返してください。説明文は不要です。
{"store":"店名（チェーンは正式名。例: ファミリーマート）","branch":"支店名（なければ空文字）",
 "date":"YYYY-MM-DD（読めなければ空文字）","total":支払合計の整数,
 "taxMode":"included か excluded か unknown",
 "items":[{"name":"品名","price":値引き後の金額の整数,"category":"カテゴリID"}]}
ルール:
- 値引き・割引の行は直前の品目の金額から差し引き、単独の品目にしない
- 小計・合計・消費税・お預り・お釣り・ポイントは items に含めない
- 品名の先頭の軽減税率マーク（◎ ※ * など）は除く
- 数量だけの行（「×2」など）は品名に含めない
- 飲食店（レストラン・居酒屋・カフェ）のレシートでは、料理や飲み物は DINING にする
- total は「合計」の金額
- category は次のIDから最も合うものを選ぶ:
${list}`;
}

export function reviewFromAi(json, cats, rules, renames, today = new Date()) {
  const cleaned = String(json).trim().replace(/^```json/, "").replace(/^```/, "").replace(/```$/, "").trim();
  const o = JSON.parse(cleaned);
  const items = [];
  for (const it of Array.isArray(o.items) ? o.items : []) {
    const raw = cleanName(it?.name);
    const price = Math.round(Number(it?.price ?? 0));
    if (!raw || !price) continue;
    const name = renames[key(raw)] ?? raw;
    const aiCat = cats.has(it?.category) && !cats.get(it.category).income ? it.category : null;
    const c = learnedFor(name, rules, cats) ?? aiCat ?? OTHER_ID;
    items.push({ id: items.length, name, price, category: c, suggested: c, ocrName: raw });
  }
  let date = parseDateInput(String(o.date ?? "").replace(/-/g, "/"));
  if (!date || date > addDays(dayOnly(today), 1)) date = dayOnly(today);
  const total = Math.round(Number(o.total ?? 0)) || items.reduce((s, i) => s + i.price, 0);
  const taxMode = o.taxMode === "included" ? "included" : o.taxMode === "excluded" ? "excluded" : "unknown";
  return { store: String(o.store ?? "").trim(), branch: String(o.branch ?? "").trim(), date, items, total, taxMode, source: "ai" };
}

export const itemsSum = (r) => r.items.reduce((s, i) => s + i.price, 0);
export const difference = (r) => (r.total > 0 && r.items.length ? r.total - itemsSum(r) : 0);

export function adjustment(r) {
  const diff = difference(r);
  if (diff === 0 || r.taxMode === "included") return 0;
  const sum = itemsSum(r);
  if (sum <= 0) return 0;
  const limit = Math.floor((sum * 11) / 100) + 1;
  return Math.abs(diff) <= limit ? diff : 0;
}

export const isConsistent = (r) => r.items.length > 0 && r.total > 0 && (difference(r) === 0 || adjustment(r) !== 0);

/** カテゴリ別の金額（外税などの差額は金額比で按分。合計はレシート合計と一致） */
export function categoryTotals(r) {
  const base = {};
  for (const i of r.items) base[i.category] = (base[i.category] ?? 0) + i.price;
  for (const k of Object.keys(base)) if (base[k] === 0) delete base[k];
  const keys = Object.keys(base);
  if (!keys.length) return r.total > 0 ? { [OTHER_ID]: r.total } : {};
  const adj = adjustment(r);
  if (!adj) return base;
  const sum = keys.reduce((s, k) => s + base[k], 0);
  const raw = Object.fromEntries(keys.map((k) => [k, (adj * base[k]) / sum]));
  const result = Object.fromEntries(keys.map((k) => [k, base[k] + Math.floor(raw[k])]));
  let rest = adj - keys.reduce((s, k) => s + Math.floor(raw[k]), 0);
  const order = [...keys].sort((a, b) => (raw[b] - Math.floor(raw[b])) - (raw[a] - Math.floor(raw[a])));
  for (let i = 0; rest > 0 && order.length; i++, rest--) result[order[i % order.length]] += 1;
  return result;
}

/** 確認画面の内容を、Android と同じ形式の保存データにする */
export function buildSave(r, { uid, name, receiptId, now, payment, paidBy, shared }) {
  const dateMs = millisOf(r.date);
  const store = [r.store, r.branch].filter(Boolean).join(" ");
  const totals = categoryTotals(r);
  const txns = Object.entries(totals).map(([cat, amount]) => {
    const names = r.items.filter((i) => i.category === cat).map((i) => i.name);
    return {
      amount, category: cat, date: dateMs, store,
      memo: names.slice(0, 5).join("、") + (names.length > 5 ? ` ほか${names.length - 5}点` : ""),
      createdBy: uid, createdByName: name, receiptId, createdAt: now,
      payment: payment ?? "", paidBy: paidBy ?? "", shared: shared !== false, recurringId: null,
    };
  });
  const receipt = {
    store: r.store, branch: r.branch, date: dateMs, total: Object.values(totals).reduce((a, b) => a + b, 0),
    items: r.items.map((i) => ({ name: i.name, price: i.price, category: i.category })),
    source: r.source ?? "ai", createdBy: uid, createdByName: name, createdAt: now,
  };
  const rules = [];
  for (const i of r.items) {
    const k = key(i.name);
    if (i.category !== i.suggested && k.length >= 2) rules.push({ type: "category", keyword: k, category: i.category, value: null });
    const ok = key(i.ocrName ?? i.name);
    if (i.name !== i.ocrName && ok.length >= 2 && ok !== k) rules.push({ type: "rename", keyword: ok, category: null, value: i.name });
  }
  return { txns, receipt, rules };
}

/** ルールの保存先ドキュメントID（Android と同じ） */
export function ruleDocId(r) {
  const safe = r.keyword.replace(/\//g, "_").replace(/\./g, "_").slice(0, 100);
  return r.type === "category" ? safe : `${r.type}_${safe}`;
}

/** AI の利用回数（Android と同じ規則） */
export function normalizeUsage(u, today) {
  const d = ymd(today); const m = ym(today);
  return {
    day: d, dayCount: u?.day === d ? u.dayCount ?? 0 : 0,
    month: m, monthCount: u?.month === m ? u.monthCount ?? 0 : 0,
    blockedDay: u?.blockedDay ?? "",
  };
}

export function reserveDecision(u, s, today) {
  const n = normalizeUsage(u, today);
  if (n.blockedDay === ymd(today)) return { kind: "blocked", next: null };
  if (n.dayCount >= s.aiDailyLimit) return { kind: "limit", daily: true, next: null };
  if (n.monthCount >= s.aiMonthlyLimit) return { kind: "limit", daily: false, next: null };
  const next = { ...n, dayCount: n.dayCount + 1, monthCount: n.monthCount + 1 };
  return { kind: "ok", next, dayLeft: s.aiDailyLimit - next.dayCount, monthLeft: s.aiMonthlyLimit - next.monthCount };
}

export const settingsFrom = (m) => ({
  aiEnabled: m?.aiEnabled ?? true, aiAuto: m?.aiAuto ?? true,
  aiDailyLimit: m?.aiDailyLimit ?? 20, aiMonthlyLimit: m?.aiMonthlyLimit ?? 100,
  aiModel: m?.aiModel || DEFAULT_AI_MODEL, weekStartsMonday: m?.weekStartsMonday ?? true, split: m?.split ?? {},
});

// ---------------- 表示 ----------------

export const yen = (n) => "¥" + Math.round(n).toLocaleString("ja-JP");
export const signedYen = (n) => (n > 0 ? "+" : n < 0 ? "−" : "±") + yen(Math.abs(n));
export function yenShort(n) {
  if (n >= 1e8) return (n / 1e8).toFixed(1) + "億";
  if (n >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, "") + "万";
  return Math.round(n).toLocaleString("ja-JP");
}
