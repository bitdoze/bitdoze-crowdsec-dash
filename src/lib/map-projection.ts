/**
 * Equirectangular projection constants for the attack map. Pure arithmetic —
 * kept free of the world-atlas bundle so it can be imported eagerly.
 * The land outline lives in `map-geo.ts`, loaded lazily by the component.
 */
export const MAP_W = 720;
export const MAP_H = 360;

/** Equirectangular projection into the viewBox. */
export function project(lat: number, lon: number): [number, number] {
	return [((lon + 180) * MAP_W) / 360, ((90 - lat) * MAP_H) / 180];
}

/** Bucketed point for the map — size follows the fixed magnitude ramp. */
export interface MapPoint {
	x: number;
	y: number;
	count: number;
}
