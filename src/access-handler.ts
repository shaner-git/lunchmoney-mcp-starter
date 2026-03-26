import { Buffer } from 'node:buffer';
import type { AuthRequest } from '@cloudflare/workers-oauth-provider';
import { readConfig, type OAuthAppEnv } from './config';
import {
	addApprovedClient,
	createOAuthState,
	fetchUpstreamAuthToken,
	generateCSRFProtection,
	getUpstreamAuthorizeUrl,
	isClientApproved,
	OAuthError,
	renderApprovalDialog,
	type IdentityProps,
	validateCSRFToken,
	validateOAuthState,
} from './workers-oauth-utils';

const CODEX_PROBE = {
	auth_model: 'cloudflare-access-oauth',
	marker: 'lunchmoney-mcp-codex-probe-2026-03-08-v1',
	resource_uris: [
		'lunchmoney://me',
		'lunchmoney://categories',
		'lunchmoney://categories/{id}',
		'lunchmoney://tags',
		'lunchmoney://tags/{id}',
		'lunchmoney://accounts/manual',
		'lunchmoney://manual_accounts/{id}',
		'lunchmoney://accounts/plaid',
		'lunchmoney://plaid_accounts/{id}',
		'lunchmoney://budgets/settings',
		'lunchmoney://recurring_items/{id}',
		'lunchmoney://transactions/{id}',
	],
	tool_names: [
		'list_transactions',
		'get_category',
		'get_tag',
		'get_manual_account',
		'get_plaid_account',
		'get_transaction',
		'get_budget_summary',
		'list_recurring_items',
		'get_recurring_item',
	],
};

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="Lunch Money MCP">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0f766e" />
      <stop offset="100%" stop-color="#14532d" />
    </linearGradient>
    <linearGradient id="coin" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#fde68a" />
      <stop offset="100%" stop-color="#f59e0b" />
    </linearGradient>
  </defs>
  <rect width="128" height="128" rx="28" fill="url(#bg)" />
  <path d="M34 42h60c6.6 0 12 5.4 12 12v30c0 6.6-5.4 12-12 12H34c-6.6 0-12-5.4-12-12V54c0-6.6 5.4-12 12-12Z" fill="#ecfccb" opacity="0.95" />
  <path d="M36 50h56c4.4 0 8 3.6 8 8v22c0 4.4-3.6 8-8 8H36c-4.4 0-8-3.6-8-8V58c0-4.4 3.6-8 8-8Z" fill="#14532d" opacity="0.12" />
  <circle cx="88" cy="64" r="18" fill="url(#coin)" />
  <path d="M86 53c-5 0-8 2.8-8 6.7 0 8.6 13 5.2 13 10 0 1.7-1.6 3-4.3 3-2.5 0-4.9-.9-6.8-2.4l-2.1 4.1c1.9 1.6 4.7 2.7 7.5 3v3.6h4.2v-3.7c4.9-.6 7.8-3.5 7.8-7.1 0-8.7-13-5.3-13-10.2 0-1.6 1.4-2.7 4.1-2.7 1.8 0 3.8.5 5.8 1.6l1.9-4.2c-1.9-1.1-4.2-1.7-6.1-1.9v-3.5h-4.2v3.7Z" fill="#14532d" />
  <path d="M45 61h18v7H45Zm0 12h31v7H45Z" fill="#14532d" opacity="0.8" />
</svg>`;

const LUNCHMONEY_MASCOT_PNG_URL = 'https://lunchmoney.app/assets/images/logos/mascot.png';

export async function handleAccessRequest(
	request: Request,
	env: OAuthAppEnv,
	_ctx: ExecutionContext,
): Promise<Response> {
	const url = new URL(request.url);
	const config = readConfig(env);
	const wantsHtml = request.headers.get('accept')?.includes('text/html') ?? false;

	if (request.method === 'GET' && url.pathname === '/') {
		if (wantsHtml) {
			return html(renderHomePage(url.origin, config));
		}

		return json(metadata(url.origin, config));
	}

	if (request.method === 'GET' && url.pathname === '/health') {
		return json({
			ok: true,
			has_lunchmoney_token: config.hasAccessToken,
			has_access_oauth: config.hasAccessOAuthConfig,
			public_base_url: config.publicBaseUrl,
			writes_enabled: config.writesEnabled,
			api_base_url: config.apiBaseUrl,
		});
	}

	if (request.method === 'GET' && url.pathname === '/icon.svg') {
		return new Response(ICON_SVG, {
			headers: {
				'cache-control': 'public, max-age=3600',
				'content-type': 'image/svg+xml; charset=utf-8',
			},
		});
	}

	if (request.method === 'GET' && url.pathname === '/icon.png') {
		return Response.redirect(LUNCHMONEY_MASCOT_PNG_URL, 302);
	}

	if (request.method === 'GET' && url.pathname === '/favicon.png') {
		return Response.redirect(LUNCHMONEY_MASCOT_PNG_URL, 302);
	}

	if (request.method === 'GET' && url.pathname === '/favicon.ico') {
		return Response.redirect(LUNCHMONEY_MASCOT_PNG_URL, 302);
	}

	if (request.method === 'GET' && url.pathname === '/favicon.svg') {
		return new Response(ICON_SVG, {
			headers: {
				'cache-control': 'public, max-age=3600',
				'content-type': 'image/svg+xml; charset=utf-8',
			},
		});
	}

	if (request.method === 'GET' && url.pathname === '/codex-probe') {
		return json({
			...CODEX_PROBE,
			configured: {
				has_access_oauth: config.hasAccessOAuthConfig,
				has_lunchmoney_token: config.hasAccessToken,
			},
			icon_url: `${url.origin}/icon.png`,
			worker_origin: url.origin,
		});
	}

	if (request.method === 'GET' && url.pathname === '/authorize') {
		let oauthReqInfo: AuthRequest;
		try {
			oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Invalid authorization request';
			return new OAuthError('invalid_client', message, 400).toResponse();
		}

		if (!oauthReqInfo.clientId) {
			return new Response('Invalid request', { status: 400 });
		}

		const client = await lookupClientOrNull(env, oauthReqInfo.clientId);
		if (!client) {
			return new OAuthError('invalid_client', 'Unknown OAuth client', 400).toResponse();
		}

		assertAccessOauthConfigured(env);

		if (await isClientApproved(request, oauthReqInfo.clientId, env.COOKIE_ENCRYPTION_KEY!.trim())) {
			const { stateToken } = await createOAuthState(oauthReqInfo, env.OAUTH_KV);
			return redirectToAccess(request, env, stateToken);
		}

		const { setCookie, token: csrfToken } = generateCSRFProtection();

		return renderApprovalDialog(request, {
			client,
			csrfToken,
			server: {
				name: 'Lunch Money MCP Starter',
				description:
					'Private Cloudflare-hosted MCP server for Lunch Money, secured with Cloudflare Access.',
				logo: `${url.origin}/icon.png`,
			},
			setCookie,
			state: { oauthReqInfo },
		});
	}

	if (request.method === 'POST' && url.pathname === '/authorize') {
		assertAccessOauthConfigured(env);
		try {
			const formData = await request.formData();
			validateCSRFToken(formData, request);

			const encodedState = formData.get('state');
			if (!encodedState || typeof encodedState !== 'string') {
				return new Response('Missing state in form data', { status: 400 });
			}

			let state: { oauthReqInfo?: AuthRequest };
			try {
				state = JSON.parse(atob(encodedState)) as { oauthReqInfo?: AuthRequest };
			} catch {
				return new Response('Invalid state data', { status: 400 });
			}

			if (!state.oauthReqInfo?.clientId) {
				return new Response('Invalid request', { status: 400 });
			}

			const approvedClientCookie = await addApprovedClient(
				request,
				state.oauthReqInfo.clientId,
				env.COOKIE_ENCRYPTION_KEY!.trim(),
			);
			const { stateToken } = await createOAuthState(state.oauthReqInfo, env.OAUTH_KV);

			return redirectToAccess(request, env, stateToken, {
				'Set-Cookie': approvedClientCookie,
			});
		} catch (error) {
			if (error instanceof OAuthError) {
				return error.toResponse();
			}

			const message = error instanceof Error ? error.message : 'Internal server error';
			return new Response(message, { status: 500 });
		}
	}

	if (request.method === 'GET' && url.pathname === '/callback') {
		assertAccessOauthConfigured(env);
		let oauthReqInfo: AuthRequest;

		try {
			const result = await validateOAuthState(request, env.OAUTH_KV);
			oauthReqInfo = result.oauthReqInfo;
		} catch (error) {
			if (error instanceof OAuthError) {
				return error.toResponse();
			}
			return new Response('Internal server error', { status: 500 });
		}

		const [accessToken, idToken, errResponse] = await fetchUpstreamAuthToken({
			client_id: env.ACCESS_CLIENT_ID!.trim(),
			client_secret: env.ACCESS_CLIENT_SECRET!.trim(),
			code: url.searchParams.get('code') ?? undefined,
			redirect_uri: callbackUrl(request, env),
			upstream_url: env.ACCESS_TOKEN_URL!.trim(),
		});
		if (errResponse) {
			return errResponse;
		}

		const claims = await verifyAccessToken(env, idToken);
		const user = {
			email: claims.email,
			name: claims.name ?? claims.email ?? claims.sub,
			sub: claims.sub,
		};

		const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
			metadata: {
				label: user.name || user.email,
			},
			props: {
				accessToken,
				email: user.email,
				login: user.sub,
				name: user.name,
			} satisfies IdentityProps,
			request: oauthReqInfo,
			scope: oauthReqInfo.scope,
			userId: user.sub,
		});

		return Response.redirect(redirectTo, 302);
	}

	return json({ error: 'Not Found' }, 404);
}

async function redirectToAccess(
	request: Request,
	env: OAuthAppEnv,
	stateToken: string,
	headers: Record<string, string> = {},
): Promise<Response> {
	assertAccessOauthConfigured(env);
	return new Response(null, {
		status: 302,
		headers: {
			...headers,
			location: getUpstreamAuthorizeUrl({
				client_id: env.ACCESS_CLIENT_ID!.trim(),
				redirect_uri: callbackUrl(request, env),
				scope: 'openid email profile',
				state: stateToken,
				upstream_url: env.ACCESS_AUTHORIZATION_URL!.trim(),
			}),
		},
	});
}

function callbackUrl(request: Request, env: OAuthAppEnv): string {
	const baseUrl = env.PUBLIC_BASE_URL?.trim();
	if (baseUrl) {
		return new URL('/callback', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).href;
	}

	return new URL('/callback', request.url).href;
}

async function lookupClientOrNull(env: OAuthAppEnv, clientId: string) {
	try {
		return await env.OAUTH_PROVIDER.lookupClient(clientId);
	} catch {
		return null;
	}
}

async function fetchAccessPublicKey(env: OAuthAppEnv, kid: string): Promise<CryptoKey> {
	const response = await fetch(env.ACCESS_JWKS_URL!.trim());
	const keys = (await response.json()) as {
		keys: Array<JsonWebKey & { kid: string }>;
	};
	const jwk = keys.keys.find((key) => key.kid === kid);
	if (!jwk) {
		throw new Error(`Unable to find a matching Cloudflare Access signing key for kid ${kid}.`);
	}

	return crypto.subtle.importKey(
		'jwk',
		jwk,
		{
			hash: 'SHA-256',
			name: 'RSASSA-PKCS1-v1_5',
		},
		false,
		['verify'],
	);
}

function parseJwt(token: string): {
	data: string;
	header: { kid?: string };
	payload: {
		aud: string | string[];
		email: string;
		email_verified?: boolean;
		exp: number;
		iss: string;
		name: string;
		sub: string;
	};
	signature: string;
} {
	const parts = token.split('.');
	if (parts.length !== 3) {
		throw new Error('JWT must contain three segments.');
	}

	return {
		data: `${parts[0]}.${parts[1]}`,
		header: JSON.parse(Buffer.from(parts[0], 'base64url').toString()) as { kid?: string },
		payload: JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as {
			aud: string | string[];
			email: string;
			email_verified?: boolean;
			exp: number;
			iss: string;
			name: string;
			sub: string;
		},
		signature: parts[2],
	};
}

async function verifyAccessToken(env: OAuthAppEnv, token: string) {
	const jwt = parseJwt(token);
	if (!jwt.header.kid) {
		throw new Error('Cloudflare Access id_token did not include a kid header.');
	}

	const key = await fetchAccessPublicKey(env, jwt.header.kid);
	const verified = await crypto.subtle.verify(
		'RSASSA-PKCS1-v1_5',
		key,
		Buffer.from(jwt.signature, 'base64url'),
		Buffer.from(jwt.data),
	);
	if (!verified) {
		throw new Error('Failed to verify the Cloudflare Access id_token signature.');
	}

	const now = Math.floor(Date.now() / 1000);
	if (jwt.payload.exp < now) {
		throw new Error('Cloudflare Access id_token has expired.');
	}

	const expectedAudience = env.ACCESS_CLIENT_ID!.trim();
	const audience = Array.isArray(jwt.payload.aud) ? jwt.payload.aud : [jwt.payload.aud];
	if (!audience.includes(expectedAudience)) {
		throw new Error('Cloudflare Access id_token audience does not match the configured client id.');
	}

	return jwt.payload;
}

function assertAccessOauthConfigured(env: OAuthAppEnv): void {
	const missing = [
		['ACCESS_CLIENT_ID', env.ACCESS_CLIENT_ID],
		['ACCESS_CLIENT_SECRET', env.ACCESS_CLIENT_SECRET],
		['ACCESS_TOKEN_URL', env.ACCESS_TOKEN_URL],
		['ACCESS_AUTHORIZATION_URL', env.ACCESS_AUTHORIZATION_URL],
		['ACCESS_JWKS_URL', env.ACCESS_JWKS_URL],
		['COOKIE_ENCRYPTION_KEY', env.COOKIE_ENCRYPTION_KEY],
	].filter(([, value]) => !value?.trim());

	if (missing.length > 0) {
		throw new Error(
			`Missing required Cloudflare Access OAuth configuration: ${missing.map(([key]) => key).join(', ')}`,
		);
	}
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: {
			'content-type': 'application/json; charset=utf-8',
		},
	});
}

function html(markup: string, status = 200): Response {
	return new Response(markup, {
		status,
		headers: {
			'content-type': 'text/html; charset=utf-8',
		},
	});
}

function metadata(origin: string, config: ReturnType<typeof readConfig>) {
	return {
		name: 'lunchmoney-mcp-starter',
		endpoints: {
			mcp: `${origin}/mcp`,
			health: `${origin}/health`,
			authorize: `${origin}/authorize`,
			token: `${origin}/token`,
			register: `${origin}/register`,
			callback: `${origin}/callback`,
			oauth_authorization_server: `${origin}/.well-known/oauth-authorization-server`,
			oauth_protected_resource: `${origin}/.well-known/oauth-protected-resource`,
		},
		configured: {
			has_lunchmoney_token: config.hasAccessToken,
			has_access_oauth: config.hasAccessOAuthConfig,
			writes_enabled: config.writesEnabled,
		},
		notes: [
			'This Worker uses Cloudflare Access as the upstream OAuth provider for MCP clients.',
			'Clients need remote OAuth support or a proxy such as mcp-remote.',
		],
	};
}

function renderHomePage(origin: string, config: ReturnType<typeof readConfig>): string {
	const info = metadata(origin, config);
	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Lunch Money MCP Starter</title>
  <meta name="description" content="Reference implementation for a private Cloudflare-hosted Lunch Money MCP server with Cloudflare Access OAuth." />
  <link rel="icon" href="${origin}/favicon.png" type="image/png" />
  <link rel="icon" href="${origin}/favicon.svg" type="image/svg+xml" />
  <link rel="shortcut icon" href="${origin}/favicon.ico" />
  <meta property="og:title" content="Lunch Money MCP Starter" />
  <meta property="og:description" content="Reference implementation for a private Cloudflare-hosted Lunch Money MCP server with Cloudflare Access OAuth." />
  <meta property="og:image" content="${origin}/icon.png" />
</head>
<body>
  <h1>Lunch Money MCP Starter</h1>
  <p>Reference implementation for a private Cloudflare-hosted Lunch Money MCP server with Cloudflare Access OAuth.</p>
  <pre>${escapeHtml(JSON.stringify(info, null, 2))}</pre>
</body>
</html>`;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}
