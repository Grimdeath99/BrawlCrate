import { z } from 'zod';

const documentId = z.string().min(1).max(64).describe('Opaque document handle returned by open_document, owned by this server session.');
const nodeId = z.string().max(256).regex(/^(root|[0-9]+(?:\/[0-9]+)*)$/).default('root')
  .describe('Stable index path returned by list_children, or root.');
const integer = z.number().int().min(0).max(2147483647);
const revision = integer.describe('Current document revision returned by the last successful read or edit.');
const operationId = z.string().min(1).max(128).describe('Unique operation ID. Reuse only for an exact retry of the same mutation in this session.');
const relativePath = z.string().min(1).max(240).describe('Path relative to the configured root. Absolute paths, traversal and reparse points are rejected.');
const page = {
  offset: integer.default(0),
  limit: z.number().int().min(1).max(200).default(50)
};
const mutation = { expected_revision: revision, operation_id: operationId };
const plainMessage = z.string().max(512)
  .regex(/^[^<\[\\\x00-\x09\x0B\x0C\x0E-\x1F\x7F-\x9F]*$/, 'Only plain text is supported; markup, escapes and controls except CR/LF are prohibited.')
  .refine(text => Buffer.byteLength(text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'), 'utf8') <= 512,
    'Message must fit in 512 UTF-8 bytes after LF normalization for the binary format.')
  .describe('Plain message text, at most 512 UTF-8 bytes with LF line endings in the binary. No markup, backslashes or control characters except CR/LF. The final message cannot be empty.');

export const outputSchema = z.strictObject({ data: z.record(z.string(), z.unknown()) });
const outputJsonSchema = z.toJSONSchema(outputSchema, { target: 'draft-7' });
const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const editAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

function tool(name, description, input, annotations) {
  const schema = z.strictObject(input);
  return {
    schema,
    definition: { name, description, inputSchema: z.toJSONSchema(schema, { target: 'draft-7' }), outputSchema: outputJsonSchema, annotations }
  };
}

export const tools = new Map([
  tool('get_status', 'Read the authoritative headless BrawlCrate session status, launch permissions, limits and open documents. This session is separate from any GUI window.', {}, readAnnotations),
  tool('open_document', 'Open a supported ARC/MSBin file under the configured root using BrawlLib. Returns a session document handle and revision. Supports uncompressed ARC trees containing ARC or plain-text MSBin only. Does not attach to a GUI document.', {
    path: relativePath, format: z.enum(['auto', 'arc', 'msbin']).default('auto')
  }, { ...readAnnotations, readOnlyHint: false, idempotentHint: false }),
  tool('get_document', 'Read current document metadata and revision from its actual in-memory BrawlLib document.', { document_id: documentId }, readAnnotations),
  tool('list_children', 'Read a bounded page of immediate children and their stable node IDs from an open document.', {
    document_id: documentId, node_id: nodeId, ...page
  }, readAnnotations),
  tool('read_messages', 'Read a bounded page of actual strings from an MSBin node. Rejects other node types.', {
    document_id: documentId, node_id: nodeId, ...page
  }, readAnnotations),
  tool('rename_node', 'Rename an ARC node in memory. Requires --allow-write and the current revision. Does not save the source file; use export_document to persist a new file.', {
    document_id: documentId, node_id: nodeId, name: z.string().min(1).max(47).regex(/^[\x20-\x7E]+$/), ...mutation
  }, editAnnotations),
  tool('set_message', 'Replace one existing MSBin message in memory using BrawlLib. Requires --allow-write and the current revision. Does not save the source file; use export_document to persist a new file.', {
    document_id: documentId, node_id: nodeId, index: integer, text: plainMessage, ...mutation
  }, editAnnotations),
  tool('export_document', 'Rebuild and export the entire native document to a NEW file under the root using BrawlLib. Requires --allow-write and the current revision. Existing files are never overwritten. Retry only with the identical operation ID and arguments.', {
    document_id: documentId, path: relativePath, ...mutation
  }, { ...editAnnotations, destructiveHint: false }),
  tool('close_document', 'Dispose this session document and its memory maps. Dirty documents require explicit discard_changes=true. Requires the current revision; allowed in read-only sessions. Cannot be undone.', {
    document_id: documentId, discard_changes: z.boolean().default(false), ...mutation
  }, editAnnotations)
].map(entry => [entry.definition.name, entry]));

export const promptArguments = z.strictObject({ path: relativePath });

export function validateOutput(result) {
  const wrapped = outputSchema.parse({ data: result });
  const text = JSON.stringify(wrapped);
  if (Buffer.byteLength(text, 'utf8') > 384 * 1024) {
    throw new Error('Application result exceeded the 384 KiB result limit. Request a smaller page.');
  }
  return { content: [{ type: 'text', text }], structuredContent: wrapped, isError: false };
}

export function toolFailure(code, message) {
  return { content: [{ type: 'text', text: JSON.stringify({ error: {
    code: String(code).slice(0, 128), message: String(message).slice(0, 4096)
  } }) }], isError: true };
}
