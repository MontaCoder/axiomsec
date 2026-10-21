import { Schema } from "effect"
import z from "zod"

import { Identifier } from "@/identifier/id"
import { ZodOverride } from "@/support/effect-zod"
import { Newtype } from "@/support/schema"

export class QuestionID extends Newtype<QuestionID>()(
  "QuestionID",
  Schema.String.annotate({ [ZodOverride]: Identifier.schema("question") }),
) {
  static ascending(id?: string): QuestionID {
    return this.make(Identifier.ascending("question", id))
  }

  static readonly zod = Identifier.schema("question") as unknown as z.ZodType<QuestionID>
}
