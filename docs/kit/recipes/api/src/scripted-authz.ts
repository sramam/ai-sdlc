// For the port's own contract suite: an `Authz` whose answers the test states.
// It is not a policy (the matrix lives in authz-oso / authz-spicedb); it lets the
// suite prove what the PORT does with each answer: allowed, refused, could-not-ask,
// and a list filter in either shape.
import type { Authz, Decision, ListFilter, AuthzRefusal } from "./authz";

export function scriptedAuthz(answers: {
  authorize?: Decision;
  listFilter?: ListFilter | AuthzRefusal;
}): Authz & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async authorize(_c, action, r) {
      asked.push(`${action} ${r.type}:${r.id}`);
      return answers.authorize ?? { ok: true };
    },
    async listFilter(_c, action, type) {
      asked.push(`${action} ${type}`);
      return answers.listFilter ?? { ok: false, code: "FORBIDDEN", detail: "no filter scripted" };
    },
  };
}
