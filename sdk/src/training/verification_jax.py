import jax
import jax.numpy as jnp
import equinox as eqx
import json
from v9_model import V9SubcaptionModel

def verify_model():
    # Mock stats matching TS structure
    dummy_stats = {
        "deltaMean": [0.0]*8,
        "deltaStd": [1.0]*8,
        "recapMean": [80.0]*8,
        "recapStd": [5.0]*8,
        "categoryMean": [160.0, 120.0, 120.0],
        "categoryStd": [10.0, 5.0, 5.0],
        "totalMean": 80.0,
        "totalStd": 5.0,
        "deltaWeights": [1.0]*8
    }
    
    key = jax.random.PRNGKey(0)
    model = V9SubcaptionModel(
        judge_count=100, 
        corps_count=50, 
        show_count=500, 
        stats_dict=dummy_stats, 
        key=key
    )
    
    # Dummy input
    batch_size = 1
    seq = jnp.zeros((SEQ_LEN, 101))
    static = jnp.zeros((169 + 8 + 0))
    mask = jnp.ones((SEQ_LEN))
    judge_ids = jnp.zeros((8), dtype=jnp.int32)
    corps_id = jnp.zeros((1), dtype=jnp.int32)
    baseline_recap = jnp.zeros((8))
    history_len = jnp.zeros((1))
    scale = jnp.ones((1))
    agnostic_show_id = jnp.zeros((1), dtype=jnp.int32)
    
    # Forward pass
    output = model(
        seq, static, mask, judge_ids, corps_id, 
        baseline_recap, history_len, scale, scale, agnostic_show_id
    )
    
    print(f"Output shape: {output.shape} (Expected: (36,))")
    
    # DCI Hierarchy Verification
    recap = output[24:32]
    cat = output[32:35]
    total = output[35]
    
    # Denormalize for testing
    recap_pts = recap * jnp.array(dummy_stats["recapStd"]) + jnp.array(dummy_stats["recapMean"])
    cat_pts = cat * jnp.array(dummy_stats["categoryStd"]) + jnp.array(dummy_stats["categoryMean"])
    tot_pts = total * dummy_stats["totalStd"] + dummy_stats["totalMean"]
    
    expected_ge = recap_pts[0] + recap_pts[1]
    expected_vis = (recap_pts[2] + recap_pts[3] + recap_pts[4]) / 2.0
    expected_mus = (recap_pts[5] + recap_pts[6] + recap_pts[7]) / 2.0
    expected_tot = expected_ge + expected_vis + expected_mus
    
    print(f"GE: Derived={cat_pts[0]:.2f}, Expected={expected_ge:.2f}")
    print(f"Visual: Derived={cat_pts[1]:.2f}, Expected={expected_vis:.2f}")
    print(f"Music: Derived={cat_pts[2]:.2f}, Expected={expected_mus:.2f}")
    print(f"Total: Derived={tot_pts:.2f}, Expected={expected_tot:.2f}")
    
    if jnp.allclose(cat_pts[0], expected_ge, atol=1e-2) and \
       jnp.allclose(tot_pts, expected_tot, atol=1e-2):
        print("HIERARCHY CHECK SUCCESS")
    else:
        print("HIERARCHY CHECK FAILED")

if __name__ == "__main__":
    from v9_model import V9SubcaptionModel
    SEQ_LEN = 15
    verify_model()
