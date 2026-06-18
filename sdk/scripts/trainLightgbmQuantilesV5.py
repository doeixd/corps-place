import argparse
import argparse
import csv
import json
import math
import os
from typing import Dict, List, Tuple

import numpy as np

try:
    import lightgbm as lgb
except ImportError as exc:
    raise SystemExit("lightgbm is required: pip install lightgbm") from exc

CAPTIONS = ["GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"]
NON_FEATURE_COLUMNS = {"season", "split", "corps_key", "competition_slug"}


def parse_args():
    parser = argparse.ArgumentParser(description="Train LightGBM quantile models for V5")
    parser.add_argument("--train", required=True)
    parser.add_argument("--val", required=True)
    parser.add_argument("--outdir", default="./lgb-models-v5")
    parser.add_argument("--num-leaves", type=int, default=31)
    parser.add_argument("--learning-rate", type=float, default=0.05)
    parser.add_argument("--feature-fraction", type=float, default=0.8)
    parser.add_argument("--bagging-fraction", type=float, default=0.8)
    parser.add_argument("--bagging-freq", type=int, default=5)
    parser.add_argument("--rounds", type=int, default=500)
    parser.add_argument("--early-stopping", type=int, default=50)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--errors-out")
    parser.add_argument("--feature-importance-out")
    return parser.parse_args()


def load_csv(path: str) -> Tuple[List[str], List[List[float]], Dict[str, List[float]]]:
    with open(path, "r", newline="") as handle:
        reader = csv.reader(handle)
        header = next(reader)
        if not header:
            raise ValueError("CSV header missing")

        target_cols = {cap: header.index(f"target_{cap}") for cap in CAPTIONS}
        feature_cols = [
            idx
            for idx, name in enumerate(header)
            if not name.startswith("target_") and name not in NON_FEATURE_COLUMNS
        ]
        feature_names = [header[idx] for idx in feature_cols]

        features: List[List[float]] = []
        targets: Dict[str, List[float]] = {cap: [] for cap in CAPTIONS}

        for row in reader:
            if not row:
                continue
            features.append([
                float(row[idx]) if row[idx] not in ("", "nan", "NaN") else 0.0
                for idx in feature_cols
            ])
            for cap in CAPTIONS:
                value = row[target_cols[cap]]
                targets[cap].append(float(value) if value not in ("", "nan", "NaN") else 0.0)

    return feature_names, features, targets


def pinball_loss(q: float, actual: float, pred: float) -> float:
    err = actual - pred
    return max(q * err, (q - 1) * err)


def evaluate_metrics(actual: List[float], p10: List[float], p50: List[float], p90: List[float]):
    n = len(actual)
    mae = sum(abs(a - b) for a, b in zip(actual, p50)) / n
    rmse = math.sqrt(sum((a - b) ** 2 for a, b in zip(actual, p50)) / n)
    ql10 = sum(pinball_loss(0.1, a, p) for a, p in zip(actual, p10)) / n
    ql50 = sum(pinball_loss(0.5, a, p) for a, p in zip(actual, p50)) / n
    ql90 = sum(pinball_loss(0.9, a, p) for a, p in zip(actual, p90)) / n
    coverage = sum(1 for a, lo, hi in zip(actual, p10, p90) if lo <= a <= hi) / n
    return {
        "count": n,
        "mae": mae,
        "rmse": rmse,
        "ql10": ql10,
        "ql50": ql50,
        "ql90": ql90,
        "coverage": coverage,
    }


def train_quantile(train_x, train_y, val_x, val_y, quantile: float, args):
    train = lgb.Dataset(train_x, label=train_y)
    val = lgb.Dataset(val_x, label=val_y)
    params = {
        "objective": "quantile",
        "alpha": quantile,
        "num_leaves": args.num_leaves,
        "learning_rate": args.learning_rate,
        "feature_fraction": args.feature_fraction,
        "bagging_fraction": args.bagging_fraction,
        "bagging_freq": args.bagging_freq,
        "seed": args.seed,
    }
    booster = lgb.train(
        params,
        train,
        num_boost_round=args.rounds,
        valid_sets=[val],
        callbacks=[lgb.early_stopping(args.early_stopping, verbose=False)],
    )
    return booster


def main():
    args = parse_args()
    os.makedirs(args.outdir, exist_ok=True)

    feature_names, train_x, train_targets = load_csv(args.train)
    _, val_x, val_targets = load_csv(args.val)

    train_x = np.asarray(train_x, dtype=np.float32)
    val_x = np.asarray(val_x, dtype=np.float32)

    summary = {"feature_count": len(feature_names), "models": {}, "metrics": {}, "feature_importance": {}}
    errors_payload = {"model": "lightgbm_quantile_v5", "errors": [], "absErrors": []}

    for caption in CAPTIONS:
        print(f"Training {caption}...")
        train_y = np.asarray(train_targets[caption], dtype=np.float32)
        val_y = np.asarray(val_targets[caption], dtype=np.float32)

        models = {}
        predictions = {}
        q50_booster = None

        for quantile in (0.1, 0.5, 0.9):
            booster = train_quantile(train_x, train_y, val_x, val_y, quantile, args)
            model_path = os.path.join(args.outdir, f"{caption}_q{int(quantile*100)}.txt")
            booster.save_model(model_path)
            models[f"q{int(quantile*100)}"] = model_path

            preds = booster.predict(val_x)
            predictions[f"q{int(quantile*100)}"] = preds

            if quantile == 0.5:
                q50_booster = booster

        if q50_booster is not None:
            importance_values = q50_booster.feature_importance(importance_type="gain")
            summary["feature_importance"][caption] = {
                name: float(importance_values[idx]) if idx < len(importance_values) else 0.0
                for idx, name in enumerate(feature_names)
            }

        metrics = evaluate_metrics(
            val_y.tolist(),
            predictions["q10"],
            predictions["q50"],
            predictions["q90"],
        )
        summary["models"][caption] = models
        summary["metrics"][caption] = metrics

        for actual, pred in zip(val_y, predictions["q50"]):
            error = pred - actual
            errors_payload["errors"].append(error)
            errors_payload["absErrors"].append(abs(error))

    summary_path = os.path.join(args.outdir, "summary.json")
    with open(summary_path, "w", encoding="utf-8") as handle:
        json.dump(summary, handle, indent=2)
    print(f"Wrote summary to {summary_path}")

    if args.errors_out:
        with open(args.errors_out, "w", encoding="utf-8") as handle:
            json.dump(errors_payload, handle, indent=2)
        print(f"Wrote errors to {args.errors_out}")

    if args.feature_importance_out:
        with open(args.feature_importance_out, "w", encoding="utf-8") as handle:
            json.dump(summary["feature_importance"], handle, indent=2)
        print(f"Wrote feature importance to {args.feature_importance_out}")


if __name__ == "__main__":
    main()
