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
  ["FURUSATO", "ふるさと納税", "🏯", 0xFF5D4037, false],
  ["OTHER", "その他", "📦", 0xFF9E9E9E, false],
  ["SALARY", "給与", "💴", 0xFF2E7D32, true],
  ["BONUS", "賞与", "🎉", 0xFF00838F, true],
  ["SIDE_INCOME", "副収入", "💼", 0xFF6A1B9A, true],
  ["TRIP_ALLOWANCE", "出張手当", "🧳", 0xFF0277BD, true],
  ["POINT_CASHBACK", "ポイント・還元", "🪙", 0xFFEF6C00, true],
  ["INCOME_OTHER", "その他収入", "💰", 0xFF827717, true],
].map(([id, label, emoji, color, income], order) => ({ id, label, emoji, color, order, hidden: false, builtin: true, income, split: id === "DINING" ? "even" : "default" }));

export const OTHER_ID = "OTHER";
export const INCOME_OTHER_ID = "INCOME_OTHER";
export const PAYMENT_METHODS = ["現金", "クレジットカード", "QRコード決済", "交通系・電子マネー", "デビット・口座振替", "その他"];
export const DEFAULT_AI_MODEL = "gemini-3.5-flash";

/** Androidの 0xFFRRGGBB を CSS の色に */
export function cssColor(argb) {
  const n = Number(argb) >>> 0;
  return "#" + (n & 0xffffff).toString(16).padStart(6, "0");
}

/** まだ設定していないカテゴリは、名前から貯蓄らしいもの（投資信託・積立保険・iDeCoなど）を初期値で貯蓄扱いにする */
export const looksLikeSavings = (label = "") =>
  /投資|投信|積立|積み立て|貯蓄|貯金|預金|ideco|イデコ|確定拠出|nisa|ニーサ/i.test(label);

/** 収支と貯蓄率。savings = 支出のうち貯蓄に数えるカテゴリの合計 */
export function balance(income, expense, savings = 0) {
  const net = income - expense;
  const saved = savings + net;
  return { income, expense, savings, net, saved, rate: income > 0 ? Math.trunc((saved * 100) / income) : null };
}

// ---------------- 負担のしかた（割り勘）：Android の Split / Splitter と同じ ----------------

export const SPLIT_MODES = [
  { id: "default", label: "共通", hint: "標準の割合で分ける" },
  { id: "even", label: "半分ずつ", hint: "人数で均等に分ける" },
  { id: "ratio", label: "割合を指定", hint: "この明細だけ別の割合" },
  { id: "amount", label: "金額を指定", hint: "相手の負担額を円で入れる" },
  { id: "payer", label: "払った人だけ", hint: "個人の出費。精算に入らない" },
  { id: "other", label: "相手の分（立替）", hint: "全額を相手が負担" },
];
export const splitLabel = (id) => SPLIT_MODES.find((m) => m.id === id)?.label ?? "共通";

/** 既定の負担をまだ決めていないカテゴリの初期値：貯蓄は払った人だけ、外食は半分ずつ */
/** カテゴリの支払いルール → 明細の負担の既定値 */
export const categorySplit = (c) => ({ mode: c?.split ?? "default", weights: c?.splitWeights ?? {}, amounts: c?.splitAmounts ?? {} });
export const defaultSplitFor = (c) => (c.income ? "default" : c.savings || c.id === "FURUSATO" ? "payer" : c.id === "DINING" ? "even" : "default");

/** 明細の負担のしかた。splitMode がない古い明細は shared から */
export function splitOf(t) {
  const mode = SPLIT_MODES.some((m) => m.id === t.splitMode) ? t.splitMode : (t.shared === false ? "payer" : "default");
  return { mode, weights: t.splitWeights ?? {}, amounts: t.splitAmounts ?? {} };
}
/** 家族の共通の出費か（精算の対象） */
export const isShared = (t) => !t.isIncome && !t.business && splitOf(t).mode !== "payer";
/** 家計の支出として数えるか（会社経費は数えない） */
export const counts = (t) => !t.business;

/** 保存するフィールド（shared は古い版との互換のため残す） */
export function splitFields(split) {
  return {
    splitMode: split.mode,
    splitWeights: split.mode === "ratio" && Object.keys(split.weights ?? {}).length ? split.weights : null,
    splitAmounts: split.mode === "amount" && Object.keys(split.amounts ?? {}).length ? split.amounts : null,
    shared: split.mode !== "payer",
  };
}

/** 割合で配分し、端数は小数部の大きい人から1円ずつ。割合が全員0なら均等 */
export function distribute(amount, people, weights) {
  if (!people.length) return {};
  const w = people.reduce((s, p) => s + (weights[p] ?? 0), 0) > 0 ? weights : Object.fromEntries(people.map((p) => [p, 1]));
  const sum = people.reduce((s, p) => s + (w[p] ?? 0), 0);
  const sign = amount < 0 ? -1 : 1;
  const abs = amount * sign;
  const raw = Object.fromEntries(people.map((p) => [p, (abs * (w[p] ?? 0)) / sum]));
  const out = Object.fromEntries(people.map((p) => [p, Math.floor(raw[p])]));
  let rest = abs - Object.values(out).reduce((a, b) => a + b, 0);
  const order = [...people].sort((a, b) => (raw[b] - Math.floor(raw[b])) - (raw[a] - Math.floor(raw[a])));
  for (const p of order) { if (rest <= 0) break; out[p] += 1; rest -= 1; }
  return Object.fromEntries(people.map((p) => [p, out[p] * sign]));
}

/** 1件の明細を、誰がいくら負担するかに分ける（合計は必ず amount） */
export function shares(amount, payer, split, members, defaultWeights = {}) {
  const people = [...new Set([...members, payer])].filter(Boolean);
  if (!people.length || !amount) return {};
  const std = Object.fromEntries(people.map((p) => [p, Math.max(0, defaultWeights[p] ?? 1)]));
  switch (split.mode) {
    case "payer": return { [payer]: amount };
    case "even": return distribute(amount, people, Object.fromEntries(people.map((p) => [p, 1])));
    case "ratio": return distribute(amount, people, Object.fromEntries(people.map((p) => [p, Math.max(0, split.weights?.[p] ?? 0)])));
    case "other": {
      const others = people.filter((p) => p !== payer);
      return others.length ? distribute(amount, others, std) : { [payer]: amount };
    }
    case "amount": {
      // 全員の額が決まっている（支払いルール：家賃 5万・3万など）ときは、その割合で分ける
      if (people.every((p) => (split.amounts?.[p] ?? -1) >= 0) && people.reduce((s, p) => s + split.amounts[p], 0) > 0) {
        return distribute(amount, people, Object.fromEntries(people.map((p) => [p, split.amounts[p]])));
      }
      const sign = amount < 0 ? -1 : 1;
      let left = amount * sign;
      const fixed = {};
      for (const p of people) {
        if (split.amounts?.[p] == null) continue;
        const v = Math.min(Math.max(0, split.amounts[p]), left);
        fixed[p] = v; left -= v;
      }
      let restPeople = people.filter((p) => !(p in fixed));
      if (!restPeople.length) restPeople = [payer];
      const rest = distribute(left, restPeople, Object.fromEntries(restPeople.map((p) => [p, 1])));
      return Object.fromEntries(people.map((p) => [p, ((fixed[p] ?? 0) + (rest[p] ?? 0)) * sign]));
    }
    default: return distribute(amount, people, std);
  }
}

/** 家計簿のカテゴリ一覧（保存済みの設定＋標準） */
export class Categories {
  constructor(stored = []) {
    const ids = new Set(stored.map((c) => c.id));
    const defIncome = Object.fromEntries(DEFAULT_CATEGORIES.map((c) => [c.id, c.income]));
    const merged = [
      ...stored.map((c) => {
        const x = { ...c, income: c.income ?? defIncome[c.id] ?? false, savings: c.savings ?? looksLikeSavings(c.label) };
        return { ...x, split: SPLIT_MODES.some((m) => m.id === c.split) && c.split !== "other" ? c.split : defaultSplitFor(x) };
      }),
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

export function settlement(expenses, members, weights = {}, records = [], carry = {}) {
  const shared = expenses.filter(isShared);
  const people = [...new Set([...members, ...shared.map(payerOf), ...Object.keys(carry), ...records.flatMap((r) => [r.from, r.to])])].filter(Boolean);
  if (!people.length) return { total: 0, members: [], transfers: [] };
  const paid = {}, share = {};
  for (const t of shared) {
    const p = payerOf(t);
    paid[p] = (paid[p] ?? 0) + t.amount;
    for (const [u, v] of Object.entries(shares(t.amount, p, splitOf(t), members, weights))) share[u] = (share[u] ?? 0) + v;
  }
  const balances = people.map((p) => {
    const sent = records.filter((r) => r.from === p).reduce((s, r) => s + r.amount, 0);
    const received = records.filter((r) => r.to === p).reduce((s, r) => s + r.amount, 0);
    const c = carry[p] ?? 0;
    return { uid: p, paid: paid[p] ?? 0, share: share[p] ?? 0, sent, received, carry: c, balance: c + (paid[p] ?? 0) - (share[p] ?? 0) + sent - received };
  });
  return { total: shared.reduce((s, t) => s + t.amount, 0), members: balances, transfers: transfersOf(balances) };
}

function transfersOf(balances) {
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
  return transfers;
}

/** 前の月までの未精算（繰越） */
export function carryOver(prior, members, weights, priorRecords) {
  const out = {};
  for (const m of settlement(prior, members, weights, priorRecords).members) if (m.balance) out[m.uid] = m.balance;
  return out;
}

/** LINE などで送る精算の文面（Android と同じ） */
export function summaryText(monthLabel, r, nameOf, ratioLabel) {
  const ms = r.members.filter((m) => m.paid || m.share || m.carry || m.sent || m.received);
  const lines = [`【${monthLabel}の家計の精算】`, `共通の出費 ${yen(r.total)}`,
    "　払った額：" + ms.map((m) => `${nameOf(m.uid)} ${yen(m.paid)}`).join("／"),
    "　負担額：" + ms.map((m) => `${nameOf(m.uid)} ${yen(m.share)}`).join("／") + (ratioLabel ? `（${ratioLabel}）` : "")];
  if (ms.some((m) => m.carry)) lines.push("　前月までの未精算：" + ms.filter((m) => m.carry).map((m) => `${nameOf(m.uid)} ${m.carry > 0 ? "受け取り" : "支払い"} ${yen(Math.abs(m.carry))}`).join("／"));
  for (const m of r.members.filter((m) => m.sent > 0)) lines.push(`　精算済み：${nameOf(m.uid)}が ${yen(m.sent)} を渡した`);
  lines.push(r.transfers.length ? r.transfers.map((t) => `→ ${nameOf(t.from)}から${nameOf(t.to)}へ ${yen(t.amount)}`).join("\n") : "→ 精算は必要ありません");
  return lines.join("\n");
}

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
export function categoryTotals(r, keyOf = (i) => i.category, fallback = OTHER_ID) {
  const base = {};
  for (const i of r.items) base[keyOf(i)] = (base[keyOf(i)] ?? 0) + i.price;
  for (const k of Object.keys(base)) if (base[k] === 0) delete base[k];
  const keys = Object.keys(base);
  if (!keys.length) return r.total > 0 ? { [fallback]: r.total } : {};
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
export function buildSave(r, { uid, name, receiptId, now, payment, paidBy, split }) {
  const dateMs = millisOf(r.date);
  const store = [r.store, r.branch].filter(Boolean).join(" ");
  // 「相手の分」の品目は別の明細にして、全額を相手の負担にする
  const parts = categoryTotals(r, (i) => i.category + (i.forOther ? "|other" : "|"), OTHER_ID + "|");
  const totals = categoryTotals(r);
  const base = split ?? { mode: "default" };
  const txns = Object.entries(parts).map(([k, amount]) => {
    const [cat, tag] = k.split("|");
    const other = tag === "other";
    const names = r.items.filter((i) => i.category === cat && !!i.forOther === other).map((i) => i.name);
    return {
      amount, category: cat, date: dateMs, store,
      memo: (other ? "相手の分：" : "") + names.slice(0, 5).join("、") + (names.length > 5 ? ` ほか${names.length - 5}点` : ""),
      createdBy: uid, createdByName: name, receiptId, createdAt: now,
      payment: payment ?? "", paidBy: paidBy ?? "", recurringId: null,
      ...splitFields(other ? { mode: "other" } : base),
      business: false, updatedAt: 0, source: "",
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

export const DEFAULT_SETTLE_START = "2026-11";
export const settingsFrom = (m) => ({
  aiEnabled: m?.aiEnabled ?? true, aiAuto: m?.aiAuto ?? true,
  aiDailyLimit: m?.aiDailyLimit ?? 20, aiMonthlyLimit: m?.aiMonthlyLimit ?? 100,
  aiModel: m?.aiModel || DEFAULT_AI_MODEL, weekStartsMonday: m?.weekStartsMonday ?? true, split: m?.split ?? {},
  tripDaily: m?.tripDaily ?? 3500, tripHolidayTravel: m?.tripHolidayTravel ?? 1500, settleStart: m?.settleStart || DEFAULT_SETTLE_START,
});

// ---------------- 表示 ----------------

export const yen = (n) => "¥" + Math.round(n).toLocaleString("ja-JP");
export const signedYen = (n) => (n > 0 ? "+" : n < 0 ? "−" : "±") + yen(Math.abs(n));
export function yenShort(n) {
  if (n >= 1e8) return (n / 1e8).toFixed(1) + "億";
  if (n >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, "") + "万";
  return Math.round(n).toLocaleString("ja-JP");
}
