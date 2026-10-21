import { Schema } from "effect"
import z from "zod"

import { Identifier } from "@/identifier/id"
import { ZodOverride } from "@/support/effect-zod"
import { withStatics } from "@/support/schema"

export const EventID = Schema.String.annotate({ [ZodOverride]: Identifier.schema("event") }).pipe(
  Schema.brand("EventID"),
  withStatics((s) => ({
    ascending: (id?: string) => s.make(Identifier.ascending("event", id)),
    zod: Identifier.schema("event").pipe(z.custom<Schema.Schema.Type<typeof s>>()),
  })),
)
