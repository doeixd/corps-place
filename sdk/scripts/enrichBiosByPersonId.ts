// Backfill bios for prominent staff who lack one (web-researched, person_id-keyed).
// Sets biography on all of a person's corps_staff rows that currently have none. Uses a busy
// timeout because the yearbook ingest may be writing concurrently. Re-runnable; --apply writes.
import { createClient } from "@libsql/client";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadRepoEnv } from "./scriptEnv.js";
const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, "..");
loadRepoEnv(SDK_DIR);
const DRY = !process.argv.includes("--apply");
const db = createClient({ url: process.env.DCI_RELATIONAL_DB_URL ?? `file:${resolve(SDK_DIR, "dci-relational.db")}` });

// Web-researched bios (sources in `src`). Concise, factual; verified the name+corps in results.
const BIOS: { personId: string; src: string; bio: string }[] = [
  { personId: "kristen-eck", src: "mandarins.org/drum-corps-staff/kristen-eck",
    bio: "Kristen Eck earned her Music Education degree from the University of Houston and began her career teaching Houston-area band programs. She taught brass (mellophone) at the Bluecoats from 2016-2022, adding a brass caption coordination role in 2021-2022, then taught at Blue Devils A and the Mandarins in 2023-2024, where she now serves as Assistant Brass Caption Head. She lives in Dayton, OH." },
  { personId: "connor-yasuda", src: "bluecoats.com / pulsepercussion.org",
    bio: "Connor Yasuda has been on staff with Pulse Percussion for nine years and marched with Pulse, POW Percussion, the Mandarins, Blue Stars, and the Bluecoats. He has taught at the Bluecoats as a snare/battery tech since 2019 and served as the Mandarins' Percussion Caption Head in 2024. He holds a degree in Film & Electronic Arts from CSU Long Beach and works as a freelance videographer and digital artist in Cypress, CA." },
  { personId: "genevieve-geisler", src: "bluecoats.com",
    bio: "Genevieve Geisler is the CFO/COO of the Bluecoats. She holds B.S. and M.P.H. degrees from the University of Michigan. Starting as a food-truck volunteer, she became operations director in 2006, director of finance in 2015, and was promoted to CFO/COO in 2018, building the corps' charitable-gaming, merchandise, health/wellness, and food-service programs. She also chaired DCI's IN STEP: Women of DCI committee." },
  { personId: "greg-power", src: "bluestars.org/staff-1/2025-greg-power",
    bio: "Greg Power holds a B.M. in Percussion Performance from Washington State University (2015) and an M.M. from CSU Northridge (2018). He marched DCI with the Cascades and Blue Stars and WGI with Pulse Percussion. He taught percussion at the Bluecoats (2020-2022, Fred Sanford Award 2022) and is the Battery/Percussion Caption Head at the Blue Stars. He is an Associate Instrumental Director at Buchanan Educational Center in Clovis, CA." },
  { personId: "scott-dupre", src: "dupremusicdesigns.com / bluecoats.com",
    bio: "Scott Dupre is a composer, arranger, and brass educator. He has been a DCI brass educator for over a decade — two seasons on the Santa Clara Vanguard brass staff, then the Bluecoats brass staff since 2015. He earned a B.M.E. from the University of Houston (2012) and an M.M.E. from Southern Methodist University (2017), and works with 30+ marching programs nationally. He lives in Fort Worth, TX." },
  { personId: "travis-pruitt", src: "hebronband.org/travispruitt-bio / mandarins.org",
    bio: "Travis Pruitt is Associate Director of Bands at Hebron High School (Carrollton, TX). He completed 12 seasons on the Bluecoats brass staff (2016 & 2024 DCI World Champions; 2024 Jim Ott Award) and is on the Mandarins' Ensemble Coordination team. A 1999 DCI World Champion with Santa Clara Vanguard, he holds a B.M.E. from New Mexico State and an M.M. from the University of Colorado Boulder." },
  { personId: "latrice-virola", src: "bluecoats.com/news/2026/3/6/meet-the-board",
    bio: "Latrice Virola joined the Bluecoats Board of Directors in 2024. A certified Lean Six Sigma Green and Black Belt with a B.S. in Decision Sciences from Miami University, she is Director of Customer Relations at the Stark Area Regional Transit Authority (SARTA) and president of the board of EN-RICH-MENT." },
  { personId: "marvin-reed", src: "mandarins.org/drum-corps-staff/dr.-marvin-reed",
    bio: "Dr. Marvin Reed is Corps Director of Blue Devils B, where he previously served as Drum Major Coordinator, and has served on the Sacramento Mandarins' Board of Directors. He holds a Doctorate in Educational Leadership from CSU Sacramento (where he was Hornet Marching Band Drum Major), plus degrees in Sociology and Higher Education. He is Vice Principal of Amador Elementary (Dublin USD) and a visual coach at Emerald High School." },
  { personId: "ryan-adamsons", src: "scvanguard.org / ryanerikadamsons.com",
    bio: "Ryan Adamsons, a Springfield, VA native based in Chicago, is a performer, composer, and educator. He holds B.S. degrees in Jazz Studies and Brass Performance (University of Akron) and an M.M. in Jazz Composition (DePaul). He marched the Bluecoats (1998-2002) and was on their brass staff (2003-2008, 2011), joined the Santa Clara Vanguard brass staff in 2012 (SCVC Brass Caption Manager, 2018), and has taught Vanguard Cadets (2018-2022) and Phantom Regiment (2020-present)." },
  { personId: "hikari-nitta", src: "siegepercussion.org / ensembleinnovations.com",
    bio: "Hikari Nitta is an Orlando-based color guard and dance educator/performer (she also performs taiko with Matsuriza at Epcot). She has performed and taught with Freedom HS (Orlando), USF Winterguard, the Bluecoats, and Swotu Waya, and led Freedom HS color guard to WGI Scholastic A finals." },
  { personId: "matt-skowronski", src: "bluecoats.com",
    bio: "Matt Skowronski is an audio engineer and visual staff member with the Bluecoats Drum and Bugle Corps." },
  { personId: "bryen-warfield", src: "mandarins.org/drum-corps-staff/bryen-warfield",
    bio: "Bryen Warfield, a native of Indianapolis, marched the Bluecoats for three seasons and has been a brass educator for Cincinnati Tradition, the Columbus Saints (2016 Open Class gold-medalist staff), Santa Clara Vanguard, and the Bluecoats; he is Co-Brass Caption Head of the Sacramento Mandarins. He holds a B.M. in Tuba Performance (University of Louisville) and an M.M. in Wind Conducting (Ohio State), and is Director of Bands and Orchestra at Homestead High School in Fort Wayne, IN." },
];

const main = async () => {
  if (!DRY) await db.execute("PRAGMA busy_timeout=15000");
  let updated = 0;
  for (const b of BIOS) {
    const rows = (await db.execute({ sql: "SELECT staff_id, display_name, length(trim(coalesce(biography,''))) bl FROM corps_staff WHERE person_id=?", args: [b.personId] })).rows as any[];
    if (rows.length === 0) { console.log(`· ${b.personId}: no rows (skip)`); continue; }
    const need = rows.filter((r) => (r.bl ?? 0) < 40);
    console.log(`${DRY ? "·" : "✓"} ${b.personId} (${rows[0].display_name}): ${need.length}/${rows.length} rows need bio  [${b.src}]`);
    if (!DRY) for (const r of need) { await db.execute({ sql: "UPDATE corps_staff SET biography=? WHERE staff_id=?", args: [b.bio, r.staff_id] }); updated++; }
  }
  console.log(`\n${DRY ? "(dry-run)" : "APPLIED"}: ${updated} rows updated across ${BIOS.length} people.`);
  process.exit(0);
};
main();
