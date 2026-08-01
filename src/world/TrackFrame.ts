import { Matrix4, Quaternion, Vector3 } from 'three';
import type { TrackSample } from './TrackPath';

/**
 * Track-attached coordinate frames.
 *
 * The frame is right handed with +X to the right of the direction of travel,
 * +Y up (rolled by the cant) and +Z pointing back along the train. Anything
 * that rides on or beside the line - sleepers, masts, signals, the train
 * itself - is placed with these helpers.
 */

const right = new Vector3();
const fwd = new Vector3();
const up = new Vector3();
const back = new Vector3();
const pos = new Vector3();

export function trackAxes(
  sample: TrackSample,
  outRight: Vector3,
  outUp: Vector3,
  outForward: Vector3,
): void {
  const pitch = Math.atan(sample.grade);
  const cp = Math.cos(pitch);
  outForward.set(Math.cos(sample.heading) * cp, Math.sin(pitch), Math.sin(sample.heading) * cp).normalize();
  outRight.set(-Math.sin(sample.heading), 0, Math.cos(sample.heading));
  outUp.crossVectors(outRight, outForward).normalize();

  const c = sample.cant;
  if (c !== 0) {
    const cos = Math.cos(c);
    const sin = Math.sin(c);
    const rx = outRight.x * cos - outUp.x * sin;
    const ry = outRight.y * cos - outUp.y * sin;
    const rz = outRight.z * cos - outUp.z * sin;
    outUp.set(
      outUp.x * cos + outRight.x * sin,
      outUp.y * cos + outRight.y * sin,
      outUp.z * cos + outRight.z * sin,
    );
    outRight.set(rx, ry, rz);
  }
  outRight.normalize();
  outUp.normalize();
}

/** World position at a lateral/vertical offset from the centre line. */
export function trackPoint(
  sample: TrackSample,
  lateral: number,
  height: number,
  out = new Vector3(),
): Vector3 {
  trackAxes(sample, right, up, fwd);
  return out
    .set(sample.x, sample.y, sample.z)
    .addScaledVector(right, lateral)
    .addScaledVector(up, height);
}

/**
 * Full transform for an object standing beside or on the track.
 * `yaw` rotates the object about its own up axis (radians).
 */
export function trackMatrix(
  sample: TrackSample,
  lateral: number,
  height: number,
  out = new Matrix4(),
  yaw = 0,
  scale?: Vector3,
): Matrix4 {
  trackAxes(sample, right, up, fwd);
  back.copy(fwd).negate();
  pos.set(sample.x, sample.y, sample.z).addScaledVector(right, lateral).addScaledVector(up, height);

  if (yaw !== 0) {
    const q = new Quaternion().setFromAxisAngle(up, yaw);
    right.applyQuaternion(q);
    back.applyQuaternion(q);
  }
  out.makeBasis(right, up, back);
  out.setPosition(pos);
  if (scale) out.scale(scale);
  return out;
}

/** Orientation-only quaternion for the track frame. */
export function trackQuaternion(sample: TrackSample, out = new Quaternion()): Quaternion {
  trackAxes(sample, right, up, fwd);
  back.copy(fwd).negate();
  const m = new Matrix4().makeBasis(right, up, back);
  return out.setFromRotationMatrix(m);
}
