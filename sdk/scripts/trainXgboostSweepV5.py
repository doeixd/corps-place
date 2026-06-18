import argparse
import argparse
import csv
import json
import math
import os
from typing import Dict, List, Tuple

try:
    import xgboost as xgb
except ImportError as exc:
    raise SystemExit("xgboost is required: pip install xgboost") from exc

CAPTIONS = ["GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"]
NON_FEATURE_COLUMNS = {"season", "split", "corps_key", "competition_slug"}


def parse_args():
    parser = argparse.ArgumentParser(description="XGBoost quantile sweep for V5")
    parser.add_argument("--train", required=True)
    parser.add_argument("--val", required=True)
    parser.add_argument("--out", default="./xgb-sweep-summary.json")
    parser.add_argument("--errors-out", default="./xgb-sweep-errors.json")
    parser.add_argument("--rounds", type=int, default=400)
    parser.add_argument("--early-stopping", type=int, default=40)
    parser.add_argument("--grid-file", help="Optional JSON grid of hyperparameters")
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


def train_quantile(train_x, train_y, val_x, val_y, quantile: float, params, rounds, early_stopping):
    train = xgb.DMatrix(train_x, label=train_y)
    val = xgb.DMatrix(val_x, label=val_y)
    booster = xgb.train(
        params | {"objective": "reg:quantileerror", "quantile_alpha": quantile},
        train,
        num_boost_round=rounds,
        evals=[(val, "val")],
        early_stopping_rounds=early_stopping,
        verbose_eval=False,
    )
    return booster


def main():
    args = parse_args()

    feature_names, train_x, train_targets = load_csv(args.train)
    _, val_x, val_targets = load_csv(args.val)

    default_grid = [
        {"name": "depth4_eta0.05", "max_depth": 4, "eta": 0.05, "subsample": 0.8, "colsample_bytree": 0.8},
        {"name": "depth6_eta0.05", "max_depth": 6, "eta": 0.05, "subsample": 0.8, "colsample_bytree": 0.8},
        {"name": "depth4_eta0.1", "max_depth": 4, "eta": 0.1, "subsample": 0.9, "colsample_bytree": 0.9},
        {"name": "depth6_eta0.1", "max_depth": 6, "eta": 0.1, "subsample": 0.9, "colsample_bytree": 0.9},
    ]

    if args.grid_file:
        with open(args.grid_file, "r", encoding="utf-8") as handle:
            grid = json.load(handle)
    else:
        grid = default_grid

    summary = {
        "feature_count": len(feature_names),
        "grid": [],
    }

    best_config = None
    best_mae = float("inf")
    best_errors: List[float] = []
    best_abs: List[float] = []

    for config in grid:
        config_metrics = {}
        errors: List[float] = []
        abs_errors: List[float] = []

        params = {
            "max_depth": config["max_depth"],
            "eta": config["eta"],
            "subsample": config["subsample"],
            "colsample_bytree": config["colsample_bytree"],
            "seed": 42,
        }

        total_mae = 0
        total_count = 0

        for caption in CAPTIONS:
            train_y = train_targets[caption]
            val_y = val_targets[caption]

            q10 = train_quantile(train_x, train_y, val_x, val_y, 0.1, params, args.rounds, args.early_stopping)
            q50 = train_quantile(train_x, train_y, val_x, val_y, 0.5, params, args.rounds, args.early_stopping)
            q90 = train_quantile(train_x, train_y, val_x, val_y, 0.9, params, args.rounds, args.early_stopping)

            pred10 = q10.predict(xgb.DMatrix(val_x)).tolist()
            pred50 = q50.predict(xgb.DMatrix(val_x)).tolist()
            pred90 = q90.predict(xgb.DMatrix(val_x)).tolist()

            metrics = evaluate_metrics(val_y, pred10, pred50, pred90)
            config_metrics[caption] = metrics
            total_mae += metrics["mae"] * metrics["count"]
            total_count += metrics["count"]

            for actual, pred in zip(val_y, pred50):
                error = pred - actual
                errors.append(error)
                abs_errors.append(abs(error))

        overall_mae = total_mae / total_count
        config_entry = {
            "name": config["name"],
            "params": params,
            "overall_mae": overall_mae,
            "metrics": config_metrics,
        }
        summary["grid"].append(config_entry)

        if overall_mae < best_mae:
            best_mae = overall_mae
            best_config = config_entry
            best_errors = errors
            best_abs = abs_errors

    summary["best"] = best_config

    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(summary, handle, indent=2)
    print(f"Wrote sweep summary to {args.out}")

    if best_config:
        with open(args.errors_out, "w", encoding="utf-8") as handle:
            json.dump({"model": "xgb_sweep_best", "errors": best_errors, "absErrors": best_abs}, handle, indent=2)
        print(f"Wrote best errors to {args.errors_out}")


if __name__ == "__main__":
    main()
