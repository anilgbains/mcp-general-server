import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = Number(process.env.PORT ?? 8787);
const MCP_PATH = "/mcp";

type Doc = {
  id: string;
  title: string;
  text: string;
};

const docs: Doc[] = [
  {
    id: "intro",
    title: "Introduction",
    text: "This is a sample document that explains what this MCP server does."
  },
  {
    id: "faq",
    title: "FAQ",
    text: "This server exposes example tools like ping, echo, time lookup, and document search."
  },
  {
    id: "policies",
    title: "Policies",
    text: "Keep tool inputs narrow, validate everything, and never expose sensitive backend internals."
  }
];

function createMcpApp() {
  const server = new McpServer({
    name: "general-mcp-server",
    version: "0.1.0"
  });

  server.registerTool(
    "ping",
    {
      title: "Ping",
      description: "Returns pong. Useful as a health-check tool.",
      inputSchema: {},
      annotations: { readOnlyHint: true }
    },
    async () => {
      return {
        content: [{ type: "text", text: "pong" }]
      };
    }
  );

  server.registerTool(
    "echo_text",
    {
      title: "Echo text",
      description: "Returns the exact text provided by the caller.",
      inputSchema: {
        text: z.string().min(1).max(5000)
      },
      annotations: { readOnlyHint: true }
    },
    async ({ text }) => {
      return {
        content: [{ type: "text", text }]
      };
    }
  );

  server.registerTool(
    "get_server_time",
    {
      title: "Get server time",
      description: "Returns the current server time. Optionally formats it for a given IANA time zone.",
      inputSchema: {
        timezone: z.string().optional()
      },
      annotations: { readOnlyHint: true }
    },
    async ({ timezone }) => {
      const now = new Date();

      let result: string;
      if (timezone) {
        try {
          result = new Intl.DateTimeFormat("en-US", {
            timeZone: timezone,
            dateStyle: "full",
            timeStyle: "long"
          }).format(now);
        } catch {
          result = now.toISOString();
        }
      } else {
        result = now.toISOString();
      }

      return {
        content: [{ type: "text", text: `Current server time: ${result}` }]
      };
    }
  );

  server.registerTool(
    "search_docs",
    {
      title: "Search docs",
      description: "Searches a small in-memory document set and returns matching results.",
      inputSchema: {
        query: z.string().min(2).max(200)
      },
      annotations: { readOnlyHint: true }
    },
    async ({ query }) => {
      const q = query.toLowerCase();

      const results = docs
        .filter(
          (doc) =>
            doc.title.toLowerCase().includes(q) ||
            doc.text.toLowerCase().includes(q)
        )
        .map((doc) => ({
          id: doc.id,
          title: doc.title,
          snippet: doc.text.slice(0, 120)
        }));

      return {
        structuredContent: { results },
        content: [
          {
            type: "text",
            text: results.length
              ? `Found ${results.length} result(s) for "${query}".`
              : `No results found for "${query}".`
          }
        ]
      };
    }
  );

  server.registerTool(
    "fetch_doc",
    {
      title: "Fetch doc",
      description: "Returns the full text of a document by id.",
      inputSchema: {
        id: z.string().min(1)
      },
      annotations: { readOnlyHint: true }
    },
    async ({ id }) => {
      const doc = docs.find((d) => d.id === id);

      if (!doc) {
        return {
          content: [{ type: "text", text: `Document "${id}" was not found.` }]
        };
      }

      return {
        structuredContent: {
          id: doc.id,
          title: doc.title,
          text: doc.text
        },
        content: [
          {
            type: "text",
            text: `Fetched "${doc.title}".`
          }
        ]
      };
    }
  );

  return server;
}

const httpServer = createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400).end("Missing URL");
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "OPTIONS" && url.pathname === MCP_PATH) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "content-type, mcp-session-id, authorization",
      "Access-Control-Expose-Headers": "Mcp-Session-Id"
    });
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("general-mcp-server is running");
    return;
  }

  const allowedMethods = new Set(["POST", "GET", "DELETE"]);

  if (url.pathname === MCP_PATH && req.method && allowedMethods.has(req.method)) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

    const server = createMcpApp();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode
      enableJsonResponse: true
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.writeHead(500).end("Internal server error");
      }
    }

    return;
  }

  res.writeHead(404).end("Not Found");
});

httpServer.listen(PORT, () => {
  console.log(`MCP server listening on http://localhost:${PORT}${MCP_PATH}`);
});