// Shared US-map geometry for the tour maps (corps page + /tour explorer).
// Loads d3-geo + topojson-client + the pre-projected us-atlas topology ONCE per
// session (module-level promise cache) — both lazy map bodies import this, so
// navigating corps ↔ /tour reuses the parsed geometry.
//
// Projection contract: us-atlas `states-albers-10m.json` is pre-projected to a
// 975×610 frame; raw lon/lat points project with the documented companion
// geoAlbersUsa().scale(1300).translate([487.5, 305]).

export const VIEW_W = 975;
export const VIEW_H = 610;

export interface MapGeometry {
  statesPath: string;
  nationPath: string;
  project: (lng: number, lat: number) => [number, number] | null;
}

let geometryPromise: Promise<MapGeometry> | null = null;

export const loadGeometry = (): Promise<MapGeometry> => {
  geometryPromise ??= (async () => {
    const [{ geoPath, geoAlbersUsa }, { feature, mesh }, topoRes] = await Promise.all([
      import('d3-geo'),
      import('topojson-client'),
      fetch('/geo/us-states-albers-10m.json'),
    ]);
    const topo = await topoRes.json();
    const path = geoPath(); // identity — topology is pre-projected
    const statesPath =
      path(mesh(topo, topo.objects.states, (a: unknown, b: unknown) => a !== b)) ?? '';
    const nationPath = path(feature(topo, topo.objects.nation)) ?? '';
    const projection = geoAlbersUsa()
      .scale(1300)
      .translate([VIEW_W / 2, VIEW_H / 2]);
    return {
      statesPath,
      nationPath,
      project: (lng: number, lat: number) => projection([lng, lat]) ?? null,
    };
  })();
  return geometryPromise;
};
