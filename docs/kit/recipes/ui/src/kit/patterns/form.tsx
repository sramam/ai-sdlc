// Form: React Hook Form with the CAPABILITY's own Zod schema as the resolver, so
// the browser checks the rules the port enforces; and a server refusal lands
// on its field (`Refusal.field`), not in a banner at the bottom of the page.
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm, type FieldValues, type Path } from "react-hook-form";
import { z } from "zod";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

/** The api recipe's refusal shape. */
export type Refusal = { ok: false; code: string; detail: string; field?: string };

export function useCapabilityForm<S extends z.ZodObject>(
  schema: S,
  submit: (values: z.input<S>) => Promise<{ ok: true } | Refusal>,
  defaultValues: z.input<S>,
) {
  type V = z.input<S> & FieldValues;
  const form = useForm<V>({
    // Validate without transforming: the port parses again on arrival.
    resolver: zodResolver(schema as never, undefined, { raw: true }) as never,
    mode: "onBlur",
    defaultValues: defaultValues as never,
  });
  const onSubmit = form.handleSubmit(async (values) => {
    const r = await submit(values);
    if (r.ok) return;
    if (r.field && r.field in schema.shape) {
      form.setError(
        r.field as Path<V>,
        { type: "server", message: r.detail },
        { shouldFocus: true },
      );
    } else {
      form.setError("root.server", { type: r.code, message: r.detail });
    }
  });
  return { form, onSubmit };
}

// The example: in a project, import the schema from the port's domain module
// (`packages/api/src/domain/…`), never re-declare it, and never from a module that
// imports the database (a client bundle would pull it in).
export const projectInput = z.strictObject({
  name: z.string().trim().min(2, "At least 2 characters.").max(80, "At most 80 characters."),
});

export function ProjectForm(props: {
  submit: (v: z.input<typeof projectInput>) => Promise<{ ok: true } | Refusal>;
}) {
  const { form, onSubmit } = useCapabilityForm(projectInput, props.submit, { name: "" });
  const err = form.formState.errors;
  return (
    <form onSubmit={onSubmit} noValidate className="max-w-sm">
      <FieldGroup>
        <Field data-invalid={!!err.name}>
          <FieldLabel htmlFor="project-name">Name</FieldLabel>
          <Input
            id="project-name"
            aria-invalid={!!err.name}
            aria-describedby="project-name-error"
            {...form.register("name")}
          />
          <FieldError id="project-name-error" errors={[err.name]} />
        </Field>
        {err.root?.server ? (
          <Alert variant="destructive">
            <AlertDescription>{err.root.server.message}</AlertDescription>
          </Alert>
        ) : null}
        <Button type="submit" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? "Saving…" : "Create project"}
        </Button>
      </FieldGroup>
    </form>
  );
}
