/**
 * Land outline for the attack map: the Natural Earth 110m polygons from
 * world-atlas, converted once to SVG path strings at module load. Loaded
 * lazily — see AttackMap.svelte — so the ~56 kB TopoJSON never blocks SSR.
 */
import { feature } from 'topojson-client';
import land110m from 'world-atlas/land-110m.json' with { type: 'json' };
import { project } from '#lib/map-projection.ts';

type Ring = [number, number][];
type Poly = Ring[] | Ring[][];

interface TopoJson {
	objects: { land: object };
}

// world-atlas `land` is one geometry collection → a single GeoJSON Feature.
const topo = land110m as unknown as TopoJson;
const land = feature(topo as never, topo.objects.land as never) as unknown as {
	type: string;
	geometry?: { type: string; coordinates: Poly };
	features?: { geometry?: { type: string; coordinates: Poly } }[];
};

function ringToPath(ring: Ring): string {
	let d = '';
	for (const [lon, lat] of ring) {
		const [x, y] = project(lat, lon);
		d += `${d ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
	}
	return `${d}Z`;
}

function polys(geometry: { type: string; coordinates: Poly }): string[] {
	if (geometry.type === 'Polygon') return (geometry.coordinates as Ring[]).map(ringToPath);
	if (geometry.type === 'MultiPolygon')
		return (geometry.coordinates as Ring[][]).flat().map(ringToPath);
	return [];
}

/** Land outline as SVG path data, computed once at module load. */
export const LAND_PATHS: string[] = (
	land.type === 'FeatureCollection' ? (land.features ?? []) : [land]
).flatMap((f) => polys(f.geometry ?? { type: '', coordinates: [] }));
