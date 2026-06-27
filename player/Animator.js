/**
 * player/Animator.js
 * -----------------------------------------------------------------------
 * Drives the Dead Star character mesh joints each render frame.
 *
 * KEY DESIGN DECISIONS
 *
 * 1. Distance-based walk cycle (no foot glide)
 *    The walk-phase accumulator advances by (speed × dt / strideLength) × 2π
 *    rather than (stepHz × dt) × 2π.  This locks the animation cycle to
 *    actual ground displacement: at any speed, one full cycle covers exactly
 *    strideLength metres.  At speed = 0 the phase freezes — the character
 *    never marches in place.  strideLength is tuned so the visual foot arc
 *    matches the distance covered per cycle, eliminating the "skating" look.
 *
 * 2. bodyGrp lean (no world-space lateral lean)
 *    root.rotation.y is the facing direction (set by updateTransform).
 *    Writing a lean to root.rotation.x uses Three.js Euler XYZ order,
 *    which means the tilt is in WORLD X — wrong for any direction except
 *    north.  Instead we write to j.body (bodyGrp), which is a child of
 *    root.  Its rotation.x is in the character's own local frame, producing
 *    a genuine forward lean regardless of facing direction.
 *
 * 3. Idempotent pose writes
 *    Every joint write is an absolute SET.  The graph may be interrupted
 *    mid-blend at any moment; the next frame starts from a clean slate.
 *
 * Joint contract (mesh._joints must contain):
 *   root    — root group (not used for lean; exposed for future needs)
 *   body    — lean pivot (child of root, parent of all upper-body parts)
 *   chest   — chest group (Y-scale for breathing / bounce)
 *   head    — head group (Y spin managed here; X tilt from pose)
 *   leftShoulder, rightShoulder
 *   leftHip, rightHip
 *   leftKnee, rightKnee
 *
 * Future extensions
 *   Attacks:    graph.transitionTo('attack_light', 0.08) from combat code.
 *   Stances:    pass context.stance to state update functions.
 *   IK planting: post-process _applyPose output before writing joints.
 *   Head track:  override j.head.rotation after _applyPose.
 *   Sockets:     read j.chest.getWorldPosition() etc. after apply.
 * -----------------------------------------------------------------------
 */

import { AnimConfig, LocomotionPhase } from './MovementConfig.js';
import { AnimationGraph, AnimationState, BodyMask } from './AnimationController.js';

/** sin wave helper: sw(t, hz) */
const sw = (t, hz, phase = 0) => Math.sin(t * hz * Math.PI * 2 + phase);

export class Animator {
  /**
   * @param {THREE.Group} mesh  The Dead Star root group from EntityView.
   *                            mesh._joints must already be populated.
   */
  constructor(mesh) {
    this.mesh  = mesh;
    this.graph = new AnimationGraph();

    /**
     * Walk-cycle phase accumulator (0–2π).
     * Advanced by distance-per-frame / strideLength each update.
     * NEVER reset on phase transitions — the cycle is continuous.
     */
    this._walkPhase = 0;

    /** Head Y-spin, managed independently of the pose system. */
    this._headSpinY = 0;

    /** Last phase — only call transitionTo when it actually changes. */
    this._lastPhase = LocomotionPhase.IDLE;

    this._buildGraph();
    this.graph.snap('idle');
  }

  // ── Graph construction ──────────────────────────────────────────────────

  _buildGraph() {
    // ── IDLE ──────────────────────────────────────────────────────────────
    // Contained, non-human feel.  Three prime-ratio sine waves (breathe, sway,
    // head) never align → organically varied without being repetitive.
    this.graph.addState(new AnimationState(
      LocomotionPhase.IDLE,
      BodyMask.FULL,
      (t) => ({
        bodyRotX:       0,
        bodyRotZ:       sw(t, AnimConfig.IDLE_SWAY_HZ) * AnimConfig.IDLE_SWAY_AMP,
        chestScaleY:    1.0 + sw(t, AnimConfig.IDLE_BREATHE_HZ) * AnimConfig.IDLE_BREATHE_AMP,
        headRotX:       sw(t, AnimConfig.IDLE_HEAD_HZ, Math.PI * 0.3) * AnimConfig.IDLE_HEAD_AMP,
        leftShoulderX:   AnimConfig.IDLE_SHOULDER_DROP,
        rightShoulderX:  AnimConfig.IDLE_SHOULDER_DROP,
        leftHipX: 0, rightHipX: 0,
        leftKneeX: 0, rightKneeX: 0,
      })
    ));

    // ── DRIFT ─────────────────────────────────────────────────────────────
    this.graph.addState(new AnimationState(
      LocomotionPhase.DRIFT,
      BodyMask.FULL,
      (t, dt, ctx) => this._locomotionPose(ctx, LocomotionPhase.DRIFT)
    ));

    // ── RUN ───────────────────────────────────────────────────────────────
    this.graph.addState(new AnimationState(
      LocomotionPhase.RUN,
      BodyMask.FULL,
      (t, dt, ctx) => this._locomotionPose(ctx, LocomotionPhase.RUN)
    ));

    // ── BREAKSTRIDE ───────────────────────────────────────────────────────
    this.graph.addState(new AnimationState(
      LocomotionPhase.BREAKSTRIDE,
      BodyMask.FULL,
      (t, dt, ctx) => this._locomotionPose(ctx, LocomotionPhase.BREAKSTRIDE)
    ));
  }

  // ── Locomotion pose producer ────────────────────────────────────────────

  /**
   * Produces PoseData for any locomotion phase.
   *
   * All locomotion states share the same _walkPhase accumulated in update()
   * so blending between two phases is always cycle-coherent — no artefacts
   * from mismatched cycles when a transition fires mid-stride.
   *
   * Amplitude is scaled by a soft-ramp of normalised speed so the character
   * builds into each phase's full stride gradually rather than snapping to
   * maximum swing the instant the phase fires.
   */
  _locomotionPose(ctx, phase) {
    const { walkPhase, speed, maxSpeed } = ctx;
    const norm  = Math.min(speed / Math.max(maxSpeed, 0.001), 1.0);
    // Soft ramp: full amplitude at ~50 % of max speed.  Keeps the blend from
    // idle feeling abrupt even when the physics accelerates quickly.
    const scale = Math.min(norm * 2.0, 1.0);
    const cycle = Math.sin(walkPhase);

    let legAmp, lean;
    switch (phase) {
      case LocomotionPhase.DRIFT:
        legAmp = AnimConfig.LEG_AMP_DRIFT;
        lean   = AnimConfig.TORSO_LEAN_DRIFT;
        break;
      case LocomotionPhase.RUN:
        legAmp = AnimConfig.LEG_AMP_RUN;
        lean   = AnimConfig.TORSO_LEAN_RUN;
        break;
      case LocomotionPhase.BREAKSTRIDE:
        legAmp = AnimConfig.LEG_AMP_BREAKSTRIDE;
        lean   = AnimConfig.TORSO_LEAN_BREAK;
        break;
      default:
        legAmp = AnimConfig.LEG_AMP_DRIFT;
        lean   = AnimConfig.TORSO_LEAN_DRIFT;
    }

    legAmp         *= scale;
    lean           *= scale;
    const armAmp   = legAmp  * AnimConfig.ARM_AMP_RATIO;
    const kneeAmp  = legAmp  * AnimConfig.KNEE_AMP_RATIO;

    return {
      // bodyGrp lean — written to j.body (local space), NOT j.root (world space).
      bodyRotX:       lean,
      bodyRotZ:       0,
      chestScaleY:    1.0 + legAmp * AnimConfig.TORSO_BOUNCE_RATIO,
      // Counter-lean the head so it stays visually level.
      headRotX:       -lean * AnimConfig.HEAD_LEVEL_FACTOR,
      leftShoulderX:  -cycle * armAmp,
      rightShoulderX:  cycle * armAmp,
      leftHipX:         cycle * legAmp,
      rightHipX:       -cycle * legAmp,
      // Knee bends on the trailing leg only (natural running mechanics).
      leftKneeX:        Math.max(0, -cycle) * kneeAmp,
      rightKneeX:       Math.max(0,  cycle) * kneeAmp,
    };
  }

  // ── Public update ───────────────────────────────────────────────────────

  /**
   * Advance the animator one render frame.
   *
   * DISTANCE-BASED WALK CYCLE:
   *   phase_increment = (speed × dt / strideLength) × 2π
   *
   *   At any speed the cycle covers exactly strideLength metres per revolution.
   *   Changing speed immediately changes cycle rate — no glide, no skate.
   *   At speed = 0 the phase freezes exactly where it stopped.
   *
   * @param {number} dt        Render-frame delta (seconds, variable)
   * @param {string} phase     Current LocomotionPhase
   * @param {number} speed     Current horizontal speed (m/s)
   * @param {number} maxSpeed  Server MAX_SPEED (used for amplitude scaling)
   */
  update(dt, phase, speed, maxSpeed) {
    // ── Walk phase (distance-locked) ───────────────────────────────────────
    const strideLen    = this._strideDist(phase);
    const distPerFrame = speed * dt;
    this._walkPhase    = (this._walkPhase + (distPerFrame / strideLen) * Math.PI * 2) % (Math.PI * 2);

    // ── Graph transitions ──────────────────────────────────────────────────
    if (phase !== this._lastPhase) {
      this.graph.transitionTo(phase, this._blendDuration(phase));
      this._lastPhase = phase;
    }

    const context = { walkPhase: this._walkPhase, speed, maxSpeed, phase };
    const pose    = this.graph.tick(dt, context);
    this._applyPose(pose);

    // ── Head spin (continuous, independent of pose) ─────────────────────────
    // Managed here rather than in the pose system so speed changes and
    // phase transitions never cause a discontinuity in spin rate.
    const now = performance.now() * 0.001;
    this._headSpinY = (this._headSpinY + dt * AnimConfig.HEAD_SPIN_RATE) % (Math.PI * 2);
    const j = this.mesh._joints;
    if (j?.head) {
      j.head.rotation.y = this._headSpinY;
      // Add precession wobble ON TOP of the pose's headRotX.
      const wobble = Math.sin(now * AnimConfig.HEAD_WOBBLE_HZ * Math.PI * 2)
                   * AnimConfig.HEAD_WOBBLE_AMP;
      j.head.rotation.x = (pose.headRotX ?? 0) + wobble;
    }
  }

  // ── Pose application ────────────────────────────────────────────────────

  /**
   * Write PoseData to mesh joints.
   *
   * All writes are absolute SETs — idempotent, zero accumulation.
   * Missing pose keys default to 0 / identity.
   *
   * LEAN NOTE: bodyRotX/Z go to j.body (bodyGrp), a child of root.
   * root.rotation.y (facing) is untouched.  This is what makes the lean
   * local-space and direction-independent.  Do NOT write lean to j.root.
   *
   * @param {object} pose  PoseData (plain object, all fields optional)
   */
  _applyPose(pose) {
    const j = this.mesh._joints;
    if (!j) return;

    // Upper-body lean — written to bodyGrp (character local space).
    // j.root is intentionally NOT used here.  See class header for why.
    if (j.body) {
      j.body.rotation.x = pose.bodyRotX ?? 0;
      j.body.rotation.z = pose.bodyRotZ ?? 0;
    }

    // Chest Y-scale (breathing / bounce)
    if (j.chest) {
      j.chest.scale.y = pose.chestScaleY ?? 1.0;
    }

    // Head tilt — Y spin is written after _applyPose in update()
    if (j.head) {
      j.head.rotation.x = pose.headRotX ?? 0;
    }

    // Arms
    if (j.leftShoulder)  j.leftShoulder.rotation.x  = pose.leftShoulderX  ?? 0;
    if (j.rightShoulder) j.rightShoulder.rotation.x = pose.rightShoulderX ?? 0;

    // Legs
    if (j.leftHip)   j.leftHip.rotation.x   = pose.leftHipX   ?? 0;
    if (j.rightHip)  j.rightHip.rotation.x  = pose.rightHipX  ?? 0;
    if (j.leftKnee)  j.leftKnee.rotation.x  = pose.leftKneeX  ?? 0;
    if (j.rightKnee) j.rightKnee.rotation.x = pose.rightKneeX ?? 0;
  }

  // ── Internal helpers ────────────────────────────────────────────────────

  /**
   * Stride length (metres per full gait cycle) for a given phase.
   *
   * Tuning guide:
   *   Increase → legs animate more slowly at the same speed (longer visual step).
   *   Decrease → legs animate faster (shorter, quicker steps).
   *
   *   Target: at full speed in each phase, the foot arc should cover roughly
   *   strideLength metres of ground.  The foot arc length is approximately
   *   2 × sin(legAmp) × legLength.  With legLength ≈ 1.1 m:
   *     drift:       2 × sin(0.65) × 1.1 ≈ 1.21 m  → STRIDE 0.90 (slightly shorter = quicker feel)
   *     run:         2 × sin(1.00) × 1.1 ≈ 1.85 m  → STRIDE 1.70 (well matched)
   *     breakstride: 2 × sin(1.55) × 1.1 ≈ 2.20 m  → STRIDE 2.20 (exact match = planted feel)
   */
  _strideDist(phase) {
    return {
      [LocomotionPhase.DRIFT]:       AnimConfig.STRIDE_LENGTH_DRIFT,
      [LocomotionPhase.RUN]:         AnimConfig.STRIDE_LENGTH_RUN,
      [LocomotionPhase.BREAKSTRIDE]: AnimConfig.STRIDE_LENGTH_BREAKSTRIDE,
    }[phase] ?? AnimConfig.STRIDE_LENGTH_DRIFT;
  }

  _blendDuration(phase) {
    return {
      [LocomotionPhase.IDLE]:        AnimConfig.BLEND_IDLE_IN,
      [LocomotionPhase.DRIFT]:       AnimConfig.BLEND_DRIFT_IN,
      [LocomotionPhase.RUN]:         AnimConfig.BLEND_RUN_IN,
      [LocomotionPhase.BREAKSTRIDE]: AnimConfig.BLEND_BREAKSTRIDE_IN,
    }[phase] ?? 0.15;
  }
}
