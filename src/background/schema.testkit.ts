// ---------------------------------------------------------------------------
// TEST ONLY. Never import this from anything under entrypoints/ — it pulls in
// GitHub's entire published schema (several MB) and would land in the bundle.
//
// Every query the extension can compose is checked against the real schema in
// schema.test.ts. The defect that motivated this: `PullRequestCommit` exposes
// no `createdAt` and no `actor`, so receipt extraction silently dropped every
// push and reported "never responded" for authors who had. A hand-written type
// asserted otherwise and nothing in the build disagreed with it. §10.3
// ---------------------------------------------------------------------------

import { schema } from '@octokit/graphql-schema';
import { buildSchema, type GraphQLSchema, parse, validate } from 'graphql';

let cached: GraphQLSchema | null = null;

export function githubSchema(): GraphQLSchema {
  // assumeValidSDL because the published dump has a genuine defect
  // (EnterpriseOwnerInfo declares two fields twice) in a type we never touch.
  // We are validating our queries against the schema, not the schema itself.
  if (!cached) cached = buildSchema(schema.idl, { assumeValidSDL: true });
  return cached;
}

/** Every validation error, as readable strings. Empty means the query is legal. */
export function schemaErrors(query: string): string[] {
  let doc: ReturnType<typeof parse>;
  try {
    doc = parse(query);
  } catch (e) {
    return [`syntax: ${(e as Error).message}`];
  }
  return validate(githubSchema(), doc).map((e) => e.message);
}

/**
 * Does `type` really expose `field`? Pins assumptions made by hand-written
 * extraction code to the schema rather than to memory.
 */
export function hasField(type: string, field: string): boolean {
  const t = githubSchema().getType(type);
  if (!t || !('getFields' in t)) return false;
  return field in (t as { getFields(): Record<string, unknown> }).getFields();
}
