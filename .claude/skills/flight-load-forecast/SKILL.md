---
name: flight-load-forecast
description: "Builds a trainable ensemble + critic system for airline flight load forecasting (absolute pax ≤ Total AU) at 30/14/7/1-3 days before departure. Use when the user asks to create, build, or generate a flight sales/load prediction model, booking curve forecast, RMS forecasting API, or ensemble for airline revenue management with historical finals and daily sales updates."
type: workflow
lifecycle: active
---

# Flight Load Forecast — Ensemble + Critic for Airline RMS

Build a production-ready, trainable ensemble of models + critic that predicts absolute passenger count at departure (capped at Total AU) for horizons 30 / 14 / 7 / 1-3 days before departure.

Data sources:

* Historical: final TICKETS + compressed CURVE strings (e.g. "0:7" or "0:1 1:5")
* Daily: last-14-days sales + availability file with Total AU (hard capacity)

Integration: FastAPI REST endpoint returning JSON.

## Core Requirements (do not violate)

1. Target = absolute passengers on departure ≤ Total AU.
2. Critic must enforce:
   * prediction ≤ Total AU
   * prediction ≥ current booked
   * select the best model from the ensemble for the horizon/route
   * no runtime errors / invalid outputs
3. Learning = hybrid: full nightly retrain on all history + incremental updates on fresh daily curves.
4. Easy RMS hookup via FastAPI `/predict`.
5. Start by analyzing incoming data, then produce forecasts. Models must be retrainable.

## Workflow

1. Data layer
   * Parse SalesHistory.csv (REIS, FLYDATE, TICKETS, CURVE, REFUND_CURVE, GROUP, CORP, REVENUE, CITY1, CITY2).
   * Parse SalesTickets.csv and Tickets_SALE_Last14Days.csv (DTD, NFARE, RBD, GROUP, CORP).
   * Parse daily availability file (extract Total AU as capacity, Free/Total SegBkd, configuration).
   * Build booking curves: expand CURVE strings into DTD → cumulative booked.
   * Features: current booked, DTD, day-of-week, month, route (CITY1-CITY2), historical same-route/same-DOW averages, group/corp flags, revenue signals, days-to-departure bins.
2. Ensemble (group of models)
   * Per horizon (30d, 14d, 7d, 1-3d) or shared with horizon feature:
      * LightGBM / XGBoost on tabular curve features + historical aggregates.
      * LSTM or simple sequence model on horizontal (intra-flight) and vertical (inter-flight same DTD) booking curves.
   * Stacking or weighted average meta-learner.
   * Fallback: route + DOW historical mean when data is sparse.
3. Critic
   * Hard guards: clip to [current_booked, Total AU].
   * Model selector: pick lowest recent MAE model for the route/horizon.
   * Consistency checks: monotonicity of predicted remaining, no NaN/inf, bounds.
   * Output critic_flag and chosen_model.
4. Training
   * Full retrain job (nightly): rebuild features from all history, train ensemble, save artifacts.
   * Incremental: update curves and light re-calibration on new daily files.
   * Persist models with joblib + metadata (version, train date, metrics).
5. API (FastAPI)
   * POST `/predict` body: `{"reis": "...", "flydate": "DD.MM.YYYY", "current_booked": N, "total_au": N, "dtd": N}`
   * Response:

```json
{
  "reis": "...",
  "flydate": "...",
  "horizons": {
    "30d": {"pred": 42, "confidence": 0.8},
    "14d": {"pred": 51, "confidence": 0.85},
    "7d": {"pred": 58, "confidence": 0.9},
    "1_3d": {"pred": 62, "confidence": 0.95}
  },
  "critic": {"ok": true, "chosen_model": "lgbm_7d", "flags": []}
}
```
