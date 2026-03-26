import { readConfig, type AppEnv, type RuntimeConfig } from './config';

type JsonObject = Record<string, unknown>;

type CacheEntry = {
	expiresAt: number;
	value: unknown;
};

const responseCache = new Map<string, CacheEntry>();

export class LunchMoneyApiError extends Error {
	readonly status: number;
	readonly details: unknown;

	constructor(message: string, status: number, details?: unknown) {
		super(message);
		this.name = 'LunchMoneyApiError';
		this.status = status;
		this.details = details;
	}
}

export interface TransactionQuery {
	start_date?: string;
	end_date?: string;
	created_since?: string;
	updated_since?: string;
	manual_account_id?: number;
	plaid_account_id?: number;
	category_id?: number;
	tag_id?: number;
	status?: 'reviewed' | 'unreviewed' | 'deleted_pending';
	is_pending?: boolean;
	include_pending?: boolean;
	include_metadata?: boolean;
	include_files?: boolean;
	include_children?: boolean;
	include_split_parents?: boolean;
	include_group_children?: boolean;
	limit?: number;
	offset?: number;
}

export interface SummaryQuery {
	start_date: string;
	end_date: string;
	include_occurrences?: boolean;
	include_past_budget_dates?: boolean;
	include_totals?: boolean;
	include_rollover_pool?: boolean;
	include_exclude_from_budgets?: boolean;
}

export interface LunchMoneyClient {
	config: RuntimeConfig;
	getMe(): Promise<JsonObject>;
	listCategories(): Promise<JsonObject[]>;
	getCategory(id: number): Promise<JsonObject>;
	listTags(): Promise<JsonObject[]>;
	getTag(id: number): Promise<JsonObject>;
	listManualAccounts(): Promise<JsonObject[]>;
	getManualAccount(id: number): Promise<JsonObject>;
	listPlaidAccounts(): Promise<JsonObject[]>;
	getPlaidAccount(id: number): Promise<JsonObject>;
	listRecurringItems(): Promise<JsonObject[]>;
	getRecurringItem(id: number): Promise<JsonObject>;
	getBudgetSettings(): Promise<JsonObject>;
	listTransactions(query?: TransactionQuery): Promise<JsonObject[]>;
	getTransaction(id: number): Promise<JsonObject>;
	getBudgetSummary(query: SummaryQuery): Promise<JsonObject>;
}

export function createLunchMoneyClient(env: AppEnv): LunchMoneyClient {
	const config = readConfig(env);

	return {
		config,
		async getMe() {
			return request<JsonObject>(env, '/me', { cacheTtlMs: config.cacheTtlMs });
		},
		async listCategories() {
			const result = await request<{ categories: JsonObject[] }>(env, '/categories', {
				query: { format: 'flattened' },
				cacheTtlMs: config.cacheTtlMs,
			});
			return result.categories;
		},
		async getCategory(id: number) {
			return request<JsonObject>(env, `/categories/${id}`, { cacheTtlMs: config.cacheTtlMs });
		},
		async listTags() {
			const result = await request<{ tags: JsonObject[] }>(env, '/tags', {
				cacheTtlMs: config.cacheTtlMs,
			});
			return result.tags;
		},
		async getTag(id: number) {
			return request<JsonObject>(env, `/tags/${id}`, { cacheTtlMs: config.cacheTtlMs });
		},
		async listManualAccounts() {
			const result = await request<{ manual_accounts: JsonObject[] }>(env, '/manual_accounts', {
				cacheTtlMs: config.cacheTtlMs,
			});
			return result.manual_accounts;
		},
		async getManualAccount(id: number) {
			return request<JsonObject>(env, `/manual_accounts/${id}`, { cacheTtlMs: config.cacheTtlMs });
		},
		async listPlaidAccounts() {
			const result = await request<{ plaid_accounts: JsonObject[] }>(env, '/plaid_accounts', {
				cacheTtlMs: config.cacheTtlMs,
			});
			return result.plaid_accounts;
		},
		async getPlaidAccount(id: number) {
			return request<JsonObject>(env, `/plaid_accounts/${id}`, { cacheTtlMs: config.cacheTtlMs });
		},
		async listRecurringItems() {
			const result = await request<{ recurring_items: JsonObject[] }>(env, '/recurring_items', {
				cacheTtlMs: config.cacheTtlMs,
			});
			return result.recurring_items;
		},
		async getRecurringItem(id: number) {
			return request<JsonObject>(env, `/recurring_items/${id}`, { cacheTtlMs: config.cacheTtlMs });
		},
		async getBudgetSettings() {
			return request<JsonObject>(env, '/budgets/settings', { cacheTtlMs: config.cacheTtlMs });
		},
		async listTransactions(query = {}) {
			validateTransactionQuery(query);
			const result = await request<{ transactions: JsonObject[] }>(env, '/transactions', {
				query: toQueryRecord(query),
			});
			return result.transactions;
		},
		async getTransaction(id: number) {
			return request<JsonObject>(env, `/transactions/${id}`);
		},
		async getBudgetSummary(query: SummaryQuery) {
			return request<JsonObject>(env, '/summary', { query: toQueryRecord(query) });
		},
	};
}

interface RequestOptions {
	cacheTtlMs?: number;
	query?: Record<string, string | number | boolean | undefined>;
}

async function request<T>(env: AppEnv, path: string, options: RequestOptions = {}): Promise<T> {
	const config = readConfig(env);
	const accessToken = env.LUNCHMONEY_ACCESS_TOKEN?.trim();
	if (!accessToken) {
		throw new LunchMoneyApiError(
			'Missing Lunch Money token. Set LUNCHMONEY_ACCESS_TOKEN before using the MCP server.',
			500,
		);
	}

	const url = new URL(normalizeRelativePath(path), ensureTrailingSlash(config.apiBaseUrl));
	appendQueryParams(url.searchParams, options.query);

	const cacheKey = options.cacheTtlMs ? `GET ${url.toString()}` : undefined;
	if (cacheKey) {
		const cached = responseCache.get(cacheKey);
		if (cached && cached.expiresAt > Date.now()) {
			return cached.value as T;
		}
	}

	let lastError: Error | undefined;
	for (let attempt = 0; attempt < 4; attempt += 1) {
		const response = await fetch(url, {
			headers: {
				Accept: 'application/json',
				Authorization: `Bearer ${accessToken}`,
			},
		});

		if (response.status === 429) {
			lastError = await buildApiError(response);
			const retryAfterSeconds = Number.parseInt(response.headers.get('Retry-After') ?? '0', 10);
			const waitMs =
				Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
					? retryAfterSeconds * 1000
					: Math.min(1000 * 2 ** attempt, 8000);
			await sleep(waitMs);
			continue;
		}

		if (!response.ok) {
			throw await buildApiError(response);
		}

		const data = (await response.json()) as T;
		if (cacheKey && options.cacheTtlMs) {
			responseCache.set(cacheKey, {
				expiresAt: Date.now() + options.cacheTtlMs,
				value: data,
			});
		}
		return data;
	}

	throw lastError ?? new LunchMoneyApiError('Lunch Money request failed after retries.', 429);
}

async function buildApiError(response: Response): Promise<LunchMoneyApiError> {
	let details: unknown;
	try {
		details = await response.json();
	} catch {
		details = await response.text();
	}

	const message =
		typeof details === 'object' &&
		details !== null &&
		'message' in details &&
		typeof details.message === 'string'
			? details.message
			: `Lunch Money request failed with status ${response.status}`;

	return new LunchMoneyApiError(message, response.status, details);
}

function ensureTrailingSlash(value: string): string {
	return value.endsWith('/') ? value : `${value}/`;
}

function normalizeRelativePath(path: string): string {
	return path.replace(/^\/+/, '');
}

function appendQueryParams(
	searchParams: URLSearchParams,
	query: Record<string, string | number | boolean | undefined> | undefined,
): void {
	if (!query) {
		return;
	}

	for (const [key, value] of Object.entries(query)) {
		if (value === undefined) {
			continue;
		}
		searchParams.set(key, String(value));
	}
}

function validateTransactionQuery(query: TransactionQuery): void {
	if ((query.start_date && !query.end_date) || (!query.start_date && query.end_date)) {
		throw new LunchMoneyApiError(
			'list_transactions requires both start_date and end_date when either is provided.',
			400,
		);
	}
}

function toQueryRecord<T extends object>(
	query: T,
): Record<string, string | number | boolean | undefined> {
	const normalized: Record<string, string | number | boolean | undefined> = {};

	for (const [key, value] of Object.entries(query)) {
		if (
			typeof value === 'string' ||
			typeof value === 'number' ||
			typeof value === 'boolean' ||
			value === undefined
		) {
			normalized[key] = value;
		}
	}

	return normalized;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
