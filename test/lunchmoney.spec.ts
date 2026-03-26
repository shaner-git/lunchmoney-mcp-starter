import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLunchMoneyClient } from '../src/lunchmoney';
import type { AppEnv } from '../src/config';

const TEST_ENV: AppEnv = {
	OAUTH_KV: {} as KVNamespace,
	LUNCHMONEY_ACCESS_TOKEN: 'test-token',
	LUNCHMONEY_API_BASE_URL: 'https://api.test.lunchmoney.dev/v2',
	CACHE_TTL_SECONDS: '300',
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe('Lunch Money client', () => {
	it('preserves the configured API version prefix when building request URLs', async () => {
		const seenPaths: string[] = [];
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input));
			seenPaths.push(url.pathname);
			return new Response(JSON.stringify({ id: seenPaths.length, transactions: [{ id: 1 }] }), {
				headers: {
					'content-type': 'application/json',
				},
				status: 200,
			});
		});
		vi.stubGlobal('fetch', fetchMock);

		const client = createLunchMoneyClient(TEST_ENV);

		await client.getMe();
		await client.listTransactions({ limit: 1 });

		expect(seenPaths).toEqual(['/v2/me', '/v2/transactions']);
	});

	it('passes through the expanded transaction query parameters', async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input));
			expect(url.origin).toBe('https://api.test.lunchmoney.dev');
			expect(url.pathname).toBe('/v2/transactions');
			expect(url.searchParams.get('start_date')).toBe('2026-03-01');
			expect(url.searchParams.get('end_date')).toBe('2026-03-31');
			expect(url.searchParams.get('status')).toBe('deleted_pending');
			expect(url.searchParams.get('include_pending')).toBe('true');
			expect(url.searchParams.get('include_metadata')).toBe('true');
			expect(url.searchParams.get('include_files')).toBe('true');
			expect(url.searchParams.get('include_children')).toBe('true');
			expect(url.searchParams.get('include_split_parents')).toBe('true');
			expect(url.searchParams.get('include_group_children')).toBe('true');
			expect(url.searchParams.get('limit')).toBe('50');
			expect(init?.headers).toMatchObject({
				Authorization: 'Bearer test-token',
			});

			return new Response(JSON.stringify({ transactions: [{ id: 1 }] }), {
				headers: {
					'content-type': 'application/json',
				},
				status: 200,
			});
		});
		vi.stubGlobal('fetch', fetchMock);

		const client = createLunchMoneyClient(TEST_ENV);
		const result = await client.listTransactions({
			start_date: '2026-03-01',
			end_date: '2026-03-31',
			status: 'deleted_pending',
			include_pending: true,
			include_metadata: true,
			include_files: true,
			include_children: true,
			include_split_parents: true,
			include_group_children: true,
			limit: 50,
		});

		expect(result).toEqual([{ id: 1 }]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('fetches single-object endpoints for hydrated lookups', async () => {
		const seenPaths: string[] = [];
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input));
			seenPaths.push(url.pathname);
			return new Response(JSON.stringify({ id: seenPaths.length }), {
				headers: {
					'content-type': 'application/json',
				},
				status: 200,
			});
		});
		vi.stubGlobal('fetch', fetchMock);

		const client = createLunchMoneyClient(TEST_ENV);

		await client.getCategory(10);
		await client.getTag(20);
		await client.getManualAccount(30);
		await client.getPlaidAccount(40);
		await client.getRecurringItem(50);

		expect(seenPaths).toEqual([
			'/v2/categories/10',
			'/v2/tags/20',
			'/v2/manual_accounts/30',
			'/v2/plaid_accounts/40',
			'/v2/recurring_items/50',
		]);
	});
});
