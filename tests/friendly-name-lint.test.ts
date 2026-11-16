// @vitest-environment node
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { ESLint } from "eslint";

// Home Assistant is retiring the `friendly_name` state attribute, and the lint
// rule in eslint.config.js is what keeps a read of it out of `src/`. `npm run
// lint` only shows that `src/` is clean today; these show the rule fires for
// each way the attribute's name can be written out.

const eslint = new ESLint({ cwd: fileURLToPath(new URL("..", import.meta.url)) });
const STATE = "declare const state: { attributes: Record<string, unknown> };";

/** How many times the rule rejects `code`, linted as a file under `src/`. */
async function rejections(code: string): Promise<number> {
  const [result] = await eslint.lintText(`${STATE}\n${code}\n`, { filePath: "src/friendly-name-probe.ts" });
  if (!result) throw new Error("the probe was not linted");
  return result.messages.filter(message => message.ruleId === "no-restricted-syntax" && message.message.includes("friendly_name")).length;
}

describe("the friendly_name lint rule", () => {
  it.each([
    ["a property access", "export const name = state.attributes.friendly_name;"],
    ["an optional property access", "export const name = state.attributes?.friendly_name;"],
    ["a quoted key", 'export const name = state.attributes["friendly_name"];'],
    ["a template literal key", "export const name = state.attributes[`friendly_name`];"],
    ["an `in` test", 'export const named = "friendly_name" in state.attributes;'],
    ["destructuring", "const { friendly_name } = state.attributes;\nexport const name = friendly_name;"],
    ["destructuring under a new name", "const { friendly_name: label } = state.attributes;\nexport const name = label;"],
    ["destructuring with a default", 'const { friendly_name = "" } = state.attributes;\nexport const name = friendly_name;'],
    ["nested destructuring", "const {\n  attributes: { friendly_name },\n} = state;\nexport const name = friendly_name;"],
    ["a destructured parameter", "export function nameOf({ friendly_name }: Record<string, unknown>): unknown {\n  return friendly_name;\n}"],
    ["destructuring by a quoted key", 'const { "friendly_name": label } = state.attributes;\nexport const name = label;'],
    ["destructuring by a template literal key", "const { [`friendly_name`]: label } = state.attributes;\nexport const name = label;"],
    ["a key of an object literal", 'export const attributes = { friendly_name: "Kitchen" };'],
  ])("rejects %s", async (_form, code) => {
    expect(await rejections(code)).toBe(1);
  });

  it.each([
    ["another attribute", "export const volts = state.attributes.voltage;"],
    ["another attribute, destructured", "const { voltage } = state.attributes;\nexport const volts = voltage;"],
  ])("leaves %s alone", async (_form, code) => {
    expect(await rejections(code)).toBe(0);
  });

  // A name that is never written out is beyond a syntax rule: these read the attribute and pass.
  it.each([
    ["a key put together at run time", 'export const name = state.attributes["friendly_" + "name"];'],
    ["a key held in a variable", "declare const key: string;\nexport const name = state.attributes[key];"],
    ["every attribute at once", "export const values = Object.values({ ...state.attributes });"],
  ])("cannot see %s", async (_form, code) => {
    expect(await rejections(code)).toBe(0);
  });
});
