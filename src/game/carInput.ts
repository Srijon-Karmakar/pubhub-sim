/**
 * Driver inputs for road vehicles. Touch controls and the keyboard both write
 * here; the runner smooths them every frame and feeds the engine, so pedals
 * build up pressure and the wheel self-centres like a real vehicle.
 */
export const carInput = {
  throttleHeld: false,
  brakeHeld: false,
  keyLeft: false,
  keyRight: false,
  /** steering wheel being dragged (-1..1) */
  touchSteer: 0,
  touchActive: false,
  // smoothed outputs
  throttle: 0,
  brake: 0,
  steer: 0,
};

export function resetCarInput() {
  Object.assign(carInput, {
    throttleHeld: false,
    brakeHeld: false,
    keyLeft: false,
    keyRight: false,
    touchSteer: 0,
    touchActive: false,
    throttle: 0,
    brake: 0,
    steer: 0,
  });
}

const approach = (v: number, target: number, up: number, down: number, dt: number) =>
  v < target ? Math.min(target, v + up * dt) : Math.max(target, v - down * dt);

export function updateCarInput(dt: number) {
  const c = carInput;
  c.throttle = approach(c.throttle, c.throttleHeld ? 1 : 0, 2.2, 5, dt);
  c.brake = approach(c.brake, c.brakeHeld ? 1 : 0, 3, 6, dt);
  if (c.touchActive) c.steer = c.touchSteer;
  else {
    const key = (c.keyRight ? 1 : 0) - (c.keyLeft ? 1 : 0);
    // keys steer progressively; with no input the wheel returns to centre
    c.steer = key !== 0 ? approach(c.steer, key, 1.6, 3, dt) : approach(c.steer, 0, 2.4, 2.4, dt);
  }
}
