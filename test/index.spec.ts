import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src';

describe('Lunch Money MCP worker', () => {
	it('serves metadata at /', async () => {
		const request = new Request('http://example.com/');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);

		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			name: 'lunchmoney-mcp-starter',
			endpoints: {
				authorize: 'http://example.com/authorize',
				mcp: 'http://example.com/mcp',
				health: 'http://example.com/health',
				register: 'http://example.com/register',
				token: 'http://example.com/token',
			},
		});
	});

	it('serves HTML at / when the client asks for it', async () => {
		const response = await SELF.fetch('http://example.com/', {
			headers: {
				accept: 'text/html',
			},
		});
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('text/html');
		const body = await response.text();
		expect(body).toContain('<link rel="icon" href="http://example.com/favicon.png" type="image/png" />');
		expect(body).toContain('<link rel="shortcut icon" href="http://example.com/favicon.ico" />');
	});

	it('serves health at /health', async () => {
		const response = await SELF.fetch('http://example.com/health');
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			api_base_url: 'https://api.lunchmoney.dev/v2',
		});
	});

	it('serves the codex probe marker', async () => {
		const response = await SELF.fetch('http://example.com/codex-probe');
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			auth_model: 'cloudflare-access-oauth',
			icon_url: 'http://example.com/icon.png',
			marker: 'lunchmoney-mcp-codex-probe-2026-03-08-v1',
			worker_origin: 'http://example.com',
		});
	});

	it('serves the MCP PNG icon URL', async () => {
		const response = await SELF.fetch('http://example.com/icon.png', {
			redirect: 'manual',
		});
		expect(response.status).toBe(302);
		expect(response.headers.get('location')).toBe('https://lunchmoney.app/assets/images/logos/mascot.png');
	});

	it('serves favicon routes', async () => {
		const pngResponse = await SELF.fetch('http://example.com/favicon.png', {
			redirect: 'manual',
		});
		expect(pngResponse.status).toBe(302);
		expect(pngResponse.headers.get('location')).toBe('https://lunchmoney.app/assets/images/logos/mascot.png');

		const icoResponse = await SELF.fetch('http://example.com/favicon.ico', {
			redirect: 'manual',
		});
		expect(icoResponse.status).toBe(302);
		expect(icoResponse.headers.get('location')).toBe('https://lunchmoney.app/assets/images/logos/mascot.png');

		const svgResponse = await SELF.fetch('http://example.com/favicon.svg');
		expect(svgResponse.status).toBe(200);
		expect(svgResponse.headers.get('content-type')).toContain('image/svg+xml');
	});

	it('serves the MCP icon', async () => {
		const response = await SELF.fetch('http://example.com/icon.svg');
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('image/svg+xml');
		expect(await response.text()).toContain('Lunch Money MCP');
	});

	it('serves OAuth authorization server metadata', async () => {
		const response = await SELF.fetch('http://example.com/.well-known/oauth-authorization-server');
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			authorization_endpoint: 'http://example.com/authorize',
			registration_endpoint: 'http://example.com/register',
			token_endpoint: 'http://example.com/token',
		});
	});

	it('returns invalid_client for unknown authorize clients', async () => {
		const response = await SELF.fetch(
			'http://example.com/authorize?response_type=code&client_id=missing-client&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback&state=test-state&code_challenge=test-challenge&code_challenge_method=plain',
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: 'invalid_client',
			error_description: 'Invalid client. The clientId provided does not match to this client.',
		});
	});

	it('returns 404 for unknown routes', async () => {
		const response = await SELF.fetch('http://example.com/does-not-exist');
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: 'Not Found' });
	});
});
