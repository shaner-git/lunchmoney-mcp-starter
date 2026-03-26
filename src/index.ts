import OAuthProvider from '@cloudflare/workers-oauth-provider';
import { createMcpHandler } from 'agents/mcp';
import { handleAccessRequest } from './access-handler';
import type { OAuthAppEnv } from './config';
import { createLunchMoneyMcpServer } from './mcp';

const mcpApiHandler = {
	async fetch(request: Request, env: OAuthAppEnv, ctx: ExecutionContext): Promise<Response> {
		const server = createLunchMoneyMcpServer(env, new URL(request.url).origin);
		const handler = createMcpHandler(server, { route: '/mcp' });
		return handler(request, env, ctx);
	},
};

export default new OAuthProvider<OAuthAppEnv>({
	apiHandler: mcpApiHandler,
	apiRoute: '/mcp',
	authorizeEndpoint: '/authorize',
	clientRegistrationEndpoint: '/register',
	defaultHandler: { fetch: handleAccessRequest as typeof mcpApiHandler.fetch },
	tokenEndpoint: '/token',
});
