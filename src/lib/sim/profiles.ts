import type { Mode, ModeGroup } from '../../types';

export interface VehicleProfile {
  label: string;
  vehicleName: string;
  /** m/s */
  vmax: number;
  /** max traction acceleration m/s² */
  accel: number;
  /** speed above which traction falls off (constant power), m/s */
  vBase: number;
  /** full service brake m/s² */
  brake: number;
  /** emergency brake m/s² */
  emergency: number;
  powerNotches: number;
  brakeNotches: number;
  /** traction lag time constant (s) */
  tau: number;
  cars: number;
  carLength: number;
  carGap: number;
  width: number;
  height: number;
  capacity: number;
  doorsPerCar: number;
  /** passenger flow per door per second */
  doorFlow: number;
  dwell: number;
  /** lateral acceleration used for curve speed limits */
  latAccel: number;
  /** lowest speed limit the curve model will produce, m/s */
  minLimit: number;
  /** default speed limit when untagged, m/s */
  defaultLimit: number;
  /** stop tolerance (m): perfect / great / good / acceptable */
  tol: [number, number, number, number];
  /** distance at which the stop gauge appears */
  approach: number;
  rail: boolean;
  atp: boolean;
  elevated?: boolean;
  sound: 'electric' | 'diesel' | 'trolley' | 'ship';
  horn: 'train' | 'metro' | 'tram' | 'bus' | 'ship';
  baseWaiting: number;
}

const kmh = (v: number) => v / 3.6;

export const PROFILES: Record<Mode, VehicleProfile> = {
  subway: {
    label: 'Metro',
    vehicleName: '6-car metro EMU',
    vmax: kmh(100),
    accel: 1.1,
    vBase: kmh(36),
    brake: 1.15,
    emergency: 1.45,
    powerNotches: 4,
    brakeNotches: 7,
    tau: 0.55,
    cars: 6,
    carLength: 19.5,
    carGap: 0.9,
    width: 2.9,
    height: 3.6,
    capacity: 1500,
    doorsPerCar: 3,
    doorFlow: 1.1,
    dwell: 25,
    latAccel: 1.0,
    minLimit: kmh(25),
    defaultLimit: kmh(100),
    tol: [0.6, 1.5, 3.5, 8],
    approach: 500,
    rail: true,
    atp: true,
    sound: 'electric',
    horn: 'metro',
    baseWaiting: 28,
  },
  train: {
    label: 'Train',
    vehicleName: '8-car suburban EMU',
    vmax: kmh(160),
    accel: 0.75,
    vBase: kmh(55),
    brake: 0.95,
    emergency: 1.25,
    powerNotches: 5,
    brakeNotches: 8,
    tau: 0.7,
    cars: 8,
    carLength: 23.5,
    carGap: 1.0,
    width: 3.0,
    height: 4.0,
    capacity: 1800,
    doorsPerCar: 3,
    doorFlow: 1.0,
    dwell: 35,
    latAccel: 0.9,
    minLimit: kmh(30),
    defaultLimit: kmh(140),
    tol: [0.8, 2, 4.5, 10],
    approach: 900,
    rail: true,
    atp: true,
    sound: 'electric',
    horn: 'train',
    baseWaiting: 32,
  },
  light_rail: {
    label: 'Light rail',
    vehicleName: '3-section light rail vehicle',
    vmax: kmh(90),
    accel: 1.15,
    vBase: kmh(35),
    brake: 1.3,
    emergency: 2.4,
    powerNotches: 4,
    brakeNotches: 6,
    tau: 0.5,
    cars: 3,
    carLength: 10.5,
    carGap: 0.5,
    width: 2.65,
    height: 3.4,
    capacity: 250,
    doorsPerCar: 2,
    doorFlow: 1.0,
    dwell: 20,
    latAccel: 1.1,
    minLimit: kmh(15),
    defaultLimit: kmh(80),
    tol: [0.7, 1.8, 4, 9],
    approach: 350,
    rail: true,
    atp: false,
    sound: 'electric',
    horn: 'tram',
    baseWaiting: 12,
  },
  tram: {
    label: 'Tram',
    vehicleName: '5-module low-floor tram',
    vmax: kmh(70),
    accel: 1.2,
    vBase: kmh(30),
    brake: 1.35,
    emergency: 2.6,
    powerNotches: 4,
    brakeNotches: 6,
    tau: 0.45,
    cars: 5,
    carLength: 6.2,
    carGap: 0.35,
    width: 2.4,
    height: 3.4,
    capacity: 210,
    doorsPerCar: 1,
    doorFlow: 1.0,
    dwell: 18,
    latAccel: 1.15,
    minLimit: kmh(12),
    defaultLimit: kmh(60),
    tol: [0.7, 1.8, 4, 9],
    approach: 300,
    rail: true,
    atp: false,
    sound: 'electric',
    horn: 'tram',
    baseWaiting: 10,
  },
  monorail: {
    label: 'Monorail',
    vehicleName: '4-car straddle monorail',
    vmax: kmh(90),
    accel: 1.0,
    vBase: kmh(35),
    brake: 1.1,
    emergency: 1.4,
    powerNotches: 4,
    brakeNotches: 6,
    tau: 0.55,
    cars: 4,
    carLength: 15,
    carGap: 0.8,
    width: 3.0,
    height: 3.8,
    capacity: 600,
    doorsPerCar: 2,
    doorFlow: 1.0,
    dwell: 25,
    latAccel: 1.0,
    minLimit: kmh(20),
    defaultLimit: kmh(85),
    tol: [0.6, 1.5, 3.5, 8],
    approach: 400,
    rail: true,
    atp: true,
    elevated: true,
    sound: 'electric',
    horn: 'metro',
    baseWaiting: 16,
  },
  bus: {
    label: 'Bus',
    vehicleName: '12 m city bus',
    vmax: kmh(80),
    accel: 1.35,
    vBase: kmh(25),
    brake: 1.7,
    emergency: 3.2,
    powerNotches: 4,
    brakeNotches: 5,
    tau: 0.4,
    cars: 1,
    carLength: 12,
    carGap: 0,
    width: 2.55,
    height: 3.1,
    capacity: 90,
    doorsPerCar: 2,
    doorFlow: 0.8,
    dwell: 15,
    latAccel: 1.6,
    minLimit: kmh(12),
    defaultLimit: kmh(60),
    tol: [1, 2.5, 5, 12],
    approach: 220,
    rail: false,
    atp: false,
    sound: 'diesel',
    horn: 'bus',
    baseWaiting: 7,
  },
  trolleybus: {
    label: 'Trolleybus',
    vehicleName: '18 m articulated trolleybus',
    vmax: kmh(70),
    accel: 1.3,
    vBase: kmh(25),
    brake: 1.6,
    emergency: 3.0,
    powerNotches: 4,
    brakeNotches: 5,
    tau: 0.4,
    cars: 2,
    carLength: 8.8,
    carGap: 0.4,
    width: 2.55,
    height: 3.1,
    capacity: 140,
    doorsPerCar: 2,
    doorFlow: 0.8,
    dwell: 15,
    latAccel: 1.5,
    minLimit: kmh(12),
    defaultLimit: kmh(60),
    tol: [1, 2.5, 5, 12],
    approach: 220,
    rail: false,
    atp: false,
    sound: 'trolley',
    horn: 'bus',
    baseWaiting: 8,
  },
  ferry: {
    label: 'Ferry',
    vehicleName: '40 m passenger ferry',
    vmax: kmh(40),
    accel: 0.28,
    vBase: kmh(14),
    brake: 0.4,
    emergency: 0.6,
    powerNotches: 5,
    brakeNotches: 5,
    tau: 1.6,
    cars: 1,
    carLength: 40,
    carGap: 0,
    width: 10,
    height: 7,
    capacity: 350,
    doorsPerCar: 2,
    doorFlow: 2.5,
    dwell: 50,
    latAccel: 99,
    minLimit: kmh(8),
    defaultLimit: kmh(40),
    tol: [2, 5, 10, 25],
    approach: 500,
    rail: false,
    atp: false,
    sound: 'ship',
    horn: 'ship',
    baseWaiting: 30,
  },
};

export function vehicleLength(p: VehicleProfile): number {
  return p.cars * p.carLength + (p.cars - 1) * p.carGap;
}

export const MODE_GROUP: Record<Mode, ModeGroup> = {
  subway: 'metro',
  train: 'train',
  light_rail: 'tram',
  tram: 'tram',
  monorail: 'monorail',
  bus: 'bus',
  trolleybus: 'bus',
  ferry: 'ferry',
};

export const GROUPS: { id: ModeGroup; label: string; colour: string }[] = [
  { id: 'metro', label: 'Metro', colour: '#6366f1' },
  { id: 'train', label: 'Train', colour: '#0ea5e9' },
  { id: 'tram', label: 'Tram', colour: '#f43f5e' },
  { id: 'monorail', label: 'Monorail', colour: '#a855f7' },
  { id: 'bus', label: 'Bus', colour: '#f59e0b' },
  { id: 'ferry', label: 'Ferry', colour: '#14b8a6' },
];

export const GROUP_COLOUR: Record<ModeGroup, string> = Object.fromEntries(
  GROUPS.map((g) => [g.id, g.colour]),
) as Record<ModeGroup, string>;

export const MODE_ORDER: Mode[] = ['subway', 'train', 'light_rail', 'tram', 'monorail', 'bus', 'trolleybus', 'ferry'];
