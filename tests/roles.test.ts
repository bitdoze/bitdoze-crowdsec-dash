import { describe, expect, it } from 'vitest';
import { hasPermission, primaryRole, rolesFromValue } from '#lib/roles.ts';

describe('roles', () => {
	it('parses single and comma-separated role values', () => {
		expect(rolesFromValue('admin')).toEqual(['admin']);
		expect(rolesFromValue('operator,viewer')).toEqual(['operator', 'viewer']);
		expect(rolesFromValue(' operator , viewer ')).toEqual(['operator', 'viewer']);
	});

	it('treats missing or unknown values as viewer', () => {
		expect(rolesFromValue(null)).toEqual(['viewer']);
		expect(rolesFromValue(undefined)).toEqual(['viewer']);
		expect(rolesFromValue('')).toEqual(['viewer']);
		expect(rolesFromValue('superuser')).toEqual(['viewer']);
	});

	it('grants read to every role', () => {
		for (const role of ['admin', 'operator', 'viewer']) {
			expect(hasPermission(role, 'read'), role).toBe(true);
		}
	});

	it('grants operate only to operator and admin', () => {
		expect(hasPermission('operator', 'operate')).toBe(true);
		expect(hasPermission('admin', 'operate')).toBe(true);
		expect(hasPermission('viewer', 'operate')).toBe(false);
	});

	it('grants configure only to admin', () => {
		expect(hasPermission('admin', 'configure')).toBe(true);
		expect(hasPermission('operator', 'configure')).toBe(false);
		expect(hasPermission('viewer', 'configure')).toBe(false);
	});

	it('unions permissions across multiple roles', () => {
		expect(hasPermission('viewer,operator', 'operate')).toBe(true);
		expect(hasPermission('viewer,nonsense', 'operate')).toBe(false);
	});

	it('reports the highest held role', () => {
		expect(primaryRole('viewer,operator')).toBe('operator');
		expect(primaryRole('viewer')).toBe('viewer');
		expect(primaryRole('nonsense')).toBe('viewer');
	});
});
