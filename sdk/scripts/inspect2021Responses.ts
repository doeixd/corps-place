import Database from 'better-sqlite3';
const db = new Database('./dci-relational.db');
const results = db.prepare('SELECT endpoint_url, response_json FROM api_responses WHERE endpoint_url LIKE ?').all('%2021%');
results.forEach(r => {
  console.log(`URL: ${r.endpoint_url}`);
  try {
    const json = JSON.parse(r.response_json);
    console.log(`Response length: ${Array.isArray(json) ? json.length : 'Object'}`);
    if (Array.isArray(json) && json.length > 0) {
      console.log("First item sample:", JSON.stringify(json[0]).substring(0, 200));
    } else {
      console.log("Response:", r.response_json.substring(0, 200));
    }
  } catch (e) {
    console.log("JSON Parse Error");
  }
  console.log("---");
});
