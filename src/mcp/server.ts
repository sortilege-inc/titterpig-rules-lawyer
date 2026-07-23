import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./build.js";

const server = buildServer();
const transport = new StdioServerTransport();
await server.connect(transport);
