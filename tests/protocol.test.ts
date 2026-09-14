import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
test("real stdio MCP process discovers all tools and isolates local drafting from publication", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "publisher-mcp-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../src/server.js", import.meta.url))],
    env: { ...process.env, PUBLISHER_COMMUNITY_HOME: root } as Record<
      string,
      string
    >,
    stderr: "pipe",
  });
  const client = new Client({ name: "publisher-smoke", version: "1.0.0" });
  t.after(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });
  await client.connect(transport);
  const list = await client.listTools();
  assert.ok(list.tools.length >= 30);
  assert.equal(
    list.tools.find((t) => t.name === "publish_draft")?.annotations
      ?.destructiveHint,
    true,
  );
  const status = await client.callTool({
    name: "check_capabilities",
    arguments: {},
  });
  assert.match(JSON.stringify(status), /configured/);
  const draft = await client.callTool({
    name: "prepare_draft",
    arguments: {
      connectionId: "personal",
      author: "urn:li:person:mock",
      text: "Protocol test draft; never publish.",
      attachments: [],
    },
  });
  assert.equal(draft.isError, undefined);
  const d = JSON.parse((draft.content as any)[0].text);
  assert.equal(d.state, "draft");
  const publish = await client.callTool({
    name: "publish_draft",
    arguments: {
      draftId: d.id,
      reviewDigest: d.reviewDigest,
      authorization: "Test fixture",
    },
  });
  assert.equal(publish.isError, true);
  assert.match(JSON.stringify(publish), /NOT_CONNECTED/);
});
