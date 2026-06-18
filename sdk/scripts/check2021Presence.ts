import Database from 'better-sqlite3';
const db = new Database('./dci-relational.db');

console.log("--- 2021 in Competitions ---");
const comps = db.prepare("SELECT COUNT(*) as count FROM competitions WHERE season = '2021'").get();
console.log(comps);

console.log("\n--- 2021 in Events ---");
const events = db.prepare("SELECT COUNT(*) as count FROM events WHERE start_date LIKE '2021%'").get();
console.log(events);

console.log("\n--- 2021 in API Responses ---");
const responses = db.prepare("SELECT COUNT(*) as count FROM api_responses WHERE endpoint_url LIKE '%2021%'").get();
console.log(responses);

console.log("\n--- 2021 in Corps Scores ---");
const scores = db.prepare("SELECT COUNT(*) as count FROM corps_scores WHERE competition_slug LIKE '2021%'").get();
console.log(scores);
