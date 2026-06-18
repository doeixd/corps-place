import os
import json
import sqlite3
import numpy as np
import jax
import jax.numpy as jnp
import equinox as eqx
import optax
from typing import List, Dict, Tuple
from v9_model import V9SubcaptionModel
from v9_loss import (
    compute_quantile_loss, compute_ranking_loss, 
    compute_soft_coverage_loss, compute_width_prior_loss, compute_width_penalty
)

# Constants
DB_PATH = "./dci-relational.db"
NORM_PATH = "./results/v9-subcaption-target-norm.json"
JUDGE_INDEX_PATH = "./src/training/judgeIndexMap.json"
CORPS_INDEX_PATH = "./src/training/corpsIndexMap.json"
SEQ_LEN = 15
FEAT_DIM = 101
BATCH_SIZE = 32
CAPTION_COUNT = 8

class V9DataProvider:
    def __init__(self, db_path: str, stats_dict: dict):
        self.conn = sqlite3.connect(db_path)
        self.stats = stats_dict
        # Pre-load mapping
        with open(JUDGE_INDEX_PATH, "r") as f:
            self.judge_map = json.load(f)
        with open(CORPS_INDEX_PATH, "r") as f:
            self.corps_map = json.load(f)

    def load_rows(self, split: str = "train"):
        cursor = self.conn.cursor()
        cursor.execute("""
            SELECT season, competition_slug, competition_date, corps_id, 
                   x_sequence_json, x_static_json, judge_indices_json, 
                   y_recap_json, division_name, split, agnostic_show_id
            FROM ml_sequence_rows_v9_subcaption
            WHERE split = ?
        """, (split,))
        return cursor.fetchall()

    # Preprocessing logic matching TS applyBaselines and buildSamples would go here
    # For briefness in this implementation, assume we have a generator yielding batches
    # that match the ModelReadyExample structure.

def main():
    # 1. Load configuration and stats
    with open(NORM_PATH, "r") as f:
        stats = json.load(f)
    
    with open(JUDGE_INDEX_PATH, "r") as f:
        judge_count = len(json.load(f))
    with open(CORPS_INDEX_PATH, "r") as f:
        corps_count = len(json.load(f))
    
    key = jax.random.PRNGKey(42)
    model_key, train_key = jax.random.split(key)
    
    # 2. Initialize Model
    model = V9SubcaptionModel(
        judge_count=judge_count, 
        corps_count=corps_count, 
        show_count=2000, # Placeholder for agnostic shows
        stats_dict=stats,
        key=model_key
    )
    
    # 3. Optimizers
    lr_scheduler = optax.cosine_decay_schedule(3e-4, 800 * 128, alpha=0.1)
    optimizer = optax.adamw(learning_rate=lr_scheduler, weight_decay=2.5e-5)
    opt_state = optimizer.init(eqx.filter(model, eqx.is_array))

    # Tensors for loss weighting (moved to JNP)
    weights_per_cap = jnp.sqrt(jnp.array(stats["deltaWeights"]))
    
    # 4. Training Step (JIT compiled)
    @eqx.filter_jit
    def train_step(model, opt_state, batch, weights_config, scheduled_wfw, key):
        def loss_fn(model):
            # batch is a dict of jnp arrays
            preds = jax.vmap(model, in_axes=(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, None, None))(
                batch["sequence"], batch["static"], batch["mask"],
                batch["judge_ids"], batch["corps_id"], batch["baseline_recap"],
                batch["history_len"], batch["judge_bias_scale"], batch["corps_scale"],
                batch["agnostic_show_id"], True, key
            )
            
            # preds: (batch, 36)
            # y_true: (batch, 36) - matching pred structure
            y_true = batch["y"]
            
            # Slice components
            delta_true = y_true[:, :8]
            recap_true = y_true[:, 24:32]
            cat_true = y_true[:, 32:35]
            total_true = y_true[:, 35]
            
            q10_pred = preds[:, :8]
            q50_pred = preds[:, 8:16]
            q90_pred = preds[:, 16:24]
            recap_pred = preds[:, 24:32]
            cat_pred = preds[:, 32:35]
            total_pred = preds[:, 35]

            # 1. Delta (Quantile) Loss
            l10, l50, l90 = compute_quantile_loss(delta_true, q10_pred, q50_pred, q90_pred, weights_per_cap)
            delta_loss = weights_config["deltaWeight"] * l50 + weights_config["quantileWeight"] * (l10 + l90)
            
            # 2. Recap/Cat/Total MSE
            recap_loss = weights_config["recapWeight"] * jnp.mean(jnp.square(recap_true - recap_pred))
            cat_loss = weights_config["categoryWeight"] * jnp.mean(jnp.square(cat_true - cat_pred))
            tot_loss = weights_config["totalWeight"] * jnp.mean(jnp.square(total_true - total_pred))
            
            # 3. Ranking Loss
            rank_loss = compute_ranking_loss(total_pred, total_true, batch["same_show_mask"])
            
            # 4. Coverage & Width
            delta_std = jnp.array(stats["deltaStd"])
            delta_mean = jnp.array(stats["deltaMean"])
            q10_denorm = q10_pred * delta_std + delta_mean
            q90_denorm = q90_pred * delta_std + delta_mean
            true_denorm = delta_true * delta_std + delta_mean
            
            cov_loss = compute_soft_coverage_loss(true_denorm, q10_denorm, q90_denorm)
            width_prior = compute_width_prior_loss(q10_denorm, q90_denorm, delta_std, batch["history_len"])
            width_pen = compute_width_penalty(q10_denorm, q90_denorm, delta_std, 0.5) # floor=0.5
            
            total_loss = (delta_loss + recap_loss + cat_loss + tot_loss + 
                          0.1 * rank_loss + # rankingWeight=0.1
                          weights_config["quantileWeight"] * (width_prior + 0.2 * cov_loss) +
                          scheduled_wfw * width_pen)
            
            return total_loss

        grads = jax.grad(loss_fn)(model)
        updates, opt_state = optimizer.update(grads, opt_state, model)
        model = eqx.apply_updates(model, updates)
        return model, opt_state

    print("JAX V9 Implementation Ready.")

if __name__ == "__main__":
    main()
