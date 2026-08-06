import { Vector3, type DirectionalLight, type PerspectiveCamera } from 'three';

/**
 * Keeps the sun's single shadow cascade pointed at what the driver can
 * actually see, and stops it crawling.
 *
 * The sky rig parks the shadow box on the camera, which spends half its
 * resolution on the ground behind you. Pushing the centre forward along the
 * view direction lets the box be far smaller for the same coverage ahead - on
 * the `high` profile that is a 3072 map over 220 m instead of 480 m, so a
 * sleeper's shadow lands on three texels instead of one.
 *
 * The centre is then snapped to whole shadow texels in light space. Without
 * that, moving a metre re-rasterises every edge onto a slightly different texel
 * and the whole world's shadows shimmer - which at 100 km/h is far more
 * distracting than a soft edge.
 *
 * Bias is derived from the texel's world size rather than hardcoded, because
 * the same constant that hides acne on a 480 m box makes shadows float clear of
 * their casters on a 220 m one.
 */
export class ShadowFitter {
  private readonly centre = new Vector3();
  private readonly forward = new Vector3();
  private readonly lightDir = new Vector3();
  private readonly right = new Vector3();
  private readonly up = new Vector3();
  private readonly worldUp = new Vector3(0, 1, 0);
  private readonly cameraPos = new Vector3();

  /**
   * @param light   the sun
   * @param camera  the view camera
   * @param extent  half-width of the shadow box in metres
   * @param ahead   how far in front of the camera to centre the box
   */
  fit(
    light: DirectionalLight,
    camera: PerspectiveCamera,
    extent: number,
    ahead: number,
    softness: number,
  ): void {
    const shadow = light.shadow;
    const mapSize = shadow.mapSize.x;
    if (mapSize < 8) return;

    camera.getWorldPosition(this.cameraPos);
    camera.getWorldDirection(this.forward);
    // Flatten the look direction: pitching the camera up at the catenary must
    // not throw the shadow box into the sky.
    this.forward.y = 0;
    if (this.forward.lengthSq() < 1e-6) this.forward.set(0, 0, -1);
    this.forward.normalize();

    this.centre.copy(this.cameraPos).addScaledVector(this.forward, ahead);

    // Light-space basis, used only to snap the centre to the texel grid.
    this.lightDir.copy(light.position).sub(light.target.position);
    if (this.lightDir.lengthSq() < 1e-6) this.lightDir.set(0.4, 0.8, 0.3);
    this.lightDir.normalize();
    const upRef = Math.abs(this.lightDir.y) > 0.98 ? Z_AXIS : this.worldUp;
    this.right.crossVectors(upRef, this.lightDir).normalize();
    this.up.crossVectors(this.lightDir, this.right).normalize();

    const texel = (2 * extent) / mapSize;
    const u = Math.round(this.centre.dot(this.right) / texel) * texel;
    const v = Math.round(this.centre.dot(this.up) / texel) * texel;
    const w = this.centre.dot(this.lightDir);
    this.centre
      .set(0, 0, 0)
      .addScaledVector(this.right, u)
      .addScaledVector(this.up, v)
      .addScaledVector(this.lightDir, w);

    const distance = extent * 2.2 + 240;
    light.target.position.copy(this.centre);
    light.position.copy(this.centre).addScaledVector(this.lightDir, distance);
    light.target.updateMatrixWorld();
    light.updateMatrixWorld();

    const cam = shadow.camera;
    if (cam.left !== -extent || cam.far !== distance * 2) {
      cam.left = -extent;
      cam.right = extent;
      cam.top = extent;
      cam.bottom = -extent;
      cam.near = 1;
      cam.far = distance * 2;
      cam.updateProjectionMatrix();
    }

    // Normal-offset scaled to the texel: enough to clear self-shadowing on a
    // rail head at a grazing sun angle without lifting a tree's shadow off the
    // grass.
    shadow.normalBias = Math.max(0.02, texel * 1.35);
    shadow.bias = -0.00012 - texel * 0.00035;
    // r185's PCF filter is a Vogel disk scaled by this radius, so it is the
    // one honest knob for how soft an edge is.
    shadow.radius = softness;
  }
}

const Z_AXIS = new Vector3(0, 0, 1);
