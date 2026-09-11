// =========================================================================
// firebase-sync.js
//
// Thin wrapper around the Firebase Web SDK (loaded straight from Google's
// CDN as ES modules -- no build step, no npm install, works as-is on
// GitHub Pages). Everything here is best-effort: if firebase-config.js is
// still using placeholder values, or the network/Firebase project is
// unreachable, every function here degrades to a harmless no-op /
// { available: false } response instead of throwing, so the exam-taking
// screens keep working purely off localStorage regardless of Firebase's
// state. Only the Admin Dashboard truly depends on this working.
// =========================================================================

import { firebaseConfig, isFirebaseConfigured, HEARTBEAT_INTERVAL_MS } from "./firebase-config.js";

export const SYNC_ENABLED = isFirebaseConfigured();
export { HEARTBEAT_INTERVAL_MS };

const ALLOWED_KEYS = [
  "candidateId", "name", "mobile", "center", "set", "batchStart", "batchEnd",
  "status", "sessionId", "loginAt", "startedAt", "submittedAt", "submitReason",
  "lastHeartbeat", "updatedAt", "total", "answered", "correct", "incorrect",
  "unanswered", "scorePercent",
];

let sdk = null;         // { initializeApp, getAuth, signInAnonymously, getFirestore, doc, getDoc, setDoc, updateDoc, onSnapshot, collection, Timestamp }
let app = null;
let auth = null;
let db = null;
let signInPromise = null;
let loadPromise = null;

function withTimeout(promise, ms, fallback) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve(fallback);
      }
    }, ms);
    promise.then(
      (val) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(val);
        }
      },
      (err) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          console.warn("SCTPC sync error:", err && err.message ? err.message : err);
          resolve(fallback);
        }
      }
    );
  });
}

async function loadSdk() {
  if (!SYNC_ENABLED) return null;
  if (sdk) return sdk;
  if (!loadPromise) {
    loadPromise = (async () => {
      const [{ initializeApp }, authMod, fsMod] = await Promise.all([
        import("https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js"),
        import("https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js"),
        import("https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js"),
      ]);
      sdk = { initializeApp, ...authMod, ...fsMod };
      return sdk;
    })().catch((err) => {
      console.warn("SCTPC sync: failed to load Firebase SDK from CDN.", err);
      sdk = null;
      loadPromise = null;
      return null;
    });
  }
  return loadPromise;
}

async function ensureInit() {
  if (!SYNC_ENABLED) return false;
  const s = await withTimeout(loadSdk(), 8000, null);
  if (!s) return false;
  if (!app) {
    app = s.initializeApp(firebaseConfig);
    auth = s.getAuth(app);
    db = s.getFirestore(app);
  }
  return true;
}

async function ensureSignedIn(timeoutMs = 6000) {
  const ok = await ensureInit();
  if (!ok) return false;
  if (auth.currentUser) return true;
  if (!signInPromise) {
    signInPromise = sdk
      .signInAnonymously(auth)
      .then(() => true)
      .catch((err) => {
        console.warn("SCTPC sync: anonymous sign-in failed.", err);
        signInPromise = null;
        return false;
      });
  }
  return withTimeout(signInPromise, timeoutMs, false);
}

function statusRef(candidateId) {
  return sdk.doc(db, "exam_status", candidateId);
}

function cleanPayload(obj) {
  const out = {};
  ALLOWED_KEYS.forEach((k) => {
    out[k] = obj.hasOwnProperty(k) ? obj[k] : null;
  });
  return out;
}

/** Returns { available: boolean, doc: object|null } -- available=false means "could not reach Firestore", not "no record exists". */
export async function fetchStatus(candidateId, timeoutMs = 6000) {
  const ready = await withTimeout(ensureSignedIn(timeoutMs), timeoutMs, false);
  if (!ready) return { available: false, doc: null };
  try {
    const snap = await withTimeout(sdk.getDoc(statusRef(candidateId)), timeoutMs, null);
    if (snap === null) return { available: false, doc: null };
    return { available: true, doc: snap.exists() ? snap.data() : null };
  } catch (err) {
    console.warn("SCTPC sync: fetchStatus failed.", err);
    return { available: false, doc: null };
  }
}

/** Writes the initial 'logged-in' record. Best-effort: resolves true/false, never throws. */
export async function writeLogin(candidate, sessionId) {
  const ready = await ensureSignedIn();
  if (!ready) return false;
  const nowTs = sdk.Timestamp.now();
  const payload = cleanPayload({
    candidateId: candidate.candidateId,
    name: candidate.name,
    mobile: String(candidate.mobile),
    center: candidate.center,
    set: candidate.set,
    batchStart: candidate.batchStart,
    batchEnd: candidate.batchEnd,
    status: "logged-in",
    sessionId,
    loginAt: nowTs,
    lastHeartbeat: nowTs,
    updatedAt: nowTs,
  });
  try {
    await sdk.setDoc(statusRef(candidate.candidateId), payload);
    return true;
  } catch (err) {
    console.warn("SCTPC sync: writeLogin failed (continuing in local-only mode).", err);
    return false;
  }
}

export async function writeStart(candidateId) {
  const ready = await ensureSignedIn();
  if (!ready) return false;
  const nowTs = sdk.Timestamp.now();
  try {
    await sdk.updateDoc(statusRef(candidateId), {
      status: "in-progress",
      startedAt: nowTs,
      lastHeartbeat: nowTs,
      updatedAt: nowTs,
    });
    return true;
  } catch (err) {
    console.warn("SCTPC sync: writeStart failed (continuing in local-only mode).", err);
    return false;
  }
}

export async function writeHeartbeat(candidateId, { answered, total }) {
  const ready = await ensureSignedIn();
  if (!ready) return false;
  const nowTs = sdk.Timestamp.now();
  try {
    await sdk.updateDoc(statusRef(candidateId), {
      lastHeartbeat: nowTs,
      updatedAt: nowTs,
      answered,
      total,
    });
    return true;
  } catch (err) {
    console.warn("SCTPC sync: writeHeartbeat failed.", err);
    return false;
  }
}

export async function writeSubmit(candidateId, result) {
  const ready = await ensureSignedIn();
  if (!ready) return false;
  const nowTs = sdk.Timestamp.now();
  try {
    await sdk.updateDoc(statusRef(candidateId), {
      status: "submitted",
      submittedAt: nowTs,
      submitReason: result.submitReason,
      total: result.total,
      answered: result.answered,
      correct: result.correct,
      incorrect: result.incorrect,
      unanswered: result.unanswered,
      scorePercent: result.scorePercent,
      updatedAt: nowTs,
    });
    return true;
  } catch (err) {
    console.warn("SCTPC sync: writeSubmit failed (result is still saved locally; retry needed for the admin dashboard to see it).", err);
    return false;
  }
}

/**
 * Subscribes to the entire exam_status collection for the admin dashboard.
 * onData receives a plain object { candidateId: docData, ... } on every change.
 * Returns an unsubscribe function; if sync isn't available, calls onError
 * once and returns a no-op unsubscribe.
 */
export function subscribeAll(onData, onError) {
  let unsub = () => {};
  (async () => {
    const ready = await ensureSignedIn();
    if (!ready) {
      onError && onError(new Error("Live sync is not available (not configured, or Firebase/network unreachable)."));
      return;
    }
    try {
      unsub = sdk.onSnapshot(
        sdk.collection(db, "exam_status"),
        (snapshot) => {
          const map = {};
          snapshot.forEach((d) => {
            map[d.id] = d.data();
          });
          onData(map);
        },
        (err) => {
          console.warn("SCTPC sync: admin subscription error.", err);
          onError && onError(err);
        }
      );
    } catch (err) {
      onError && onError(err);
    }
  })();
  return () => unsub();
}

/** Ensures the current tab (candidate or admin) has an anonymous auth session. Safe to call repeatedly. */
export async function ensureAuth() {
  return ensureSignedIn();
}