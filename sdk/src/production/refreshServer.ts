// src/production/refreshServer.ts
import { createServer } from "node:http";
import { spawn, ChildProcess } from "node:child_process";

/**
 * PRODUCTION REFRESH SERVER
 * 
 * listens for a webhook and triggers scripts/refreshV7.ts.
 * Implements a singleton pattern: if a new request comes in while a 
 * refresh is active, the active one is killed and restarted.
 */

let activeProcess: ChildProcess | null = null;

function runRefresh(fineTune: boolean = false) {
  // Kill existing process if running
  if (activeProcess) {
    console.log("\n>>> CANCELING ACTIVE REFRESH...");
    activeProcess.kill("SIGTERM");
    activeProcess = null;
  }

  const args = ["scripts/refreshV7.ts"];
  if (fineTune) args.push("--fine-tune");

  console.log(`\n>>> STARTING REFRESH: npx tsx ${args.join(" ")}`);

  activeProcess = spawn("npx", ["tsx", ...args], {
    stdio: "inherit",
    shell: true
  });

  activeProcess.on("close", (code) => {
    console.log(`>>> REFRESH PROCESS EXITED WITH CODE ${code}`);
    activeProcess = null;
  });

  activeProcess.on("error", (err) => {
    console.error(`>>> REFRESH PROCESS ERROR:`, err);
    activeProcess = null;
  });
}

const server = createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  if (req.method === "POST" && url.pathname === "/refresh") {
    // Check for optional fine-tune flag in query or body
    const fineTune = url.searchParams.get("fineTune") === "true";

    runRefresh(fineTune);

    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "Accepted", message: "Refresh triggered" }));
    return;
  }

  if (url.pathname === "/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: activeProcess ? "Busy" : "Idle",
      pid: activeProcess?.pid
    }));
    return;
  }

  res.writeHead(404);
  res.end();
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`   V7 PRODUCTION REFRESH SERVER RUNNING ON PORT ${PORT}   `);
  console.log(`   Endpoint: POST /refresh?fineTune=true           `);
  console.log(`====================================================`);
});
