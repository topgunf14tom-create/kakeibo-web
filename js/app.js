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
  stats: { type: "month", anchor: today(), member: null, shareMode: false, cat: null, tx: [], inc: [], priv: [], prev: null, lastYear: null, review: null, bar: null },
  book: "", priv: [], memberBudgets: {}, furusato: {}, assets: null,
  events: [], loans: [], payslips: [], anomalies: null,
  settle: { month: new Date(new Date().getFullYear(), new Date().getMonth(), 1), tx: [], records: [], all: [], closes: {}, carry: {}, carryKey: "" },
  authTab: "login", modal: null, busy: false, error: "", reviewBusy: false,
  page: null, recurring: [],
};
const subs = {};
function sub(name, fn) { if (subs[name]) subs[name](); subs[name] = fn ? fn() : null; }
const hh = () => doc(db, "households", S.hid);
const col = (name) => collection(db, "households", S.hid, name);
const myName = () => S.profile?.name || S.user?.displayName || "メンバー";
const nameOf = (uid) => S.household?.memberNames?.[uid] ?? (uid ? "メンバー" : "");
const txFromDoc = (d, income) => ({ id: d.id, ...d.data(), isIncome: income });
const txToMap = (t) => ({
  amount: t.amount, category: t.category, date: t.date, store: t.store ?? "", memo: t.memo ?? "",
  createdBy: t.createdBy, createdByName: t.createdByName, receiptId: t.receiptId ?? null, createdAt: t.createdAt,
  payment: t.payment ?? "", paidBy: t.paidBy ?? "", recurringId: t.recurringId ?? null,
  ...C.splitFields(t.isIncome ? { mode: "default" } : (t.split ?? C.splitOf(t))),
  business: !t.isIncome && !!t.business, updatedAt: t.updatedAt ?? 0,
  // Android で付けた項目も消さずに残す（特別費・取り込み元・精算済み・イベント・保証期限）
  special: !t.isIncome && !!t.special, source: t.source ?? "", reimbursed: !!t.reimbursed,
  eventId: t.isIncome ? null : t.eventId || null, warrantyUntil: t.isIncome ? null : t.warrantyUntil || null,
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
  sub("household", () => onSnapshot(hh(), (s) => { S.household = s.exists() ? s.data() : null; loadCarry(); render(); }));
  sub("cats", () => onSnapshot(doc(db, "households", S.hid, "meta", "categories"), (s) => { S.cats = new C.Categories(s.data()?.items ?? []); render(); }));
  sub("settings", () => onSnapshot(doc(db, "households", S.hid, "meta", "settings"), (s) => { S.settings = C.settingsFrom(s.data()); loadCarry(); render(); }));
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
  sub("memberBudgets", () => onSnapshot(col("memberBudgets"), (s) => {
    S.memberBudgets = {};
    s.docs.forEach((d) => { const b = d.data(); if (b.uid && b.month) (S.memberBudgets[b.uid] ??= []).push({ month: b.month, total: b.total ?? null, categories: b.categories ?? {} }); });
    render();
  }));
  sub("events", () => onSnapshot(col("events"), (s) => { S.events = s.docs.map((d) => ({ id: d.id, ...d.data() })); render(); }));
  const myCol = (name) => collection(db, "households", S.hid, "private", S.user.uid, name);
  sub("loans", () => onSnapshot(myCol("loans"), (s) => { S.loans = s.docs.map((d) => ({ id: d.id, ...d.data() })); render(); }, () => {}));
  sub("payslips", () => onSnapshot(myCol("payslips"), (s) => { S.payslips = s.docs.map((d) => ({ id: d.id, ...d.data() })); render(); }, () => {}));
  sub("furusato", () => onSnapshot(col("furusato"), (s) => { S.furusato = Object.fromEntries(s.docs.map((d) => [d.id, d.data()])); render(); }));
  sub("assets", () => onSnapshot(doc(col("shared"), "assets"), (s) => {
    try { S.assets = s.exists() ? { ...JSON.parse(s.data().json), fetchedAt: s.data().fetchedAt, owner: s.data().owner } : null; } catch { S.assets = null; }
    render();
  }));
  let posted = false;
  sub("recurring", () => onSnapshot(col("recurring"), (s) => {
    S.recurring = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (!posted) { posted = true; postRecurring(); }
    render();
  }));
  // 月末・月初は、精算する月を最初から表示しておく
  const target = settleTarget();
  if (target) S.settle.month = target;
  subscribeMonth(); subscribeStats(); subscribeSettle();
}

function rangeQuery(name, start, end) {
  const c = typeof name === "string" ? col(name) : name;
  return query(c, where("date", ">=", C.millisOf(start)), where("date", "<", C.millisOf(end)), orderBy("date", "desc"));
}
/** 自分だけに見える明細（households/{id}/private/{uid}/transactions。Android と同じ場所） */
const privCol = () => collection(db, "households", S.hid, "private", S.user.uid, "transactions");
const privFromDoc = (d) => ({ ...txFromDoc(d, false), onlyMe: true });
const sortTx = (a) => a.sort((x, y) => y.date - x.date || (y.createdAt ?? 0) - (x.createdAt ?? 0));

function subscribeMonth() {
  const s = S.month, e = C.addMonths(s, 1);
  sub("monthTx", () => onSnapshot(rangeQuery("transactions", s, e), (q) => { S.monthTx = sortTx(q.docs.map((d) => txFromDoc(d, false))); render(); }));
  sub("monthIn", () => onSnapshot(rangeQuery("incomes", s, e), (q) => { S.monthIn = sortTx(q.docs.map((d) => txFromDoc(d, true))); render(); }));
  sub("monthPriv", () => onSnapshot(rangeQuery(privCol(), s, e), (q) => { S.priv = sortTx(q.docs.map(privFromDoc)); render(); }, () => { S.priv = []; }));
}

function statsPeriod() { return C.Period.of(S.stats.type, S.stats.anchor, S.settings.weekStartsMonday); }

function subscribeStats() {
  const p = statsPeriod();
  S.stats.bar = null;
  sub("statsTx", () => onSnapshot(rangeQuery("transactions", p.start, p.end), (q) => { S.stats.tx = q.docs.map((d) => txFromDoc(d, false)); render(); }));
  sub("statsIn", () => onSnapshot(rangeQuery("incomes", p.start, p.end), (q) => { S.stats.inc = q.docs.map((d) => txFromDoc(d, true)); render(); }));
  sub("statsPriv", () => onSnapshot(rangeQuery(privCol(), p.start, p.end), (q) => { S.stats.priv = q.docs.map(privFromDoc); render(); }, () => { S.stats.priv = []; }));
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
  // 会社経費は比較から外す（会社経費だけを読んで差し引く）
  const biz = getDocs(query(col("transactions"), where("business", "==", true))).then((q) => q.docs.map((d) => d.data())).catch(() => []);
  const net = async (per) => (await sumOf(per)) - (await biz).filter((t) => t.date >= C.millisOf(per.start) && t.date < C.millisOf(per.end)).reduce((s, t) => s + t.amount, 0);
  net(p.shift(-1)).then((v) => { if (statsPeriod().label === key) { S.stats.prev = v; render(); } }).catch(() => {});
  if (p.type === "month") {
    const ly = C.Period.of("month", new Date(p.start.getFullYear() - 1, p.start.getMonth(), 1));
    net(ly).then((v) => { if (statsPeriod().label === key) { S.stats.lastYear = v; render(); } }).catch(() => {});
  }
}

function subscribeSettle() {
  const s = S.settle.month, e = C.addMonths(s, 1);
  sub("settleTx", () => onSnapshot(rangeQuery("transactions", s, e), (q) => { S.settle.tx = q.docs.map((d) => txFromDoc(d, false)); render(); }));
  sub("settleRec", () => onSnapshot(col("settlements"), (q) => {
    S.settle.all = q.docs.map((d) => ({ id: d.id, ...d.data() }));
    S.settle.records = S.settle.all.filter((r) => r.month === C.ym(S.settle.month));
    loadCarry(); render();
  }));
  sub("settleClose", () => onSnapshot(col("settleCloses"), (q) => {
    S.settle.closes = Object.fromEntries(q.docs.map((d) => [d.id, d.data()])); render();
  }));
  loadCarry();
}

/** 精算の開始月から前の月までの未精算（繰越）。月を変えたとき・精算を記録したときに1回だけ読む */
async function loadCarry() {
  const sm = S.settle.month;
  const start = new Date(+S.settings.settleStart.slice(0, 4), +S.settings.settleStart.slice(5, 7) - 1, 1);
  const members = S.household?.members ?? [];
  const key = [C.ym(sm), S.settle.all.length, JSON.stringify(S.settings.split), members.join()].join("|");
  if (S.settle.carryKey === key) return;
  S.settle.carryKey = key;
  if (!(sm > start)) { S.settle.carry = {}; render(); return; }
  try {
    const prior = (await getDocs(rangeQuery("transactions", start, sm))).docs.map((d) => txFromDoc(d, false));
    const recs = S.settle.all.filter((r) => r.month >= C.ym(start) && r.month < C.ym(sm));
    if (S.settle.carryKey === key) { S.settle.carry = C.carryOver(prior, members, S.settings.split, recs); render(); }
  } catch (e) { console.error(e); }
}

/** 月末・月初は、精算するひと月を返す（それ以外は null） */
function settleTarget() {
  const d = today();
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  if (d.getDate() >= last - 2) return new Date(d.getFullYear(), d.getMonth(), 1);
  if (d.getDate() <= 3) return new Date(d.getFullYear(), d.getMonth() - 1, 1);
  return null;
}

// ======================= 画面 =======================

let chart = null;

// ======================= 着せ替え =======================
// Androidアプリと同じ4つのデザイン。選んだデザインはこのブラウザだけに覚える（瑞希と別々に選べる）
const THEMES = [
  { id: "chomen", label: "帳面", note: "霞色の紙面に藍鼠の表紙。落ち着いた標準のデザイン", bg: "#eef0f2", paper: "#ffffff", cover: "#2d3d4d", coverText: "#f1f4f6", primary: "#3e5c76", members: ["#3e5c76", "#b0657b"] },
  { id: "hidamari", label: "ひだまり", note: "生成りの紙面に杏色の表紙。あたたかく明るいデザイン", bg: "#fbf6ef", paper: "#ffffff", cover: "#ffdcc2", coverText: "#4a2a18", primary: "#c75b34", members: ["#2f7fb5", "#d9566f"] },
  { id: "sorairo", label: "そらいろ", note: "白い紙面に水色の表紙。さわやかで明るいデザイン", bg: "#f2f7fb", paper: "#ffffff", cover: "#cfe8f7", coverText: "#0f3550", primary: "#2479b5", members: ["#2b6fb0", "#db6680"] },
  { id: "yoru", label: "夜", note: "暗い紙面に紺の表紙。夜や暗い場所で見やすいデザイン", bg: "#14181c", paper: "#1c2227", cover: "#243140", coverText: "#f1f4f6", primary: "#a9c2da", members: ["#a9c2da", "#e3a6b7"] },
];
const darkQuery = window.matchMedia?.("(prefers-color-scheme: dark)");
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 保存できなくても今の表示は変える */ } },
};
const themePref = { id: store.get("kakeibo.theme", "chomen"), follow: store.get("kakeibo.themeFollowDark", "1") !== "0" };
const effectiveTheme = () => THEMES.find((t) => t.id === (themePref.follow && darkQuery?.matches ? "yoru" : themePref.id)) ?? THEMES[0];
function applyTheme() {
  const t = effectiveTheme();
  document.documentElement.dataset.theme = t.id;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t.bg);
}
applyTheme();
darkQuery?.addEventListener?.("change", () => { applyTheme(); render(); });

function themeSample(t) {
  return `<span class="sample" style="background:${t.bg}">
    <span class="s-cover" style="background:${t.cover};color:${t.coverText}">¥128,400</span>
    <span class="s-row" style="background:${t.paper}">${t.members.map((c) => `<i style="background:${c}"></i>`).join("")}<em style="background:${t.primary}"></em></span>
  </span>`;
}

function themeCard() {
  const nowDark = themePref.follow && darkQuery?.matches;
  return `<div class="card stack">
    <b>🎨 デザイン（着せ替え）</b>
    <div class="tiny muted">このブラウザだけの設定です。家族はそれぞれ好きなデザインにできます。</div>
    <div class="themes">${THEMES.map((t) => `<button class="theme-opt ${themePref.id === t.id ? "on" : ""}" data-act="theme" data-v="${t.id}">
      ${themeSample(t)}<span class="grow"><b>${t.label}</b><span class="small muted">${t.note}</span></span><span class="radio"></span></button>`).join("")}</div>
    <button class="row" data-act="themeFollow" style="width:100%;text-align:left;padding:6px 2px">
      <span class="grow"><b class="small">端末がダークモードのときは「夜」にする</b>
      <span class="tiny muted">${nowDark ? "いまは端末がダークモードなので「夜」で表示しています" : "オフにすると、いつも選んだデザインで表示します"}</span></span>
      <span class="switch ${themePref.follow ? "on" : ""}"></span></button>
  </div>`;
}

// タブのアイコン（Androidアプリと同じ Material のアイコン）
const TAB_ICONS = {
  record: "M19.5 3.5 18 2l-1.5 1.5L15 2l-1.5 1.5L12 2l-1.5 1.5L9 2 7.5 3.5 6 2v14H3v3c0 1.66 1.34 3 3 3h12c1.66 0 3-1.34 3-3V2l-1.5 1.5zM19 19c0 .55-.45 1-1 1s-1-.45-1-1v-3H8V5h11v14zM9 7h6v2H9zm7 0h2v2h-2zm-7 3h6v2H9zm7 0h2v2h-2z",
  stats: "M5 9.2h3V19H5zM10.6 5h2.8v14h-2.8zm5.6 8H19v6h-2.8z",
  assets: "M21 18v1c0 1.1-.9 2-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14c1.1 0 2 .9 2 2v1h-9a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h9zm-9-2h10V8H12v8zm4-2.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z",
  more: "M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z",
};

function render() {
  if (chart && !document.getElementById("chart")) { chart.destroy(); chart = null; }
  if (S.user === null) { $app.innerHTML = viewAuth(); return; }
  if (S.profile === undefined) { $app.innerHTML = `<div class="page center"><div class="spinner"></div></div>`; return; }
  if (!S.hid) { $app.innerHTML = viewSetup(); return; }
  const scroll = window.scrollY;
  const sheetScroll = document.querySelector(".sheet")?.scrollTop ?? 0;
  $app.innerHTML = `
    <header class="top"><h1>${esc(S.household?.name ?? "家計簿")}</h1></header>
    <main class="page">${S.page ? viewPage() : S.tab === "record" ? viewRecord() : S.tab === "stats" ? viewStats() : S.tab === "assets" ? viewAssets() : viewMore()}</main>
    <nav class="tabs">
      ${[["record", "記録"], ["stats", "集計"], ...(S.assets ? [["assets", "資産"]] : []), ["more", "設定"]].map(([k, l]) =>
        `<button data-act="tab" data-v="${k}" class="${S.tab === k ? "on" : ""}"><span class="ic"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${TAB_ICONS[k]}"/></svg></span>${l}</button>`).join("")}
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
  const t = today();
  const perDay = C.perDayLeft(spent, budget, period, t);
  const pace = C.isOverPace(spent, budget, period, t);
  // 目盛り：今日までに使ってよい目安（アプリと同じ）
  const tick = t >= period.start && t < period.end ? (Math.round((t - period.start) / 86400000) + 1) / period.days : null;
  return `<div class="budget">
    <div class="row"><span class="small muted">${label} ${C.yen(budget)} のうち ${Math.floor(r * 100)}%</span>
    <b class="num ${cls}">${spent > budget ? "超過 " + C.yen(spent - budget) : "残り " + C.yen(budget - spent)}</b></div>
    <div class="bline"><i class="${cls}" style="width:${Math.min(100, r * 100)}%"></i>${tick != null ? `<em style="left:${Math.min(100, tick * 100)}%"></em>` : ""}</div>
    ${perDay != null || pace ? `<div class="tiny ${pace ? "bad" : "muted"}">${[perDay != null ? "残り1日あたり " + C.yen(perDay) : "", pace ? "目盛りより先に進んでいます" : ""].filter(Boolean).join("。")}</div>` : ""}
  </div>`;
}

// 貯蓄に数えるカテゴリ（投資信託・積立保険・iDeCo など。Androidのカテゴリ管理で設定）の支出合計
const savingsOf = (list) => list.filter((t) => S.cats.get(t.category)?.savings).reduce((s, t) => s + t.amount, 0);
function savingsLine(b) {
  if (b.rate == null) return "";
  return `<div class="${b.saved < 0 ? "bad" : "good"}"><b>貯蓄 ${C.yen(b.saved)}（貯蓄率 ${b.rate}%）</b></div>` +
    (b.savings > 0 ? `<div class="tiny">内訳：投資・積立など ${C.yen(b.savings)} ＋ 残金 ${C.signedYen(b.net)}</div>` : "");
}

/** 払った人の色（家計簿に入った順：藍・薄紅…） */
function payerColor(t) {
  const ms = S.household?.members ?? [];
  if (t.isIncome || ms.length < 2) return "";
  const i = ms.indexOf(t.paidBy || t.createdBy);
  return i < 0 ? "" : `var(${["--masa", "--mizu", "--m3", "--m4"][i % 4]})`;
}

function txRow(t) {
  const c = S.cats.get(t.category);
  const sp = C.splitOf(t).mode;
  const tag = t.isIncome ? "" : t.business ? (t.reimbursed ? "会社経費（精算済み）" : "会社経費") : t.onlyMe ? "" : sp !== "default" ? C.splitLabel(sp) : "";
  const sub = [t.fullAmount ? `全体 ${C.yen(t.fullAmount)}のうち` : "", c.label, t.onlyMe ? "🔒自分だけ" : "", t.special ? "特別費" : "", tag, t.payment, t.memo, t.createdByName ? `記録 ${t.createdByName}` : ""].filter(Boolean).join("／");
  const band = payerColor(t);
  return `<button class="tx" data-act="edit" data-id="${t.id}" data-income="${t.isIncome ? 1 : 0}">
    <i class="band" style="background:${band || "transparent"}"></i>
    <span class="dot" style="background:${C.cssColor(c.color)}22">${c.emoji}</span>
    <span class="grow"><span class="ellipsis tx-name">${esc(t.store || c.label)}</span><span class="small muted ellipsis">${esc(sub)}</span></span>
    <b class="${t.isIncome ? "inc" : t.business ? "muted" : ""}">${t.isIncome ? "+" : ""}${C.yen(t.amount)}</b></button>`;
}

/** 表紙の1行（摘要と金額。下に点線） */
const coverLine = (label, amount, cls = "", sub = "", act = "") =>
  `<div class="cline"${act ? ` data-act="${act}" role="button"` : ""}><span>${label}</span><b class="num ${cls}">${amount}</b></div>${sub ? `<div class="tiny cl-sub">${sub}</div>` : ""}`;

/** お知らせ（付箋）：左端の色の帯と2行の文 */
const slip = (title, sub, act, v = "", urgent = false) =>
  `<button class="slip ${urgent ? "urgent" : ""}" data-act="${act}" data-v="${v}"><i></i><span class="grow"><b>${title}</b><span class="small muted">${sub}</span></span><span class="open">開く</span></button>`;

// ======================= 家計簿（自分・相手・ふたり） =======================

const members_ = () => S.household?.members ?? [];
/** 見ている家計簿（uid か C.BOTH）。空なら自分 */
const curBook = () => S.book || S.user.uid;
const bookOf = (list) => C.bookView(list, curBook(), members_(), S.settings.split);
/** 見ている家計簿の予算（ふたり＝家族の予算、各自＝その人の予算） */
const bookBudgets = (book = curBook()) => (book === C.BOTH ? S.budgets : S.memberBudgets[book] ?? []);
const bookGoals = () => (members_().length > 1 ? S.goals.filter((g) => C.ownsBook(g.owner ?? "", curBook())) : S.goals);

function bookSwitch() {
  const ms = members_();
  if (ms.length < 2) return "";
  const me = S.user.uid, b = curBook();
  const order = [me, ...ms.filter((u) => u !== me)];
  const note = b === C.BOTH ? "ふたりの合計。共通の出費は全額で数えます"
    : b === me ? "共通の出費は自分の負担分で数えます" : `${esc(nameOf(b))}の家計簿（見るだけ）。共通の出費は${esc(nameOf(b))}の負担分で数えます`;
  return `<div class="book-switch"><div class="chips">${order.map((u) => `<button data-act="book" data-v="${u === me ? "" : u}" class="${b === u ? "on" : ""}">${u === me ? "自分の家計簿" : `${esc(nameOf(u))}の家計簿`}</button>`).join("")}
    <button data-act="book" data-v="${C.BOTH}" class="${b === C.BOTH ? "on" : ""}">ふたり</button></div><div class="tiny muted">${note}</div></div>`;
}

function viewRecord() {
  const m = S.month;
  // 会社経費は一覧には出すが、支出の合計・予算・貯蓄率には入れない
  const monthTx = bookOf([...S.monthTx, ...S.priv]);
  const monthIn = bookOf(S.monthIn);
  const spend = monthTx.filter(C.everyday);
  const total = spend.reduce((s, t) => s + t.amount, 0);
  const inc = monthIn.reduce((s, t) => s + t.amount, 0);
  const budget = C.resolveBudget(C.ym(m), bookBudgets());
  const period = C.Period.of("month", m);
  const byCat = C.aggregate(spend, period).byCategory;
  const target = (S.household?.members ?? []).length > 1 ? settleTarget() : null;
  let settleNote = "";
  if (target) {
    const sameMonth = C.ym(target) === C.ym(S.settle.month);
    const r = sameMonth ? C.settlement(S.settle.tx, S.household.members, S.settings.split, S.settle.records, S.settle.carry) : null;
    const msg = r ? (r.transfers.length ? r.transfers.map((t) => `${esc(nameOf(t.from))} → ${esc(nameOf(t.to))} ${C.yen(t.amount)}`).join("、") : "精算は必要ありません ✓") : "金額を確認しましょう";
    settleNote = slip(`${target.getMonth() + 1}月の精算`, msg, "goSettle", C.ym(target), !!r?.transfers.length);
  }
  const all = sortTx([...monthTx, ...monthIn]);
  const groups = {};
  for (const t of all) (groups[t.date] ??= []).push(t);
  const goal = [...bookGoals()].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))[0];
  const bal = inc > 0 ? C.balance(inc, total, savingsOf(spend)) : null;
  const dow = "日月火水木金土";
  return `${bookSwitch()}
    <div class="month-head"><b class="num">${m.getMonth() + 1}</b><span><span class="tiny muted">${m.getFullYear()}年</span><span class="mh-tsuki">月</span></span>
      <span class="sp"></span><button class="icon" data-act="month" data-v="-1" aria-label="前の月">‹</button><button class="icon" data-act="month" data-v="1" aria-label="次の月">›</button></div>
    <div class="cover"><div class="cover-in">
      <div class="row cover-label"><span>今月の支出</span><span class="small">${spend.length}件</span></div>
      <div class="big">${C.yen(total)}</div>
      ${bal ? `<div class="crule"></div>${coverLine("収入", C.yen(inc))}${coverLine("収支", C.signedYen(bal.net), bal.net < 0 ? "bad" : "good")}
        ${bal.rate != null ? coverLine("貯蓄", `${C.yen(bal.saved)}（${bal.rate}%）`, bal.saved < 0 ? "bad" : "good", bal.savings > 0 ? `投資・積立 ${C.yen(bal.savings)} と残金 ${C.signedYen(bal.net)}` : "") : ""}` : ""}
      ${budget?.total > 0 ? budgetLine(total, budget.total, period) : ""}
      ${byCat.length ? `<div class="stack-bar">${byCat.map((c) => `<i style="flex:${c.amount};background:${C.cssColor(S.cats.get(c.id).color)}"></i>`).join("")}</div>
        <div class="cat2">${byCat.slice(0, 4).map((c) => `<span><i style="background:${C.cssColor(S.cats.get(c.id).color)}"></i><span class="ellipsis">${esc(S.cats.get(c.id).label)}</span><b class="num">${C.yenShort(c.amount)}</b></span>`).join("")}</div>` : ""}
    </div></div>
    <div class="actions">
      <label class="primary big-btn">📷 レシートを撮る<input type="file" accept="image/*" capture="environment" data-act="scan" hidden></label>
      <label class="outline">🖼 写真から<input type="file" accept="image/*" multiple data-act="scan" hidden></label>
      <button class="outline" data-act="add">＋ 手入力</button>
      <button class="outline" data-act="quick">🎤 ひとことで入力</button>
    </div>
    ${today().getDate() <= 5 ? `<div class="slips"><button class="slip" data-act="openPage" data-v="report"><i></i><span class="grow"><b>${addMonthsD(today(), -1).getMonth() + 1}月のレポートができました</b><span class="small muted">支出・前月比・多かったカテゴリ・予算超え</span></span><span class="open">開く</span></button></div>` : ""}
    ${anomalyHtml()}
    ${settleNote ? `<div class="slips">${settleNote}</div>` : ""}
    ${goal ? goalCard(goal, false) : ""}
    ${all.length ? "" : `<div class="blank"><b>この月はまだ白紙です</b><p class="muted">「レシートを撮る」でレシートを撮ると、店名・金額・品目を読み取って記帳します。</p></div>`}
    ${Object.entries(groups).map(([d, list]) => {
      const dt = new Date(+d), w = dt.getDay();
      const v = list.filter((t) => !t.isIncome && C.counts(t)).reduce((s, t) => s + t.amount, 0);
      return `<div class="day"><b class="num">${dt.getMonth() + 1}/${dt.getDate()}</b><span class="dow ${w === 0 ? "sun" : w === 6 ? "sat" : ""}">${dow[w]}</span><span class="sp"></span>${v ? `<span class="num muted">${C.yen(v)}</span>` : ""}</div>
        <div class="ledger">${list.map(txRow).join("")}</div>`;
    }).join("")}`;
}

function goalCard(g, withButtons) {
  const saved = C.goalSaved(g);
  const r = g.target > 0 ? saved / g.target : 0;
  const need = C.monthlyNeeded(g, today());
  return `<div class="card">
    <div class="row"><b>🎯 ${esc(g.name)}${members_().length > 1 ? `<span class="tiny muted">　${g.owner ? (g.owner === S.user.uid ? "自分の目標" : `${esc(nameOf(g.owner))}の目標`) : "ふたりの目標"}</span>` : ""}</b>${withButtons ? `<button class="text small" data-act="delGoal" data-id="${g.id}">削除</button>` : ""}</div>
    <div>${C.yen(saved)} / ${C.yen(g.target)}（${Math.floor(r * 100)}%）</div>
    <div class="bar"><i class="good" style="width:${Math.min(100, r * 100)}%"></i></div>
    <div class="small muted">${saved >= g.target ? "🎉 達成しました" : need != null ? `期限 ${g.deadline.replace("-", "/")} まで、毎月 ${C.yen(need)} で達成` : `あと ${C.yen(g.target - saved)}`}</div>
    ${withButtons ? `<button class="outline small" data-act="deposit" data-id="${g.id}">積み立てる</button>` : ""}
  </div>`;
}

/** 集計に使う明細：会社経費を除き、人を選んだときは記録した分か負担額（割り勘の自分の分）にする */
function statsTx() {
  const st = S.stats;
  return bookOf([...st.tx, ...st.priv].filter(C.everyday));
}

function viewStats() {
  const p = statsPeriod();
  const st = S.stats;
  const tx = statsTx();
  const inc = bookOf(st.inc).reduce((s, t) => s + t.amount, 0);
  const both = curBook() === C.BOTH || (S.household?.members ?? []).length < 2;
  const agg = C.aggregate(tx, p);
  const budget = C.budgetFor(p, bookBudgets());
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
    ${bookSwitch()}
    <div class="card primary-bg">
      <div class="small">合計出費</div><div class="big">${C.yen(agg.total)}</div>
      <div class="small">${agg.count}件 · 1日平均 ${C.yen(p.days ? agg.total / p.days : 0)}</div>
      ${!both ? "" : cmp({ week: "前週比", month: "前月比", year: "前年比" }[p.type], st.prev) + (p.type === "month" ? cmp("前年同月比", st.lastYear) : "")}
      ${inc > 0 ? `<div>収入 ${C.yen(inc)}</div><b class="${inc - agg.total < 0 ? "bad" : "good"}">収支 ${C.signedYen(inc - agg.total)}</b>${savingsLine(C.balance(inc, agg.total, savingsOf(tx)))}` : ""}
      ${budget?.total > 0 ? budgetLine(agg.total, budget.total, p) : ""}
    </div>
    ${p.type === "month" && S.settings.aiEnabled ? `<div class="card">
      <div class="row"><b>✨ AIのふりかえり</b><button class="text small" data-act="aiReview" ${S.reviewBusy ? "disabled" : ""}>${S.reviewBusy ? "作成中…" : st.review ? "作り直す" : "作成する"}</button></div>
      <div class="small ${st.review ? "" : "muted"} pre">${esc(st.review ?? "この月の支出・収入・予算の数字だけをAIに送り、気づきを3〜4行でまとめます（AIの回数を1回使います）。")}</div></div>` : ""}
    <div class="card">
      <div class="row"><b>カテゴリ別</b><span class="tiny muted">タップで明細</span></div>
      ${agg.byCategory.length ? agg.byCategory.map((s) => {
        const c = S.cats.get(s.id);
        const limit = budget?.categories?.[s.id];
        const r = limit ? s.amount / limit : 0;
        return `<button class="catrow" data-act="openCat" data-v="${s.id}">
          <span class="row"><span><i class="swatch" style="background:${C.cssColor(c.color)}"></i>${c.emoji} ${esc(c.label)}</span>
          <span><span class="tiny muted">${agg.total ? Math.floor((s.amount * 100) / agg.total) : 0}% · ${s.count}件</span> <b>${C.yen(s.amount)}</b> <span class="muted">›</span></span></span>
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
  const tx = statsTx();
  const agg = C.aggregate(tx, p);
  const buckets = p.buckets();
  const ids = [...new Set(agg.buckets.flatMap((b) => Object.keys(b)))].filter((id) => !st.cat || id === st.cat)
    .sort((a, b) => S.cats.get(a).order - S.cats.get(b).order);
  const css = getComputedStyle(document.documentElement);
  const tick = css.getPropertyValue("--muted").trim() || "#5c6873", gridc = css.getPropertyValue("--line").trim() || "#eee";
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
        x: { stacked: true, ticks: { color: tick, autoSkip: true, maxRotation: 0 }, grid: { display: false } },
        y: { stacked: true, ticks: { color: tick, callback: (v) => C.yenShort(v) }, grid: { color: gridc } },
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

/** 精算に入った明細の内訳（タップで明細を直せる） */
function settleLinesHtml(members) {
  const lines = C.settlementLines(S.settle.tx, members, S.settings.split);
  const ex = C.settlementExcluded(S.settle.tx);
  const dow = "日月火水木金土";
  const modeText = (t) => {
    const sp = C.splitOf(t);
    if (sp.mode === "ratio") return "割合 " + members.map((u) => sp.weights?.[u] ?? 0).join(":");
    if (sp.mode === "default") return "共通（標準の割合 " + members.map((u) => S.settings.split?.[u] ?? 1).join(":") + "）";
    return C.splitLabel(sp.mode);
  };
  const sharesText = (sh) => members.map((u) => `${esc(nameOf(u))} ${C.yen(sh[u] ?? 0)}`).join("・");
  const total = {};
  for (const l of lines) for (const u of members) total[u] = (total[u] ?? 0) + (l.shares[u] ?? 0);
  const exText = [ex.business ? `会社経費 ${ex.business}件` : "", ex.payerOnly ? `払った人だけ ${ex.payerOnly}件` : ""].filter(Boolean).join("、");
  if (!lines.length) return exText ? `<div class="tiny muted">精算に入らない明細：${exText}</div>` : "";
  return `<details class="settle-lines" open><summary><b class="small">精算に入った明細（${lines.length}件）</b></summary>
    <div class="ledger">${lines.map(({ txn: t, shares: sh }) => {
      const d = new Date(t.date);
      return `<button class="sl" data-act="edit" data-id="${t.id}" data-income="0">
        <span class="sl-top"><span class="tiny muted">${d.getMonth() + 1}/${d.getDate()}(${dow[d.getDay()]})</span><span class="grow ellipsis">${esc(t.store || S.cats.get(t.category).label)}</span><b class="num">${C.yen(t.amount)}</b></span>
        <span class="sl-sub tiny"><i class="payer" style="background:${payerColor(t) || "var(--muted)"}"></i><span class="grow ellipsis muted">${esc(nameOf(C.payerOf(t)))}が払った・${esc(modeText(t))}</span></span>
        <span class="sl-share tiny">負担　${sharesText(sh)}</span>
      </button>`;
    }).join("")}
    <div class="sl-total small"><b>合計</b><span class="grow"></span><b>${sharesText(total)}</b></div></div>
    ${exText ? `<div class="tiny muted">精算に入らない明細：${exText}</div>` : ""}
  </details>`;
}

function viewMore() {
  const members = S.household?.members ?? [];
  const sm = S.settle.month;
  const res = C.settlement(S.settle.tx, members, S.settings.split, S.settle.records, S.settle.carry);
  const closed = !!S.settle.closes[C.ym(sm)];
  const sharedCount = S.settle.tx.filter(C.isShared).length;
  const b = C.resolveBudget(C.ym(S.month), bookBudgets());
  const spentBy = {};
  for (const t of bookOf([...S.monthTx, ...S.priv]).filter(C.everyday)) spentBy[t.category] = (spentBy[t.category] ?? 0) + t.amount;
  const u = S.usage ?? C.normalizeUsage(null, today());
  return `
    <div class="card stack">
      <b>👪 家族で共有</b>
      <div class="center"><div class="small muted">招待コード</div><div class="code">${esc(S.household?.inviteCode ?? "")}</div></div>
      <div class="small">メンバー：${members.map((m) => esc(nameOf(m))).join("、")}</div>
    </div>

    <div class="card stack" id="settle">
      <b>🔁 立替・精算（月末にまとめて）</b>
      <div class="nav small-nav"><button data-act="settleMonth" data-v="-1">‹</button><span>${sm.getFullYear()}年${sm.getMonth() + 1}月${closed ? "（締め済み）" : ""}</span><button data-act="settleMonth" data-v="1">›</button></div>
      ${members.length < 2 ? `<p class="muted small">家族が2人以上参加すると使えます。</p>` : `
        ${res.transfers.length ? res.transfers.map((t) => `<div class="stack"><b class="big" style="font-size:1.3rem">${esc(nameOf(t.from))} → ${esc(nameOf(t.to))} ${C.yen(t.amount)}</b>
          <button class="primary small" data-act="settle" data-from="${t.from}" data-to="${t.to}" data-amount="${t.amount}">渡したので精算済みにする</button></div>`).join("") : `<div class="good">精算は必要ありません ✓</div>`}
        <div class="row" style="justify-content:flex-start;gap:8px">
          <button class="outline small" data-act="shareSettle">LINEなどで送る</button>
          ${!closed && !res.transfers.length && sharedCount ? `<button class="outline small" data-act="closeMonth">この月を締める</button>` : ""}
          ${closed ? `<button class="text small" data-act="reopenMonth">締めを取り消す</button>` : ""}
        </div>
        <div class="small">共通の出費 <b>${C.yen(res.total)}</b>（${sharedCount}件）</div>
        <table class="tbl"><tr><th></th><th>払った額</th><th>負担額</th><th>差額</th></tr>
        ${res.members.map((m) => `<tr><td>${esc(nameOf(m.uid))}</td><td>${C.yen(m.paid)}</td><td>${C.yen(m.share)}</td><td class="${m.paid - m.share < 0 ? "bad" : "good"}">${C.signedYen(m.paid - m.share)}</td></tr>`).join("")}</table>
        ${res.members.some((m) => m.carry) ? `<div class="small">前の月までの未精算：${res.members.filter((m) => m.carry).map((m) => `${esc(nameOf(m.uid))} ${m.carry > 0 ? "受け取り" : "支払い"} ${C.yen(Math.abs(m.carry))}`).join("／")}</div>` : ""}
        ${settleLinesHtml(members)}
        ${S.settle.records.map((r) => `<div class="row small muted"><span>記録：${esc(nameOf(r.from))} → ${esc(nameOf(r.to))} ${C.yen(r.amount)}</span><button class="text small" data-act="delSettle" data-id="${r.id}">取り消す</button></div>`).join("")}
        <div class="tiny muted">負担額は明細ごとの「負担」（共通・半分ずつ・相手の分など）で計算します。会社経費と「払った人だけ」の明細は入りません。</div>
        <div class="stack" style="gap:6px;margin-top:6px"><b class="small">自分の受け取り先</b>
          <div class="tiny muted">精算を「LINEなどで送る」ときに、受け取る人の受け取り先を文に入れます（例：PayPay ID ○○ / 住信SBI 普通 1234567）</div>
          <input id="payoutIn" value="${esc(S.settings.payout?.[S.user.uid] ?? "")}" placeholder="PayPay ID・振込先など">
          <button class="outline small" data-act="savePayout">受け取り先を保存</button>
          ${members.filter((u) => u !== S.user.uid && S.settings.payout?.[u]).map((u) => `<div class="tiny">${esc(nameOf(u))}の受け取り先：${esc(S.settings.payout[u])}</div>`).join("")}</div>
        <div class="stack" style="gap:6px;margin-top:6px"><b class="small">標準の負担割合</b>
          <div class="tiny muted">明細の負担が「共通」のときに使います。例：6と4にすると6:4で分けます（全員1なら均等）</div>
          <div class="grid2">${members.map((u) => `<label>${esc(nameOf(u))}<input data-ratio="${u}" inputmode="numeric" value="${S.settings.split[u] ?? 1}"></label>`).join("")}</div>
          <button class="outline small" data-act="saveRatio" ${S.busy ? "disabled" : ""}>割合を保存</button></div>`}
    </div>

    <div class="card stack">
      <b>🗂 家計の設定</b>
      <div class="menu">
        ${[["budget", "💰", "予算", "月の全体・カテゴリ別の予算"], ["cats", "🏷️", "カテゴリ・支払いルール", "追加・並べ替え・非表示、カテゴリごとの負担（家賃 5万・3万など）"],
          ["recurring", "🔁", "固定費・定期収入", "家賃・保険・給与など、毎月決まった日に自動で記録"], ["medical", "💊", "医療費控除の集計", "1年分の医療費と控除の目安、確定申告用のCSV"],
          ["furusato", "🏯", "ふるさと納税", "自分の上限の目安と残り枠、家族の寄附"],
          ["events", "🎉", "イベント別の予算", "新婚旅行・引越し・顔合わせなどの予算と実績"], ["lifeplan", "📈", "ライフプランの見通し", "資産と貯蓄ペース、イベントの予定から数年先の残高"],
          ["report", "📊", "毎月のレポート", "前の月のまとめ"], ["payslips", "🧾", "給与明細", "写真・PDFから読み取り（自分だけ）"],
          ["loans", "🤝", "友人との貸し借り", "立て替えた・借りたお金（自分だけ）"], ["warranty", "🛡️", "保証書・保証期限", "家電などの保証期限の一覧"]]
          .map(([k, i, t, d]) => `<button data-act="openPage" data-v="${k}"><span class="mi">${i}</span><span class="grow"><b>${t}</b><span class="tiny muted">${d}</span></span><span class="muted">›</span></button>`).join("")}
      </div>
      <div class="tiny muted">カード明細・通販の自動取り込みと出張手当はAndroidアプリで行います。</div>
    </div>

    <div class="row"><h3>🎯 貯金目標</h3><button class="text" data-act="addGoal">＋ 追加</button></div>
    ${S.goals.length ? [...S.goals].sort((a, c) => (a.createdAt ?? 0) - (c.createdAt ?? 0)).map((g) => goalCard(g, true)).join("") : `<p class="muted small">目標はまだありません。</p>`}

    <div class="card stack">
      <b>💰 今月の予算${members_().length > 1 ? `<span class="tiny muted">　${curBook() === C.BOTH ? "ふたり" : curBook() === S.user.uid ? "自分の家計簿" : `${esc(nameOf(curBook()))}の家計簿`}</span>` : ""}</b>
      ${b ? `${b.total ? budgetLine(Object.values(spentBy).reduce((a, c) => a + c, 0), b.total, C.Period.of("month", S.month), "全体") : ""}
        ${Object.entries(b.categories ?? {}).map(([id, v]) => budgetLine(spentBy[id] ?? 0, v, C.Period.of("month", S.month), S.cats.get(id).emoji + S.cats.get(id).label)).join("")}`
        : `<p class="muted small">予算はまだありません。</p>`}
      <button class="outline small" data-act="openPage" data-v="budget">予算を設定する</button>
    </div>

    <div class="card stack">
      <b>✨ AI解析</b>
      <div class="small">今日 ${u.dayCount} / ${S.settings.aiDailyLimit}回 · 今月 ${u.monthCount} / ${S.settings.aiMonthlyLimit}回（家族の合計）</div>
      ${u.blockedDay === C.ymd(today()) ? `<div class="bad small">⚠ Googleの無料枠の上限に達したため、今日はAIを止めています</div><button class="outline small" data-act="unblockAi">停止を解除して、もう一度試す</button>` : ""}
      ${!recaptchaSiteKey ? `<div class="warn small">このWeb版はAIの設定（reCAPTCHA）がまだのため、レシートは手入力になります。</div>` : ""}
    </div>

    ${themeCard()}

    <button class="outline" data-act="logout">ログアウト（${esc(myName())}）</button>
    <p class="tiny muted center">レシート家計簿 Web版</p>`;
}

// ======================= モーダル =======================

const catChips = (list, selected, act) => `<div class="chips wrap">${list.map((c) =>
  `<button type="button" data-act="${act}" data-v="${c.id}" class="${selected === c.id ? "on" : ""}">${c.emoji} ${esc(c.label)}</button>`).join("")}</div>`;

function payFields(m, { amount = null, modes = C.SPLIT_MODES } = {}) {
  const members = S.household?.members ?? [];
  return `<label>支払い方法<select data-bind="payment"><option value="">（未設定）</option>${C.PAYMENT_METHODS.map((p) => `<option ${m.payment === p ? "selected" : ""}>${p}</option>`).join("")}</select></label>
    ${members.length > 1 ? `<label>払った人<select data-bind="paidBy" data-rerender="1">${members.map((u) => `<option value="${u}" ${m.paidBy === u ? "selected" : ""}>${esc(nameOf(u))}</option>`).join("")}</select></label>
    ${m.business ? `<div class="small muted">会社経費の明細です（家計の支出・精算には入りません。Androidアプリで変更できます）</div>` : splitFieldsHtml(m, amount, modes)}` : ""}`;
}

/** 負担のしかた（瑞希との割り勘） */
function splitFieldsHtml(m, amount, modes) {
  const members = S.household?.members ?? [];
  const sp = m.split ?? { mode: "default" };
  const payer = m.paidBy || S.user.uid;
  const others = members.filter((u) => u !== payer);
  let detail = "";
  if (sp.mode === "default") detail = `<div class="tiny muted">標準の割合（${members.map((u) => S.settings.split[u] ?? 1).join(":")}）で分けます</div>`;
  else if (sp.mode === "ratio") detail = `<div class="grid2">${members.map((u) => `<label>${esc(nameOf(u))}<input data-split-w="${u}" inputmode="numeric" value="${sp.weights?.[u] ?? ""}"></label>`).join("")}</div>`;
  else if (sp.mode === "amount") detail = others.map((u) => `<label>${esc(nameOf(u))}の分（円）<input data-split-a="${u}" inputmode="numeric" value="${sp.amounts?.[u] ?? ""}"></label>`).join("");
  else if (sp.mode === "other") detail = `<div class="tiny muted">全額を${others.map((u) => esc(nameOf(u))).join("・")}が負担します</div>`;
  else detail = `<div class="tiny muted">${esc(C.SPLIT_MODES.find((x) => x.id === sp.mode)?.hint ?? "")}</div>`;
  const n = Number(amount);
  const preview = n > 0 && sp.mode !== "payer"
    ? (() => { const sh = C.shares(n, payer, sp, members, S.settings.split); return `<div class="small"><b>→ ${members.map((u) => `${esc(nameOf(u))} ${C.yen(sh[u] ?? 0)}`).join("　")}</b></div>`; })()
    : "";
  return `<div class="stack" style="gap:6px"><div class="small muted">負担</div>
    <div class="chips wrap">${modes.map((x) => `<button type="button" data-act="splitMode" data-v="${x.id}" class="${sp.mode === x.id ? "on" : ""}">${x.label}</button>`).join("")}</div>
    ${detail}${preview}</div>`;
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
      ${m.income || m.onlyMe ? "" : payFields(m, { amount: String(m.amount ?? "").replace(/[,¥円]/g, "") })}
      ${m.income || m.onlyMe ? "" : (() => {
        const open = S.events.filter((e) => !e.closed || e.id === m.eventId);
        return open.length ? `<div class="small muted">イベント</div><div class="chips wrap"><button type="button" data-act="pickEvent" data-v="" class="${m.eventId ? "" : "on"}">なし</button>${open.map((e) => `<button type="button" data-act="pickEvent" data-v="${e.id}" class="${m.eventId === e.id ? "on" : ""}">${esc(e.emoji ?? "🎉")} ${esc(e.name)}</button>`).join("")}</div>` : "";
      })()}
      ${m.income ? "" : `<label>保証期限（家電など・任意）<input type="date" data-bind="warrantyUntil" value="${esc((m.warrantyUntil ?? "").replace(/\//g, "-"))}"></label>`}
      ${m.income ? "" : `<label class="check"><input type="checkbox" data-act="onlyMe" ${m.onlyMe ? "checked" : ""}> 🔒 自分だけに見える（相手の家計簿・ふたり・精算に入りません）</label>`}
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
      ${payFields(m, { amount: C.categoryTotals(r, (i) => (i.forOther ? "o" : "s"), "s").s ?? 0, modes: C.SPLIT_MODES.filter((x) => x.id !== "amount") })}
      ${(S.household?.members ?? []).length > 1 ? `<div class="tiny muted">品目の「相手の分」にチェックすると、その品目だけ全額を相手の負担にして別の明細で保存します。</div>` : ""}
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
        ${(S.household?.members ?? []).length > 1 ? `<label class="check tiny"><input type="checkbox" data-item="${idx}" data-f="forOther" ${i.forOther ? "checked" : ""}> 相手の分</label>` : ""}
        <button class="text" data-act="delItem" data-v="${idx}">✕</button></div>`).join("")}
      <button class="outline small" data-act="addItem">＋ 品目を追加</button>
      <button class="primary" data-act="saveReceipt" ${S.busy || !Object.keys(totals).length ? "disabled" : ""}>${C.yen(Object.values(totals).reduce((a, b) => a + b, 0))} を ${Object.keys(totals).length}カテゴリに分けて保存</button>
    </div></div>`;
  }
  if (m.type === "cat") return viewCategoryModal(m);
  if (m.type === "quick") return viewQuickModal(m);
  if (m.type === "event") return viewEventModal(m);
  if (m.type === "loan") return viewLoanModal(m);
  if (m.type === "payslip") return viewPayslipModal(m);
  if (m.type === "rec") return viewRecurringModal(m);
  if (m.type === "goal") {
    return `<div class="modal"><div class="sheet stack">
      <div class="row"><h2>貯金目標を追加</h2><button class="text" data-act="close">✕</button></div>
      <label>目標（例：新婚旅行）<input data-bind="name" value="${esc(m.name ?? "")}"></label>
      <label>目標金額（円）<input data-bind="target" inputmode="numeric" value="${esc(m.target ?? "")}"></label>
      <label>期限（任意）<input type="month" data-bind="deadline" value="${esc(m.deadline ?? "")}"></label>
      ${members_().length > 1 ? `<div class="chips"><button data-act="goalOwner" data-v="${S.user.uid}" class="${m.owner === S.user.uid ? "on" : ""}">自分の目標</button><button data-act="goalOwner" data-v="" class="${!m.owner ? "on" : ""}">ふたりの目標</button></div>` : ""}
      <button class="primary" data-act="saveGoal">保存</button></div></div>`;
  }
  return "";
}

// ======================= 設定のページ（予算・カテゴリ・固定費・医療費） =======================

const num = (v) => { const n = Math.round(Number(String(v ?? "").replace(/[,¥円\s]/g, ""))); return Number.isFinite(n) ? n : NaN; };
const ymLabel = (k) => `${+k.slice(0, 4)}年${+k.slice(5, 7)}月`;
const pageHead = (title) => `<div class="page-head"><button class="icon" data-act="pageBack" aria-label="戻る">←</button><h2>${title}</h2></div>`;

function openPage(type) {
  if (type === "budget") {
    const owner = members_().length > 1 && curBook() !== C.BOTH ? S.user.uid : C.BOTH;
    S.page = { type, owner, month: C.ym(today()), ...budgetDraft(C.ym(today()), owner) };
  }
  else if (type === "medical") { S.page = { type, year: today().getFullYear(), reimbursed: "", rows: null }; loadMedical(); }
  else if (type === "furusato") { S.page = { type, year: today().getFullYear(), form: null, rows: null }; loadFurusato(); }
  else if (type === "events") { S.page = { type }; loadEventSpent(); }
  else if (type === "lifeplan") { S.page = { type, start: S.assets?.net != null ? String(S.assets.net) : "", saving: "", years: 5 }; loadEventSpent(); loadSaving(); }
  else if (type === "report") { S.page = { type, month: C.ym(addMonthsD(today(), -1)), rep: null }; loadReport(); }
  else if (type === "warranty") { S.page = { type, rows: null }; loadWarranty(); }
  else if (type === "payslips") { S.page = { type, year: today().getFullYear() }; }
  else S.page = { type };
  render(); window.scrollTo(0, 0);
}

function viewPage() {
  const p = S.page;
  if (p.type === "budget") return viewBudgetPage(p);
  if (p.type === "cats") return viewCategoriesPage();
  if (p.type === "recurring") return viewRecurringPage();
  if (p.type === "medical") return viewMedicalPage(p);
  if (p.type === "catDetail") return viewCategoryDetail(p);
  if (p.type === "furusato") return viewFurusatoPage(p);
  if (p.type === "events") return viewEventsPage();
  if (p.type === "eventDetail") return viewEventDetail(p);
  if (p.type === "lifeplan") return viewLifePlan(p);
  if (p.type === "report") return viewReport(p);
  if (p.type === "loans") return viewLoansPage();
  if (p.type === "warranty") return viewWarrantyPage(p);
  if (p.type === "payslips") return viewPayslipsPage(p);
  return "";
}

// ---------- 予算 ----------

/** その月から使う予算の下書き（その月の設定があればそれ、なければその月に効いている設定） */
function budgetDraft(key, owner = S.page?.owner ?? C.BOTH) {
  const list = bookBudgets(owner);
  const b = list.find((x) => x.month === key) ?? C.resolveBudget(key, list);
  return { total: b?.total != null ? String(b.total) : "", cats: Object.fromEntries(Object.entries(b?.categories ?? {}).map(([k, v]) => [k, String(v)])) };
}

function viewBudgetPage(p) {
  const list = bookBudgets(p.owner);
  const exists = list.some((b) => b.month === p.month);
  return `${pageHead("予算")}
    ${members_().length > 1 ? `<div class="chips"><button data-act="budgetOwner" data-v="${S.user.uid}" class="${p.owner === S.user.uid ? "on" : ""}">自分の家計簿の予算</button><button data-act="budgetOwner" data-v="${C.BOTH}" class="${p.owner === C.BOTH ? "on" : ""}">ふたりの予算</button></div>
      <p class="tiny muted">${p.owner === C.BOTH ? "ふたりの合計（共通の出費は全額）に対する予算です。" : "自分の家計簿（共通の出費は自分の負担分）に対する予算です。"}</p>` : ""}
    <div class="card stack">
      <label>この設定を使い始める月<input type="month" data-pbind="month" value="${p.month}"></label>
      <div class="tiny muted">${exists ? `${ymLabel(p.month)}からの設定を直します。` : `${ymLabel(p.month)}から、次の設定がある月まで使います。`}</div>
      <button class="outline small" data-act="budgetSuggest">過去3か月から予算を提案</button>
      <label>全体の予算（円）<input data-pbind="total" inputmode="numeric" value="${esc(p.total)}" placeholder="決めない"></label>
      <div class="small muted" style="margin-top:6px">カテゴリ別の予算（空欄は決めない）</div>
      <div class="budget-form">${S.cats.visible.map((c) => `<label><span>${c.emoji} ${esc(c.label)}</span>
        <input data-pbind="cats.${c.id}" inputmode="numeric" value="${esc(p.cats[c.id] ?? "")}" placeholder="—"></label>`).join("")}</div>
      <div class="tiny muted" id="catSum">${budgetSumText(p)}</div>
      <button class="primary" data-act="saveBudget" ${S.busy ? "disabled" : ""}>保存</button>
    </div>
    <h3>これまでの設定</h3>
    ${list.length ? [...list].sort((a, b) => b.month.localeCompare(a.month)).map((b) => `<div class="row card-row">
      <span class="grow"><b>${ymLabel(b.month)}から</b><span class="tiny muted">${[b.total ? `全体 ${C.yen(b.total)}` : "", `カテゴリ ${Object.keys(b.categories ?? {}).length}件`].filter(Boolean).join("・")}</span></span>
      <button class="text small" data-act="delBudget" data-v="${b.month}">削除</button></div>`).join("") : `<p class="muted small">まだありません。</p>`}`;
}

function budgetSumText(p) {
  const sum = Object.values(p.cats).map(num).filter((n) => n > 0).reduce((a, b) => a + b, 0);
  return `カテゴリ別の合計 ${C.yen(sum)}${num(p.total) > 0 ? `（全体 ${C.yen(num(p.total))}）` : ""}`;
}

function saveBudget() {
  const p = S.page;
  if (!/^\d{4}-\d{2}$/.test(p.month)) { toast("月を選んでください"); return; }
  const total = num(p.total) > 0 ? num(p.total) : null;
  const categories = Object.fromEntries(Object.entries(p.cats).map(([k, v]) => [k, num(v)]).filter(([, n]) => n > 0));
  if (total == null && !Object.keys(categories).length) { toast("全体かカテゴリのどれかに金額を入れてください"); return; }
  const ref = p.owner === C.BOTH ? doc(col("budgets"), p.month) : doc(col("memberBudgets"), `${p.owner}_${p.month}`);
  const data = p.owner === C.BOTH ? { total, categories } : { total, categories, uid: p.owner, month: p.month };
  task(() => setDoc(ref, data), () => toast(`${ymLabel(p.month)}からの予算を保存しました`));
}

// ---------- カテゴリ・支払いルール ----------

const saveCategories = (list) => setDoc(doc(db, "households", S.hid, "meta", "categories"), { items: list.map((c, i) => C.categoryToStored(c, i)) });

function moveCategory(id, d) {
  const list = [...S.cats.all];
  const i = list.findIndex((c) => c.id === id);
  const c = list[i];
  // 同じ種類（支出／収入）の中で、隣のカテゴリと入れ替える
  let j = i + d;
  while (j >= 0 && j < list.length && list[j].income !== c.income) j += d;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  task(() => saveCategories(list));
}

const ruleText = (c) => {
  const members = S.household?.members ?? [];
  if (c.split === "ratio") return "割合 " + members.map((u) => c.splitWeights?.[u] ?? 0).join(":");
  if (c.split === "amount") return members.map((u) => `${nameOf(u)} ${C.yen(c.splitAmounts?.[u] ?? 0)}`).join("・");
  return C.splitLabel(c.split);
};

function viewCategoriesPage() {
  const group = (income) => {
    const list = S.cats.all.filter((c) => !!c.income === income);
    return `<div class="ledger cat-list">${list.map((c, i) => `<div class="cat-row ${c.hidden ? "off" : ""}">
      <span class="dot" style="background:${C.cssColor(c.color)}22">${c.emoji}</span>
      <button class="grow" data-act="catEdit" data-v="${c.id}" style="text-align:left"><b>${esc(c.label)}</b>
        <span class="tiny muted">${c.hidden ? "非表示" : income ? "収入" : [ruleText(c), c.savings ? "貯蓄に数える" : ""].filter(Boolean).join("・")}</span></button>
      <button class="icon sm" data-act="catMove" data-v="${c.id}" data-d="-1" ${i === 0 ? "disabled" : ""} aria-label="上へ">▲</button>
      <button class="icon sm" data-act="catMove" data-v="${c.id}" data-d="1" ${i === list.length - 1 ? "disabled" : ""} aria-label="下へ">▼</button>
      ${c.id === C.OTHER_ID || c.id === C.INCOME_OTHER_ID ? `<span class="hide-sp"></span>` : `<button class="text small" data-act="catHide" data-v="${c.id}">${c.hidden ? "表示" : "隠す"}</button>`}
    </div>`).join("")}</div>`;
  };
  return `${pageHead("カテゴリ・支払いルール")}
    <p class="tiny muted">名前をタップすると、名前・絵文字・色と、そのカテゴリの既定の負担（支払いルール）を変えられます。家族の全員に反映されます。</p>
    <div class="row"><h3>支出</h3><button class="text" data-act="catAdd" data-v="0">＋ 追加</button></div>${group(false)}
    <div class="row"><h3>収入</h3><button class="text" data-act="catAdd" data-v="1">＋ 追加</button></div>${group(true)}`;
}

function viewCategoryModal(m) {
  const members = S.household?.members ?? [];
  const sp = m.split ?? { mode: "default" };
  const modes = C.SPLIT_MODES.filter((x) => x.id !== "other");
  let detail = "";
  if (sp.mode === "default") detail = `<div class="tiny muted">標準の割合（${members.map((u) => S.settings.split[u] ?? 1).join(":")}）で分けます</div>`;
  else if (sp.mode === "ratio") detail = `<div class="grid2">${members.map((u) => `<label>${esc(nameOf(u))}<input data-split-w="${u}" inputmode="numeric" value="${sp.weights?.[u] ?? ""}"></label>`).join("")}</div>`;
  else if (sp.mode === "amount") detail = `<div class="tiny muted">例：家賃 まさゆき 50,000・瑞希 30,000。金額が違う月は、この割合で分けます。</div>
    <div class="grid2">${members.map((u) => `<label>${esc(nameOf(u))}（円）<input data-split-a="${u}" inputmode="numeric" value="${sp.amounts?.[u] ?? ""}"></label>`).join("")}</div>`;
  else detail = `<div class="tiny muted">${esc(C.SPLIT_MODES.find((x) => x.id === sp.mode)?.hint ?? "")}</div>`;
  return `<div class="modal"><div class="sheet stack">
    <div class="row"><h2>${m.isNew ? (m.income ? "収入のカテゴリを追加" : "カテゴリを追加") : "カテゴリを編集"}</h2><button class="text" data-act="close">✕</button></div>
    <div class="grid-cat"><label>絵文字<input data-bind="emoji" value="${esc(m.emoji)}" maxlength="4" class="emoji-in"></label>
      <label>名前<input data-bind="label" value="${esc(m.label)}" placeholder="例：ジム"></label>
      <label>色<input type="color" data-bind="colorHex" value="${m.colorHex}"></label></div>
    ${m.income ? "" : `<label class="check"><input type="checkbox" data-bind="savings" ${m.savings ? "checked" : ""}> 貯蓄に数える（投資信託・積立・iDeCo など）</label>
      ${members.length > 1 ? `<div class="stack" style="gap:6px"><div class="small muted">支払いルール（このカテゴリの明細の、既定の負担）</div>
        <div class="chips wrap">${modes.map((x) => `<button type="button" data-act="splitMode" data-v="${x.id}" class="${sp.mode === x.id ? "on" : ""}">${x.label}</button>`).join("")}</div>
        ${detail}<div class="tiny muted">これから記録する明細に使います。記録済みの明細は変わりません。</div></div>` : ""}`}
    <button class="primary" data-act="saveCat" ${S.busy ? "disabled" : ""}>保存</button>
    ${!m.isNew && !m.builtin ? `<button class="text bad" data-act="delCat">このカテゴリを削除</button>` : ""}
  </div></div>`;
}

function saveCategory() {
  const m = S.modal;
  const label = String(m.label ?? "").trim();
  if (!label) { toast("名前を入れてください"); return; }
  const sp = m.split ?? { mode: "default" };
  const c = {
    ...(S.cats.byId[m.id] ?? {}), id: m.id, label, emoji: String(m.emoji ?? "").trim() || "🏷️", color: C.argbOf(m.colorHex),
    income: !!m.income, savings: !m.income && !!m.savings, builtin: !!m.builtin, hidden: !!m.hidden,
    split: m.income ? "default" : sp.mode, splitWeights: sp.weights ?? {}, splitAmounts: sp.amounts ?? {},
  };
  const list = m.isNew ? (() => { // 同じ種類の最後に入れる
    const all = [...S.cats.all];
    const last = all.map((x) => !!x.income).lastIndexOf(!!c.income);
    all.splice(last + 1, 0, c);
    return all;
  })() : S.cats.all.map((x) => (x.id === c.id ? c : x));
  task(() => saveCategories(list), () => { S.modal = null; toast("カテゴリを保存しました"); });
}

// ---------- 固定費・定期収入 ----------

function viewRecurringPage() {
  const list = [...S.recurring].sort((a, b) => (!!a.income - !!b.income) || (a.day ?? 1) - (b.day ?? 1));
  const sum = (inc) => list.filter((r) => !!r.income === inc && r.active !== false).reduce((s, r) => s + (r.amount ?? 0), 0);
  return `${pageHead("固定費・定期収入")}
    <p class="tiny muted">毎月決まった日に、明細として自動で記録します（Androidアプリ・Web版のどちらかを開いたとき。二重には記録しません）。</p>
    <div class="card"><div class="row"><span class="small">固定費 毎月</span><b class="num">${C.yen(sum(false))}</b></div>
      <div class="row"><span class="small">定期収入 毎月</span><b class="num inc">${C.yen(sum(true))}</b></div></div>
    <div class="row"><h3>一覧</h3><button class="text" data-act="recAdd">＋ 追加</button></div>
    ${list.length ? `<div class="ledger">${list.map((r) => {
      const c = S.cats.get(r.category);
      return `<button class="tx ${r.active === false ? "off" : ""}" data-act="recEdit" data-v="${r.id}">
        <i class="band" style="background:${payerColor({ paidBy: r.paidBy }) || "transparent"}"></i>
        <span class="dot" style="background:${C.cssColor(c.color)}22">${c.emoji}</span>
        <span class="grow"><span class="ellipsis tx-name">${esc(r.name || c.label)}</span>
          <span class="small muted ellipsis">${[`毎月${r.day ?? 1}日`, c.label, r.income ? "" : C.splitLabel(C.splitOf(r).mode), r.active === false ? "止めています" : r.lastPosted ? `${ymLabel(r.lastPosted)}まで記録済み` : ""].filter(Boolean).join("／")}</span></span>
        <b class="${r.income ? "inc" : ""}">${r.income ? "+" : ""}${C.yen(r.amount ?? 0)}</b></button>`;
    }).join("")}</div>` : `<p class="muted small">まだありません。「＋ 追加」から家賃・保険・給与などを登録できます。</p>`}`;
}

function viewRecurringModal(m) {
  const cats = m.income ? S.cats.incomeVisible : S.cats.visible;
  return `<div class="modal"><div class="sheet stack">
    <div class="row"><h2>${m.isNew ? "固定費・定期収入を追加" : "固定費・定期収入を編集"}</h2><button class="text" data-act="close">✕</button></div>
    <div class="seg"><button data-act="recKind" data-v="0" class="${m.income ? "" : "on"}">固定費（支出）</button><button data-act="recKind" data-v="1" class="${m.income ? "on" : ""}">定期収入</button></div>
    <label>名前<input data-bind="name" value="${esc(m.name ?? "")}" placeholder="${m.income ? "例：給与" : "例：家賃"}"></label>
    <label>金額（円）<input data-bind="amount" inputmode="numeric" value="${esc(m.amount ?? "")}" class="bigin"></label>
    ${catChips(cats, m.category, "pickCat")}
    <div class="grid2"><label>毎月の記録日<select data-bind="day">${Array.from({ length: 31 }, (_, i) => i + 1).map((d) => `<option value="${d}" ${+m.day === d ? "selected" : ""}>${d}日${d >= 29 ? "（月末に合わせる）" : ""}</option>`).join("")}</select></label>
      <label>記録を始める月<input type="month" data-bind="startMonth" value="${m.startMonth ?? C.ym(today())}"></label></div>
    ${m.income ? "" : payFields(m, { amount: String(m.amount ?? "").replace(/[,¥円]/g, ""), modes: C.SPLIT_MODES })}
    <label class="check"><input type="checkbox" data-bind="active" ${m.active !== false ? "checked" : ""}> 毎月記録する（オフにすると止めます）</label>
    ${m.lastPosted ? `<div class="tiny muted">${ymLabel(m.lastPosted)}分まで記録済みです。</div>` : ""}
    <button class="primary" data-act="saveRec" ${S.busy ? "disabled" : ""}>保存</button>
    ${m.isNew ? "" : `<button class="text bad" data-act="delRec">削除</button>`}
  </div></div>`;
}

function saveRecurring() {
  const m = S.modal;
  const amount = num(m.amount);
  if (!String(m.name ?? "").trim()) { toast("名前を入れてください"); return; }
  if (!(amount > 0)) { toast("金額を入れてください"); return; }
  const data = {
    ...C.splitFields(m.income ? { mode: "default" } : m.split ?? { mode: "default" }),
    name: m.name.trim(), amount, category: m.category, income: !!m.income, day: +m.day || 1,
    payment: m.payment ?? "", paidBy: m.paidBy || S.user.uid, active: m.active !== false,
    startMonth: /^\d{4}-\d{2}$/.test(m.startMonth ?? "") ? m.startMonth : C.ym(today()), lastPosted: m.lastPosted ?? "",
  };
  task(() => (m.isNew ? addDoc(col("recurring"), data) : setDoc(doc(col("recurring"), m.id), data)), () => { S.modal = null; toast("保存しました"); postRecurring(); });
}

/** 固定費を今日までの分だけ記録する。Android と同じく固定費ごとにトランザクションで lastPosted を確かめるので二重にならない */
async function postRecurring() {
  let posted = 0;
  for (const r of S.recurring) {
    if (!C.monthsToPost(r, today()).length) continue;
    try {
      posted += await runTransaction(db, async (tx) => {
        const ref = doc(col("recurring"), r.id);
        const snap = await tx.get(ref);
        if (!snap.exists()) return 0;
        const cur = { id: r.id, ...snap.data() };
        const months = C.monthsToPost(cur, today());
        for (const mo of months) {
          const t = {
            amount: cur.amount, category: cur.category, date: C.millisOf(C.recurringDate(cur, mo)), store: cur.name,
            memo: cur.income ? "定期収入" : "固定費（自動）", createdBy: S.user.uid, createdByName: myName(), createdAt: Date.now(),
            payment: cur.payment ?? "", paidBy: cur.paidBy ?? "", recurringId: cur.id, isIncome: !!cur.income,
            split: cur.income ? { mode: "default" } : C.splitOf(cur),
          };
          tx.set(doc(col(cur.income ? "incomes" : "transactions")), txToMap(t));
        }
        if (months.length) tx.update(ref, { lastPosted: months.at(-1) });
        return months.length;
      });
    } catch (e) { console.error(e); }
  }
  if (posted) toast(`固定費・定期収入を${posted}件記録しました`);
}

// ---------- 医療費控除 ----------

async function loadMedical() {
  const p = S.page;
  p.rows = null; render();
  const y = p.year;
  try {
    const q = await getDocs(rangeQuery("transactions", new Date(y, 0, 1), new Date(y + 1, 0, 1)));
    if (S.page !== p || p.year !== y) return;
    p.rows = q.docs.map((d) => txFromDoc(d, false)).filter((t) => t.category === "HEALTH" && !t.onlyMe);
  } catch (e) { console.error(e); p.rows = []; toast(friendly(e)); }
  render();
}

function viewMedicalPage(p) {
  const rows = p.rows ?? [];
  const total = rows.reduce((s, t) => s + t.amount, 0);
  const re = num(p.reimbursed) > 0 ? num(p.reimbursed) : 0;
  const est = C.medicalEstimate(total, re);
  const by = (f) => Object.entries(rows.reduce((o, t) => { const k = f(t); (o[k] ??= []).push(t); return o; }, {}))
    .map(([k, l]) => [k, l.length, l.reduce((s, t) => s + t.amount, 0)]).sort((a, b) => b[2] - a[2]);
  return `${pageHead("医療費控除の集計")}
    <div class="month-head"><b class="num">${p.year}</b><span><span class="mh-tsuki">年</span></span><span class="sp"></span>
      <button class="icon" data-act="medYear" data-v="-1" aria-label="前の年">‹</button><button class="icon" data-act="medYear" data-v="1" aria-label="次の年">›</button></div>
    <div class="cover"><div class="cover-in">
      <div class="row cover-label"><span>「${esc(S.cats.get("HEALTH").label)}」の支出（家族全員）</span><span class="small">${rows.length}件</span></div>
      <div class="big">${p.rows == null ? "…" : C.yen(total)}</div>
      <div class="crule"></div>
      <label class="cover-in-label">保険金などで補填される額（円）<input data-pbind="reimbursed" data-rerender="1" inputmode="numeric" value="${esc(p.reimbursed)}" placeholder="0"></label>
      ${coverLine(est > 0 ? "医療費控除の目安" : "基準の10万円まで", est > 0 ? C.yen(est) : `あと ${C.yen(Math.max(0, C.MEDICAL_THRESHOLD + re - total))}`, est > 0 ? "good" : "")}
    </div></div>
    <p class="tiny muted">総所得が200万円未満の人は、基準が10万円ではなく所得の5%になります。治療目的でない市販品・健康食品などは対象外です。最終的な判断は国税庁の案内や税務署で確認してください。</p>
    ${rows.length ? `<button class="outline" data-act="medCsv">確定申告用のCSVをダウンロード</button>
      <p class="tiny muted">国税庁の「医療費集計フォーム」の項目の順に並べています。氏名（払った人）や区分は必要に応じてExcelで直してください。</p>
      <h3>払った人ごと</h3><div class="card">${by((t) => C.payerOf(t)).map(([u, n, a]) => `<div class="row"><span>${esc(nameOf(u))}</span><span class="num">${n}件 <b>${C.yen(a)}</b></span></div>`).join("")}</div>
      <h3>支払先ごと</h3><div class="card">${by((t) => t.store || "（店名なし）").map(([st, n, a]) => `<div class="row small"><span class="grow ellipsis">${esc(st)}<span class="tiny muted">（${C.medicalKind(st)}）</span></span><span class="num">${n}件 ${C.yen(a)}</span></div>`).join("")}</div>`
      : p.rows ? `<p class="muted small">${p.year}年の「${esc(S.cats.get("HEALTH").label)}」の明細はまだありません。</p>` : ""}`;
}

function downloadCsv(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- カテゴリの明細（集計タブからタップ） ----------

function viewCategoryDetail(p) {
  const per = statsPeriod();
  const c = S.cats.get(p.id);
  const list = sortTx(statsTx().filter((t) => t.category === p.id));
  const total = list.reduce((a, t) => a + t.amount, 0);
  const limit = C.budgetFor(per, bookBudgets())?.categories?.[p.id];
  const stores = Object.entries(list.reduce((o, t) => { const k = t.store || "店名なし"; (o[k] ??= [0, 0]); o[k][0]++; o[k][1] += t.amount; return o; }, {}))
    .sort((a, b) => b[1][1] - a[1][1]);
  const groups = {};
  for (const t of list) (groups[t.date] ??= []).push(t);
  const dow = "日月火水木金土";
  return `${pageHead(`${c.emoji} ${esc(c.label)}`)}${bookSwitch()}
    <div class="nav"><button data-act="statsShift" data-v="-1">‹</button><h2>${per.label}</h2><button data-act="statsShift" data-v="1">›</button></div>
    <div class="card">
      <div class="row"><span class="small muted">${esc(c.label)}の合計</span><span class="small muted">${list.length}件</span></div>
      <div class="big num">${C.yen(total)}</div>
      <div class="row small"><span>1日平均</span><span class="num">${C.yen(per.days ? total / per.days : 0)}</span></div>
      ${list.length ? `<div class="row small"><span>1回あたり</span><span class="num">${C.yen(total / list.length)}</span></div>` : ""}
      ${limit ? budgetLine(total, limit, per, "予算") : ""}
    </div>
    ${stores.length > 1 ? `<h3>よく使った店</h3><div class="card">${stores.slice(0, 5).map(([n, [k, a]]) => `<div class="row small"><span class="grow ellipsis">${esc(n)}<span class="tiny muted">（${k}回）</span></span><b class="num">${C.yen(a)}</b></div>`).join("")}</div>` : ""}
    <h3>明細</h3>
    ${list.length ? Object.entries(groups).map(([d, l]) => {
      const dt = new Date(+d), w = dt.getDay();
      return `<div class="day"><b class="num">${dt.getMonth() + 1}/${dt.getDate()}</b><span class="dow ${w === 0 ? "sun" : w === 6 ? "sat" : ""}">${dow[w]}</span><span class="sp"></span><span class="num muted">${C.yen(l.reduce((a, t) => a + t.amount, 0))}</span></div>
        <div class="ledger">${l.map(txRow).join("")}</div>`;
    }).join("") : `<p class="muted small">この期間の明細はありません。</p>`}`;
}

// ---------- ふるさと納税（自分の上限と、家族の分を見る） ----------

const personalRef = () => doc(db, "households", S.hid, "private", S.user.uid, "meta", "personal");

async function loadFurusato() {
  const p = S.page, y = p.year;
  try {
    const [ps, q] = await Promise.all([getDoc(personalRef()), getDocs(rangeQuery("transactions", new Date(y, 0, 1), new Date(y + 1, 0, 1)))]);
    if (S.page !== p) return;
    const d = ps.exists() ? ps.data() : {};
    p.form = Object.fromEntries(["salary", "social", "ideco", "otherDeduction", "furusatoLimit"].map((k) => [k, d[k] ? String(d[k]) : ""]));
    p.rows = q.docs.map((x) => txFromDoc(x, false)).filter((t) => t.category === "FURUSATO");
  } catch (e) { console.error(e); p.form ??= {}; p.rows = []; toast(friendly(e)); }
  render();
}

const furusatoOf = (f, year) => (num(f.furusatoLimit) > 0 ? num(f.furusatoLimit)
  : C.furusatoLimit(num(f.salary) || 0, num(f.social) || 0, num(f.ideco) || 0, num(f.otherDeduction) || 0, year));

function furusatoCard(title, limit, rows, editable) {
  const done = rows.reduce((a, t) => a + t.amount, 0);
  const r = limit > 0 ? done / limit : 0;
  return `<div class="card stack">
    <b>${title}</b>
    <div class="big num">${C.yen(done)}<span class="small muted"> / 上限の目安 ${limit > 0 ? C.yen(limit) : "未設定"}</span></div>
    ${limit > 0 ? `<div class="bar"><i class="${r > 1 ? "bad" : "good"}" style="width:${Math.min(100, r * 100)}%"></i></div>
      <div class="small ${done > limit ? "bad" : ""}">${done <= limit ? `残り ${C.yen(limit - done)}（12月31日までの寄附が今年の分）` : `目安を ${C.yen(done - limit)} 超えています（超えた分は自己負担）`}</div>`
      : `<div class="tiny muted">${editable ? "下で年収などを入れて保存すると、上限の目安を計算します" : "本人が上限の計算を保存すると表示されます"}</div>`}
    ${rows.length ? `<div class="tiny muted">${rows.length}件。ワンストップ特例が使えるのは寄附先が5自治体までです</div>
      <div class="ledger">${sortTx([...rows]).map(txRow).join("")}</div>` : ""}
  </div>`;
}

function viewFurusatoPage(p) {
  if (!p.form || !p.rows) return `${pageHead("ふるさと納税")}<div class="center"><div class="spinner"></div></div>`;
  const me = S.user.uid, y = p.year;
  const mine = p.rows.filter((t) => C.payerOf(t) === me);
  const limit = furusatoOf(p.form, y);
  const fields = [["salary", "給与収入（年額・税込）", "源泉徴収票の「支払金額」"], ["social", "社会保険料（年額）", "健康保険・厚生年金・雇用保険の合計（iDeCo は下に）"],
    ["ideco", "iDeCo などの掛金（年額）", ""], ["otherDeduction", "そのほかの所得控除（年額）", "生命保険料控除・地震保険料控除など"],
    ["furusatoLimit", "上限を自分で決める（任意）", "ポータルサイトのシミュレーションの結果などを使う場合"]];
  return `${pageHead("ふるさと納税")}
    ${furusatoCard(`${y}年の自分の寄附`, limit, mine, true)}
    ${members_().filter((u) => u !== me).map((u) => {
      const sh = S.furusato[u];
      return furusatoCard(`${esc(nameOf(u))}の${y}年の寄附（見るだけ）`, sh?.year === y ? sh.limit ?? 0 : 0, p.rows.filter((t) => C.payerOf(t) === u), false);
    }).join("")}
    <h3>上限の計算</h3>
    <p class="tiny muted">入れた金額は自分だけに保存され、家族には上限の目安だけが見えます。会社員で扶養なしの場合の目安です（住宅ローン控除・医療費控除などは含みません）。寄附は「ふるさと納税」カテゴリで記録すると数えます。</p>
    <div class="card stack">${fields.map(([k, l, h]) => `<label>${l}<input data-pbind="form.${k}" inputmode="numeric" value="${esc(p.form[k] ?? "")}" placeholder="0">${h ? `<span class="tiny muted">${h}</span>` : ""}</label>`).join("")}
      <button class="primary" data-act="saveFurusato" ${S.busy ? "disabled" : ""}>計算して保存</button></div>`;
}

function saveFurusato() {
  const p = S.page, y = p.year;
  const data = Object.fromEntries(Object.entries(p.form).map(([k, v]) => [k, num(v) > 0 ? num(v) : 0]));
  const limit = furusatoOf(p.form, y);
  task(async () => {
    await setDoc(personalRef(), data, { merge: true });
    await setDoc(doc(col("furusato"), S.user.uid), { year: y, limit, updatedAt: Date.now() });
  }, () => toast(limit > 0 ? `上限の目安は ${C.yen(limit)} です` : "保存しました"));
}

// ---------- 資産（Android アプリが写した配当積立帳の集計を見る） ----------

function lineChart(points, key, color) {
  if (points.length < 2) return "";
  const W = 340, H = 110, vals = points.map((x) => x[key]);
  const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
  const xy = vals.map((v, i) => [(i / (vals.length - 1)) * W, H - 6 - ((v - lo) / span) * (H - 16)]);
  const d = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="spark" preserveAspectRatio="none"><path d="${d}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>
    <div class="row tiny muted"><span>${esc(points[0].d)}</span><span>${C.yenShort(lo)}〜${C.yenShort(hi)}</span><span>${esc(points.at(-1).d)}</span></div>`;
}

function viewAssets() {
  const a = S.assets;
  if (!a) return `<div class="blank"><b>資産のデータがまだありません</b><p class="muted">Androidアプリの「資産」タブを開くと、ここにも表示されます。</p></div>`;
  const ch = a.prev?.net != null ? a.net - a.prev.net : null;
  const cats = (a.categories ?? []).filter((c) => c.value > 0);
  const catTotal = cats.reduce((s, c) => s + c.value, 0) || 1;
  const colors = ["#3e5c76", "#b0657b", "#5f8f6b", "#c79a3b", "#7a6fa8", "#4f9aa8", "#a86f4f", "#8a8a8a"];
  const g = a.goal;
  const hold = [...(a.holdings ?? [])].sort((x, y) => y.value - x.value);
  const todayS = C.ymd(today()).replace(/\//g, "-");
  const events = (a.events ?? []).filter((e) => (e.date ?? "") >= todayS.slice(0, e.month ? 7 : 10)).slice(0, 8);
  const md = (d) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;
  const div = a.monthly?.div ?? [];
  const divMax = Math.max(1, ...div);
  return `
    <div class="tiny muted" style="margin-bottom:6px">${a.owner ? `${esc(nameOf(a.owner))}の資産（配当積立帳）。見るだけ` : "配当積立帳の資産"}${a.fetchedAt ? `・${new Date(a.fetchedAt).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} 時点` : ""}</div>
    <div class="cover"><div class="cover-in">
      <div class="row cover-label"><span>純資産</span>${ch != null ? `<span class="small ${ch < 0 ? "bad" : "good"}">前回から ${C.signedYen(ch)}</span>` : ""}</div>
      <div class="big">${C.yen(a.net)}</div>
      <div class="crule"></div>
      ${coverLine("金融資産", C.yen(a.fin))}
      ${a.finPl ? coverLine("評価損益", C.signedYen(a.finPl), a.finPl < 0 ? "bad" : "good") : ""}
      ${a.liab ? coverLine("負債", C.yen(a.liab), "bad") : ""}
      ${a.divNet ? coverLine("年間配当（税引後）", C.yen(a.divNet), "", a.yutai ? `優待 ${C.yen(a.yutai)} 相当` : "") : ""}
      ${cats.length ? `<div class="stack-bar">${cats.map((c, i) => `<i style="flex:${c.value};background:${colors[i % colors.length]}"></i>`).join("")}</div>
        <div class="cat2">${cats.map((c, i) => `<span><i style="background:${colors[i % colors.length]}"></i><span class="ellipsis">${esc(c.label)}</span><b class="num">${Math.round((c.value * 100) / catTotal)}%</b></span>`).join("")}</div>` : ""}
    </div></div>
    ${g ? `<h3>目標</h3><div class="card"><div class="row"><b>${C.yen(g.amount)}（${esc(g.date ?? "")}）</b><span class="num">${(g.progress ?? 0).toFixed(1)}%</span></div>
      <div class="bar"><i class="good" style="width:${Math.min(100, g.progress ?? 0)}%"></i></div>
      <div class="small muted">あと${g.monthsLeft}か月。積立（月${C.yenShort(g.monthly)}）だけなら、期限には${C.yenShort(g.projected)}円${g.shortfall > 0 ? `（${C.yenShort(g.shortfall)}円足りない見込み）` : ""}</div></div>` : ""}
    ${(a.history ?? []).length > 1 ? `<h3>純資産の推移</h3><div class="card">${lineChart(a.history, "n", "var(--primary)")}</div>` : ""}
    ${div.some((v) => v > 0) ? `<h3>月ごとの配当</h3><div class="card"><div class="divbars">${div.map((v, i) => `<span><i style="height:${(v / divMax) * 100}%"></i><em>${i + 1}</em></span>`).join("")}</div></div>` : ""}
    ${events.length ? `<h3>これからの予定</h3><div class="card">${events.map((e) => `<div class="row small"><span class="grow ellipsis"><span class="tiny muted">${e.month ? `${+e.date.slice(5, 7)}月` : md(e.date)}</span> ${esc(e.name)}<span class="tiny muted">　${{ div: "配当の入金", yutai_rights: "優待の権利付最終日" }[e.type] ?? "優待が届く"}</span></span>${e.amount ? `<b class="num">${C.yen(e.amount)}</b>` : ""}</div>`).join("")}</div>` : ""}
    ${hold.length ? `<h3>保有銘柄（${hold.length}）</h3><div class="ledger">${hold.map((h) => `<div class="tx"><i class="band"></i>
      <span class="grow"><span class="ellipsis tx-name">${esc(h.name)}</span><span class="small muted ellipsis">${[h.kindLabel, h.account, h.yieldPct != null ? `利回り ${h.yieldPct.toFixed(2)}%` : "", h.div ? `配当 ${C.yen(h.div)}` : ""].filter(Boolean).map(esc).join("／")}</span></span>
      <span class="hold-amt"><b class="num">${C.yen(h.value)}</b>${h.pl != null ? `<span class="tiny ${h.pl < 0 ? "bad" : "good"}">${C.signedYen(h.pl)}${h.plPct != null ? `（${h.plPct.toFixed(1)}%）` : ""}</span>` : ""}</span></div>`).join("")}</div>` : ""}
    ${(a.insurances ?? []).length ? `<h3>積立保険</h3><div class="card">${a.insurances.map((x) => `<div class="row small"><span class="grow ellipsis">${esc(x.name)}<span class="tiny muted">　払込 ${C.yen(x.paid)}${x.ratio != null ? `・返戻率 ${x.ratio.toFixed(1)}%` : ""}</span></span><b class="num">${C.yen(x.value)}</b></div>`).join("")}</div>` : ""}
    ${(a.others ?? []).length ? `<h3>そのほか</h3><div class="card">${a.others.map((x) => `<div class="row small"><span class="grow ellipsis">${esc(x.name)}<span class="tiny muted">　${esc(x.type)}</span></span><b class="num">${C.yen(x.value)}</b></div>`).join("")}</div>` : ""}`;
}

// ======================= 高機能化（2〜11） =======================

const addMonthsD = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);
const myColRef = (name) => collection(db, "households", S.hid, "private", S.user.uid, name);

/** AI の枠を確保して呼ぶ。使えなければ toast して null */
async function withAiQuota(fn) {
  if (!S.settings.aiEnabled || !recaptchaSiteKey) { toast("AIが使えません（設定でオフ、またはWeb版のAI設定がまだです）"); return null; }
  if (!localStorage.getItem("aiConsent")) {
    if (!confirm("入力した内容をGoogleのAI（Gemini）に送って読み取ります。無料枠の範囲だけで使い、料金はかかりません。よろしいですか？")) return null;
    localStorage.setItem("aiConsent", "1");
  }
  const r = await reserveAi();
  if (r.kind === "blocked" || r.kind === "limit") { toast("今日のAIの回数の上限に達しました"); return null; }
  try { return await fn(); } catch (e) { refundAi(); throw e; }
}
const jsonOf = (text) => JSON.parse(String(text).trim().replace(/^```json/, "").replace(/^```/, "").replace(/```$/, "").trim());
const catListText = () => [...S.cats.visible, ...S.cats.incomeVisible].map((c) => `- ${c.id}: ${c.label}${c.income ? "（収入）" : ""}`).join("\n");

// ---------- 2. ひとことで入力 ----------

function viewQuickModal(m) {
  return `<div class="modal"><div class="sheet stack">
    <div class="row"><h2>ひとことで入力</h2><button class="text" data-act="close">✕</button></div>
    <div class="tiny muted">例：「スシロー ふたりで3200」「昨日 ガソリン 5,400 カード」「まさゆきの分 ユニクロ 2990」</div>
    <div class="row"><input data-bind="text" value="${esc(m.text ?? "")}" placeholder="何にいくら？" class="grow">
      ${window.SpeechRecognition || window.webkitSpeechRecognition ? `<button class="outline small" data-act="quickVoice">🎤</button>` : ""}</div>
    ${m.loading ? `<div class="center"><div class="spinner"></div></div>` : ""}
    <button class="primary" data-act="quickGo" ${m.loading ? "disabled" : ""}>読み取る</button>
  </div></div>`;
}

function quickVoice() {
  const R = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!R) return;
  const rec = new R();
  rec.lang = "ja-JP"; rec.interimResults = false;
  rec.onresult = (e) => { if (S.modal?.type === "quick") { S.modal.text = e.results[0][0].transcript; render(); } };
  rec.onerror = () => toast("音声を聞き取れませんでした");
  rec.start(); toast("話してください…");
}

async function quickEntry() {
  const m = S.modal;
  const text = String(m.text ?? "").trim();
  if (!text) return;
  const partner = nameOf(members_().find((u) => u !== S.user.uid) ?? "") || "相手";
  m.loading = true; render();
  try {
    const o = await withAiQuota(async () => {
      const model = getGenerativeModel(ai, { model: S.settings.aiModel, generationConfig: { responseMimeType: "application/json" } });
      const prompt = `家計簿に1件記録します。次のひとことから、次の形のJSONだけを返してください。
{"amount":金額の整数（円。「3千」「1.2万」も数字に）,"category":"カテゴリID","store":"お店・相手（なければ空）","memo":"補足（なければ空）",
 "date":"yyyy-MM-dd（「昨日」「おととい」「月曜」などは今日 ${C.ymd(today())} から計算。書かれていなければ空）","income":収入なら true,
 "split":"負担（「ふたりで」「半分」→ even、「自分の」「自分だけ」→ payer、「${partner}の分」「立て替え」→ other、書かれていなければ default）",
 "payment":"支払方法（現金・クレジットカード・PayPay・交通系IC など。書かれていなければ空）"}
カテゴリ:
${catListText()}

ひとこと: ${text}`;
      return jsonOf((await withRetry(() => model.generateContent(prompt))).response.text());
    });
    if (!o) { m.loading = false; render(); return; }
    const cat = S.cats.byId[o.category] ? o.category : o.income ? "SALARY" : "OTHER";
    const split = { even: { mode: "even" }, payer: { mode: "payer" }, other: { mode: "other" } }[o.split] ?? C.categorySplit(S.cats.get(cat));
    const date = /^\d{4}-\d{2}-\d{2}$/.test(o.date ?? "") ? o.date : C.ymd(today());
    S.modal = { type: "entry", income: !!o.income, amount: o.amount > 0 ? String(o.amount) : "", category: cat, date, store: o.store ?? "", memo: o.memo ?? "",
      payment: o.payment || (localStorage.getItem("lastPayment") ?? ""), paidBy: S.user.uid, split, splitTouched: o.split !== "default" };
    toast("読み取りました。確かめて保存してください");
  } catch (e) { console.error(e); m.loading = false; toast("読み取れませんでした（" + friendly(e) + "）"); }
  render();
}

// ---------- 3. 給与明細 ----------

function viewPayslipsPage(p) {
  const list = S.payslips.filter((x) => (x.month ?? "").startsWith(String(p.year))).sort((a, b) => (b.month + (b.bonus ? "b" : "")).localeCompare(a.month + (a.bonus ? "b" : "")));
  const sum = (k) => list.reduce((a, x) => a + (x[k] ?? 0), 0);
  const est = payslipYear(p.year);
  return `${pageHead("給与明細")}
    <p class="tiny muted">給与明細の写真やPDFをAIで読み取り、総支給・控除・手取りを記録します。自分だけに保存され、家族には見えません。</p>
    <button class="primary" data-act="payslipPick">給与明細を読み取る（写真・PDF）</button>
    <input type="file" id="payslipFile" data-act="payslipFile" accept="image/*,application/pdf" hidden>
    <button class="text" data-act="payslipEdit" data-v="">手で入力する</button>
    <div class="nav"><button data-act="payYear" data-v="-1">‹</button><h2>${p.year}年</h2><button data-act="payYear" data-v="1">›</button></div>
    <div class="card">
      <div class="row"><span>総支給（${list.length}件）</span><b class="num">${C.yen(sum("gross"))}</b></div>
      <div class="row small"><span>手取り</span><span class="num">${C.yen(sum("net"))}</span></div>
      <div class="row small"><span>所得税・住民税</span><span class="num">${C.yen(sum("incomeTax") + sum("residentTax"))}</span></div>
      <div class="row small"><span>社会保険料</span><span class="num">${C.yen(sum("social"))}</span></div>
      ${est.gross > 0 ? `<div class="row small"><span>年収の見込み</span><b class="num">${C.yen(est.gross)}</b></div><div class="tiny muted">まだの月は毎月の平均で埋めた見込み（社会保険料 ${C.yen(est.social)}）</div>
        <button class="outline small" data-act="payslipToFurusato">ふるさと納税の上限の計算に使う</button>` : ""}
    </div>
    <h3>明細</h3>
    ${list.length ? `<div class="card">${list.map((x) => `<button class="row small" data-act="payslipEdit" data-v="${x.id}" style="width:100%;text-align:left;padding:6px 0">
      <span class="grow">${x.month.replace("-", "年")}月${x.bonus ? "（賞与）" : ""}<span class="tiny muted">　総支給 ${C.yen(x.gross ?? 0)}・税 ${C.yen((x.incomeTax ?? 0) + (x.residentTax ?? 0))}・社保 ${C.yen(x.social ?? 0)}</span></span><b class="num">${C.yen(x.net ?? 0)}</b></button>`).join("")}</div>` : `<p class="muted small">この年の明細はまだありません。</p>`}`;
}

function payslipYear(year) {
  const l = S.payslips.filter((x) => (x.month ?? "").startsWith(String(year)));
  if (!l.length) return { gross: 0, social: 0 };
  const m = l.filter((x) => !x.bonus);
  const left = Math.max(0, 12 - new Set(m.map((x) => x.month)).size);
  const avg = (k) => (m.length ? Math.trunc(m.reduce((a, x) => a + (x[k] ?? 0), 0) / m.length) : 0);
  return { gross: l.reduce((a, x) => a + (x.gross ?? 0), 0) + avg("gross") * left, social: l.reduce((a, x) => a + (x.social ?? 0), 0) + avg("social") * left };
}

async function readPayslip(file) {
  if (!file) return;
  if (file.size > 15e6) { toast("ファイルが大きすぎます（15MBまで）"); return; }
  S.modal = { type: "payslip", loading: true, month: C.ym(today()), bonus: false, record: true }; render();
  try {
    const data = file.type.startsWith("image/") ? await resize(file) : await new Promise((ok, ng) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1]); r.onerror = ng; r.readAsDataURL(file); });
    const mime = file.type.startsWith("image/") ? "image/jpeg" : file.type || "application/pdf";
    const o = await withAiQuota(async () => {
      const model = getGenerativeModel(ai, { model: S.settings.aiModel, generationConfig: { responseMimeType: "application/json" } });
      const prompt = `給与明細（または賞与明細）です。次の形のJSONだけを返してください。金額は円の整数、なければ0。
{"month":"支給年月 yyyy-MM","gross":総支給額,"net":差引支給額（手取り）,"incomeTax":所得税,"residentTax":住民税,"social":社会保険料の合計（健康保険・介護保険・厚生年金・雇用保険）,"other":そのほかの控除の合計,"bonus":賞与明細なら true,"employer":"会社名（分からなければ空）"}`;
      return jsonOf((await withRetry(() => model.generateContent([prompt, { inlineData: { data, mimeType: mime } }]))).response.text());
    });
    if (!o) { S.modal = null; render(); return; }
    S.modal = { type: "payslip", month: /^\d{4}-\d{2}$/.test(o.month ?? "") ? o.month : C.ym(today()), bonus: !!o.bonus, record: true,
      ...Object.fromEntries(["gross", "net", "incomeTax", "residentTax", "social", "other"].map((k) => [k, String(o[k] ?? 0)])), employer: o.employer ?? "" };
    toast("読み取りました。確かめて保存してください");
  } catch (e) { console.error(e); S.modal = null; toast("読み取れませんでした（" + friendly(e) + "）"); }
  render();
}

function viewPayslipModal(m) {
  if (m.loading) return `<div class="modal"><div class="sheet stack"><b>AIで給与明細を読み取っています…</b><div class="center"><div class="spinner"></div></div></div></div>`;
  const f = (k, l) => `<label>${l}<input data-bind="${k}" inputmode="numeric" value="${esc(m[k] ?? "")}"></label>`;
  return `<div class="modal"><div class="sheet stack">
    <div class="row"><h2>給与明細の確認</h2><button class="text" data-act="close">✕</button></div>
    <div class="grid2"><label>支給月<input type="month" data-bind="month" value="${esc(m.month ?? "")}"></label>
      <label class="check" style="align-self:end"><input type="checkbox" data-bind="bonus" ${m.bonus ? "checked" : ""}> 賞与</label></div>
    <div class="grid2">${f("gross", "総支給額")}${f("net", "手取り")}${f("incomeTax", "所得税")}${f("residentTax", "住民税")}${f("social", "社会保険料")}${f("other", "そのほかの控除")}</div>
    <label>会社名<input data-bind="employer" value="${esc(m.employer ?? "")}"></label>
    <label class="check"><input type="checkbox" data-bind="record" ${m.record ? "checked" : ""}> 手取りを収入として記録する</label>
    <button class="primary" data-act="savePayslip" ${S.busy ? "disabled" : ""}>保存</button>
    ${m.id ? `<button class="text bad" data-act="delPayslip">削除</button>` : ""}
  </div></div>`;
}

function savePayslip() {
  const m = S.modal;
  if (!/^\d{4}-\d{2}$/.test(m.month ?? "")) { toast("支給月を入れてください"); return; }
  const n = (k) => Math.max(0, num(m[k]) || 0);
  const data = { month: m.month, gross: n("gross"), net: n("net"), incomeTax: n("incomeTax"), residentTax: n("residentTax"), social: n("social"), other: n("other"),
    bonus: !!m.bonus, employer: String(m.employer ?? "").trim(), createdAt: m.createdAt ?? Date.now() };
  const id = m.bonus ? `${m.month}-bonus` : m.month;
  task(async () => {
    if (m.id && m.id !== id) await deleteDoc(doc(myColRef("payslips"), m.id));
    await setDoc(doc(myColRef("payslips"), id), data);
    if (m.record && data.net > 0) {
      const [y, mo] = m.month.split("-").map(Number);
      const day = new Date(y, mo - 1, Math.min(25, new Date(y, mo, 0).getDate()));
      await setDoc(doc(col("incomes"), `pay-${S.user.uid.slice(0, 6)}-${id}`), txToMap({
        amount: data.net, category: data.bonus ? "BONUS" : "SALARY", date: C.millisOf(day), store: data.employer || (data.bonus ? "賞与" : "給与"),
        memo: `給与明細から（総支給 ${C.yen(data.gross)}）`, createdBy: S.user.uid, createdByName: myName(), createdAt: Date.now(),
        paidBy: S.user.uid, isIncome: true, source: "payslip",
      }));
    }
  }, () => { S.modal = null; toast("給与明細を保存しました"); });
}

function payslipToFurusato() {
  const est = payslipYear(S.page.year);
  if (!(est.gross > 0)) return;
  task(async () => {
    await setDoc(doc(db, "households", S.hid, "private", S.user.uid, "meta", "personal"), { salary: est.gross, social: est.social }, { merge: true });
    const snap = await getDoc(doc(db, "households", S.hid, "private", S.user.uid, "meta", "personal"));
    const d = snap.data() ?? {};
    const y = today().getFullYear();
    const limit = d.furusatoLimit > 0 ? d.furusatoLimit : C.furusatoLimit(d.salary ?? 0, d.social ?? 0, d.ideco ?? 0, d.otherDeduction ?? 0, y);
    await setDoc(doc(col("furusato"), S.user.uid), { year: y, limit, updatedAt: Date.now() });
  }, () => toast("ふるさと納税の計算に年収の見込みを入れました"));
}

// ---------- 4. イベント ----------

async function loadEventSpent() {
  try {
    const q = await getDocs(query(col("transactions"), where("eventId", ">", "")));
    const spent = {};
    q.docs.map((d) => txFromDoc(d, false)).filter((t) => !t.business).forEach((t) => { spent[t.eventId] = (spent[t.eventId] ?? 0) + t.amount; });
    S.eventSpent = spent;
  } catch (e) { console.error(e); S.eventSpent = {}; }
  render();
}

function viewEventsPage() {
  const sp = S.eventSpent ?? {};
  const list = [...S.events].sort((a, b) => (!!a.closed - !!b.closed) || (a.start || "9999").localeCompare(b.start || "9999"));
  return `${pageHead("イベント別の予算")}
    <p class="tiny muted">新婚旅行・引越し・顔合わせなどをイベントとして作り、明細の入力画面でイベントを選ぶと、予算と実績・ふたりの負担をまとめます。予定日と予算は「ライフプラン」にも使います。</p>
    <button class="outline" data-act="eventEdit" data-v="">＋ イベントを作る</button>
    ${list.map((e) => {
      const used = sp[e.id] ?? 0, r = e.budget > 0 ? used / e.budget : 0;
      return `<button class="card stack" data-act="openEvent" data-v="${e.id}" style="text-align:left;width:100%">
        <div class="row"><b>${esc(e.emoji ?? "🎉")} ${esc(e.name)}</b>${e.closed ? `<span class="tiny muted">終了</span>` : ""}</div>
        ${e.start ? `<span class="tiny muted">予定 ${e.start.replace(/-/g, "/")}${e.end ? "〜" + e.end.replace(/-/g, "/") : ""}</span>` : ""}
        <div class="big num">${C.yen(used)}${e.budget > 0 ? `<span class="small muted"> / 予算 ${C.yen(e.budget)}</span>` : ""}</div>
        ${e.budget > 0 ? `<div class="bar"><i class="${r > 1 ? "bad" : "good"}" style="width:${Math.min(100, r * 100)}%"></i></div><span class="small">${used <= e.budget ? `残り ${C.yen(e.budget - used)}` : `予算を ${C.yen(used - e.budget)} 超えています`}</span>` : ""}
      </button>`;
    }).join("") || `<p class="muted small">まだありません。</p>`}`;
}

function viewEventModal(m) {
  return `<div class="modal"><div class="sheet stack">
    <div class="row"><h2>${m.id ? "イベントを直す" : "イベントを作る"}</h2><button class="text" data-act="close">✕</button></div>
    <div class="grid-cat" style="grid-template-columns:70px 1fr"><label>絵文字<input data-bind="emoji" value="${esc(m.emoji ?? "🎉")}" maxlength="4" class="emoji-in"></label>
      <label>名前<input data-bind="name" value="${esc(m.name ?? "")}" placeholder="例：新婚旅行"></label></div>
    <label>予算（円・任意）<input data-bind="budget" inputmode="numeric" value="${esc(m.budget ?? "")}"></label>
    <div class="grid2"><label>予定日・開始日<input type="date" data-bind="start" value="${esc(m.start ?? "")}"></label><label>終了日<input type="date" data-bind="end" value="${esc(m.end ?? "")}"></label></div>
    ${m.id ? `<label class="check"><input type="checkbox" data-bind="closed" ${m.closed ? "checked" : ""}> 終わったイベント（入力画面に出さない）</label>` : ""}
    <button class="primary" data-act="saveEvent" ${S.busy ? "disabled" : ""}>保存</button>
    ${m.id ? `<button class="text bad" data-act="delEvent">削除</button>` : ""}
  </div></div>`;
}

function saveEvent() {
  const m = S.modal;
  if (!String(m.name ?? "").trim()) { toast("名前を入れてください"); return; }
  const data = { name: m.name.trim(), emoji: (m.emoji || "🎉").trim(), budget: num(m.budget) > 0 ? num(m.budget) : 0, start: m.start ?? "", end: m.end ?? "", closed: !!m.closed, createdAt: m.createdAt ?? Date.now() };
  task(() => (m.id ? setDoc(doc(col("events"), m.id), data) : addDoc(col("events"), data)), () => { S.modal = null; toast("イベントを保存しました"); loadEventSpent(); });
}

async function loadEventRows() {
  const p = S.page;
  try {
    const q = await getDocs(query(col("transactions"), where("eventId", "==", p.id)));
    p.rows = sortTx(q.docs.map((d) => txFromDoc(d, false)));
  } catch (e) { console.error(e); p.rows = []; }
  render();
}

function viewEventDetail(p) {
  const e = S.events.find((x) => x.id === p.id);
  if (!e) return `${pageHead("イベント")}<p class="muted">見つかりません。</p>`;
  const rows = p.rows ?? [];
  const spend = rows.filter((t) => !t.business);
  const total = spend.reduce((a, t) => a + t.amount, 0);
  const ms = members_();
  const byCat = {};
  for (const t of spend) byCat[t.category] = (byCat[t.category] ?? 0) + t.amount;
  return `${pageHead(`${esc(e.emoji ?? "🎉")} ${esc(e.name)}`)}
    <div class="card stack">
      <div class="row"><span class="small muted">使った額（${spend.length}件）</span><button class="text small" data-act="eventEdit" data-v="${e.id}">直す</button></div>
      <div class="big num">${C.yen(total)}</div>
      ${e.budget > 0 ? budgetLine(total, e.budget, C.Period.of("month", today()), "予算") : ""}
      ${ms.length > 1 ? ms.map((u) => `<div class="row small"><span>${esc(nameOf(u))}の負担<span class="tiny muted">（払った額 ${C.yen(spend.filter((t) => C.payerOf(t) === u).reduce((a, t) => a + t.amount, 0))}）</span></span><b class="num">${C.yen(spend.reduce((a, t) => a + C.shareOf(t, u, ms, S.settings.split), 0))}</b></div>`).join("") : ""}
    </div>
    ${Object.keys(byCat).length ? `<h3>カテゴリ別</h3><div class="card">${Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([c, v]) => `<div class="row small"><span>${S.cats.get(c).emoji} ${esc(S.cats.get(c).label)}</span><b class="num">${C.yen(v)}</b></div>`).join("")}</div>` : ""}
    <h3>明細</h3>
    ${p.rows == null ? `<div class="center"><div class="spinner"></div></div>` : rows.length ? `<div class="ledger">${rows.map(txRow).join("")}</div>` : `<p class="muted small">入力画面で「イベント」を選ぶとここに入ります。</p>`}`;
}

// ---------- 5. ライフプラン ----------

async function loadSaving() {
  const p = S.page;
  try {
    const m = today(), start = addMonthsD(m, -3), end = addMonthsD(m, 0);
    const [tx, inc] = await Promise.all([getDocs(rangeQuery("transactions", start, end)), getDocs(rangeQuery("incomes", start, end))]);
    const v = C.monthlySaving(tx.docs.map((d) => txFromDoc(d, false)), inc.docs.map((d) => txFromDoc(d, true)), C.ym(m), 3);
    p.recent = v;
    if (!p.saving) p.saving = String(v);
  } catch (e) { console.error(e); }
  render();
}

function viewLifePlan(p) {
  const pts = C.lifePlan(num(p.start) || 0, num(p.saving) || 0, C.ym(today()), p.years * 12, S.events, S.eventSpent ?? {});
  const last = pts.at(-1);
  const low = pts.reduce((a, x) => (x.balance < a.balance ? x : a), pts[0]);
  return `${pageHead("ライフプランの見通し")}
    <p class="tiny muted">今の資産から、毎月の貯蓄が続いた場合の残高の見込みです。イベントの予定日に、残りの予算を出費として引きます。</p>
    <div class="card stack">
      <label>今の資産（円）<input data-pbind="start" data-rerender="1" inputmode="numeric" value="${esc(p.start)}"><span class="tiny muted">${S.assets?.net != null ? `資産タブの純資産 ${C.yen(S.assets.net)}` : "資産タブのデータがあると自動で入ります"}</span></label>
      <label>毎月の貯蓄（円）<input data-pbind="saving" data-rerender="1" inputmode="numeric" value="${esc(p.saving)}"><span class="tiny muted">${p.recent != null ? `直近3か月のふたりの 収入−支出 の平均は ${C.yen(p.recent)}` : "計算中…"}</span></label>
      <div class="chips">${[3, 5, 10].map((y) => `<button data-act="planYears" data-v="${y}" class="${p.years === y ? "on" : ""}">${y}年</button>`).join("")}</div>
    </div>
    <div class="card">
      <div class="small muted">${last.month.replace("-", "年")}月の見込み</div>
      <div class="big num ${last.balance < 0 ? "bad" : ""}">${C.yen(last.balance)}</div>
      ${lineChart(pts.map((x) => ({ d: x.month, n: x.balance })), "n", "var(--primary)")}
      ${low.balance < (num(p.start) || 0) ? `<div class="small">いちばん少なくなるのは ${low.month.replace("-", "年")}月の ${C.yen(low.balance)}</div>` : ""}
    </div>
    ${pts.some((x) => x.events.length) ? `<h3>予定の出費</h3><div class="card">${pts.filter((x) => x.events.length).map((x) => `<div class="row small"><span class="grow">${x.month.replace("-", "年")}月<span class="tiny muted">　${esc(x.events.join("、"))} のあと</span></span><b class="num">${C.yen(x.balance)}</b></div>`).join("")}</div>` : ""}
    <h3>1年ごと</h3><div class="card">${pts.filter((x, i) => x.month.endsWith("-12") || i === pts.length - 1).map((x) => `<div class="row small"><span>${x.month.replace("-", "年")}月</span><b class="num">${C.yen(x.balance)}</b></div>`).join("")}</div>`;
}

// ---------- 6. 毎月のレポート ----------

async function loadReport() {
  const p = S.page;
  p.rep = null; render();
  try {
    const m = new Date(+p.month.slice(0, 4), +p.month.slice(5, 7) - 1, 1), next = addMonthsD(m, 1), prev = addMonthsD(m, -1);
    const [tx, inc, pv, pm, pmPrev] = await Promise.all([getDocs(rangeQuery("transactions", m, next)), getDocs(rangeQuery("incomes", m, next)), getDocs(rangeQuery("transactions", prev, m)),
      getDocs(rangeQuery(privCol(), m, next)).catch(() => ({ docs: [] })), getDocs(rangeQuery(privCol(), prev, m)).catch(() => ({ docs: [] }))]);
    const b = curBook();
    const view = (l) => C.bookView(l, b, members_(), S.settings.split);
    p.rep = C.monthReport(view([...tx.docs.map((d) => txFromDoc(d, false)), ...pm.docs.map(privFromDoc)]), view(inc.docs.map((d) => txFromDoc(d, true))),
      view([...pv.docs.map((d) => txFromDoc(d, false)), ...pmPrev.docs.map(privFromDoc)]), C.resolveBudget(p.month, bookBudgets()));
  } catch (e) { console.error(e); p.rep = { error: friendly(e) }; }
  render();
}

function viewReport(p) {
  const r = p.rep;
  const head = `${pageHead("毎月のレポート")}${bookSwitch()}<div class="nav"><button data-act="reportMonth" data-v="-1">‹</button><h2>${p.month.replace("-", "年")}月</h2><button data-act="reportMonth" data-v="1">›</button></div>`;
  if (!r) return head + `<div class="center"><div class="spinner"></div></div>`;
  if (r.error) return head + `<p class="bad">${esc(r.error)}</p>`;
  const diff = r.prevSpend != null ? r.spend - r.prevSpend : null;
  return `${head}
    <div class="card">
      <div class="small muted">支出（${r.count}件）</div><div class="big num">${C.yen(r.spend)}</div>
      ${diff != null ? `<div class="row small"><span>前月比</span><b class="num ${diff > 0 ? "bad" : "good"}">${C.signedYen(diff)}</b></div>` : ""}
      ${r.income > 0 ? `<div class="row small"><span>収入</span><span class="num">${C.yen(r.income)}</span></div><div class="row small"><span>収支</span><b class="num ${r.income < r.spend ? "bad" : "good"}">${C.signedYen(r.income - r.spend)}</b></div>` : ""}
    </div>
    ${r.top.length ? `<h3>多かったカテゴリ</h3><div class="card">${r.top.map(([c, v]) => `<div class="row small"><span>${S.cats.get(c).emoji} ${esc(S.cats.get(c).label)}</span><b class="num">${C.yen(v)}</b></div>`).join("")}</div>` : ""}
    ${r.over.length ? `<h3>予算を超えたカテゴリ</h3><div class="card">${r.over.map(([c, v]) => `<div class="row small"><span>${S.cats.get(c).emoji} ${esc(S.cats.get(c).label)}</span><b class="num bad">+${C.yen(v)}</b></div>`).join("")}</div>` : ""}`;
}

// ---------- 7. 予算の提案 ----------

async function suggestBudgetFill() {
  const p = S.page;
  try {
    const base = new Date(+p.month.slice(0, 4), +p.month.slice(5, 7) - 1, 1);
    const q = await getDocs(rangeQuery("transactions", addMonthsD(base, -3), base));
    const view = C.bookView(q.docs.map((d) => txFromDoc(d, false)), p.owner, members_(), S.settings.split);
    const b = C.suggestBudget(view, p.month);
    if (!b) { toast("直近3か月の明細がないので提案できません"); return; }
    p.total = String(b.total);
    p.cats = Object.fromEntries(Object.entries(b.categories).map(([k, v]) => [k, String(v)]));
    toast("直近3か月の平均から入れました。確かめて保存してください");
  } catch (e) { console.error(e); toast(friendly(e)); }
  render();
}

// ---------- 8. おかしな出費 ----------

function anomalyHtml() {
  if (curBook() !== S.user.uid && curBook() !== C.BOTH) return "";
  if (S.anomalies == null) { S.anomalies = []; loadAnomalies(); return ""; }
  const ok = new Set(JSON.parse(store.get("kakeibo.anomalyOk", "[]")));
  const list = S.anomalies.filter((a) => !ok.has(a.detail)).slice(0, 5);
  if (!list.length) return "";
  const icon = { dup: "⚠️", up: "📈", large: "💸" };
  return `<div class="card stack"><b class="small">気になる出費</b>${list.map((a) => `<div class="row small"><span class="grow" ${a.ids[0] ? `data-act="edit" data-id="${a.ids[0]}" data-income="0" role="button"` : ""}><b>${icon[a.kind] ?? ""} ${a.title}</b><span class="tiny muted">${esc(a.detail)}</span></span>
    <button class="text small" data-act="dismissAnomaly" data-v="${esc(a.detail)}">問題なし</button></div>`).join("")}</div>`;
}

async function loadAnomalies() {
  try {
    const t = today(), start = addMonthsD(t, -4);
    const q = await getDocs(rangeQuery("transactions", start, new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1)));
    const hist = q.docs.map((d) => txFromDoc(d, false));
    const cut = t.getTime() - 14 * 86400000;
    S.anomalies = C.anomalies(hist.filter((x) => x.date >= cut), hist, t.getTime());
  } catch (e) { console.error(e); S.anomalies = []; }
  render();
}

// ---------- 9. 友人との貸し借り ----------

function viewLoansPage() {
  const signed = (l) => (l.settled ? 0 : l.lend ? l.amount : -l.amount);
  const people = Object.entries(S.loans.reduce((o, l) => { (o[l.person] ??= []).push(l); return o; }, {}))
    .map(([p, l]) => [p, l, l.reduce((a, x) => a + signed(x), 0)]).sort((a, b) => Math.abs(b[2]) - Math.abs(a[2]));
  const lend = S.loans.filter((l) => !l.settled && l.lend).reduce((a, l) => a + l.amount, 0);
  const borrow = S.loans.filter((l) => !l.settled && !l.lend).reduce((a, l) => a + l.amount, 0);
  return `${pageHead("友人との貸し借り")}
    <p class="tiny muted">友人の分を立て替えた・借りたお金を、相手ごとに残します。家計簿の支出とは別で、自分だけに保存されます。</p>
    <div class="card"><div class="row"><span>貸している（返してもらう）</span><b class="num good">${C.yen(lend)}</b></div><div class="row"><span>借りている（返す）</span><b class="num bad">${C.yen(borrow)}</b></div></div>
    <button class="outline" data-act="loanEdit" data-v="">＋ 貸し借りを追加</button>
    ${people.map(([p, l, bal]) => `<div class="card stack">
      <div class="row"><b>${esc(p)}さん</b><b class="num ${bal < 0 ? "bad" : "good"}">${bal > 0 ? `貸し ${C.yen(bal)}` : bal < 0 ? `借り ${C.yen(-bal)}` : "精算済み"}</b></div>
      ${[...l].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "")).map((x) => `<button class="row small" data-act="loanEdit" data-v="${x.id}" style="width:100%;text-align:left">
        <span class="grow ${x.settled ? "muted" : ""}">${(x.date ?? "").replace(/-/g, "/")}　${esc(x.memo || (x.lend ? "立て替え" : "借りた"))}${x.settled ? "（返済済み）" : ""}</span><span class="num">${x.lend ? "+" : "−"}${C.yen(x.amount)}</span></button>`).join("")}
      <div class="row"><button class="text small" data-act="loanEdit" data-v="" data-person="${esc(p)}">＋ 追加</button>${bal !== 0 ? `<button class="outline small" data-act="settleLoans" data-v="${esc(p)}">全部返してもらった・返した</button>` : ""}</div>
    </div>`).join("")}`;
}

function viewLoanModal(m) {
  return `<div class="modal"><div class="sheet stack">
    <div class="row"><h2>${m.id ? "貸し借りを直す" : "貸し借りを追加"}</h2><button class="text" data-act="close">✕</button></div>
    <div class="seg"><button data-act="loanLend" data-v="1" class="${m.lend ? "on" : ""}">貸した・立て替えた</button><button data-act="loanLend" data-v="0" class="${m.lend ? "" : "on"}">借りた</button></div>
    <label>相手<input data-bind="person" value="${esc(m.person ?? "")}" list="loanPeople"></label>
    <datalist id="loanPeople">${[...new Set(S.loans.map((l) => l.person))].map((p) => `<option value="${esc(p)}">`).join("")}</datalist>
    <label>金額（円）<input data-bind="amount" inputmode="numeric" value="${esc(m.amount ?? "")}"></label>
    <label>内容<input data-bind="memo" value="${esc(m.memo ?? "")}" placeholder="例：パーティー会費"></label>
    <label>日付<input type="date" data-bind="date" value="${esc(m.date ?? "")}"></label>
    ${m.id ? `<label class="check"><input type="checkbox" data-bind="settled" ${m.settled ? "checked" : ""}> 返済済み</label>` : ""}
    <button class="primary" data-act="saveLoan" ${S.busy ? "disabled" : ""}>保存</button>
    ${m.id ? `<button class="text bad" data-act="delLoan">削除</button>` : ""}
  </div></div>`;
}

function saveLoan() {
  const m = S.modal;
  const amount = num(m.amount);
  if (!String(m.person ?? "").trim() || !(amount > 0)) { toast("相手と金額を入れてください"); return; }
  const prev = S.loans.find((x) => x.id === m.id);
  const data = { person: m.person.trim(), amount, lend: !!m.lend, memo: String(m.memo ?? "").trim(), date: m.date || C.ymd(today()),
    settled: !!m.settled, settledAt: m.settled && !prev?.settled ? Date.now() : prev?.settledAt ?? 0, createdAt: prev?.createdAt ?? Date.now() };
  task(() => (m.id ? setDoc(doc(myColRef("loans"), m.id), data) : addDoc(myColRef("loans"), data)), () => { S.modal = null; });
}

// ---------- 10. 精算の受け取り先 ----------

function savePayout() {
  const v = String(document.getElementById("payoutIn")?.value ?? "").trim();
  task(() => setDoc(doc(db, "households", S.hid, "meta", "settings"), { payout: { [S.user.uid]: v } }, { merge: true }), () => toast("受け取り先を保存しました"));
}

// ---------- 11. 保証期限 ----------

async function loadWarranty() {
  const p = S.page;
  try {
    const q = await getDocs(query(col("transactions"), where("warrantyUntil", ">", "")));
    p.rows = C.warrantyList(q.docs.map((d) => txFromDoc(d, false)), today());
  } catch (e) { console.error(e); p.rows = []; }
  render();
}

function viewWarrantyPage(p) {
  if (!p.rows) return `${pageHead("保証書・保証期限")}<div class="center"><div class="spinner"></div></div>`;
  const alive = p.rows.filter((x) => x.days >= 0), expired = p.rows.filter((x) => x.days < 0);
  const row = (x) => `<button class="row small" data-act="edit" data-id="${x.t.id}" data-income="0" style="width:100%;text-align:left;padding:6px 0">
    <span class="grow">${S.cats.get(x.t.category).emoji} ${esc(x.t.store || x.t.memo || "店名なし")}<span class="tiny muted">　${C.ymd(new Date(x.t.date))} 購入・${C.yen(x.t.amount)}</span></span>
    <span class="${x.days >= 0 && x.days <= 30 ? "bad" : ""}">${x.t.warrantyUntil.replace(/-/g, "/")}${x.days >= 0 ? (x.days <= 30 ? `（あと${x.days}日）` : "まで") : " 終了"}</span></button>`;
  return `${pageHead("保証書・保証期限")}
    <p class="tiny muted">明細の入力画面で「保証期限」を入れた買い物の一覧です。Androidアプリでは期限の30日前と当日に通知します。</p>
    ${alive.length ? `<h3>保証中（${alive.length}）</h3><div class="card">${alive.map(row).join("")}</div>` : `<p class="muted small">保証中のものはありません。</p>`}
    ${expired.length ? `<h3>期限切れ（${expired.length}）</h3><div class="card">${expired.map(row).join("")}</div>` : ""}`;
}

// ---------- 標準の負担割合 ----------

function saveRatio() {
  const split = {};
  for (const el of document.querySelectorAll("[data-ratio]")) {
    const n = num(el.value);
    if (!(n >= 0)) { toast("割合は0以上の数字で入れてください"); return; }
    split[el.dataset.ratio] = n;
  }
  if (!Object.values(split).some((n) => n > 0)) { toast("どれか1人は1以上にしてください"); return; }
  task(() => setDoc(doc(db, "households", S.hid, "meta", "settings"), { split }, { merge: true }), () => toast("標準の負担割合を保存しました"));
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

/** ページの入力欄（data-pbind="a.b"）を S.page に書く */
function setPath(obj, path, value) {
  const keys = path.split(".");
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] ??= {};
  o[keys.at(-1)] = value;
}

document.addEventListener("input", (e) => {
  const el = e.target;
  if (el.dataset.pbind && S.page) {
    setPath(S.page, el.dataset.pbind, el.type === "checkbox" ? el.checked : el.value);
    if (S.page.type === "budget") { const t = document.getElementById("catSum"); if (t) t.textContent = budgetSumText(S.page); }
    return;
  }
  const m = S.modal;
  if (!m) return;
  if (el.dataset.bind) m[el.dataset.bind] = el.type === "checkbox" ? el.checked : el.value;
});

document.addEventListener("change", (e) => {
  const el = e.target;
  if (el.dataset.act === "scan") { scanReceipt([...el.files]); el.value = ""; return; }
  if (el.dataset.act === "payslipFile") { readPayslip(el.files[0]); el.value = ""; return; }
  if (el.dataset.act === "onlyMe" && S.modal) {
    const m = S.modal;
    m.onlyMe = el.checked;
    if (m.onlyMe) { m.paidBy = S.user.uid; m.split = { mode: "payer" }; } else if (!m.splitTouched) m.split = C.categorySplit(S.cats.get(m.category));
    render(); return;
  }
  if (el.dataset.pbind && S.page) {
    setPath(S.page, el.dataset.pbind, el.type === "checkbox" ? el.checked : el.value);
    if (S.page.type === "budget" && el.dataset.pbind === "month") { Object.assign(S.page, budgetDraft(el.value)); render(); return; }
    if (el.dataset.rerender) render();
    return;
  }
  const m = S.modal;
  if (!m) return;
  if (el.dataset.bind) { m[el.dataset.bind] = el.type === "checkbox" ? el.checked : el.value; if (el.dataset.rerender || el.dataset.bind === "amount") render(); return; }
  if (el.dataset.splitW || el.dataset.splitA) {
    const n = Math.round(Number(el.value.replace(/[,¥円]/g, "")));
    m.split = { ...(m.split ?? { mode: "default" }) };
    if (el.dataset.splitW) m.split.weights = { ...(m.split.weights ?? {}), [el.dataset.splitW]: Number.isFinite(n) ? Math.max(0, n) : 0 };
    else {
      const a = { ...(m.split.amounts ?? {}) };
      if (el.value.trim() === "" || !Number.isFinite(n)) delete a[el.dataset.splitA]; else a[el.dataset.splitA] = Math.max(0, n);
      m.split.amounts = a;
    }
    m.splitTouched = true;
    render(); return;
  }
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
    else if (el.type === "checkbox") it[el.dataset.f] = el.checked;
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
    case "tab": S.tab = v; S.page = null; render(); window.scrollTo(0, 0); break;
    case "openPage": openPage(v); break;
    case "pageBack": S.page = null; render(); window.scrollTo(0, 0); break;
    case "saveBudget": saveBudget(); break;
    case "delBudget": if (confirm(`${v.replace("-", "年")}月からの予算の設定を削除しますか？`)) {
      const o = S.page?.owner ?? C.BOTH;
      task(() => deleteDoc(o === C.BOTH ? doc(col("budgets"), v) : doc(col("memberBudgets"), `${o}_${v}`)));
    } break;
    case "catMove": moveCategory(v, +el.dataset.d); break;
    case "catHide": { const c = S.cats.get(v); task(() => saveCategories(S.cats.all.map((x) => (x.id === c.id ? { ...x, hidden: !x.hidden } : x)))); break; }
    case "catEdit": { const c = S.cats.get(v); S.modal = { type: "cat", ...c, colorHex: C.cssColor(c.color), split: C.categorySplit(c) }; render(); break; }
    case "catAdd": S.modal = { type: "cat", isNew: true, id: "c" + Date.now().toString(36), label: "", emoji: v === "1" ? "💰" : "🏷️", colorHex: "#7e8a97", income: v === "1", savings: false, builtin: false, hidden: false, split: { mode: "default" } }; render(); break;
    case "saveCat": saveCategory(); break;
    case "delCat": if (confirm(`カテゴリ「${m.label}」を削除しますか？このカテゴリの明細は「その他」として表示されます。`)) task(() => saveCategories(S.cats.all.filter((x) => x.id !== m.id)), () => { S.modal = null; }); break;
    case "recEdit": { const r = S.recurring.find((x) => x.id === v); S.modal = { type: "rec", ...r, split: C.splitOf(r), splitTouched: true, amount: String(r.amount) }; render(); break; }
    case "recAdd": S.modal = { type: "rec", isNew: true, name: "", amount: "", income: false, category: "HOUSING", day: 27, payment: "デビット・口座振替", paidBy: S.user.uid, split: C.categorySplit(S.cats.get("HOUSING")), active: true, startMonth: C.ym(today()), lastPosted: "" }; render(); break;
    case "recKind": m.income = v === "1"; m.category = m.income ? "SALARY" : "HOUSING"; render(); break;
    case "saveRec": saveRecurring(); break;
    case "delRec": if (confirm(`「${m.name}」を削除しますか？これまでに記録した明細は残ります。`)) task(() => deleteDoc(doc(col("recurring"), m.id)), () => { S.modal = null; }); break;
    case "medYear": S.page.year += +v; loadMedical(); break;
    case "medCsv": downloadCsv(`医療費_${S.page.year}.csv`, C.medicalCsv(S.page.rows ?? [], nameOf)); break;
    case "saveRatio": saveRatio(); break;
    case "saveFurusato": saveFurusato(); break;
    case "quick": S.modal = { type: "quick", text: "" }; render(); break;
    case "quickGo": quickEntry(); break;
    case "quickVoice": quickVoice(); break;
    case "pickEvent": m.eventId = v; render(); break;
    case "eventEdit": { const e = S.events.find((x) => x.id === v); S.modal = { type: "event", ...(e ?? { emoji: "🎉", name: "", budget: "", start: "", end: "", closed: false }), budget: e?.budget ? String(e.budget) : "" }; render(); break; }
    case "saveEvent": saveEvent(); break;
    case "delEvent": if (confirm(`イベント「${m.name}」を削除しますか？明細は残ります。`)) task(() => deleteDoc(doc(col("events"), m.id)), () => { S.modal = null; S.page = { type: "events" }; }); break;
    case "openEvent": S.page = { type: "eventDetail", id: v, rows: null }; loadEventRows(); render(); window.scrollTo(0, 0); break;
    case "budgetSuggest": suggestBudgetFill(); break;
    case "dismissAnomaly": { const set = new Set(JSON.parse(store.get("kakeibo.anomalyOk", "[]"))); set.add(v); store.set("kakeibo.anomalyOk", JSON.stringify([...set])); render(); break; }
    case "loanEdit": { const l = S.loans.find((x) => x.id === v); S.modal = { type: "loan", ...(l ?? { person: el.dataset.person ?? "", lend: true, memo: "", date: C.ymd(today()).replace(/\//g, "-"), settled: false }), amount: l ? String(l.amount) : "" }; render(); break; }
    case "loanLend": m.lend = v === "1"; render(); break;
    case "saveLoan": saveLoan(); break;
    case "delLoan": task(() => deleteDoc(doc(myColRef("loans"), m.id)), () => { S.modal = null; }); break;
    case "settleLoans": if (confirm(`${v}さんとの貸し借りを全部精算済みにしますか？`)) task(async () => { for (const l of S.loans.filter((x) => x.person === v && !x.settled)) await setDoc(doc(myColRef("loans"), l.id), { ...l, id: undefined, settled: true, settledAt: Date.now() }); }); break;
    case "savePayout": savePayout(); break;
    case "reportMonth": S.page.month = C.ym(addMonthsD(new Date(+S.page.month.slice(0, 4), +S.page.month.slice(5, 7) - 1, 1), +v)); loadReport(); break;
    case "payYear": S.page.year += +v; render(); break;
    case "planYears": S.page.years = +v; render(); break;
    case "payslipPick": document.getElementById("payslipFile")?.click(); break;
    case "payslipEdit": { const p = S.payslips.find((x) => x.id === v); S.modal = { type: "payslip", ...(p ?? { month: C.ym(today()), bonus: false }), record: !p }; render(); break; }
    case "savePayslip": savePayslip(); break;
    case "delPayslip": task(() => deleteDoc(doc(myColRef("payslips"), m.id)), () => { S.modal = null; }); break;
    case "payslipToFurusato": payslipToFurusato(); break;
    case "theme": themePref.id = v; store.set("kakeibo.theme", v); applyTheme(); render(); break;
    case "themeFollow": themePref.follow = !themePref.follow; store.set("kakeibo.themeFollowDark", themePref.follow ? "1" : "0"); applyTheme(); render(); break;
    case "logout": signOut(auth); break;
    case "month": S.month = C.addMonths(S.month, +v); subscribeMonth(); render(); break;
    case "statsType": S.stats.type = v; subscribeStats(); render(); break;
    case "statsShift": S.stats.anchor = statsPeriod().shift(+v).start; subscribeStats(); render(); break;
    case "member": S.stats.member = v || null; render(); break;
    case "book": S.book = v; render(); break;
    case "openCat": S.page = { type: "catDetail", id: v }; render(); window.scrollTo(0, 0); break;
    case "goalOwner": m.owner = v; render(); break;
    case "budgetOwner": Object.assign(S.page, { owner: v }, budgetDraft(S.page.month, v)); render(); break;
    case "shareMode": S.stats.shareMode = v === "1"; render(); break;
    case "splitMode": {
      const members = S.household?.members ?? [];
      m.split = v === "ratio" ? { mode: v, weights: m.split?.weights && Object.keys(m.split.weights).length ? m.split.weights : Object.fromEntries(members.map((u) => [u, S.settings.split[u] ?? 1])) }
        : v === "amount" ? { mode: v, amounts: m.split?.amounts ?? {} } : { mode: v };
      m.splitTouched = true; render(); break;
    }
    case "goSettle": {
      const [y, mo] = v.split("-").map(Number);
      S.settle.month = new Date(y, mo - 1, 1); S.tab = "more"; subscribeSettle(); render();
      setTimeout(() => document.getElementById("settle")?.scrollIntoView({ behavior: "smooth" }), 50);
      break;
    }
    case "shareSettle": {
      const members = S.household?.members ?? [];
      const r = C.settlement(S.settle.tx, members, S.settings.split, S.settle.records, S.settle.carry);
      const pay = [...new Set(r.transfers.map((x) => x.to))].map((u) => S.settings.payout?.[u] ? `${nameOf(u)}の受け取り先：${S.settings.payout[u]}` : "").filter(Boolean);
      const text = C.summaryText(`${S.settle.month.getMonth() + 1}月`, r, nameOf, members.map((u) => S.settings.split[u] ?? 1).join(":")) + (pay.length ? "\n\n" + pay.join("\n") : "");
      if (navigator.share) navigator.share({ text }).catch(() => {});
      else navigator.clipboard?.writeText(text).then(() => toast("精算の内容をコピーしました"), () => toast("コピーできませんでした"));
      break;
    }
    case "closeMonth":
      task(() => setDoc(doc(db, "households", S.hid, "settleCloses", C.ym(S.settle.month)), { closedAt: Date.now(), by: myName() }), () => toast("この月を締めました"));
      break;
    case "reopenMonth":
      task(() => deleteDoc(doc(db, "households", S.hid, "settleCloses", C.ym(S.settle.month))));
      break;
    case "cat": S.stats.cat = S.stats.cat === v ? null : v; render(); break;
    case "settleMonth": S.settle.month = C.addMonths(S.settle.month, +v); subscribeSettle(); render(); break;
    case "close": S.modal = null; render(); break;
    case "add":
      S.modal = { type: "entry", income: false, category: "FOOD", date: C.ymd(today()), payment: localStorage.getItem("lastPayment") ?? "", paidBy: S.user.uid, split: C.categorySplit(S.cats.get("FOOD")) };
      render(); break;
    case "edit": {
      const income = el.dataset.income === "1";
      const t = [...S.monthTx, ...S.monthIn, ...S.stats.tx, ...S.stats.inc, ...S.settle.tx, ...S.priv, ...S.stats.priv].find((x) => x.id === el.dataset.id && x.isIncome === income);
      if (!t) return;
      S.modal = { type: "entry", ...t, income, date: C.ymd(C.dateOf(t.date)), paidBy: C.payerOf(t), split: C.splitOf(t), splitTouched: true, wasOnlyMe: !!t.onlyMe, onlyMe: !!t.onlyMe };
      render(); break;
    }
    case "kind": m.income = v === "1"; m.category = m.income ? "SALARY" : "FOOD"; render(); break;
    case "pickCat": m.category = v; if (!m.income && !m.splitTouched) m.split = C.categorySplit(S.cats.get(v)); render(); break;
    case "saveEntry": saveEntry(); break;
    case "deleteEntry":
      if (confirm("この明細を削除しますか？家族全員の家計簿から削除されます。")) {
        task(() => deleteDoc(m.wasOnlyMe ? doc(privCol(), m.id) : doc(db, "households", S.hid, m.income ? "incomes" : "transactions", m.id)), () => { S.modal = null; });
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
    case "settle": {
      const month = C.ym(S.settle.month);
      task(async () => {
        await addDoc(col("settlements"), { month, from: el.dataset.from, to: el.dataset.to, amount: +el.dataset.amount, createdAt: Date.now() });
        await setDoc(doc(db, "households", S.hid, "settleCloses", month), { closedAt: Date.now(), by: myName() });
      }, () => toast("精算を記録しました"));
      break;
    }
    case "delSettle": task(() => deleteDoc(doc(db, "households", S.hid, "settlements", el.dataset.id))); break;
    case "addGoal": S.modal = { type: "goal", owner: curBook() === C.BOTH ? "" : S.user.uid }; render(); break;
    case "unblockAi":
      task(() => setDoc(doc(db, "households", S.hid, "meta", "aiUsage"), { blockedDay: "" }, { merge: true }), () => toast("AI解析の停止を解除しました"));
      break;
    case "saveGoal": {
      const target = Math.round(Number(String(m.target ?? "").replace(/[,¥円]/g, "")));
      if (!m.name?.trim() || !(target > 0)) { toast("目標と金額を入れてください"); return; }
      task(() => addDoc(col("goals"), { name: m.name.trim(), target, deadline: m.deadline ?? "", deposits: [], createdAt: Date.now(), owner: m.owner ?? "" }), () => { S.modal = null; });
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
    split: m.income ? { mode: "default" } : (m.split ?? { mode: "default" }), business: !!m.business,
    recurringId: m.recurringId ?? null, isIncome: m.income, updatedAt: m.id ? Date.now() : 0,
    special: !!m.special, source: m.source ?? "", reimbursed: !!m.reimbursed,
    eventId: m.income || m.onlyMe ? "" : m.eventId ?? "", warrantyUntil: m.income ? "" : (m.warrantyUntil ?? "").replace(/\//g, "-"),
  };
  if (t.split.mode === "amount" && Object.values(t.split.amounts ?? {}).reduce((a, b) => a + b, 0) > amount) { toast("相手の分が金額を超えています"); return; }
  if (!m.income && t.payment) { try { localStorage.setItem("lastPayment", t.payment); } catch { /* 覚えられなくてもよい */ } }
  if (m.onlyMe && !m.income) {
    // 自分だけの明細は private に保存し、共有の明細からは消す（Android と同じ）
    const pt = { ...t, paidBy: S.user.uid, split: { mode: "payer" } };
    const ref = m.id ? doc(privCol(), m.id) : doc(privCol());
    task(async () => {
      await setDoc(ref, { ...txToMap(pt), private: true });
      if (m.id && !m.wasOnlyMe) await deleteDoc(doc(col("transactions"), m.id));
    }, () => { S.modal = null; toast("自分だけに見える明細として保存しました"); });
    return;
  }
  if (m.wasOnlyMe) {
    // 自分だけ → 共有に戻す
    task(async () => {
      await setDoc(doc(col("transactions"), m.id), txToMap(t));
      await deleteDoc(doc(privCol(), m.id));
    }, () => { S.modal = null; toast("家族と共有する明細にしました"); });
    return;
  }
  const c = col(m.income ? "incomes" : "transactions");
  // 編集は merge で書き、Android で付けた項目（自動取り込みの元・会社経費の精算済みなど）を消さない
  task(() => (m.id ? setDoc(doc(c, m.id), txToMap(t), { merge: true }) : addDoc(c, txToMap(t))), () => { S.modal = null; toast("保存しました"); });
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
// 429系のエラーを「1日の枠切れ（その日は止める）」と「一時的（1分あたりの上限・混雑）」に分ける
const errText = (e) => String(e?.message ?? e) + " " + String(e?.code ?? "") + " " + JSON.stringify(e?.customData ?? {});
const quotaKind = (e) => {
  const t = errText(e);
  if (!/quota|429|RESOURCE_EXHAUSTED|rate limit|overloaded|503|unavailable/i.test(t)) return "none";
  return /per ?day|requests_per_day/i.test(t) ? "daily" : "transient";
};
const BUSY_MSG = "AIが混み合っているか、Googleの無料枠の一時的な上限に当たりました（回数には数えていません）。1分ほど待ってからもう一度お試しください";
// 一時的なエラーなら15秒待って1回だけやり直す
async function withRetry(fn) {
  try { return await fn(); } catch (e) {
    if (quotaKind(e) !== "transient") throw e;
    await new Promise((r) => setTimeout(r, 15000));
    return fn();
  }
}
// 結果が得られなかった1回分を返す
const refundAi = () => runTransaction(db, async (tx) => {
  const ref = doc(db, "households", S.hid, "meta", "aiUsage");
  const d = (await tx.get(ref)).data();
  if (!d) return;
  tx.set(ref, { ...d, dayCount: Math.max(0, (d.dayCount ?? 0) - 1), monthCount: Math.max(0, (d.monthCount ?? 0) - 1) });
}).catch(() => {});
const markBlocked = () => setDoc(doc(db, "households", S.hid, "meta", "aiUsage"), { blockedDay: C.ymd(today()) }, { merge: true }).catch(() => {});

function emptyReview() {
  return { store: "", branch: "", date: today(), items: [], total: 0, taxMode: "unknown", source: "device" };
}

async function scanReceipt(files) {
  if (!files.length) return;
  const base = { type: "receipt", payment: localStorage.getItem("lastPayment") ?? "", paidBy: S.user.uid, split: { mode: "default" } };
  const manual = (notice) => { S.modal = { ...base, review: emptyReview(), notice, noticeWarn: true }; render(); };
  if (!S.settings.aiEnabled) return manual("AI解析がオフになっているため、品目を手で入力してください。");
  if (!recaptchaSiteKey) return manual("このWeb版はAIの設定がまだのため、品目を手で入力してください。");
  if (!localStorage.getItem("aiConsent")) {
    if (!confirm("レシートの画像をGoogleのAI（Gemini）に送って読み取ります。無料枠の範囲だけで使い、料金はかかりません。よろしいですか？")) return manual("品目を手で入力してください。");
    localStorage.setItem("aiConsent", "1");
  }
  S.modal = { ...base, loading: "画像を準備しています…" }; render();
  let reserved = false;
  try {
    const images = await Promise.all(files.slice(0, 3).map((f) => resize(f)));
    const r = await reserveAi();
    if (r.kind === "blocked") return manual("Googleの無料枠の上限に達しています。今日は手入力でお願いします。");
    if (r.kind === "limit") return manual(`AI解析の${r.daily ? "今日" : "今月"}の上限（${r.daily ? S.settings.aiDailyLimit : S.settings.aiMonthlyLimit}回）に達しました。品目を手で入力してください。`);
    S.modal.loading = "AIでレシートを読み取っています…"; render();
    reserved = true;
    const model = getGenerativeModel(ai, { model: S.settings.aiModel, generationConfig: { responseMimeType: "application/json" } });
    const res = await withRetry(() => model.generateContent([C.aiPrompt(S.cats), ...images.map((data) => ({ inlineData: { data, mimeType: "image/jpeg" } }))]));
    reserved = false;
    const review = C.reviewFromAi(res.response.text(), S.cats, S.rules, S.renames, today());
    const low = r.dayLeft <= S.settings.aiDailyLimit / 5 || r.monthLeft <= S.settings.aiMonthlyLimit / 5;
    // 負担の初期値は、金額がいちばん大きいカテゴリの既定（外食なら半分ずつ など）
    const top = Object.entries(C.categoryTotals(review)).sort((x, y) => y[1] - x[1])[0]?.[0];
    if (top) base.split = C.categorySplit(S.cats.get(top));
    S.modal = { ...base, review, notice: low ? `AIで読み取りました。AI解析は残りわずかです（今日 ${r.dayLeft}回・今月 ${r.monthLeft}回）。` : `AIで読み取りました（今月あと${r.monthLeft}回）。内容を確認して保存してください。`, noticeWarn: low };
    render();
  } catch (e) {
    console.error(e);
    if (reserved) refundAi();
    const k = quotaKind(e);
    if (k === "daily") { markBlocked(); return manual("Googleの無料枠（1日分）の上限に達しました。今日はAIを止めています。品目を手で入力してください。"); }
    if (k === "transient") return manual(BUSY_MSG + "。今回は品目を手で入力するか、閉じてからもう一度撮ってください。");
    manual("AIの読み取りに失敗しました（" + friendly(e) + "）。品目を手で入力してください。");
  }
}

function saveReceipt() {
  const m = S.modal;
  const receiptId = crypto.randomUUID();
  const { txns, receipt, rules } = C.buildSave(m.review, { uid: S.user.uid, name: myName(), receiptId, now: Date.now(), payment: m.payment, paidBy: m.paidBy, split: m.split });
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
  let reserved = false;
  try {
    const r = await reserveAi();
    if (r.kind !== "ok") { toast(r.kind === "blocked" ? "Googleの無料枠の上限に達しています" : "AI解析の上限に達しています"); return; }
    reserved = true;
    const cur = C.aggregate(S.stats.tx.filter(C.everyday), p);
    const prevP = p.shift(-1);
    const prevSnap = (await getDocs(rangeQuery("transactions", prevP.start, prevP.end))).docs.map((d) => txFromDoc(d, false));
    const before = C.aggregate(prevSnap.filter(C.everyday), prevP);
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
    const text = (await withRetry(() => model.generateContent(prompt))).response.text().trim();
    reserved = false;
    await setDoc(doc(db, "households", S.hid, "reviews", C.ym(p.start)), { text, by: myName(), createdAt: Date.now() });
  } catch (e) {
    console.error(e);
    if (reserved) refundAi();
    const k = quotaKind(e);
    if (k === "daily") { markBlocked(); toast("Googleの無料枠（1日分）の上限に達しました"); }
    else if (k === "transient") toast(BUSY_MSG);
    else toast("作成に失敗しました：" + friendly(e));
  } finally { S.reviewBusy = false; render(); }
}

// 画面確認用（URLの末尾に #debug を付けたときだけ）
if (location.hash === "#debug") Object.assign(window, { __S: S, __render: render });

render();
