import { parseBioFacts } from "../src/bioFactsParse.js";

const cases: { bio: string; expect: string[] }[] = [
  // The two famous mis-grounds — must yield NO performed corps:
  { bio: "Matt Harloff joined Carolina Crown as Brass Caption Head in 2003, building CrownBRASS into an elite program. He performed with Star of Indiana (1989-1995), serving as drum major in 1993, and later taught on The Cadets' brass staff.", expect: [] },
  { bio: "George Hopkins joined the Garfield Cadets as a percussion instructor in 1979 and later served as director of The Cadets.", expect: [] },
  // True positives — must STILL be captured:
  { bio: "He marched with the Blue Devils from 2010 to 2013 before pursuing a teaching career.", expect: ["Blue Devils"] },
  { bio: "A proud member of the Santa Clara Vanguard (2005-2008), she aged out in 2008.", expect: ["Santa Clara Vanguard"] },
  { bio: "Marched with the Cadets (1998-2001) before joining the Crossmen staff as a brass tech.", expect: ["Cadets"] },
  { bio: "He performed with the Phantom Regiment in 2015 and toured with the Bluecoats in 2016.", expect: ["Phantom Regiment", "Bluecoats"] },
];

let pass = 0;
for (const c of cases) {
  const got = parseBioFacts(c.bio).performed.map((p) => `${p.group}${p.startYear ? ` ${p.startYear}-${p.endYear ?? ""}` : ""}`);
  const groups = parseBioFacts(c.bio).performed.map((p) => p.group);
  const ok = JSON.stringify(groups.sort()) === JSON.stringify([...c.expect].sort());
  console.log(`${ok ? "PASS" : "FAIL"}  expect=[${c.expect.join(", ")}]  got=[${got.join(", ")}]`);
  if (ok) pass++;
}
console.log(`\n${pass}/${cases.length} passed`);
process.exit(pass === cases.length ? 0 : 1);
