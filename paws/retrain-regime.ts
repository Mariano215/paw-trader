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
// Regression triggers (either one flips the verdict to "regression"):
//   - absolute floor: new validation_accuracy below 0.55
//   - relative drop:  new validation_accuracy more than 0.05 below prior
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
      'we verify accuracy:',
      '',
      '  cd ~/Projects/trader-engine && uv run python scripts/train_regime.py --out models/regime_xgb.joblib.new',
      '',
      'Return the training output verbatim. The operator downstream needs',
      'the accuracy line and the confusion matrix for every split.',
    ].join('\n'),

    analyze: [
      'Parse the training output from the OBSERVE phase. Extract the',
      'walk-forward val accuracy value (the [val] accuracy line).',
      '',
      'Read the existing models/regime_xgb.meta.json on the engine host',
      '(cat ~/Projects/trader-engine/models/regime_xgb.meta.json) and',
      'pull the prior validation_accuracy field.',
      '',
      'Compare new accuracy to prior validation_accuracy. Flag',
      '"regression" if EITHER trigger fires:',
      '  - absolute floor: new accuracy below 0.55',
      '  - relative drop:  new accuracy more than 0.05 below prior',
      '    (prior minus new greater than 0.05)',
      '',
      'Otherwise flag "healthy" and return both values plus the verdict',
      'so the DECIDE phase can gate on it.',
    ].join('\n'),

    decide: [
      'If ANALYZE flagged "healthy": proceed to ACT. The rotation and',
      'restart run automatically.',
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
      'One line plain text Telegram summary of the cycle.',
      'Healthy example: "Regime retrain OK. Accuracy 0.67 (prev 0.65). Rotated to regime_xgb_20260426.joblib.bak. Engine restarted."',
      'Regression example: "Regime retrain REGRESSION. New accuracy 0.48 below 0.55 threshold. Old model retained. Operator inspection required."',
      'No HTML, no markdown, no double newlines. Plain text only.',
    ].join('\n'),
  },
}
