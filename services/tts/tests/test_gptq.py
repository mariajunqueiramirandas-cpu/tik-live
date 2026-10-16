import unittest

import numpy as np

from tts import gptq


class GPTQTest(unittest.TestCase):
    def test_moves_outputs_less_than_rounding(self):
        rng = np.random.default_rng(0)
        w = rng.standard_normal((64, 128)).astype(np.float32)
        x = (rng.standard_normal((512, 32)) @ rng.standard_normal((32, 128))).astype(np.float32)  # correlated inputs
        q, s = gptq.quantize(w, x)
        q0, s0 = gptq.round_to_nearest(w)
        self.assertEqual((q.dtype, q.min() >= -8, q.max() <= 7), (np.int8, True, True))
        err = lambda q, s: np.linalg.norm(x @ (q * s[:, None] - w).T) / np.linalg.norm(x @ w.T)
        self.assertLess(err(q, s), 0.5 * err(q0, s0))  # measured 0.30x


if __name__ == "__main__":
    unittest.main()
