// src/paws/trader-retrain-regime.ts
//
// Phase 5 Task 5: Weekly regime model retraining Paw.
//
// This declarative config defines a Paw that runs every Sunday at
// 10am America/New_York (one hour after the 9am weekly report, so the
// report's snapshot is stable). It retrains the XGBoost regime model on
// the engine host, compares the new accuracy to the current meta.json,
// and either rotates the old joblib to a dated backup + installs the new
// model + restarts the engine, or refuses to rotate and pings the
// operator on regression.
//
// Rotation behaviour on healthy retrain:
//   1. old  models/regime_xgb.joblib       -> models/regime_xgb_YYYYMMDD.joblib.bak
//   2. new  models/regime_xgb.joblib.new   -> models/regime_xgb.joblib
//   3. old  models/regime_xgb.meta.json    -> models/regime_xgb_YYYYMMDD.meta.json.bak
//   4. new  models/regime_xgb.meta.json.new -> models/regime_xgb.meta.json
//   5. sudo systemctl restart trader-engine
//
// PRIMARY gate -- predictive skill (forward-return separation):
//   train_regime.py prints "PREDICTIVE_GATE: PASS|FAIL|INCONCLUSIVE" and exits
//   non-zero on FAIL. This is the metric with real content: do the PREDICTED
//   regimes separate forward returns (bull precedes higher forward returns than
//   bear)? FAIL or a non-zero exit -> regression, do not promote.
//
// SECONDARY backstop -- gross breakage on rule-reconstruction accuracy:
//   The *_accuracy fields are TAUTOLOGICAL (~0.99 always, label is a function of
//   the model's own features) so they cannot prove skill. They are kept only as
//   a crash detector: absolute floor below 0.55 or a relative drop over 0.05
//   means the trainer itself broke -> regression.
//
// Regression triggers (ANY flips the verdict to "regression"):
//   - PREDICTIVE_GATE: FAIL, or the script exited non-zero
//   - rule-reconstruction validation_accuracy below 0.55 (gross breakage)
//   - rule-reconstruction validation_accuracy more than 0.05 below prior
//
// INCONCLUSIVE (sparse test window) is NOT a regression: promote, but say so.
//
// On regression the old joblib + meta.json stay in place, no restart is
// issued, and the report emits a HIGH severity Telegram so the operator
// inspects before the next scheduled run.

export interface TrainRegimePawConfig {
  id: string
  name: string
  /** cron string interpreted in America/New_York by the scheduler. */
  schedule: string
  project_id: string
  /**
   * 'low' keeps the cycle auto-running (no approval gate). Regression is
   * handled inside the phase prompts, not via the scheduler severity gate.
   */
  severity_threshold: 'low' | 'medium' | 'high'
  phases: {
    observe: string
    analyze: string
    decide: string
    act: string
    report: string
  }
}

export const trainRegimePawConfig: TrainRegimePawConfig = {
  id: 'trader-retrain-regime',
  name: 'Weekly regime model retrain',
  schedule: '0 10 * * 0',
  project_id: 'trader',
  severity_threshold: 'low',
  phases: {
    observe: [
      'SSH to your-engine-host and run the retrainer, writing the',
      'new model to a staged path so the old joblib stays live while',
      'we verify it:',
      '',
      '  cd ~/Projects/trader-engine && uv run python scripts/train_regime.py --out models/regime_xgb.joblib.new; echo "EXIT_STATUS=$?"',
      '',
      'Return the training output verbatim AND the EXIT_STATUS line. The',
      'script exits non-zero when the predictive gate FAILS. Downstream',
      'needs the "PREDICTIVE_GATE:" line, the forward-return-by-regime',
      'block, the per-split accuracy lines, and the exit status.',
    ].join('\n'),

    analyze: [
      'Two gates. The PRIMARY gate is predictive skill; the accuracy is a',
      'tautology kept only as a crash detector. Read both.',
      '',
      'PRIMARY -- predictive gate (forward-return separation):',
      '  From the OBSERVE output read the "PREDICTIVE_GATE:" line. It is',
      '  PASS, FAIL, or INCONCLUSIVE. Also read EXIT_STATUS.',
      '  - FAIL or EXIT_STATUS not 0  -> verdict "regression".',
      '  - INCONCLUSIVE (sparse test window) -> verdict "healthy-inconclusive":',
      '    promote, but note the predictive check could not run.',
      '  - PASS -> predictive gate satisfied.',
      '',
      'SECONDARY -- gross-breakage backstop on rule-reconstruction accuracy:',
      '  The *_accuracy fields are tautological (label is a function of the',
      "  model's own features) so a ~0.99 value proves nothing about skill;",
      '  it only catches a broken trainer. Extract the new [val] accuracy.',
      '  cat ~/Projects/trader-engine/models/regime_xgb.meta.json for the',
      '  prior validation_accuracy. Flag "regression" if EITHER fires:',
      '    - absolute floor: new accuracy below 0.55',
      '    - relative drop:  new accuracy more than 0.05 below prior',
      '',
      'Final verdict: "regression" if the predictive gate failed OR the',
      'backstop tripped. Otherwise "healthy" (or "healthy-inconclusive").',
      'Return the predictive verdict, the bull-minus-bear separation, both',
      'accuracies, and the final verdict for DECIDE.',
    ].join('\n'),

    decide: [
      'If ANALYZE flagged "healthy" or "healthy-inconclusive": proceed to',
      'ACT. The rotation and restart run automatically.',
      '',
      'If ANALYZE flagged "regression": skip ACT entirely. Do NOT touch',
      'the live joblib. Emit severity high so the operator gets pinged',
      'and can inspect the regression before the next scheduled run.',
      'The old model stays live until manual intervention.',
    ].join('\n'),

    act: [
      'Only runs on the healthy verdict. Rotate the old artifacts to a',
      'dated backup, install the staged new ones, then restart the',
      'engine. SSH to your-engine-host and run:',
      '',
      '  cd ~/Projects/trader-engine && \\',
      '  DATE=$(date +%Y%m%d) && \\',
      '  mv models/regime_xgb.joblib models/regime_xgb_${DATE}.joblib.bak && \\',
      '  mv models/regime_xgb.joblib.new models/regime_xgb.joblib && \\',
      '  mv models/regime_xgb.meta.json models/regime_xgb_${DATE}.meta.json.bak && \\',
      '  mv models/regime_xgb.meta.json.new models/regime_xgb.meta.json && \\',
      '  sudo systemctl restart trader-engine',
      '',
      'Report the rotation and restart status so REPORT can summarise',
      'them in a single Telegram line.',
    ].join('\n'),

    report: [
      'One line plain text Telegram summary of the cycle. Lead with the',
      'PREDICTIVE gate (the real signal), not the tautological accuracy.',
      'Healthy example: "Regime retrain OK. Predictive gate PASS, bull-minus-bear fwd sep +0.018. Rule-fit acc 0.99 (tautological). Rotated to regime_xgb_20260628.joblib.bak. Engine restarted."',
      'Inconclusive example: "Regime retrain OK (predictive gate INCONCLUSIVE, sparse test window). Promoted. Rule-fit acc 0.99. Engine restarted."',
      'Regression example: "Regime retrain REGRESSION. Predictive gate FAIL (bull did not beat bear). Old model retained. Operator inspection required."',
      'No HTML, no markdown, no double newlines. Plain text only.',
    ].join('\n'),
  },
}
