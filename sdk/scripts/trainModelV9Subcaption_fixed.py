import argparse
import csv
import json
import math
import os
import random
import sqlite3
import time
from dataclasses import dataclass
from typing import Dict, Generator, Iterable, List, Optional, Tuple

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

DB_PATH = "./dci-relational.db"
MODEL_DIR = "./models/v9_subcaption_fixed"
NORM_PATH = "./results/v9-subcaption-target-norm.json"
JUDGE_INDEX_PATH = "./src/training/judgeIndexMap.json"
CORPS_INDEX_PATH = "./src/training/corpsIndexMap.json"

CAPTIONS = ["GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"]
CAPTION_COUNT = len(CAPTIONS)
SEQ_LEN = 15
FEAT_DIM = 101
RAW_STATIC_DIM = 169

TREND_DIM = CAPTION_COUNT
CONTEXT_DIM = 0
TOTAL_STATIC_DIM = RAW_STATIC_DIM + TREND_DIM + CONTEXT_DIM

BATCH_SIZE = 128
EPOCHS = 800
EARLY_STOPPING_PATIENCE = 100
REDUCE_LR_PATIENCE = 20
PADDING_INDEX = 3

WIDTH_FLOOR_PTS = 0.5
WIDTH_FLOOR_WEIGHT = 1.5
SCORE_COVERAGE_TARGET = 0.8
SCORE_COVERAGE_WEIGHT = 0.2
EMA_ALPHA = 0.3
RECAP_OFFSET_IN_FEATS = 21
CAPTION_STRIDE = 4
CAPTION_SCORE_SCALE = 20
SAMPLES_PER_EPOCH = 4096

WIDTH_TARGET_PTS = 2.5
UNK_CORPS_ID = 0
DELTA_DIM = CAPTION_COUNT * 3
RECAP_DIM = CAPTION_COUNT
CATEGORY_DIM = 3
TOTAL_DIM = 1
OUTPUT_DIM = DELTA_DIM + RECAP_DIM + CATEGORY_DIM + TOTAL_DIM
TARGET_DIM = CAPTION_COUNT + RECAP_DIM + CATEGORY_DIM + TOTAL_DIM
BASELINE_DROPOUT_RATE = 0.1
BASELINE_NOISE_STD_PTS = 0.25


def denormalize(value: float, mean: float, std: float) -> float:
    return value * (std if std > 1e-6 else 1.0) + mean


def seeded_random(seed: int):
    s = seed

    def rng():
        nonlocal s
        s = (s * 9301 + 49297) % 233280
        return s / 233280

    return rng


def gaussian_random(rng) -> float:
    u = 0.0
    v = 0.0
    while u == 0:
        u = rng()
    while v == 0:
        v = rng()
    return math.sqrt(-2.0 * math.log(u)) * math.cos(2.0 * math.pi * v)


def shuffle_array(items: List, rng) -> List:
    result = list(items)
    for i in range(len(result) - 1, 0, -1):
        j = int(rng() * (i + 1))
        result[i], result[j] = result[j], result[i]
    return result


def mean(values: List[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def std(values: List[float]) -> float:
    if len(values) < 2:
        return 0.0
    avg = mean(values)
    variance = sum((v - avg) ** 2 for v in values) / (len(values) - 1)
    return math.sqrt(variance)


def compute_ema(values: List[float], alpha: float) -> float:
    if not values:
        return 0.0
    ema = values[0]
    for v in values[1:]:
        ema = alpha * v + (1 - alpha) * ema
    return ema


def coverage_weight(epoch: int, start: int, ramp: int, max_w: float) -> float:
    if epoch < start:
        return 0.0
    t = min(1.0, (epoch - start) / max(1, ramp))
    return max_w * t * t * (3 - 2 * t)


def normalize_value(value: float, mean_value: float, std_value: float) -> float:
    if not math.isfinite(std_value) or std_value < 1e-6:
        return 0.0
    return (value - mean_value) / std_value


def get_recap_from_step(step: List[float], caption_index: int) -> float:
    normalized_score = step[RECAP_OFFSET_IN_FEATS + 2 + caption_index * CAPTION_STRIDE] if step else 0.0
    return normalized_score * CAPTION_SCORE_SCALE


def predict_quadratic(history: List[float], fallback: float) -> float:
    if len(history) < 3:
        return fallback
    points = history[-min(10, len(history)) :]
    n = len(points)
    sx = sx2 = sx3 = sx4 = 0.0
    sy = sxy = sx2y = 0.0
    for i, y in enumerate(points):
        x = float(i)
        x2 = x * x
        x3 = x2 * x
        x4 = x2 * x2
        sx += x
        sx2 += x2
        sx3 += x3
        sx4 += x4
        sy += y
        sxy += x * y
        sx2y += x2 * y
    sx1 = sx
    det = sx4 * (sx2 * n - sx1 * sx1) - sx3 * (sx3 * n - sx1 * sx2) + sx2 * (sx3 * sx1 - sx2 * sx2)
    if abs(det) < 1e-10:
        return fallback
    det_a = sx2y * (sx2 * n - sx1 * sx1) - sxy * (sx3 * n - sx1 * sx2) + sy * (sx3 * sx1 - sx2 * sx2)
    det_b = sx4 * (sxy * n - sy * sx1) - sx3 * (sx2y * n - sy * sx2) + sx2 * (sx2y * sx1 - sxy * sx2)
    det_c = sx4 * (sx2 * sy - sx1 * sxy) - sx3 * (sx3 * sy - sx1 * sx2y) + sx2 * (sx3 * sxy - sx2 * sx2y)
    a = det_a / det
    b = det_b / det
    c = det_c / det
    x_next = float(n)
    return a * x_next * x_next + b * x_next + c

@dataclass
class DataRow:
    seq: List[List[float]]
    seq_mask: List[bool]
    stat: List[float]
    judge_indices: List[int]
    corps_id: int
    recap: List[float]
    total: float
    agnostic_show_id: int
    division: str
    split: str
    context_features: List[float]
    date: str
    show_key: str
    global_baseline: List[float]
    trend_slopes: List[float]


@dataclass
class TargetStats:
    delta_mean: List[float]
    delta_std: List[float]
    recap_mean: List[float]
    recap_std: List[float]
    category_mean: List[float]
    category_std: List[float]
    total_mean: float
    total_std: float
    delta_weights: List[float]
    recap_weights: List[float]


@dataclass
class Sample:
    xs: List
    ys: List[float]


class V9LossScheduler:
    def get_weights(self, epoch: int):
        if epoch < 20:
            return {
                "totalWeight": 0.05,
                "recapWeight": 1.0,
                "deltaWeight": 0.2,
                "categoryWeight": 0.05,
                "quantileWeight": 0.02,
                "consistencyWeight": 0.0,
                "identityDropoutRate": 0.95,
            }
        if epoch < 60:
            t = (epoch - 20) / 40
            return {
                "totalWeight": 0.0,
                "recapWeight": 1.0 - 0.7 * t,
                "deltaWeight": 0.2 + 0.8 * t,
                "categoryWeight": 0.05,
                "quantileWeight": 0.02 + 0.08 * t,
                "consistencyWeight": 0.0,
                "identityDropoutRate": 0.95,
            }
        t = min(1.0, (epoch - 60) / 250)
        id_drop = 1.0 if epoch < 100 else max(0.05, 1.0 - 0.95 * ((epoch - 100) / 200))
        return {
            "totalWeight": 0.10,
            "recapWeight": 0.05,
            "deltaWeight": 10.0,
            "categoryWeight": 0.05,
            "quantileWeight": 0.10 + 0.90 * t,
            "consistencyWeight": 0.0,
            "identityDropoutRate": id_drop,
        }

    def get_scales(self, epoch: int):
        judge_bias = min(1.0, epoch / 60)
        corps = 0 if epoch < 40 else min(1.0, (epoch - 40) / 50)
        return {"judgeBias": judge_bias, "corps": corps}

    def get_width_floor_weight(self, epoch: int, start_weight: float, end_weight: float) -> float:
        if epoch < 20:
            return start_weight
        if epoch < 60:
            t = (epoch - 20) / 40
            smooth = t * t * (3 - 2 * t)
            return start_weight + (end_weight - start_weight) * smooth
        return end_weight


class SequenceDataProviderV9:
    def __init__(self, rows: List[DataRow], epoch: int, batch_size: int = BATCH_SIZE):
        self.rows = rows
        self.epoch = epoch
        self.batch_size = batch_size
        self.world_rows = [r for r in rows if r.division == "World Class"]
        self.open_rows = [r for r in rows if r.division == "Open Class"]
        self.world_shows = self._group_by_show(self.world_rows)
        self.open_shows = self._group_by_show(self.open_rows)
        self.all_shows = self._group_by_show(self.rows)

    def set_epoch(self, epoch: int):
        self.epoch = epoch

    def get_sequence_length(self) -> int:
        return 5 if self.epoch < 20 else 15

    def sample_rows(self, count: int, seed: int) -> List[DataRow]:
        if not self.open_shows:
            return self._flatten_shows(self._sample_shows(self.all_shows, count, seed))
        open_count = int(count * 0.25)
        world_count = count - open_count
        world_sample = self._sample_shows(self.world_shows, world_count, seed)
        open_sample = self._sample_shows(self.open_shows, open_count, seed + 1)
        merged = self._shuffle(world_sample + open_sample, seed + 2)
        return self._flatten_shows(merged)

    def _group_by_show(self, rows: List[DataRow]) -> List[List[DataRow]]:
        show_map: Dict[str, List[DataRow]] = {}
        for row in rows:
            show_map.setdefault(row.show_key, []).append(row)
        return list(show_map.values())

    def _sample_shows(self, shows: List[List[DataRow]], target_count: int, seed: int) -> List[List[DataRow]]:
        if not shows:
            return []
        shuffled = self._shuffle(list(shows), seed)
        picked = []
        count = 0
        for show in shuffled:
            picked.append(show)
            count += len(show)
            if count >= target_count:
                break
        return picked

    def _flatten_shows(self, shows: List[List[DataRow]]) -> List[DataRow]:
        return [row for show in shows for row in show]

    def _shuffle(self, items: List, seed: int) -> List:
        result = list(items)
        for i in range(len(result) - 1, 0, -1):
            j = int(self._seeded_random(seed) * (i + 1))
            seed += 1
            result[i], result[j] = result[j], result[i]
        return result

    def _seeded_random(self, seed: int) -> float:
        x = math.sin(seed) * 10000
        return x - math.floor(x)


def build_data_rows(raw_rows: List[Dict]) -> List[DataRow]:
    shows: Dict[str, List[Dict]] = {}
    for row in raw_rows:
        key = f"{row['season']}_{row.get('competition_slug') or 'unknown'}_{row['competition_date']}"
        shows.setdefault(key, []).append(row)
    data_rows: List[DataRow] = []
    for show_key, show_rows in shows.items():
        parsed_show = []
        for r in show_rows:
            recap = json.loads(r["y_recap_json"])
            total = (recap.get("GE1", 0) + recap.get("GE2", 0)) + (
                (recap.get("VP", 0) + recap.get("VA", 0) + recap.get("CG", 0)) / 2
            ) + (
                (recap.get("MB", 0) + recap.get("MA", 0) + recap.get("MP", 0)) / 2
            )
            parsed_show.append((r, recap, total))
        for row, recap, total in parsed_show:
            raw_seq = json.loads(row["x_sequence_json"])
            seq_mask = [step[PADDING_INDEX] != 1 for step in raw_seq]
            seq = [
                ([0.0] * FEAT_DIM if step[PADDING_INDEX] == 1 else step)
                for step in raw_seq
            ]
            stat = json.loads(row["x_static_json"])
            judge_indices = json.loads(row["judge_indices_json"])
            agnostic_show_id = row.get("agnostic_show_id", 0) or 0
            if len(seq) != SEQ_LEN or (seq and len(seq[0]) != FEAT_DIM):
                continue
            if len(stat) != RAW_STATIC_DIM:
                continue
            recap_values = [float(recap.get(cap, 0)) for cap in CAPTIONS]
            data_rows.append(
                DataRow(
                    seq=seq,
                    seq_mask=seq_mask,
                    stat=stat,
                    judge_indices=judge_indices,
                    corps_id=int(row.get("corps_id") or 0),
                    recap=recap_values,
                    total=float(total),
                    agnostic_show_id=int(agnostic_show_id),
                    division=row["division_name"],
                    split=row["split"],
                    context_features=[],
                    date=row["competition_date"],
                    show_key=show_key,
                    global_baseline=[],
                    trend_slopes=[],
                )
            )
    return data_rows


def apply_baselines(rows: List[DataRow], history_rows: List[DataRow]):
    history_set = {id(row) for row in history_rows}
    corps_map: Dict[int, List[DataRow]] = {}
    for row in rows:
        corps_map.setdefault(row.corps_id, []).append(row)
    for corps_id, corps_rows in corps_map.items():
        corps_rows.sort(key=lambda r: (r.date, r.show_key))
        ema: List[Optional[float]] = [None] * CAPTION_COUNT
        recap_history: List[List[float]] = [[] for _ in range(CAPTION_COUNT)]
        for row in corps_rows:
            row.global_baseline = [v if v is not None else 0.0 for v in ema]
            slopes: List[float] = []
            for i in range(CAPTION_COUNT):
                history = recap_history[i]
                last3 = history[-3:]
                slope = (last3[-1] - last3[0]) / (len(last3) - 1) / 0.1 if len(last3) >= 2 else 0.0
                slopes.append(slope)
            row.trend_slopes = slopes
            if id(row) not in history_set:
                continue
            for i in range(CAPTION_COUNT):
                val = row.recap[i]
                if val is not None:
                    if ema[i] is None:
                        ema[i] = val
                    else:
                        ema[i] = EMA_ALPHA * val + (1 - EMA_ALPHA) * ema[i]
                    recap_history[i].append(val)
                    if len(recap_history[i]) > 3:
                        recap_history[i].pop(0)


def compute_target_stats(rows: List[DataRow]) -> TargetStats:
    delta_series = [[] for _ in range(CAPTION_COUNT)]
    recap_series = [[] for _ in range(CAPTION_COUNT)]
    category_series = [[] for _ in range(3)]
    total_series: List[float] = []
    for row in rows:
        baseline = row.global_baseline
        for idx in range(CAPTION_COUNT):
            raw_recap = row.recap[idx] if idx < len(row.recap) else 0.0
            baseline_raw = baseline[idx] if idx < len(baseline) else 0.0
            delta_raw = raw_recap - baseline_raw
            delta_series[idx].append(delta_raw)
            recap_series[idx].append(raw_recap)
        ge = (row.recap[0] if row.recap else 0.0) + (row.recap[1] if row.recap else 0.0)
        visual = ((row.recap[2] if row.recap else 0.0) + (row.recap[3] if row.recap else 0.0) + (row.recap[4] if row.recap else 0.0)) / 2
        music = ((row.recap[5] if row.recap else 0.0) + (row.recap[6] if row.recap else 0.0) + (row.recap[7] if row.recap else 0.0)) / 2
        category_series[0].append(ge)
        category_series[1].append(visual)
        category_series[2].append(music)
        total_series.append(row.total)
    delta_mean = [mean(vals) for vals in delta_series]
    delta_std = [std(vals) for vals in delta_series]
    recap_mean = [mean(vals) for vals in recap_series]
    recap_std = [std(vals) for vals in recap_series]
    category_mean = [mean(vals) for vals in category_series]
    category_std = [std(vals) for vals in category_series]
    total_mean = mean(total_series)
    total_std = std(total_series)
    min_std = 0.25
    delta_weights = [1 / max(v, min_std) for v in delta_std]
    recap_weights = [1 / max(v, min_std) for v in recap_std]
    return TargetStats(
        delta_mean=delta_mean,
        delta_std=delta_std,
        recap_mean=recap_mean,
        recap_std=recap_std,
        category_mean=category_mean,
        category_std=category_std,
        total_mean=total_mean,
        total_std=total_std,
        delta_weights=delta_weights,
        recap_weights=recap_weights,
    )


def compute_baseline_mae(samples: List[Sample], stats: TargetStats):
    zero_sum = mean_sum = ema_sum = quad_sum = 0.0
    count = 0
    for sample in samples:
        seq = sample.xs[0]
        mask = sample.xs[2]
        steps = [step for idx, step in enumerate(seq) if (mask[idx] == 1 if mask else any(v != 0 for v in step))]
        for idx in range(CAPTION_COUNT):
            truth_recap_norm = sample.ys[CAPTION_COUNT + idx] if CAPTION_COUNT + idx < len(sample.ys) else 0.0
            actual = denormalize(truth_recap_norm, stats.recap_mean[idx], stats.recap_std[idx])
            history_full = [get_recap_from_step(step, idx) for step in steps]
            history = history_full[:-1] if history_full else []
            ema = compute_ema(history, EMA_ALPHA) if history else 0.0
            mean_pred = stats.recap_mean[idx]
            quad_pred = predict_quadratic(history, mean_pred)
            zero_sum += abs(actual)
            mean_sum += abs(actual - mean_pred)
            ema_sum += abs(actual - ema)
            quad_sum += abs(actual - quad_pred)
            count += 1
    return {
        "baselineZero": zero_sum / count if count else 0.0,
        "baselineMean": mean_sum / count if count else 0.0,
        "baselineEma": ema_sum / count if count else 0.0,
        "baselineQuad": quad_sum / count if count else 0.0,
    }


def build_samples(
    rows: List[DataRow],
    stats: TargetStats,
    seq_len: int,
    identity_dropout_rate: float,
    seed: int,
    epoch: int = 0,
    baseline_dropout_rate: float = BASELINE_DROPOUT_RATE,
    baseline_noise_std: float = BASELINE_NOISE_STD_PTS,
) -> Tuple[List[Sample], int]:
    samples: List[Sample] = []
    rng = seeded_random(seed)
    agnostic_show_set = {row.agnostic_show_id for row in rows}
    unique_show_count = max(1, max(agnostic_show_set) + 1 if agnostic_show_set else 1)
    show_id_map: Dict[str, int] = {}
    show_id_counter = 0
    for row in rows:
        sliced_seq = row.seq[-seq_len:]
        sliced_mask = [1 if v else 0 for v in row.seq_mask[-seq_len:]]
        while len(sliced_seq) < SEQ_LEN:
            sliced_seq.insert(0, [0.0] * FEAT_DIM)
            sliced_mask.insert(0, 0)
        last_valid_idx = len(sliced_mask) - 1 - sliced_mask[::-1].index(1) if 1 in sliced_mask else -1
        last_score_baseline: Optional[List[float]] = None
        if last_valid_idx != -1:
            original_step = sliced_seq[last_valid_idx]
            last_score_baseline = [
                (original_step[RECAP_OFFSET_IN_FEATS + i * CAPTION_STRIDE + 2] or 0.0) * CAPTION_SCORE_SCALE
                for i in range(CAPTION_COUNT)
            ]
            step = list(original_step)
            for i in range(CAPTION_COUNT):
                base = RECAP_OFFSET_IN_FEATS + i * CAPTION_STRIDE
                for j in range(CAPTION_STRIDE):
                    step[base + j] = 0.0
            sliced_seq[last_valid_idx] = step
        baseline_raw_vector = row.global_baseline
        baseline_norm_vector: List[float] = []
        baseline_input_raw = list(last_score_baseline) if last_score_baseline else list(baseline_raw_vector)
        if last_score_baseline:
            for idx in range(CAPTION_COUNT):
                if baseline_input_raw[idx] == 0:
                    baseline_input_raw[idx] = baseline_raw_vector[idx] if idx < len(baseline_raw_vector) else stats.recap_mean[idx]
        if baseline_dropout_rate > 0 and rng() < baseline_dropout_rate:
            for idx in range(CAPTION_COUNT):
                baseline_input_raw[idx] = stats.recap_mean[idx]
        if baseline_noise_std > 0:
            for idx in range(CAPTION_COUNT):
                baseline_input_raw[idx] += gaussian_random(rng) * baseline_noise_std
        delta_targets: List[float] = []
        recap_values: List[float] = []
        for idx in range(CAPTION_COUNT):
            baseline_input = baseline_input_raw[idx]
            baseline_norm = normalize_value(baseline_input, stats.recap_mean[idx], stats.recap_std[idx])
            baseline_norm_vector.append(baseline_norm)
            raw_recap = row.recap[idx]
            delta_raw = raw_recap - baseline_input
            normalized_delta = normalize_value(delta_raw, stats.delta_mean[idx], stats.delta_std[idx])
            delta_targets.append(normalized_delta)
            normalized_recap = normalize_value(raw_recap, stats.recap_mean[idx], stats.recap_std[idx])
            recap_values.append(normalized_recap)
        ge_raw = (row.recap[0] if row.recap else 0.0) + (row.recap[1] if row.recap else 0.0)
        visual_raw = ((row.recap[2] if row.recap else 0.0) + (row.recap[3] if row.recap else 0.0) + (row.recap[4] if row.recap else 0.0)) / 2
        music_raw = ((row.recap[5] if row.recap else 0.0) + (row.recap[6] if row.recap else 0.0) + (row.recap[7] if row.recap else 0.0)) / 2
        category_targets = [
            normalize_value(ge_raw, stats.category_mean[0], stats.category_std[0]),
            normalize_value(visual_raw, stats.category_mean[1], stats.category_std[1]),
            normalize_value(music_raw, stats.category_mean[2], stats.category_std[2]),
        ]
        normalized_total = normalize_value(row.total, stats.total_mean, stats.total_std or 1.0)
        valid_steps = [step for i, step in enumerate(sliced_seq) if sliced_mask[i] == 1]
        history_len = max(0, len(valid_steps) - 1)
        trend_features = row.trend_slopes
        if row.corps_id < 0:
            raise ValueError(f"corps_id out of range: {row.corps_id}")
        if (epoch == 0 or epoch % 50 == 0) and rng() < 1 / 64 and valid_steps:
            last_step = valid_steps[-1]
            for idx in range(CAPTION_COUNT):
                base = RECAP_OFFSET_IN_FEATS + idx * CAPTION_STRIDE
                for j in range(CAPTION_STRIDE):
                    value = last_step[base + j] if last_step else 0.0
                    if value != 0:
                        raise ValueError(
                            f"TREND ASSERTION FAILED: Last valid step has non-zero caption feature at caption {idx}, offset {j}: {value}"
                        )
        corps_id = UNK_CORPS_ID if rng() < identity_dropout_rate else row.corps_id
        show_id = show_id_map.get(row.show_key)
        if show_id is None:
            show_id = show_id_counter
            show_id_map[row.show_key] = show_id
            show_id_counter += 1
        agnostic_show_id = 0 if rng() < 0.2 else row.agnostic_show_id
        samples.append(
            Sample(
                xs=[
                    sliced_seq,
                    list(row.stat) + list(trend_features) + list(row.context_features),
                    sliced_mask,
                    row.judge_indices,
                    corps_id,
                    baseline_norm_vector,
                    history_len,
                    show_id,
                    agnostic_show_id,
                ],
                ys=delta_targets + recap_values + category_targets + [normalized_total],
            )
        )
    return samples, unique_show_count


def batch_generator(
    samples: List[Sample],
    batch_size: int,
    shuffle: bool,
    seed: int,
    scales: Dict[str, float],
    device: torch.device,
) -> Generator[Tuple[Dict[str, torch.Tensor], torch.Tensor, List[Sample]], None, None]:
    rng = seeded_random(seed)
    show_map: Dict[int, List[Sample]] = {}
    for sample in samples:
        show_id = sample.xs[7]
        show_map.setdefault(show_id, []).append(sample)
    show_groups = list(show_map.values())
    ordered_shows = shuffle_array(show_groups, rng) if shuffle else show_groups
    batch: List[Sample] = []
    for show_samples in ordered_shows:
        if batch and len(batch) + len(show_samples) > batch_size:
            yield build_batch_tensors(batch, scales, device), build_targets(batch, device), batch
            batch = []
        if len(show_samples) > batch_size and not batch:
            yield build_batch_tensors(show_samples, scales, device), build_targets(show_samples, device), show_samples
            continue
        batch.extend(show_samples)
    if batch:
        yield build_batch_tensors(batch, scales, device), build_targets(batch, device), batch


def build_batch_tensors(batch_samples: List[Sample], scales: Dict[str, float], device: torch.device) -> Dict[str, torch.Tensor]:
    batch_size = len(batch_samples)
    sequence = np.zeros((batch_size, SEQ_LEN, FEAT_DIM), dtype=np.float32)
    static = np.zeros((batch_size, TOTAL_STATIC_DIM), dtype=np.float32)
    mask = np.zeros((batch_size, SEQ_LEN), dtype=np.float32)
    judge_ids = np.zeros((batch_size, CAPTION_COUNT), dtype=np.int64)
    corps_id = np.zeros((batch_size, 1), dtype=np.int64)
    baseline = np.zeros((batch_size, CAPTION_COUNT), dtype=np.float32)
    history_len = np.zeros((batch_size, 1), dtype=np.float32)
    show_id = np.zeros((batch_size, 1), dtype=np.int64)
    agnostic_show_id = np.zeros((batch_size, 1), dtype=np.int64)
    for i, sample in enumerate(batch_samples):
        seq = sample.xs[0]
        for s in range(SEQ_LEN):
            sequence[i, s, :] = seq[s] if s < len(seq) else 0.0
        static[i, :] = sample.xs[1]
        mask[i, :] = sample.xs[2]
        judge_ids[i, :] = sample.xs[3]
        corps_id[i, 0] = sample.xs[4]
        baseline[i, :] = sample.xs[5]
        history_len[i, 0] = sample.xs[6]
        show_id[i, 0] = sample.xs[7]
        agnostic_show_id[i, 0] = sample.xs[8]
    return {
        "sequence": torch.from_numpy(sequence).to(device),
        "static": torch.from_numpy(static).to(device),
        "mask": torch.from_numpy(mask).to(device),
        "judge_ids": torch.from_numpy(judge_ids).to(device),
        "corps_id": torch.from_numpy(corps_id).to(device),
        "baseline_recap": torch.from_numpy(baseline).to(device),
        "history_len": torch.from_numpy(history_len).to(device),
        "show_id": torch.from_numpy(show_id).to(device),
        "agnostic_show_id": torch.from_numpy(agnostic_show_id).to(device),
        "judge_bias_scale": torch.full((batch_size, 1), scales["judgeBias"], dtype=torch.float32, device=device),
        "corps_scale": torch.full((batch_size, 1), scales["corps"], dtype=torch.float32, device=device),
    }


def build_targets(batch_samples: List[Sample], device: torch.device) -> torch.Tensor:
    ys = np.zeros((len(batch_samples), TARGET_DIM), dtype=np.float32)
    for i, sample in enumerate(batch_samples):
        ys[i, :] = np.array(sample.ys, dtype=np.float32)
    return torch.from_numpy(ys).to(device)


class RecapLayer(nn.Module):
    def __init__(self, stats: TargetStats):
        super().__init__()
        recap_std = torch.tensor(stats.recap_std, dtype=torch.float32)
        delta_std = torch.tensor(stats.delta_std, dtype=torch.float32)
        delta_mean = torch.tensor(stats.delta_mean, dtype=torch.float32)
        safe_recap_std = torch.where(recap_std > 1e-6, recap_std, torch.ones_like(recap_std))
        self.register_buffer("A", delta_std / safe_recap_std)
        self.register_buffer("C", delta_mean / safe_recap_std)

    def forward(self, delta_pred: torch.Tensor, baseline_input: torch.Tensor) -> torch.Tensor:
        return delta_pred * self.A + baseline_input + self.C


class RecurrentDropoutLSTM(nn.Module):
    def __init__(
        self,
        input_size: int,
        hidden_size: int,
        dropout: float = 0.0,
        recurrent_dropout: float = 0.0,
        bidirectional: bool = False,
    ):
        super().__init__()
        self.input_size = input_size
        self.hidden_size = hidden_size
        self.dropout = dropout
        self.recurrent_dropout = recurrent_dropout
        self.bidirectional = bidirectional
        self.cell_fwd = nn.LSTMCell(input_size, hidden_size)
        self.cell_bwd = nn.LSTMCell(input_size, hidden_size) if bidirectional else None

    def _run_direction(self, x: torch.Tensor, cell: nn.LSTMCell, reverse: bool) -> torch.Tensor:
        batch_size, seq_len, _ = x.shape
        h = x.new_zeros((batch_size, self.hidden_size))
        c = x.new_zeros((batch_size, self.hidden_size))
        input_mask = None
        if self.training and self.dropout > 0:
            input_mask = x.new_empty((batch_size, self.input_size)).bernoulli_(1 - self.dropout) / (1 - self.dropout)
        recur_mask = None
        if self.training and self.recurrent_dropout > 0:
            recur_mask = x.new_empty((batch_size, self.hidden_size)).bernoulli_(1 - self.recurrent_dropout) / (
                1 - self.recurrent_dropout
            )
        outputs: List[torch.Tensor] = []
        indices = range(seq_len - 1, -1, -1) if reverse else range(seq_len)
        for t in indices:
            xt = x[:, t, :]
            if input_mask is not None:
                xt = xt * input_mask
            h_in = h * recur_mask if recur_mask is not None else h
            h, c = cell(xt, (h_in, c))
            outputs.append(h)
        if reverse:
            outputs = list(reversed(outputs))
        return torch.stack(outputs, dim=1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        fwd = self._run_direction(x, self.cell_fwd, reverse=False)
        if not self.bidirectional:
            return fwd
        bwd = self._run_direction(x, self.cell_bwd, reverse=True)
        return torch.cat([fwd, bwd], dim=2)


class CategoryLayer(nn.Module):
    def __init__(self, stats: TargetStats):
        super().__init__()
        matrix = torch.tensor(
            [
                [1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
                [0.0, 0.0, 0.5, 0.5, 0.5, 0.0, 0.0, 0.0],
                [0.0, 0.0, 0.0, 0.0, 0.0, 0.5, 0.5, 0.5],
            ],
            dtype=torch.float32,
        )
        recap_std = torch.tensor(stats.recap_std, dtype=torch.float32)
        category_std = torch.tensor(stats.category_std, dtype=torch.float32)
        safe_cat_std = torch.where(category_std > 1e-6, category_std, torch.ones_like(category_std))
        cat_a = (matrix * recap_std.unsqueeze(0)) / safe_cat_std.unsqueeze(1)
        self.register_buffer("catA", cat_a.t())
        cat_c = []
        for i, row in enumerate(matrix):
            pts = sum(row[j].item() * stats.recap_mean[j] for j in range(CAPTION_COUNT))
            cat_c.append((pts - stats.category_mean[i]) / (stats.category_std[i] if stats.category_std[i] > 1e-6 else 1.0))
        self.register_buffer("catC", torch.tensor(cat_c, dtype=torch.float32))

    def forward(self, recap_norm: torch.Tensor) -> torch.Tensor:
        return recap_norm @ self.catA + self.catC


class TotalLayer(nn.Module):
    def __init__(self, stats: TargetStats):
        super().__init__()
        category_std = torch.tensor(stats.category_std, dtype=torch.float32)
        total_std = stats.total_std if stats.total_std > 1e-6 else 1.0
        self.register_buffer("totalA", category_std / total_std)
        total_c_val = (sum(stats.category_mean) - stats.total_mean) / total_std
        self.register_buffer("totalC", torch.tensor(total_c_val, dtype=torch.float32))

    def forward(self, cat_norm: torch.Tensor) -> torch.Tensor:
        return (cat_norm * self.totalA).sum(dim=1, keepdim=True) + self.totalC


class DciScorePredictorV9Fixed(nn.Module):
    def __init__(self, config: Dict, stats: TargetStats):
        super().__init__()
        judge_count = config["judge_count"]
        corps_count = config["corps_count"]
        show_count = config["show_count"]
        lstm1_units = config["lstm1_units"]
        lstm2_units = config["lstm2_units"]
        dropout_lstm = config["dropout_lstm"]
        recurrent_dropout = config["recurrent_dropout"]
        dropout_dense1 = config["dropout_dense1"]
        dropout_dense2 = config["dropout_dense2"]
        use_mha = config["use_mha"]

        self.judge_emb = nn.Embedding(judge_count, 24)
        self.corps_emb = nn.Embedding(corps_count, 20)
        self.show_emb = nn.Embedding(show_count, 12)

        self.lstm1 = RecurrentDropoutLSTM(
            input_size=FEAT_DIM,
            hidden_size=lstm1_units,
            dropout=dropout_lstm,
            recurrent_dropout=recurrent_dropout,
            bidirectional=True,
        )
        self.lstm1_norm = nn.LayerNorm(lstm1_units * 2)

        self.lstm2 = RecurrentDropoutLSTM(
            input_size=lstm1_units * 2,
            hidden_size=lstm2_units,
            dropout=dropout_lstm,
            recurrent_dropout=recurrent_dropout,
            bidirectional=True,
        )
        self.lstm2_norm = nn.LayerNorm(lstm2_units * 2)

        self.use_mha = use_mha
        if use_mha:
            mha_dim = 16 * 4
            self.mha_q = nn.Linear(lstm2_units * 2, mha_dim)
            self.mha_k = nn.Linear(lstm2_units * 2, mha_dim)
            self.mha_v = nn.Linear(lstm2_units * 2, mha_dim)
            self.mha = nn.MultiheadAttention(embed_dim=mha_dim, num_heads=4, batch_first=True)
            self.mha_out = nn.Linear(mha_dim, lstm2_units * 2)
            self.mha_norm = nn.LayerNorm(lstm2_units * 2)
            self.mha_dropout = nn.Dropout(0.1)

        self.att_score = nn.Linear(lstm2_units * 2, 1)

        context_dim = lstm2_units * 2
        judge_flat_dim = CAPTION_COUNT * 24
        input_dim = context_dim + TOTAL_STATIC_DIM + judge_flat_dim + CAPTION_COUNT + FEAT_DIM + 12
        self.d1 = nn.Linear(input_dim, 512)
        self.d1_dropout = nn.Dropout(dropout_dense1)
        self.d2 = nn.Linear(512, 256)
        self.d2_dropout = nn.Dropout(dropout_dense2)

        self.strength = nn.Linear(context_dim, 24)
        self.accuracy_trunk = nn.Linear(256 + TOTAL_STATIC_DIM + 24, 128)
        self.accuracy_dropout = nn.Dropout(0.2)
        self.judge_bias_raw = nn.Linear(judge_flat_dim, CAPTION_COUNT)
        self.delta_q50_base = nn.Linear(128, CAPTION_COUNT)
        self.corps_corr_raw = nn.Linear(20, CAPTION_COUNT)

        width_concat_dim = (256 + TOTAL_STATIC_DIM + 24) + judge_flat_dim + 1
        self.q10_width_raw = nn.Linear(width_concat_dim, CAPTION_COUNT)
        self.q90_width_raw = nn.Linear(width_concat_dim, CAPTION_COUNT)
        nn.init.constant_(self.q10_width_raw.bias, -3.0)
        nn.init.constant_(self.q90_width_raw.bias, -3.0)

        self.recap_layer = RecapLayer(stats)
        self.category_layer = CategoryLayer(stats)
        self.total_layer = TotalLayer(stats)

    def forward(self, xs: Dict[str, torch.Tensor]) -> torch.Tensor:
        x_seq = xs["sequence"]
        x_static = xs["static"]
        x_mask = xs["mask"]
        x_judge = xs["judge_ids"]
        x_corps = xs["corps_id"]
        x_baseline = xs["baseline_recap"]
        x_history = xs["history_len"]
        x_judge_scale = xs["judge_bias_scale"]
        x_corps_scale = xs["corps_scale"]
        x_show = xs["agnostic_show_id"]

        lstm1_out = self.lstm1_norm(self.lstm1(x_seq))
        attention_input = self.lstm2_norm(self.lstm2(lstm1_out))
        if self.use_mha:
            q = self.mha_q(attention_input)
            k = self.mha_k(attention_input)
            v = self.mha_v(attention_input)
            attn_out, _ = self.mha(q, k, v)
            attn_out = self.mha_out(attn_out)
            attention_input = self.mha_norm(attention_input + attn_out)
            attention_input = self.mha_dropout(attention_input)

        scores = torch.tanh(self.att_score(attention_input)).squeeze(-1)
        mask = x_mask
        has_any = mask.bool().any(dim=1, keepdim=True)
        if not has_any.all():
            default = torch.zeros_like(mask)
            default[:, 0] = 1.0
            mask = torch.where(has_any, mask, default)
        scores = scores.masked_fill(mask == 0, -1e9)
        weights = F.softmax(scores, dim=1).unsqueeze(-1)
        context = torch.sum(attention_input * weights, dim=1)

        judge_flat = self.judge_emb(x_judge).reshape(x_judge.shape[0], -1)
        corps_flat = self.corps_emb(x_corps).reshape(x_corps.shape[0], -1)
        show_flat = self.show_emb(x_show).reshape(x_show.shape[0], -1)
        last_step = x_seq[:, -1, :]

        concat = torch.cat([context, x_static, judge_flat, x_baseline, last_step, show_flat], dim=1)
        d1 = F.relu(self.d1(concat))
        d1 = self.d1_dropout(d1)
        d2 = F.relu(self.d2(d1))
        d2 = self.d2_dropout(d2)

        strength = F.relu(self.strength(context))
        skip_concat = torch.cat([d2, x_static, strength], dim=1)
        accuracy = F.relu(self.accuracy_trunk(skip_concat))
        accuracy = self.accuracy_dropout(accuracy)

        judge_bias = self.judge_bias_raw(judge_flat) * x_judge_scale
        delta_q50_base = self.delta_q50_base(accuracy)
        corps_corr = self.corps_corr_raw(corps_flat) * x_corps_scale
        delta_q50 = delta_q50_base + judge_bias + corps_corr

        width_concat = torch.cat([skip_concat, judge_flat, x_history], dim=1)
        q10_width = F.softplus(self.q10_width_raw(width_concat))
        q90_width = F.softplus(self.q90_width_raw(width_concat))
        q10_delta = delta_q50 - q10_width
        q90_delta = delta_q50 + q90_width

        recap_head = self.recap_layer(delta_q50, x_baseline)
        category_head = self.category_layer(recap_head)
        total_head = self.total_layer(category_head)

        output = torch.cat([q10_delta, delta_q50, q90_delta, recap_head, category_head, total_head], dim=1)
        return output


class LossContext:
    def __init__(self, stats: TargetStats, device: torch.device):
        self.recap_mean = torch.tensor(stats.recap_mean, dtype=torch.float32, device=device)
        self.recap_std = torch.tensor([v if v > 1e-6 else 1.0 for v in stats.recap_std], dtype=torch.float32, device=device)
        self.delta_mean = torch.tensor(stats.delta_mean, dtype=torch.float32, device=device)
        self.delta_std = torch.tensor([v if v > 1e-6 else 1.0 for v in stats.delta_std], dtype=torch.float32, device=device)
        self.category_mean = torch.tensor(stats.category_mean, dtype=torch.float32, device=device)
        self.category_std = torch.tensor([v if v > 1e-6 else 1.0 for v in stats.category_std], dtype=torch.float32, device=device)
        self.delta_weight = torch.pow(torch.tensor(stats.delta_weights, dtype=torch.float32, device=device), 0.5)
        self.recap_weight = torch.tensor(stats.recap_weights, dtype=torch.float32, device=device)
        self.total_mean = torch.tensor(stats.total_mean, dtype=torch.float32, device=device)
        self.total_std = torch.tensor(stats.total_std if stats.total_std > 1e-6 else 1.0, dtype=torch.float32, device=device)


def weighted_caption_mean(loss_by_cap: torch.Tensor, weights: torch.Tensor) -> torch.Tensor:
    per_cap = loss_by_cap.mean(dim=0)
    denom = torch.clamp(weights.sum(), min=1e-8)
    return (per_cap * weights).sum() / denom


def v9_loss(
    y_true: torch.Tensor,
    y_pred: torch.Tensor,
    weights: Dict[str, float],
    history_len: torch.Tensor,
    show_ids: torch.Tensor,
    scheduled_width_floor_weight: float,
    width_floor_pts: float,
    ctx: LossContext,
    reg_loss: Optional[torch.Tensor] = None,
) -> torch.Tensor:
    delta_true = y_true[:, 0:CAPTION_COUNT]
    recap_true = y_true[:, CAPTION_COUNT:CAPTION_COUNT + RECAP_DIM]
    category_true = y_true[:, CAPTION_COUNT + RECAP_DIM:CAPTION_COUNT + RECAP_DIM + CATEGORY_DIM]
    total_true = y_true[:, CAPTION_COUNT + RECAP_DIM + CATEGORY_DIM:CAPTION_COUNT + RECAP_DIM + CATEGORY_DIM + TOTAL_DIM]

    delta_pred = y_pred[:, 0:DELTA_DIM]
    recap_pred = y_pred[:, DELTA_DIM:DELTA_DIM + RECAP_DIM]
    category_pred = y_pred[:, DELTA_DIM + RECAP_DIM:DELTA_DIM + RECAP_DIM + CATEGORY_DIM]
    total_pred = y_pred[:, DELTA_DIM + RECAP_DIM + CATEGORY_DIM:DELTA_DIM + RECAP_DIM + CATEGORY_DIM + TOTAL_DIM]

    delta_pred_q10 = delta_pred[:, 0:CAPTION_COUNT]
    delta_pred_q50 = delta_pred[:, CAPTION_COUNT:CAPTION_COUNT * 2]
    delta_pred_q90 = delta_pred[:, CAPTION_COUNT * 2:CAPTION_COUNT * 3]

    err10 = delta_true - delta_pred_q10
    err50 = delta_true - delta_pred_q50
    err90 = delta_true - delta_pred_q90

    q10_loss = torch.maximum(0.1 * err10, -0.9 * err10)
    q50_loss = torch.maximum(0.5 * err50, -0.5 * err50)
    q90_loss = torch.maximum(0.9 * err90, -0.1 * err90)

    weighted_q10 = weighted_caption_mean(q10_loss, ctx.delta_weight)
    weighted_q50 = weighted_caption_mean(q50_loss, ctx.delta_weight)
    weighted_q90 = weighted_caption_mean(q90_loss, ctx.delta_weight)

    delta_loss = weights["deltaWeight"] * weighted_q50 + weights["quantileWeight"] * (weighted_q10 + weighted_q90)

    recap_error = recap_true - recap_pred
    recap_loss = weights["recapWeight"] * weighted_caption_mean(recap_error.pow(2), ctx.recap_weight)

    category_loss = weights["categoryWeight"] * (category_true - category_pred).pow(2).mean()
    total_loss = weights["totalWeight"] * (total_true - total_pred).pow(2).mean()

    total_true_flat = total_true.view(-1)
    total_pred_flat = total_pred.view(-1)
    show_ids_flat = show_ids.view(-1).long()
    diff_true = total_true_flat.unsqueeze(1) - total_true_flat.unsqueeze(0)
    diff_pred = total_pred_flat.unsqueeze(1) - total_pred_flat.unsqueeze(0)
    id_row = show_ids_flat.view(-1, 1)
    id_col = show_ids_flat.view(1, -1)
    same_show = id_row == id_col
    idx = torch.arange(total_true_flat.shape[0], device=total_true.device)
    row = idx.view(-1, 1)
    col = idx.view(1, -1)
    lower_tri = row > col
    pair_mask = same_show & lower_tri
    mask_float = pair_mask.float()
    zero_mask = diff_true == 0
    gt_mask = diff_true > 0
    target = gt_mask.float() + zero_mask.float() * 0.5
    pred_prob = torch.sigmoid(diff_pred).clamp(1e-7, 1 - 1e-7)
    loss_matrix = -(
        target * torch.log(pred_prob) + (1 - target) * torch.log(1 - pred_prob)
    )
    masked_loss = loss_matrix * mask_float
    denom = torch.clamp(mask_float.sum(), min=1.0)
    ranking_loss = masked_loss.sum() / denom

    q10_denorm = delta_pred_q10 * ctx.delta_std + ctx.delta_mean
    q90_denorm = delta_pred_q90 * ctx.delta_std + ctx.delta_mean
    width_pts = q90_denorm - q10_denorm
    h_plus1 = history_len + 1.0
    width_factor = 1.0 + 0.5 / torch.sqrt(h_plus1)
    base_width = ctx.delta_std * 1.28
    target_width = base_width * width_factor
    width_prior_loss = (width_pts - target_width).pow(2).mean()
    sigma_floor = ctx.delta_std * 0.2
    width_floor = torch.maximum(torch.tensor(width_floor_pts, device=width_pts.device), sigma_floor)
    width_shortfall = F.relu(width_floor - width_pts)
    width_penalty = width_shortfall.pow(2).mean()

    true_denorm = delta_true * ctx.delta_std + ctx.delta_mean
    sharpness = 2.0
    left = torch.sigmoid((true_denorm - q10_denorm) * sharpness)
    right = torch.sigmoid((q90_denorm - true_denorm) * sharpness)
    soft_hit = left * right
    soft_coverage = soft_hit.mean()
    coverage_penalty = F.relu(torch.tensor(0.8, device=soft_coverage.device) - soft_coverage)

    total = (
        delta_loss
        + recap_loss
        + category_loss
        + total_loss
        + weights["rankingWeight"] * ranking_loss
        + (scheduled_width_floor_weight if weights["quantileWeight"] > 0 else 0.0) * width_penalty
        + weights["quantileWeight"] * width_prior_loss
        + weights["quantileWeight"] * 0.2 * coverage_penalty
    )
    if reg_loss is not None:
        total = total + reg_loss
    return total


def compute_reg_loss(model: DciScorePredictorV9Fixed, l2_reg: float) -> torch.Tensor:
    loss = torch.tensor(0.0, device=next(model.parameters()).device)

    def add_params(params: Iterable[torch.Tensor], coeff: float):
        nonlocal loss
        for p in params:
            loss = loss + coeff * (p ** 2).sum()

    def add_weights_only(module: nn.Module, coeff: float):
        nonlocal loss
        for name, param in module.named_parameters():
            if "weight" in name:
                loss = loss + coeff * (param ** 2).sum()

    add_weights_only(model.lstm1, l2_reg)
    add_weights_only(model.lstm2, l2_reg)
    add_weights_only(model.d1, l2_reg)
    add_weights_only(model.d2, l2_reg)
    add_weights_only(model.accuracy_trunk, l2_reg)
    add_weights_only(model.delta_q50_base, l2_reg)
    add_weights_only(model.judge_bias_raw, 1e-4)
    add_weights_only(model.corps_corr_raw, 1e-4)
    add_weights_only(model.judge_emb, 1e-3)
    add_weights_only(model.corps_emb, 1e-5)
    add_weights_only(model.show_emb, 1e-4)
    return loss


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--epochs", type=int, default=EPOCHS)
    parser.add_argument("--batch", type=int, default=BATCH_SIZE)
    parser.add_argument("--maxRows", type=int, default=0)
    parser.add_argument("--patience", type=int, default=EARLY_STOPPING_PATIENCE)
    parser.add_argument("--reduce-lr-patience", type=int, default=REDUCE_LR_PATIENCE)
    parser.add_argument("--lstm1-units", type=int, default=128)
    parser.add_argument("--lstm2-units", type=int, default=64)
    parser.add_argument("--dropout-lstm", type=float, default=0.2)
    parser.add_argument("--recurrent-dropout", type=float, default=0.1)
    parser.add_argument("--dropout-dense1", type=float, default=0.3)
    parser.add_argument("--dropout-dense2", type=float, default=0.2)
    parser.add_argument("--l2-reg", type=float, default=0.000025)
    parser.add_argument("--lr", type=float, default=0.00075)
    parser.add_argument("--min-lr", type=float, default=0.00003)
    parser.add_argument("--warmup-epochs", type=int, default=10)
    parser.add_argument("--start-epoch", type=int, default=0)
    parser.add_argument("--clip-norm", type=float, default=1.0)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--swa", type=str, default="true")
    parser.add_argument("--swa-start", type=float, default=0.75)
    parser.add_argument("--swa-interval", type=int, default=1)
    parser.add_argument("--snapshot-epochs", type=str, default="")
    parser.add_argument("--use-mha", type=str, default="false")
    parser.add_argument("--width-floor-pts", type=float, default=WIDTH_FLOOR_PTS)
    parser.add_argument("--width-floor-weight", type=float, default=WIDTH_FLOOR_WEIGHT)
    parser.add_argument("--width-floor-start", type=float, default=0.1)
    parser.add_argument("--width-floor-end", type=float, default=WIDTH_FLOOR_WEIGHT)
    parser.add_argument("--ranking-weight", type=float, default=0.1)
    parser.add_argument("--val-split", type=float, default=0.05)
    parser.add_argument("--samples-per-epoch", type=int, default=SAMPLES_PER_EPOCH)
    parser.add_argument("--load-model", type=str, default="")
    parser.add_argument("--baseline-dropout", type=float, default=BASELINE_DROPOUT_RATE)
    parser.add_argument("--baseline-noise-std", type=float, default=BASELINE_NOISE_STD_PTS)
    parser.add_argument("--log-csv", type=str, default="./results/lstm-v9-production-training-log.csv")
    parser.add_argument("--trial-id", type=str, default="")
    parser.add_argument("--no-judge-bias", type=str, default="false")
    parser.add_argument("--no-corps-residual", type=str, default="false")
    parser.add_argument("--output-report", type=str, default="eval_report.json")
    parser.add_argument("--baseline-scope", type=str, default="train")
    parser.add_argument("--validate-only", action="store_true")
    parser.add_argument("--val-batches", type=int, default=0)
    args = parser.parse_args()
    args.swa = args.swa.lower() == "true"
    args.use_mha = args.use_mha.lower() == "true"
    args.no_judge_bias = args.no_judge_bias.lower() == "true"
    args.no_corps_residual = args.no_corps_residual.lower() == "true"
    if args.maxRows <= 0:
        args.maxRows = None
    return args


def load_rows_from_db() -> List[Dict]:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("PRAGMA table_info(ml_sequence_rows_v9_subcaption)")
    cols = {row["name"] for row in cur.fetchall()}
    select_cols = [
        "season",
        "competition_slug",
        "competition_date",
        "corps_key",
        "corps_id",
        "x_sequence_json",
        "x_static_json",
        "judge_indices_json",
        "y_residuals_json",
        "y_recap_json",
        "division_name",
        "split",
    ]
    if "agnostic_show_id" in cols:
        select_cols.append("agnostic_show_id")
    query = f"SELECT {', '.join(select_cols)} FROM ml_sequence_rows_v9_subcaption"
    cur.execute(query)
    rows = [dict(row) for row in cur.fetchall()]
    conn.close()
    return rows


def save_checkpoint(model: nn.Module, run_dir: str, stats: TargetStats, args, meta: Optional[Dict] = None):
    os.makedirs(run_dir, exist_ok=True)
    torch.save(model.state_dict(), os.path.join(run_dir, "model_state.pt"))
    with open(os.path.join(run_dir, "training-args.json"), "w", encoding="utf-8") as f:
        json.dump(vars(args), f, indent=2)
    if meta is not None:
        with open(os.path.join(run_dir, "best-meta.json"), "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2)


def init_csv_logger(path: str, fieldnames: List[str]) -> None:
    if not path:
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()


def append_csv_row(path: str, fieldnames: List[str], row: Dict) -> None:
    if not path:
        return
    with open(path, "a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writerow(row)


def main():
    args = parse_args()
    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(args.seed)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    with open(JUDGE_INDEX_PATH, "r", encoding="utf-8") as f:
        judge_index_map = json.load(f)
    with open(CORPS_INDEX_PATH, "r", encoding="utf-8") as f:
        corps_index_map = json.load(f)
    if corps_index_map.get("unknown") != UNK_CORPS_ID:
        raise ValueError(f"Expected corps unknown to be index {UNK_CORPS_ID}, got {corps_index_map.get('unknown')}")
    judge_count = len(judge_index_map)
    corps_count = len(corps_index_map)

    print("Loading V9 sequence data...")
    raw_rows = load_rows_from_db()
    all_data_rows = build_data_rows(raw_rows)
    non_test_rows = [row for row in all_data_rows if row.split != "test"]
    test_rows = [row for row in all_data_rows if row.split == "test"]

    val_rng = seeded_random(args.seed)
    shuffled = shuffle_array(list(non_test_rows), val_rng)
    val_count = max(1, int(len(shuffled) * args.val_split))
    val_rows = shuffled[:val_count]
    train_rows = shuffled[val_count:]

    baseline_scope = args.baseline_scope.lower()
    baseline_history_rows = all_data_rows if baseline_scope == "global" else train_rows
    if baseline_scope not in ("global", "train"):
        print(f"Unknown baseline scope '{args.baseline_scope}', defaulting to 'train'.")
    apply_baselines(all_data_rows, baseline_history_rows)

    train_subset = train_rows[: args.maxRows] if args.maxRows else train_rows
    if not train_subset:
        raise ValueError("Missing train data for V9 model.")

    stats = compute_target_stats(train_subset)
    os.makedirs(os.path.dirname(NORM_PATH), exist_ok=True)
    with open(NORM_PATH, "w", encoding="utf-8") as f:
        json.dump(stats.__dict__, f, indent=2)
    print(f"Saved normalization stats to {NORM_PATH}")

    initial_train_samples, unique_show_count = build_samples(train_subset, stats, SEQ_LEN, 1.0, args.seed, 0, 0, 0)
    initial_val_samples, _ = build_samples(val_rows, stats, SEQ_LEN, 1.0, args.seed + 1, 0, 0, 0)
    if initial_val_samples:
        audit_sample = initial_val_samples[0]
        last_valid_idx = len(audit_sample.xs[2]) - 1 - audit_sample.xs[2][::-1].index(1)
        if last_valid_idx >= 0:
            step = audit_sample.xs[0][last_valid_idx]
            for i in range(CAPTION_COUNT):
                base = RECAP_OFFSET_IN_FEATS + i * CAPTION_STRIDE
                for j in range(CAPTION_STRIDE):
                    value = step[base + j]
                    if value != 0:
                        raise ValueError(
                            f"AUDIT FAILED: Last valid step has caption data at {i}:{j} -> {value}"
                        )

    baselines = compute_baseline_mae(initial_val_samples, stats) if initial_val_samples else {
        "baselineZero": 0.0,
        "baselineMean": 0.0,
        "baselineEma": 0.0,
        "baselineQuad": 0.0,
    }
    print(f"Baseline MAE: {baselines}")

    config = {
        "judge_count": judge_count,
        "corps_count": corps_count,
        "show_count": unique_show_count,
        "lstm1_units": args.lstm1_units,
        "lstm2_units": args.lstm2_units,
        "dropout_lstm": args.dropout_lstm,
        "recurrent_dropout": args.recurrent_dropout,
        "dropout_dense1": args.dropout_dense1,
        "dropout_dense2": args.dropout_dense2,
        "use_mha": args.use_mha,
    }
    model = DciScorePredictorV9Fixed(config, stats).to(device)

    if args.load_model:
        load_path = args.load_model
        candidate = os.path.join(load_path, "model_state.pt") if os.path.isdir(load_path) else load_path
        if os.path.exists(candidate):
            print(f"Loading weights from {candidate}...")
            model.load_state_dict(torch.load(candidate, map_location=device))
        else:
            print(f"Load model path does not exist: {candidate}")

    optimizer = torch.optim.Adam(model.parameters(), lr=args.lr)
    print(model)

    print("\n--- DERIVATION EXACTNESS CHECK ---")
    with torch.no_grad():
        dummy_seq = torch.zeros((1, SEQ_LEN, FEAT_DIM), device=device)
        dummy_static = torch.zeros((1, TOTAL_STATIC_DIM), device=device)
        dummy_mask = torch.ones((1, SEQ_LEN), device=device)
        dummy_judge_ids = torch.zeros((1, CAPTION_COUNT), dtype=torch.long, device=device)
        dummy_corps_id = torch.zeros((1, 1), dtype=torch.long, device=device)
        dummy_baseline = torch.zeros((1, CAPTION_COUNT), device=device)
        dummy_history = torch.ones((1, 1), device=device)
        dummy_scale = torch.ones((1, 1), device=device)
        dummy_show = torch.zeros((1, 1), dtype=torch.long, device=device)
        output_tensor = model(
            {
                "sequence": dummy_seq,
                "static": dummy_static,
                "mask": dummy_mask,
                "judge_ids": dummy_judge_ids,
                "corps_id": dummy_corps_id,
                "baseline_recap": dummy_baseline,
                "history_len": dummy_history,
                "judge_bias_scale": dummy_scale,
                "corps_scale": dummy_scale,
                "agnostic_show_id": dummy_show,
            }
        )
        if output_tensor.shape[1] != OUTPUT_DIM:
            raise ValueError(f"DERIVATION CHECK FAILED: Unexpected output shape {output_tensor.shape}")
        derived_recap_norm = output_tensor[:, 24:32].cpu().numpy().flatten()
        derived_cat_norm = output_tensor[:, 32:35].cpu().numpy().flatten()
        derived_total_norm = output_tensor[:, 35:36].cpu().numpy().flatten()
        recap_pts = [
            derived_recap_norm[i] * stats.recap_std[i] + stats.recap_mean[i] for i in range(CAPTION_COUNT)
        ]
        cat_pts = [
            derived_cat_norm[i] * stats.category_std[i] + stats.category_mean[i] for i in range(3)
        ]
        tot_pts = derived_total_norm[0] * stats.total_std + stats.total_mean
        expected_ge = recap_pts[0] + recap_pts[1]
        expected_visual = (recap_pts[2] + recap_pts[3] + recap_pts[4]) / 2
        expected_music = (recap_pts[5] + recap_pts[6] + recap_pts[7]) / 2
        expected_total = expected_ge + expected_visual + expected_music
        print("Recap Points:", [f"{v:.2f}" for v in recap_pts])
        print(f"GE: Derived = {cat_pts[0]:.2f}, Expected = {expected_ge:.2f}")
        print(f"Visual: Derived = {cat_pts[1]:.2f}, Expected = {expected_visual:.2f}")
        print(f"Music: Derived = {cat_pts[2]:.2f}, Expected = {expected_music:.2f}")
        print(f"Total: Derived = {tot_pts:.2f}, Expected = {expected_total:.2f}")
        if (
            abs(cat_pts[0] - expected_ge) > 0.05
            or abs(cat_pts[1] - expected_visual) > 0.05
            or abs(cat_pts[2] - expected_music) > 0.05
            or abs(tot_pts - expected_total) > 0.05
        ):
            raise ValueError("DERIVATION CHECK FAILED: Architecture consistency mismatch!")
    print("DERIVATION CHECK SUCCESS\n")

    if train_rows:
        sample_row = train_rows[0]
        sum8 = sum(sample_row.recap)
        print(f"Sample Row Total: {sample_row.total:.2f} (expecting DCI scale, not sum-of-8)")
        print(f"Sum-of-8: {sum8:.2f}")
        if abs(sample_row.total - sum8) < 0.1 and any(r > 0 for r in sample_row.recap):
            print("WARNING: total score is still sum-of-8! Fix logic in build_data_rows.")
        else:
            print("SCALE SANITY SUCCESS: target total is on DCI scale.\n")

    print("\n=== V9-FIXED: Production PyTorch Training ===")
    print(
        f"Hyperparameters: lstm1={args.lstm1_units}, lstm2={args.lstm2_units}, dropout={args.dropout_lstm}, "
        f"lr={args.lr}, batch={args.batch}, width_floor_pts={args.width_floor_pts}, "
        f"width_floor_schedule={args.width_floor_start}->{args.width_floor_end}, baseline_dropout={args.baseline_dropout}, "
        f"baseline_noise_std={args.baseline_noise_std}"
    )
    print(
        f"Model Capacity: {args.lstm1_units * 2}x{args.lstm2_units * 2} BiLSTM, Dense 512x256, "
        "Judge Emb 24, Corps Emb 20, Show Emb 12"
    )

    swa_start_epoch = max(0, int(args.epochs * args.swa_start)) if math.isfinite(args.swa_start) else int(args.epochs * 0.75)
    swa_interval = max(1, args.swa_interval or 1)
    swa_state = None
    swa_count = 0
    best_score = float("inf")
    best_state = None
    patience = 0
    current_lr = args.lr
    epochs_since_improvement = 0
    scheduler = V9LossScheduler()
    provider = SequenceDataProviderV9(train_subset, 0, args.batch)
    cached_val_samples, _ = build_samples(val_rows, stats, 15, 0.0, args.seed + 999, 0, 0, 0)
    print(f"Cached {len(cached_val_samples)} validation samples (seqLen=15, identityDropout=0.0)")
    ctx = LossContext(stats, device)

    if args.validate_only:
        epoch = args.start_epoch
        weights = scheduler.get_weights(epoch)
        scales = scheduler.get_scales(epoch)
        if args.no_judge_bias:
            scales["judgeBias"] = 0
        if args.no_corps_residual:
            scales["corps"] = 0
        model.eval()
        val_delta_mae_sum = 0.0
        val_recap_mae_sum = 0.0
        val_category_mae_sum = 0.0
        val_total_mae_sum = 0.0
        val_inertia_mae_sum = 0.0
        val_quad_mae_sum = 0.0
        coverage_count = 0.0
        coverage_within = 0.0
        interval_width_sum = 0.0
        width_norm_sum = 0.0
        width_floor_count = 0.0
        val_count_total = 0
        max_batches = args.val_batches if args.val_batches and args.val_batches > 0 else None
        seen_batches = 0
        with torch.no_grad():
            for xs, ys, batch_samples in batch_generator(cached_val_samples, args.batch, False, args.seed, scales, device):
                preds = model(xs)
                pred_q50 = preds[:, CAPTION_COUNT:CAPTION_COUNT * 2]
                delta_true = ys[:, 0:CAPTION_COUNT]
                pred_denorm = pred_q50 * ctx.delta_std + ctx.delta_mean
                true_denorm = delta_true * ctx.delta_std + ctx.delta_mean
                mae_points = (pred_denorm - true_denorm).abs().mean().item()

                pred_recap = preds[:, DELTA_DIM:DELTA_DIM + RECAP_DIM]
                true_recap = ys[:, CAPTION_COUNT:CAPTION_COUNT + RECAP_DIM]
                pred_recap_denorm = pred_recap * ctx.recap_std + ctx.recap_mean
                true_recap_denorm = true_recap * ctx.recap_std + ctx.recap_mean
                base_recap_denorm = xs["baseline_recap"] * ctx.recap_std + ctx.recap_mean
                recap_mae_points = (pred_recap_denorm - true_recap_denorm).abs().mean().item()
                inertia_mae_points = (true_recap_denorm - base_recap_denorm).abs().mean().item()

                pred_category = preds[:, DELTA_DIM + RECAP_DIM:DELTA_DIM + RECAP_DIM + CATEGORY_DIM]
                true_category = ys[:, CAPTION_COUNT + RECAP_DIM:CAPTION_COUNT + RECAP_DIM + CATEGORY_DIM]
                category_mae_points = ((pred_category - true_category).abs() * ctx.category_std).mean().item()

                pred_total = preds[:, DELTA_DIM + RECAP_DIM + CATEGORY_DIM:DELTA_DIM + RECAP_DIM + CATEGORY_DIM + TOTAL_DIM]
                true_total = ys[:, CAPTION_COUNT + RECAP_DIM + CATEGORY_DIM:CAPTION_COUNT + RECAP_DIM + CATEGORY_DIM + TOTAL_DIM]
                total_mae_points = ((pred_total - true_total).abs() * ctx.total_std).mean().item()

                pred_q10 = preds[:, 0:CAPTION_COUNT]
                pred_q90 = preds[:, CAPTION_COUNT * 2:CAPTION_COUNT * 3]
                pred_q10_denorm = pred_q10 * ctx.delta_std + ctx.delta_mean
                pred_q90_denorm = pred_q90 * ctx.delta_std + ctx.delta_mean
                lower = torch.minimum(pred_q10_denorm, pred_q90_denorm)
                upper = torch.maximum(pred_q10_denorm, pred_q90_denorm)
                within = (true_denorm >= lower) & (true_denorm <= upper)
                width_floor_mask = (pred_q90_denorm - pred_q10_denorm) < args.width_floor_pts

                val_delta_mae_sum += mae_points * ys.shape[0]
                val_recap_mae_sum += recap_mae_points * ys.shape[0]
                val_category_mae_sum += category_mae_points * ys.shape[0]
                val_total_mae_sum += total_mae_points * ys.shape[0]
                val_inertia_mae_sum += inertia_mae_points * ys.shape[0]
                coverage_within += within.float().sum().item()
                coverage_count += ys.shape[0] * CAPTION_COUNT
                interval_width_sum += (pred_q90_denorm - pred_q10_denorm).mean().item() * (ys.shape[0] * CAPTION_COUNT)
                width_norm_sum += (pred_q90_denorm - pred_q10_denorm).mean().item() * ys.shape[0]
                width_floor_count += width_floor_mask.float().sum().item()
                val_count_total += ys.shape[0]

                for sample in batch_samples:
                    seq = sample.xs[0]
                    mask = sample.xs[2]
                    steps = [step for idx, step in enumerate(seq) if mask[idx] == 1]
                    for cap_idx in range(CAPTION_COUNT):
                        truth_recap_norm = sample.ys[CAPTION_COUNT + cap_idx]
                        actual = denormalize(truth_recap_norm, stats.recap_mean[cap_idx], stats.recap_std[cap_idx])
                        history_full = [get_recap_from_step(step, cap_idx) for step in steps]
                        history = history_full[:-1] if history_full else []
                        mean_pred = stats.recap_mean[cap_idx]
                        quad_pred = predict_quadratic(history, mean_pred)
                        val_quad_mae_sum += abs(actual - quad_pred)

                seen_batches += 1
                if max_batches is not None and seen_batches >= max_batches:
                    break

        val_delta_mae = val_delta_mae_sum / val_count_total if val_count_total else 0.0
        val_recap_mae = val_recap_mae_sum / val_count_total if val_count_total else 0.0
        val_category_mae = val_category_mae_sum / val_count_total if val_count_total else 0.0
        val_total_mae = val_total_mae_sum / val_count_total if val_count_total else 0.0
        val_inertia_mae = val_inertia_mae_sum / val_count_total if val_count_total else 0.0
        val_quad_mae = val_quad_mae_sum / (val_count_total * CAPTION_COUNT) if val_count_total else 0.0
        vs_inertia = val_inertia_mae - val_recap_mae
        vs_quadratic = val_quad_mae - val_recap_mae
        coverage = coverage_within / coverage_count if coverage_count else 0.0
        width_norm = width_norm_sum / val_count_total if val_count_total else 0.0
        width_floor_pct = width_floor_count / (val_count_total * CAPTION_COUNT) if val_count_total else 0.0

        cov_w = coverage_weight(epoch, 80, 20, SCORE_COVERAGE_WEIGHT)
        under_coverage = max(0.0, SCORE_COVERAGE_TARGET - coverage)
        cov_penalty = under_coverage * under_coverage
        width_excess = max(0.0, width_norm - WIDTH_TARGET_PTS)
        width_penalty_score = width_excess * 0.5
        if epoch < 40:
            val_score = val_delta_mae + val_total_mae
        else:
            val_score = (
                weights["deltaWeight"] * val_delta_mae
                + weights["recapWeight"] * val_recap_mae
                + weights["totalWeight"] * val_total_mae
                + weights["categoryWeight"] * val_category_mae
                + cov_w * cov_penalty
                + width_penalty_score
            )

        print("VALIDATION ONLY RESULTS:")
        print(
            f"delta_mae_pts = {val_delta_mae:.4f}, recap_mae_pts = {val_recap_mae:.4f}, "
            f"cat_mae_pts = {val_category_mae:.4f}, total_mae_pts = {val_total_mae:.4f}, "
            f"vs_inertia_pts = {vs_inertia:.4f}, vs_quad_pts = {vs_quadratic:.4f}, "
            f"coverage = {coverage:.3f}, width = {width_norm:.4f}, width_floor_pct = {width_floor_pct:.3f}, "
            f"score = {val_score:.4f}"
        )
        append_csv_row(
            args.log_csv,
            csv_fields,
            {
                "epoch": epoch,
                "train_loss": "",
                "val_score": f"{val_score:.6f}",
                "val_delta_mae": f"{val_delta_mae:.6f}",
                "val_recap_mae": f"{val_recap_mae:.6f}",
                "val_category_mae": f"{val_category_mae:.6f}",
                "val_total_mae": f"{val_total_mae:.6f}",
                "val_inertia_mae": f"{val_inertia_mae:.6f}",
                "val_quad_mae": f"{val_quad_mae:.6f}",
                "coverage": f"{coverage:.6f}",
                "width_norm": f"{width_norm:.6f}",
                "width_floor_pct": f"{width_floor_pct:.6f}",
                "lr": "",
                "seq_len": "",
                "id_drop": "",
                "width_floor_weight": "",
                "weights": json.dumps(weights, separators=(",", ":")),
                "scales": json.dumps(scales, separators=(",", ":")),
                "elapsed_sec": "",
            },
        )
        return

    snapshot_epochs = set()
    if args.snapshot_epochs:
        for value in args.snapshot_epochs.split(","):
            value = value.strip()
            if value:
                snapshot_epochs.add(int(value))

    run_id = f"{args.trial_id or 'run'}_{int(time.time() * 1000)}"
    run_dir = os.path.join(MODEL_DIR, run_id)
    best_dir = os.path.join(run_dir, "best")
    os.makedirs(run_dir, exist_ok=True)
    with open(os.path.join(run_dir, "target-stats.json"), "w", encoding="utf-8") as f:
        json.dump(stats.__dict__, f, indent=2)
    run_meta = {
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "device": str(device),
        "counts": {
            "judgeCount": judge_count,
            "corpsCount": corps_count,
            "showCount": unique_show_count,
            "trainRows": len(train_rows),
            "valRows": len(val_rows),
            "testRows": len(test_rows),
        },
        "normPath": NORM_PATH,
        "runId": run_id,
        "args": vars(args),
    }
    with open(os.path.join(run_dir, "run-meta.json"), "w", encoding="utf-8") as f:
        json.dump(run_meta, f, indent=2)

    csv_fields = [
        "epoch",
        "train_loss",
        "val_score",
        "val_delta_mae",
        "val_recap_mae",
        "val_category_mae",
        "val_total_mae",
        "val_inertia_mae",
        "val_quad_mae",
        "coverage",
        "width_norm",
        "width_floor_pct",
        "lr",
        "seq_len",
        "id_drop",
        "width_floor_weight",
        "weights",
        "scales",
        "elapsed_sec",
    ]
    init_csv_logger(args.log_csv, csv_fields)
    metrics_path = os.path.join(run_dir, "training-metrics.jsonl")
    min_best_save_interval_ms = 30000
    last_best_save_ms = 0
    best_saved_epoch = -1
    start_time = time.time()

    for epoch in range(args.start_epoch, args.start_epoch + args.epochs):
        provider.set_epoch(epoch)
        weights = scheduler.get_weights(epoch)
        scales = scheduler.get_scales(epoch)
        if args.no_judge_bias:
            scales["judgeBias"] = 0
        if args.no_corps_residual:
            scales["corps"] = 0
        seq_len = provider.get_sequence_length()
        epoch_rows = provider.sample_rows(args.samples_per_epoch, args.seed + epoch)
        epoch_samples, _ = build_samples(
            epoch_rows,
            stats,
            seq_len,
            weights["identityDropoutRate"],
            args.seed + epoch,
            epoch,
            args.baseline_dropout,
            args.baseline_noise_std,
        )
        drop_rate = sum(1 for s in epoch_samples if s.xs[4] == UNK_CORPS_ID) / max(1, len(epoch_samples))
        current_width_floor_weight = scheduler.get_width_floor_weight(epoch, args.width_floor_start, args.width_floor_end)
        print(
            f"\nEpoch {epoch}: Weights {json.dumps(weights)}, Scales {json.dumps(scales)}, "
            f"SeqLen {seq_len}, ID_Drop {drop_rate:.3f}, WFW {current_width_floor_weight:.3f}"
        )

        warmup = max(0, min(args.warmup_epochs, args.epochs))
        if epoch < warmup:
            lr = args.lr * (epoch + 1) / max(1, warmup)
        else:
            progress = 1 if warmup >= args.epochs else (epoch - warmup) / max(1, args.epochs - warmup)
            lr = args.min_lr + 0.5 * (args.lr - args.min_lr) * (1 + math.cos(math.pi * progress))
        for group in optimizer.param_groups:
            group["lr"] = lr
        current_lr = lr

        model.train()
        train_loss_sum = 0.0
        train_count = 0
        for xs, ys, _ in batch_generator(epoch_samples, args.batch, True, args.seed + epoch, scales, device):
            optimizer.zero_grad(set_to_none=True)
            preds = model(xs)
            reg_loss = compute_reg_loss(model, args.l2_reg)
            loss = v9_loss(
                ys,
                preds,
                {**weights, "rankingWeight": args.ranking_weight},
                xs["history_len"],
                xs["show_id"],
                scheduler.get_width_floor_weight(epoch, args.width_floor_start, args.width_floor_end),
                args.width_floor_pts,
                ctx,
                reg_loss=reg_loss,
            )
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), args.clip_norm)
            optimizer.step()
            batch_size = ys.shape[0]
            train_loss_sum += loss.item() * batch_size
            train_count += batch_size

        monitoring_stats = {
            "valScore": 0,
            "valDeltaMae": 0,
            "valRecapMae": 0,
            "valCategoryMae": 0,
            "valTotalMae": 0,
            "valInertiaMae": 0,
            "valQuadMae": 0,
            "vsInertia": 0,
            "vsQuadratic": 0,
            "coverage": 0,
            "widthNorm": 0,
            "widthFloorPct": 0,
        }

        caption_delta_mae_sum = [0.0] * CAPTION_COUNT
        caption_recap_mae_sum = [0.0] * CAPTION_COUNT
        caption_coverage_within = [0.0] * CAPTION_COUNT
        caption_width_sum = [0.0] * CAPTION_COUNT
        caption_count = [0] * CAPTION_COUNT

        if cached_val_samples:
            model.eval()
            val_loss_sum = 0.0
            val_delta_mae_sum = 0.0
            val_recap_mae_sum = 0.0
            val_category_mae_sum = 0.0
            val_total_mae_sum = 0.0
            val_inertia_mae_sum = 0.0
            val_quad_mae_sum = 0.0
            coverage_count = 0.0
            coverage_within = 0.0
            interval_width_sum = 0.0
            width_norm_sum = 0.0
            width_floor_count = 0.0
            val_count_total = 0
            history_buckets = {
                "counts": [0, 0, 0, 0, 0],
                "maeSum": [0.0, 0.0, 0.0, 0.0, 0.0],
                "baselineDevSum": [0.0, 0.0, 0.0, 0.0, 0.0],
                "baselineErrorSum": [0.0, 0.0, 0.0, 0.0, 0.0],
            }
            with torch.no_grad():
                for xs, ys, batch_samples in batch_generator(cached_val_samples, args.batch, False, args.seed, scales, device):
                    preds = model(xs)
                    scheduled_wfw = scheduler.get_width_floor_weight(epoch, args.width_floor_start, args.width_floor_end)
                    loss = v9_loss(
                        ys,
                        preds,
                        {**weights, "rankingWeight": args.ranking_weight},
                        xs["history_len"],
                        xs["show_id"],
                        scheduled_wfw,
                        args.width_floor_pts,
                        ctx,
                    )
                    batch_size = ys.shape[0]
                    val_loss_sum += loss.item() * batch_size

                    pred_q50 = preds[:, CAPTION_COUNT:CAPTION_COUNT * 2]
                    delta_true = ys[:, 0:CAPTION_COUNT]
                    pred_denorm = pred_q50 * ctx.delta_std + ctx.delta_mean
                    true_denorm = delta_true * ctx.delta_std + ctx.delta_mean
                    mae_points = (pred_denorm - true_denorm).abs().mean().item()

                    pred_recap = preds[:, DELTA_DIM:DELTA_DIM + RECAP_DIM]
                    true_recap = ys[:, CAPTION_COUNT:CAPTION_COUNT + RECAP_DIM]
                    pred_recap_denorm = pred_recap * ctx.recap_std + ctx.recap_mean
                    true_recap_denorm = true_recap * ctx.recap_std + ctx.recap_mean
                    base_recap_denorm = xs["baseline_recap"] * ctx.recap_std + ctx.recap_mean
                    recap_mae_points = (pred_recap_denorm - true_recap_denorm).abs().mean().item()
                    inertia_mae_points = (true_recap_denorm - base_recap_denorm).abs().mean().item()

                    pred_category = preds[:, DELTA_DIM + RECAP_DIM:DELTA_DIM + RECAP_DIM + CATEGORY_DIM]
                    true_category = ys[:, CAPTION_COUNT + RECAP_DIM:CAPTION_COUNT + RECAP_DIM + CATEGORY_DIM]
                    category_mae_points = ((pred_category - true_category).abs() * ctx.category_std).mean().item()

                    pred_total = preds[:, DELTA_DIM + RECAP_DIM + CATEGORY_DIM:DELTA_DIM + RECAP_DIM + CATEGORY_DIM + TOTAL_DIM]
                    true_total = ys[:, CAPTION_COUNT + RECAP_DIM + CATEGORY_DIM:CAPTION_COUNT + RECAP_DIM + CATEGORY_DIM + TOTAL_DIM]
                    total_mae_points = ((pred_total - true_total).abs() * ctx.total_std).mean().item()

                    pred_q10 = preds[:, 0:CAPTION_COUNT]
                    pred_q90 = preds[:, CAPTION_COUNT * 2:CAPTION_COUNT * 3]
                    pred_q10_denorm = pred_q10 * ctx.delta_std + ctx.delta_mean
                    pred_q90_denorm = pred_q90 * ctx.delta_std + ctx.delta_mean
                    lower = torch.minimum(pred_q10_denorm, pred_q90_denorm)
                    upper = torch.maximum(pred_q10_denorm, pred_q90_denorm)
                    within = (true_denorm >= lower) & (true_denorm <= upper)
                    width_floor_mask = (pred_q90_denorm - pred_q10_denorm) < args.width_floor_pts

                    val_delta_mae_sum += mae_points * batch_size
                    val_recap_mae_sum += recap_mae_points * batch_size
                    val_category_mae_sum += category_mae_points * batch_size
                    val_total_mae_sum += total_mae_points * batch_size
                    val_inertia_mae_sum += inertia_mae_points * batch_size

                    coverage_within += within.float().sum().item()
                    coverage_count += batch_size * CAPTION_COUNT
                    interval_width_sum += (pred_q90_denorm - pred_q10_denorm).mean().item() * (batch_size * CAPTION_COUNT)
                    width_norm_sum += (pred_q90_denorm - pred_q10_denorm).mean().item() * batch_size
                    width_floor_count += width_floor_mask.float().sum().item()
                    val_count_total += batch_size

                    if epoch % 50 == 0 or epoch == 0:
                        cap_mae = (pred_denorm - true_denorm).abs().mean(dim=0).cpu().numpy()
                        cap_recap = (pred_recap_denorm - true_recap_denorm).abs().mean(dim=0).cpu().numpy()
                        cap_within = within.float().sum(dim=0).cpu().numpy()
                        cap_width = (pred_q90_denorm - pred_q10_denorm).mean(dim=0).cpu().numpy()
                        for i in range(CAPTION_COUNT):
                            caption_delta_mae_sum[i] += cap_mae[i] * batch_size
                            caption_recap_mae_sum[i] += cap_recap[i] * batch_size
                            caption_coverage_within[i] += cap_within[i]
                            caption_width_sum[i] += cap_width[i] * batch_size
                            caption_count[i] += batch_size

                    mae_per_sample = (pred_denorm - true_denorm).abs().mean(dim=1).cpu().numpy()
                    base_err_per_sample = (true_recap_denorm - base_recap_denorm).abs().mean(dim=1).cpu().numpy()
                    base_dev_per_sample = (pred_recap_denorm - base_recap_denorm).abs().mean(dim=1).cpu().numpy()
                    hist_len = xs["history_len"].view(-1).cpu().numpy()
                    for i in range(batch_size):
                        h = hist_len[i]
                        bucket = 4
                        if h < 0.5:
                            bucket = 0
                        elif h < 1.5:
                            bucket = 1
                        elif h < 2.5:
                            bucket = 2
                        elif h < 5.5:
                            bucket = 3
                        history_buckets["counts"][bucket] += 1
                        history_buckets["maeSum"][bucket] += mae_per_sample[i]
                        history_buckets["baselineErrorSum"][bucket] += base_err_per_sample[i]
                        history_buckets["baselineDevSum"][bucket] += base_dev_per_sample[i]

                    for sample in batch_samples:
                        seq = sample.xs[0]
                        mask = sample.xs[2]
                        steps = [step for idx, step in enumerate(seq) if mask[idx] == 1]
                        for cap_idx in range(CAPTION_COUNT):
                            truth_recap_norm = sample.ys[CAPTION_COUNT + cap_idx]
                            actual = denormalize(truth_recap_norm, stats.recap_mean[cap_idx], stats.recap_std[cap_idx])
                            history_full = [get_recap_from_step(step, cap_idx) for step in steps]
                            history = history_full[:-1] if history_full else []
                            mean_pred = stats.recap_mean[cap_idx]
                            quad_pred = predict_quadratic(history, mean_pred)
                            val_quad_mae_sum += abs(actual - quad_pred)

            val_delta_mae = val_delta_mae_sum / val_count_total if val_count_total else 0.0
            val_recap_mae = val_recap_mae_sum / val_count_total if val_count_total else 0.0
            val_category_mae = val_category_mae_sum / val_count_total if val_count_total else 0.0
            val_total_mae = val_total_mae_sum / val_count_total if val_count_total else 0.0
            val_inertia_mae = val_inertia_mae_sum / val_count_total if val_count_total else 0.0
            val_quad_mae = val_quad_mae_sum / (val_count_total * CAPTION_COUNT) if val_count_total else 0.0
            vs_inertia = val_inertia_mae - val_recap_mae
            vs_quadratic = val_quad_mae - val_recap_mae
            coverage = coverage_within / coverage_count if coverage_count else 0.0
            width_norm = width_norm_sum / val_count_total if val_count_total else 0.0
            width_floor_pct = width_floor_count / (val_count_total * CAPTION_COUNT) if val_count_total else 0.0

            cov_w = coverage_weight(epoch, 80, 20, SCORE_COVERAGE_WEIGHT)
            under_coverage = max(0.0, SCORE_COVERAGE_TARGET - coverage)
            cov_penalty = under_coverage * under_coverage
            width_excess = max(0.0, width_norm - WIDTH_TARGET_PTS)
            width_penalty_score = width_excess * 0.5
            if epoch < 40:
                val_score = val_delta_mae + val_total_mae
            else:
                val_score = (
                    weights["deltaWeight"] * val_delta_mae
                    + weights["recapWeight"] * val_recap_mae
                    + weights["totalWeight"] * val_total_mae
                    + weights["categoryWeight"] * val_category_mae
                    + cov_w * cov_penalty
                    + width_penalty_score
                )

            monitoring_stats = {
                "valScore": val_score,
                "valDeltaMae": val_delta_mae,
                "valRecapMae": val_recap_mae,
                "valCategoryMae": val_category_mae,
                "valTotalMae": val_total_mae,
                "valInertiaMae": val_inertia_mae,
                "valQuadMae": val_quad_mae,
                "vsInertia": vs_inertia,
                "vsQuadratic": vs_quadratic,
                "coverage": coverage,
                "widthNorm": width_norm,
                "widthFloorPct": width_floor_pct,
            }

            if epoch in (40, 120):
                print(f"\n--- PHASE TRANSITION (Epoch {epoch}): Resetting Best Score & Patience ---")
                best_score = float("inf")
                patience = 0
                epochs_since_improvement = 0

            print("\nHistory Bucket Diagnostics (Avg Abs Error per sample, normalized units):")
            labels = ["0", "1", "2", "3-5", "6+"]
            print("Hist | Count | MAE_Pred | MAE_Base | PredDevFromBase")
            print("-----|-------|----------|----------|----------------")
            for i in range(5):
                c = history_buckets["counts"][i]
                if c > 0:
                    print(
                        f"{labels[i].ljust(4)} | {str(c).ljust(5)} | "
                        f"{(history_buckets['maeSum'][i] / c):.4f} | "
                        f"{(history_buckets['baselineErrorSum'][i] / c):.4f} | "
                        f"{(history_buckets['baselineDevSum'][i] / c):.4f}"
                    )
            print("")

        train_loss = train_loss_sum / train_count if train_count else 0.0
        elapsed = time.time() - start_time
        print(
            f"Epoch {epoch}: loss = {train_loss:.6f} "
            f"delta_mae_pts = {monitoring_stats['valDeltaMae']:.4f} "
            f"recap_mae_pts = {monitoring_stats['valRecapMae']:.4f} "
            f"cat_mae_pts = {monitoring_stats['valCategoryMae']:.4f} "
            f"total_mae_pts = {monitoring_stats['valTotalMae']:.4f} "
            f"vs_inertia_pts = {monitoring_stats['vsInertia']:.4f} "
            f"vs_quad_pts = {monitoring_stats['vsQuadratic']:.4f} "
            f"mon_cov = {monitoring_stats['coverage']:.3f} "
            f"mon_score = {monitoring_stats['valScore']:.4f} "
            f"time = {elapsed:.2f} s"
        )

        append_csv_row(
            args.log_csv,
            csv_fields,
            {
                "epoch": epoch,
                "train_loss": f"{train_loss:.6f}",
                "val_score": f"{monitoring_stats['valScore']:.6f}",
                "val_delta_mae": f"{monitoring_stats['valDeltaMae']:.6f}",
                "val_recap_mae": f"{monitoring_stats['valRecapMae']:.6f}",
                "val_category_mae": f"{monitoring_stats['valCategoryMae']:.6f}",
                "val_total_mae": f"{monitoring_stats['valTotalMae']:.6f}",
                "val_inertia_mae": f"{monitoring_stats['valInertiaMae']:.6f}",
                "val_quad_mae": f"{monitoring_stats['valQuadMae']:.6f}",
                "coverage": f"{monitoring_stats['coverage']:.6f}",
                "width_norm": f"{monitoring_stats['widthNorm']:.6f}",
                "width_floor_pct": f"{monitoring_stats['widthFloorPct']:.6f}",
                "lr": f"{current_lr:.8f}",
                "seq_len": seq_len,
                "id_drop": f"{drop_rate:.6f}",
                "width_floor_weight": f"{current_width_floor_weight:.6f}",
                "weights": json.dumps(weights, separators=(",", ":")),
                "scales": json.dumps(scales, separators=(",", ":")),
                "elapsed_sec": f"{elapsed:.2f}",
            },
        )
        with open(metrics_path, "a", encoding="utf-8") as f:
            f.write(
                json.dumps(
                    {
                        "epoch": epoch,
                        "train_loss": train_loss,
                        "val": monitoring_stats,
                        "weights": weights,
                        "scales": scales,
                        "seq_len": seq_len,
                        "id_drop": drop_rate,
                        "width_floor_weight": current_width_floor_weight,
                        "lr": current_lr,
                        "elapsed_sec": elapsed,
                    }
                )
                + "\n"
            )

        if weights["deltaWeight"] > 0 and (epoch % 50 == 0 or epoch == 0):
            print(f"\n--- CAPTION STATS (Epoch {epoch}) ---")
            for i in range(CAPTION_COUNT):
                cap_delta_mae = caption_delta_mae_sum[i] / caption_count[i] if caption_count[i] else 0.0
                cap_recap_mae = caption_recap_mae_sum[i] / caption_count[i] if caption_count[i] else 0.0
                cap_cov = caption_coverage_within[i] / caption_count[i] if caption_count[i] else 0.0
                cap_width = caption_width_sum[i] / caption_count[i] if caption_count[i] else 0.0
                print(
                    f"{CAPTIONS[i]}: delta_pts = {cap_delta_mae:.4f}, recap_pts = {cap_recap_mae:.4f}, "
                    f"cov = {cap_cov:.3f}, width = {cap_width:.4f}"
                )
            print("----------------------------------\n")

        improved = monitoring_stats["valScore"] < best_score - 1e-4
        if improved or not initial_val_samples:
            best_score = monitoring_stats["valScore"]
            patience = 0
            epochs_since_improvement = 0
            best_state = {k: v.detach().clone() for k, v in model.state_dict().items()}
            now = int(time.time() * 1000)
            should_save = epoch != best_saved_epoch and now - last_best_save_ms > min_best_save_interval_ms
            if should_save:
                tmp_best_dir = os.path.join(run_dir, "best_tmp")
                if os.path.exists(tmp_best_dir):
                    for root, dirs, files in os.walk(tmp_best_dir, topdown=False):
                        for name in files:
                            os.remove(os.path.join(root, name))
                        for name in dirs:
                            os.rmdir(os.path.join(root, name))
                    os.rmdir(tmp_best_dir)
                save_checkpoint(model, tmp_best_dir, stats, args, meta={"epoch": epoch, "bestScore": best_score, "monitoring": monitoring_stats, "savedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
                if os.path.exists(best_dir):
                    for root, dirs, files in os.walk(best_dir, topdown=False):
                        for name in files:
                            os.remove(os.path.join(root, name))
                        for name in dirs:
                            os.rmdir(os.path.join(root, name))
                    os.rmdir(best_dir)
                os.rename(tmp_best_dir, best_dir)
                best_saved_epoch = epoch
                last_best_save_ms = now
                print(f"Saved BEST checkpoint @epoch {epoch} score = {best_score:.4f} -> {best_dir}")
        else:
            patience += 1
            epochs_since_improvement += 1
            if epochs_since_improvement >= args.reduce_lr_patience and current_lr > args.min_lr:
                current_lr = max(current_lr * 0.5, args.min_lr)
                for group in optimizer.param_groups:
                    group["lr"] = current_lr
                print(f"\n--- NO IMPROVEMENT FOR {args.reduce_lr_patience} EPOCHS: Reducing LR to {current_lr:.6f} ---")
                epochs_since_improvement = 0
            if patience >= args.patience:
                print(f"Early stopping at epoch {epoch}")
                break

        if args.swa and epoch >= swa_start_epoch and (epoch - swa_start_epoch) % swa_interval == 0:
            state = model.state_dict()
            if swa_state is None:
                swa_state = {k: v.detach().clone() for k, v in state.items()}
                swa_count = 1
            else:
                swa_count += 1
                for k in swa_state:
                    swa_state[k] = (swa_state[k] * (swa_count - 1) + state[k].detach()) / swa_count

        if (epoch + 1) in snapshot_epochs:
            snapshot_dir = os.path.join(MODEL_DIR, run_id, f"snapshot_{epoch + 1}")
            save_checkpoint(model, snapshot_dir, stats, args)
            print(f"Saved snapshot to {snapshot_dir}")

    if args.swa and swa_state is not None:
        model.load_state_dict(swa_state)
    elif best_state is not None:
        model.load_state_dict(best_state)

    print(f"Saving final production model to {run_dir}...")
    save_checkpoint(model, run_dir, stats, args)

    if test_rows:
        print("\n--- FINAL TEST EVALUATION ---")
        test_samples, _ = build_samples(test_rows, stats, SEQ_LEN, 0.0, 42, 0, 0, 0)
        test_delta_mae_sum = 0.0
        test_recap_mae_sum = 0.0
        test_category_mae_sum = 0.0
        test_total_mae_sum = 0.0
        test_coverage_within = 0.0
        test_width_sum = 0.0
        test_width_floor_count = 0.0
        test_count = 0
        test_scales = {"judgeBias": 0.0 if args.no_judge_bias else 1.0, "corps": 0.0 if args.no_corps_residual else 1.0}
        model.eval()
        with torch.no_grad():
            for xs, ys, _ in batch_generator(test_samples, args.batch, False, 42, test_scales, device):
                preds = model(xs)
                pred_q50 = preds[:, CAPTION_COUNT:CAPTION_COUNT * 2]
                delta_true = ys[:, 0:CAPTION_COUNT]
                pred_denorm = pred_q50 * ctx.delta_std + ctx.delta_mean
                true_denorm = delta_true * ctx.delta_std + ctx.delta_mean

                pred_recap = preds[:, DELTA_DIM:DELTA_DIM + RECAP_DIM]
                true_recap = ys[:, CAPTION_COUNT:CAPTION_COUNT + RECAP_DIM]
                pred_category = preds[:, DELTA_DIM + RECAP_DIM:DELTA_DIM + RECAP_DIM + CATEGORY_DIM]
                true_category = ys[:, CAPTION_COUNT + RECAP_DIM:CAPTION_COUNT + RECAP_DIM + CATEGORY_DIM]
                pred_total = preds[:, DELTA_DIM + RECAP_DIM + CATEGORY_DIM:DELTA_DIM + RECAP_DIM + CATEGORY_DIM + TOTAL_DIM]
                true_total = ys[:, CAPTION_COUNT + RECAP_DIM + CATEGORY_DIM:CAPTION_COUNT + RECAP_DIM + CATEGORY_DIM + TOTAL_DIM]

                pred_q10 = preds[:, 0:CAPTION_COUNT]
                pred_q90 = preds[:, CAPTION_COUNT * 2:CAPTION_COUNT * 3]
                pred_q10_denorm = pred_q10 * ctx.delta_std + ctx.delta_mean
                pred_q90_denorm = pred_q90 * ctx.delta_std + ctx.delta_mean
                lower = torch.minimum(pred_q10_denorm, pred_q90_denorm)
                upper = torch.maximum(pred_q10_denorm, pred_q90_denorm)
                within = (true_denorm >= lower) & (true_denorm <= upper)
                width_floor_mask = (pred_q90_denorm - pred_q10_denorm) < args.width_floor_pts

                mae_points = (pred_denorm - true_denorm).abs().mean().item()
                recap_mae = ((pred_recap - true_recap).abs() * ctx.recap_std).mean().item()
                category_mae = ((pred_category - true_category).abs() * ctx.category_std).mean().item()
                total_mae = ((pred_total - true_total).abs() * ctx.total_std).mean().item()
                interval_width = (pred_q90_denorm - pred_q10_denorm).mean().item()
                within_count = within.float().sum().item()
                width_floor_count_batch = width_floor_mask.float().sum().item()

                batch_size = ys.shape[0]
                test_delta_mae_sum += mae_points * batch_size
                test_recap_mae_sum += recap_mae * batch_size
                test_category_mae_sum += category_mae * batch_size
                test_total_mae_sum += total_mae * batch_size
                test_coverage_within += within_count
                test_width_sum += interval_width * (batch_size * CAPTION_COUNT)
                test_width_floor_count += width_floor_count_batch
                test_count += batch_size

        final_test_delta_pts = test_delta_mae_sum / test_count if test_count else 0.0
        final_test_recap_pts = test_recap_mae_sum / test_count if test_count else 0.0
        final_test_category = test_category_mae_sum / test_count if test_count else 0.0
        final_test_total = test_total_mae_sum / test_count if test_count else 0.0
        final_test_cov = test_coverage_within / (test_count * CAPTION_COUNT) if test_count else 0.0
        final_test_width = test_width_sum / (test_count * CAPTION_COUNT) if test_count else 0.0
        final_test_width_floor_pct = test_width_floor_count / (test_count * CAPTION_COUNT) if test_count else 0.0

        print(
            "TEST RESULTS: "
            f"delta_mae_pts = {final_test_delta_pts:.4f}, "
            f"recap_mae_pts = {final_test_recap_pts:.4f}, "
            f"cat_mae_pts = {final_test_category:.4f}, "
            f"total_mae_pts = {final_test_total:.4f}, "
            f"coverage = {final_test_cov:.3f}, "
            f"width = {final_test_width:.4f}, "
            f"width_floor_pct = {final_test_width_floor_pct:.3f}"
        )

        report = {
            "metrics": {
                "delta_mae_pts": final_test_delta_pts,
                "recap_mae_pts": final_test_recap_pts,
                "category_mae_pts": final_test_category,
                "total_mae_pts": final_test_total,
                "coverage": final_test_cov,
                "width": final_test_width,
                "width_floor_pct": final_test_width_floor_pct,
            },
            "config": vars(args),
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        with open(os.path.join(run_dir, args.output_report), "w", encoding="utf-8") as f:
            json.dump(report, f, indent=2)
        if args.output_report != "test-results.json":
            with open(os.path.join(run_dir, "test-results.json"), "w", encoding="utf-8") as f:
                json.dump(report["metrics"], f, indent=2)

    print("Production training complete.")


if __name__ == "__main__":
    main()
