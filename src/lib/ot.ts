import type { TextOp } from "@/lib/types";

/**
 * Shared operational-transform helpers ("OT-lite").
 *
 * Insert/delete operations over a flat string with position transformation.
 * Both the server room engine and the browser client use these exact
 * functions so concurrent edits converge to identical buffers on every peer.
 *
 * Guarantees:
 *  - transformOffset is monotonic
 *  - transformOp returns null when an op is swallowed by a wider concurrent
 *    delete (its intent is preserved — nothing to apply)
 */

export function transformOffset(offset: number, against: TextOp): number {
  if (against.type === "insert") {
    // Inserts at exactly the same offset resolve deterministically by
    // arrival order (the already-applied op wins the position).
    return offset > against.offset ? offset + against.text.length : offset;
  }
  const end = against.offset + against.length;
  if (offset >= end) return offset - against.length;
  if (offset > against.offset) return against.offset; // clamp into deleted span
  return offset;
}

export function transformOp(op: TextOp, against: TextOp): TextOp | null {
  if (op.type === "insert") {
    return { ...op, offset: transformOffset(op.offset, against) };
  }
  const start = transformOffset(op.offset, against);
  const end = transformOffset(op.offset + op.length, against);
  if (end <= start) return null; // swallowed by a wider concurrent delete
  return { type: "delete", offset: start, length: end - start };
}

export function applyOp(content: string, op: TextOp): string {
  if (op.type === "insert") {
    return content.slice(0, op.offset) + op.text + content.slice(op.offset);
  }
  return content.slice(0, op.offset) + content.slice(op.offset + op.length);
}

/**
 * Rebase an ordered, already-sequential edit script over operations that were
 * applied after the script's base revision.
 *
 * `ops` entries are NOT transformed against earlier entries in `ops`: their
 * offsets already include the effects of previous entries in the same script.
 * This is the wire semantic used by OperationBatch.ops.
 */
export function rebaseSequentialOps(ops: TextOp[], against: TextOp[]): TextOp[] {
  const out: TextOp[] = [];
  for (const original of ops) {
    let op: TextOp | null = original;
    for (const past of against) op = op ? transformOp(op, past) : null;
    if (op) out.push(op);
  }
  return out;
}

/**
 * Transform a same-base operation set into sequential application order.
 *
 * This helper self-transforms later entries against earlier transformed output
 * entries. Do not use it for OperationBatch.ops, which are already sequential.
 */
export function transformBatch(ops: TextOp[], against: TextOp[]): TextOp[] {
  const out: TextOp[] = [];
  for (const original of ops) {
    let op: TextOp | null = original;
    for (const past of against) op = op ? transformOp(op, past) : null;
    for (const done of out) op = op ? transformOp(op, done) : null;
    if (op) out.push(op);
  }
  return out;
}
