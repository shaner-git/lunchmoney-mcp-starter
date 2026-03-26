import { ResourceTemplate, McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppEnv } from './config';
import { createLunchMoneyClient } from './lunchmoney';

const iconFor = (origin: string) => [
	{
		src: `${origin}/icon.png`,
		mimeType: 'image/png',
		sizes: ['176x168'],
	},
	{
		src: `${origin}/icon.svg`,
		mimeType: 'image/svg+xml',
		sizes: ['any'],
	},
];

export function createLunchMoneyMcpServer(env: AppEnv, origin: string): McpServer {
	const client = createLunchMoneyClient(env);
	const server = new McpServer({
		icons: iconFor(origin),
		name: 'lunchmoney-private',
		version: '0.1.0',
	});

	server.registerResource(
		'profile',
		'lunchmoney://me',
		{
			title: 'Lunch Money Profile',
			description: 'Profile details for the configured Lunch Money account.',
			mimeType: 'application/json',
			icons: iconFor(origin),
		},
		async (uri) => jsonResource(uri.href, await client.getMe()),
	);

	server.registerResource(
		'categories',
		'lunchmoney://categories',
		{
			title: 'Lunch Money Categories',
			description: 'All categories in flattened form for the configured account.',
			mimeType: 'application/json',
			icons: iconFor(origin),
		},
		async (uri) => jsonResource(uri.href, await client.listCategories()),
	);

	server.registerResource(
		'category',
		new ResourceTemplate('lunchmoney://categories/{id}', { list: undefined }),
		{
			title: 'Lunch Money Category',
			description: 'A single category by Lunch Money category ID.',
			mimeType: 'application/json',
			icons: iconFor(origin),
		},
		async (uri, params) => jsonResource(uri.href, await client.getCategory(parseId(firstTemplateValue(params.id)))),
	);

	server.registerResource(
		'tags',
		'lunchmoney://tags',
		{
			title: 'Lunch Money Tags',
			description: 'All tags for the configured account.',
			mimeType: 'application/json',
			icons: iconFor(origin),
		},
		async (uri) => jsonResource(uri.href, await client.listTags()),
	);

	server.registerResource(
		'tag',
		new ResourceTemplate('lunchmoney://tags/{id}', { list: undefined }),
		{
			title: 'Lunch Money Tag',
			description: 'A single tag by Lunch Money tag ID.',
			mimeType: 'application/json',
			icons: iconFor(origin),
		},
		async (uri, params) => jsonResource(uri.href, await client.getTag(parseId(firstTemplateValue(params.id)))),
	);

	server.registerResource(
		'manual-accounts',
		'lunchmoney://accounts/manual',
		{
			title: 'Manual Accounts',
			description: 'All manual accounts for the configured account.',
			mimeType: 'application/json',
			icons: iconFor(origin),
		},
		async (uri) => jsonResource(uri.href, await client.listManualAccounts()),
	);

	server.registerResource(
		'manual-account',
		new ResourceTemplate('lunchmoney://manual_accounts/{id}', { list: undefined }),
		{
			title: 'Manual Account',
			description: 'A single manual account by Lunch Money manual account ID.',
			mimeType: 'application/json',
			icons: iconFor(origin),
		},
		async (uri, params) =>
			jsonResource(uri.href, await client.getManualAccount(parseId(firstTemplateValue(params.id)))),
	);

	server.registerResource(
		'plaid-accounts',
		'lunchmoney://accounts/plaid',
		{
			title: 'Plaid Accounts',
			description: 'All Plaid accounts for the configured account.',
			mimeType: 'application/json',
			icons: iconFor(origin),
		},
		async (uri) => jsonResource(uri.href, await client.listPlaidAccounts()),
	);

	server.registerResource(
		'plaid-account',
		new ResourceTemplate('lunchmoney://plaid_accounts/{id}', { list: undefined }),
		{
			title: 'Plaid Account',
			description: 'A single Plaid account by Lunch Money Plaid account ID.',
			mimeType: 'application/json',
			icons: iconFor(origin),
		},
		async (uri, params) =>
			jsonResource(uri.href, await client.getPlaidAccount(parseId(firstTemplateValue(params.id)))),
	);

	server.registerResource(
		'budget-settings',
		'lunchmoney://budgets/settings',
		{
			title: 'Budget Settings',
			description: 'Budget period settings and account-level budget configuration.',
			mimeType: 'application/json',
			icons: iconFor(origin),
		},
		async (uri) => jsonResource(uri.href, await client.getBudgetSettings()),
	);

	server.registerResource(
		'recurring-item',
		new ResourceTemplate('lunchmoney://recurring_items/{id}', { list: undefined }),
		{
			title: 'Recurring Item',
			description: 'A single recurring item by Lunch Money recurring item ID.',
			mimeType: 'application/json',
			icons: iconFor(origin),
		},
		async (uri, params) =>
			jsonResource(uri.href, await client.getRecurringItem(parseId(firstTemplateValue(params.id)))),
	);

	server.registerResource(
		'transaction',
		new ResourceTemplate('lunchmoney://transactions/{id}', { list: undefined }),
		{
			title: 'Transaction',
			description: 'A single transaction by Lunch Money transaction ID.',
			mimeType: 'application/json',
			icons: iconFor(origin),
		},
		async (uri, params) =>
			jsonResource(uri.href, await client.getTransaction(parseId(firstTemplateValue(params.id)))),
	);

	server.registerTool(
		'list_transactions',
		{
			title: 'List Transactions',
			description: 'List transactions with optional date and account filters.',
			inputSchema: z
				.object({
					start_date: z.string().optional(),
					end_date: z.string().optional(),
					created_since: z.string().optional(),
					updated_since: z.string().optional(),
					manual_account_id: z.number().int().optional(),
					plaid_account_id: z.number().int().optional(),
					category_id: z.number().int().optional(),
					tag_id: z.number().int().optional(),
					status: z.enum(['reviewed', 'unreviewed', 'deleted_pending']).optional(),
					is_pending: z.boolean().optional(),
					include_pending: z.boolean().optional(),
					include_metadata: z.boolean().optional(),
					include_files: z.boolean().optional(),
					include_children: z.boolean().optional(),
					include_split_parents: z.boolean().optional(),
					include_group_children: z.boolean().optional(),
					limit: z.number().int().positive().max(500).optional(),
					offset: z.number().int().min(0).optional(),
				})
				.refine(
					(args) =>
						(args.start_date === undefined && args.end_date === undefined) ||
						(args.start_date !== undefined && args.end_date !== undefined),
					{
						message: 'Provide both start_date and end_date together.',
						path: ['start_date'],
					},
				),
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async (args) => toolResult(await client.listTransactions(args)),
	);

	server.registerTool(
		'get_category',
		{
			title: 'Get Category',
			description: 'Fetch a single category by Lunch Money category ID.',
			inputSchema: {
				id: z.number().int().positive(),
			},
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async ({ id }) => toolResult(await client.getCategory(id)),
	);

	server.registerTool(
		'get_tag',
		{
			title: 'Get Tag',
			description: 'Fetch a single tag by Lunch Money tag ID.',
			inputSchema: {
				id: z.number().int().positive(),
			},
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async ({ id }) => toolResult(await client.getTag(id)),
	);

	server.registerTool(
		'get_manual_account',
		{
			title: 'Get Manual Account',
			description: 'Fetch a single manual account by Lunch Money manual account ID.',
			inputSchema: {
				id: z.number().int().positive(),
			},
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async ({ id }) => toolResult(await client.getManualAccount(id)),
	);

	server.registerTool(
		'get_plaid_account',
		{
			title: 'Get Plaid Account',
			description: 'Fetch a single Plaid account by Lunch Money Plaid account ID.',
			inputSchema: {
				id: z.number().int().positive(),
			},
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async ({ id }) => toolResult(await client.getPlaidAccount(id)),
	);

	server.registerTool(
		'get_transaction',
		{
			title: 'Get Transaction',
			description: 'Fetch a single transaction by Lunch Money transaction ID.',
			inputSchema: {
				id: z.number().int().positive(),
			},
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async ({ id }) => toolResult(await client.getTransaction(id)),
	);

	server.registerTool(
		'get_budget_summary',
		{
			title: 'Get Budget Summary',
			description: 'Fetch budget summary data for a date range.',
			inputSchema: {
				start_date: z.string(),
				end_date: z.string(),
				include_occurrences: z.boolean().optional(),
				include_past_budget_dates: z.boolean().optional(),
				include_totals: z.boolean().optional(),
				include_rollover_pool: z.boolean().optional(),
				include_exclude_from_budgets: z.boolean().optional(),
			},
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async (args) => toolResult(await client.getBudgetSummary(args)),
	);

	server.registerTool(
		'list_recurring_items',
		{
			title: 'List Recurring Items',
			description: 'List recurring income and expense items.',
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async () => toolResult(await client.listRecurringItems()),
	);

	server.registerTool(
		'get_recurring_item',
		{
			title: 'Get Recurring Item',
			description: 'Fetch a single recurring item by Lunch Money recurring item ID.',
			inputSchema: {
				id: z.number().int().positive(),
			},
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async ({ id }) => toolResult(await client.getRecurringItem(id)),
	);

	return server;
}

function toolResult(data: unknown) {
	return {
		content: [
			{
				type: 'text' as const,
				text: JSON.stringify(data, null, 2),
			},
		],
	};
}

function jsonResource(uri: string, data: unknown) {
	return {
		contents: [
			{
				uri,
				mimeType: 'application/json',
				text: JSON.stringify(data, null, 2),
			},
		],
	};
}

function parseId(value: string | undefined): number {
	const parsed = Number.parseInt(value ?? '', 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error('Resource path must include a positive numeric transaction id.');
	}

	return parsed;
}

function firstTemplateValue(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}
