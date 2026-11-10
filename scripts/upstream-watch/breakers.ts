// A run has up to three phases in one conversation: the check, then the fix
// when the report says the plugin needs one, then the feature when the release
// lifts something the plugin couldn't do. Each has its own minutes and
// dollars: past them the model is told to hand in what it has, and past HARD
// times them the phase stops without it.

export const HARD = 1.5;

export type Breaker = { minutes: number; dollars: number };

// The most a run can take: every phase to its hard stop.
export function worst(phases: Breaker[]): Breaker {
  return {
    minutes: phases.reduce((sum, p) => sum + p.minutes * HARD, 0),
    dollars: phases.reduce((sum, p) => sum + p.dollars * HARD, 0),
  };
}
