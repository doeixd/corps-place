import jax
import jax.numpy as jnp
import equinox as eqx
from typing import List, Optional, Tuple

class AttentionPooling(eqx.Module):
    dense: eqx.nn.Dense

    def __init__(self, key_dim: int, key: jax.random.PRNGKey):
        self.dense = eqx.nn.Dense(key_dim, 1, key=key)

    def __call__(self, x: jnp.ndarray, mask: jnp.ndarray) -> jnp.ndarray:
        # x: (seq_len, dim)
        # mask: (seq_len,)
        scores = jax.vmap(self.dense)(x).squeeze(-1) # (seq_len,)
        scores = jnp.tanh(scores)
        
        # Masked Softmax
        scores = jnp.where(mask > 0.5, scores, -1e9)
        weights = jax.nn.softmax(scores)
        
        # Weighted sum
        return jnp.sum(x * weights[:, None], axis=0)

class V9SubcaptionModel(eqx.Module):
    # Dimensions
    SEQ_LEN = 15
    FEAT_DIM = 101
    RAW_STATIC_DIM = 169
    TREND_DIM = 8
    CONTEXT_DIM = 0
    TOTAL_STATIC_DIM = RAW_STATIC_DIM + TREND_DIM + CONTEXT_DIM
    CAPTION_COUNT = 8
    JUDGE_COUNT: int = eqx.static_field()
    CORPS_COUNT: int = eqx.static_field()
    SHOW_COUNT: int = eqx.static_field()

    # Model Layers
    judge_embed: eqx.nn.Embedding
    corps_embed: eqx.nn.Embedding
    show_embed: eqx.nn.Embedding
    
    lstm1: eqx.nn.LSTM
    lstm1_rev: eqx.nn.LSTM
    ln1: eqx.nn.LayerNorm
    
    lstm2: eqx.nn.LSTM
    lstm2_rev: eqx.nn.LSTM
    ln2: eqx.nn.LayerNorm
    
    attention_pool: AttentionPooling
    
    d1: eqx.nn.Dense
    d2: eqx.nn.Dense
    strength_dense: eqx.nn.Dense
    accuracy_trunk: eqx.nn.Dense
    
    judge_bias_raw: eqx.nn.Dense
    delta_q50_base: eqx.nn.Dense
    corps_corr_raw: eqx.nn.Dense
    
    q10_width_raw: eqx.nn.Dense
    q90_width_raw: eqx.nn.Dense

    # Statistics (for derived layers)
    delta_mean: jnp.ndarray
    delta_std: jnp.ndarray
    recap_mean: jnp.ndarray
    recap_std: jnp.ndarray
    category_mean: jnp.ndarray
    category_std: jnp.ndarray
    total_mean: jnp.ndarray
    total_std: jnp.ndarray
    
    matrix_m: jnp.ndarray

    def __init__(self, judge_count: int, corps_count: int, show_count: int, stats_dict: dict, key: jax.random.PRNGKey):
        self.JUDGE_COUNT = judge_count
        self.CORPS_COUNT = corps_count
        self.SHOW_COUNT = show_count
        
        # Load stats
        self.delta_mean = jnp.array(stats_dict["deltaMean"])
        self.delta_std = jnp.array([max(v, 1e-6) for v in stats_dict["deltaStd"]])
        self.recap_mean = jnp.array(stats_dict["recapMean"])
        self.recap_std = jnp.array([max(v, 1e-6) for v in stats_dict["recapStd"]])
        self.category_mean = jnp.array(stats_dict["categoryMean"])
        self.category_std = jnp.array([max(v, 1e-6) for v in stats_dict["categoryStd"]])
        self.total_mean = jnp.array(stats_dict["totalMean"])
        self.total_std = jnp.array(max(stats_dict["totalStd"], 1e-6))
        
        self.matrix_m = jnp.array([
            [1, 1, 0, 0, 0, 0, 0, 0],       # GE
            [0, 0, 0.5, 0.5, 0.5, 0, 0, 0], # Visual
            [0, 0, 0, 0, 0, 0.5, 0.5, 0.5]  # Music
        ])
        
        k1, k2, k3, k4, k5, k6, k7, k8, k9, k10, k11, k12, k13, k14, k15, k16 = jax.random.split(key, 16)
        
        self.judge_embed = eqx.nn.Embedding(judge_count, 24, key=k1)
        self.corps_embed = eqx.nn.Embedding(corps_count, 20, key=k2)
        self.show_embed = eqx.nn.Embedding(show_count, 12, key=k3)
        
        # BiLSTM 1 (128 units)
        lstm1_size = 128
        self.lstm1 = eqx.nn.LSTM(self.FEAT_DIM, lstm1_size, key=k4)
        self.lstm1_rev = eqx.nn.LSTM(self.FEAT_DIM, lstm1_size, key=k5)
        self.ln1 = eqx.nn.LayerNorm(lstm1_size * 2)
        
        # BiLSTM 2 (64 units)
        lstm2_size = 64
        self.lstm2 = eqx.nn.LSTM(lstm1_size * 2, lstm2_size, key=k6)
        self.lstm2_rev = eqx.nn.LSTM(lstm1_size * 2, lstm2_size, key=k7)
        self.ln2 = eqx.nn.LayerNorm(lstm2_size * 2)
        
        self.attention_pool = AttentionPooling(lstm2_size * 2, key=k8)
        
        # Dense Trunk
        self.d1 = eqx.nn.Dense(lstm2_size * 2 + self.TOTAL_STATIC_DIM + 24 * self.CAPTION_COUNT + self.CAPTION_COUNT + self.FEAT_DIM + 12, 512, key=k9)
        self.d2 = eqx.nn.Dense(512, 256, key=k10)
        self.strength_dense = eqx.nn.Dense(lstm2_size * 2, 24, key=k11)
        
        # Accuracy Trunk
        skip_size = 256 + self.TOTAL_STATIC_DIM + 24
        self.accuracy_trunk = eqx.nn.Dense(skip_size, 128, key=k12)
        
        self.judge_bias_raw = eqx.nn.Dense(24 * self.CAPTION_COUNT, self.CAPTION_COUNT, key=k13)
        self.delta_q50_base = eqx.nn.Dense(128, self.CAPTION_COUNT, key=k14)
        self.corps_corr_raw = eqx.nn.Dense(20, self.CAPTION_COUNT, key=k15)
        
        # Width heads
        width_in_size = skip_size + 24 * self.CAPTION_COUNT + 1
        self.q10_width_raw = eqx.nn.Dense(width_in_size, self.CAPTION_COUNT, key=k16)
        self.q90_width_raw = eqx.nn.Dense(width_in_size, self.CAPTION_COUNT, key=jax.random.split(k16)[1])

    def __call__(self, 
                 sequence: jnp.ndarray, # (SEQ_LEN, FEAT_DIM)
                 static: jnp.ndarray,   # (TOTAL_STATIC_DIM)
                 mask: jnp.ndarray,     # (SEQ_LEN)
                 judge_ids: jnp.ndarray, # (CAPTION_COUNT)
                 corps_id: jnp.ndarray,  # (1)
                 baseline_recap: jnp.ndarray, # (CAPTION_COUNT)
                 history_len: jnp.ndarray, # (1)
                 judge_bias_scale: jnp.ndarray, # (1)
                 corps_scale: jnp.ndarray, # (1)
                 agnostic_show_id: jnp.ndarray, # (1)
                 training: bool = False,
                 key: Optional[jax.random.PRNGKey] = None) -> jnp.ndarray:
        
        # Embeddings
        j_ids = jnp.atleast_1d(judge_ids)
        j_emb = jax.vmap(self.judge_embed)(j_ids) # (CAPTION_COUNT, 24)
        j_flat = j_emb.reshape(-1)
        
        c_id = jnp.atleast_1d(corps_id)[0]
        c_emb = self.corps_embed(c_id) # (20,)
        
        s_id = jnp.atleast_1d(agnostic_show_id)[0]
        s_emb = self.show_embed(s_id) # (12,)
        
        # BiLSTM 1
        def scan_lstm(lstm, x, reverse=False):
            if reverse: x = x[::-1]
            h = jnp.zeros(lstm.hidden_size)
            c = jnp.zeros(lstm.hidden_size)
            def step(carry, x_t):
                h_next, c_next = lstm(x_t, carry)
                return (h_next, c_next), h_next
            _, hs = jax.lax.scan(step, (h, c), x)
            if reverse: hs = hs[::-1]
            return hs

        hs1_fwd = scan_lstm(self.lstm1, sequence)
        hs1_rev = scan_lstm(self.lstm1_rev, sequence, reverse=True)
        hs1 = jnp.concatenate([hs1_fwd, hs1_rev], axis=-1)
        hs1 = self.ln1(hs1)
        
        # BiLSTM 2
        hs2_fwd = scan_lstm(self.lstm2, hs1)
        hs2_rev = scan_lstm(self.lstm2_rev, hs1, reverse=True)
        hs2 = jnp.concatenate([hs2_fwd, hs2_rev], axis=-1)
        hs2 = self.ln2(hs2)
        
        # Attention
        context = self.attention_pool(hs2, mask)
        
        # Last step
        last_step = sequence[-1] # Matches TS LastStepLayer logic
        
        # Concat for trunk
        trunk_in = jnp.concatenate([context, static, j_flat, baseline_recap, last_step, s_emb])
        d1_out = jax.nn.relu(self.d1(trunk_in))
        d2_out = jax.nn.relu(self.d2(d1_out))
        
        strength = jax.nn.relu(self.strength_dense(context))
        
        # Skip concat
        skip_concat = jnp.concatenate([d2_out, static, strength])
        
        # Accuracy trunk
        acc_trunk_out = jax.nn.relu(self.accuracy_trunk(skip_concat))
        
        # Q50 Delta (Normalized)
        j_bias_norm = self.judge_bias_raw(j_flat) * judge_bias_scale[0]
        c_corr_norm = self.corps_corr_raw(c_emb) * corps_scale[0]
        delta_q50_base_norm = self.delta_q50_base(acc_trunk_out)
        
        delta_q50_norm = delta_q50_base_norm + j_bias_norm + c_corr_norm
        
        # Quantile Widths (Normalized)
        width_in = jnp.concatenate([skip_concat, j_flat, history_len])
        q10_w_norm = jax.nn.softplus(self.q10_width_raw(width_in))
        q90_w_norm = jax.nn.softplus(self.q90_width_raw(width_in))
        
        q10_delta_norm = delta_q50_norm - q10_w_norm
        q90_delta_norm = delta_q50_norm + q90_w_norm
        
        # Derived Layers (Denormalization -> Summation -> Renormalization)
        
        # 1. Recap Layer
        # denormalized_delta = delta_norm * delta_std + delta_mean
        # denormalized_base = baseline_norm * recap_std + recap_mean
        # recap_pts = denormalized_delta + denormalized_base
        # recap_norm = (recap_pts - recap_mean) / recap_std
        
        # Simplified: recap_norm = (delta_norm * delta_std / recap_std) + baseline_norm + (delta_mean / recap_std)
        recap_norm = (delta_q50_norm * self.delta_std / self.recap_std) + baseline_recap + (self.delta_mean / self.recap_std)
        
        # 2. Category Layer (Summation rules)
        recap_pts = recap_norm * self.recap_std + self.recap_mean
        cat_pts = jnp.dot(self.matrix_m, recap_pts)
        cat_norm = (cat_pts - self.category_mean) / self.category_std
        
        # 3. Total Layer
        total_pts = jnp.sum(cat_pts)
        total_norm = (total_pts - self.total_mean) / self.total_std
        
        # Final Output: 36 dimensions
        # [q10_delta(8), q50_delta(8), q90_delta(8), recap(8), category(3), total(1)]
        return jnp.concatenate([
            q10_delta_norm, 
            delta_q50_norm, 
            q90_delta_norm, 
            recap_norm, 
            cat_norm, 
            jnp.atleast_1d(total_norm)
        ])
