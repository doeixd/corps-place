import { Effect } from "effect";
import { makeDciApiLayer } from "../src/client.js";
import { DciApi } from "../src/service.js";

const test2021 = Effect.gen(function* () {
  const api = yield* (DciApi);
  console.log("Fetching 2021 seasons...");
  const seasons = yield* (api.getSeasons());
  console.log("Seasons:", seasons);

  console.log("Fetching 2021 competitions...");
  const comps = yield* (api.getCompetitions("2021"));
  console.log(`Found ${comps.length} competitions.`);
  if (comps.length > 0) {
    const released = comps.filter(c => c.recapReleased);
    console.log(`Competitions with recaps: ${released.length}`);
    if (released.length > 0) {
      const slug = released[0].slug;
      console.log(`Fetching recap for ${slug}...`);
      const recap = yield* (api.getCompetitionRecap(slug));
      console.log(`Found ${recap.length} corps scores.`);
      if (recap.length > 0) {
        console.log("First score category keys:", Object.keys(recap[0].categories[0]));
        console.log("First judge keys:", Object.keys(recap[0].categories[0].Captions?.[0] || {}));
      }
    }
  }
});

const ApiLayer = makeDciApiLayer();
Effect.runPromise(test2021.pipe(Effect.provide(ApiLayer))).catch(console.error);
