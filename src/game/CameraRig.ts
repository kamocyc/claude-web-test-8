import { Euler, Object3D, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import type { Consist } from '../train/Consist';
import { STRUCT_TUNNEL, type TrackPath } from '../world/TrackPath';
import type { TerrainField } from '../world/TerrainField';
import { trackAxes } from '../world/TrackFrame';
import { clamp, damp, lerp, smoothstep } from '../core/MathUtils';

export type CameraMode = 'cab' | 'window' | 'chase' | 'lineside' | 'nose' | 'roof';

export const CAMERA_MODES: CameraMode[] = ['cab', 'window', 'chase', 'lineside', 'nose', 'roof'];

/** Translation keys for the mode names. */
export const CAMERA_LABELS: Record<CameraMode, string> = {
  cab: 'camera.cab',
  window: 'camera.window',
  chase: 'camera.chase',
  lineside: 'camera.lineside',
  nose: 'camera.nose',
  roof: 'camera.roof',
};

const tmpA = new Vector3();
const tmpB = new Vector3();
const axisRight = new Vector3();
const axisUp = new Vector3();
const axisFwd = new Vector3();
const quat = new Quaternion();
const windowRight = new Vector3();
const windowUp = new Vector3();
const windowOrigin = new Vector3();
const panAxis = new Vector3();
const lookEuler = new Euler(0, 0, 0, 'YXZ');

/** How far the camera may be slid sideways in each view, in metres. */
const PAN_LIMIT: Record<CameraMode, number> = {
  cab: 0.85,
  window: 2.2,
  chase: 20,
  lineside: 30,
  nose: 1.6,
  roof: 1.6,
};

/**
 * Camera work.
 *
 * The cab view is the point of the game: the driver's eye, rigidly attached to
 * a car that is itself pitching and rolling with the track, with free look and
 * the constant fine vibration of a train at speed. The other views exist to
 * show off the world and the stock.
 */
export class CameraRig {
  mode: CameraMode = 'cab';
  yaw = 0;
  pitch = 0;
  /** Sideways offset the player has slid the view to, in metres. */
  panOffset = 0;
  /** Vibration multiplier from the settings. */
  shake = 1;

  private readonly position = new Vector3();
  private readonly target = new Vector3();
  private lineSideAnchor = new Vector3();
  private lineSideValidUntil = -1;
  private jointPhase = 0;
  private jointImpulse = 0;
  private swayX = 0;
  private swayY = 0;
  private chasePosition = new Vector3();
  private initialised = false;
  /** -1 looks out of the left hand side, +1 the right. */
  private windowSide = -1;

  constructor(
    private readonly track: TrackPath,
    private readonly field: TerrainField,
  ) {}

  cycle(): void {
    const index = CAMERA_MODES.indexOf(this.mode);
    this.setMode(CAMERA_MODES[(index + 1) % CAMERA_MODES.length]);
  }

  setMode(mode: CameraMode): void {
    this.mode = mode;
    this.recentre();
    this.lineSideValidUntil = -1;
  }

  /** Puts the view back where the shot was framed to be seen from. */
  recentre(): void {
    this.yaw = 0;
    this.pitch = 0;
    this.panOffset = 0;
  }

  look(dYaw: number, dPitch: number): void {
    this.yaw = clamp(this.yaw + dYaw, -Math.PI * 0.95, Math.PI * 0.95);
    this.pitch = clamp(this.pitch + dPitch, -0.8, 0.7);
  }

  /**
   * Slides the view sideways. In the cab that is the driver leaning across to
   * see round a pillar or out along the train; in the outside views it walks
   * the shot across the line.
   */
  pan(delta: number): void {
    const limit = PAN_LIMIT[this.mode];
    this.panOffset = clamp(this.panOffset + delta, -limit, limit);
  }

  /**
   * Fine vibration: a fast component from the bogies plus a discrete kick each
   * time a wheelset crosses a rail joint, both scaled by speed.
   */
  private updateVibration(dt: number, speed: number, elapsed: number): void {
    const jointSpacing = 25;
    this.jointPhase += speed * dt;
    if (this.jointPhase > jointSpacing) {
      this.jointPhase -= jointSpacing;
      this.jointImpulse = Math.min(1, speed / 30);
    }
    this.jointImpulse = damp(this.jointImpulse, 0, 9, dt);

    // The lineside camera is a tripod in a field. Whatever the train is doing
    // to itself is no business of a camera that is not on it, so that shot is
    // steady however hard the rest of the game is shaking.
    const carried = this.mode === 'lineside' ? 0 : this.shake;
    const intensity = smoothstep(0, 28, speed) * carried;
    this.swayX =
      (Math.sin(elapsed * 1.9) * 0.011 + Math.sin(elapsed * 4.7 + 1.3) * 0.005) * intensity;
    this.swayY =
      (Math.sin(elapsed * 13.3) * 0.0035 +
        Math.sin(elapsed * 27.1) * 0.0016 +
        this.jointImpulse * 0.012) *
      intensity;
  }

  update(
    camera: PerspectiveCamera,
    consist: Consist,
    speed: number,
    dt: number,
    elapsed: number,
    trainS: number,
  ): void {
    this.updateVibration(dt, Math.abs(speed), elapsed);

    const leadCar = consist.cars[0].group;
    leadCar.updateMatrixWorld(true);

    switch (this.mode) {
      case 'cab':
        this.updateCab(camera, consist, leadCar);
        break;
      case 'window':
        this.updateWindow(camera, consist);
        break;
      case 'nose':
        this.updateAttached(camera, leadCar, new Vector3(0, 1.15, -consist.spec.carLength / 2 - 0.9));
        break;
      case 'roof':
        this.updateAttached(camera, leadCar, new Vector3(0, 4.9, -consist.spec.carLength / 2 + 2.5));
        break;
      case 'chase':
        this.updateChase(camera, consist, dt, trainS);
        break;
      case 'lineside':
        this.updateLineside(camera, consist, trainS);
        break;
    }

    // Every shot above leaves the camera framed as its author intended; the
    // player's own pan and free look are laid on top of that, in one place, so
    // that they behave the same way whichever view is up.
    this.applyPan(camera);
    this.applyLook(camera);

    if (!this.initialised) {
      this.chasePosition.copy(camera.position);
      this.initialised = true;
    }
  }

  /**
   * Slides the framed shot sideways, along the horizontal right of whatever it
   * was already looking down. Taking the axis from the shot rather than from
   * the free look means leaning left stays leaning left even when the player
   * has turned to look out of the side window.
   */
  private applyPan(camera: PerspectiveCamera): void {
    if (this.panOffset === 0) return;
    panAxis.set(1, 0, 0).applyQuaternion(camera.quaternion);
    panAxis.y = 0;
    if (panAxis.lengthSq() < 1e-6) return;
    camera.position.addScaledVector(panAxis.normalize(), this.panOffset);
  }

  /**
   * Free look, added to whatever the shot is already pointing at.
   *
   * Turning about the camera's own axes is what used to tilt the horizon: as
   * soon as the framing carries any pitch - a car on a grade, a chase shot
   * looking down at the train - the camera's local Y is no longer up, and a yaw
   * about it rolls the whole frame. Decomposing into yaw about world up, pitch
   * about the turned right axis and roll about the view axis, adding the look
   * to the first two and leaving the third alone, keeps the horizon exactly as
   * level as the shot itself put it, however far round the player looks. What
   * roll remains is the real thing: the cant the car is leaning at.
   */
  private applyLook(camera: PerspectiveCamera): void {
    lookEuler.setFromQuaternion(camera.quaternion);
    lookEuler.y += this.yaw + this.swayX;
    // Short of straight up or straight down, where yaw and roll would collapse
    // into each other and the view would spin.
    lookEuler.x = clamp(lookEuler.x + this.pitch + this.swayY, -1.5, 1.5);
    camera.quaternion.setFromEuler(lookEuler);
  }

  private updateCab(camera: PerspectiveCamera, consist: Consist, leadCar: Object3D): void {
    consist.getEyeWorld(this.position);
    camera.position.copy(this.position);
    // The car's local -Z is forward, which is exactly where the camera looks.
    camera.quaternion.copy(leadCar.quaternion);
  }

  private updateAttached(
    camera: PerspectiveCamera,
    leadCar: Object3D,
    localOffset: Vector3,
  ): void {
    tmpA.copy(localOffset).applyMatrix4(leadCar.matrixWorld);
    camera.position.copy(tmpA);
    camera.quaternion.copy(leadCar.quaternion);
  }

  /**
   * The view a passenger gets: level with the windows, a little outside the
   * glass so the scenery is not seen through a tinted pane, with the bodyside
   * running along the edge of frame.
   */
  private updateWindow(camera: PerspectiveCamera, consist: Consist): void {
    const index = Math.min(1, consist.cars.length - 1);
    const car = consist.cars[index].group;
    car.updateMatrixWorld(true);

    // Work from the car's own axes rather than from a fixed yaw, so the view
    // is guaranteed to face out across the lineside instead of into the
    // glazing however the car happens to be oriented.
    windowRight.setFromMatrixColumn(car.matrixWorld, 0).normalize();
    windowUp.setFromMatrixColumn(car.matrixWorld, 1).normalize();
    windowOrigin.setFromMatrixPosition(car.matrixWorld);

    tmpA
      .copy(windowOrigin)
      .addScaledVector(windowRight, this.windowSide * 2.0)
      .addScaledVector(windowUp, 2.45);
    camera.position.copy(tmpA);

    tmpB
      .copy(tmpA)
      .addScaledVector(windowRight, this.windowSide * 40)
      .addScaledVector(windowUp, -4);
    camera.up.set(0, 1, 0);
    camera.lookAt(tmpB);
  }

  /** Swaps the window view to the other side of the train. */
  flipWindowSide(): void {
    this.windowSide *= -1;
  }

  private updateChase(camera: PerspectiveCamera, consist: Consist, dt: number, trainS: number): void {
    const sample = this.track.sampleAt(trainS - 26);
    trackAxes(sample, axisRight, axisUp, axisFwd);
    // Inside a bore the usual stand-off would put the camera in the rock, so
    // it tucks in behind the train instead. The chase position is damped, so
    // the move in and out of a tunnel is a glide rather than a cut.
    const inTunnel = sample.structure === STRUCT_TUNNEL;
    tmpA
      .set(sample.x, sample.y, sample.z)
      .addScaledVector(axisRight, consist.lateral - (inTunnel ? 3.0 : 5.5))
      .addScaledVector(axisUp, inTunnel ? 3.4 : 7.5);
    this.chasePosition.lerp(tmpA, 1 - Math.exp(-6 * dt));

    const lookSample = this.track.sampleAt(trainS - 8);
    trackAxes(lookSample, axisRight, axisUp, axisFwd);
    this.target
      .set(lookSample.x, lookSample.y, lookSample.z)
      .addScaledVector(axisRight, consist.lateral)
      .addScaledVector(axisUp, 2.2);

    // A fixed stand-off from the track puts the camera inside the hillside
    // wherever the line runs through a cutting, along a shelf or up to a tunnel
    // mouth, and the shot becomes a screen full of rock. Clear the ground under
    // the camera, and the ground between it and the train as well - a bank
    // halfway along the sight line hides the train just as completely as one
    // the lens is buried in.
    if (!inTunnel) {
      const here = this.field.heightAt(this.chasePosition.x, this.chasePosition.z).y;
      const midX = (this.chasePosition.x + this.target.x) * 0.5;
      const midZ = (this.chasePosition.z + this.target.z) * 0.5;
      const between = this.field.heightAt(midX, midZ).y;
      this.chasePosition.y = Math.max(this.chasePosition.y, here + 2.4, between + 3.2);
    }
    camera.position.copy(this.chasePosition);
    camera.up.set(0, 1, 0);
    camera.lookAt(this.target);
  }

  private updateLineside(camera: PerspectiveCamera, consist: Consist, trainS: number): void {
    // Pick a spot beside the line ahead of the train and hold it until the
    // train has gone past, like a fixed trackside camera.
    if (trainS > this.lineSideValidUntil) {
      const anchorS = trainS + 180;
      const sample = this.track.sampleAt(anchorS);
      trackAxes(sample, axisRight, axisUp, axisFwd);
      const side = Math.random() > 0.5 ? 1 : -1;
      const lateral = side * lerp(16, 34, Math.random());
      this.lineSideAnchor
        .set(sample.x, sample.y, sample.z)
        .addScaledVector(axisRight, lateral);
      // Stand on the ground rather than at rail level: in a cutting the rail
      // level would be underground. It has to be the ground the corridor mesh
      // actually draws at this offset, not the natural country underneath it -
      // beside a station the two differ by the whole depth of the forecourt,
      // and standing on the lower of them puts the camera under the tarmac.
      // Whichever of the two meshes is higher here is the one the camera would
      // otherwise end up underneath, so take the greater of them.
      const ground = Math.max(
        this.field.ground(sample, lateral, this.lineSideAnchor.x, this.lineSideAnchor.z),
        this.field.heightAt(this.lineSideAnchor.x, this.lineSideAnchor.z).y,
      );
      // A platform is 1.1 m above the rail and the canopy over it half as high
      // again, so a camera at head height beside a station films the back of a
      // wall. Stand well above it there and let the shot look down on the
      // train instead.
      const stand = lerp(1.7, 7, Math.random()) + sample.stationZone * 3.4;
      this.lineSideAnchor.y = Math.max(ground, sample.y - 3) + stand;
      if (sample.structure === STRUCT_TUNNEL) {
        // No standing beside the line in here: take the shot from the walkway.
        this.lineSideAnchor
          .set(sample.x, sample.y, sample.z)
          .addScaledVector(axisRight, side * 3.7)
          .addScaledVector(axisUp, 1.6);
      }
      this.lineSideValidUntil = anchorS + 120;
    }
    camera.position.copy(this.lineSideAnchor);
    consist.cars[0].group.getWorldPosition(tmpB);
    camera.up.set(0, 1, 0);
    camera.lookAt(tmpB.x, tmpB.y + 2.0, tmpB.z);
  }

  /** Quaternion of the lead car, used to orient audio. */
  orientation(consist: Consist, out = quat): Quaternion {
    return out.copy(consist.cars[0].group.quaternion);
  }
}
