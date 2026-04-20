// src/paws/__tests__/trader-retrain-regime.test.ts
import { describe, it, expect } from 'vitest'
import { trainRegimePawConfig } from '../trader-retrain-regime.js'

describe('trainRegimePawConfig', () => {
  it('exports a trainRegimePawConfig with the expected shape', () => {
    expect(trainRegimePawConfig.id).toBe('trader-retrain-regime')
    expect(trainRegimePawConfig.name).toBe('Weekly regime model retrain')
    expect(trainRegimePawConfig.schedule).toBe('0 10 * * 0')
    expect(trainRegimePawConfig.project_id).toBe('trader')
    expect(trainRegimePawConfig.severity_threshold).toBe('low')
    // all five phase keys present
    expect(trainRegimePawConfig.phases.observe).toBeDefined()
    expect(trainRegimePawConfig.phases.analyze).toBeDefined()
    expect(trainRegimePawConfig.phases.decide).toBeDefined()
    expect(trainRegimePawConfig.phases.act).toBeDefined()
    expect(trainRegimePawConfig.phases.report).toBeDefined()
    // each phase is a non-empty string
    for (const phase of ['observe', 'analyze', 'decide', 'act', 'report'] as const) {
      const text = trainRegimePawConfig.phases[phase]
      expect(typeof text).toBe('string')
      expect(text.trim().length).toBeGreaterThan(0)
    }
  })

  it('observe phase references the training script with the staged output path', () => {
    const observe = trainRegimePawConfig.phases.observe
    expect(observe).toContain('scripts/train_regime.py')
    expect(observe).toContain('--out models/regime_xgb.joblib.new')
  })

  it('analyze phase defines both regression triggers (absolute floor + relative drop)', () => {
    const analyze = trainRegimePawConfig.phases.analyze
    expect(analyze).toContain('0.55')
    expect(analyze).toContain('0.05')
    // validation_accuracy is the field this phase reads from meta.json
    expect(analyze).toContain('validation_accuracy')
  })

  it('act phase rotates old joblib to dated backup before installing the new one', () => {
    const act = trainRegimePawConfig.phases.act
    // rotation preamble must mention bak
    expect(act).toContain('bak')
    // install new must include this exact move
    expect(act).toContain('mv models/regime_xgb.joblib.new models/regime_xgb.joblib')
    // rotation must happen before the install: the first "bak" reference
    // (moving old joblib out of the way) comes before the install move
    const bakIndex = act.indexOf('bak')
    const installIndex = act.indexOf('mv models/regime_xgb.joblib.new models/regime_xgb.joblib')
    expect(bakIndex).toBeGreaterThan(-1)
    expect(installIndex).toBeGreaterThan(bakIndex)
  })

  it('act phase restarts the engine systemd service', () => {
    const act = trainRegimePawConfig.phases.act
    expect(act).toContain('sudo systemctl restart trader-engine')
  })

  it('decide phase escalates regression to high severity', () => {
    const decide = trainRegimePawConfig.phases.decide
    // operator expects a clear "regression" trigger + escalation to "high"
    expect(decide.toLowerCase()).toContain('regression')
    expect(decide.toLowerCase()).toContain('high')
  })

  it('report phase gives a plain text single-line Telegram summary', () => {
    const report = trainRegimePawConfig.phases.report
    // plain text only: no HTML tags, no markdown bold, no double newlines
    expect(report).not.toContain('<')
    expect(report).not.toContain('>')
    expect(report).not.toContain('**')
    expect(report).not.toContain('\n\n')
  })

  it('schedule is Sunday 10am cron (0 10 * * 0)', () => {
    // pinned exact cron string; day-of-week 0 = Sunday
    expect(trainRegimePawConfig.schedule).toBe('0 10 * * 0')
    const parts = trainRegimePawConfig.schedule.split(' ')
    expect(parts).toHaveLength(5)
    expect(parts[0]).toBe('0')   // minute
    expect(parts[1]).toBe('10')  // hour (10am)
    expect(parts[2]).toBe('*')   // day-of-month
    expect(parts[3]).toBe('*')   // month
    expect(parts[4]).toBe('0')   // day-of-week = Sunday
  })

  it('no em dashes in any phase string', () => {
    // ClaudePaw hard rule: no em dashes anywhere
    for (const phase of ['observe', 'analyze', 'decide', 'act', 'report'] as const) {
      expect(trainRegimePawConfig.phases[phase]).not.toContain('\u2014')
    }
  })
})
