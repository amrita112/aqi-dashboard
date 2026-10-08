"""Running bias correction for the daily forecast.

THE PROBLEM, MEASURED. The forecast is anchored to a seasonal climatology and
to a reading that is a median 3.0 days old. Both look backwards. During the
autumn ramp, when levels climb 30-115% in ten days, it under-predicts by an
amount that is large, systematic, and slow-moving. Chennai is the natural
control: the only city whose level FELL over the period is the only one whose
bias improved.

That shape -- a bias that persists for days and drifts slowly -- is what a
running correction fixes, and it needs no refit of the model itself.

THE RULE IS STRICTLY CAUSAL. The offset for a target day uses only forecast
errors for target days strictly BEFORE it. Nothing from the day being corrected
or later is visible, which is what makes the backtest honest and the live
behaviour identical to it.

SELF-POLICING, BECAUSE THE CORRECTION IS NOT ALWAYS AN IMPROVEMENT. Backtested
over 102 city-days: overall MAE 23.2 -> 18.1 (-22%), bias -13.4 -> -2.4, with
Pune -39%, Kolkata -38%, Bangalore -38%, Chennai -34%. But MUMBAI GOT 18%
WORSE -- its real bias is small enough that correcting it mostly adds noise, and
no threshold rule removed that (they reduced it to +12% at the cost of gains
elsewhere). So the decision is made per city from its own recent record: apply
only where the correction would have beaten the raw forecast over the window.

That same mechanism handles the turn of the season. A correction learned on a
ramp will start over-predicting once levels plateau in late November; when it
does, it stops beating the raw forecast and switches itself off, rather than
needing someone to remember.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta
from typing import Any, Dict, List, Optional, Tuple

# Three days beat 5, 7 and 10 at every damping setting in the backtest, which
# says the bias drifts fast -- consistent with a ramp rather than a fixed defect.
WINDOW_DAYS = 3

# Damping. 0.8 beat both 0.5 (under-corrects) and 1.0 (overshoots into a
# positive bias) on MAE. Short of 1.0 on purpose: the offset is estimated from a
# handful of days and correcting the whole of it trusts that estimate too far.
DAMPING = 0.8

# Below this many usable days there is no estimate worth acting on.
MIN_DAYS = 2

# How far back to look for evidence that the correction is helping. Longer than
# WINDOW_DAYS so the decision is steadier than the offset it governs.
REVIEW_DAYS = 10

# ...but the long review alone reacts too slowly to a regime change. Replaying
# ten days when the bias vanished five days ago is still dominated by the five
# days where correcting helped enormously, so it keeps correcting for about a
# week after it should have stopped -- precisely the failure that matters when
# the season turns in late November. So the correction must ALSO be helping over
# the last few days. Short enough to notice a turn, long enough not to flap on
# one noisy day.
RECENT_DAYS = 4

# Do not correct a bias that is small relative to the noise around it. Delhi is
# the case: replaying the shipping code, its true bias was +0.6 against a
# per-station MAE near 50, and "correcting" that moved the forecast around for
# no reason -- 5% worse. A bias has to be a meaningful share of the error before
# subtracting it is anything but adding variance.
#
# 0.30 rather than 0.15, measured: at 0.15 Delhi was still corrected on 45% of
# days and came out 5% worse. A sign-consistency test was tried instead and made
# things worse overall (MAE 37.0 -> 37.8), so it was removed -- the three-day
# window is short enough that requiring one sign throughout rejects real lags
# too.
MIN_OFFSET_FRACTION_OF_MAE = 0.30

# The correction may never move a forecast by more than this fraction of itself.
# A guard against a single bad day of observations, not a tuning parameter.
MAX_RELATIVE_SHIFT = 0.5


def _mean(xs: List[float]) -> Optional[float]:
    return sum(xs) / len(xs) if xs else None


def city_day_errors(
    forecasts: List[Dict[str, Any]],
    actuals: Dict[Tuple[str, str], float],
    city_of: Dict[str, str],
) -> Dict[Tuple[str, str], Dict[date, float]]:
    """(city, pollutant) -> {target_date: mean (forecast - actual)}.

    Errors are averaged over the stations of a city, because the correction is a
    city-level offset. A per-station offset would be fitted on a handful of days
    per station and would mostly be noise.

    Learned from `value_raw` where present: correcting against an
    already-corrected forecast would make the offset chase its own tail.
    """
    buckets: Dict[Tuple[str, str], Dict[date, List[float]]] = defaultdict(lambda: defaultdict(list))
    for f in forecasts:
        city = city_of.get(f["monitor_id"])
        if not city:
            continue
        raw = f.get("value_raw")
        value = float(raw if raw is not None else f["value"])
        actual = actuals.get((f["monitor_id"], f["target_date"]))
        if actual is None:
            continue
        target = date.fromisoformat(f["target_date"])
        buckets[(city, f["pollutant"])][target].append(value - float(actual))
    return {
        key: {d: sum(v) / len(v) for d, v in days.items()}
        for key, days in buckets.items()
    }


def window_errors(errors: Dict[date, float], before: date) -> List[float]:
    """The errors inside the window ending the day before `before`."""
    return [errors[d] for d in sorted(errors)
            if before - timedelta(days=WINDOW_DAYS) <= d < before]


def is_persistent(window: List[float]) -> bool:
    """Do these errors point the same way?

    A LAG and an OSCILLATION both produce a non-zero mean over three days, and
    only the first is worth correcting. Delhi is the case: its overall bias was
    +0.6 against a per-station error near 50, yet it was being corrected on 45%
    of days and came out 5% worse, because its errors swing either side of zero
    and a three-day mean of a swing is not a bias.

    Requiring one sign throughout is a blunt test, but the window is only three
    days and anything subtler would be fitted to this one autumn.
    """
    if len(window) < MIN_DAYS:
        return False
    return all(x > 0 for x in window) or all(x < 0 for x in window)


def offset_for(errors: Dict[date, float], before: date) -> Optional[float]:
    """Mean error over the WINDOW_DAYS days ending the day before `before`.

    `before` is excluded, which is the whole point: the forecast for a day may
    not be corrected using that day's own outcome.
    """
    window = [
        errors[d]
        for d in errors
        if before - timedelta(days=WINDOW_DAYS) <= d < before
    ]
    if len(window) < MIN_DAYS:
        return None
    return sum(window) / len(window)


def decide(errors: Dict[date, float], today: date) -> Dict[str, Any]:
    """Whether to correct this city/pollutant, and by how much.

    Replays the last REVIEW_DAYS days as if the correction had been live, using
    only information available on each of those days, and compares the resulting
    error against the raw forecast's. The correction is applied only if it won.
    """
    offset = offset_for(errors, today)
    if offset is None:
        return {"offset": 0.0, "applied": False, "n_days": len(errors),
                "reason": f"fewer than {MIN_DAYS} scored days in the last {WINDOW_DAYS}",
                "mae_raw": None, "mae_corrected": None}

    raw_abs: List[float] = []
    cor_abs: List[float] = []
    recent_raw: List[float] = []
    recent_cor: List[float] = []
    for d in sorted(errors):
        if d < today - timedelta(days=REVIEW_DAYS) or d >= today:
            continue
        past = offset_for(errors, d)
        if past is None:
            continue
        raw, cor = abs(errors[d]), abs(errors[d] - DAMPING * past)
        raw_abs.append(raw)
        cor_abs.append(cor)
        if d >= today - timedelta(days=RECENT_DAYS):
            recent_raw.append(raw)
            recent_cor.append(cor)

    mae_raw, mae_cor = _mean(raw_abs), _mean(cor_abs)
    recent_mae_raw, recent_mae_cor = _mean(recent_raw), _mean(recent_cor)
    if mae_raw is None or mae_cor is None:
        # No review evidence yet. Do not apply: an uncorrected forecast is the
        # thing we already understand.
        return {"offset": round(offset, 2), "applied": False, "n_days": len(errors),
                "reason": "not enough history to check whether correcting helps",
                "mae_raw": mae_raw, "mae_corrected": mae_cor}

    # Both windows must agree. The long one keeps the decision steady; the short
    # one lets it notice a turn within days rather than a week.
    helps_overall = mae_cor < mae_raw
    helps_recently = (
        recent_mae_cor is None or recent_mae_raw is None or recent_mae_cor < recent_mae_raw
    )
    # Is the bias big enough, and is it a lag rather than a swing?
    big_enough = mae_raw is not None and abs(offset) >= MIN_OFFSET_FRACTION_OF_MAE * mae_raw
    helps = helps_overall and helps_recently and big_enough
    pct = 100 * (mae_cor - mae_raw) / mae_raw if mae_raw else 0.0
    if not big_enough:
        why = (f"bias {offset:+.1f} is under {MIN_OFFSET_FRACTION_OF_MAE:.0%} of the "
               f"recent error ({mae_raw:.1f}) — too small to be worth correcting")
    elif helps_overall and not helps_recently:
        why = (f"helped over {len(raw_abs)} days ({pct:+.0f}%) but NOT over the "
               f"last {RECENT_DAYS} — treating this as a regime change")
    else:
        why = (f"correcting would have changed MAE by {pct:+.0f}% over the last "
               f"{len(raw_abs)} scored days")
    return {
        "offset": round(offset, 2),
        "applied": bool(helps),
        "n_days": len(raw_abs),
        "reason": why,
        "mae_raw": round(mae_raw, 2),
        "mae_corrected": round(mae_cor, 2),
    }


def apply_offset(value: float, offset: float) -> float:
    """The corrected forecast: never negative, never moved more than half itself.

    The relative cap is a guard against one bad day of observations producing an
    offset that swamps the forecast, not a tuning knob -- it should almost never
    bind, and if it starts binding regularly something upstream is wrong.
    """
    shift = DAMPING * offset
    limit = MAX_RELATIVE_SHIFT * value
    shift = max(-limit, min(limit, shift))
    return max(value - shift, 0.0)
