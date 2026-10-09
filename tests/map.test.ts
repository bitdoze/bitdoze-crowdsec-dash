import { describe, expect, it } from 'vitest';
import { LAND_PATHS } from '#lib/map-geo.ts';
import { MAP_H, MAP_W, project } from '#lib/map-projection.ts';

describe('attack map geometry', () => {
	it('builds land outline paths from the world-atlas bundle', () => {
		expect(LAND_PATHS.length).toBeGreaterThan(0);
		for (const d of LAND_PATHS) {
			expect(d).toMatch(/^M[-\d.,L]+Z$/);
		}
	});

	it('projects the corners of the world into the viewBox', () => {
		expect(project(90, -180)).toEqual([0, 0]);
		expect(project(-90, 180)).toEqual([MAP_W, MAP_H]);
		expect(project(0, 0)).toEqual([MAP_W / 2, MAP_H / 2]);
	});

	it('projects real alert coordinates inside the viewBox', () => {
		for (const [lat, lon] of [
			[38.9, -77.0],
			[52.37, 4.9],
			[-23.5, -46.6]
		] as const) {
			const [x, y] = project(lat, lon);
			expect(x).toBeGreaterThanOrEqual(0);
			expect(x).toBeLessThanOrEqual(MAP_W);
			expect(y).toBeGreaterThanOrEqual(0);
			expect(y).toBeLessThanOrEqual(MAP_H);
		}
	});
});
