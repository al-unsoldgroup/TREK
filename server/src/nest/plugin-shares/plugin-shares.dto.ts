import { createZodDto } from 'nestjs-zod';
import { adviceActionSchema, adviceEmptySchema, adviceOwnerWriteSchema, adviceRevisionSchema, adviceShareConfigSchema } from '@trek/shared';
import type { AdviceAction } from '@trek/shared';
export class AdviceOwnerWriteDto extends createZodDto(adviceOwnerWriteSchema) {}
export class AdviceConfigDto extends createZodDto(adviceShareConfigSchema) {}
export class AdviceRevisionDto extends createZodDto(adviceRevisionSchema) {}
export class AdviceSessionDto extends createZodDto(adviceEmptySchema) {}
// createZodDto's class-extension type only supports object schemas, while the
// action contract is a discriminated union. This DTO keeps the union schema on
// the runtime metatype; the controller reparses its already-validated body to
// obtain the shared discriminated-union type without a cast.
export class AdviceActionDto {
  static isZodDto = true;
  static schema = adviceActionSchema;
  static create(input: unknown): AdviceAction { return adviceActionSchema.parse(input); }
}
/** Compatibility name for host fixtures that imported the S1 DTO directly. */
export class AdviceReadDto extends AdviceActionDto {}
