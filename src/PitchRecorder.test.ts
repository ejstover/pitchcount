import { describe, expect, it } from 'vitest'
import { pitchTargetAt } from './PitchRecorder'

describe('shared pitch target hit detection', () => {
  it('records all four filled diagonal corners as outside balls', () => {
    expect(pitchTargetAt(.12, .12)).toEqual({ type: 'ball', location: 'upIn' })
    expect(pitchTargetAt(.88, .12)).toEqual({ type: 'ball', location: 'upOut' })
    expect(pitchTargetAt(.12, .88)).toEqual({ type: 'ball', location: 'downIn' })
    expect(pitchTargetAt(.88, .88)).toEqual({ type: 'ball', location: 'downOut' })
  })
  it('uses the inner square and round center, including their visible edges', () => {
    expect(pitchTargetAt(.2, .2)).toEqual({ type: 'called', location: 'upIn' })
    expect(pitchTargetAt(.8, .8)).toEqual({ type: 'called', location: 'downOut' })
    expect(pitchTargetAt(.5, .5)).toEqual({ type: 'called', location: 'middle' })
    expect(pitchTargetAt(.401, .401)).toEqual({ type: 'called', location: 'upIn' })
    expect(pitchTargetAt(.199, .25)).toEqual({ type: 'ball', location: 'upIn' })
    expect(pitchTargetAt(.801, .75)).toEqual({ type: 'ball', location: 'downOut' })
  })
  it('cancels outside the target and in the clipped corners', () => {
    for (const [x, y] of [[-.01, .5], [1.01, .5], [.5, -.01], [.5, 1.01], [.05, .05], [.95, .05], [.05, .95], [.95, .95]]) {
      expect(pitchTargetAt(x, y)).toBeNull()
    }
  })
})
