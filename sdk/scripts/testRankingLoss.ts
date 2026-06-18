import * as tf from "@tensorflow/tfjs-node";

function rankNetLoss(totalTrue: tf.Tensor2D, totalPred: tf.Tensor2D, showIds: tf.Tensor2D) {
  return tf.tidy(() => {
    const totalTrueFlat = totalTrue.reshape([-1]);
    const totalPredFlat = totalPred.reshape([-1]);
    const showIdsFlat = showIds.reshape([-1]).toInt();

    const diffTrue = tf.sub(totalTrueFlat.expandDims(1), totalTrueFlat.expandDims(0));
    const diffPred = tf.sub(totalPredFlat.expandDims(1), totalPredFlat.expandDims(0));

    const idRow = showIdsFlat.expandDims(1);
    const idCol = showIdsFlat.expandDims(0);
    const sameShow = tf.equal(idRow, idCol);

    const idx = tf.range(0, totalTrueFlat.shape[0] ?? 0, 1, "int32");
    const row = idx.expandDims(1);
    const col = idx.expandDims(0);
    const lowerTri = tf.greater(row, col);

    const pairMask = tf.logicalAnd(sameShow, lowerTri);
    const maskFloat = tf.cast(pairMask, "float32");

    const zeroMask = tf.equal(diffTrue, 0);
    const gtMask = tf.greater(diffTrue, 0);
    const target = tf.add(
      tf.cast(gtMask, "float32"),
      tf.mul(tf.cast(zeroMask, "float32"), tf.scalar(0.5))
    );

    const predProb = tf.clipByValue(tf.sigmoid(diffPred), 1e-7, 1 - 1e-7);
    const lossMatrix = tf.neg(
      tf.add(
        tf.mul(target, tf.log(predProb)),
        tf.mul(tf.sub(tf.scalar(1), target), tf.log(tf.sub(tf.scalar(1), predProb)))
      )
    );

    const maskedLoss = tf.mul(lossMatrix, maskFloat);
    const denom = tf.maximum(tf.sum(maskFloat), tf.scalar(1));
    return tf.div(tf.sum(maskedLoss), denom);
  });
}

async function main() {
  const showIds = tf.tensor2d([1, 1, 2, 2], [4, 1], "int32");
  const totalTrue = tf.tensor2d([10, 9, 8, 7], [4, 1], "float32");

  const predPerfect = tf.tensor2d([10, 9, 8, 7], [4, 1], "float32");
  const predInverted = tf.tensor2d([9, 10, 7, 8], [4, 1], "float32");

  const lossPerfect = rankNetLoss(totalTrue, predPerfect, showIds);
  const lossInverted = rankNetLoss(totalTrue, predInverted, showIds);

  const perfectVal = (await lossPerfect.data())[0] ?? 0;
  const invertedVal = (await lossInverted.data())[0] ?? 0;

  console.log(`RankNet loss (perfect): ${perfectVal.toFixed(6)}`);
  console.log(`RankNet loss (inverted): ${invertedVal.toFixed(6)}`);

  if (perfectVal >= invertedVal) {
    throw new Error("RankNet loss test failed: perfect ordering should have lower loss.");
  }

  lossPerfect.dispose();
  lossInverted.dispose();
  showIds.dispose();
  totalTrue.dispose();
  predPerfect.dispose();
  predInverted.dispose();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
