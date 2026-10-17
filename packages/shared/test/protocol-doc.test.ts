import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  stageClientMessageSchema,
  stageServerMessageSchema,
  STUDIO_SERVER_MESSAGE_TYPES,
  studioCommandSchema,
} from "../src";

/** docs/protocol.md must describe every message type the schemas define. */
const doc = readFileSync(path.join(import.meta.dir, "../../../docs/protocol.md"), "utf8");

/** The text of a `### ` section, up to the next `## ` or `### ` heading. */
function section(title: string): string {
  const start = doc.indexOf(`\n### ${title}\n`);
  if (start < 0) throw new Error(`docs/protocol.md has no "### ${title}" section`);
  const rest = doc.slice(start + title.length + 6);
  const end = rest.search(/\n#{2,3} /);
  return end < 0 ? rest : rest.slice(0, end);
}

function documented(text: string, level: string): string[] {
  return [...text.matchAll(new RegExp(`^${level} \`([a-z_-]+)\`$`, "gm"))].map((match) => match[1] as string);
}

const discriminators = (schema: { options: readonly { shape: object }[] }, key: "t" | "kind") =>
  schema.options.map((option) => (option.shape as Record<string, { value: string }>)[key]!.value).sort();

describe("docs/protocol.md", () => {
  it("documents every server-to-stage message", () => {
    expect(documented(section("Server to stage"), "####").sort()).toEqual(discriminators(stageServerMessageSchema, "t"));
  });

  it("documents every stage-to-server message", () => {
    expect(documented(section("Stage to server"), "####").sort()).toEqual(discriminators(stageClientMessageSchema, "t"));
  });

  it("documents every server-to-studio message", () => {
    expect(documented(section("Server to studio"), "####").sort()).toEqual([...STUDIO_SERVER_MESSAGE_TYPES].sort());
  });

  it("documents every studio command", () => {
    expect(documented(section("Studio to server"), "#####").sort()).toEqual(discriminators(studioCommandSchema, "kind"));
  });
});
