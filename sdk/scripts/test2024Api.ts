import { Effect } from "effect";
import { makeDciApiLayer } from "../src/client.js";
import { DciApi } from "../src/service.js";

const test2024 = Effect.gen(function* () {
  const api = yield* (DciApi);
  console.log("Fetching 2024 competitions...");
  const comps = yield* (api.getCompetitions("2024"));
  console.log(`Found ${comps.length} competitions.`);
  if (comps.length > 0) {
    console.log("First comp sample:", JSON.stringify(comps[0], null, 2));
    const slug = comps[0].slug;
    console.log(`Fetching recap for ${slug}...`);
    const recap = yield* (api.getCompetitionRecap(slug));
    console.log(`Found ${recap.length} corps scores.`);
    if (recap.length > 0) {
      const firstScore = recap[0];
      console.log("First score categories sample:", JSON.stringify(firstScore.categories[0], (k, v) => k === 'Subcaptions' ? (v?.length || 0) : v, 2));
      console.log("Does judge have Subcaptions?", firstScore.categories[0].Captions?.[0]?.hasOwnProperty('Subcaptions'));
      console.log("Judge sample keys:", Object.keys(firstScore.categories[0].Captions?.[0] || {}));
    }
  }
});

const ApiLayer = makeDciApiLayer();

Effect.runPromise(test2024.pipe(Effect.provide(ApiLayer))).catch(console.error);
