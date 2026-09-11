// =========================================================================
// exam-logic.js
//
// Pure, side-effect-free logic for the SCTPC Online Examination Portal:
// scoring, session/question preparation, derived live-status computation
// for the admin dashboard, and CSV building. Nothing in this file touches
// the DOM, localStorage, or Firebase -- that keeps it independently
// testable (see test/*.mjs) and easy to reason about.
// =========================================================================

export const EXAM_DURATION_MINUTES = 30;
export const EXAM_DURATION_MS = EXAM_DURATION_MINUTES * 60 * 1000;
export const STALE_SESSION_MS = 3 * 60 * 1000; // must match firestore.rules staleSession()
export const TIME_EXPIRED_GRACE_MS = 2 * 60 * 1000; // extra grace after exam end before flagging incomplete

// ------------------------------------------------------------------
// Randomization / formatting helpers
// ------------------------------------------------------------------
export function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function mmss(ms) {
  if (ms < 0) ms = 0;
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

export function maskMobile(mobile) {
  const s = String(mobile);
  if (s.length < 4) return s;
  return "XXXXXX" + s.slice(-4);
}

export function csvEscape(val) {
  const s = String(val === undefined || val === null ? "" : val);
  if (/[",\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export function rowsToCsv(rows) {
  return rows.map((r) => r.map(csvEscape).join(",")).join("\r\n");
}

// ------------------------------------------------------------------
// Session / question preparation
// ------------------------------------------------------------------

/**
 * Builds the per-candidate prepared question list for a session: applies
 * option-order randomization (if enabled) and records the correct display
 * index for scoring, independent of the JSON's authored option order.
 */
export function buildPreparedQuestions(rawQuestions, randomizeOptions, rng = Math.random) {
  return rawQuestions.map((q) => {
    const originalIndices = [0, 1, 2, 3];
    const order = randomizeOptions ? shuffle(originalIndices, rng) : originalIndices;
    const displayOptions = order.map((origIdx) => q.options[origIdx]);
    const correctDisplayIndex = order.indexOf(q.answer);
    return {
      id: q.id,
      category: q.category,
      text: q.text,
      options: displayOptions,
      correctIndex: correctDisplayIndex,
    };
  });
}

// ------------------------------------------------------------------
// Scoring
// ------------------------------------------------------------------

/**
 * Computes the full scored result for a completed/timed-out session.
 * `session` = { questions: [{id,category,text,options,correctIndex}], answers: {id: selectedIndex} }
 * `meta` = { candidateId, name, mobile, set, center, submittedAt (ISO string), submitReason }
 */
export function computeResult(session, meta) {
  const perQuestion = session.questions.map((q) => {
    const selected = session.answers.hasOwnProperty(q.id) ? session.answers[q.id] : null;
    const isCorrect = selected !== null && selected === q.correctIndex;
    return {
      id: q.id,
      category: q.category,
      question: q.text,
      options: q.options,
      selectedIndex: selected,
      selectedText: selected !== null ? q.options[selected] : null,
      correctIndex: q.correctIndex,
      correctText: q.options[q.correctIndex],
      isCorrect,
    };
  });

  const total = perQuestion.length;
  const answered = perQuestion.filter((p) => p.selectedIndex !== null).length;
  const correct = perQuestion.filter((p) => p.isCorrect).length;
  const incorrect = answered - correct;
  const unanswered = total - answered;

  const categories = {};
  perQuestion.forEach((p) => {
    if (!categories[p.category]) categories[p.category] = { total: 0, correct: 0 };
    categories[p.category].total++;
    if (p.isCorrect) categories[p.category].correct++;
  });

  return {
    candidateId: meta.candidateId,
    name: meta.name,
    mobile: meta.mobile,
    set: meta.set,
    center: meta.center,
    submittedAt: meta.submittedAt,
    submitReason: meta.submitReason,
    total,
    answered,
    correct,
    incorrect,
    unanswered,
    scorePercent: total > 0 ? Math.round((correct / total) * 1000) / 10 : 0,
    categories,
    perQuestion,
  };
}

// ------------------------------------------------------------------
// Derived live status (for the admin dashboard)
// ------------------------------------------------------------------
// Underlying stored states are only ever: 'logged-in' -> 'in-progress' -> 'submitted'.
// This function derives a richer, real-time-accurate display status by also
// comparing against the current time and the candidate's batch window, so
// the dashboard can surface "Time Expired" (no-show or incomplete) even if
// a candidate's device never got a chance to report its own final state.

export function computeDerivedStatus(candidate, statusDoc, nowMs) {
  const batchEndMs = new Date(candidate.batchEnd).getTime();

  if (!statusDoc) {
    if (!isNaN(batchEndMs) && nowMs > batchEndMs) {
      return { code: "time-expired", variant: "no-show", label: "Time Expired", detail: "Did not log in during the allotted slot" };
    }
    return { code: "not-logged-in", variant: null, label: "Not Logged In", detail: null };
  }

  if (statusDoc.status === "submitted") {
    const reasonLabel = statusDoc.submitReason === "timeout" ? "Auto-submitted (timer expired)" : "Submitted manually";
    return {
      code: "submitted",
      variant: statusDoc.submitReason || "manual",
      label: "Submitted Successfully",
      detail: reasonLabel,
      score: {
        correct: statusDoc.correct,
        total: statusDoc.total,
        scorePercent: statusDoc.scorePercent,
      },
    };
  }

  const lastSeenMs = toMillis(statusDoc.lastHeartbeat) || toMillis(statusDoc.loginAt) || nowMs;
  const staleness = nowMs - lastSeenMs;

  if (statusDoc.status === "in-progress") {
    const startedAtMs = toMillis(statusDoc.startedAt);
    const examEndMs = startedAtMs ? startedAtMs + EXAM_DURATION_MS : null;
    const pastGrace = examEndMs !== null && nowMs > examEndMs + TIME_EXPIRED_GRACE_MS;
    if (staleness > STALE_SESSION_MS || pastGrace) {
      return {
        code: "time-expired",
        variant: "incomplete",
        label: "Time Expired",
        detail: "Exam time elapsed without a recorded submission (connection likely lost)",
      };
    }
    return {
      code: "in-progress",
      variant: null,
      label: "Exam In Progress",
      detail: typeof statusDoc.answered === "number" ? `${statusDoc.answered}/${statusDoc.total || 30} answered` : null,
    };
  }

  // status === 'logged-in' (on instructions screen, exam not started yet)
  if (staleness > STALE_SESSION_MS && !isNaN(batchEndMs) && nowMs > batchEndMs) {
    return { code: "time-expired", variant: "no-show", label: "Time Expired", detail: "Logged in but never started the exam" };
  }
  return { code: "logged-in", variant: null, label: "Logged In", detail: "Reading instructions" };
}

function toMillis(isoOrTimestamp) {
  if (!isoOrTimestamp) return null;
  // Supports plain ISO strings and Firestore Timestamp-like objects ({seconds, nanoseconds} or .toMillis()).
  if (typeof isoOrTimestamp === "string") {
    const t = new Date(isoOrTimestamp).getTime();
    return isNaN(t) ? null : t;
  }
  if (typeof isoOrTimestamp.toMillis === "function") return isoOrTimestamp.toMillis();
  if (typeof isoOrTimestamp.seconds === "number") return isoOrTimestamp.seconds * 1000;
  return null;
}

// ------------------------------------------------------------------
// Admin aggregation
// ------------------------------------------------------------------

const STATUS_CODES = ["not-logged-in", "logged-in", "in-progress", "submitted", "time-expired"];

/**
 * Groups candidates by exam center and tallies derived statuses.
 * `candidates` = array of candidate records (must include `center`).
 * `statusByCandidateId` = { candidateId: statusDoc|null }
 */
export function groupCandidatesByCenter(candidates, statusByCandidateId, nowMs) {
  const centers = new Map();

  candidates.forEach((c) => {
    if (!centers.has(c.center)) {
      centers.set(c.center, {
        center: c.center,
        total: 0,
        counts: Object.fromEntries(STATUS_CODES.map((s) => [s, 0])),
      });
    }
    const bucket = centers.get(c.center);
    bucket.total++;
    const derived = computeDerivedStatus(c, statusByCandidateId[c.candidateId] || null, nowMs);
    bucket.counts[derived.code] = (bucket.counts[derived.code] || 0) + 1;
  });

  const list = Array.from(centers.values()).sort((a, b) => a.center.localeCompare(b.center, undefined, { numeric: true }));
  list.forEach((bucket) => {
    bucket.completionRate = bucket.total > 0 ? Math.round((bucket.counts["submitted"] / bucket.total) * 1000) / 10 : 0;
  });

  const overall = {
    total: candidates.length,
    counts: Object.fromEntries(STATUS_CODES.map((s) => [s, list.reduce((sum, b) => sum + b.counts[s], 0)])),
  };
  overall.completionRate = overall.total > 0 ? Math.round((overall.counts["submitted"] / overall.total) * 1000) / 10 : 0;

  return { centers: list, overall };
}

/**
 * Builds the flat monitoring-grid row list (one row per candidate) with
 * derived status attached, for rendering and for sorting/filtering.
 */
export function buildMonitoringRows(candidates, statusByCandidateId, nowMs) {
  return candidates.map((c) => {
    const statusDoc = statusByCandidateId[c.candidateId] || null;
    const derived = computeDerivedStatus(c, statusDoc, nowMs);
    return {
      candidateId: c.candidateId,
      name: c.name,
      mobile: c.mobile,
      center: c.center,
      set: c.set,
      batchStart: c.batchStart,
      batchEnd: c.batchEnd,
      derived,
    };
  });
}

/**
 * Builds result rows (submitted candidates only) for the admin Results tab.
 */
export function buildAdminResultsRows(candidates, statusByCandidateId) {
  const rows = [];
  candidates.forEach((c) => {
    const statusDoc = statusByCandidateId[c.candidateId];
    if (!statusDoc || statusDoc.status !== "submitted") return;
    rows.push({
      candidateId: c.candidateId,
      name: c.name,
      mobile: c.mobile,
      center: c.center,
      set: c.set,
      submittedAt: statusDoc.submittedAt,
      submitReason: statusDoc.submitReason,
      total: statusDoc.total,
      answered: statusDoc.answered,
      correct: statusDoc.correct,
      incorrect: statusDoc.incorrect,
      unanswered: statusDoc.unanswered,
      scorePercent: statusDoc.scorePercent,
    });
  });
  return rows;
}

export function sortRows(rows, key, direction = "asc") {
  const sorted = rows.slice().sort((a, b) => {
    let av = a[key];
    let bv = b[key];
    if (typeof av === "string") av = av.toLowerCase();
    if (typeof bv === "string") bv = bv.toLowerCase();
    if (av === undefined || av === null) av = "";
    if (bv === undefined || bv === null) bv = "";
    if (av < bv) return direction === "asc" ? -1 : 1;
    if (av > bv) return direction === "asc" ? 1 : -1;
    return 0;
  });
  return sorted;
}

export function buildAdminResultsCsv(rows) {
  const header = [
    "Candidate ID", "Name", "Mobile", "Center", "Set",
    "Submitted At", "Submit Reason", "Total", "Answered",
    "Correct", "Incorrect", "Unanswered", "Score %",
  ];
  const body = rows.map((r) => [
    r.candidateId, r.name, r.mobile, r.center, r.set,
    r.submittedAt || "", r.submitReason || "", r.total, r.answered,
    r.correct, r.incorrect, r.unanswered, r.scorePercent,
  ]);
  return rowsToCsv([header, ...body]);
}

export function buildCandidateResultCsvRows(result, fmtDateTime) {
  const rows = [];
  rows.push(["SCTPC Online Examination — Result Summary"]);
  rows.push(["Candidate ID", result.candidateId]);
  rows.push(["Name", result.name]);
  rows.push(["Mobile", result.mobile]);
  rows.push(["Exam Center", result.center]);
  rows.push(["Paper Set", result.set]);
  rows.push(["Submitted At", fmtDateTime ? fmtDateTime(result.submittedAt) : result.submittedAt]);
  rows.push(["Submit Reason", result.submitReason]);
  rows.push(["Total Questions", result.total]);
  rows.push(["Answered", result.answered]);
  rows.push(["Correct", result.correct]);
  rows.push(["Incorrect", result.incorrect]);
  rows.push(["Unanswered", result.unanswered]);
  rows.push(["Score Percent", result.scorePercent + "%"]);
  rows.push([]);
  rows.push(["Q#", "Category", "Question", "Selected Answer", "Correct Answer", "Result"]);
  result.perQuestion.forEach((p, i) => {
    rows.push([
      i + 1,
      p.category,
      p.question,
      p.selectedText || "(Not Answered)",
      p.correctText,
      p.isCorrect ? "Correct" : (p.selectedIndex === null ? "Unanswered" : "Incorrect"),
    ]);
  });
  return rows;
}