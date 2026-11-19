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
  const s = C.buildSave(r, { uid: "u1", name: "瑞希", receiptId: "rid", now: 1, payment: "クレジットカード", paidBy: "u1", split: { mode: "default" } });
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

test("貯蓄率は貯蓄カテゴリ＋残金で計算する", () => {
  const b = C.balance(294624, 184169, 75000);
  assert.equal(b.net, 110455);
  assert.equal(b.saved, 185455);
  assert.equal(b.rate, 62);
  assert.equal(C.balance(0, 10).rate, null);
  assert.equal(C.looksLikeSavings("個人型確定拠出年金"), true);
  assert.equal(C.looksLikeSavings("国民年金"), false);
  const cats = new C.Categories([{ id: "C_x", label: "投資信託", order: 1 }, { id: "C_y", label: "投資信託", order: 2, savings: false }]);
  assert.equal(cats.get("C_x").savings, true);
  assert.equal(cats.get("C_y").savings, false);
});

// ---------------- 割り勘・精算（Android の LinksTest と同じ数字） ----------------
const M = "masa", Z = "mizu", STD = { masa: 6, mizu: 4 };
const ex = (amount, payer, extra = {}) => ({ id: payer + amount, amount, createdBy: payer, category: "FOOD", date: C.millisOf(new Date(2026, 10, 3)), ...extra });

test("負担のしかた", () => {
  assert.deepEqual(C.shares(6000, M, { mode: "default" }, [M, Z], STD), { masa: 3600, mizu: 2400 });
  assert.deepEqual(C.shares(6000, M, { mode: "even" }, [M, Z], STD), { masa: 3000, mizu: 3000 });
  assert.deepEqual(C.shares(6000, M, { mode: "payer" }, [M, Z], STD), { masa: 6000 });
  assert.deepEqual(C.shares(6000, M, { mode: "other" }, [M, Z], STD), { mizu: 6000 });
  assert.deepEqual(C.shares(6000, M, { mode: "ratio", weights: { masa: 1, mizu: 2 } }, [M, Z], STD), { masa: 2000, mizu: 4000 });
  assert.deepEqual(C.shares(6000, M, { mode: "amount", amounts: { mizu: 2000 } }, [M, Z], STD), { masa: 4000, mizu: 2000 });
  const odd = C.shares(1001, Z, { mode: "even" }, [M, Z], STD);
  assert.equal(odd.masa + odd.mizu, 1001);
  assert.equal(C.splitOf({ shared: false }).mode, "payer");
  assert.equal(C.splitOf({}).mode, "default");
});

test("精算：明細ごとの負担・会社経費・繰越", () => {
  const e = [
    ex(10000, M),
    ex(6000, M, { splitMode: "even", id: "dinner" }),
    ex(3000, M, { splitMode: "other", id: "her" }),
    ex(5000, M, { splitMode: "payer", id: "fund" }),
    ex(30000, M, { business: true, id: "hotel" }),
    ex(2000, Z, { splitMode: "amount", splitAmounts: { masa: 500 }, id: "z1" }),
  ];
  const r = C.settlement(e, [M, Z], STD);
  assert.equal(r.total, 21000);
  assert.equal(r.members.find((m) => m.uid === Z).share, 11500);
  assert.deepEqual(r.transfers, [{ from: Z, to: M, amount: 9500 }]);
  const carry = C.carryOver([ex(10000, M)], [M, Z], STD, []);
  assert.deepEqual(carry, { masa: 4000, mizu: -4000 });
  const nov = C.settlement([ex(5000, Z, { splitMode: "even" })], [M, Z], STD, [], carry);
  assert.deepEqual(nov.transfers, [{ from: Z, to: M, amount: 1500 }]);
});

test("精算の文面", () => {
  const r = C.settlement([ex(186420, M)], [M, Z], STD);
  const text = C.summaryText("11月", r, (u) => (u === M ? "まさゆき" : "瑞希"), "6:4");
  assert.ok(text.includes("負担額：まさゆき ¥111,852／瑞希 ¥74,568（6:4）"));
  assert.ok(text.endsWith("→ 瑞希からまさゆきへ ¥74,568"));
});

test("レシート：相手の分の品目は別の明細", () => {
  const r = { store: "イオン", branch: "", date: new Date(2026, 10, 2), total: 1500, items: [
    { name: "牛乳", price: 300, category: "FOOD", suggested: "FOOD", ocrName: "牛乳" },
    { name: "化粧水", price: 1200, category: "CLOTHING", suggested: "CLOTHING", ocrName: "化粧水", forOther: true },
  ] };
  const s = C.buildSave(r, { uid: "u1", name: "まさゆき", receiptId: "rid", now: 1, payment: "", paidBy: "u1", split: { mode: "default" } });
  assert.equal(s.txns.length, 2);
  const her = s.txns.find((t) => t.category === "CLOTHING");
  assert.equal(her.splitMode, "other");
  assert.ok(her.memo.startsWith("相手の分："));
  assert.equal(s.txns.find((t) => t.category === "FOOD").splitMode, "default");
});

test("カテゴリの既定の負担", () => {
  const cats = new C.Categories([{ id: "C1", label: "投資信託", order: 1 }]);
  assert.equal(cats.get("C1").split, "payer");
  assert.equal(cats.get("DINING").split, "even");
  assert.equal(cats.get("FOOD").split, "default");
  assert.equal(cats.get("TRIP_ALLOWANCE").income, true);
});

test("支払いルール：家賃 5万・3万（金額が違えば同じ割合）", () => {
  const rent = { mode: "amount", amounts: { masa: 50000, mizu: 30000 } };
  assert.deepEqual(C.shares(80000, "mizu", rent, ["masa", "mizu"], { masa: 6, mizu: 4 }), { masa: 50000, mizu: 30000 });
  assert.deepEqual(C.shares(82000, "masa", rent, ["masa", "mizu"], { masa: 6, mizu: 4 }), { masa: 51250, mizu: 30750 });
  assert.deepEqual(C.shares(6000, "masa", { mode: "amount", amounts: { mizu: 2000 } }, ["masa", "mizu"], {}), { masa: 4000, mizu: 2000 });
  const cats = new C.Categories([{ id: "C9", label: "家賃", split: "amount", splitAmounts: { masa: 50000, mizu: 30000 } }]);
  assert.deepEqual(C.categorySplit(cats.get("C9")), { mode: "amount", weights: {}, amounts: { masa: 50000, mizu: 30000 } });
});

test("精算の明細の内訳は負担額の合計と一致する", () => {
  const d = (n) => new Date(2026, 10, n).getTime();
  const list = [
    { id: "a", amount: 6000, createdBy: "a", date: d(5) },
    { id: "o", amount: 3001, createdBy: "a", splitMode: "other", date: d(3) },
    { id: "b", amount: 2001, createdBy: "b", date: d(1) },
    { id: "p", amount: 5000, createdBy: "b", splitMode: "payer", date: d(2) },
    { id: "z", amount: 9000, createdBy: "a", business: true, date: d(2) },
  ];
  const m = ["a", "b"];
  const lines = C.settlementLines(list, m, {});
  assert.deepEqual(lines.map((l) => l.txn.id), ["b", "o", "a"]);
  const r = C.settlement(list, m, {});
  for (const u of m) assert.equal(lines.reduce((s, l) => s + (l.shares[u] ?? 0), 0), r.members.find((x) => x.uid === u).share);
  assert.deepEqual(C.settlementExcluded(list), { business: 1, payerOnly: 1 });
});

test("固定費を記録する月（Androidと同じ）", () => {
  const r = { amount: 80000, day: 25, startMonth: "2026-09", lastPosted: "", active: true };
  assert.deepEqual(C.monthsToPost(r, new Date(2026, 10, 16)), ["2026-09", "2026-10"]);
  assert.deepEqual(C.monthsToPost(r, new Date(2026, 10, 25)), ["2026-09", "2026-10", "2026-11"]);
  assert.deepEqual(C.monthsToPost({ ...r, lastPosted: "2026-10" }, new Date(2026, 10, 16)), []);
  assert.deepEqual(C.monthsToPost({ ...r, active: false }, new Date(2026, 10, 30)), []);
  assert.deepEqual(C.monthsToPost({ ...r, day: 31, startMonth: "2027-02" }, new Date(2027, 1, 28)), ["2027-02"]);
  assert.equal(C.monthsToPost({ ...r, startMonth: "2024-01" }, new Date(2026, 10, 30)).length, 12);
  assert.equal(C.recurringDate({ day: 31 }, "2026-02").getDate(), 28);
});

test("医療費控除とカテゴリの保存形", () => {
  assert.equal(C.medicalEstimate(150000, 20000), 30000);
  assert.equal(C.medicalEstimate(90000, 0), 0);
  assert.equal(C.medicalKind("ウエルシア稲城店"), "医薬品購入");
  assert.equal(C.medicalKind("やまだ歯科"), "診療・治療");
  const csv = C.medicalCsv([{ amount: 3000, store: "やまだ歯科", date: new Date(2026, 4, 1).getTime(), createdBy: "a" }], () => "真志");
  assert.ok(csv.startsWith("﻿医療を受けた方の氏名"));
  assert.ok(csv.includes("真志,やまだ歯科,診療・治療,3000,0,2026/05/01"));
  assert.equal(C.argbOf("#43a047"), 0xff43a047);
  const s = C.categoryToStored({ id: "x", label: "家賃", emoji: "🏠", color: 0xff546e7a, split: "amount", splitAmounts: { a: 50000, b: 30000 } }, 3);
  assert.deepEqual([s.order, s.split, s.splitAmounts.a, s.splitWeights], [3, "amount", 50000, null]);
});

test("家計簿ごとの金額（Androidと同じ）", () => {
  const m = ["a", "b"];
  const all = [
    { id: "rent", amount: 80000, createdBy: "a", splitMode: "amount", splitAmounts: { a: 50000, b: 30000 } },
    { id: "food", amount: 3001, createdBy: "b" },
    { id: "mine", amount: 1200, createdBy: "b", splitMode: "payer" },
    { id: "lend", amount: 5000, createdBy: "a", splitMode: "other" },
    { id: "sec", amount: 900, createdBy: "a", onlyMe: true },
    { id: "pay", amount: 300000, createdBy: "a", isIncome: true },
    { id: "biz", amount: 7000, createdBy: "b", business: true },
  ];
  const obj = (l) => Object.fromEntries(l.map((t) => [t.id, t.amount]));
  assert.deepEqual(obj(C.bookView(all, "a", m)), { rent: 50000, food: 1501, sec: 900, pay: 300000 });
  assert.deepEqual(obj(C.bookView(all, "b", m)), { rent: 30000, food: 1500, mine: 1200, lend: 5000, biz: 7000 });
  assert.equal(C.bookView(all, "a", m).find((t) => t.id === "rent").fullAmount, 80000);
  assert.equal(C.bookView(all, C.BOTH, m).length, all.length - 1);
  assert.equal(C.ownsBook("", C.BOTH), true);
  assert.equal(C.ownsBook("a", "a"), true);
  assert.equal(C.ownsBook("", "a"), false);
});

test("ふるさと納税の上限（Androidのテストと同じ値）", () => {
  assert.equal(C.salaryDeduction(6700000), 1770000);
  assert.equal(C.furusatoLimit(6700000, 1000000, 276000, 0, 2026), 82185);
  assert.ok(C.furusatoLimit(6700000, 1000000, 0, 0, 2026) > 82185);
  assert.equal(C.furusatoLimit(0, 0, 0, 0, 2026), 0);
});

test("予算の提案・おかしな出費・ライフプラン・レポート・保証（Androidと同じ）", () => {
  const d = (m, day) => new Date(2026, m - 1, day).getTime();
  const t = (id, amount, category, date, store = "") => ({ id, amount, category, date, store, createdBy: "a" });
  const b = C.suggestBudget([t("1", 30000, "FOOD", d(8, 3)), t("2", 31000, "FOOD", d(9, 3)), t("3", 29500, "FOOD", d(10, 3)), t("4", 9000, "DINING", d(10, 9)), t("5", 99999, "FOOD", d(11, 2))], "2026-11");
  assert.deepEqual(b, { total: 34000, categories: { FOOD: 31000, DINING: 3000 } });
  const dup = C.anomalies([t("a", 1280, "DINING", d(11, 1), "スシロー"), t("b", 1280, "DINING", d(11, 2), "スシロー")], [], new Date(2026, 10, 3).getTime());
  assert.equal(dup.filter((x) => x.kind === "dup").length, 1);
  const subs = [t("s1", 1490, "HOBBY", d(8, 5), "Netflix"), t("s2", 1490, "HOBBY", d(9, 5), "Netflix"), t("s3", 1590, "HOBBY", d(10, 5), "Netflix")];
  assert.equal(C.anomalies([], subs, d(10, 20)).filter((x) => x.kind === "up").length, 1);
  const hist = [1, 2, 3, 4, 5, 6].map((i) => t("h" + i, 3000 + i * 100, "DINING", d(9, i)));
  assert.equal(C.anomalies([t("x", 12000, "DINING", d(11, 3), "焼肉")], hist, d(11, 4)).filter((x) => x.kind === "large").length, 1);
  assert.equal(C.monthlySaving([t("1", 200000, "FOOD", d(10, 1))], [{ ...t("i", 320000, "SALARY", d(10, 25)), isIncome: true }], "2026-11", 1), 120000);
  const pts = C.lifePlan(1000000, 100000, "2026-11", 8, [{ id: "e", name: "新婚旅行", budget: 800000, start: "2027-05-01" }], { e: 300000 });
  assert.equal(pts[6].balance, 1000000 + 6 * 100000 - 500000);
  assert.deepEqual(pts[6].events, ["新婚旅行 -¥500,000"]);
  const rep = C.monthReport([t("1", 50000, "FOOD", d(10, 1)), t("2", 8000, "DINING", d(10, 2))], [], [t("p", 40000, "FOOD", d(9, 1))], { categories: { FOOD: 45000 } });
  assert.deepEqual([rep.spend, rep.prevSpend, rep.over], [58000, 40000, [["FOOD", 5000]]]);
  const w = C.warrantyList([{ ...t("w1", 1, "X", 0), warrantyUntil: "2026-12-01" }, { ...t("w2", 1, "X", 0), warrantyUntil: "2026-01-01" }], new Date(2026, 10, 19));
  assert.deepEqual(w.map((x) => [x.t.id, x.days]), [["w2", -322], ["w1", 12]]);
});
