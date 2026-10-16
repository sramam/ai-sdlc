# Discovering personas and tenancy

The interview `/kickoff` stage 2 runs for BRD themes 2 and 5
([product.md](product.md)). What the documents then declare is in
`docs/kit/plan-and-requirements.md` § _Personas are discovered, not assumed_
and § _Tenancy and access are discovered, not assumed_.

## Personas

**Where candidates come from** (check every source; each tends to miss someone):
every actor named in a requirement; the author's answers to who uses it, who
pays for it and who would complain if it broke; every distinct role the
permission model allows or refuses something; whoever _receives_ an email,
report, invoice, notification or export; whoever configures, onboards others or
administers it; the product's own support and operations staff; and people with
no account (a visitor, an invitee, someone signing up).

External systems (a payment provider, a scheduler, a webhook) are actors, not
personas. Name them `system:<name>` in requirements and keep them out of the
registry.

**When are two candidates one persona?** Split them when they differ in goals,
permissions, or the journeys they walk. Merge them when they differ only in
job title.

**The registry grows by finding, not by assumption.** When `/kickoff` or
`/spec` meets a request whose actor is not in `personas.md`, that is a finding.
Either the request maps to an existing persona, or a new one is added through
`/kickoff revisit product`.

## Tenancy

A project might be a single-customer deployment, a personal tool, a team
workspace, a multi-tenant service, a marketplace with two sides, or a
hierarchy.

**The questions that reveal it** (ask them of the BRD and of the author): who
owns the data (a person, a team, a company, the product itself); who must never
see whose data, as a concrete pair ("company A must never see company B's
invoices"); what the billing unit is (whoever pays is often the tenant); whether
one person can belong to several, with a different role in each; whether there
is a hierarchy (organization → team → project) and whether access inherits down
it; what is shared or public; who works across tenants (the product's own staff
are a separate axis, with audited, deliberate access); and whether residency or
isolation is demanded per tenant.

**The usual answers, and what each implies:**

| model                                 | looks like                                   | implies                                                                                     |
| ------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **single-tenant**                     | one customer, or one deployment per customer | no row scoping; isolation is the deployment's job                                           |
| **per-user**                          | personal data only, with no sharing          | every row has an owner; scope = the caller                                                  |
| **multi-tenant, shared schema**       | organizations or teams in one database       | every scoped row carries the tenant ID; a scoping layer on the data client; isolation tests |
| **hierarchical**                      | org → team → project                         | scope at each level; decide whether access inherits downward                                |
| **two-sided / marketplace**           | buyers and sellers, hosts and guests         | per-relationship visibility; neither side is "the" tenant                                   |
| **database or deployment per tenant** | regulated customers, residency demands       | routing by tenant; migrations × N; no shared-schema scoping                                 |
