"""Pass probabilities of a non-inferiority margin on the paired difference's one-sided 95% lower bound (paired bootstrap), against the exact-count
rule "resolved no lower", by simulation. Usage: margin_power.py [discordant_share=0.09] [N:MARGIN ...]  (default: the 10*sqrt(60/n) rule at 60, 120, 150; N:MARGIN gives a margin in points, e.g. 60:10 150:5)
n paired tasks; q is the share of tasks resolved by exactly one arm (observed 6 of 60 in the 1.0.8 gate and 5 of 60 in the 1.0.10 gate); delta is the true
Q-minus-P difference in points. Margin M(n) = 10 * sqrt(60 / n) points, -10 at 60 tasks."""
import sys

import numpy as np

rng = np.random.default_rng(1)
q = float(sys.argv[1]) if len(sys.argv) > 1 else 0.09
CASES = [tuple(map(float, a.split(":"))) for a in sys.argv[2:]]
MARGINS = {int(n): m for n, m in CASES}


def margin(n):
    return MARGINS.get(n, 10 * (60 / n) ** 0.5)


def pass_margin(n, delta, sims=3000, boot=1000):
    pq, pp = (q + delta / 100) / 2, (q - delta / 100) / 2
    if pp < 0 or pq < 0:
        return float("nan")
    ok = 0
    for _ in range(sims):
        xb, xa, x0 = rng.multinomial(n, [pq, pp, 1 - pq - pp])
        draws = rng.multinomial(n, [xb / n, xa / n, x0 / n], size=boot)
        ok += np.sort(100 * (draws[:, 0] - draws[:, 1]) / n)[int(0.05 * boot)] >= -margin(n)
    return ok / sims


def pass_exact(n, delta, sims=20000):
    pq, pp = (q + delta / 100) / 2, (q - delta / 100) / 2
    x = rng.multinomial(n, [pq, pp, 1 - pq - pp], size=sims)
    return float((x[:, 0] >= x[:, 1]).mean())


print(f"discordant share {q:.0%}")
for n in (sorted(MARGINS) or (60, 120, 150)):
    print(f"n={n}: margin {margin(n):.1f} points")
    print("  true diff (points):        ", "   ".join(f"{d:>5}" for d in (0, -3, -5, -8)))
    print("  P(pass), margin rule:      ", "   ".join(f"{pass_margin(n, d):5.2f}" for d in (0, -3, -5, -8)))
    print("  P(pass), exact-count rule: ", "   ".join(f"{pass_exact(n, d):5.2f}" for d in (0, -3, -5, -8)))
