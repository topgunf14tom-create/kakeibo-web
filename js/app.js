// レシート家計簿 Web版（Android版と同じ Firebase の家計簿を読み書きする）
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, updateProfile, signOut,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, doc, collection, query, where, orderBy,
  onSnapshot, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc, writeBatch, runTransaction, arrayUnion,
  getAggregateFromServer, sum,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app-check.js";
import { getAI, getGenerativeModel, GoogleAIBackend } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-ai.js";
import { firebaseConfig, recaptchaSiteKey } from "./config.js";
import * as C from "./core.js";

const $app = document.getElementById("app");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

if (!firebaseConfig.apiKey) {
  $app.innerHTML = `<div class="page center"><h1>🧾 レシート家計簿</h1><div class="card warn">設定がまだです。<br><code>js/config.js</code> に Firebase の設定を貼り付けてください（README の手順2）。</div></div>`;
  throw new Error("config.js が未設定です");
}

const app = initializeApp(firebaseConfig);
if (recaptchaSiteKey) {
  initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(recaptchaSiteKey), isTokenAutoRefreshEnabled: true });
}
const auth = getAuth(app);
const db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
const ai = getAI(app, { backend: new GoogleAIBackend() });

// ======================= 状態 =======================

const today = () => C.dayOnly(new Date());
const S = {
  user: null, profile: undefined, hid: null, household: null,
  cats: new C.Categories([]), settings: C.settingsFrom(null), budgets: [], rules: {}, renames: {}, goals: [], usage: null,
  tab: "record",
  month: new Date(new Date().getFullYear(), new Date().getMonth(), 1), monthTx: [], monthIn: [],
  stats: { type: "month", anchor: today(), member: null, cat: null, tx: [], inc: [], prev: null, lastYear: null, review: null, bar: null },
  settle: { month: new Date(new Date().getFullYear(), new Date().getMonth(), 1), tx: [], records: [] },
  authTab: "login", modal: null, busy: false, error: "", reviewBusy: false,
};
const subs = {};
function sub(name, fn) { if (subs[name]) subs[name](); subs[name] = fn ? fn() : null; }
const hh = () => doc(db, "households", S.hid);
const col = (name) => collection(db, "households", S.hid, name);
const myName = () => S.profile?.name || S.user?.displayName || "メンバー";
const nameOf = (uid) => S.household?.memberNames?.[uid] ?? (uid ? "メンバー" : "");
const txFromDoc = (d, income) => ({ id: d.id, ...d.data(), isIncome: income, shared: d.data().shared ?? true });
const txToMap = (t) => ({
  amount: t.amount, category: t.category, date: t.date, store: t.store ?? "", memo: t.memo ?? "",
  createdBy: t.createdBy, createdByName: t.createdByName, receiptId: t.receiptId ?? null, createdAt: t.createdAt,
  payment: t.payment ?? "", paidBy: t.paidBy ?? "", shared: t.isIncome ? false : t.shared !== false, recurringId: t.recurringId ?? null,
});

let toastTimer;
function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg; el.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 3500);
}
function friendly(e) {
  const m = String(e?.code ?? "") + " " + String(e?.message ?? e);
  if (/invalid-credential|wrong-password|user-not-found/.test(m)) return "メールアドレスかパスワードが違います";
  if (/email-already-in-use/.test(m)) return "このメールアドレスは登録済みです";
  if (/weak-password/.test(m)) return "パスワードは6文字以上にしてください";
  if (/invalid-email/.test(m)) return "メールアドレスの形式が正しくありません";
  if (/permission-denied|PERMISSION_DENIED/.test(m)) return "アクセス権がありません";
  if (/App ?Check/i.test(m)) return "AIの利用登録（App Check）が完了していません。管理者に連絡してください";
  if (/network|offline/i.test(m)) return "ネットワークに接続できません";
  return m.trim();
}
async function task(fn, done) {
  S.busy = true; S.error = ""; render();
  try { await fn(); done?.(); } catch (e) { console.error(e); S.error = friendly(e); toast(S.error); }
  finally { S.busy = false; render(); }
}

// ======================= 購読 =======================

onAuthStateChanged(auth, (u) => {
  S.user = u; S.profile = undefined; S.hid = null;
  Object.keys(subs).forEach((k) => sub(k, null));
  if (u) {
    sub("profile", () => onSnapshot(doc(db, "users", u.uid), (snap) => {
      const d = snap.data() ?? {};
      S.profile = { name: d.name ?? u.displayName ?? "メンバー", householdId: d.householdId ?? null };
      if (S.profile.householdId !== S.hid) { S.hid = S.profile.householdId; if (S.hid) subscribeHousehold(); }
      render();
    }));
  }
  render();
});

function subscribeHousehold() {
  sub("household", () => onSnapshot(hh(), (s) => { S.household = s.exists() ? s.data() : null; render(); }));
  sub("cats", () => onSnapshot(doc(db, "households", S.hid, "meta", "categories"), (s) => { S.cats = new C.Categories(s.data()?.items ?? []); render(); }));
  sub("settings", () => onSnapshot(doc(db, "households", S.hid, "meta", "settings"), (s) => { S.settings = C.settingsFrom(s.data()); render(); }));
  sub("usage", () => onSnapshot(doc(db, "households", S.hid, "meta", "aiUsage"), (s) => { S.usage = C.normalizeUsage(s.data(), today()); render(); }));
  sub("budgets", () => onSnapshot(col("budgets"), (s) => { S.budgets = s.docs.map((d) => ({ month: d.id, ...d.data() })); render(); }));
  sub("rules", () => onSnapshot(col("rules"), (s) => {
    S.rules = {}; S.renames = {};
    s.docs.forEach((d) => {
      const r = d.data();
      if ((r.type ?? "category") === "category" && r.category) S.rules[r.keyword] = r.category;
      if (r.type === "rename" && r.value) S.renames[r.keyword] = r.value;
    });
  }));
  sub("goals", () => onSnapshot(col("goals"), (s) => { S.goals = s.docs.map((d) => ({ id: d.id, ...d.data() })); render(); }));
  subscribeMonth(); subscribeStats(); subscribeSettle();
}

function rangeQuery(name, start, end) {
  return query(col(name), where("date", ">=", C.millisOf(start)), where("date", "<", C.millisOf(end)), orderBy("date", "desc"));
}
const sortTx = (a) => a.sort((x, y) => y.date - x.date || (y.createdAt ?? 0) - (x.createdAt ?? 0));

function subscribeMonth() {
  const s = S.month, e = C.addMonths(s, 1);
  sub("monthTx", () => onSnapshot(rangeQuery("transactions", s, e), (q) => { S.monthTx = sortTx(q.docs.map((d) => txFromDoc(d, false))); render(); }));
  sub("monthIn", () => onSnapshot(rangeQuery("incomes", s, e), (q) => { S.monthIn = sortTx(q.docs.map((d) => txFromDoc(d, true))); render(); }));
}

function statsPeriod() { return C.Period.of(S.stats.type, S.stats.anchor, S.settings.weekStartsMonday); }

function subscribeStats() {
  const p = statsPeriod();
  S.stats.bar = null;
  sub("statsTx", () => onSnapshot(rangeQuery("transactions", p.start, p.end), (q) => { S.stats.tx = q.docs.map((d) => txFromDoc(d, false)); render(); }));
  sub("statsIn", () => onSnapshot(rangeQuery("incomes", p.start, p.end), (q) => { S.stats.inc = q.docs.map((d) => txFromDoc(d, true)); render(); }));
  sub("review", p.type === "month"
    ? () => onSnapshot(doc(db, "households", S.hid, "reviews", C.ym(p.start)), (s) => { S.stats.review = s.data()?.text ?? null; render(); })
    : null);
  if (p.type !== "month") S.stats.review = null;
  S.stats.prev = null; S.stats.lastYear = null;
  const sumOf = async (per) => {
    const q = query(col("transactions"), where("date", ">=", C.millisOf(per.start)), where("date", "<", C.millisOf(per.end)));
    return (await getAggregateFromServer(q, { total: sum("amount") })).data().total ?? 0;
  };
  const key = p.label;
  sumOf(p.shift(-1)).then((v) => { if (statsPeriod().label === key) { S.stats.prev = v; render(); } }).catch(() => {});
  if (p.type === "month") {
    const ly = C.Period.of("month", new Date(p.start.getFullYear() - 1, p.start.getMonth(), 1));
    sumOf(ly).then((v) => { if (statsPeriod().label === key) { S.stats.lastYear = v; render(); } }).catch(() => {});
  }
}

function subscribeSettle() {
  const s = S.settle.month, e = C.addMonths(s, 1);
  sub("settleTx", () => onSnapshot(rangeQuery("transactions", s, e), (q) => { S.settle.tx = q.docs.map((d) => txFromDoc(d, false)); render(); }));
  sub("settleRec", () => onSnapshot(query(col("settlements"), where("month", "==", C.ym(s))), (q) => {
    S.settle.records = q.docs.map((d) => ({ id: d.id, ...d.data() })); render();
  }));
}

// ======================= 画面 =======================

let chart = null;

function render() {
  if (chart && !document.getElementById("chart")) { chart.destroy(); chart = null; }
  if (S.user === null) { $app.innerHTML = viewAuth(); return; }
  if (S.profile === undefined) { $app.innerHTML = `<div class="page center"><div class="spinner"></div></div>`; return; }
  if (!S.hid) { $app.innerHTML = viewSetup(); return; }
  const scroll = window.scrollY;
  const sheetScroll = document.querySelector(".sheet")?.scrollTop ?? 0;
  $app.innerHTML = `
    <header class="top"><h1>${esc(S.household?.name ?? "家計簿")}</h1></header>
    <main class="page">${S.tab === "record" ? viewRecord() : S.tab === "stats" ? viewStats() : viewMore()}</main>
    <nav class="tabs">
      ${[["record", "🧾", "記録"], ["stats", "📊", "集計"], ["more", "⚙️", "その他"]].map(([k, i, l]) =>
        `<button data-act="tab" data-v="${k}" class="${S.tab === k ? "on" : ""}"><span>${i}</span>${l}</button>`).join("")}
    </nav>
    ${S.modal ? viewModal() : ""}`;
  window.scrollTo(0, scroll);
  const sheet = document.querySelector(".sheet");
  if (sheet) sheet.scrollTop = sheetScroll;
  if (S.tab === "stats") drawChart();
}

function viewAuth() {
  const reg = S.authTab === "register";
  return `<div class="page narrow">
    <h1 class="hero">🧾 レシート家計簿</h1>
    <p class="muted">Androidアプリと同じ家計簿をブラウザで使えます。</p>
    <div class="seg"><button data-act="authTab" data-v="login" class="${reg ? "" : "on"}">ログイン</button><button data-act="authTab" data-v="register" class="${reg ? "on" : ""}">新規登録</button></div>
    <form data-form="auth" class="stack">
      ${reg ? `<label>表示名<input name="name" placeholder="例：瑞希" required></label>` : ""}
      <label>メールアドレス<input name="email" type="email" autocomplete="email" required></label>
      <label>パスワード（6文字以上）<input name="password" type="password" autocomplete="${reg ? "new-password" : "current-password"}" required minlength="6"></label>
      ${S.error ? `<p class="err">${esc(S.error)}</p>` : ""}
      <button class="primary" ${S.busy ? "disabled" : ""}>${reg ? "登録してはじめる" : "ログイン"}</button>
    </form></div>`;
}

function viewSetup() {
  return `<div class="page narrow stack">
    <h2>家計簿に参加しましょう</h2>
    <form data-form="join" class="card stack">
      <b>招待コードで参加する</b>
      <p class="muted small">家族から届いた6文字のコードを入れてください。</p>
      <input name="code" maxlength="6" placeholder="ABC123" style="text-transform:uppercase" required>
      <button class="primary" ${S.busy ? "disabled" : ""}>参加する</button>
    </form>
    ${S.error ? `<p class="err">${esc(S.error)}</p>` : ""}
    <button class="text" data-act="logout">ログアウト</button></div>`;
}

function budgetLine(spent, budget, period, label = "予算") {
  const r = budget > 0 ? spent / budget : 0;
  const cls = r > 1 ? "bad" : r >= 0.8 ? "warn" : "good";
  const perDay = C.perDayLeft(spent, budget, period, today());
  const pace = C.isOverPace(spent, budget, period, today());
  return `<div class="budget">
    <div class="row"><span class="small">${label} ${C.yen(budget)} のうち ${Math.floor(r * 100)}%</span>
    <b class="small ${cls}">${spent > budget ? "超過 " + C.yen(spent - budget) : "残り " + C.yen(budget - spent)}</b></div>
    <div class="bar"><i class="${cls}" style="width:${Math.min(100, r * 100)}%"></i></div>
    ${perDay != null || pace ? `<div class="tiny ${pace ? "bad" : "muted"}">${[perDay != null ? "残り1日あたり " + C.yen(perDay) : "", pace ? "ペース超過" : ""].filter(Boolean).join(" · ")}</div>` : ""}
  </div>`;
}

function txRow(t) {
  const c = S.cats.get(t.category);
  const sub = [c.label, t.payment, t.memo].filter(Boolean).join(" · ");
  return `<button class="tx" data-act="edit" data-id="${t.id}" data-income="${t.isIncome ? 1 : 0}">
    <span class="dot" style="background:${C.cssColor(c.color)}33">${c.emoji}</span>
    <span class="grow"><b class="ellipsis">${esc(t.store || c.label)}</b><span class="small muted ellipsis">${esc(sub)}</span>
    ${t.createdByName ? `<span class="tiny muted">記録: ${esc(t.createdByName)}</span>` : ""}</span>
    <b class="${t.isIncome ? "good" : ""}">${t.isIncome ? "+" : ""}${C.yen(t.amount)}</b></button>`;
}

function viewRecord() {
  const m = S.month;
  const total = S.monthTx.reduce((s, t) => s + t.amount, 0);
  const inc = S.monthIn.reduce((s, t) => s + t.amount, 0);
  const budget = C.resolveBudget(C.ym(m), S.budgets);
  const period = C.Period.of("month", m);
  const byCat = C.aggregate(S.monthTx, period).byCategory;
  const all = sortTx([...S.monthTx, ...S.monthIn]);
  const groups = {};
  for (const t of all) (groups[t.date] ??= []).push(t);
  const goal = [...S.goals].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))[0];
  return `
    <div class="nav"><button data-act="month" data-v="-1">‹</button><h2>${m.getFullYear()}年${m.getMonth() + 1}月</h2><button data-act="month" data-v="1">›</button></div>
    <div class="card primary-bg">
      <div class="small">今月の支出</div><div class="big">${C.yen(total)}</div><div class="small">${S.monthTx.length}件</div>
      ${inc > 0 ? `<div class="${inc - total < 0 ? "bad" : "good"}"><b>収入 ${C.yen(inc)} · 収支 ${C.signedYen(inc - total)}（貯蓄率 ${Math.floor(((inc - total) * 100) / inc)}%）</b></div>` : ""}
      ${budget?.total > 0 ? budgetLine(total, budget.total, period) : ""}
      ${byCat.length ? `<div class="stack-bar">${byCat.map((c) => `<i style="flex:${c.amount};background:${C.cssColor(S.cats.get(c.id).color)}"></i>`).join("")}</div>
        <div class="tiny">${byCat.slice(0, 4).map((c) => `${S.cats.get(c.id).emoji}${esc(S.cats.get(c.id).label)} ${C.yenShort(c.amount)}`).join("　")}</div>` : ""}
    </div>
    <div class="actions">
      <label class="primary big-btn">📷 レシートを撮る<input type="file" accept="image/*" capture="environment" data-act="scan" hidden></label>
      <label class="outline">🖼 写真から<input type="file" accept="image/*" multiple data-act="scan" hidden></label>
      <button class="outline" data-act="add">＋ 手入力</button>
    </div>
    ${goal ? goalCard(goal, false) : ""}
    ${all.length ? "" : `<p class="muted center pad">まだ記録がありません。「レシートを撮る」から始めましょう。</p>`}
    ${Object.entries(groups).map(([d, list]) => {
      const dt = new Date(+d);
      return `<div class="day"><span>${dt.getMonth() + 1}月${dt.getDate()}日(${"日月火水木金土"[dt.getDay()]})</span><span>${(() => { const v = list.filter((t) => !t.isIncome).reduce((s, t) => s + t.amount, 0); return v ? C.yen(v) : ""; })()}</span></div>${list.map(txRow).join("")}`;
    }).join("")}`;
}

function goalCard(g, withButtons) {
  const saved = C.goalSaved(g);
  const r = g.target > 0 ? saved / g.target : 0;
  const need = C.monthlyNeeded(g, today());
  return `<div class="card">
    <div class="row"><b>🎯 ${esc(g.name)}</b>${withButtons ? `<button class="text small" data-act="delGoal" data-id="${g.id}">削除</button>` : ""}</div>
    <div>${C.yen(saved)} / ${C.yen(g.target)}（${Math.floor(r * 100)}%）</div>
    <div class="bar"><i class="good" style="width:${Math.min(100, r * 100)}%"></i></div>
    <div class="small muted">${saved >= g.target ? "🎉 達成しました" : need != null ? `期限 ${g.deadline.replace("-", "/")} まで、毎月 ${C.yen(need)} で達成` : `あと ${C.yen(g.target - saved)}`}</div>
    ${withButtons ? `<button class="outline small" data-act="deposit" data-id="${g.id}">積み立てる</button>` : ""}
  </div>`;
}

function viewStats() {
  const p = statsPeriod();
  const st = S.stats;
  const tx = st.member ? st.tx.filter((t) => t.createdBy === st.member) : st.tx;
  const inc = (st.member ? st.inc.filter((t) => C.payerOf(t) === st.member) : st.inc).reduce((s, t) => s + t.amount, 0);
  const agg = C.aggregate(tx, p);
  const budget = st.member ? null : C.budgetFor(p, S.budgets);
  const shown = st.cat ? tx.filter((t) => t.category === st.cat) : tx;
  const members = S.household?.members ?? [];
  const cmp = (label, before) => {
    if (before == null) return "";
    const d = agg.total - before;
    return `<div class="small ${d > 0 ? "bad" : "good"}">${label} ${C.signedYen(d)}${before > 0 ? `（${d >= 0 ? "+" : ""}${Math.trunc((d * 100) / before)}%）` : ""}</div>`;
  };
  const byPay = {};
  for (const t of tx) byPay[t.payment || "未設定"] = (byPay[t.payment || "未設定"] ?? 0) + t.amount;
  return `
    <div class="seg">${[["week", "週"], ["month", "月"], ["year", "年"]].map(([k, l]) => `<button data-act="statsType" data-v="${k}" class="${st.type === k ? "on" : ""}">${l}</button>`).join("")}</div>
    <div class="nav"><button data-act="statsShift" data-v="-1">‹</button><h2>${p.label}</h2><button data-act="statsShift" data-v="1">›</button></div>
    ${members.length > 1 ? `<div class="chips"><button data-act="member" data-v="" class="${st.member ? "" : "on"}">全員</button>${members.map((u) => `<button data-act="member" data-v="${u}" class="${st.member === u ? "on" : ""}">${esc(nameOf(u))}</button>`).join("")}</div>` : ""}
    <div class="card primary-bg">
      <div class="small">合計出費</div><div class="big">${C.yen(agg.total)}</div>
      <div class="small">${agg.count}件 · 1日平均 ${C.yen(p.days ? agg.total / p.days : 0)}</div>
      ${st.member ? "" : cmp({ week: "前週比", month: "前月比", year: "前年比" }[p.type], st.prev) + (p.type === "month" ? cmp("前年同月比", st.lastYear) : "")}
      ${inc > 0 ? `<div>収入 ${C.yen(inc)}</div><b class="${inc - agg.total < 0 ? "bad" : "good"}">収支 ${C.signedYen(inc - agg.total)}（貯蓄率 ${Math.floor(((inc - agg.total) * 100) / inc)}%）</b>` : ""}
      ${budget?.total > 0 ? budgetLine(agg.total, budget.total, p) : ""}
    </div>
    ${p.type === "month" && S.settings.aiEnabled ? `<div class="card">
      <div class="row"><b>✨ AIのふりかえり</b><button class="text small" data-act="aiReview" ${S.reviewBusy ? "disabled" : ""}>${S.reviewBusy ? "作成中…" : st.review ? "作り直す" : "作成する"}</button></div>
      <div class="small ${st.review ? "" : "muted"} pre">${esc(st.review ?? "この月の支出・収入・予算の数字だけをAIに送り、気づきを3〜4行でまとめます（AIの回数を1回使います）。")}</div></div>` : ""}
    <div class="card">
      <b>カテゴリ別</b>
      ${agg.byCategory.length ? agg.byCategory.map((s) => {
        const c = S.cats.get(s.id);
        const limit = budget?.categories?.[s.id];
        const r = limit ? s.amount / limit : 0;
        return `<button class="catrow ${st.cat === s.id ? "sel" : ""}" data-act="cat" data-v="${s.id}">
          <span class="row"><span><i class="swatch" style="background:${C.cssColor(c.color)}"></i>${c.emoji} ${esc(c.label)}</span>
          <span><span class="tiny muted">${agg.total ? Math.floor((s.amount * 100) / agg.total) : 0}% · ${s.count}件</span> <b>${C.yen(s.amount)}</b></span></span>
          ${limit ? `<span class="bar"><i class="${r > 1 ? "bad" : r >= 0.8 ? "warn" : "good"}" style="width:${Math.min(100, r * 100)}%"></i></span>
            <span class="tiny ${s.amount > limit ? "bad" : "muted"}">予算 ${C.yen(limit)} · ${s.amount > limit ? "超過 " + C.yen(s.amount - limit) : "残り " + C.yen(limit - s.amount)}</span>` : ""}
        </button>`;
      }).join("") : `<p class="muted">記録なし</p>`}
    </div>
    ${Object.keys(byPay).length > 1 || (Object.keys(byPay)[0] && Object.keys(byPay)[0] !== "未設定") ? `<div class="card"><b>支払い方法別</b>${Object.entries(byPay).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<div class="row small"><span>${esc(k)}</span><span>${C.yen(v)}</span></div>`).join("")}</div>` : ""}
    <div class="card">
      <div class="row"><b>推移${st.cat ? `（${esc(S.cats.get(st.cat).label)}）` : ""}</b>${st.cat ? `<button class="text small" data-act="cat" data-v="${st.cat}">全カテゴリ</button>` : ""}</div>
      <div class="chart-wrap"><canvas id="chart"></canvas></div>
      <div id="barDetail" class="small muted">棒をタップすると内訳を表示します</div>
    </div>
    <h3>明細（${shown.length}件）</h3>
    ${sortTx([...shown]).slice(0, 200).map(txRow).join("")}`;
}

function drawChart() {
  const el = document.getElementById("chart");
  if (!el || !window.Chart) return;
  const p = statsPeriod();
  const st = S.stats;
  const tx = st.member ? st.tx.filter((t) => t.createdBy === st.member) : st.tx;
  const agg = C.aggregate(tx, p);
  const buckets = p.buckets();
  const ids = [...new Set(agg.buckets.flatMap((b) => Object.keys(b)))].filter((id) => !st.cat || id === st.cat)
    .sort((a, b) => S.cats.get(a).order - S.cats.get(b).order);
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  if (chart) chart.destroy();
  chart = new window.Chart(el, {
    type: "bar",
    data: {
      labels: buckets.map((b) => b.label),
      datasets: ids.map((id) => ({ label: S.cats.get(id).label, data: agg.buckets.map((b) => b[id] ?? 0), backgroundColor: C.cssColor(S.cats.get(id).color), stack: "s" })),
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.dataset.label} ${C.yen(c.raw)}` } } },
      scales: {
        x: { stacked: true, ticks: { color: dark ? "#aaa" : "#555", autoSkip: true, maxRotation: 0 }, grid: { display: false } },
        y: { stacked: true, ticks: { color: dark ? "#aaa" : "#555", callback: (v) => C.yenShort(v) }, grid: { color: dark ? "#333" : "#eee" } },
      },
      onClick: (_, els) => {
        const i = els[0]?.index;
        const box = document.getElementById("barDetail");
        if (i == null || !box) return;
        const b = buckets[i];
        const m = Object.entries(agg.buckets[i]).filter(([k]) => !st.cat || k === st.cat).sort((a, c) => c[1] - a[1]);
        box.innerHTML = `<b>${p.type === "year" ? b.label : `${b.start.getMonth() + 1}月${b.start.getDate()}日`} ${C.yen(m.reduce((s, x) => s + x[1], 0))}</b>` +
          m.map(([k, v]) => `<div class="row"><span>${S.cats.get(k).emoji} ${esc(S.cats.get(k).label)}</span><span>${C.yen(v)}</span></div>`).join("");
      },
    },
  });
}

function viewMore() {
  const members = S.household?.members ?? [];
  const sm = S.settle.month;
  const res = C.settlement(S.settle.tx, members, S.settings.split, S.settle.records);
  const b = C.resolveBudget(C.ym(S.month), S.budgets);
  const spentBy = {};
  for (const t of S.monthTx) spentBy[t.category] = (spentBy[t.category] ?? 0) + t.amount;
  const u = S.usage ?? C.normalizeUsage(null, today());
  return `
    <div class="card stack">
      <b>👪 家族で共有</b>
      <div class="center"><div class="small muted">招待コード</div><div class="code">${esc(S.household?.inviteCode ?? "")}</div></div>
      <div class="small">メンバー：${members.map((m) => esc(nameOf(m))).join("、")}</div>
    </div>

    <div class="card stack">
      <b>🔁 立替・精算</b>
      <div class="nav small-nav"><button data-act="settleMonth" data-v="-1">‹</button><span>${sm.getFullYear()}年${sm.getMonth() + 1}月</span><button data-act="settleMonth" data-v="1">›</button></div>
      ${members.length < 2 ? `<p class="muted small">家族が2人以上参加すると使えます。</p>` : `
        <div class="small">共通の出費 <b>${C.yen(res.total)}</b></div>
        <table class="tbl"><tr><th></th><th>払った額</th><th>負担額</th><th>差額</th></tr>
        ${res.members.map((m) => `<tr><td>${esc(nameOf(m.uid))}</td><td>${C.yen(m.paid)}</td><td>${C.yen(m.share)}</td><td class="${m.balance < 0 ? "bad" : "good"}">${C.signedYen(m.balance)}</td></tr>`).join("")}</table>
        ${res.transfers.length ? res.transfers.map((t) => `<div class="row"><b>${esc(nameOf(t.from))} → ${esc(nameOf(t.to))} ${C.yen(t.amount)}</b>
          <button class="outline small" data-act="settle" data-from="${t.from}" data-to="${t.to}" data-amount="${t.amount}">精算済みにする</button></div>`).join("") : `<div class="good small">精算は必要ありません ✓</div>`}
        ${S.settle.records.map((r) => `<div class="row small muted"><span>記録：${esc(nameOf(r.from))} → ${esc(nameOf(r.to))} ${C.yen(r.amount)}</span><button class="text small" data-act="delSettle" data-id="${r.id}">取り消す</button></div>`).join("")}
        <div class="tiny muted">負担の割合の変更はAndroidアプリの「立替・精算」から行えます。</div>`}
    </div>

    <div class="row"><h3>🎯 貯金目標</h3><button class="text" data-act="addGoal">＋ 追加</button></div>
    ${S.goals.length ? [...S.goals].sort((a, c) => (a.createdAt ?? 0) - (c.createdAt ?? 0)).map((g) => goalCard(g, true)).join("") : `<p class="muted small">目標はまだありません。</p>`}

    <div class="card stack">
      <b>💰 今月の予算</b>
      ${b ? `${b.total ? budgetLine(Object.values(spentBy).reduce((a, c) => a + c, 0), b.total, C.Period.of("month", S.month), "全体") : ""}
        ${Object.entries(b.categories ?? {}).map(([id, v]) => budgetLine(spentBy[id] ?? 0, v, C.Period.of("month", S.month), S.cats.get(id).emoji + S.cats.get(id).label)).join("")}`
        : `<p class="muted small">予算はまだありません。</p>`}
      <div class="tiny muted">予算・カテゴリ・固定費の設定、カード明細の取り込み、医療費の集計はAndroidアプリで行えます。</div>
    </div>

    <div class="card stack">
      <b>✨ AI解析</b>
      <div class="small">今日 ${u.dayCount} / ${S.settings.aiDailyLimit}回 · 今月 ${u.monthCount} / ${S.settings.aiMonthlyLimit}回（家族の合計）</div>
      ${u.blockedDay === C.ymd(today()) ? `<div class="bad small">⚠ Googleの無料枠の上限に達したため、今日はAIを止めています</div>` : ""}
      ${!recaptchaSiteKey ? `<div class="warn small">このWeb版はAIの設定（reCAPTCHA）がまだのため、レシートは手入力になります。</div>` : ""}
    </div>

    <button class="outline" data-act="logout">ログアウト（${esc(myName())}）</button>
    <p class="tiny muted center">レシート家計簿 Web版</p>`;
}

// ======================= モーダル =======================

const catChips = (list, selected, act) => `<div class="chips wrap">${list.map((c) =>
  `<button type="button" data-act="${act}" data-v="${c.id}" class="${selected === c.id ? "on" : ""}">${c.emoji} ${esc(c.label)}</button>`).join("")}</div>`;

function payFields(m) {
  const members = S.household?.members ?? [];
  return `<label>支払い方法<select data-bind="payment"><option value="">（未設定）</option>${C.PAYMENT_METHODS.map((p) => `<option ${m.payment === p ? "selected" : ""}>${p}</option>`).join("")}</select></label>
    ${members.length > 1 ? `<label>払った人<select data-bind="paidBy">${members.map((u) => `<option value="${u}" ${m.paidBy === u ? "selected" : ""}>${esc(nameOf(u))}</option>`).join("")}</select></label>
    <label class="check"><input type="checkbox" data-bind="shared" ${m.shared !== false ? "checked" : ""}> 家族の共通の出費（オフで個人の出費）</label>` : ""}`;
}

function viewModal() {
  const m = S.modal;
  if (m.type === "entry") {
    const cats = m.income ? S.cats.incomeVisible : S.cats.visible;
    return `<div class="modal"><div class="sheet stack">
      <div class="row"><h2>${m.id ? "明細を編集" : "手入力で追加"}</h2><button class="text" data-act="close">✕</button></div>
      ${m.id ? "" : `<div class="seg"><button data-act="kind" data-v="0" class="${m.income ? "" : "on"}">支出</button><button data-act="kind" data-v="1" class="${m.income ? "on" : ""}">収入</button></div>`}
      <label>金額（円）<input data-bind="amount" inputmode="numeric" value="${m.amount ?? ""}" class="bigin"></label>
      ${catChips(cats, m.category, "pickCat")}
      <label>日付<input type="date" data-bind="date" value="${m.date}"></label>
      <label>${m.income ? "入金元" : "店名"}<input data-bind="store" value="${esc(m.store ?? "")}"></label>
      <label>メモ<input data-bind="memo" value="${esc(m.memo ?? "")}"></label>
      ${m.income ? "" : payFields(m)}
      ${m.createdByName ? `<div class="tiny muted">記録: ${esc(m.createdByName)}</div>` : ""}
      <button class="primary" data-act="saveEntry" ${S.busy ? "disabled" : ""}>保存</button>
      ${m.id ? `<button class="text bad" data-act="deleteEntry">この明細を削除</button>` : ""}
    </div></div>`;
  }
  if (m.type === "receipt") {
    if (m.loading) return `<div class="modal"><div class="sheet center stack"><div class="spinner"></div><p>${esc(m.loading)}</p></div></div>`;
    const r = m.review;
    const totals = C.categoryTotals(r);
    const ok = C.isConsistent(r);
    const diff = C.difference(r);
    const adj = C.adjustment(r);
    return `<div class="modal"><div class="sheet stack">
      <div class="row"><h2>レシートの確認</h2><button class="text" data-act="close">✕</button></div>
      ${m.notice ? `<div class="card ${m.noticeWarn ? "warn" : "info"} small">${m.noticeWarn ? "⚠ " : "✓ "}${esc(m.notice)}</div>` : ""}
      <div class="grid2"><label>店名<input data-rev="store" value="${esc(r.store)}"></label><label>支店<input data-rev="branch" value="${esc(r.branch)}"></label></div>
      <div class="grid2"><label>日付<input type="date" data-rev="date" value="${C.ymd(r.date)}"></label><label>レシート合計<input data-rev="total" inputmode="numeric" value="${r.total}"></label></div>
      ${payFields(m)}
      <div class="card primary-bg stack">
        <b>分類結果</b>
        ${Object.entries(totals).sort((a, b) => b[1] - a[1]).map(([id, v]) => `<div class="row"><span>${S.cats.get(id).emoji} ${esc(S.cats.get(id).label)}</span><b>${C.yen(v)}</b></div>`).join("")}
        ${ok ? `<div class="small">✓ ${adj ? `明細計と合計の差 ${C.signedYen(adj)}（外税・端数）は各カテゴリに按分しています` : "明細の合計とレシートの合計が一致しています"}</div>`
          : r.items.length ? `<div class="small bad">⚠ 明細計 ${C.yen(C.itemsSum(r))} と合計 ${C.yen(r.total)} が ${C.yen(Math.abs(diff))} 合いません。品目を確認してください。</div>
            <button class="text small" data-act="addDiff">差額 ${C.signedYen(diff)} を「その他」として追加</button>` : `<div class="small bad">⚠ 品目を読み取れませんでした。品目を追加してください。</div>`}
      </div>
      <b>品目（${r.items.length}）</b>
      ${r.items.map((i, idx) => `<div class="item">
        <input data-item="${idx}" data-f="name" value="${esc(i.name)}">
        <input data-item="${idx}" data-f="price" inputmode="numeric" value="${i.price}" class="price">
        <select data-item="${idx}" data-f="category">${S.cats.visible.map((c) => `<option value="${c.id}" ${c.id === i.category ? "selected" : ""}>${c.emoji} ${esc(c.label)}</option>`).join("")}</select>
        <button class="text" data-act="delItem" data-v="${idx}">✕</button></div>`).join("")}
      <button class="outline small" data-act="addItem">＋ 品目を追加</button>
      <button class="primary" data-act="saveReceipt" ${S.busy || !Object.keys(totals).length ? "disabled" : ""}>${C.yen(Object.values(totals).reduce((a, b) => a + b, 0))} を ${Object.keys(totals).length}カテゴリに分けて保存</button>
    </div></div>`;
  }
  if (m.type === "goal") {
    return `<div class="modal"><div class="sheet stack">
      <div class="row"><h2>貯金目標を追加</h2><button class="text" data-act="close">✕</button></div>
      <label>目標（例：新婚旅行）<input data-bind="name"></label>
      <label>目標金額（円）<input data-bind="target" inputmode="numeric"></label>
      <label>期限（任意）<input type="month" data-bind="deadline"></label>
      <button class="primary" data-act="saveGoal">保存</button></div></div>`;
  }
  return "";
}

// ======================= 操作 =======================

document.addEventListener("submit", (e) => {
  const f = e.target.closest("form[data-form]");
  if (!f) return;
  e.preventDefault();
  const v = Object.fromEntries(new FormData(f));
  if (f.dataset.form === "auth") {
    if (S.authTab === "login") task(() => signInWithEmailAndPassword(auth, v.email.trim(), v.password));
    else task(async () => {
      const cred = await createUserWithEmailAndPassword(auth, v.email.trim(), v.password);
      await updateProfile(cred.user, { displayName: v.name.trim() });
      await setDoc(doc(db, "users", cred.user.uid), { name: v.name.trim() }, { merge: true });
    });
  }
  if (f.dataset.form === "join") {
    task(async () => {
      const code = v.code.trim().toUpperCase();
      const inv = await getDoc(doc(db, "invites", code));
      const hid = inv.data()?.householdId;
      if (!hid) throw new Error("招待コードが見つかりません");
      await updateDoc(doc(db, "households", hid), { members: arrayUnion(auth.currentUser.uid), [`memberNames.${auth.currentUser.uid}`]: myName(), joinCode: code });
      await setDoc(doc(db, "users", auth.currentUser.uid), { householdId: hid, name: myName() }, { merge: true });
    });
  }
});

document.addEventListener("input", (e) => {
  const el = e.target;
  const m = S.modal;
  if (!m) return;
  if (el.dataset.bind) m[el.dataset.bind] = el.type === "checkbox" ? el.checked : el.value;
});

document.addEventListener("change", (e) => {
  const el = e.target;
  if (el.dataset.act === "scan") { scanReceipt([...el.files]); el.value = ""; return; }
  const m = S.modal;
  if (!m) return;
  if (el.dataset.bind) { m[el.dataset.bind] = el.type === "checkbox" ? el.checked : el.value; return; }
  if (el.dataset.rev) {
    const r = m.review;
    if (el.dataset.rev === "total") r.total = Math.round(Number(el.value.replace(/[,¥円]/g, ""))) || 0;
    else if (el.dataset.rev === "date") r.date = C.parseDateInput(el.value.replace(/-/g, "/")) ?? r.date;
    else r[el.dataset.rev] = el.value;
    render(); return;
  }
  if (el.dataset.item != null) {
    const it = m.review.items[+el.dataset.item];
    if (el.dataset.f === "price") it.price = Math.round(Number(el.value.replace(/[,¥円−]/g, (c) => (c === "−" ? "-" : "")))) || 0;
    else it[el.dataset.f] = el.value;
    render();
  }
});

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-act]");
  if (!el || el.tagName === "INPUT") return;
  const a = el.dataset.act, v = el.dataset.v;
  const m = S.modal;
  switch (a) {
    case "authTab": S.authTab = v; S.error = ""; render(); break;
    case "tab": S.tab = v; render(); window.scrollTo(0, 0); break;
    case "logout": signOut(auth); break;
    case "month": S.month = C.addMonths(S.month, +v); subscribeMonth(); render(); break;
    case "statsType": S.stats.type = v; subscribeStats(); render(); break;
    case "statsShift": S.stats.anchor = statsPeriod().shift(+v).start; subscribeStats(); render(); break;
    case "member": S.stats.member = v || null; render(); break;
    case "cat": S.stats.cat = S.stats.cat === v ? null : v; render(); break;
    case "settleMonth": S.settle.month = C.addMonths(S.settle.month, +v); subscribeSettle(); render(); break;
    case "close": S.modal = null; render(); break;
    case "add":
      S.modal = { type: "entry", income: false, category: "FOOD", date: C.ymd(today()), payment: localStorage.getItem("lastPayment") ?? "", paidBy: S.user.uid, shared: true };
      render(); break;
    case "edit": {
      const income = el.dataset.income === "1";
      const t = [...S.monthTx, ...S.monthIn, ...S.stats.tx, ...S.stats.inc].find((x) => x.id === el.dataset.id && x.isIncome === income);
      if (!t) return;
      S.modal = { type: "entry", ...t, income, date: C.ymd(C.dateOf(t.date)), paidBy: C.payerOf(t) };
      render(); break;
    }
    case "kind": m.income = v === "1"; m.category = m.income ? "SALARY" : "FOOD"; render(); break;
    case "pickCat": m.category = v; render(); break;
    case "saveEntry": saveEntry(); break;
    case "deleteEntry":
      if (confirm("この明細を削除しますか？家族全員の家計簿から削除されます。")) {
        task(() => deleteDoc(doc(db, "households", S.hid, m.income ? "incomes" : "transactions", m.id)), () => { S.modal = null; });
      }
      break;
    case "delItem": m.review.items.splice(+v, 1); render(); break;
    case "addItem": {
      const c = m.review.items.at(-1)?.category ?? C.OTHER_ID;
      m.review.items.push({ id: Date.now(), name: "品目", price: 0, category: c, suggested: c, ocrName: "品目" }); render(); break;
    }
    case "addDiff": {
      const d = C.difference(m.review);
      m.review.items.push({ id: Date.now(), name: d > 0 ? "読み取れなかった分" : "差額調整", price: d, category: C.OTHER_ID, suggested: C.OTHER_ID, ocrName: "差額" });
      render(); break;
    }
    case "saveReceipt": saveReceipt(); break;
    case "settle":
      task(() => addDoc(col("settlements"), { month: C.ym(S.settle.month), from: el.dataset.from, to: el.dataset.to, amount: +el.dataset.amount, createdAt: Date.now() }), () => toast("精算を記録しました"));
      break;
    case "delSettle": task(() => deleteDoc(doc(db, "households", S.hid, "settlements", el.dataset.id))); break;
    case "addGoal": S.modal = { type: "goal" }; render(); break;
    case "saveGoal": {
      const target = Math.round(Number(String(m.target ?? "").replace(/[,¥円]/g, "")));
      if (!m.name?.trim() || !(target > 0)) { toast("目標と金額を入れてください"); return; }
      task(() => addDoc(col("goals"), { name: m.name.trim(), target, deadline: m.deadline ?? "", deposits: [], createdAt: Date.now() }), () => { S.modal = null; });
      break;
    }
    case "deposit": {
      const s = prompt("積み立てる金額（取り崩しはマイナス）");
      const amount = Math.round(Number(String(s ?? "").replace(/[,¥円]/g, "")));
      if (!amount) return;
      task(() => updateDoc(doc(db, "households", S.hid, "goals", el.dataset.id), { deposits: arrayUnion({ date: C.ymd(today()), amount, by: myName(), at: Date.now() }) }), () => toast(`${C.yen(amount)}を記録しました`));
      break;
    }
    case "delGoal": if (confirm("この目標を削除しますか？")) task(() => deleteDoc(doc(db, "households", S.hid, "goals", el.dataset.id))); break;
    case "aiReview": makeMonthlyReview(); break;
  }
});

function saveEntry() {
  const m = S.modal;
  const amount = Math.round(Number(String(m.amount ?? "").replace(/[,¥円]/g, "")));
  const d = C.parseDateInput(String(m.date ?? "").replace(/-/g, "/"));
  if (!(amount > 0) || !d) { toast("金額と日付を入れてください"); return; }
  const t = {
    amount, category: m.category, date: C.millisOf(d), store: (m.store ?? "").trim(), memo: (m.memo ?? "").trim(),
    createdBy: m.createdBy ?? S.user.uid, createdByName: m.createdByName ?? myName(), receiptId: m.receiptId ?? null,
    createdAt: m.createdAt ?? Date.now(), payment: m.income ? "" : m.payment ?? "", paidBy: m.paidBy ?? S.user.uid,
    shared: !m.income && m.shared !== false, recurringId: m.recurringId ?? null, isIncome: m.income,
  };
  if (!m.income && t.payment) localStorage.setItem("lastPayment", t.payment);
  const c = col(m.income ? "incomes" : "transactions");
  task(() => (m.id ? setDoc(doc(c, m.id), txToMap(t)) : addDoc(c, txToMap(t))), () => { S.modal = null; toast("保存しました"); });
}

// ---------------- レシート（Gemini） ----------------

async function resize(file, maxSide = 1600) {
  const img = await createImageBitmap(file);
  const s = Math.min(1, maxSide / Math.max(img.width, img.height));
  const cv = document.createElement("canvas");
  cv.width = Math.round(img.width * s); cv.height = Math.round(img.height * s);
  cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
  return cv.toDataURL("image/jpeg", 0.85).split(",")[1];
}

async function reserveAi() {
  const ref = doc(db, "households", S.hid, "meta", "aiUsage");
  return runTransaction(db, async (tx) => {
    const d = C.reserveDecision((await tx.get(ref)).data(), S.settings, today());
    if (d.kind === "ok") tx.set(ref, d.next);
    return d;
  });
}
const isQuota = (e) => /quota|429|RESOURCE_EXHAUSTED|rate limit/i.test(String(e?.message ?? e) + String(e?.code ?? ""));
const markBlocked = () => setDoc(doc(db, "households", S.hid, "meta", "aiUsage"), { blockedDay: C.ymd(today()) }, { merge: true }).catch(() => {});

function emptyReview() {
  return { store: "", branch: "", date: today(), items: [], total: 0, taxMode: "unknown", source: "device" };
}

async function scanReceipt(files) {
  if (!files.length) return;
  const base = { type: "receipt", payment: localStorage.getItem("lastPayment") ?? "", paidBy: S.user.uid, shared: true };
  const manual = (notice) => { S.modal = { ...base, review: emptyReview(), notice, noticeWarn: true }; render(); };
  if (!S.settings.aiEnabled) return manual("AI解析がオフになっているため、品目を手で入力してください。");
  if (!recaptchaSiteKey) return manual("このWeb版はAIの設定がまだのため、品目を手で入力してください。");
  if (!localStorage.getItem("aiConsent")) {
    if (!confirm("レシートの画像をGoogleのAI（Gemini）に送って読み取ります。無料枠の範囲だけで使い、料金はかかりません。よろしいですか？")) return manual("品目を手で入力してください。");
    localStorage.setItem("aiConsent", "1");
  }
  S.modal = { ...base, loading: "画像を準備しています…" }; render();
  try {
    const images = await Promise.all(files.slice(0, 3).map((f) => resize(f)));
    const r = await reserveAi();
    if (r.kind === "blocked") return manual("Googleの無料枠の上限に達しています。今日は手入力でお願いします。");
    if (r.kind === "limit") return manual(`AI解析の${r.daily ? "今日" : "今月"}の上限（${r.daily ? S.settings.aiDailyLimit : S.settings.aiMonthlyLimit}回）に達しました。品目を手で入力してください。`);
    S.modal.loading = "AIでレシートを読み取っています…"; render();
    const model = getGenerativeModel(ai, { model: S.settings.aiModel, generationConfig: { responseMimeType: "application/json" } });
    const res = await model.generateContent([C.aiPrompt(S.cats), ...images.map((data) => ({ inlineData: { data, mimeType: "image/jpeg" } }))]);
    const review = C.reviewFromAi(res.response.text(), S.cats, S.rules, S.renames, today());
    const low = r.dayLeft <= S.settings.aiDailyLimit / 5 || r.monthLeft <= S.settings.aiMonthlyLimit / 5;
    S.modal = { ...base, review, notice: low ? `AIで読み取りました。AI解析は残りわずかです（今日 ${r.dayLeft}回・今月 ${r.monthLeft}回）。` : `AIで読み取りました（今月あと${r.monthLeft}回）。内容を確認して保存してください。`, noticeWarn: low };
    render();
  } catch (e) {
    console.error(e);
    if (isQuota(e)) { markBlocked(); return manual("Googleの無料枠の上限に達しました。今日はAIを止めています。品目を手で入力してください。"); }
    manual("AIの読み取りに失敗しました（" + friendly(e) + "）。品目を手で入力してください。");
  }
}

function saveReceipt() {
  const m = S.modal;
  const receiptId = crypto.randomUUID();
  const { txns, receipt, rules } = C.buildSave(m.review, { uid: S.user.uid, name: myName(), receiptId, now: Date.now(), payment: m.payment, paidBy: m.paidBy, shared: m.shared });
  if (m.payment) localStorage.setItem("lastPayment", m.payment);
  task(async () => {
    const b = writeBatch(db);
    b.set(doc(col("receipts"), receiptId), receipt);
    for (const t of txns) b.set(doc(col("transactions")), t);
    for (const r of rules) b.set(doc(col("rules"), C.ruleDocId(r)), r);
    await b.commit();
  }, () => { S.modal = null; toast("保存しました"); });
}

// ---------------- AIの月次ふりかえり ----------------

async function makeMonthlyReview() {
  const p = statsPeriod();
  if (p.type !== "month" || S.reviewBusy) return;
  if (!recaptchaSiteKey) { toast("このWeb版はAIの設定がまだです"); return; }
  S.reviewBusy = true; render();
  try {
    const r = await reserveAi();
    if (r.kind !== "ok") { toast(r.kind === "blocked" ? "Googleの無料枠の上限に達しています" : "AI解析の上限に達しています"); return; }
    const cur = C.aggregate(S.stats.tx, p);
    const prevP = p.shift(-1);
    const prevSnap = (await getDocs(rangeQuery("transactions", prevP.start, prevP.end))).docs.map((d) => txFromDoc(d, false));
    const before = C.aggregate(prevSnap, prevP);
    const budget = C.budgetFor(p, S.budgets);
    const income = S.stats.inc.reduce((s, t) => s + t.amount, 0);
    const lines = (a) => a.byCategory.map((c) => `- ${S.cats.get(c.id).label}: ${c.amount}円（${c.count}件）`).join("\n");
    const prompt = `あなたは家計簿アプリのアシスタントです。家族の${p.label}の家計を、次の数字だけを使って日本語でふりかえってください。
・箇条書き3〜4行、1行40字程度。数字を必ず入れる。説教や断定的な助言はせず、気づきと来月の小さな工夫を1つ。
・データにないことは書かない。
【今月】支出 ${cur.total}円 / 収入 ${income}円${budget?.total ? ` / 予算 ${budget.total}円` : ""}
${lines(cur)}
【先月】支出 ${before.total}円
${lines(before)}
${Object.entries(budget?.categories ?? {}).map(([k, v]) => `予算 ${S.cats.get(k).label}: ${v}円`).join("\n")}`;
    const model = getGenerativeModel(ai, { model: S.settings.aiModel });
    const text = (await model.generateContent(prompt)).response.text().trim();
    await setDoc(doc(db, "households", S.hid, "reviews", C.ym(p.start)), { text, by: myName(), createdAt: Date.now() });
  } catch (e) {
    console.error(e);
    if (isQuota(e)) { markBlocked(); toast("Googleの無料枠の上限に達しました"); } else toast("作成に失敗しました：" + friendly(e));
  } finally { S.reviewBusy = false; render(); }
}

// 画面確認用（URLの末尾に #debug を付けたときだけ）
if (location.hash === "#debug") Object.assign(window, { __S: S, __render: render });

render();
