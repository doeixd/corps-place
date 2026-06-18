// One-off: enrich Charley Poole + Michael Lentz bios (and set Lentz's photo_url
// to the locally-cached canonical key). Run from sdk/.
import { createClient } from "@libsql/client";

const db = createClient({ url: "file:./dci-relational.db" });

const pooleBio =
  "Charles 'Charley' Poole Jr. is a Hall of Fame percussion adjudicator, arranger, and educator whose 41-year drum corps career began in 1957 at age six; he won the first of three national individual snare drum championships at 16 and was the Connecticut and Northeastern states individual champion (1966-1969). After staff positions with Boston-area corps he joined the instructional staff of the 27th Lancers of Revere, Massachusetts in 1977, collaborating with George Zingali and Jim Wedge on some of the most celebrated show designs in DCI history. He was unanimously elected to the DCI Task Force on Judging as the percussion instructor representative (1980-1986), consulted with the Star of Indiana (1987) and the Bluecoats (1988), and serves as DCI Atlantic Division percussion caption chairperson. He is the percussion supervisor at Everett High School (MA), a signature artist for Pro-Mark, Evans, Zildjian, and Pearl, and a member of the World Drum Corps, Drum Corps International, and Massachusetts Drum Corps Halls of Fame.";

const lentzBio =
  "Michael Lentz is a color guard designer, instructor, and adjudicator and a 2025 Winter Guard International Hall of Fame inductee with over 40 years in the marching arts. He began in high school marching band in eastern Ohio, marched baritone with the Bluecoats in 1989 and the Steel City Ambassadors senior corps color guard in 1991, and co-founded the independent guard 'Dimension' in 1988 — renamed Onyx in 1996 — a three-time WGI World Champion based in Dayton, Ohio. He helped start the Ohio Indoor Performance Association (Circuit President 2007-2009) and has served on the WGI Color Guard Advisory board since 2001, the WGI Board of Directors, and the WGI Steering Committee. He designs and consults for marching band, winter guard, and DCI, was Artistic Director for the Boston Crusaders' 2014 production, and later led the Troopers' color guard; he adjudicates the color guard caption for Drum Corps International and Bands of America.";

await db.execute({ sql: "UPDATE judges SET biography = ? WHERE judge_id = 'c-poole-1'", args: [pooleBio] });
await db.execute({
  sql: "UPDATE judges SET biography = ?, photo_url = ? WHERE judge_id = 'm-lentz-1'",
  args: [lentzBio, "https://drumcorps.app/judges/michael-lentz.jpg"],
});

const r = await db.execute(
  "SELECT judge_id, length(biography) AS bio, photo_url FROM judges WHERE judge_id IN ('c-poole-1','m-lentz-1')"
);
for (const row of r.rows) console.log(row.judge_id, "bio:", row.bio, "photo:", String(row.photo_url).slice(0, 55));
