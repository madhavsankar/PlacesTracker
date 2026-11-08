/**
 * McpRouter — Streamable HTTP Model Context Protocol (MCP) Server (`/mcp`).
 * Static tool schemas and server metadata are loaded from `data/catalog/`.
 */

import { CORS_HEADERS } from "../config/constants.js";
import { APP_METADATA, MCP_TOOLS } from "../data/CatalogData.js";

export class McpRouter {
  constructor(catalogService, storageRepo) {
    this.catalogService = catalogService;
    this.storageRepo = storageRepo;
  }

  async handleRequest(request, originUrl) {
    if (request.method === "GET") {
      return new Response(
        JSON.stringify({
          ...APP_METADATA.server_info,
          status: "ok",
          mcp_endpoint: `${originUrl}/mcp`,
          web_map_url: originUrl,
        }),
        { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }

    if (request.method === "POST") {
      const msg = await request.json();
      const { method, id, params = {} } = msg;

      if (id === undefined || id === null) {
        return new Response(null, { status: 202, headers: CORS_HEADERS });
      }

      try {
        let result;
        if (method === "initialize") {
          result = {
            protocolVersion:
              params.protocolVersion || APP_METADATA.default_protocol_version,
            capabilities: { tools: { listChanged: false } },
            serverInfo: APP_METADATA.server_info,
          };
        } else if (method === "ping") {
          result = {};
        } else if (method === "tools/list") {
          result = { tools: MCP_TOOLS };
        } else if (method === "tools/call") {
          const toolOut = await this.executeToolCall(
            originUrl,
            params.name,
            params.arguments || {}
          );
          result = {
            content: [{ type: "text", text: JSON.stringify(toolOut, null, 2) }],
            isError: false,
          };
        } else {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              error: { code: -32601, message: `Method not found: ${method}` },
            }),
            { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
          );
        }

        return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        });
      } catch (err) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: `Error: ${err.message}` }],
              isError: true,
            },
          }),
          { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
        );
      }
    }

    return new Response("Method Not Allowed", { status: 405, headers: CORS_HEADERS });
  }

  async executeToolCall(originUrl, toolName, args = {}) {
    if (toolName === "places_mark") {
      const res = await this.catalogService.markPlaces(args);
      return { ...res, interactive_map_url: originUrl };
    }

    if (toolName === "places_stats") {
      const userState = await this.storageRepo.loadUserState();
      const catalog = this.catalogService.getMergedCatalog(userState);
      return {
        ...this.catalogService.computeStats(catalog),
        interactive_map_url: originUrl,
      };
    }

    if (toolName === "places_search") {
      const userState = await this.storageRepo.loadUserState();
      const catalog = this.catalogService.getMergedCatalog(userState);
      const results = this.catalogService.searchPlaces(catalog, args);
      return { count: results.length, places: results };
    }

    if (toolName === "places_recommend") {
      const userState = await this.storageRepo.loadUserState();
      const catalog = this.catalogService.getMergedCatalog(userState);
      return this.catalogService.recommendPlaces(catalog, args.destination);
    }

    if (toolName === "places_add_custom") {
      const res = await this.catalogService.addCustomPlace(args);
      return { added: args.name, mark_result: res, interactive_map_url: originUrl };
    }

    if (toolName === "places_render_dashboard") {
      const userState = await this.storageRepo.loadUserState();
      const catalog = this.catalogService.getMergedCatalog(userState);
      const stats = this.catalogService.computeStats(catalog);
      return {
        status: "rendered",
        interactive_map_url: originUrl,
        summary: stats.summary,
        flag_belt: stats.flag_belt,
      };
    }

    if (toolName === "places_csv") {
      if (args.action === "import" && args.csv_text) {
        const res = await this.catalogService.importCsv(args.csv_text);
        return { action: "import", ...res, interactive_map_url: originUrl };
      }
      const userState = await this.storageRepo.loadUserState();
      const catalog = this.catalogService.getMergedCatalog(userState);
      const csvText = this.catalogService.exportCsv(catalog);
      return { action: "export", csv: csvText };
    }

    throw new Error(`Unknown tool: ${toolName}`);
  }
}
