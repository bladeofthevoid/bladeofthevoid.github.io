/**
 * player/AnimationController.js
 * -----------------------------------------------------------------------
 * Animation state graph, blending, and pose data infrastructure.
 *
 * Design contract:
 *   - No Three.js dependency — pure data logic.
 *   - AnimationState produces a PoseData plain object each tick.
 *   - AnimationGraph manages a FROM→TO blend and ticks both states.
 *   - AnimationBlend lerps between two PoseDatas by weight.
 *   - Animator.js consumes PoseData and writes to mesh joints.
 *
 * This separation (graph knows WHAT to play, Animator knows HOW to
 * apply it) means combat actions (attacks, parries, abilities) can later
 * inject their own AnimationStates and BodyMasks without touching the
 * Dead Star mesh wiring at all.
 *
 * BodyMask (future combat use):
 *   FULL  — state controls every joint (all current states)
 *   UPPER — state controls shoulders, elbows, hands only
 *           (e.g. attack while locomotion runs on LOWER)
 *   LOWER — state controls hips, knees, feet only
 *
 * PoseData schema (all fields optional; missing = 0 / identity):
 *   rootRotX, rootRotZ          — root group lean
 *   chestScaleY                 — breathing / bounce (1 = neutral)
 *   headRotX                    — head tilt (Y spin managed separately)
 *   leftShoulderX, rightShoulderX
 *   leftHipX, rightHipX
 *   leftKneeX, rightKneeX
 * -----------------------------------------------------------------------
 */

// ── BodyMask ─────────────────────────────────────────────────────────────

/** Declares which body region an AnimationState drives. */
export const BodyMask = Object.freeze({
  FULL:  'full',
  UPPER: 'upper',
  LOWER: 'lower',
});

// ── AnimationState ────────────────────────────────────────────────────────

/**
 * A named, self-ticking animation state.
 *
 * The update function receives:
 *   (time: number, dt: number, context: object) → PoseData
 *
 * `time`    — seconds since this state was last reset/entered
 * `dt`      — frame delta (seconds)
 * `context` — shared read-only bag from AnimationGraph.tick() callers
 *             (walkPhase, speed, maxSpeed, phase, …)
 *
 * Keeping the update function pure (no external mutation) makes it
 * trivial to test states in isolation and to layer them via BodyMask.
 */
export class AnimationState {
  /**
   * @param {string}   name
   * @param {string}   mask     BodyMask constant
   * @param {Function} updateFn (time, dt, context) => PoseData
   */
  constructor(name, mask, updateFn) {
    this.name     = name;
    this.mask     = mask;
    this._updateFn = updateFn;
    this.time      = 0;
  }

  /**
   * Advance internal time and produce a PoseData.
   * @param {number} dt
   * @param {object} context
   * @returns {object} PoseData
   */
  tick(dt, context) {
    this.time += dt;
    return this._updateFn(this.time, dt, context);
  }

  /** Reset local time — call when transitioning INTO this state. */
  reset() {
    this.time = 0;
  }
}

// ── AnimationBlend ────────────────────────────────────────────────────────

/**
 * Static utility: linearly interpolates two PoseData objects.
 *
 * Keys present in `to` but missing in `from` default their "from" value
 * to 0 (identity). Keys present in `from` but missing in `to` are
 * omitted from the output (the consumer's _applyPose falls back to 0).
 *
 * This design means new pose keys can be added to a subset of states
 * without breaking older states that don't know about them.
 */
export class AnimationBlend {
  /**
   * @param {object|null} from   Source PoseData (weight 0 end)
   * @param {object|null} to     Target PoseData (weight 1 end)
   * @param {number}      weight 0 = fully from, 1 = fully to
   * @returns {object} Blended PoseData
   */
  static lerp(from, to, weight) {
    if (!from) return to  ?? {};
    if (!to)   return from;
    if (weight <= 0) return from;
    if (weight >= 1) return to;

    const result = {};
    // All keys the "to" state defines
    for (const key of Object.keys(to)) {
      const a = from[key] ?? 0;
      const b = to[key]   ?? 0;
      result[key] = a + (b - a) * weight;
    }
    return result;
  }
}

// ── AnimationGraph ────────────────────────────────────────────────────────

/**
 * Manages a registry of AnimationStates and one active FROM→TO blend.
 *
 * Usage:
 *   const graph = new AnimationGraph();
 *   graph.addState(new AnimationState('idle', BodyMask.FULL, idleFn));
 *   graph.addState(new AnimationState('run',  BodyMask.FULL, runFn));
 *   graph.snap('idle');
 *   // per frame:
 *   const pose = graph.tick(dt, context);
 *
 * Calling transitionTo() mid-blend replaces the current "to" state and
 * restarts the blend from whatever the current FROM→TO output was.
 * This prevents hard jumps when transitions are interrupted.
 *
 * Future (upper/lower body split):
 *   Run two graphs in parallel — one per BodyMask — and merge their
 *   outputs using the mask before passing to Animator._applyPose.
 *   No changes needed here; this class is already ready for that.
 */
export class AnimationGraph {
  constructor() {
    /** @type {Map<string, AnimationState>} */
    this._states     = new Map();
    this._current    = null;   // AnimationState we are blending TO
    this._previous   = null;   // AnimationState we are blending FROM
    this._weight     = 1.0;    // 0 → 1 during blend
    this._blendRate  = 99;     // 1 / blend_duration_seconds
  }

  /**
   * Register a state. Returns `this` for chaining.
   * @param {AnimationState} state
   * @returns {AnimationGraph}
   */
  addState(state) {
    this._states.set(state.name, state);
    return this;
  }

  /**
   * Immediate cut to a state with no blend.
   * Use for first-frame initialisation or hard cuts (e.g. respawn).
   * @param {string} name
   */
  snap(name) {
    const s = this._states.get(name);
    if (!s) return;
    s.reset();
    this._current  = s;
    this._previous = null;
    this._weight   = 1.0;
  }

  /**
   * Begin blending to a new state over `duration` seconds.
   * Safe to call every frame (no-ops if already targeting this state).
   * @param {string} name
   * @param {number} duration  Blend duration in seconds
   */
  transitionTo(name, duration = 0.15) {
    const s = this._states.get(name);
    if (!s || s === this._current) return;

    s.reset();
    this._previous  = this._current;
    this._current   = s;
    this._weight    = 0.0;
    this._blendRate = duration > 0.001 ? 1 / duration : 999;
  }

  /**
   * Advance the graph by dt and return a blended PoseData.
   * Both the current and previous states are ticked so neither freezes
   * mid-blend (important when a state like idle has ongoing animation).
   *
   * @param {number} dt       Frame delta (seconds)
   * @param {object} context  Shared read-only data bag for state functions
   * @returns {object} Blended PoseData
   */
  tick(dt, context) {
    if (!this._current) return {};

    this._weight = Math.min(1.0, this._weight + dt * this._blendRate);

    const currentPose  = this._current.tick(dt, context);
    const previousPose = this._previous ? this._previous.tick(dt, context) : null;

    return AnimationBlend.lerp(previousPose, currentPose, this._weight);
  }

  // ── Accessors for DebugUI ───────────────────────────────────────────────

  get currentName()    { return this._current?.name  ?? 'none'; }
  get prevName()       { return this._previous?.name ?? 'none'; }
  get blendPct()       { return Math.round(this._weight * 100); }
  get isTransitioning(){ return this._weight < 1.0 && this._previous !== null; }
}
