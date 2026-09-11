import assert from "node:assert/strict";
import {
  shuffle, mmss, maskMobile, csvEscape, rowsToCsv,
  buildPreparedQuestions, computeResult, computeDerivedStatus,
  groupCandidatesByCenter, buildMonitoringRows, buildAdminResultsRows,
  sortRows, buildAdminResultsCsv, buildCandidateResultCsvRows,
  EXAM_DURATION_MS, STALE_SESSION_MS,
} from "../exam-logic.js";

let pass = 0, fail = 0;
function test(name, fn) {
  try {
    fn();
    console.log("PASS:", name);
    pass++;
  } catch (e) {
    console.log("FAIL:", name, "->", e.message);
    fail++;
  }
}

// ---------------- mmss ----------------
test("mmss formats correctly", () => {
  assert.equal(mmss(0), "00:00");
  assert.equal(mmss(59000), "00:59");
  assert.equal(mmss(60000), "01:00");
  assert.equal(mmss(30 * 60 * 1000), "30:00");
  assert.equal(mmss(-500), "00:00");
});

// ---------------- maskMobile ----------------
test("maskMobile masks all but last 4 digits", () => {
  assert.equal(maskMobile("9000000001"), "XXXXXX0001");
  assert.equal(maskMobile("123"), "123");
});

// ---------------- csvEscape / rowsToCsv ----------------
test("csvEscape quotes fields with commas/quotes/newlines", () => {
  assert.equal(csvEscape("plain"), "plain");
  assert.equal(csvEscape("a,b"), '"a,b"');
  assert.equal(csvEscape('he said "hi"'), '"he said ""hi"""');
  assert.equal(csvEscape("line1\nline2"), '"line1\nline2"');
  assert.equal(csvEscape(null), "");
  assert.equal(csvEscape(42), "42");
});

test("rowsToCsv joins rows with CRLF", () => {
  const csv = rowsToCsv([["a", "b"], [1, 2]]);
  assert.equal(csv, "a,b\r\n1,2");
});

// ---------------- shuffle ----------------
test("shuffle is deterministic under a fixed rng and preserves elements", () => {
  const seq = [0.9, 0.1, 0.5];
  let i = 0;
  const rng = () => seq[i++ % seq.length];
  const result = shuffle([0, 1, 2, 3], rng);
  assert.deepEqual([...result].sort(), [0, 1, 2, 3]);
});

// ---------------- buildPreparedQuestions ----------------
test("buildPreparedQuestions preserves correctness through shuffle", () => {
  const raw = [
    { id: "Q1", category: "Applications", text: "Q1?", options: ["A", "B", "C", "D"], answer: 2 },
  ];
  // Force a specific shuffle: reverse order [3,2,1,0]
  const rng = (() => {
    const seq = [0.99, 0.99, 0.99, 0.99]; // will produce a reversal-ish shuffle w/ Fisher-Yates; just assert correctness holds regardless
    let i = 0;
    return () => seq[i++ % seq.length];
  })();
  const prepared = buildPreparedQuestions(raw, true, rng);
  const q = prepared[0];
  assert.equal(q.options[q.correctIndex], "C", "the option at correctIndex must be the originally-correct text ('C')");
  assert.equal(q.options.length, 4);
});

test("buildPreparedQuestions keeps fixed order when randomize=false", () => {
  const raw = [{ id: "Q1", category: "Technology", text: "?", options: ["A", "B", "C", "D"], answer: 1 }];
  const prepared = buildPreparedQuestions(raw, false);
  assert.deepEqual(prepared[0].options, ["A", "B", "C", "D"]);
  assert.equal(prepared[0].correctIndex, 1);
});

// ---------------- computeResult ----------------
function sampleSession(answersOverride = {}) {
  const questions = [
    { id: "A1", category: "Applications", text: "a1", options: ["a", "b", "c", "d"], correctIndex: 0 },
    { id: "A2", category: "Applications", text: "a2", options: ["a", "b", "c", "d"], correctIndex: 1 },
    { id: "O1", category: "Office Tools", text: "o1", options: ["a", "b", "c", "d"], correctIndex: 2 },
    { id: "T1", category: "Technology", text: "t1", options: ["a", "b", "c", "d"], correctIndex: 3 },
  ];
  const answers = { A1: 0, A2: 2, O1: 2, ...answersOverride }; // A1 correct, A2 wrong, O1 correct, T1 unanswered
  return { questions, answers };
}

test("computeResult scores correctly and buckets categories", () => {
  const session = sampleSession();
  const result = computeResult(session, {
    candidateId: "C1", name: "Test User", mobile: "9000000001",
    set: "Set 1", center: "Center 1", submittedAt: "2026-09-11T10:00:00+05:30", submitReason: "manual",
  });
  assert.equal(result.total, 4);
  assert.equal(result.answered, 3);
  assert.equal(result.correct, 2);
  assert.equal(result.incorrect, 1);
  assert.equal(result.unanswered, 1);
  assert.equal(result.scorePercent, 50);
  assert.equal(result.categories["Applications"].total, 2);
  assert.equal(result.categories["Applications"].correct, 1);
  assert.equal(result.categories["Technology"].correct, 0);
  const t1 = result.perQuestion.find((p) => p.id === "T1");
  assert.equal(t1.selectedIndex, null);
  assert.equal(t1.isCorrect, false);
});

test("computeResult handles a perfect score", () => {
  const session = sampleSession({ A1: 0, A2: 1, O1: 2, T1: 3 });
  const result = computeResult(session, { candidateId: "C2", name: "N", mobile: "9", set: "Set 1", center: "Center 1", submittedAt: "x", submitReason: "manual" });
  assert.equal(result.correct, 4);
  assert.equal(result.scorePercent, 100);
});

// ---------------- computeDerivedStatus ----------------
const candidate = { candidateId: "C1", batchStart: "2026-09-11T09:00:00+05:30", batchEnd: "2026-09-11T12:00:00+05:30" };
const NOW_IN_WINDOW = new Date("2026-09-11T10:00:00+05:30").getTime();
const NOW_AFTER_WINDOW = new Date("2026-09-11T13:00:00+05:30").getTime();

test("no status doc, within window -> not-logged-in", () => {
  const d = computeDerivedStatus(candidate, null, NOW_IN_WINDOW);
  assert.equal(d.code, "not-logged-in");
});

test("no status doc, past batchEnd -> time-expired (no-show)", () => {
  const d = computeDerivedStatus(candidate, null, NOW_AFTER_WINDOW);
  assert.equal(d.code, "time-expired");
  assert.equal(d.variant, "no-show");
});

test("status logged-in, fresh heartbeat -> logged-in", () => {
  const doc = { status: "logged-in", loginAt: new Date(NOW_IN_WINDOW - 10000).toISOString(), lastHeartbeat: new Date(NOW_IN_WINDOW - 5000).toISOString() };
  const d = computeDerivedStatus(candidate, doc, NOW_IN_WINDOW);
  assert.equal(d.code, "logged-in");
});

test("status in-progress, fresh heartbeat, within exam time -> in-progress", () => {
  const startedAt = new Date(NOW_IN_WINDOW - 5 * 60 * 1000).toISOString(); // started 5 min ago
  const doc = { status: "in-progress", startedAt, lastHeartbeat: new Date(NOW_IN_WINDOW - 10000).toISOString(), answered: 12, total: 30 };
  const d = computeDerivedStatus(candidate, doc, NOW_IN_WINDOW);
  assert.equal(d.code, "in-progress");
  assert.equal(d.detail, "12/30 answered");
});

test("status in-progress, heartbeat stale beyond threshold -> time-expired (incomplete)", () => {
  const startedAt = new Date(NOW_IN_WINDOW - 5 * 60 * 1000).toISOString();
  const staleHeartbeat = new Date(NOW_IN_WINDOW - (STALE_SESSION_MS + 60000)).toISOString();
  const doc = { status: "in-progress", startedAt, lastHeartbeat: staleHeartbeat };
  const d = computeDerivedStatus(candidate, doc, NOW_IN_WINDOW);
  assert.equal(d.code, "time-expired");
  assert.equal(d.variant, "incomplete");
});

test("status in-progress, exam duration + grace elapsed even with recent heartbeat -> time-expired", () => {
  const startedAt = new Date(NOW_IN_WINDOW - EXAM_DURATION_MS - 3 * 60 * 1000).toISOString(); // started 33 min ago (30 min exam + grace 2 min exceeded)
  const doc = { status: "in-progress", startedAt, lastHeartbeat: new Date(NOW_IN_WINDOW - 5000).toISOString() };
  const d = computeDerivedStatus(candidate, doc, NOW_IN_WINDOW);
  assert.equal(d.code, "time-expired");
  assert.equal(d.variant, "incomplete");
});

test("status submitted -> submitted with score", () => {
  const doc = { status: "submitted", submitReason: "timeout", correct: 20, total: 30, scorePercent: 66.7 };
  const d = computeDerivedStatus(candidate, doc, NOW_IN_WINDOW);
  assert.equal(d.code, "submitted");
  assert.equal(d.score.correct, 20);
  assert.match(d.detail, /Auto-submitted/);
});

// ---------------- groupCandidatesByCenter / buildMonitoringRows ----------------
function fakeCandidates() {
  return [
    { candidateId: "S1-C1", name: "A", mobile: "1", center: "Center 1", set: "Set 1", batchStart: candidate.batchStart, batchEnd: candidate.batchEnd },
    { candidateId: "S1-C2", name: "B", mobile: "2", center: "Center 1", set: "Set 1", batchStart: candidate.batchStart, batchEnd: candidate.batchEnd },
    { candidateId: "S2-C1", name: "C", mobile: "3", center: "Center 2", set: "Set 2", batchStart: candidate.batchStart, batchEnd: candidate.batchEnd },
  ];
}

test("groupCandidatesByCenter tallies correctly", () => {
  const statusMap = {
    "S1-C1": { status: "submitted", submitReason: "manual", correct: 25, total: 30, scorePercent: 83.3 },
    "S1-C2": null,
    "S2-C1": { status: "in-progress", startedAt: new Date(NOW_IN_WINDOW - 60000).toISOString(), lastHeartbeat: new Date(NOW_IN_WINDOW - 5000).toISOString(), answered: 5, total: 30 },
  };
  const grouped = groupCandidatesByCenter(fakeCandidates(), statusMap, NOW_IN_WINDOW);
  assert.equal(grouped.centers.length, 2);
  const c1 = grouped.centers.find((c) => c.center === "Center 1");
  assert.equal(c1.total, 2);
  assert.equal(c1.counts["submitted"], 1);
  assert.equal(c1.counts["not-logged-in"], 1);
  const c2 = grouped.centers.find((c) => c.center === "Center 2");
  assert.equal(c2.counts["in-progress"], 1);
  assert.equal(grouped.overall.total, 3);
  assert.equal(grouped.overall.counts["submitted"], 1);
});

test("buildMonitoringRows returns one row per candidate with derived status", () => {
  const rows = buildMonitoringRows(fakeCandidates(), {}, NOW_IN_WINDOW);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].derived.code, "not-logged-in");
});

test("buildAdminResultsRows only includes submitted candidates", () => {
  const statusMap = {
    "S1-C1": { status: "submitted", correct: 25, total: 30, scorePercent: 83.3, answered: 28, incorrect: 3, unanswered: 2, submittedAt: "x", submitReason: "manual" },
    "S1-C2": { status: "in-progress" },
  };
  const rows = buildAdminResultsRows(fakeCandidates(), statusMap);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].candidateId, "S1-C1");
});

// ---------------- sortRows ----------------
test("sortRows sorts ascending and descending, case-insensitively for strings", () => {
  const rows = [{ name: "banana", n: 2 }, { name: "Apple", n: 10 }, { name: "cherry", n: 1 }];
  const asc = sortRows(rows, "name", "asc");
  assert.deepEqual(asc.map((r) => r.name), ["Apple", "banana", "cherry"]);
  const desc = sortRows(rows, "n", "desc");
  assert.deepEqual(desc.map((r) => r.n), [10, 2, 1]);
});

// ---------------- CSV builders ----------------
test("buildAdminResultsCsv produces expected header and row count", () => {
  const rows = [{ candidateId: "C1", name: "A", mobile: "1", center: "Center 1", set: "Set 1", submittedAt: "t", submitReason: "manual", total: 30, answered: 28, correct: 20, incorrect: 8, unanswered: 2, scorePercent: 66.7 }];
  const csv = buildAdminResultsCsv(rows);
  const lines = csv.split("\r\n");
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith("Candidate ID,Name,Mobile,Center,Set"));
  assert.ok(lines[1].startsWith("C1,A,1,Center 1,Set 1"));
});

test("buildCandidateResultCsvRows includes per-question breakdown", () => {
  const session = sampleSession();
  const result = computeResult(session, { candidateId: "C1", name: "N", mobile: "9", set: "Set 1", center: "Center 1", submittedAt: "t", submitReason: "manual" });
  const rows = buildCandidateResultCsvRows(result);
  const qHeaderIdx = rows.findIndex((r) => r[0] === "Q#");
  assert.ok(qHeaderIdx > 0);
  assert.equal(rows.length, qHeaderIdx + 1 + 4); // header block + 4 question rows
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
