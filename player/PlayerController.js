/**
 * player/PlayerController.js
 * -----------------------------------------------------------------------
 * Top-level orchestrator for the local player's movement + animation.
 *
 * Sits between Game and the existing Predictor:
 *
 *   Game._tickSimulation   →  playerController.tick(dirX, dirZ, dt)
 *   Game._loop             →  playerController.updateVisual(frameDt)
 *                          →  playerController.animate(frameDt)
 *
 * Owns:
 *   - LocomotionController  (phase classification)
 *   - Animator              (joint pose writing)
 *
 * Does NOT own:
 *   - WebSocket / network   (Game does)
 *   - Predictor             (Game creates it; we receive it)
 *   - EntityView / mesh     (attached lazily after view is ready)
 *   - Scene / camera        (Game does)
 *
 * Phase-based prediction config:
 *   tick() overrides the predictor's cfg for each step based on the
 *   current locomotion phase. The override uses moderate multipliers
 *   (≤ 1.55×) so server-reconciliation corrections are imperceptible.
 *   Reconciliation itself still uses the server's flat config (unchanged
 *   Predictor.reconcile()) — only the forward-prediction step diverges.
 *
 * Future extension points:
 *   - Dodge:     call playerController.startDodge(dirX, dirZ) from
 *                whatever reads the dodge key; inject DODGE phase.
 *   - Lock-on:   playerController.setLockOnTarget(entity) stores the
 *                target; tick() keeps facing toward it.
 *   - Abilities: call playerController.triggerAbility(id) which tells
 *                the animator to play the ability AnimationState while
 *                locomotion drives the lower body.
 * -----------------------------------------------------------------------
 */

import { PhaseConfig, LocomotionPhase, AnimConfig } from './MovementConfig.js';
import { LocomotionController } from './LocomotionController.js';
import { Animator } from './Animator.js';

export class PlayerController {
  /**
   * @param {Predictor} predictor   The existing Predictor instance.
   * @param {object}    serverCfg   The server's movement config object
   *                                (MAX_SPEED, ACCELERATION, FRICTION, TURN_RATE).
   */
  constructor(predictor, serverCfg) {
    this.predictor  = predictor;
    this.serverCfg  = serverCfg;

    this.locomotion = new LocomotionController();

    /** @type {Animator|null}  Null until attachMesh() is called. */
    this.animator   = null;

    // ── Debug / DebugUI expose ──────────────────────────────────────────
    /** Current horizontal speed (m/s). Updated each tick(). */
    this.speed           = 0;
    /** Normalised speed (0–1 relative to MAX_SPEED). */
    this.normalizedSpeed = 0;
    /** Current locomotion phase string. */
    this.phase           = LocomotionPhase.IDLE;
    /** Signed acceleration measured over the last fixed tick (m/s²). */
    this.acceleration    = 0;
    /** Velocity vector snapshot for camera anticipation. */
    this.velocity        = { x: 0, z: 0 };

    this._prevSpeed = 0;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /**
   * Attach the Dead Star mesh so the Animator can drive its joints.
   * Call once, immediately after EntityManager.ensureView() makes the
   * EntityView available. Sets mesh._externalAnimator = true so
   * EntityView.updateTransform() skips its built-in _animateDeadStar().
   *
   * @param {THREE.Group} mesh  EntityView.mesh
   */
  attachMesh(mesh) {
    this.animator             = new Animator(mesh);
    mesh._externalAnimator    = true;   // suppress EntityView's own anim
  }

  // ── Fixed-tick update (simulation loop) ────────────────────────────────

  /**
   * Run one fixed-timestep simulation step.
   * Replaces the direct predictor.step() call in Game._tickSimulation().
   * Returns the input command that MUST be sent to the server immediately.
   *
   * @param {number} dirX   Normalised world-space X input (−1 to 1)
   * @param {number} dirZ   Normalised world-space Z input (−1 to 1)
   * @param {number} dt     Fixed simulation timestep (seconds)
   * @returns {object}      Input command { seq, dirX, dirZ }
   */
  tick(dirX, dirZ, dt) {
    const hasInput = dirX !== 0 || dirZ !== 0;

    // Snapshot velocity BEFORE the step for acceleration measurement
    this._prevSpeed = Math.hypot(
      this.predictor.state.velocity.x,
      this.predictor.state.velocity.z
    );

    // Classify phase from current (pre-step) speed
    this.locomotion.update(this._prevSpeed, this.serverCfg.MAX_SPEED, hasInput, dt);
    this.phase = this.locomotion.phase;

    // Build a phase-appropriate effective cfg and step prediction with it.
    // phase is also passed directly so it lands in input.phase — the server
    // reads this field to apply the matching speed cap server-side.
    // Because reconciliation replays each pending input with its stored phase,
    // client and server run byte-for-byte identical MovementSystem logic
    // with zero speed divergence.
    const effectiveCfg = this._buildEffectiveCfg(this.phase);
    const input        = this.predictor.step(dirX, dirZ, dt, effectiveCfg, this.phase);

    // Update speed / accel measurements from post-step velocity
    const vx   = this.predictor.state.velocity.x;
    const vz   = this.predictor.state.velocity.z;
    this.velocity.x    = vx;
    this.velocity.z    = vz;
    this.speed         = Math.hypot(vx, vz);
    this.normalizedSpeed = Math.min(this.speed / Math.max(this.serverCfg.MAX_SPEED, 0.001), 1);
    this.acceleration  = dt > 0 ? (this.speed - this._prevSpeed) / dt : 0;

    return input;
  }

  // ── Per-render-frame update (render loop) ───────────────────────────────

  /**
   * Ease the visual (rendered) position toward the simulated position.
   * Wraps Predictor.updateVisual() — call exactly once per render frame.
   * @param {number} frameDt  Variable render delta (seconds)
   */
  updateVisual(frameDt) {
    this.predictor.updateVisual(frameDt);
  }

  /**
   * Drive the animation system one render frame.
   * Call after updateVisual() so speed is measured on smoothed velocity.
   * @param {number} frameDt
   */
  animate(frameDt) {
    if (!this.animator) return;
    this.animator.update(frameDt, this.phase, this.speed, this.serverCfg.MAX_SPEED);
  }

  // ── Debug ───────────────────────────────────────────────────────────────

  /**
   * Returns a stats object for DebugUI.update().
   * All fields are safe to display even before attachMesh() is called.
   * @returns {object}
   */
  debugStats() {
    return {
      speed:       this.speed,
      normSpeed:   this.normalizedSpeed,
      phase:       this.phase,
      accel:       this.acceleration,
      locoDebug:   this.locomotion.debugString(),
      animState:   this.animator?.graph.currentName ?? 'none',
      animBlend:   this.animator?.graph.blendPct    ?? 0,
      animPrev:    this.animator?.graph.prevName     ?? '--',
    };
  }

  // ── Private ─────────────────────────────────────────────────────────────

  /**
   * Build a movement config for the current phase by scaling the server's
   * baseline values with the phase-specific multipliers from PhaseConfig.
   *
   * Reconciliation in Predictor.reconcile() still uses the raw serverCfg
   * (unchanged) — only the forward-prediction step uses this override,
   * keeping the authoritative server path identical.
   *
   * @param {string} phase  LocomotionPhase constant
   * @returns {object}      Movement config compatible with MovementSystem.step()
   */
  _buildEffectiveCfg(phase) {
    const mult = PhaseConfig[phase] ?? PhaseConfig[LocomotionPhase.RUN];
    return {
      // Hard cap and phase speed caps pass through unchanged — MovementSystem
      // selects the right cap via input.phase, so we never override MAX_SPEED
      // here (doing so would fight the server's authoritative cap).
      MAX_SPEED:         this.serverCfg.MAX_SPEED,
      DRIFT_SPEED:       this.serverCfg.DRIFT_SPEED,
      RUN_SPEED:         this.serverCfg.RUN_SPEED,
      BREAKSTRIDE_SPEED: this.serverCfg.BREAKSTRIDE_SPEED,
      // These three are the only phase-specific multipliers left — they
      // produce small, tolerable divergence from the server's flat values.
      ACCELERATION: this.serverCfg.ACCELERATION * mult.accelerationMult,
      FRICTION:     this.serverCfg.FRICTION      * mult.frictionMult,
      TURN_RATE:    this.serverCfg.TURN_RATE      * mult.turnRateMult,
    };
  }
}
