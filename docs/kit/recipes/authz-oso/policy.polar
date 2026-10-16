# The example access model (access-model.example.md), as Polar.
# Facts come from Postgres through local authorization (data-bindings.yaml):
# has_role from `membership`, has_relation from `project`. Nothing is written
# to Oso, so there is no second store to keep in step.

actor User {}

resource Organization {
  roles = ["member", "admin"];
  permissions = ["project.create"];

  "member" if "admin";
  "project.create" if "member";
}

resource Project {
  permissions = ["project.read", "project.update", "project.delete"];
  relations = { parent: Organization, creator: User };

  "project.read" if "member" on "parent";
  "project.update" if "admin" on "parent";
  "project.delete" if "admin" on "parent";
}

# "Own": a member may update a project they created, while still a member.
has_permission(user: User, "project.update", project: Project) if
  has_relation(project, "creator", user) and
  org matches Organization and
  has_relation(project, "parent", org) and
  has_role(user, "member", org);

test "a member updates only what they created" {
  setup {
    has_role(User{"m"}, "member", Organization{"a"});
    has_relation(Project{"mine"}, "parent", Organization{"a"});
    has_relation(Project{"mine"}, "creator", User{"m"});
    has_relation(Project{"theirs"}, "parent", Organization{"a"});
  }
  assert allow(User{"m"}, "project.update", Project{"mine"});
  assert_not allow(User{"m"}, "project.update", Project{"theirs"});
  assert allow(User{"m"}, "project.read", Project{"theirs"});
  assert_not allow(User{"m"}, "project.delete", Project{"mine"});
}
