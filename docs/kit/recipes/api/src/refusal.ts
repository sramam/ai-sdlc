// Refusals are returned, never thrown (tech-stack.md § The architecture shape).
// A throw is a defect; a refusal is an answer the binding renders.
//
// | code        | means                                                        |
// | ----------- | ------------------------------------------------------------ |
// | INVALID     | the input is wrong; `field` names where, so a form puts it there |
// | FORBIDDEN   | the policy says no (your role)                               |
// | NOT_FOUND   | no such row in your tenant (also: one you may not know exists) |
// | CONFLICT    | the world says no: a duplicate, a state that forbids it      |
// | UNAVAILABLE | could not ask (the policy engine, a vendor); refused, not allowed |
export type RefusalCode = "INVALID" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "UNAVAILABLE";

export type Refusal = {
  ok: false;
  code: RefusalCode;
  /** One sentence, in the user's words. No internal ids or field keys beyond `field`. */
  detail: string;
  /** The input path the refusal belongs on (`name`, `lines.2.amount`), for forms. */
  field?: string;
};

export const refuse = (code: RefusalCode, detail: string, field?: string): Refusal =>
  field === undefined ? { ok: false, code, detail } : { ok: false, code, detail, field };

export const isRefusal = (v: unknown): v is Refusal =>
  typeof v === "object" && v !== null && (v as { ok?: unknown }).ok === false;
