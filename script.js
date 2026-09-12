/* =========================================================================
   SCTPC Online Examination Portal — Application Logic (ES module)
   Exam-taking works fully offline/local (localStorage). The Admin
   Dashboard and cross-device enforcement additionally use Firestore via
   firebase-sync.js, which degrades gracefully when unavailable.
   ========================================================================= */

import {
  EXAM_DURATION_MINUTES, EXAM_DURATION_MS, STALE_SESSION_MS,
  shuffle, mmss, maskMobile, rowsToCsv,
  buildPreparedQuestions, computeResult, computeDerivedStatus,
  groupCandidatesByCenter, buildMonitoringRows, buildAdminResultsRows,
  sortRows, buildAdminResultsCsv, buildCandidateResultCsvRows,
} from "./exam-logic.js";

import { ADMIN_PASSWORD } from "./firebase-config.js";

import {
  SYNC_ENABLED, HEARTBEAT_INTERVAL_MS,
  fetchStatus, writeLogin, writeStart, writeHeartbeat, writeSubmit,
  subscribeAll, ensureAuth,
} from "./firebase-sync.js";

// ------------------------------------------------------------------
// Configuration
// ------------------------------------------------------------------
const QUESTIONS_PER_EXAM = 35;
const RANDOMIZE_OPTIONS = true; // shuffle option display order per candidate session
const TIMER_WARNING_MS = 5 * 60 * 1000;  // amber under 5 minutes
const TIMER_CRITICAL_MS = 1 * 60 * 1000; // red under 1 minute
const DISPLAY_TIMEZONE = "Asia/Kolkata";
const ADMIN_SESSION_KEY = "sctpc_v1_admin_session";

const LS_PREFIX = "sctpc_v1_";
const LS_ACTIVE_POINTER = LS_PREFIX + "active_candidate";
const sessionKey = (candidateId) => LS_PREFIX + "session_" + candidateId;
const resultKey = (candidateId) => LS_PREFIX + "result_" + candidateId;

// ------------------------------------------------------------------
// Global in-memory state
// ------------------------------------------------------------------
let CANDIDATES = [];
let QUESTION_SETS = {};
let currentCandidate = null;
let session = null;
let timerHandle = null;
let heartbeatHandle = null;

let adminUnsubscribe = null;
let adminStatusMap = {};
let adminTickHandle = null;
let adminSortKey = "submittedAt";
let adminSortDir = "desc";
let adminFilterCenter = "";
let adminFilterStatus = "";
let adminSearchText = "";
let adminActiveTab = "monitoring";

// ------------------------------------------------------------------
// DOM helpers
// ------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
function showScreen(id) {
  document.querySelectorAll(".screen").forEach((el) => el.classList.remove("active"));
  const target = $(id);
  if (target) target.classList.add("active");
}
function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str);
  return div.innerHTML;
}

function fmtDateTime(iso) {
  if (!iso) return "—";
  try {
    const d = typeof iso === "string" ? new Date(iso) : (iso.toDate ? iso.toDate() : new Date(iso));
    return new Intl.DateTimeFormat("en-IN", {
      timeZone: DISPLAY_TIMEZONE, day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: true,
    }).format(d);
  } catch (e) {
    return String(iso);
  }
}

function genSessionId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return "sess-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
}

function persistSession() {
  if (session) localStorage.setItem(sessionKey(session.candidateId), JSON.stringify(session));
}
function setActivePointer(candidateId) { localStorage.setItem(LS_ACTIVE_POINTER, candidateId); }
function clearActivePointer() { localStorage.removeItem(LS_ACTIVE_POINTER); }
function getResult(candidateId) {
  const raw = localStorage.getItem(resultKey(candidateId));
  return raw ? JSON.parse(raw) : null;
}
function getSession(candidateId) {
  const raw = localStorage.getItem(sessionKey(candidateId));
  return raw ? JSON.parse(raw) : null;
}

// ------------------------------------------------------------------
// Bootstrapping
// ------------------------------------------------------------------
async function loadData() {
  try {
    const [candRes, quesRes] = await Promise.all([
      fetch("candidates.json", { cache: "no-store" }),
      fetch("questions.json", { cache: "no-store" }),
    ]);
    if (!candRes.ok) throw new Error("candidates.json failed to load (HTTP " + candRes.status + ")");
    if (!quesRes.ok) throw new Error("questions.json failed to load (HTTP " + quesRes.status + ")");

    const candData = await candRes.json();
    const quesData = await quesRes.json();

    if (!candData || !Array.isArray(candData.candidates)) throw new Error("candidates.json is missing a valid 'candidates' array.");
    if (!quesData || !quesData.sets || typeof quesData.sets !== "object") throw new Error("questions.json is missing a valid 'sets' object.");

    CANDIDATES = candData.candidates;
    QUESTION_SETS = { ...quesData.sets };

    // "aliases" lets a set name reuse another set's questions verbatim (e.g.
    // an afternoon session repeating the same 5 papers under new set labels,
    // "Set 6" = "Set 1", etc.) without duplicating question data. Resolved
    // once here so every other lookup of QUESTION_SETS[candidate.set] below
    // just works, whether that set is real or an alias.
    const aliases = quesData.aliases && typeof quesData.aliases === "object" ? quesData.aliases : {};
    Object.keys(aliases).forEach((aliasName) => {
      const targetName = aliases[aliasName];
      if (quesData.sets[aliasName]) {
        // A real "sets" entry for this name already exists -- it wins over
        // the alias rather than being silently overwritten by it.
        return;
      }
      if (QUESTION_SETS[targetName]) {
        QUESTION_SETS[aliasName] = QUESTION_SETS[targetName];
      } else {
        console.warn(`Warning: alias "${aliasName}" points to "${targetName}", which does not exist in questions.json.`);
      }
    });

    Object.keys(QUESTION_SETS).forEach((setName) => {
      const qs = QUESTION_SETS[setName];
      if (!Array.isArray(qs) || qs.length !== QUESTIONS_PER_EXAM) {
        console.warn(`Warning: ${setName} does not contain exactly ${QUESTIONS_PER_EXAM} questions.`);
      }
    });
    return true;
  } catch (err) {
    console.error(err);
    showFatal("The application could not load candidates.json or questions.json. Details: " + err.message);
    return false;
  }
}

function showFatal(message) {
  setText("fatalMessage", message);
  showScreen("screen-fatal");
}

// ------------------------------------------------------------------
// Top bar
// ------------------------------------------------------------------
function renderTopbar(mode) {
  const right = $("topbarRight");
  right.innerHTML = "";
  if (mode === "candidate" && currentCandidate) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = `${currentCandidate.name} • ${currentCandidate.center} • ${currentCandidate.set}`;
    right.appendChild(chip);
  }
  if (mode === "logout-available" || mode === "admin") {
    const btn = document.createElement("button");
    btn.className = "btn-logout";
    btn.textContent = "Logout";
    btn.onclick = mode === "admin" ? adminLogout : doLogout;
    right.appendChild(btn);
  }
  if (mode !== "admin") {
    const link = document.createElement("a");
    link.href = "#admin";
    link.className = "admin-link";
    link.textContent = "Admin";
    link.onclick = (e) => { e.preventDefault(); enterAdminLogin(); };
    right.appendChild(link);
  }
}

function doLogout() {
  clearActivePointer();
  currentCandidate = null;
  session = null;
  stopTimer();
  stopHeartbeat();
  resetLoginForm();
  renderTopbar("none");
  showScreen("screen-login");
}

function resetLoginForm() {
  $("loginForm").reset();
  hideAlert("loginAlert");
  hideAlert("loginInfo");
}
function showAlert(id, message) {
  const el = $(id);
  el.textContent = message;
  el.classList.remove("hidden");
}
function hideAlert(id) {
  const el = $(id);
  el.classList.add("hidden");
  el.textContent = "";
}

// ------------------------------------------------------------------
// Login flow
// ------------------------------------------------------------------
function initLoginForm() {
  $("loginForm").addEventListener("submit", handleLoginSubmit);
  $("pwToggle").addEventListener("click", () => {
    const input = $("passwordInput");
    const isPw = input.type === "password";
    input.type = isPw ? "text" : "password";
    $("pwToggle").textContent = isPw ? "\u{1F576}" : "\u{1F441}";
  });
  $("mobileInput").addEventListener("input", (e) => {
    e.target.value = e.target.value.replace(/\D/g, "").slice(0, 10);
  });
}

async function handleLoginSubmit(e) {
  e.preventDefault();
  hideAlert("loginAlert");
  hideAlert("loginInfo");

  const mobile = $("mobileInput").value.trim();
  const password = $("passwordInput").value;

  if (mobile.length !== 10) { showAlert("loginAlert", "Please enter a valid 10-digit mobile number."); return; }
  if (!password) { showAlert("loginAlert", "Please enter your password."); return; }

  const candidate = CANDIDATES.find((c) => String(c.mobile) === mobile && String(c.password) === password);
  if (!candidate) {
    showAlert("loginAlert", "Invalid mobile number or password. Please check your credentials and try again.");
    return;
  }

  // Local (this-device) already-submitted check — always enforced regardless of sync.
  const localResult = getResult(candidate.candidateId);
  if (localResult) {
    showAlert("loginAlert",
      `You have already completed and submitted this examination on ${fmtDateTime(localResult.submittedAt)} ` +
      `(Score: ${localResult.correct}/${localResult.total}). Multiple attempts are not permitted.`);
    return;
  }

  // Another candidate's exam currently active on THIS device/browser.
  const activePointer = localStorage.getItem(LS_ACTIVE_POINTER);
  if (activePointer && activePointer !== candidate.candidateId) {
    const otherSession = getSession(activePointer);
    if (otherSession && otherSession.status === "in-progress" && Date.now() < otherSession.endAt) {
      showAlert("loginAlert",
        "Another candidate's examination is currently in progress on this device. " +
        "Please use a different device, or ask the examination coordinator to clear this station.");
      return;
    }
  }

  // Time-slot enforcement.
  const now = Date.now();
  const start = new Date(candidate.batchStart).getTime();
  const end = new Date(candidate.batchEnd).getTime();
  if (isNaN(start) || isNaN(end)) {
    showAlert("loginAlert", "Your batch time slot is not configured correctly. Please contact the examination coordinator.");
    return;
  }
  if (now < start) {
    showInfoInstead(`Your examination has not started yet. Your allotted slot is ${fmtDateTime(candidate.batchStart)} to ${fmtDateTime(candidate.batchEnd)} (IST). Please return and login during that window.`);
    return;
  }
  if (now > end) {
    showAlert("loginAlert", `Your allotted time slot (${fmtDateTime(candidate.batchStart)} to ${fmtDateTime(candidate.batchEnd)} IST) has ended. Login is no longer permitted for this slot. Please contact the examination coordinator.`);
    return;
  }

  // Cross-device check via Firestore (best-effort; skipped entirely if sync unavailable).
  $("loginBtn").disabled = true;
  $("loginBtn").textContent = "Checking…";
  const remote = await fetchStatus(candidate.candidateId, 6000);
  $("loginBtn").disabled = false;
  $("loginBtn").textContent = "Login to Exam Portal";

  if (remote.available && remote.doc) {
    const doc = remote.doc;
    if (doc.status === "submitted") {
      showAlert("loginAlert",
        `Our records show this examination was already submitted on ${fmtDateTime(doc.submittedAt)}` +
        (typeof doc.correct === "number" ? ` (Score: ${doc.correct}/${doc.total}).` : ".") +
        " Multiple attempts are not permitted.");
      return;
    }
    if (doc.status === "in-progress" || doc.status === "logged-in") {
      const lastSeenMs = toMillisLoose(doc.lastHeartbeat) || toMillisLoose(doc.loginAt) || 0;
      const stale = Date.now() - lastSeenMs > STALE_SESSION_MS;
      if (!stale) {
        showAlert("loginAlert",
          "This candidate is already logged in and has an active session on another device. " +
          "If that session has genuinely ended (e.g. a crash), please wait a few minutes and try again, " +
          "or contact the examination coordinator.");
        return;
      }
      // stale -> fall through and allow a fresh login, which will overwrite the abandoned session.
    }
  }

  // Success — create/resume session.
  currentCandidate = candidate;
  let existingSession = getSession(candidate.candidateId);
  if (!existingSession) {
    existingSession = buildNewSession(candidate);
  }
  session = existingSession;
  setActivePointer(candidate.candidateId);
  persistSession();

  writeLogin(candidate, session.sessionId); // fire-and-forget, best-effort

  resetLoginForm();
  enterAppForCandidate();
}

function toMillisLoose(v) {
  if (!v) return null;
  if (typeof v === "string") { const t = new Date(v).getTime(); return isNaN(t) ? null : t; }
  if (typeof v.toMillis === "function") return v.toMillis();
  if (typeof v.seconds === "number") return v.seconds * 1000;
  return null;
}

function showInfoInstead(message) { showAlert("loginInfo", message); }

function buildNewSession(candidate) {
  const rawQuestions = QUESTION_SETS[candidate.set] || [];
  const preparedQuestions = buildPreparedQuestions(rawQuestions, RANDOMIZE_OPTIONS);
  return {
    candidateId: candidate.candidateId,
    name: candidate.name,
    mobile: candidate.mobile,
    set: candidate.set,
    center: candidate.center,
    sessionId: genSessionId(),
    status: "instructions",
    instructionsAccepted: false,
    startedAt: null,
    endAt: null,
    currentIndex: 0,
    answers: {},
    flagged: {},
    questions: preparedQuestions,
  };
}

function enterAppForCandidate() {
  if (!session) return;
  if (session.status === "in-progress") {
    const remaining = session.endAt - Date.now();
    if (remaining <= 0) { finalizeExam("timeout"); return; }
    renderTopbar("candidate");
    enterExamScreen();
    return;
  }
  renderTopbar("candidate");
  enterInstructionsScreen();
}

// ------------------------------------------------------------------
// Instructions screen
// ------------------------------------------------------------------
function enterInstructionsScreen() {
  setText("instrCandidateLine", `Candidate: ${currentCandidate.name} · Mobile: ${maskMobile(currentCandidate.mobile)} · Center: ${currentCandidate.center} · Paper Set: ${currentCandidate.set}`);
  $("agreeCheckbox").checked = false;
  $("startExamBtn").disabled = true;
  showScreen("screen-instructions");
}

function initInstructionsScreen() {
  $("agreeCheckbox").addEventListener("change", (e) => { $("startExamBtn").disabled = !e.target.checked; });
  $("logoutFromInstr").addEventListener("click", () => {
    if (session) localStorage.removeItem(sessionKey(session.candidateId));
    doLogout();
  });
  $("startExamBtn").addEventListener("click", () => {
    if (!session) return;
    session.status = "in-progress";
    session.instructionsAccepted = true;
    session.startedAt = Date.now();
    session.endAt = session.startedAt + EXAM_DURATION_MS;
    persistSession();
    writeStart(session.candidateId);
    enterExamScreen();
  });
}

// ------------------------------------------------------------------
// Exam screen
// ------------------------------------------------------------------
function enterExamScreen() {
  showScreen("screen-exam");
  renderCandidateMini();
  renderPalette();
  renderQuestion();
  updateSidebarStats();
  startTimer();
  startHeartbeat();
  window.addEventListener("beforeunload", beforeUnloadHandler);
}

function beforeUnloadHandler(e) {
  if (session && session.status === "in-progress") { e.preventDefault(); e.returnValue = ""; }
}

function renderCandidateMini() {
  $("candidateMini").innerHTML =
    `<strong>${escapeHtml(currentCandidate.name)}</strong>` +
    `Center: ${escapeHtml(currentCandidate.center)}<br>` +
    `Paper: ${escapeHtml(currentCandidate.set)}<br>` +
    `Mobile: ${maskMobile(currentCandidate.mobile)}`;
}

function renderQuestion() {
  const idx = session.currentIndex;
  const q = session.questions[idx];
  setText("qIndexLabel", `Question ${idx + 1} of ${session.questions.length}`);
  setText("qTextLabel", q.text);

  const container = $("qOptionsContainer");
  container.innerHTML = "";
  const letters = ["A", "B", "C", "D"];
  q.options.forEach((optText, optIdx) => {
    const selected = session.answers[q.id] === optIdx;
    const row = document.createElement("div");
    row.className = "q-option" + (selected ? " selected" : "");
    row.setAttribute("role", "button");
    row.setAttribute("tabindex", "0");
    row.innerHTML = `<span class="q-option-letter">${letters[optIdx]}</span><span class="q-option-text">${escapeHtml(optText)}</span>`;
    row.addEventListener("click", () => selectOption(optIdx));
    row.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); selectOption(optIdx); } });
    container.appendChild(row);
  });

  const flagBtn = $("flagBtn");
  const isFlagged = !!session.flagged[q.id];
  flagBtn.classList.toggle("is-flagged", isFlagged);
  flagBtn.innerHTML = isFlagged ? "★ Flagged for Review" : "☆ Flag for Review";

  $("prevBtn").disabled = idx === 0;
  $("nextBtn").disabled = idx === session.questions.length - 1;
}

function selectOption(optIdx) {
  const q = session.questions[session.currentIndex];
  session.answers[q.id] = optIdx;
  persistSession();
  renderQuestion();
  renderPalette();
  updateSidebarStats();
}

function initExamScreen() {
  $("prevBtn").addEventListener("click", () => {
    if (session.currentIndex > 0) { session.currentIndex--; persistSession(); renderQuestion(); renderPalette(); }
  });
  $("nextBtn").addEventListener("click", () => {
    if (session.currentIndex < session.questions.length - 1) { session.currentIndex++; persistSession(); renderQuestion(); renderPalette(); }
  });
  $("clearBtn").addEventListener("click", () => {
    const q = session.questions[session.currentIndex];
    delete session.answers[q.id];
    persistSession(); renderQuestion(); renderPalette(); updateSidebarStats();
  });
  $("flagBtn").addEventListener("click", () => {
    const q = session.questions[session.currentIndex];
    if (session.flagged[q.id]) delete session.flagged[q.id]; else session.flagged[q.id] = true;
    persistSession(); renderQuestion(); renderPalette(); updateSidebarStats();
  });
  $("submitBtn").addEventListener("click", () => {
    const total = session.questions.length;
    const answered = Object.keys(session.answers).length;
    const unanswered = total - answered;
    const msg = unanswered > 0
      ? `You have ${unanswered} unanswered question${unanswered > 1 ? "s" : ""} out of ${total}. Once submitted, you cannot make further changes. Do you want to submit now?`
      : `You have answered all ${total} questions. Once submitted, you cannot make further changes. Submit now?`;
    openConfirmModal("Submit Examination?", msg, () => finalizeExam("manual"));
  });
}

function renderPalette() {
  const palette = $("palette");
  palette.innerHTML = "";
  session.questions.forEach((q, idx) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "palette-item";
    const answered = session.answers.hasOwnProperty(q.id);
    const flagged = !!session.flagged[q.id];
    if (answered) btn.classList.add("answered");
    if (flagged) btn.classList.add("flagged");
    if (idx === session.currentIndex) btn.classList.add("current");
    btn.textContent = String(idx + 1);
    btn.title = `Question ${idx + 1}`;
    btn.addEventListener("click", () => { session.currentIndex = idx; persistSession(); renderQuestion(); renderPalette(); });
    palette.appendChild(btn);
  });
}

function updateSidebarStats() {
  const total = session.questions.length;
  const answered = Object.keys(session.answers).length;
  const flagged = Object.keys(session.flagged).length;
  const unanswered = total - answered;
  $("sidebarStats").innerHTML =
    `<div><span>Answered</span><strong>${answered}</strong></div>` +
    `<div><span>Unanswered</span><strong>${unanswered}</strong></div>` +
    `<div><span>Flagged</span><strong>${flagged}</strong></div>`;
}

// ------------------------------------------------------------------
// Timer & heartbeat sync
// ------------------------------------------------------------------
function startTimer() { stopTimer(); tickTimer(); timerHandle = setInterval(tickTimer, 1000); }
function stopTimer() { if (timerHandle) { clearInterval(timerHandle); timerHandle = null; } }
function tickTimer() {
  if (!session || session.status !== "in-progress") { stopTimer(); return; }
  const remaining = session.endAt - Date.now();
  const box = $("timerBox");
  box.classList.remove("timer-warning", "timer-critical");
  if (remaining <= TIMER_CRITICAL_MS) box.classList.add("timer-critical");
  else if (remaining <= TIMER_WARNING_MS) box.classList.add("timer-warning");
  setText("timerClock", mmss(remaining));
  if (remaining <= 0) finalizeExam("timeout");
}

function startHeartbeat() {
  stopHeartbeat();
  const beat = () => {
    if (!session || session.status !== "in-progress") return;
    writeHeartbeat(session.candidateId, { answered: Object.keys(session.answers).length, total: session.questions.length });
  };
  beat();
  heartbeatHandle = setInterval(beat, HEARTBEAT_INTERVAL_MS);
}
function stopHeartbeat() { if (heartbeatHandle) { clearInterval(heartbeatHandle); heartbeatHandle = null; } }

// ------------------------------------------------------------------
// Confirm modal
// ------------------------------------------------------------------
let confirmCallback = null;
function openConfirmModal(title, message, onConfirm) {
  setText("confirmTitle", title);
  setText("confirmMessage", message);
  confirmCallback = onConfirm;
  $("confirmModal").classList.remove("hidden");
}
function closeConfirmModal() { $("confirmModal").classList.add("hidden"); confirmCallback = null; }
function initConfirmModal() {
  $("confirmCancel").addEventListener("click", closeConfirmModal);
  $("confirmOk").addEventListener("click", () => { const cb = confirmCallback; closeConfirmModal(); if (cb) cb(); });
}

// ------------------------------------------------------------------
// Finalize / scoring
// ------------------------------------------------------------------
function finalizeExam(reason) {
  if (!session || session.status === "submitted") return;
  stopTimer();
  stopHeartbeat();
  window.removeEventListener("beforeunload", beforeUnloadHandler);

  const result = computeResult(session, {
    candidateId: session.candidateId,
    name: session.name,
    mobile: session.mobile,
    set: session.set,
    center: session.center,
    submittedAt: new Date().toISOString(),
    submitReason: reason,
  });

  localStorage.setItem(resultKey(session.candidateId), JSON.stringify(result));
  localStorage.removeItem(sessionKey(session.candidateId));
  clearActivePointer();

  retryWriteSubmit(session.candidateId, result);

  session.status = "submitted";
  session = null;

  renderResultScreen(result);
  renderTopbar("logout-available");
}

async function retryWriteSubmit(candidateId, result, attempt = 1) {
  const ok = await writeSubmit(candidateId, result);
  if (!ok && attempt < 4) {
    setTimeout(() => retryWriteSubmit(candidateId, result, attempt + 1), attempt * 3000);
  }
}

// ------------------------------------------------------------------
// Result screen
// ------------------------------------------------------------------
function renderResultScreen(result) {
  setText("resultCandidateLine", `${result.name} · ${maskMobile(result.mobile)} · ${result.center} · ${result.set}`);
  setText("submitReasonLine", result.submitReason === "timeout"
    ? `Auto-submitted automatically when the timer reached zero, on ${fmtDateTime(result.submittedAt)}.`
    : `Submitted manually on ${fmtDateTime(result.submittedAt)}.`);

  setText("scoreHeroNum", String(result.correct));
  setText("scoreHeroTotal", String(result.total));
  setText("scorePercent", result.scorePercent + "%");
  setText("resTotal", String(result.total));
  setText("resAnswered", String(result.answered));
  setText("resCorrect", String(result.correct));
  setText("resIncorrect", String(result.incorrect));
  setText("resUnanswered", String(result.unanswered));

  $("downloadJsonBtn").onclick = () => downloadResultJson(result);
  $("downloadCsvBtn").onclick = () => downloadResultCsv(result);
  showScreen("screen-result");
}

function downloadResultJson(result) {
  const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
  triggerDownload(blob, `SCTPC_Result_${result.candidateId}.json`);
}
function downloadResultCsv(result) {
  const rows = buildCandidateResultCsvRows(result, fmtDateTime);
  const blob = new Blob([rowsToCsv(rows)], { type: "text/csv;charset=utf-8;" });
  triggerDownload(blob, `SCTPC_Result_${result.candidateId}.csv`);
}
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ------------------------------------------------------------------
// Resume-on-refresh
// ------------------------------------------------------------------
function tryResumeSession() {
  const pointer = localStorage.getItem(LS_ACTIVE_POINTER);
  if (!pointer) return false;
  const candidate = CANDIDATES.find((c) => c.candidateId === pointer);
  if (!candidate) { clearActivePointer(); return false; }
  if (getResult(pointer)) { clearActivePointer(); return false; }
  const existingSession = getSession(pointer);
  if (!existingSession) { clearActivePointer(); return false; }
  currentCandidate = candidate;
  session = existingSession;
  enterAppForCandidate();
  return true;
}

// =========================================================================
// ADMIN DASHBOARD
// =========================================================================

function enterAdminLogin() {
  stopTimer(); stopHeartbeat();
  hideAlert("adminLoginAlert");
  if (sessionStorage.getItem(ADMIN_SESSION_KEY) === "1") {
    enterAdminDashboard();
    return;
  }
  showScreen("screen-admin-login");
}

function initAdminLogin() {
  $("adminLoginForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const pw = $("adminPasswordInput").value;
    if (pw === ADMIN_PASSWORD) {
      sessionStorage.setItem(ADMIN_SESSION_KEY, "1");
      $("adminPasswordInput").value = "";
      enterAdminDashboard();
    } else {
      showAlert("adminLoginAlert", "Incorrect admin key.");
    }
  });
  $("adminBackToLogin").addEventListener("click", () => { showScreen("screen-login"); renderTopbar("none"); });
}

function adminLogout() {
  sessionStorage.removeItem(ADMIN_SESSION_KEY);
  if (adminUnsubscribe) { adminUnsubscribe(); adminUnsubscribe = null; }
  stopAdminTicker();
  showScreen("screen-login");
  renderTopbar("none");
}

async function enterAdminDashboard() {
  showScreen("screen-admin-dashboard");
  renderTopbar("admin");
  setText("adminCandidateCount", String(CANDIDATES.length));

  if (!SYNC_ENABLED) {
    $("adminSyncNotice").classList.remove("hidden");
    $("adminSyncNotice").textContent = "Live sync is not configured yet (firebase-config.js still has placeholder values). Fill it in to enable the real-time dashboard — see README.md.";
    renderAdminAll();
    return;
  }

  await ensureAuth();
  if (adminUnsubscribe) adminUnsubscribe();
  adminUnsubscribe = subscribeAll(
    (map) => {
      adminStatusMap = map;
      $("adminSyncNotice").classList.add("hidden");
      renderAdminAll();
    },
    (err) => {
      $("adminSyncNotice").classList.remove("hidden");
      $("adminSyncNotice").textContent = "Live sync is currently unreachable (" + (err && err.message ? err.message : "unknown error") + "). Showing the last known data, if any.";
      renderAdminAll();
    }
  );
  startAdminTicker();
}

function startAdminTicker() {
  stopAdminTicker();
  adminTickHandle = setInterval(renderAdminAll, 5000);
}
function stopAdminTicker() { if (adminTickHandle) { clearInterval(adminTickHandle); adminTickHandle = null; } }

function initAdminDashboard() {
  $("adminTabMonitoring").addEventListener("click", () => { adminActiveTab = "monitoring"; renderAdminAll(); });
  $("adminTabResults").addEventListener("click", () => { adminActiveTab = "results"; renderAdminAll(); });

  $("adminCenterFilter").addEventListener("change", (e) => { adminFilterCenter = e.target.value; renderAdminAll(); });
  $("adminStatusFilter").addEventListener("change", (e) => { adminFilterStatus = e.target.value; renderAdminAll(); });
  $("adminSearchInput").addEventListener("input", (e) => { adminSearchText = e.target.value.trim().toLowerCase(); renderAdminAll(); });

  $("adminExportCsvBtn").addEventListener("click", () => {
    const rows = buildAdminResultsRows(CANDIDATES, adminStatusMap);
    const sorted = sortRows(rows, adminSortKey, adminSortDir);
    const csv = buildAdminResultsCsv(sorted);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    triggerDownload(blob, `SCTPC_All_Results_${new Date().toISOString().slice(0, 10)}.csv`);
  });

  document.querySelectorAll("#resultsTable thead th[data-sort-key]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.getAttribute("data-sort-key");
      if (adminSortKey === key) adminSortDir = adminSortDir === "asc" ? "desc" : "asc";
      else { adminSortKey = key; adminSortDir = "asc"; }
      renderAdminAll();
    });
  });
}

function renderAdminAll() {
  if (!$("screen-admin-dashboard").classList.contains("active")) return;
  const now = Date.now();

  $("adminTabMonitoring").classList.toggle("tab-active", adminActiveTab === "monitoring");
  $("adminTabResults").classList.toggle("tab-active", adminActiveTab === "results");
  $("adminPanelMonitoring").classList.toggle("hidden", adminActiveTab !== "monitoring");
  $("adminPanelResults").classList.toggle("hidden", adminActiveTab !== "results");

  populateCenterFilterOptions();

  const grouped = groupCandidatesByCenter(CANDIDATES, adminStatusMap, now);
  renderAdminStatCards(grouped.overall);
  renderAdminCenterBreakdown(grouped.centers);

  let rows = buildMonitoringRows(CANDIDATES, adminStatusMap, now);
  if (adminFilterCenter) rows = rows.filter((r) => r.center === adminFilterCenter);
  if (adminFilterStatus) rows = rows.filter((r) => r.derived.code === adminFilterStatus);
  if (adminSearchText) rows = rows.filter((r) => r.name.toLowerCase().includes(adminSearchText) || String(r.mobile).includes(adminSearchText) || r.candidateId.toLowerCase().includes(adminSearchText));
  renderMonitoringTable(rows);

  const resultRows = sortRows(buildAdminResultsRows(CANDIDATES, adminStatusMap), adminSortKey, adminSortDir);
  renderResultsTable(resultRows);
}

function populateCenterFilterOptions() {
  const sel = $("adminCenterFilter");
  if (sel.dataset.populated === "1") return;
  const centers = Array.from(new Set(CANDIDATES.map((c) => c.center))).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  centers.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c; opt.textContent = c;
    sel.appendChild(opt);
  });
  sel.dataset.populated = "1";
}

const STATUS_LABELS = {
  "not-logged-in": "Not Logged In",
  "logged-in": "Logged In",
  "in-progress": "Exam In Progress",
  "submitted": "Submitted Successfully",
  "time-expired": "Time Expired",
};
const STATUS_BADGE_CLASS = {
  "not-logged-in": "badge-gray",
  "logged-in": "badge-blue",
  "in-progress": "badge-amber",
  "submitted": "badge-green",
  "time-expired": "badge-red",
};

function renderAdminStatCards(overall) {
  const box = $("adminStatCards");
  const order = ["not-logged-in", "logged-in", "in-progress", "submitted", "time-expired"];
  box.innerHTML = order.map((code) => `
    <div class="stat-card ${STATUS_BADGE_CLASS[code]}">
      <div class="stat-num">${overall.counts[code]}</div>
      <div class="stat-label">${STATUS_LABELS[code]}</div>
    </div>
  `).join("") + `
    <div class="stat-card badge-navy">
      <div class="stat-num">${overall.completionRate}%</div>
      <div class="stat-label">Completion Rate</div>
    </div>
  `;
}

function renderAdminCenterBreakdown(centers) {
  const box = $("adminCenterBreakdown");
  box.innerHTML = centers.map((c) => `
    <div class="exam-center-card">
      <div class="exam-center-card-title">${escapeHtml(c.center)}</div>
      <div class="exam-center-card-total">${c.total} candidates</div>
      <div class="exam-center-card-bars">
        <span class="mini-badge badge-gray">${c.counts["not-logged-in"]} not in</span>
        <span class="mini-badge badge-blue">${c.counts["logged-in"]} logged in</span>
        <span class="mini-badge badge-amber">${c.counts["in-progress"]} active</span>
        <span class="mini-badge badge-green">${c.counts["submitted"]} done</span>
        <span class="mini-badge badge-red">${c.counts["time-expired"]} expired</span>
      </div>
      <div class="exam-center-card-rate">${c.completionRate}% completed</div>
    </div>
  `).join("");
}

function renderMonitoringTable(rows) {
  const tbody = $("monitoringTableBody");
  setText("monitoringCount", `${rows.length} candidate${rows.length === 1 ? "" : "s"}`);
  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-row">No candidates match the current filters.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((r) => `
    <tr>
      <td>${escapeHtml(r.candidateId)}</td>
      <td>${escapeHtml(r.name)}</td>
      <td>${maskMobile(r.mobile)}</td>
      <td>${escapeHtml(r.center)}</td>
      <td>${escapeHtml(r.set)}</td>
      <td><span class="badge ${STATUS_BADGE_CLASS[r.derived.code]}">${STATUS_LABELS[r.derived.code]}</span></td>
      <td class="detail-cell">${escapeHtml(r.derived.detail || "—")}</td>
    </tr>
  `).join("");
}

function renderResultsTable(rows) {
  const tbody = $("resultsTableBody");
  setText("resultsCount", `${rows.length} submitted`);
  document.querySelectorAll("#resultsTable thead th[data-sort-key]").forEach((th) => {
    const key = th.getAttribute("data-sort-key");
    th.classList.toggle("sorted-asc", adminSortKey === key && adminSortDir === "asc");
    th.classList.toggle("sorted-desc", adminSortKey === key && adminSortDir === "desc");
  });
  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty-row">No submissions yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((r) => `
    <tr>
      <td>${escapeHtml(r.candidateId)}</td>
      <td>${escapeHtml(r.name)}</td>
      <td>${maskMobile(r.mobile)}</td>
      <td>${escapeHtml(r.center)}</td>
      <td>${escapeHtml(r.set)}</td>
      <td>${fmtDateTime(r.submittedAt)}</td>
      <td>${r.correct} / ${r.total}</td>
      <td>${r.scorePercent}%</td>
      <td>${r.submitReason === "timeout" ? "Auto (timeout)" : "Manual"}</td>
    </tr>
  `).join("");
}

// ------------------------------------------------------------------
// Init
// ------------------------------------------------------------------
async function init() {
  setText("yearSpan", String(new Date().getFullYear()));
  initLoginForm();
  initInstructionsScreen();
  initExamScreen();
  initConfirmModal();
  initAdminLogin();
  initAdminDashboard();

  const ok = await loadData();
  if (!ok) return;

  if (window.location.hash === "#admin") {
    renderTopbar("none");
    enterAdminLogin();
    return;
  }

  const resumed = tryResumeSession();
  if (!resumed) {
    renderTopbar("none");
    showScreen("screen-login");
  }
}

document.addEventListener("DOMContentLoaded", init);

// Lets a bookmarked/typed "#admin" URL open the admin login even without a
// full page reload (e.g. typed into the address bar while already on the page).
window.addEventListener("hashchange", () => {
  if (window.location.hash === "#admin" && CANDIDATES.length > 0) {
    renderTopbar("none");
    enterAdminLogin();
  }
});