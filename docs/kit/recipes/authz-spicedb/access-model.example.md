# Access model (example)

Tenancy: multi-tenant, shared schema. A tenant is an `Organization`.

Personas, each acting in organization `a`:

- **admin**: holds `admin` in `a`
- **member**: holds `member` in `a`
- **outsider**: holds `admin` in another organization `b`, and nothing in `a`
  (the "must never see" pair: nothing in `a` is visible from `b`)

## Roles × capabilities

`yes` allows; `no` refuses; `own` allows only on rows the persona created.

| capability     | resource     | admin | member | outsider |
| -------------- | ------------ | ----- | ------ | -------- |
| project.create | Organization | yes   | yes    | no       |
| project.read   | Project      | yes   | yes    | no       |
| project.update | Project      | yes   | own    | no       |
| project.delete | Project      | yes   | no     | no       |
