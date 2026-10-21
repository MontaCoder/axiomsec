import { Schema } from "effect"
import z from "zod"

import { Identifier } from "@/identifier/id"
import { ZodOverride } from "@/support/effect-zod"
import { Newtype } from "@/support/schema"

export class PermissionID extends Newtype<PermissionID>()(
  "PermissionID",
  Schema.String.annotate({ [ZodOverride]: Identifier.schema("permission") }),
) {
  static ascending(id?: string): PermissionID {
    return this.make(Identifier.ascending("permission", id))
  }

  static readonly zod = Identifier.schema("permission") as unknown as z.ZodType<PermissionID>
}
