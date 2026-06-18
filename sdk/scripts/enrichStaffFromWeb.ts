// Web-research enrichment for the residual common-surname review queue (§0d of the plan).
// The remaining held pairs are common-surname cross-corps records that deterministic tactics
// can't safely merge — but a web search on the individual ("<name> drum corps <corps>") usually
// reveals (a) whether the two corps' records are ONE career and (b) a bio the corps sites never
// published. This script applies the human/agent-verified verdicts: it merges the confirmed-same
// records into one person_id (union to the smallest existing id), backfills the harvested bio on
// rows that lack one, and marks the review pairs resolved with decided_by='web-research'.
//
// Each entry is a VERDICT reached by reading web results (DCI bios, corps staff pages, LinkedIn,
// announcements). `merge:false` records a confirmed SPLIT (two different people) so we stop
// re-queuing it. Re-runnable: skips rows already correct.
import { createClient } from "@libsql/client";
const db = createClient({ url: "file:./dci-relational.db" });
const DRY = !process.argv.includes("--apply");

type Verdict = { name: string; merge: boolean; bio?: string; source?: string; note: string };
const VERDICTS: Verdict[] = [
  { name: "Sean Clark", merge: true, source: "https://www.bluedevils.org/common/people/details.php?ID=64282",
    note: "Thesis Indoor Percussion was acquired by Blue Devils Performing Arts (BDPA) in 2023; Sean directs Thesis and is BD 'B' percussion caption head — the BD + bapam 'Thesis' records are one person.",
    bio: "Sean Clark is the director of Thesis Percussion, an independent world percussion ensemble he founded in Northern California in 2022 that was acquired by Blue Devils Performing Arts in 2023. In six years with BDPA he won three DCI World Championships (2014, 2015, 2017), an Open Class title (2012), and a Fred Sanford High Percussion Award (2015), and served as percussion section leader (2015-2017). He is Percussion Caption Head, Battery Arranger, and Staff Coordinator at Blue Devils B, and Director of Percussion at Saratoga High School. He graduated summa cum laude from CSU Fresno (2018) in Instrumental Music Education." },
  { name: "Evan Black", merge: true, source: "https://www.fusioncore.org/guard",
    note: "Color guard instructor/designer/choreographer with 10+ years on Fusion Core's design team; the Fusion/Genesis/Heat Wave guard records are one person.",
    bio: "Evan Black is a seasoned color guard instructor, director, and choreographer with over a decade of experience, serving on the design team for Fusion (Fusion Core) and working with groups including Genesis and Heat Wave." },
  { name: "Julian Johnson", merge: true, source: "https://cadets.org/julian-johnson",
    note: "Cadets visual staff (9 seasons) AND Bluecoats visual instructor — same person.",
    bio: "Julian Johnson began marching DCI in 2009 on trumpet with the Raiders, joined The Cadets in 2010 for four years (2011 DCI World Champion, 2012 Cadet of the Year, 2013 trumpet section leader). He has worked on The Cadets' visual staff for nine summers and as a visual instructor at Bluecoats, designing and staging drill since 2014. He has taught high school programs in New Jersey and the Carmel (IN) Marching Greyhounds." },
  { name: "Taylor Smith", merge: true, source: "https://www.scvanguard.org/staff/taylor-smith/",
    note: "SCV Brass Caption Manager since 2020; previously brass staff at Troopers, Cavaliers, Carolina Crown (where he also performed). Brass-caption thread across corps = one person.",
    bio: "Taylor Smith has been on the Santa Clara Vanguard brass staff since 2020 and is the Brass Caption Manager. A former Carolina Crown performer, he has been brass staff at Troopers, the Cavaliers, and Carolina Crown, helping earn four Jim Ott High Brass Awards and the 2013 DCI World Championship. He graduated from the University of Oklahoma (2009) with a Bachelor of Music Education." },
  { name: "Kaysey Thompson", merge: true, source: "https://www.scvanguard.org/staff/kaysey-thompson/",
    note: "Color guard choreographer/instructor whose clients include the Crossmen and SCV — same person.",
    bio: "Kaysey Leigh Thompson is a color guard choreographer and instructor from Boston, MA, whose clients include the Crossmen, Madison Scouts, Blue Knights, and Carolina Crown. She has performed with SCV Winterguard, The Cadets, and The Crossmen, and toured 15 years with Blast!, Shockwave, and Blast: Mix. She directs color guards at Westlake High School (Austin, TX)." },
  { name: "Colby Vasquez", merge: true, source: "http://www.colbyvasquez.com/bio",
    note: "SCV Assistant Corps Director (2023-25) who also supported the Seattle Cascades; the SCV + Cascades records are one person.",
    bio: "Colby Vasquez, DMA, marched Santa Clara Vanguard (2010-2012) and has staffed SCV and Vanguard Cadets in visual and admin roles, serving as Vanguard Cadets Visual Caption Head (2017-18), SCV Visual Caption Head (2022), and SCV Assistant Corps Director (2023-2025). He has supported the Seattle Cascades and is Assistant Director of Bands at North Carolina State University." },
  { name: "Derrell Wallace", merge: true, source: "https://musiccityyouth.org/drum-corps/staff",
    note: "Low brass/tuba instructor thread across corps — Music City Youth 'Tuba Lead', plus low brass at Cadets and Mandarins. Consistent caption = one person.",
    bio: "Derrell Wallace is a low brass / tuba instructor in the marching arts, serving on brass staffs including Music City Youth (Tuba Lead), The Cadets, and the Mandarins." },
  { name: "Garrett Davis", merge: true, source: "https://www.carolinacrown.org/drum-corps/staff",
    note: "Marched Cadets2 (2016), Carolina Crown (2017-18), The Cadets (2019), then joined Cadets staff (2020); active South Jersey marching-arts educator. Cadets + Crown records = one person.",
    bio: "Garrett Davis marched Cadets2 in 2016 (first championship), Carolina Crown in 2017-2018, and The Cadets in 2019, then joined The Cadets staff for the 2020 season. He earned a Bachelor's in Music Performance from Rowan University and composes and teaches for marching bands and indoor percussion groups in South Jersey." },
  { name: "Rachel Spencer", merge: true, source: "http://texasbands.org/rachel-spencer/",
    note: "Bluecoats lead trumpet/soloist/horn sergeant (5 yrs) → Bluecoats winds caption head / education coordinator, plus brass instruction at Madison Scouts and Vanguard Cadets. Brass thread = one person.",
    bio: "Rachel Spencer was a Bluecoats lead trumpet, soloist, and horn sergeant for five years (bronze, silver, gold medalist) and has served on the Bluecoats staff as a winds caption head and education coordinator, with brass instruction at the Madison Scouts and Vanguard Cadets. A music educator with over a decade of experience, she has held director roles at UT Austin, DCI, SoundSport, and the New School of Music Austin." },
  { name: "Enrique Perez", merge: true, source: "https://cadets.org/enrique-perez",
    note: "Color guard instructor/designer/choreographer — Cadets Color Guard Caption Manager; performed with Seattle Cascades, Braddock, and The Cadets. Guard records across corps = one person.",
    bio: "Enrique Perez is a color guard instructor, designer, and choreographer who serves as The Cadets' Color Guard Caption Manager. A former social studies and music teacher in Miami, he performed with the Seattle Cascades, Braddock Independent World Guard, and The Cadets, earning WGI and DCI bronze medals, and has worked with marching arts programs across Florida and the country." },
];

const norm = (s: string) => s.toLowerCase().trim();
let merged = 0, splits = 0, bios = 0;
for (const v of VERDICTS) {
  const rows = (await db.execute({ sql: "SELECT staff_id, person_id, biography FROM corps_staff WHERE lower(trim(display_name))=?", args: [norm(v.name)] })).rows as any[];
  if (rows.length < 2) { console.log(`· ${v.name}: <2 rows, skip`); continue; }
  if (v.merge) {
    const canonical = rows.map((r) => String(r.person_id)).sort()[0]!;
    console.log(`✓ MERGE ${v.name} → ${canonical} (${rows.length} rows)  [${v.note}]`);
    if (!DRY) {
      for (const r of rows) {
        if (r.person_id !== canonical) { await db.execute({ sql: "UPDATE corps_staff SET person_id=? WHERE staff_id=?", args: [canonical, r.staff_id] }); merged++; }
        if (v.bio && (!r.biography || String(r.biography).trim().length < 40)) {
          await db.execute({ sql: "UPDATE corps_staff SET biography=? WHERE staff_id=?", args: [v.bio, r.staff_id] }); bios++;
        }
      }
      await db.execute({ sql: "UPDATE corps_staff_review SET resolved=1, action='merge', decided_by='web-research', rationale=? WHERE resolved=0 AND (lower(left_staff_id) LIKE ? OR review_id IN (SELECT review_id FROM corps_staff_review r2 JOIN corps_staff l ON l.staff_id=r2.left_staff_id WHERE lower(trim(l.display_name))=?))", args: [v.note, `%${norm(v.name)}%`, norm(v.name)] });
    }
  } else {
    splits++;
    console.log(`✗ SPLIT ${v.name} (confirmed different people)  [${v.note}]`);
    if (!DRY) await db.execute({ sql: "UPDATE corps_staff_review SET resolved=1, action='keep-separate', decided_by='web-research', rationale=? WHERE resolved=0 AND review_id IN (SELECT review_id FROM corps_staff_review r2 JOIN corps_staff l ON l.staff_id=r2.left_staff_id WHERE lower(trim(l.display_name))=?)", args: [v.note, norm(v.name)] });
  }
}
console.log(`\n${DRY ? "(dry-run)" : "APPLIED"}: ${VERDICTS.length} verdicts — merged ${merged} rows, ${bios} bios backfilled, ${splits} confirmed-splits.`);
process.exit(0);
