import { Schema } from "effect"
import z from "zod"

import { Identifier } from "@/identifier/id"
import { ZodOverride } from "@/support/effect-zod"
import { withStatics } from "@/support/schema"

const toolIdSchema = Schema.String.annotate({ [ZodOverride]: Identifier.schema("tool") }).pipe(Schema.brand("ToolID"))

export type ToolID = typeof toolIdSchema.Type

export const ToolID = toolIdSchema.pipe(
  withStatics((schema: typeof toolIdSchema) => ({
    ascending: (id?: string) => schema.make(Identifier.ascending("tool", id)),
    zod: Identifier.schema("tool").pipe(z.custom<ToolID>()),
  })),
)
