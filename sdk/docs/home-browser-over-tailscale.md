# Driving a home browser over Tailscale (residential-IP scraping)

**Goal:** run `scripts/browser-tools.ts` on the server (`vultr`, a datacenter box
whose IP gets auto-blocked by scraping targets) but have the actual browser — and
therefore the actual HTTP requests — run on a **home machine** (`mini-pc`) so
traffic egresses from a **residential IP**.

**Status: working.** Verified the remote browser egresses from the residential IP
`96.233.133.226`, while `vultr` itself is `149.28.121.248`.

---

## TL;DR — how to use it

**On the home machine (`mini-pc`, Windows)** — one command launches Chrome with
the DevTools port *and* opens the auto-reconnecting reverse tunnel:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\home-browser-host.ps1
```

Leave it running. (For unattended boot, set up an SSH key + a logon task — see
[Run it on startup](#run-it-on-startup).)

**On the server (`vultr`)** — use the CLI normally; it auto-targets
`localhost:9222`:

```bash
npx tsx scripts/browser-tools.ts nav https://example.com
npx tsx scripts/browser-tools.ts content https://example.com
npx tsx scripts/browser-tools.ts eval "location.href"
scripts/browser-tunnel.sh --check     # health check (hits /json/version)
```

---

## Architecture

```
  home machine (mini-pc, Windows)            server (vultr, Linux)
  ┌─────────────────────────────┐            ┌─────────────────────────────┐
  │ Chrome --remote-debugging-   │            │ browser-tools.ts             │
  │ port=9222 (binds 127.0.0.1)  │            │   connects to localhost:9222 │
  │                              │            │                              │
  │ ssh -N -R 9222:127.0.0.1:9222│──Tailscale─▶ sshd publishes 127.0.0.1:9222│
  │   patrick@<vultr-tailnet-ip> │   (DERP)   │   forwarded back to mini-pc  │
  └─────────────────────────────┘            └─────────────────────────────┘
            outbound only                       CDP traffic rides the tunnel
```

`browser-tools.ts` is **unchanged** — it always talks to `localhost:9222`. The
SSH reverse forward makes the home machine's Chrome appear on the server's
`localhost:9222`. Chrome's debug port stays bound to loopback on both ends (never
exposed on the tailnet), which also sidesteps Chrome's "Host header must be an IP
or localhost" rejection.

### Why REVERSE (`-R`), not forward (`-L`)

The obvious design is the server SSH-ing **into** the home machine
(`scripts/browser-tunnel.sh`, the `ssh -L` forward). **That does not work here:**
the home machine sits behind a corporate network that only carries **outbound**
TCP. The server cannot initiate any connection to it. So instead the home machine
dials **out** to the server and remote-forwards (`-R`) its Chrome port. The
direction that works carries the tunnel.

`scripts/browser-tunnel.sh` (the `-L` forward, run from the server) is kept for
the symmetric case where the server *can* reach the home machine; its header
documents both forms. For this setup, use the reverse tunnel / the PowerShell
helper.

---

## The two non-obvious gotchas

### 1. Pin `127.0.0.1` on both ends — not `localhost`

Symptom: `curl http://localhost:9222/json/version` on the server returns
**`curl: (52) Empty reply from server`** even though the tunnel port is open.

Cause: on Windows, `localhost` resolves to IPv6 `::1` first, but Chrome's
remote-debugging server binds **IPv4 `127.0.0.1` only**. `ssh -R 9222:localhost:9222`
forwards to `[::1]:9222`, where nothing is listening, so the connection closes
empty.

Fix: write the forward as `ssh -R 9222:127.0.0.1:9222 …` (the destination is
resolved on the home machine). `home-browser-host.ps1` already does this.

### 2. `browser-tools.ts content` / `search --content` → "__name is not defined"

Cause: `tsx` runs the CLI through esbuild with `--keep-names`, which rewrites
named functions into `__name(fn, "name")`. Functions injected into the page via
`page.evaluate` then reference `__name`, which doesn't exist in the browser.

Fix (committed in `scripts/browser-tools.ts`): a no-op `__name` shim installed in
`preparePage` via both `page.evaluate` and `page.evaluateOnNewDocument`. The
`evaluateOnNewDocument` reinstall matters because `page.goto` creates a fresh JS
context that loses the shim — `content` navigates before extracting, so without
the reinstall the shim would be gone by extraction time.

---

## Run it on startup

`home-browser-host.ps1` is foreground/auto-reconnecting. To make it unattended:

1. **SSH key** (no password prompt at boot):
   ```powershell
   ssh-keygen -t ed25519                    # accept defaults
   type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh patrick@100.97.144.34 `
     "cat >> ~/.ssh/authorized_keys"
   ```
2. **Logon task:**
   ```powershell
   schtasks /Create /TN "BrowserHost" /SC ONLOGON /RL LIMITED /F /TR `
     "powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PWD\scripts\home-browser-host.ps1`""
   ```

---

## Tailscale setup notes (home machine)

These are prerequisites; most bit us at least once during bring-up.

- **Node key expiry.** Tailscale node keys expire (default ~180 days). If
  `tailscale ping <peer>` reports *"peer's node key has expired"* and `status`
  shows the device offline despite it being powered on, re-authenticate on the
  device (`tailscale up` + browser login) or disable key expiry for it in the
  admin console (Machines → device → ⋯).
- **`tailscale ping` proves almost nothing about app traffic.** It uses the disco
  protocol handled entirely inside `tailscaled` — it never touches the target's
  OS network stack, firewall, or ACLs. A successful `pong` only means the two
  daemons can reach each other (here, over a DERP relay). Real TCP can still be
  fully blocked while ping succeeds.
- **`tailscale ssh` does NOT work to a Windows target.** Tailscale's SSH *server*
  is Linux/macOS-only. For Windows, use plain `ssh` against Windows' built-in
  OpenSSH server (`Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0`)
  — but in this setup we don't need inbound SSH at all (reverse tunnel).

---

## Diagnostic playbook (what we ruled out, and how)

We spent a long session proving `vultr → mini-pc` TCP was dead on **every** port
(22 / 3389 / 445) while `mini-pc → vultr` worked. The corporate-NAT
outbound-only conclusion came from eliminating everything else. For next time:

| Suspect | How we tested | Result |
|---|---|---|
| sshd not running | `Get-NetTCPConnection -LocalPort 22 -State Listen` | Listening on `0.0.0.0:22` — not it |
| Per-port firewall rule | `Get-NetFirewallRule … -Action Block` + created an explicit allow | Allow rule correct — not it |
| Wrong firewall profile | `Get-NetConnectionProfile` (Tailscale iface) | Already `Private` — not it |
| **Windows firewall at all** | `Set-NetFirewallProfile -All -Enabled False`, re-probe | **Still blocked → firewall innocent** |
| Tailscale ShieldsUp (receiver) | `tailscale debug prefs | Select-String ShieldsUp` | `false` — not it |
| Tailnet ACL | Admin console → Access Controls | Default allow-all (`src:*,dst:*,ip:*`) — not it |
| Data plane broken | `Test-NetConnection <vultr> -Port 22` **from mini-pc** | **Succeeded** → tunnel carries TCP; only *inbound to mini-pc* is dead |

Conclusion: the block is the **corporate network**, dropping all inbound TCP to
the home machine. Key insight: **switching SSH to a "normal" port (443/80) cannot
help** — the corporate firewall never sees the inner port; all Tailscale traffic
is encrypted inside a WireGuard/DERP TLS stream. The only fix is to not require
inbound at all → reverse tunnel.

**Fast disambiguator for any future "X → Y is blocked over Tailscale":** run a
reverse `Test-NetConnection`/TCP probe (`Y → X`). If it succeeds, the data plane
is fine and the problem is receiver-side inbound (firewall / shields / ACL / NAT)
— and a reverse tunnel sidesteps it.

---

## Files

- `scripts/home-browser-host.ps1` — home-machine launcher (Chrome + reverse tunnel, auto-reconnect).
- `scripts/browser-tunnel.sh` — server-side `ssh -L` forward + `--check` health probe; header documents forward vs reverse.
- `scripts/browser-tools.ts` — the CDP CLI (unchanged transport; `__name` shim fix).
- `sdk/docs/web-research-and-scraping-field-guide.md` — the broader scraping-tool field guide; this doc is the deep-dive for the Tailscale path.
