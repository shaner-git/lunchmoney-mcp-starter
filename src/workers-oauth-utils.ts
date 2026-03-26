import type { AuthRequest, ClientInfo } from '@cloudflare/workers-oauth-provider';

export class OAuthError extends Error {
	constructor(
		public code: string,
		public description: string,
		public statusCode = 400,
	) {
		super(description);
		this.name = 'OAuthError';
	}

	toResponse(): Response {
		return new Response(
			JSON.stringify({
				error: this.code,
				error_description: this.description,
			}),
			{
				status: this.statusCode,
				headers: { 'content-type': 'application/json; charset=utf-8' },
			},
		);
	}
}

export interface OAuthStateResult {
	stateToken: string;
}

export interface ValidateStateResult {
	oauthReqInfo: AuthRequest;
	clearCookie: string;
}

export interface CSRFProtectionResult {
	token: string;
	setCookie: string;
}

export interface ValidateCsrfResult {
	clearCookie: string;
}

export interface IdentityProps {
	email: string;
	login: string;
	name: string;
	[key: string]: unknown;
}

export function sanitizeText(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}

export function sanitizeUrl(url: string): string {
	const normalized = url.trim();
	if (normalized.length === 0) {
		return '';
	}

	for (let index = 0; index < normalized.length; index += 1) {
		const code = normalized.charCodeAt(index);
		if ((code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f)) {
			return '';
		}
	}

	let parsedUrl: URL;
	try {
		parsedUrl = new URL(normalized);
	} catch {
		return '';
	}

	const scheme = parsedUrl.protocol.slice(0, -1).toLowerCase();
	if (!['https', 'http'].includes(scheme)) {
		return '';
	}

	return normalized;
}

export function generateCSRFProtection(): CSRFProtectionResult {
	const cookieName = '__Host-CSRF_TOKEN';
	const token = crypto.randomUUID();
	return {
		token,
		setCookie: `${cookieName}=${token}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600`,
	};
}

export function validateCSRFToken(formData: FormData, request: Request): ValidateCsrfResult {
	const cookieName = '__Host-CSRF_TOKEN';
	const tokenFromForm = formData.get('csrf_token');
	if (!tokenFromForm || typeof tokenFromForm !== 'string') {
		throw new OAuthError('invalid_request', 'Missing CSRF token in form data', 400);
	}

	const cookieHeader = request.headers.get('Cookie') || '';
	const cookies = cookieHeader.split(';').map((cookie) => cookie.trim());
	const csrfCookie = cookies.find((cookie) => cookie.startsWith(`${cookieName}=`));
	const tokenFromCookie = csrfCookie ? csrfCookie.slice(cookieName.length + 1) : null;

	if (!tokenFromCookie) {
		throw new OAuthError('invalid_request', 'Missing CSRF token cookie', 400);
	}

	if (tokenFromForm !== tokenFromCookie) {
		throw new OAuthError('invalid_request', 'CSRF token mismatch', 400);
	}

	return {
		clearCookie: `${cookieName}=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0`,
	};
}

export async function createOAuthState(
	oauthReqInfo: AuthRequest,
	kv: KVNamespace,
	stateTtlSeconds = 600,
): Promise<OAuthStateResult> {
	const stateToken = crypto.randomUUID();
	await kv.put(`oauth:state:${stateToken}`, JSON.stringify(oauthReqInfo), {
		expirationTtl: stateTtlSeconds,
	});
	return { stateToken };
}

export async function validateOAuthState(
	request: Request,
	kv: KVNamespace,
): Promise<ValidateStateResult> {
	const stateFromQuery = new URL(request.url).searchParams.get('state');
	if (!stateFromQuery) {
		throw new OAuthError('invalid_request', 'Missing state parameter', 400);
	}

	const storedDataJson = await kv.get(`oauth:state:${stateFromQuery}`);
	if (!storedDataJson) {
		throw new OAuthError('invalid_request', 'Invalid or expired state', 400);
	}

	let oauthReqInfo: AuthRequest;
	try {
		oauthReqInfo = JSON.parse(storedDataJson) as AuthRequest;
	} catch {
		throw new OAuthError('server_error', 'Invalid state data', 500);
	}

	await kv.delete(`oauth:state:${stateFromQuery}`);

	return {
		oauthReqInfo,
		clearCookie: '',
	};
}

export async function isClientApproved(
	request: Request,
	clientId: string,
	cookieSecret: string,
): Promise<boolean> {
	const approvedClients = await getApprovedClientsFromCookie(request, cookieSecret);
	return approvedClients?.includes(clientId) ?? false;
}

export async function addApprovedClient(
	request: Request,
	clientId: string,
	cookieSecret: string,
): Promise<string> {
	const cookieName = '__Host-APPROVED_CLIENTS';
	const maxAgeSeconds = 60 * 60 * 24 * 30;
	const existingApprovedClients =
		(await getApprovedClientsFromCookie(request, cookieSecret)) || [];
	const updatedApprovedClients = Array.from(new Set([...existingApprovedClients, clientId]));
	const payload = JSON.stringify(updatedApprovedClients);
	const signature = await signData(payload, cookieSecret);
	const cookieValue = `${signature}.${btoa(payload)}`;

	return `${cookieName}=${cookieValue}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export interface ApprovalDialogOptions {
	client: ClientInfo | null;
	server: {
		name: string;
		logo?: string;
		description?: string;
	};
	state: Record<string, unknown>;
	csrfToken: string;
	setCookie: string;
}

export function renderApprovalDialog(request: Request, options: ApprovalDialogOptions): Response {
	const { client, csrfToken, server, setCookie, state } = options;
	const encodedState = btoa(JSON.stringify(state));
	const serverName = sanitizeText(server.name);
	const clientName = client?.clientName ? sanitizeText(client.clientName) : 'Unknown MCP Client';
	const serverDescription = server.description ? sanitizeText(server.description) : '';
	const logoUrl = server.logo ? sanitizeText(sanitizeUrl(server.logo)) : '';
	const clientUri = client?.clientUri ? sanitizeText(sanitizeUrl(client.clientUri)) : '';
	const policyUri = client?.policyUri ? sanitizeText(sanitizeUrl(client.policyUri)) : '';
	const tosUri = client?.tosUri ? sanitizeText(sanitizeUrl(client.tosUri)) : '';
	const contacts =
		client?.contacts && client.contacts.length > 0
			? sanitizeText(client.contacts.join(', '))
			: '';
	const redirectUris =
		client?.redirectUris && client.redirectUris.length > 0
			? client.redirectUris
					.map((uri) => {
						const validated = sanitizeUrl(uri);
						return validated ? sanitizeText(validated) : '';
					})
					.filter((uri) => uri !== '')
			: [];

	const html = `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${clientName} | Authorization Request</title>
        <style>
          :root {
            --accent: #f97316;
            --border: #e5e7eb;
            --ink: #111827;
            --muted: #4b5563;
            --panel: #ffffff;
            --shadow: 0 16px 48px rgba(17, 24, 39, 0.12);
          }

          body {
            margin: 0;
            min-height: 100vh;
            font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            color: var(--ink);
            background:
              radial-gradient(circle at top left, rgba(249, 115, 22, 0.18), transparent 28%),
              linear-gradient(180deg, #fff7ed 0%, #f8fafc 100%);
          }

          .shell {
            max-width: 720px;
            margin: 0 auto;
            padding: 48px 20px;
          }

          .banner {
            text-align: center;
            margin-bottom: 24px;
          }

          .panel {
            background: var(--panel);
            border: 1px solid rgba(229, 231, 235, 0.9);
            border-radius: 20px;
            box-shadow: var(--shadow);
            padding: 32px;
          }

          .server {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 12px;
            margin-bottom: 12px;
          }

          .logo {
            width: 48px;
            height: 48px;
            border-radius: 12px;
            object-fit: contain;
          }

          h1, h2, p {
            margin: 0;
          }

          .headline {
            font-size: 1.85rem;
            line-height: 1.15;
            margin-bottom: 12px;
            text-align: center;
          }

          .subhead {
            color: var(--muted);
            text-align: center;
            margin-bottom: 28px;
          }

          .card {
            border: 1px solid var(--border);
            border-radius: 16px;
            padding: 20px;
            background: linear-gradient(180deg, rgba(255, 247, 237, 0.7), rgba(255, 255, 255, 0.9));
          }

          .row {
            display: flex;
            gap: 16px;
            margin-bottom: 12px;
            align-items: baseline;
          }

          .label {
            min-width: 140px;
            color: var(--muted);
            font-weight: 600;
          }

          .value {
            overflow-wrap: anywhere;
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            font-size: 0.95rem;
          }

          .value a {
            color: inherit;
          }

          .copy {
            margin-top: 20px;
            color: var(--muted);
          }

          .actions {
            display: flex;
            justify-content: flex-end;
            gap: 12px;
            margin-top: 28px;
          }

          .button {
            appearance: none;
            border: 0;
            border-radius: 999px;
            cursor: pointer;
            font-size: 1rem;
            font-weight: 700;
            padding: 12px 18px;
          }

          .button-secondary {
            background: #ffffff;
            box-shadow: inset 0 0 0 1px var(--border);
            color: var(--ink);
          }

          .button-primary {
            background: var(--accent);
            color: #ffffff;
          }

          @media (max-width: 640px) {
            .panel {
              padding: 24px;
            }

            .row {
              flex-direction: column;
              gap: 4px;
            }

            .label {
              min-width: auto;
            }

            .actions {
              flex-direction: column;
            }

            .button {
              width: 100%;
            }
          }
        </style>
      </head>
      <body>
        <main class="shell">
          <section class="banner">
            <div class="server">
              ${logoUrl ? `<img src="${logoUrl}" alt="${serverName} logo" class="logo">` : ''}
              <p><strong>${serverName}</strong></p>
            </div>
            ${serverDescription ? `<p class="subhead">${serverDescription}</p>` : ''}
          </section>

          <section class="panel">
            <h1 class="headline">${clientName} wants to connect</h1>
            <p class="subhead">Approve this client to continue through Cloudflare Access sign-in and finish the MCP OAuth flow.</p>

            <div class="card">
              <div class="row">
                <div class="label">Client</div>
                <div class="value">${clientName}</div>
              </div>
              ${
								clientUri
									? `
              <div class="row">
                <div class="label">Website</div>
                <div class="value"><a href="${clientUri}" target="_blank" rel="noopener noreferrer">${clientUri}</a></div>
              </div>`
									: ''
							}
              ${
								policyUri
									? `
              <div class="row">
                <div class="label">Privacy Policy</div>
                <div class="value"><a href="${policyUri}" target="_blank" rel="noopener noreferrer">${policyUri}</a></div>
              </div>`
									: ''
							}
              ${
								tosUri
									? `
              <div class="row">
                <div class="label">Terms of Service</div>
                <div class="value"><a href="${tosUri}" target="_blank" rel="noopener noreferrer">${tosUri}</a></div>
              </div>`
									: ''
							}
              ${
								redirectUris.length > 0
									? `
              <div class="row">
                <div class="label">Redirect URIs</div>
                <div class="value">${redirectUris.map((uri) => `<div>${uri}</div>`).join('')}</div>
              </div>`
									: ''
							}
              ${
								contacts
									? `
              <div class="row">
                <div class="label">Contact</div>
                <div class="value">${contacts}</div>
              </div>`
									: ''
							}
            </div>

            <p class="copy">Only approve MCP clients you expect to use with this private Lunch Money server.</p>

            <form method="post" action="${new URL(request.url).pathname}">
              <input type="hidden" name="state" value="${encodedState}">
              <input type="hidden" name="csrf_token" value="${csrfToken}">

              <div class="actions">
                <button type="button" class="button button-secondary" onclick="window.history.back()">Cancel</button>
                <button type="submit" class="button button-primary">Approve</button>
              </div>
            </form>
          </section>
        </main>
      </body>
    </html>
  `;

	return new Response(html, {
		headers: {
			'content-security-policy': "frame-ancestors 'none'",
			'content-type': 'text/html; charset=utf-8',
			'Set-Cookie': setCookie,
			'x-frame-options': 'DENY',
		},
	});
}

async function getApprovedClientsFromCookie(
	request: Request,
	cookieSecret: string,
): Promise<string[] | null> {
	const cookieName = '__Host-APPROVED_CLIENTS';
	const cookieHeader = request.headers.get('Cookie');
	if (!cookieHeader) {
		return null;
	}

	const cookies = cookieHeader.split(';').map((cookie) => cookie.trim());
	const targetCookie = cookies.find((cookie) => cookie.startsWith(`${cookieName}=`));
	if (!targetCookie) {
		return null;
	}

	const cookieValue = targetCookie.slice(cookieName.length + 1);
	const parts = cookieValue.split('.');
	if (parts.length !== 2) {
		return null;
	}

	const [signatureHex, base64Payload] = parts;
	const payload = atob(base64Payload);
	const isValid = await verifySignature(signatureHex, payload, cookieSecret);
	if (!isValid) {
		return null;
	}

	try {
		const approvedClients = JSON.parse(payload);
		if (
			!Array.isArray(approvedClients) ||
			!approvedClients.every((item) => typeof item === 'string')
		) {
			return null;
		}
		return approvedClients as string[];
	} catch {
		return null;
	}
}

async function signData(data: string, secret: string): Promise<string> {
	const key = await importKey(secret);
	const encoded = new TextEncoder().encode(data);
	const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoded);
	return Array.from(new Uint8Array(signatureBuffer))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

async function verifySignature(
	signatureHex: string,
	data: string,
	secret: string,
): Promise<boolean> {
	const key = await importKey(secret);
	const encoded = new TextEncoder().encode(data);

	try {
		const signatureBytes = new Uint8Array(
			signatureHex.match(/.{1,2}/g)?.map((byte) => Number.parseInt(byte, 16)) ?? [],
		);
		return await crypto.subtle.verify('HMAC', key, signatureBytes.buffer, encoded);
	} catch {
		return false;
	}
}

async function importKey(secret: string): Promise<CryptoKey> {
	if (!secret) {
		throw new Error('COOKIE_ENCRYPTION_KEY is required for signing approval cookies.');
	}

	return crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ hash: 'SHA-256', name: 'HMAC' },
		false,
		['sign', 'verify'],
	);
}

export function getUpstreamAuthorizeUrl(params: {
	upstream_url: string;
	client_id: string;
	redirect_uri: string;
	scope: string;
	state: string;
}): string {
	const url = new URL(params.upstream_url);
	url.searchParams.set('client_id', params.client_id);
	url.searchParams.set('redirect_uri', params.redirect_uri);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('scope', params.scope);
	url.searchParams.set('state', params.state);
	return url.toString();
}

export async function fetchUpstreamAuthToken(params: {
	upstream_url: string;
	client_id: string;
	client_secret: string;
	code?: string;
	redirect_uri: string;
}): Promise<[string, string, null] | [null, null, Response]> {
	if (!params.code) {
		return [null, null, new Response('Missing authorization code', { status: 400 })];
	}

	const body = new URLSearchParams({
		client_id: params.client_id,
		client_secret: params.client_secret,
		code: params.code,
		grant_type: 'authorization_code',
		redirect_uri: params.redirect_uri,
	});

	const response = await fetch(params.upstream_url, {
		method: 'POST',
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: body.toString(),
	});

	if (!response.ok) {
		const errorText = await response.text();
		return [
			null,
			null,
			new Response(`Failed to exchange code for token: ${errorText}`, {
				status: response.status,
			}),
		];
	}

	const payload = (await response.json()) as {
		access_token?: string;
		id_token?: string;
	};

	if (!payload.access_token) {
		return [null, null, new Response('Missing access token', { status: 400 })];
	}

	if (!payload.id_token) {
		return [null, null, new Response('Missing id token', { status: 400 })];
	}

	return [payload.access_token, payload.id_token, null];
}
