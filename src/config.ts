import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

export interface AppEnv {
	OAUTH_KV: KVNamespace;
	LUNCHMONEY_ACCESS_TOKEN?: string;
	LUNCHMONEY_API_BASE_URL?: string;
	CACHE_TTL_SECONDS?: string;
	ENABLE_WRITES?: string;
	PUBLIC_BASE_URL?: string;
	ACCESS_AUTHORIZATION_URL?: string;
	ACCESS_CLIENT_ID?: string;
	ACCESS_CLIENT_SECRET?: string;
	ACCESS_JWKS_URL?: string;
	ACCESS_TOKEN_URL?: string;
	COOKIE_ENCRYPTION_KEY?: string;
}

export type OAuthAppEnv = AppEnv & {
	OAUTH_PROVIDER: OAuthHelpers;
};

export interface RuntimeConfig {
	apiBaseUrl: string;
	cacheTtlMs: number;
	hasAccessToken: boolean;
	writesEnabled: boolean;
	hasAccessOAuthConfig: boolean;
	publicBaseUrl: string | null;
}

const DEFAULT_API_BASE_URL = 'https://api.lunchmoney.dev/v2';
const DEFAULT_CACHE_TTL_SECONDS = 300;

export function readConfig(env: AppEnv): RuntimeConfig {
	return {
		apiBaseUrl: env.LUNCHMONEY_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL,
		cacheTtlMs: parsePositiveInteger(env.CACHE_TTL_SECONDS, DEFAULT_CACHE_TTL_SECONDS) * 1000,
		hasAccessToken: Boolean(env.LUNCHMONEY_ACCESS_TOKEN?.trim()),
		writesEnabled: parseBooleanFlag(env.ENABLE_WRITES),
		hasAccessOAuthConfig: hasAccessOAuthConfig(env),
		publicBaseUrl: env.PUBLIC_BASE_URL?.trim() || null,
	};
}

export function parseBooleanFlag(value: string | undefined): boolean {
	if (!value) {
		return false;
	}

	return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
	if (!value) {
		return fallback;
	}

	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return fallback;
	}

	return parsed;
}

function hasAccessOAuthConfig(env: AppEnv): boolean {
	return Boolean(
		env.ACCESS_CLIENT_ID?.trim() &&
			env.ACCESS_CLIENT_SECRET?.trim() &&
			env.ACCESS_TOKEN_URL?.trim() &&
			env.ACCESS_AUTHORIZATION_URL?.trim() &&
			env.ACCESS_JWKS_URL?.trim() &&
			env.COOKIE_ENCRYPTION_KEY?.trim(),
	);
}
