import jax
import jax.numpy as jnp
import optax
from typing import Dict

def pinball_loss(y_true, y_pred, tau):
    err = y_true - y_pred
    return jnp.maximum(tau * err, (tau - 1) * err)

def compute_quantile_loss(y_true, y_pred_q10, y_pred_q50, y_pred_q90, weights_per_cap):
    # y_true, y_pred_qXX: (batch, CAPTION_COUNT)
    # weights_per_cap: (CAPTION_COUNT,)
    
    q10_l = pinball_loss(y_true, y_pred_q10, 0.1)
    q50_l = pinball_loss(y_true, y_pred_q50, 0.5)
    q90_l = pinball_loss(y_true, y_pred_q90, 0.9)
    
    # Weights are deltaWeightTensor in TS: tf.pow(stats.deltaWeights, 0.5)
    def weighted_mean(l):
        per_cap = jnp.mean(l, axis=0)
        return jnp.sum(per_cap * weights_per_cap) / jnp.maximum(jnp.sum(weights_per_cap), 1e-8)

    return weighted_mean(q10_l), weighted_mean(q50_l), weighted_mean(q90_l)

def compute_ranking_loss(pred_total, true_total, same_show_mask):
    # pred_total, true_total: (batch,)
    # same_show_mask: (batch, batch) - True if samples i and j are in the same show
    
    # Pairwise differences
    diff_true = true_total[:, None] - true_total[None, :]
    diff_pred = pred_total[:, None] - pred_total[None, :]
    
    # Target: 1.0 if i > j, 0.5 if i == j, 0.0 if i < j
    zero_mask = jnp.equal(diff_true, 0)
    gt_mask = jnp.greater(diff_true, 0)
    target = gt_mask.astype(jnp.float32) + zero_mask.astype(jnp.float32) * 0.5
    
    # Binary Cross Entropy on sigmoid of predicted differences
    # We use jax.nn.log_sigmoid for stability
    # BCE = -(target * log(sigmoid(d)) + (1-target) * log(1-sigmoid(d)))
    # log(1-sigmoid(d)) = log(sigmoid(-d))
    
    log_p = jax.nn.log_sigmoid(diff_pred)
    log_not_p = jax.nn.log_sigmoid(-diff_pred)
    
    loss_matrix = -(target * log_p + (1 - target) * log_not_p)
    
    # Apply show mask and lower triangular mask to avoid double counting and self-pairs
    lower_tri = jnp.tril(jnp.ones_like(same_show_mask, dtype=bool), k=-1)
    pair_mask = same_show_mask & lower_tri
    
    masked_loss = jnp.where(pair_mask, loss_matrix, 0.0)
    return jnp.sum(masked_loss) / jnp.maximum(jnp.sum(pair_mask), 1.0)

def compute_soft_coverage_loss(y_true, q10_denorm, q90_denorm, target_coverage=0.8, sharpness=2.0):
    # Replicating TS sigmoid-based soft coverage
    left = jax.nn.sigmoid((y_true - q10_denorm) * sharpness)
    right = jax.nn.sigmoid((q90_denorm - y_true) * sharpness)
    soft_hit = left * right
    soft_coverage = jnp.mean(soft_hit)
    return jnp.maximum(0.0, target_coverage - soft_coverage)

def compute_width_prior_loss(q10_denorm, q90_denorm, delta_std, history_len):
    # Replicating TS width prior: V9 SQUEEZE logic
    # baseWidth = deltaStd * 1.28 (80% interval)
    # widthFactor = 1.0 + 0.5 / sqrt(historyLen + 1)
    
    width_pts = q90_denorm - q10_denorm
    base_width = delta_std * 1.28
    width_factor = 1.0 + 0.5 / jnp.sqrt(history_len + 1.0)
    target_width = base_width * width_factor
    
    return jnp.mean(jnp.square(width_pts - target_width))

def compute_width_penalty(q10_denorm, q90_denorm, delta_std, width_floor_pts):
    # Replicating TS width floor penalty
    width_pts = q90_denorm - q10_denorm
    sigma_floor = delta_std * 0.2
    width_floor = jnp.maximum(width_floor_pts, sigma_floor)
    
    width_shortfall = jnp.maximum(0.0, width_floor - width_pts)
    return jnp.mean(jnp.square(width_shortfall))
