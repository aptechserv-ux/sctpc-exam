// =========================================================================
// Firebase configuration for the SCTPC Online Examination Portal.
//
// This file enables the LIVE ADMIN DASHBOARD (real-time candidate status
// across all exam centers, single-attempt enforcement across devices, and
// centralized result collection). The exam-taking screens work perfectly
// well WITHOUT this being filled in -- they just stay fully local to each
// device, exactly like a plain offline exam, and the Admin Dashboard will
// show a "live sync is not configured" notice instead of data.
//
// HOW TO FILL THIS IN (about 10 minutes, no cost):
//   1. Go to https://console.firebase.google.com and create a new project
//      (any name, e.g. "sctpc-exam"). Google Analytics is not needed --
//      you can decline it.
//   2. In the project, go to Build -> Firestore Database -> Create database.
//      Choose "Start in production mode" and pick a region close to you
//      (e.g. asia-south1 / Mumbai).
//   3. Go to Build -> Authentication -> Get started -> Sign-in method ->
//      enable "Anonymous". This lets the app sign candidates and admins in
//      silently (no separate accounts) so Firestore Security Rules can
//      require request.auth != null.
//   4. Go to Project settings (gear icon) -> General -> "Your apps" ->
//      click the "</>" (Web) icon -> register an app (any nickname, no
//      hosting needed) -> copy the "firebaseConfig" object it shows you
//      and paste its values below, replacing the placeholders.
//   5. Go to Build -> Firestore Database -> Rules, and paste the contents
//      of firestore.rules (included in this delivery) there, then Publish.
//      See README.md section 5 for the full walkthrough and how to verify
//      the rules using the Rules Playground before going live.
//
// The values below (apiKey, projectId, etc.) are NOT secret -- Firebase
// web config is meant to be public in client-side code. Your data is
// protected by the Firestore Security Rules (firestore.rules), not by
// hiding this file. See README.md "Security Notes" for the full picture.
// =========================================================================

export const firebaseConfig = {
  apiKey: "AIzaSyBVcBAtKBfFwfUePkY_H_cM3VjPv6a3rt8",
  authDomain: "sctpc-exam.firebaseapp.com",
  projectId: "sctpc-exam",
  storageBucket: "sctpc-exam.appspot.com",
  messagingSenderId: "516730071191",
  appId: "1:516730071191:web:bd467be45850f94bb721d2",
};

// Detects whether the placeholders above have been replaced with a real
// config. The app uses this to decide whether to attempt Firebase sync at
// all, so it can degrade gracefully (and quietly) before you've set it up.
export function isFirebaseConfigured() {
  return (
    firebaseConfig.apiKey &&
    !String(firebaseConfig.apiKey).startsWith("YOUR_") &&
    firebaseConfig.projectId &&
    !String(firebaseConfig.projectId).startsWith("YOUR_")
  );
}

// How often each candidate's browser pings Firestore with a heartbeat
// (answered-count + "still here" timestamp) while their exam is in
// progress. Set conservatively for a ~300-candidate single mass batch to
// comfortably stay within the Firestore Spark (free) plan's 20,000
// writes/day quota -- see README.md "Firestore usage budget" for the
// exact math and how to tune this for your own candidate count/schedule.
export const HEARTBEAT_INTERVAL_MS = 45 * 1000;

// The admin dashboard "master key". This is a CLIENT-SIDE convenience gate
// only -- anyone who can view script.js can see this value, so treat it as
// a shared PIN for keeping casual users out of the dashboard, not as real
// authentication. See README.md "Security Notes" before relying on this
// for anything sensitive. Change it before deploying.
export const ADMIN_PASSWORD = "IgPcs@092026";