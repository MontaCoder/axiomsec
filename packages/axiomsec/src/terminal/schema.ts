import { Schema } from "effect"
import z from "zod"

import { Identifier } from "@/identifier/id"
import { ZodOverride } from "@/support/effect-zod"
import { withStatics } from "@/support/schema"

const ptyIdSchema = Schema.String.annotate({ [ZodOverride]: Identifier.schema("pty") }).pipe(Schema.brand("PtyID"))

export type PtyID = typeof ptyIdSchema.Type

export const PtyID = ptyIdSchema.pipe(
  withStatics((schema: typeof ptyIdSchema) => ({
    ascending: (id?: string) => schema.make(Identifier.ascending("pty", id)),
    zod: Identifier.schema("pty").pipe(z.custom<PtyID>()),
  })),
)
