/**
 * The additive-response policy of `docs/openapi/openapi.yaml`, as test helpers.
 *
 * Published server-sent schemas are open: integrators must ignore unknown keys.
 * Each one carries `x-smscode-tested-closed: true`, and our own payloads,
 * examples and fixtures are validated against the strict view, which reads
 * that marker as `additionalProperties: false`. Nothing else is closed by the
 * view, so `allOf` envelope branches stay exactly as open as published.
 */

export const TESTED_CLOSED = "x-smscode-tested-closed";

type Json = unknown;

/** A deep clone of `doc` in which every marker-carrying object node is closed. */
export function strictView(doc: Record<string, unknown>): Record<string, unknown> {
  const close = (node: Json): Json => {
    if (Array.isArray(node)) return node.map(close);
    if (node === null || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) out[key] = close(value);
    if (out[TESTED_CLOSED] === true) out.additionalProperties = false;
    return out;
  };
  return close(doc) as Record<string, unknown>;
}

/** The client-sent request bodies: the only schemas that stay closed. */
export const CLOSED_REQUEST_SCHEMAS = [
  "V1CreateOrderRequest",
  "V2CreateOrderRequest",
  "V1ReactivateRequest",
  "V2ReactivateRequest",
  "V1OrderIdRequest",
  "UpdateWebhookBody",
] as const;

/** Server-sent object nodes that are deliberately open maps. */
const OPEN_MAPS = new Set([
  "#/components/schemas/Meta",
  "#/components/schemas/ErrorObject/properties/details",
]);
const ENVELOPE = "#/components/schemas/SuccessEnvelope";
const ENVELOPE_KEYS = new Set(["data", "meta"]);
/** Schema-bearing keywords the walk does not follow: any of them fails closed. */
const UNSUPPORTED = [
  "patternProperties",
  "unevaluatedProperties",
  "propertyNames",
  "dependentSchemas",
  "prefixItems",
  "contains",
  "unevaluatedItems",
  "not",
  "if",
  "then",
  "else",
  "$dynamicRef",
  "$recursiveRef",
  // A cap on properties forbids the additive fields the policy promises.
  "maxProperties",
  // An embedded schema the walk would not see.
  "contentSchema",
  // A key-dependent rule can reject an additive key that arrives without its companion.
  "dependentRequired",
  // Keywords that change how a $ref resolves or which dialect applies.
  "$id",
  "$anchor",
  "$dynamicAnchor",
  "$recursiveAnchor",
  "$schema",
  "$vocabulary",
  // Earlier-draft schema-bearing keywords a validator for that draft would apply.
  "dependencies",
  "additionalItems",
  // A discriminator mapping can name schemas the walk never reaches.
  "discriminator",
];
/** Every OpenAPI operation method, so no response or request body escapes the walk. */
const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
/**
 * The members OpenAPI 3.1 defines on each object the walk reads. A member outside
 * its list (an `encoding` with part headers, an OpenAPI 3.2 `query` operation, a
 * Swagger 2.0 `schema` on a response) is one the walk would not read, so it fails;
 * vendor `x-` extensions are inert.
 */
const MEMBERS = {
  reference: ["$ref", "summary", "description"],
  "path item": ["$ref", "summary", "description", "servers", "parameters", ...METHODS],
  operation: [
    "tags",
    "summary",
    "description",
    "externalDocs",
    "operationId",
    "parameters",
    "requestBody",
    "responses",
    "callbacks",
    "deprecated",
    "security",
    "servers",
  ],
  "request body": ["description", "content", "required"],
  response: ["description", "headers", "content", "links"],
  "media type": ["schema", "example", "examples"],
  header: [
    "description",
    "required",
    "deprecated",
    "allowEmptyValue",
    "style",
    "explode",
    "allowReserved",
    "schema",
    "example",
    "examples",
    "content",
  ],
  parameter: [
    "name",
    "in",
    "description",
    "required",
    "deprecated",
    "allowEmptyValue",
    "style",
    "explode",
    "allowReserved",
    "schema",
    "example",
    "examples",
    "content",
  ],
} as const;
/** Keywords that may sit beside a $ref without constraining it. */
const REF_ANNOTATIONS = new Set([
  "$ref",
  "$comment",
  "title",
  "summary",
  "description",
  "default",
  "deprecated",
  "readOnly",
  "writeOnly",
  "example",
  "examples",
]);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
/** True when `v` is, or nests, a JSON object: a literal that would pin an object's exact keys. */
const holdsObject = (v: unknown): boolean => isObj(v) || (Array.isArray(v) && v.some(holdsObject));
const esc = (t: string): string => t.replace(/~/g, "~0").replace(/\//g, "~1");

export interface PolicyCounts {
  marked: number;
  envelopeBranches: number;
  envelope: number;
  openMaps: number;
}

function walkPolicy(doc: Obj): { counts: PolicyCounts; violations: string[]; reached: Set<string> } {
  const counts: PolicyCounts = { marked: 0, envelopeBranches: 0, envelope: 0, openMaps: 0 };
  const violations: string[] = [];
  const reached = new Set<string>();
  const components = (isObj(doc.components) ? doc.components : {}) as Obj;
  const schemas = (isObj(components.schemas) ? components.schemas : {}) as Obj;
  const responses = (isObj(components.responses) ? components.responses : {}) as Obj;
  const requestBodies = (isObj(components.requestBodies) ? components.requestBodies : {}) as Obj;
  const parameters = (isObj(components.parameters) ? components.parameters : {}) as Obj;

  // Shared responses being followed right now: meeting one again is a cycle.
  const followingResponses = new Set<string>();

  const checkMembers = (node: Obj, kind: keyof typeof MEMBERS, pointer: string): void => {
    const known: readonly string[] = MEMBERS[kind];
    for (const key of Object.keys(node)) {
      if (!key.startsWith("x-") && !known.includes(key)) violations.push(`${pointer}: unsupported ${kind} member ${key}`);
    }
  };

  // A schema position may only $ref a schema, and a response position a response.
  const followSchemaRef = (ref: string, pointer: string): void => {
    if (!ref.startsWith("#/components/schemas/")) {
      violations.push(`${pointer}: unsupported $ref ${ref}`);
      return;
    }
    const name = ref.slice("#/components/schemas/".length);
    if (reached.has(ref)) return;
    if (!(name in schemas)) {
      violations.push(`${pointer}: unresolved $ref ${ref}`);
      return;
    }
    visit(schemas[name], ref, false);
  };

  const followResponseRef = (ref: string, pointer: string): void => {
    if (!ref.startsWith("#/components/responses/")) {
      violations.push(`${pointer}: unsupported response $ref ${ref}`);
      return;
    }
    const name = ref.slice("#/components/responses/".length);
    if (!(name in responses)) {
      violations.push(`${pointer}: unresolved $ref ${ref}`);
    } else if (followingResponses.has(ref)) {
      violations.push(`${pointer}: cyclic response $ref ${ref}`);
    } else if (!reached.has(ref)) {
      followingResponses.add(ref);
      visitMedia(responses[name], ref, "response");
      followingResponses.delete(ref);
      reached.add(ref);
    }
  };

  const visit = (node: unknown, pointer: string, envelopeBranch: boolean): void => {
    if (!isObj(node)) {
      // A boolean schema is valid JSON Schema; anything else the walk cannot read.
      if (typeof node !== "boolean") violations.push(`${pointer}: malformed schema`);
      return;
    }
    if ("$ref" in node && typeof node.$ref !== "string") {
      violations.push(`${pointer}: malformed $ref`);
      return;
    }
    if (typeof node.$ref === "string") {
      followSchemaRef(node.$ref, pointer);
      // OpenAPI 3.1 applies a $ref's sibling keywords as well, so walk them here.
      const siblings = Object.keys(node).filter((key) => !REF_ANNOTATIONS.has(key) && !key.startsWith("x-"));
      if (siblings.length === 0) return;
    }
    if (reached.has(pointer)) return;
    reached.add(pointer);
    for (const keyword of UNSUPPORTED) {
      if (keyword in node) violations.push(`${pointer}: unsupported keyword ${keyword}`);
    }
    if (holdsObject(node.const) || (Array.isArray(node.enum) && node.enum.some(holdsObject))) {
      violations.push(`${pointer}: object-valued const or enum pins an exact object`);
    }
    const type = node.type;
    const objectShaped =
      type === "object" ||
      (Array.isArray(type) && type.includes("object")) ||
      "properties" in node ||
      "additionalProperties" in node ||
      "patternProperties" in node ||
      "required" in node ||
      "minProperties" in node;
    if (objectShaped) {
      const keys = isObj(node.properties) ? Object.keys(node.properties) : [];
      if (node[TESTED_CLOSED] === true) counts.marked += 1;
      else if (envelopeBranch && keys.length > 0 && keys.every((k) => ENVELOPE_KEYS.has(k)))
        counts.envelopeBranches += 1;
      else if (pointer === ENVELOPE) counts.envelope += 1;
      else if (OPEN_MAPS.has(pointer) && node.additionalProperties === true && !("properties" in node))
        counts.openMaps += 1;
      else violations.push(`${pointer}: unclassified object-shaped server-sent node`);
    }
    for (const applicator of ["allOf", "oneOf", "anyOf"]) {
      const members = node[applicator];
      if (!Array.isArray(members)) {
        if (applicator in node) violations.push(`${pointer}: malformed ${applicator}`);
        continue;
      }
      const besideEnvelope =
        applicator === "allOf" && members.some((m) => isObj(m) && m.$ref === ENVELOPE);
      members.forEach((member, i) =>
        visit(member, `${pointer}/${applicator}/${i}`, besideEnvelope && isObj(member) && !("$ref" in member)),
      );
    }
    if (isObj(node.properties)) {
      for (const [key, value] of Object.entries(node.properties)) visit(value, `${pointer}/properties/${esc(key)}`, false);
    } else if ("properties" in node) {
      violations.push(`${pointer}: malformed properties`);
    }
    for (const keyword of ["items", "additionalProperties"]) {
      const value = node[keyword];
      if (isObj(value)) visit(value, `${pointer}/${keyword}`, false);
      else if (keyword in node && typeof value !== "boolean") violations.push(`${pointer}: malformed ${keyword}`);
    }
  };

  // A client-sent body must be exactly a $ref to one of the closed request schemas;
  // a shared #/components/requestBodies entry is followed until it reaches one.
  const visitRequestBody = (body: unknown, pointer: string, following: ReadonlySet<string> = new Set()): void => {
    if (isObj(body) && "$ref" in body) {
      checkMembers(body, "reference", pointer);
      const ref = body.$ref;
      if (typeof ref !== "string") {
        violations.push(`${pointer}: malformed request body $ref`);
        return;
      }
      const name = ref.startsWith("#/components/requestBodies/")
        ? ref.slice("#/components/requestBodies/".length)
        : null;
      if (name === null || !(name in requestBodies)) {
        violations.push(`${pointer}: unsupported request body $ref ${ref}`);
      } else if (following.has(ref)) {
        violations.push(`${pointer}: cyclic request body $ref ${ref}`);
      } else {
        visitRequestBody(requestBodies[name], ref, new Set([...following, ref]));
      }
      return;
    }
    if (!isObj(body) || !isObj(body.content) || Object.keys(body.content).length === 0) {
      violations.push(`${pointer}: request body must $ref a closed request schema`);
      return;
    }
    checkMembers(body, "request body", pointer);
    for (const [type, media] of Object.entries(body.content)) {
      if (isObj(media)) checkMembers(media, "media type", `${pointer}/content/${esc(type)}`);
      const schema = isObj(media) ? media.schema : undefined;
      const closed =
        isObj(schema) &&
        Object.keys(schema).length === 1 &&
        CLOSED_REQUEST_SCHEMAS.some((name) => schema.$ref === `#/components/schemas/${name}`);
      if (!closed) {
        violations.push(`${pointer}/content/${esc(type)}/schema: request body must $ref a closed request schema`);
      }
    }
  };

  // A response (or webhook body) is a $ref, a body-less response, or content whose
  // every media type carries a schema; anything the walk cannot read fails. Only a
  // response may be a $ref (to a shared response); a webhook body is inline.
  const visitMedia = (holder: unknown, pointer: string, kind: "response" | "webhook body"): void => {
    if (holder === undefined) return;
    if (!isObj(holder)) {
      violations.push(`${pointer}: malformed ${kind}`);
      return;
    }
    if ("$ref" in holder) {
      checkMembers(holder, "reference", pointer);
      if (typeof holder.$ref !== "string") violations.push(`${pointer}: malformed ${kind} $ref`);
      else if (kind === "response") followResponseRef(holder.$ref, pointer);
      else violations.push(`${pointer}: unsupported ${kind} $ref ${holder.$ref}`);
      return;
    }
    checkMembers(holder, kind === "response" ? "response" : "request body", pointer);
    if (kind === "response" && "headers" in holder) visitHeaders(holder.headers, `${pointer}/headers`);
    if (!("content" in holder)) return;
    if (!isObj(holder.content)) {
      violations.push(`${pointer}: malformed ${kind} content`);
      return;
    }
    for (const [type, media] of Object.entries(holder.content)) {
      const at = `${pointer}/content/${esc(type)}`;
      if (isObj(media)) checkMembers(media, "media type", at);
      if (isObj(media) && isObj(media.schema)) visit(media.schema, `${at}/schema`, false);
      else violations.push(`${at}: media type without a schema`);
    }
  };

  // Response headers are server-sent too: each one is walked through its schema.
  const visitHeaders = (headers: unknown, pointer: string): void => {
    if (!isObj(headers)) {
      violations.push(`${pointer}: malformed headers`);
      return;
    }
    for (const [name, header] of Object.entries(headers)) {
      const at = `${pointer}/${esc(name)}`;
      if (!isObj(header)) violations.push(`${at}: malformed header`);
      else if ("$ref" in header) violations.push(`${at}: unsupported header $ref ${String(header.$ref)}`);
      else {
        checkMembers(header, "header", at);
        if ("content" in header) violations.push(`${at}: unsupported header content`);
        else if ("schema" in header) visit(header.schema, `${at}/schema`, false);
      }
    }
  };

  // A webhook's parameters are headers we send: each one is walked through its schema.
  const visitParameters = (list: unknown, pointer: string): void => {
    if (!Array.isArray(list)) {
      violations.push(`${pointer}: malformed parameters`);
      return;
    }
    list.forEach((entry, index) => {
      let at = `${pointer}/${index}`;
      let parameter: unknown = entry;
      if (isObj(entry) && "$ref" in entry) {
        checkMembers(entry, "reference", at);
        const ref = entry.$ref;
        const name =
          typeof ref === "string" && ref.startsWith("#/components/parameters/")
            ? ref.slice("#/components/parameters/".length)
            : null;
        if (name === null || !(name in parameters)) {
          violations.push(`${at}: unsupported parameter $ref ${String(ref)}`);
          return;
        }
        at = ref as string;
        parameter = parameters[name];
      }
      if (!isObj(parameter) || "$ref" in parameter) violations.push(`${at}: malformed parameter`);
      else {
        checkMembers(parameter, "parameter", at);
        if ("content" in parameter) violations.push(`${at}: unsupported parameter content`);
        else if ("schema" in parameter) visit(parameter.schema, `${at}/schema`, false);
      }
    });
  };

  // Every container the walk iterates must be readable; one it cannot read fails.
  for (const [path, item] of Object.entries((isObj(doc.paths) ? doc.paths : {}) as Obj)) {
    const at = `#/paths/${esc(path)}`;
    if (!isObj(item)) {
      violations.push(`${at}: malformed path item`);
      continue;
    }
    if ("$ref" in item) violations.push(`${at}: unsupported path item $ref`);
    checkMembers(item, "path item", at);
    for (const method of METHODS) {
      if (!(method in item)) continue;
      const op = item[method];
      if (!isObj(op)) {
        violations.push(`${at}/${method}: malformed operation`);
        continue;
      }
      checkMembers(op, "operation", `${at}/${method}`);
      // Callbacks are server-sent requests this walk does not read.
      if ("callbacks" in op) violations.push(`${at}/${method}: unsupported callbacks`);
      if ("requestBody" in op) visitRequestBody(op.requestBody, `${at}/${method}/requestBody`);
      if (!("responses" in op)) continue;
      if (!isObj(op.responses)) {
        violations.push(`${at}/${method}: malformed responses`);
        continue;
      }
      for (const [status, response] of Object.entries(op.responses)) {
        visitMedia(response, `${at}/${method}/responses/${esc(status)}`, "response");
      }
    }
  }
  for (const [name, response] of Object.entries(responses)) visitMedia(response, `#/components/responses/${esc(name)}`, "response");
  for (const [name, item] of Object.entries((isObj(doc.webhooks) ? doc.webhooks : {}) as Obj)) {
    const at = `#/webhooks/${esc(name)}`;
    if (!isObj(item)) {
      violations.push(`${at}: malformed webhook path item`);
      continue;
    }
    if ("$ref" in item) violations.push(`${at}: unsupported webhook path item $ref`);
    checkMembers(item, "path item", at);
    if ("parameters" in item) visitParameters(item.parameters, `${at}/parameters`);
    for (const method of METHODS) {
      if (!(method in item)) continue;
      const op = item[method];
      if (!isObj(op)) {
        violations.push(`${at}/${method}: malformed operation`);
        continue;
      }
      checkMembers(op, "operation", `${at}/${method}`);
      if ("callbacks" in op) violations.push(`${at}/${method}: unsupported callbacks`);
      if ("parameters" in op) visitParameters(op.parameters, `${at}/${method}/parameters`);
      visitMedia(op.requestBody, `${at}/${method}/requestBody`, "webhook body");
    }
  }
  return { counts, violations, reached };
}

/** Per-class totals of the object-shaped server-sent nodes the walk reaches. */
export function policyCounts(doc: Record<string, unknown>): PolicyCounts {
  return walkPolicy(doc).counts;
}

/**
 * Every way `doc` breaks the additive-response policy, one line each.
 * Empty means: every server-sent schema the walk reaches (response bodies and
 * headers, webhook bodies and header parameters) is classified, nothing it
 * cannot read is present (callbacks, foreign or malformed refs, malformed
 * containers, members OpenAPI 3.1 does not define on the objects it reads),
 * exactly the 6 request schemas are closed, every operation's
 * request body is a $ref to one of them, and the marker sits only on
 * server-sent nodes.
 */
export function policyViolations(doc: Record<string, unknown>): string[] {
  const { violations, reached } = walkPolicy(doc);
  const requestPointers = new Set(CLOSED_REQUEST_SCHEMAS.map((n) => `#/components/schemas/${n}`));
  const deep = (node: unknown, pointer: string): void => {
    if (Array.isArray(node)) {
      node.forEach((child, i) => deep(child, `${pointer}/${i}`));
      return;
    }
    if (!isObj(node)) return;
    if (node.additionalProperties === false && !requestPointers.has(pointer))
      violations.push(`${pointer}: additionalProperties false outside the request schemas`);
    if (node[TESTED_CLOSED] === true && !reached.has(pointer))
      violations.push(`${pointer}: tested-closed marker on a node no response or webhook reaches`);
    for (const [key, value] of Object.entries(node)) deep(value, `${pointer}/${esc(key)}`);
  };
  deep(doc, "#");
  const schemas = ((doc.components as Obj | undefined)?.schemas ?? {}) as Obj;
  for (const name of CLOSED_REQUEST_SCHEMAS) {
    const schema = schemas[name];
    if (!isObj(schema) || schema.additionalProperties !== false)
      violations.push(`#/components/schemas/${name}: request schema must stay additionalProperties false`);
    if (isObj(schema) && schema[TESTED_CLOSED] === true)
      violations.push(`#/components/schemas/${name}: request schema carries the tested-closed marker`);
  }
  return violations;
}
