import test from "node:test";
import assert from "node:assert/strict";
import * as C from "../js/core.js";

const t = (y, m, d, cat, amount, extra = {}) => ({ id: `${y}${m}${d}${cat}${amount}`, amount, category: cat, date: C.millisOf(new Date(y, m - 1, d)), ...extra });
const txns = [t(2026, 9, 27, "FOOD", 1000), t(2026, 9, 28, "FOOD", 500), t(2026, 9, 28, "DAILY", 300), t(2026, 9, 30, "DINING", 2000), t(2026, 10, 1, "FOOD", 800), t(2025, 12, 31, "FOOD", 999)];

test("週・月・年の集計（Android の StatsTest と同じ値）", () => {
  const w = C.Period.of("week", new Date(2026, 8, 28));
  assert.equal(C.ymd(w.start), "2026-09-28");
  const a = C.aggregate(txns, w);
  assert.equal(a.total, 3600);
  assert.equal(a.buckets.reduce((s, b) => s + Object.values(b).reduce((x, y) => x + y, 0), 0), 3600);
  assert.equal(C.aggregate(txns, C.Period.of("week", new Date(2026, 8, 28), false)).total, 4600);
  const m = C.aggregate(txns, C.Period.of("month", new Date(2026, 8, 5)));
  assert.equal(m.total, 3800); assert.equal(m.buckets.length, 30); assert.equal(m.byCategory[0].id, "DINING");
  const y = C.aggregate(txns, C.Period.of("year", new Date(2026, 0, 1)));
  assert.equal(y.total, 4600); assert.equal(y.buckets.length, 12);
});

test("予算の引き継ぎとペース", () => {
  const budgets = [{ month: "2026-07", total: 200000, categories: { FOOD: 50000 } }, { month: "2026-12", total: 250000, categories: { FOOD: 60000 } }];
  assert.equal(C.resolveBudget("2026-09", budgets).total, 200000);
  assert.equal(C.resolveBudget("2026-06", budgets), null);
  assert.equal(C.budgetFor(C.Period.of("year", new Date(2026, 2, 1)), budgets).total, 200000 * 5 + 250000);
  const p = C.Period.of("month", new Date(2026, 8, 1));
  assert.equal(C.isOverPace(60000, 100000, p, new Date(2026, 8, 10)), true);
  assert.equal(C.perDayLeft(80000, 100000, p, new Date(2026, 8, 21)), 2000);
});

test("立替・精算（Android と同じ）", () => {
  const e = [t(2026, 9, 1, "FOOD", 6000, { createdBy: "a" }), t(2026, 9, 1, "FOOD", 2000, { createdBy: "b" }), t(2026, 9, 1, "FOOD", 5000, { createdBy: "b", shared: false })];
  assert.deepEqual(C.settlement(e, ["a", "b"]).transfers, [{ from: "b", to: "a", amount: 2000 }]);
  const one = [t(2026, 9, 1, "FOOD", 10001, { createdBy: "a" })];
  const r = C.settlement(one, ["a", "b"], { a: 6, b: 4 });
  assert.equal(r.members.reduce((s, m) => s + m.share, 0), 10001);
  assert.deepEqual(r.transfers, [{ from: "b", to: "a", amount: 4000 }]);
  assert.deepEqual(C.settlement(one, ["a", "b"], { a: 6, b: 4 }, [{ from: "b", to: "a", amount: 4000 }]).transfers, []);
});

test("キーの正規化（ひらがな→カタカナ・全角→半角）", () => {
  assert.equal(C.key("ぎゅうにゅう １０００ml"), "ギュウニュウ1000ML");
  assert.equal(C.cleanName("◎茶碗蒸し ×2"), "茶碗蒸し");
});

test("AIの結果 → 確認画面 → 保存データ", () => {
  const cats = new C.Categories([]);
  const json = '```json\n{"store":"豚捨","branch":"KITTE丸の内店","date":"2026-09-20","total":25930,"taxMode":"included","items":[{"name":"ベネフィット(料理数)","price":17000,"category":"DINING"},{"name":"◎スーパードライ(中瓶)","price":930,"category":"FOOD"},{"name":"松茸ごはん","price":8000,"category":"XYZ"}]}\n```';
  const r = C.reviewFromAi(json, cats, { [C.key("スーパードライ")]: "DINING" }, {}, new Date(2026, 8, 27));
  assert.equal(r.items[1].name, "スーパードライ(中瓶)");
  assert.equal(r.items[1].category, "DINING"); // 家族の学習ルールが AI より優先
  assert.equal(r.items[2].category, "OTHER"); // 不明なIDはその他
  assert.equal(C.ymd(r.date), "2026-09-20");
  assert.equal(C.isConsistent(r), true);
  r.items[2].category = "DINING";
  const s = C.buildSave(r, { uid: "u1", name: "瑞希", receiptId: "rid", now: 1, payment: "クレジットカード", paidBy: "u1", shared: true });
  assert.deepEqual(s.txns.map((x) => [x.category, x.amount]), [["DINING", 25930]]);
  assert.equal(s.txns[0].store, "豚捨 KITTE丸の内店");
  assert.equal(s.receipt.items.length, 3);
  assert.deepEqual(s.rules.map((x) => C.ruleDocId(x)), [C.key("松茸ごはん")]);
});

test("外税の按分と、内税の読み落とし", () => {
  const r = { items: [{ price: 500, category: "FOOD" }, { price: 300, category: "DAILY" }], total: 864, taxMode: "excluded" };
  assert.deepEqual(C.categoryTotals(r), { FOOD: 540, DAILY: 324 });
  const r2 = { ...r, taxMode: "included" };
  assert.equal(C.isConsistent(r2), false);
  assert.deepEqual(C.categoryTotals(r2), { FOOD: 500, DAILY: 300 });
});

test("AIの回数上限（Android と同じ規則）", () => {
  const s = C.settingsFrom({ aiDailyLimit: 2, aiMonthlyLimit: 3 });
  const today = new Date(2026, 8, 27);
  let d = C.reserveDecision({ day: "2026-09-27", dayCount: 1, month: "2026-09", monthCount: 1 }, s, today);
  assert.equal(d.kind, "ok"); assert.equal(d.dayLeft, 0); assert.equal(d.monthLeft, 1);
  d = C.reserveDecision(d.next, s, today);
  assert.equal(d.kind, "limit"); assert.equal(d.daily, true);
  d = C.reserveDecision({ day: "2026-09-26", dayCount: 5, month: "2026-09", monthCount: 3 }, s, today);
  assert.equal(d.kind, "limit"); assert.equal(d.daily, false);
  assert.equal(C.reserveDecision({ blockedDay: "2026-09-27" }, s, today).kind, "blocked");
});

test("貯金目標の毎月の必要額", () => {
  const g = { target: 300000, deadline: "2027-02", deposits: [{ amount: 60000 }] };
  assert.equal(C.monthlyNeeded(g, new Date(2026, 8, 27)), 40000);
});
