// Run with: npx tsx test/v9BreakdownSplitCurves.test.ts
import assert from 'node:assert/strict';
import {
  V9_BREAKDOWN_CAPTIONS,
  type V9BreakdownCaption,
} from '../src/training/v9BreakdownData.js';
import {
  V9_BREAKDOWN_SPLIT_CURVE_VERSION,
  blendV9BreakdownContentShare,
  splitV9RecapWithCurvesAndPrior,
  splitV9RecapWithCurves,
  validateV9BreakdownSplitCurveArtifact,
  type V9BreakdownSplitCurveArtifact,
} from '../src/training/v9BreakdownSplitCurves.js';

const makeCurve = (contentShare: number) => ({
  count: 100,
  contentShare,
  points: [
    {
      percentThroughSeason: 0,
      contentShare,
      rawContentShare: contentShare,
      count: 100,
      medianContentShare: contentShare,
      stdContentShare: 0.001,
      q10ContentShare: contentShare - 0.001,
      q90ContentShare: contentShare + 0.001,
    },
    {
      percentThroughSeason: 100,
      contentShare: contentShare - 0.004,
      rawContentShare: contentShare - 0.004,
      count: 100,
      medianContentShare: contentShare - 0.004,
      stdContentShare: 0.001,
      q10ContentShare: contentShare - 0.005,
      q90ContentShare: contentShare - 0.003,
    },
  ],
});

const fixtureArtifact = (): V9BreakdownSplitCurveArtifact => ({
  version: V9_BREAKDOWN_SPLIT_CURVE_VERSION,
  generatedAt: '2026-06-05T00:00:00.000Z',
  source: {
    dbPath: 'fixture.db',
    sourceV9ModelId: 'v9-real-fixture',
    anchorMode: 'v9_predicted',
    rowCount: 1,
    pairCount: 8,
  },
  config: {
    bucketSize: 10,
    minShare: 0.49,
    maxShare: 0.53,
    divisionCaptionPrior: 20,
    captionPrior: 80,
    divisionPrior: 40,
    globalPrior: 80,
  },
  global: makeCurve(0.508),
  byCaption: Object.fromEntries(
    V9_BREAKDOWN_CAPTIONS.map((caption, idx) => [caption, makeCurve(0.508 + idx * 0.0002)])
  ) as Record<V9BreakdownCaption, ReturnType<typeof makeCurve>>,
  byDivision: {
    'World Class': makeCurve(0.509),
  },
  byDivisionCaption: Object.fromEntries(
    V9_BREAKDOWN_CAPTIONS.map((caption, idx) => [
      `World Class|${caption}`,
      makeCurve(0.51 + idx * 0.0002),
    ])
  ),
});

const assertSplitPreservesTotal = () => {
  const artifact = validateV9BreakdownSplitCurveArtifact(fixtureArtifact());
  const captions = Object.fromEntries(
    V9_BREAKDOWN_CAPTIONS.map((caption, idx) => [caption, 12.345 + idx * 0.321])
  ) as Record<V9BreakdownCaption, number>;
  const breakdown = splitV9RecapWithCurves(artifact, {
    divisionName: 'World Class',
    percentThroughSeason: 42,
    captions,
  });

  for (const caption of V9_BREAKDOWN_CAPTIONS) {
    const pair = breakdown[caption];
    assert.equal(
      Number((pair.content + pair.achievement).toFixed(4)),
      Number(captions[caption]!.toFixed(4)),
      `${caption} split should preserve caption total`
    );
    assert.ok(pair.contentShare >= artifact.config.minShare, `${caption} share should respect min clamp`);
    assert.ok(pair.contentShare <= artifact.config.maxShare, `${caption} share should respect max clamp`);
  }
};

const assertValidationRejectsStaleArtifact = () => {
  const artifact = { ...fixtureArtifact(), version: 'old-version' };
  assert.throws(
    () => validateV9BreakdownSplitCurveArtifact(artifact),
    /unsupported version/
  );
};

const assertPriorBlendInvariants = () => {
  const artifact = validateV9BreakdownSplitCurveArtifact(fixtureArtifact());
  const captions = Object.fromEntries(
    V9_BREAKDOWN_CAPTIONS.map((caption, idx) => [caption, 14 + idx * 0.1])
  ) as Record<V9BreakdownCaption, number>;

  const curveOnly = splitV9RecapWithCurvesAndPrior(artifact, {
    divisionName: 'World Class',
    percentThroughSeason: 20,
    captions,
    priorBlendConfig: { enabled: true },
  });
  for (const caption of V9_BREAKDOWN_CAPTIONS) {
    assert.equal(curveOnly[caption].splitSource, 'curve_only');
    assert.equal(curveOnly[caption].priorWeight, 0);
    assert.equal(
      Number((curveOnly[caption].content + curveOnly[caption].achievement).toFixed(4)),
      Number(captions[caption]!.toFixed(4))
    );
  }

  const blended = splitV9RecapWithCurvesAndPrior(artifact, {
    divisionName: 'World Class',
    percentThroughSeason: 20,
    captions,
    priors: {
      GE1: {
        count: 3,
        meanShare: 0.52,
        emaShare: 0.521,
        latestShare: 0.522,
        stdShare: 0.002,
        daysSinceLatest: 5,
      },
    },
    priorBlendConfig: { enabled: true },
  });
  assert.equal(blended.GE1.splitSource, 'curve_prior_blend');
  assert.ok(blended.GE1.priorWeight > 0);
  assert.ok(blended.GE1.contentShare > blended.GE1.curveShare);
  assert.equal(
    Number((blended.GE1.content + blended.GE1.achievement).toFixed(4)),
    Number(captions.GE1.toFixed(4))
  );

  const stale = blendV9BreakdownContentShare(
    0.51,
    { count: 3, meanShare: 0.52, latestShare: 0.52, daysSinceLatest: 100 },
    { ...artifact.config, enabled: true, baseWeight: 0.35, maxWeight: 0.4, strongCount: 3, emaAlpha: 0.55, maxPriorAgeDays: 45 }
  );
  assert.equal(stale.priorWeight, 0);
  assert.equal(stale.finalShare, stale.curveShare);
};

assertSplitPreservesTotal();
assertValidationRejectsStaleArtifact();
assertPriorBlendInvariants();
console.log('v9BreakdownSplitCurves tests passed');
